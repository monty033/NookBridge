/**
 * In-memory authentication state coordinator for Stage 2A.
 *
 * The coordinator owns no persistence path. In particular, credentials and
 * provider session values never pass to PersistentStorage or the logger.
 */

import type { Logger } from "../logging/logger.js";
import {
  isAuthProviderError,
  type AuthCredentials,
  type AuthProvider,
  type AuthSession,
  type AuthState,
} from "./types.js";

export type AuthCoordinatorOptions = Readonly<{
  provider: AuthProvider;
  clock?: () => number;
  logger?: Logger;
}>;

const COORDINATOR_ERROR = Symbol("auth-coordinator-error");

type CoordinatorBoundaryError = Error & {
  [COORDINATOR_ERROR]?: true;
};

function categoricalError(message: string): Error {
  const error = new Error(message) as CoordinatorBoundaryError;
  Object.defineProperty(error, COORDINATOR_ERROR, {
    configurable: false,
    enumerable: false,
    value: true,
  });
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  return error;
}

function isCategoricalError(error: unknown): error is CoordinatorBoundaryError {
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as CoordinatorBoundaryError)[COORDINATOR_ERROR] === true
    );
  } catch {
    return false;
  }
}

type NormalizedCoordinatorOptions = Readonly<{
  provider: unknown;
  clock: unknown;
  logger: unknown;
}>;

function normalizeCoordinatorOptions(options: unknown): NormalizedCoordinatorOptions {
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new Error("invalid options");
    }
    const candidate = options as Record<string, unknown>;
    return {
      provider: candidate.provider,
      clock: candidate.clock,
      logger: candidate.logger,
    };
  } catch {
    throw categoricalError("auth coordinator options are invalid");
  }
}

function validateProvider(provider: unknown): asserts provider is AuthProvider {
  try {
    if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
      throw new Error("invalid provider");
    }
    const candidate = provider as Record<string, unknown>;
    for (const method of ["login", "refresh", "logout"] as const) {
      if (typeof candidate[method] !== "function") {
        throw new Error("invalid provider");
      }
    }
  } catch {
    throw categoricalError("auth coordinator provider is invalid");
  }
}

export class AuthCoordinator {
  private readonly provider: AuthProvider;
  private readonly clock: () => number;
  private readonly logger: Logger | undefined;
  private currentState: AuthState = createSignedOutState();
  private transitionGeneration = 0;

  constructor(options: AuthCoordinatorOptions) {
    const normalized = normalizeCoordinatorOptions(options);
    validateProvider(normalized.provider);
    const clock = normalized.clock === undefined ? Date.now : normalized.clock;
    if (typeof clock !== "function") {
      throw categoricalError("auth coordinator clock is invalid");
    }
    this.provider = normalized.provider;
    this.clock = clock as () => number;
    this.logger =
      normalized.logger === undefined || normalized.logger === null
        ? undefined
        : (normalized.logger as Logger);
  }

  /** Return the current state and mark an authenticated session expired at its deadline. */
  status(): AuthState {
    if (this.currentState.status === "authenticated" && this.isExpired(this.currentState.session)) {
      this.currentState = createSessionState("expired", this.currentState.session);
    }
    return copyState(this.currentState);
  }

  async login(credentials: AuthCredentials): Promise<AuthState> {
    const safeCredentials = validateCredentials(credentials);
    const generation = this.beginTransition();
    try {
      if (this.status().status !== "signed-out") {
        throw categoricalError("cannot log in while an in-memory session is active");
      }
      const providerSession = await this.callProviderLogin(safeCredentials);
      this.ensureCurrent(generation);
      const session = validateSession(providerSession);
      const now = this.currentTime();
      this.ensureCurrent(generation);
      ensureSessionIsLive(session, now);
      this.currentState = createSessionState("authenticated", session);
      this.logInfo("auth.login", {
        status: "authenticated",
        userId: session.userId,
      });
      return copyState(this.currentState);
    } catch (error) {
      if (this.transitionGeneration !== generation) throw supersededError();
      if (isCategoricalError(error) || isAuthProviderError(error)) throw error;
      throw categoricalError("auth provider login failed");
    }
  }

  /** Refresh an authenticated or expired session without persisting its token. */
  async refresh(): Promise<AuthState> {
    const generation = this.beginTransition();
    try {
      const state = this.status();
      if (state.status === "signed-out") {
        throw categoricalError("cannot refresh while signed out");
      }

      const providerSession = await this.callProviderRefresh(copySession(state.session));
      this.ensureCurrent(generation);
      const session = validateSession(providerSession);
      const now = this.currentTime();
      this.ensureCurrent(generation);
      ensureSessionIsLive(session, now);
      this.currentState = createSessionState("authenticated", session);
      this.logInfo("auth.refresh", {
        status: "authenticated",
        userId: session.userId,
      });
      return copyState(this.currentState);
    } catch (error) {
      if (this.transitionGeneration !== generation) throw supersededError();
      if (isCategoricalError(error) || isAuthProviderError(error)) throw error;
      throw categoricalError("auth provider refresh failed");
    }
  }

  /** Clear the local session even if a provider's logout operation fails. */
  async logout(): Promise<void> {
    const generation = this.beginTransition();
    const state = this.currentState;
    if (state.status !== "signed-out") {
      // Clear local state before awaiting provider code. This is the important
      // fail-safe boundary for both the offline mock and a future provider.
      this.currentState = createSignedOutState();
    }
    try {
      // This call is intentionally made even while signed out. It invalidates
      // provider work that may be completing after a prior login transition.
      await this.callProviderCancelPending();
      if (state.status === "signed-out") {
        this.ensureCurrent(generation);
        return;
      }
      await this.callProviderLogout(copySession(state.session));
      this.ensureCurrent(generation);
    } catch (error) {
      if (this.transitionGeneration !== generation) throw supersededError();
      if (isCategoricalError(error) || isAuthProviderError(error)) throw error;
      throw categoricalError("auth provider logout failed");
    } finally {
      if (this.transitionGeneration === generation) {
        this.logInfo("auth.logout", { status: "signed-out" });
      }
    }
  }

  private async callProviderLogin(credentials: AuthCredentials): Promise<unknown> {
    try {
      return await this.provider.login(credentials);
    } catch (error) {
      if (isAuthProviderError(error)) throw error;
      throw categoricalError("auth provider login failed");
    }
  }

  private async callProviderRefresh(session: AuthSession): Promise<unknown> {
    try {
      return await this.provider.refresh(session);
    } catch (error) {
      if (isAuthProviderError(error)) throw error;
      throw categoricalError("auth provider refresh failed");
    }
  }

  private async callProviderLogout(session: AuthSession): Promise<void> {
    try {
      await this.provider.logout(session);
    } catch (error) {
      if (isAuthProviderError(error)) throw error;
      throw categoricalError("auth provider logout failed");
    }
  }

  private async callProviderCancelPending(): Promise<void> {
    try {
      const cancelPending = this.provider.cancelPending;
      if (cancelPending !== undefined) {
        if (typeof cancelPending !== "function") {
          throw new Error("invalid cancellation seam");
        }
        await cancelPending.call(this.provider);
      }
    } catch {
      throw categoricalError("auth provider cancellation failed");
    }
  }

  private isExpired(session: AuthSession): boolean {
    return this.currentTime() >= session.expiresAt;
  }

  private currentTime(): number {
    try {
      const now = this.clock();
      if (!Number.isFinite(now)) throw new Error("invalid clock");
      return now;
    } catch {
      throw categoricalError("auth coordinator clock must return a finite number");
    }
  }

  private beginTransition(): number {
    this.transitionGeneration += 1;
    return this.transitionGeneration;
  }

  private ensureCurrent(generation: number): void {
    if (this.transitionGeneration !== generation) throw supersededError();
  }

  /** Logging is best-effort; a logger must not alter an auth transition. */
  private logInfo(message: string, record: { status: string; userId?: string }): void {
    try {
      this.logger?.info(message, record);
    } catch {
      // Injected logger implementations are outside the auth state machine.
    }
  }
}

function ensureSessionIsLive(session: AuthSession, now: number): void {
  if (session.expiresAt <= now) {
    throw categoricalError("auth provider returned an expired in-memory session");
  }
}

function supersededError(): Error {
  return categoricalError("auth operation superseded by a newer transition");
}

function validateCredentials(credentials: unknown): AuthCredentials {
  let username: unknown;
  let password: unknown;
  try {
    if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
      throw new Error("invalid credentials");
    }
    const candidate = credentials as Record<string, unknown>;
    username = candidate.username;
    password = candidate.password;
  } catch {
    throw categoricalError("auth coordinator credentials are invalid");
  }
  if (typeof username !== "string" || username.length === 0) {
    throw categoricalError("auth coordinator credentials are invalid");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw categoricalError("auth coordinator credentials are invalid");
  }
  return { username, password };
}

function validateSession(session: unknown): AuthSession {
  let userId: unknown;
  let accessToken: unknown;
  let issuedAt: unknown;
  let expiresAt: unknown;
  try {
    if (typeof session !== "object" || session === null || Array.isArray(session)) {
      throw new Error("invalid session");
    }
    const candidate = session as Record<string, unknown>;
    userId = candidate.userId;
    accessToken = candidate.accessToken;
    issuedAt = candidate.issuedAt;
    expiresAt = candidate.expiresAt;
  } catch {
    throw categoricalError("auth provider returned an invalid in-memory session");
  }
  if (
    typeof userId !== "string" ||
    userId.length === 0 ||
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    typeof issuedAt !== "number" ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt
  ) {
    throw categoricalError("auth provider returned an invalid in-memory session");
  }
  return { userId, accessToken, issuedAt, expiresAt };
}

function copySession(session: AuthSession): AuthSession {
  return {
    userId: session.userId,
    accessToken: session.accessToken,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
  };
}

function createSignedOutState(): AuthState {
  return Object.freeze({ status: "signed-out" });
}

function createSessionState(status: "authenticated" | "expired", session: AuthSession): AuthState {
  return Object.freeze({
    status,
    session: Object.freeze(copySession(session)),
  });
}

function copyState(state: AuthState): AuthState {
  if (state.status === "signed-out") return { status: "signed-out" };
  return { status: state.status, session: copySession(state.session) };
}
