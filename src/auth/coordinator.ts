/**
 * In-memory authentication state coordinator for Stage 2A.
 *
 * The coordinator owns no persistence path. In particular, credentials and
 * provider session values never pass to PersistentStorage or the logger.
 */

import type { Logger } from "../logging/logger.js";
import type { AuthCredentials, AuthProvider, AuthSession, AuthState } from "./types.js";

export type AuthCoordinatorOptions = Readonly<{
  provider: AuthProvider;
  clock?: () => number;
  logger?: Logger;
}>;

export class AuthCoordinator {
  private readonly provider: AuthProvider;
  private readonly clock: () => number;
  private readonly logger: Logger | undefined;
  private currentState: AuthState = createSignedOutState();
  private transitionGeneration = 0;

  constructor(options: AuthCoordinatorOptions) {
    this.provider = options.provider;
    this.clock = options.clock ?? Date.now;
    this.logger = options.logger;
  }

  /** Return the current state and mark an authenticated session expired at its deadline. */
  status(): AuthState {
    if (this.currentState.status === "authenticated" && this.isExpired(this.currentState.session)) {
      this.currentState = createSessionState("expired", this.currentState.session);
    }
    return copyState(this.currentState);
  }

  async login(credentials: AuthCredentials): Promise<AuthState> {
    const generation = this.beginTransition();
    try {
      if (this.status().status !== "signed-out") {
        throw new Error("cannot log in while an in-memory session is active");
      }
      const providerSession = await this.provider.login(credentials);
      this.ensureCurrent(generation);
      const session = validateSession(providerSession);
      const now = this.currentTime();
      this.ensureCurrent(generation);
      ensureSessionIsLive(session, now);
      this.currentState = createSessionState("authenticated", session);
      this.logger?.info("auth.login", {
        status: "authenticated",
        userId: session.userId,
      });
      return copyState(this.currentState);
    } catch (error) {
      if (this.transitionGeneration !== generation) throw supersededError();
      throw error;
    }
  }

  /** Refresh an authenticated or expired session without persisting its token. */
  async refresh(): Promise<AuthState> {
    const generation = this.beginTransition();
    try {
      const state = this.status();
      if (state.status === "signed-out") {
        throw new Error("cannot refresh while signed out");
      }

      const providerSession = await this.provider.refresh(copySession(state.session));
      this.ensureCurrent(generation);
      const session = validateSession(providerSession);
      const now = this.currentTime();
      this.ensureCurrent(generation);
      ensureSessionIsLive(session, now);
      this.currentState = createSessionState("authenticated", session);
      this.logger?.info("auth.refresh", {
        status: "authenticated",
        userId: session.userId,
      });
      return copyState(this.currentState);
    } catch (error) {
      if (this.transitionGeneration !== generation) throw supersededError();
      throw error;
    }
  }

  /** Clear the local session even if a provider's logout operation fails. */
  async logout(): Promise<void> {
    const generation = this.beginTransition();
    const state = this.currentState;
    if (state.status === "signed-out") return;

    // Clear local state before awaiting provider code. This is the important
    // fail-safe boundary for both the offline mock and a future Stage 2B
    // provider.
    this.currentState = createSignedOutState();
    try {
      await this.provider.logout(copySession(state.session));
      this.ensureCurrent(generation);
    } catch (error) {
      if (this.transitionGeneration !== generation) throw supersededError();
      throw error;
    } finally {
      if (this.transitionGeneration === generation) {
        this.logger?.info("auth.logout", { status: "signed-out" });
      }
    }
  }

  private isExpired(session: AuthSession): boolean {
    return this.currentTime() >= session.expiresAt;
  }

  private currentTime(): number {
    const now = this.clock();
    if (!Number.isFinite(now))
      throw new Error("auth coordinator clock must return a finite number");
    return now;
  }

  private beginTransition(): number {
    this.transitionGeneration += 1;
    return this.transitionGeneration;
  }

  private ensureCurrent(generation: number): void {
    if (this.transitionGeneration !== generation) throw supersededError();
  }
}

function ensureSessionIsLive(session: AuthSession, now: number): void {
  if (session.expiresAt <= now) {
    throw new Error("auth provider returned an expired in-memory session");
  }
}

function supersededError(): Error {
  return new Error("auth operation superseded by a newer transition");
}

function validateSession(session: unknown): AuthSession {
  if (typeof session !== "object" || session === null) {
    throw new Error("auth provider returned an invalid in-memory session");
  }

  const candidate = session as {
    userId?: unknown;
    accessToken?: unknown;
    issuedAt?: unknown;
    expiresAt?: unknown;
  };
  const { userId, accessToken, issuedAt, expiresAt } = candidate;
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
    throw new Error("auth provider returned an invalid in-memory session");
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
