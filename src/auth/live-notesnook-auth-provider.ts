/**
 * Stage 2B-live — explicit live Notesnook auth provider.
 *
 * This module is the live-handle counterpart to the offline
 * `NotesnookAuthProvider`.  Where the offline provider is wired to an
 * injected `NotesnookDatabaseHandle` plus an injected encrypted
 * `IStorage`, the live provider is wired to the narrow
 * {@link NotesnookLiveCoreHandle} produced by
 * `createNotesnookLiveCoreFactory(...)`.  Both providers compose with
 * the same `AuthProvider` lifecycle used by the Stage 2A
 * `AuthCoordinator`; neither mutates the other; both reject secret
 * bytes at their boundaries.
 *
 * Hard invariants:
 *
 *   1. The provider accepts ONLY a {@link NotesnookLiveCoreHandle}
 *      (the narrow surface the factory returns).  It NEVER accepts
 *      an arbitrary `Database`, a generic transport, a generic core
 *      passthrough, or a raw `@notesnook/core` import.
 *   2. The provider NEVER writes the upstream token envelope to a
 *      caller-supplied `IStorage`.  Token persistence is owned by
 *      the upstream `@notesnook/core` `kv` accessor, and the
 *      provider only ever invokes it through the narrow
 *      `handle.kv.read` / `handle.kv.write` / `handle.kv.delete`
 *      surface.  The provider does NOT cache the envelope on its
 *      instance; the only copy that lingers in scope is the
 *      `AuthSession` returned to the caller, which never carries a
 *      `refresh_token`.
 *   3. Login follows the exact order documented in
 *      `docs/upstream-contract.md`:
 *        a. `core.user.authenticateEmail(email)`; its return value is
 *           metadata, not the token envelope used for branching.
 *        b. Read the canonical envelope from `core.token.getToken()` and
 *           branch only when its `scope` exactly equals the MFA sentinel:
 *           - MFA: call the injected MFA supplier, then
 *             `core.user.authenticateMultiFactorCode(code, "app")`,
 *             followed by `core.user.authenticatePassword(email, password)`.
 *           - Non-MFA: call `core.user._login({ email, hashedPassword })`
 *             with the canonical SHA-256 password hash.
 *        c. Each password branch starts with the supplied initial password
 *           and consults the injected supplier only after rejection.
 *      No password / MFA code is ever persisted on the provider.
 *   4. After the upstream returns successfully the provider calls
 *      `core.token.getToken()` to read the canonical upstream KV
 *      envelope and normalizes it into a refresh-token-free
 *      `AuthSession`.  The session's `userId` is the upstream
 *      `user.getUser()` `id` (no token-derived hashes).  No raw
 *      `token` write happens — the upstream owns persistence.
 *   5. Refresh calls `core.token._refreshToken(true)` then
 *      `core.token.getToken()`.  Refresh-after-logout and concurrent
 *      refresh races are guarded by an operation epoch so a stale
 *      login/restore cannot resurrect the envelope.
 *   6. Logout calls `core.user.logout(true)` (the factory narrow
 *      surface already forwards `true`; we verify that contract via
 *      the narrow handle rather than re-asserting it), then deletes
 *      only the literal `token` key through the narrow KV
 *      accessor.  The provider then invokes the supplied cleanup
 *      hook.  All three steps are independent — a failure in any
 *      one does not skip the others.  The provider never calls
 *      `db.reset()` or any generic destructive operation; that is
 *      the cleanup hook's responsibility.
 *   7. All categorical errors carry no token bytes, no password
 *      bytes, no MFA bytes, no email bytes, and no upstream
 *      response body.  The `cause` and `__context__` chain are
 *      wiped.
 *   8. Buffers / strings the runner collects are caller-owned and
 *      are zeroized by the runner, NOT by the provider.  The
 *      provider has no instance password cache and no MFA cache.
 *
 * No live network call is performed in this module: the upstream
 * `core.user.authenticate*` calls go through the narrow handle and
 * only run when a real `@notesnook/core` factory is constructed.
 * Offline tests inject a fake handle so no real call is ever made.
 */

import type { Logger } from "../logging/logger.js";
import type {
  NotesnookLiveCoreHandle,
  NotesnookLiveKvKey,
  NotesnookLiveTokenEnvelope,
  NotesnookLiveUser,
} from "../core/notesnook-live-factory.js";
import { NOTESNOOK_LIVE_KV_TOKEN_KEY } from "../core/notesnook-live-factory.js";
import { hashNotesnookPassword } from "./notesnook-password-hash.js";
import {
  isAuthProviderError,
  markAuthProviderError,
  type AuthCredentials,
  type AuthProvider,
  type AuthSession,
} from "./types.js";

type AuthenticatedTokenEnvelope = NotesnookLiveTokenEnvelope & {
  refresh_token: string;
};

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

/**
 * The exact narrow upstream token key the provider may read, write,
 * or delete.  Mirrors {@link NOTESNOOK_LIVE_KV_TOKEN_KEY} so the
 * provider cannot be repurposed as a generic KV passthrough.
 */
export const LIVE_NOTESNOOK_KV_TOKEN_KEY: NotesnookLiveKvKey = NOTESNOOK_LIVE_KV_TOKEN_KEY;

/**
 * The upstream scope sentinel that triggers an MFA round on top of
 * the email + password flow.  Mirrors the offline provider's
 * sentinel so the contract is uniform across both slices.
 */
const MFA_REQUIRED_SCOPE = "auth:grant_types:mfa" as const;

/**
 * Caller-supplied function used by the provider to obtain a fresh
 * password attempt when the branch-specific upstream password step
 * rejects the previous one.  MFA accounts retry
 * `authenticatePassword`; non-MFA accounts retry `_login` with a
 * newly hashed password.  Returning `null` signals that no further
 * password is available — the provider rejects the login.
 *
 * The runner passes a supplier that yields a one-shot `Buffer`
 * the runner owns and zeroizes.  The provider holds the password
 * only inside a local variable inside the retry loop and never
 * persists, logs, or stores it on the instance.
 */
export type LivePasswordSupplier = () => Promise<string | null>;

/**
 * Caller-supplied function used by the provider to obtain an MFA
 * code when the upstream scope requires one.  Same null-signal
 * semantics as {@link LivePasswordSupplier}.
 */
export type LiveMfaSupplier = () => Promise<string | null>;

/**
 * Caller-supplied cleanup hook invoked after the canonical `token`
 * deletion attempt (whether or not upstream logout or deletion
 * succeeded).  It is the ONLY path through which the provider can
 * clear local encrypted state and is the fallback when deletion
 * fails.  Production code wires this to whatever destructive
 * boundary owns `db.reset()` in a later slice; offline tests inject
 * a stub that just records the call.
 */
export type LiveCleanupHook = () => void | Promise<void>;

/**
 * Constructor options for {@link LiveNotesnookAuthProvider}.
 *
 * `clock`, `passwordSupplier`, `mfaSupplier`, `logger`, and
 * `cleanupHook` are the standard injectable seams; `handle` is the
 * narrow live factory handle.  No credential is accepted via
 * constructor arguments.
 */
export type LiveNotesnookAuthProviderOptions = Readonly<{
  /** The narrow live factory handle. */
  handle: NotesnookLiveCoreHandle;
  /** Optional injected password supplier. */
  passwordSupplier?: LivePasswordSupplier;
  /** Optional injected MFA supplier. */
  mfaSupplier?: LiveMfaSupplier;
  /** Maximum attempts the MFA supplier is consulted.  Defaults to 3. */
  mfaMaxAttempts?: number;
  /** Maximum attempts the password supplier is consulted.  Defaults to 3. */
  passwordMaxAttempts?: number;
  /** Clock used to reject envelopes that are already expired. */
  clock?: () => number;
  /**
   * Cleanup hook invoked AFTER `token` removal completes.  The
   * provider never invokes any generic reset or destructive
   * boundary directly; the hook is the only such path.
   */
  cleanupHook: LiveCleanupHook;
  /** Optional structured logger.  No credentials or tokens are logged. */
  logger?: Logger;
}>;

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/**
 * Create a stable provider error with no upstream cause/context
 * attached and no upstream text in the message.
 */
function categoricalError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  return markAuthProviderError(error);
}

/**
 * The only upstream-authentication diagnostics allowed to cross from the
 * provider to the runner.  This intentionally describes the operation we
 * attempted, not any upstream response or exception.
 */
export type LiveAuthFailureDiagnostic = Readonly<{
  phase: "email" | "password" | "mfa";
  category: "upstream-rejected";
}>;

const LIVE_AUTH_FAILURE_DIAGNOSTIC = Symbol("live-auth-failure-diagnostic");

function upstreamRejectedError(phase: LiveAuthFailureDiagnostic["phase"]): Error {
  const error = categoricalError("live notesnook authentication rejected");
  Object.defineProperty(error, LIVE_AUTH_FAILURE_DIAGNOSTIC, {
    configurable: false,
    enumerable: false,
    value: phase,
  });
  return error;
}

/**
 * Return a diagnostic only when this module itself attached one.  Never read
 * an error message, cause, context, or arbitrary property from an upstream
 * exception to construct it.
 */
export function getLiveAuthFailureDiagnostic(
  error: unknown,
): LiveAuthFailureDiagnostic | undefined {
  try {
    if (typeof error !== "object" || error === null || !isAuthProviderError(error)) {
      return undefined;
    }
    const phase = Object.getOwnPropertyDescriptor(error, LIVE_AUTH_FAILURE_DIAGNOSTIC)?.value;
    if (phase === "email" || phase === "password" || phase === "mfa") {
      return { phase, category: "upstream-rejected" };
    }
  } catch {
    // A hostile error object must not influence the public diagnostic.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Defaults.
// ---------------------------------------------------------------------------

const DEFAULT_MFA_MAX_ATTEMPTS = 3;
const DEFAULT_PASSWORD_MAX_ATTEMPTS = 3;

/**
 * Default no-op suppliers.  Production callers MUST inject a real
 * supplier (the runner collects bytes from the prompt); tests
 * inject a deterministic stub.  When the default is used the
 * provider cannot retry — that is intentional: a default is a
 * refusal-by-omission.
 */
const defaultPasswordSupplier: LivePasswordSupplier = async () => null;
const defaultMfaSupplier: LiveMfaSupplier = async () => null;

// ---------------------------------------------------------------------------
// Provider.
// ---------------------------------------------------------------------------

/**
 * The explicit live Notesnook auth provider.  Implements
 * {@link AuthProvider} so it composes with the Stage 2A
 * `AuthCoordinator` boundary.
 *
 * No runtime import of `@notesnook/core` happens here: the
 * provider accepts only the narrow factory handle, and the factory
 * is the only place that lazy-imports the real package.
 */
type CleanupState = "clean" | "queued" | "deleting" | "verifying" | "fallback" | "blocked";

/**
 * The live provider owns one FIFO queue for every operation that can touch the
 * shared Notesnook core.  The queue is deliberately provider-local: the core
 * keeps mutable token state on the handle, so serializing only the final read
 * is not sufficient.
 */
export class LiveNotesnookAuthProvider implements AuthProvider {
  private readonly handle: NotesnookLiveCoreHandle;
  private readonly passwordSupplier: LivePasswordSupplier;
  private readonly mfaSupplier: LiveMfaSupplier;
  private readonly mfaMaxAttempts: number;
  private readonly passwordMaxAttempts: number;
  private readonly clock: () => number;
  private readonly cleanupHook: LiveCleanupHook;
  private readonly logger: Logger | undefined;

  /** Invalidating generation; captured before the first queue await. */
  private invalidationGeneration = 0;
  /** True only while the provider has published a usable session. */
  private hasActiveSession = false;

  /** The single serialized mechanism for login, refresh, logout, and cancel. */
  private operationTail: Promise<void> = Promise.resolve();
  /** Explicit durable-cleanup state machine. */
  private cleanupState: CleanupState = "clean";
  private cleanupInFlight: Promise<void> | undefined;
  private logoutInFlight: Promise<void> | undefined;
  /** Admission guard for the established single-flight refresh contract. */
  private refreshInFlight: Promise<AuthSession> | undefined;

  constructor(options: LiveNotesnookAuthProviderOptions) {
    const normalized = normalizeProviderOptions(options);
    validateHandle(normalized.handle);
    if (typeof normalized.cleanupHook !== "function") {
      throw categoricalError("live notesnook auth provider requires cleanupHook");
    }
    const passwordSupplier =
      (normalized.passwordSupplier as LivePasswordSupplier | undefined) ?? defaultPasswordSupplier;
    if (typeof passwordSupplier !== "function") {
      throw categoricalError("live notesnook auth provider password supplier must be a function");
    }
    const mfaSupplier =
      (normalized.mfaSupplier as LiveMfaSupplier | undefined) ?? defaultMfaSupplier;
    if (typeof mfaSupplier !== "function") {
      throw categoricalError("live notesnook auth provider MFA supplier must be a function");
    }
    const clock = (normalized.clock as (() => number) | undefined) ?? Date.now;
    if (typeof clock !== "function") {
      throw categoricalError("live notesnook auth provider clock must be a function");
    }
    validateLogger(normalized.logger);
    this.handle = normalized.handle as NotesnookLiveCoreHandle;
    this.passwordSupplier = passwordSupplier;
    this.mfaSupplier = mfaSupplier;
    this.mfaMaxAttempts = positiveInteger(
      normalized.mfaMaxAttempts ?? DEFAULT_MFA_MAX_ATTEMPTS,
      "mfaMaxAttempts",
    );
    this.passwordMaxAttempts = positiveInteger(
      normalized.passwordMaxAttempts ?? DEFAULT_PASSWORD_MAX_ATTEMPTS,
      "passwordMaxAttempts",
    );
    this.clock = clock;
    this.cleanupHook = () => (normalized.cleanupHook as LiveCleanupHook)();
    this.logger = normalized.logger as Logger | undefined;
  }

  /**
   * Login captures the invalidation generation before entering the queue.  A
   * login already queued when logout/cancel begins therefore cannot adopt the
   * new generation after waiting and authenticate behind the cleanup barrier.
   */
  async login(credentials: AuthCredentials): Promise<AuthSession> {
    const validated = validateCredentials(credentials);
    this.ensureCleanupAvailable();
    const generation = this.invalidationGeneration;
    return this.enqueue(() => this.executeLogin(generation, validated));
  }

  /**
   * Refresh participates in the same FIFO as login and cleanup.  In
   * particular, a refresh that is blocked inside upstream work is followed by
   * the queued authoritative cleanup rather than racing it.
   */
  async refresh(_session: AuthSession): Promise<AuthSession> {
    if (this.logoutInFlight) {
      throw categoricalError("live notesnook refresh unavailable during logout");
    }
    if (this.cleanupInFlight) {
      throw categoricalError("live notesnook refresh unavailable during cancellation");
    }
    if (!this.hasActiveSession) {
      throw categoricalError("live notesnook refresh unavailable without an active session");
    }
    if (this.refreshInFlight) {
      throw categoricalError("live notesnook refresh already in progress");
    }
    const generation = this.invalidationGeneration;
    const queued = this.enqueue(() => this.executeRefresh(generation));
    const operation = queued.finally(() => {
      if (this.refreshInFlight === operation) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = operation;
    return operation;
  }

  /**
   * Reopen the authenticated upstream token already held in the encrypted
   * core store.  This is deliberately credential-free: it neither prompts
   * nor attempts a network refresh.  Callers decide whether a restored,
   * expired session should be refreshed.
   */
  async restoreSession(): Promise<AuthSession | null> {
    this.ensureCleanupAvailable();
    const generation = this.invalidationGeneration;
    return this.enqueue(async () => {
      this.ensureGeneration(generation);
      let envelope: NotesnookLiveTokenEnvelope | undefined;
      try {
        envelope = await this.handle.token.getToken();
      } catch {
        throw categoricalError("live notesnook token read failed");
      }
      this.ensureGeneration(generation);
      if (envelope === undefined) return null;
      const authenticated = requireAuthenticatedEnvelope(envelope);
      const user = await this.readUserIfCurrent(generation);
      const session = envelopeToSession(authenticated, user, this.providerNow());
      this.hasActiveSession = true;
      return session;
    });
  }

  /**
   * Invalidate synchronously, then queue revoke + canonical cleanup.  The
   * promise is published before the queue body can reach an upstream await,
   * which makes re-entrant logger callbacks safe and prevents new logins from
   * crossing the cleanup barrier.
   */
  async logout(_session: AuthSession): Promise<void> {
    if (this.logoutInFlight) return this.logoutInFlight;

    this.invalidate();
    this.cleanupState = "queued";
    const queued = this.enqueue(() => this.executeLogout());
    const operation = queued.finally(() => {
      if (this.logoutInFlight === operation) this.logoutInFlight = undefined;
      if (this.cleanupState !== "blocked") this.cleanupState = "clean";
    });
    this.logoutInFlight = operation;
    return operation;
  }

  /**
   * Invalidate synchronously and queue the same authoritative token cleanup
   * used by logout, without the upstream revoke round.  If called from a
   * logger while an operation is active, the active queue item finishes with a
   * superseded error and this cleanup item runs next; it never awaits itself.
   */
  cancelPending(): Promise<void> {
    this.invalidate();
    if (this.logoutInFlight) return this.logoutInFlight;
    if (this.cleanupInFlight) return this.cleanupInFlight;
    return this.scheduleCleanup(false);
  }

  // ---------------------------------------------------------------------
  // One queue and the cleanup state machine.
  // ---------------------------------------------------------------------

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.operationTail = completion;

    return (async () => {
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    })();
  }

  private invalidate(): void {
    this.invalidationGeneration += 1;
    this.hasActiveSession = false;
  }

  private ensureGeneration(generation: number): void {
    if (this.invalidationGeneration !== generation) {
      throw categoricalError("live notesnook auth operation superseded");
    }
  }

  private ensureCleanupAvailable(): void {
    if (this.cleanupState === "blocked") {
      throw categoricalError("live notesnook cleanup requires reset");
    }
  }

  private scheduleCleanup(invokeHookOnVerifiedDelete: boolean): Promise<void> {
    const existing = this.cleanupInFlight;
    if (existing) return existing;

    this.cleanupState = "queued";
    const queued = this.enqueue(() => this.runCleanup(invokeHookOnVerifiedDelete));
    const operation = queued.finally(() => {
      if (this.cleanupInFlight === operation) this.cleanupInFlight = undefined;
      if (this.cleanupState !== "blocked") this.cleanupState = "clean";
    });
    this.cleanupInFlight = operation;
    return operation;
  }

  private async runCleanup(invokeHookOnVerifiedDelete: boolean): Promise<void> {
    this.cleanupState = "deleting";
    let deleteFailed = false;
    try {
      await this.handle.kv.delete(LIVE_NOTESNOOK_KV_TOKEN_KEY);
    } catch {
      deleteFailed = true;
    }

    this.cleanupState = "verifying";
    const deletedTokenIsAbsent = await this.verifyTokenAbsent();
    const needsFallback = deleteFailed || !deletedTokenIsAbsent;
    let hookFailed = false;
    if (invokeHookOnVerifiedDelete || needsFallback) {
      this.cleanupState = "fallback";
      try {
        await this.cleanupHook();
      } catch {
        hookFailed = true;
      }
    }

    if (needsFallback) {
      this.cleanupState = "verifying";
      const fallbackProvedRemoval = await this.verifyTokenAbsent();
      if (!fallbackProvedRemoval) {
        this.cleanupState = "blocked";
        throw categoricalError("live notesnook token cleanup failed");
      }
    }
    if (hookFailed) {
      this.cleanupState = "blocked";
      throw categoricalError("live notesnook local-state cleanup failed");
    }
    this.cleanupState = "clean";
  }

  private async verifyTokenAbsent(): Promise<boolean> {
    try {
      const token = await this.handle.kv.read(LIVE_NOTESNOOK_KV_TOKEN_KEY);
      return token === undefined || token === null;
    } catch {
      // An unreadable canonical token cannot be proven absent.
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Serialized operation bodies.
  // ---------------------------------------------------------------------

  private async executeLogin(
    generation: number,
    credentials: AuthCredentials,
  ): Promise<AuthSession> {
    this.ensureGeneration(generation);
    this.ensureCleanupAvailable();
    try {
      return await this.loginInternal(generation, credentials);
    } catch (error) {
      const failure = isAuthProviderError(error)
        ? error
        : categoricalError("live notesnook login failed");
      await this.compensateLoginToken(generation);
      throw failure;
    }
  }

  private async executeRefresh(generation: number): Promise<AuthSession> {
    this.ensureGeneration(generation);
    this.ensureCleanupAvailable();
    try {
      return await this.refreshInternal(generation);
    } catch (error) {
      if (isAuthProviderError(error)) throw error;
      throw categoricalError("live notesnook token refresh failed");
    }
  }

  private async executeLogout(): Promise<void> {
    let remoteLogoutFailed = false;
    let cleanupFailure: Error | undefined;
    try {
      await this.handle.user.logout(true);
    } catch {
      remoteLogoutFailed = true;
    }

    try {
      // Cleanup runs inline because enqueuing a second queue item here would
      // await the queue tail that this operation itself owns.
      await this.runCleanup(true);
    } catch (error) {
      cleanupFailure = isAuthProviderError(error)
        ? error
        : categoricalError("live notesnook token cleanup failed");
    }
    if (cleanupFailure) throw cleanupFailure;
    if (remoteLogoutFailed) {
      // The canonical local token was verifiably removed even though the
      // upstream revoke request failed. This is safe operational context, not
      // an upstream response body or token-derived detail.
      throw categoricalError("live notesnook remote logout failed; local auth state cleared");
    }
    this.logInfo("live.notesnook.auth.logout", { status: "signed-out" });
  }

  private async loginInternal(
    generation: number,
    credentials: AuthCredentials,
  ): Promise<AuthSession> {
    this.ensureGeneration(generation);
    const { username, password } = credentials;

    try {
      await this.handle.user.authenticateEmail(username);
    } catch {
      this.ensureGeneration(generation);
      throw upstreamRejectedError("email");
    }
    this.ensureGeneration(generation);

    const emailEnvelope = await this.readEnvelopeIfCurrent(generation);
    if (scopeContainsMfa(emailEnvelope.scope)) {
      await this.submitMfaWithRetry(generation, emailEnvelope);
      this.ensureGeneration(generation);
      await this.submitPasswordWithRetry(generation, username, password);
    } else {
      await this.submitPasswordOnlyWithRetry(generation, username, password);
    }
    this.ensureGeneration(generation);

    const envelope = requireAuthenticatedEnvelope(await this.readEnvelopeIfCurrent(generation));
    const user = await this.readUserIfCurrent(generation);
    this.ensureGeneration(generation);

    const session = envelopeToSession(envelope, user, this.providerNow());
    this.hasActiveSession = true;
    this.logInfo("live.notesnook.auth.login", { status: "authenticated", userId: session.userId });
    // A logger may synchronously call cancelPending().  The queued cleanup
    // must not be awaited from this operation; this check rejects the stale
    // result and lets the next queue item remove the token.
    this.ensureGeneration(generation);
    return session;
  }

  private async refreshInternal(generation: number): Promise<AuthSession> {
    try {
      await this.handle.token._refreshToken(true);
    } catch {
      throw categoricalError("live notesnook token refresh failed");
    }
    this.ensureGeneration(generation);
    const envelope = requireAuthenticatedEnvelope(await this.readEnvelopeIfCurrent(generation));
    const user = await this.readUserIfCurrent(generation);
    this.ensureGeneration(generation);
    const session = envelopeToSession(envelope, user, this.providerNow());
    this.hasActiveSession = true;
    this.logInfo("live.notesnook.auth.refresh", {
      status: "authenticated",
      userId: session.userId,
    });
    this.ensureGeneration(generation);
    return session;
  }

  private providerNow(): number {
    try {
      return this.clock();
    } catch {
      throw categoricalError("live notesnook auth clock failed");
    }
  }

  /** Logging is best-effort; a logger throw never changes the auth result. */
  private logInfo(message: string, record: { status: string; userId?: string }): void {
    try {
      this.logger?.info(message, record);
    } catch {
      // Injected logger failures must never cross the provider boundary.
    }
  }

  /** Best-effort rollback for a login that may have persisted a token. */
  private async compensateLoginToken(generation: number): Promise<void> {
    // A queued logout/cancel is authoritative and will delete after this
    // operation settles.  Never let this stale rollback race a later login.
    if (this.invalidationGeneration !== generation) return;
    try {
      await this.handle.kv.delete(LIVE_NOTESNOOK_KV_TOKEN_KEY);
    } catch {
      // Preserve the original categorical login failure.  Logout/cancel can
      // still retry authoritative cleanup through the state machine.
    }
  }

  private async readEnvelopeIfCurrent(generation: number): Promise<NotesnookLiveTokenEnvelope> {
    this.ensureGeneration(generation);
    let raw: unknown;
    try {
      raw = await this.handle.token.getToken();
    } catch {
      throw categoricalError("live notesnook token read failed");
    }
    this.ensureGeneration(generation);
    return asEnvelope(raw);
  }

  private async readUserIfCurrent(generation: number): Promise<NotesnookLiveUser | undefined> {
    this.ensureGeneration(generation);
    let user: NotesnookLiveUser | undefined;
    try {
      user = await this.handle.user.getUser();
    } catch {
      throw categoricalError("live notesnook user read failed");
    }
    this.ensureGeneration(generation);
    return user;
  }

  private async submitPasswordOnlyWithRetry(
    generation: number,
    email: string,
    initialPassword: string,
  ): Promise<void> {
    let currentPassword = initialPassword;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.passwordMaxAttempts; attempt += 1) {
      this.ensureGeneration(generation);
      try {
        await this.handle.user._login({
          email,
          password: currentPassword,
          hashedPassword: await hashNotesnookPassword(email, currentPassword),
        });
        this.ensureGeneration(generation);
        return;
      } catch {
        this.ensureGeneration(generation);
        lastError = upstreamRejectedError("password");
        if (attempt === this.passwordMaxAttempts) break;
        let next: string | null;
        try {
          next = await this.passwordSupplier();
        } catch {
          this.ensureGeneration(generation);
          throw categoricalError("live notesnook password supplier failed");
        }
        this.ensureGeneration(generation);
        if (next === null) break;
        if (typeof next !== "string" || next.length === 0) {
          throw categoricalError("live notesnook password supplier returned invalid input");
        }
        currentPassword = next;
      }
    }
    throw lastError ?? categoricalError("live notesnook password authentication failed");
  }

  private async submitPasswordWithRetry(
    generation: number,
    email: string,
    initialPassword: string,
  ): Promise<void> {
    let currentPassword = initialPassword;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.passwordMaxAttempts; attempt += 1) {
      this.ensureGeneration(generation);
      try {
        await this.handle.user.authenticatePassword(email, currentPassword);
        this.ensureGeneration(generation);
        return;
      } catch {
        this.ensureGeneration(generation);
        lastError = upstreamRejectedError("password");
        if (attempt === this.passwordMaxAttempts) break;
        let next: string | null;
        try {
          next = await this.passwordSupplier();
        } catch {
          this.ensureGeneration(generation);
          throw categoricalError("live notesnook password supplier failed");
        }
        this.ensureGeneration(generation);
        if (next === null) break;
        if (typeof next !== "string" || next.length === 0) {
          throw categoricalError("live notesnook password supplier returned invalid input");
        }
        currentPassword = next;
      }
    }
    throw lastError ?? categoricalError("live notesnook password authentication failed");
  }

  private async submitMfaWithRetry(
    generation: number,
    _initialEnvelope: NotesnookLiveTokenEnvelope,
  ): Promise<void> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.mfaMaxAttempts; attempt += 1) {
      this.ensureGeneration(generation);
      let code: string | null;
      try {
        code = await this.mfaSupplier();
      } catch {
        this.ensureGeneration(generation);
        throw categoricalError("live notesnook MFA supplier failed");
      }
      this.ensureGeneration(generation);
      if (code === null) {
        // If a submitted code was already rejected, retain that fixed
        // upstream diagnostic when the operator declines another attempt.
        // Before any submission this remains an input-ending error.
        throw (
          lastError ?? categoricalError("live notesnook MFA input ended before a code was entered")
        );
      }
      if (typeof code !== "string" || code.length === 0) {
        throw categoricalError("live notesnook MFA supplier returned invalid input");
      }
      try {
        await this.handle.user.authenticateMultiFactorCode(code, "app");
        this.ensureGeneration(generation);
        return;
      } catch {
        this.ensureGeneration(generation);
        lastError = upstreamRejectedError("mfa");
      }
    }
    throw lastError ?? categoricalError("live notesnook MFA authentication failed");
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

type NormalizedProviderOptions = Readonly<{
  handle: unknown;
  passwordSupplier: unknown;
  mfaSupplier: unknown;
  mfaMaxAttempts: unknown;
  passwordMaxAttempts: unknown;
  clock: unknown;
  cleanupHook: unknown;
  logger: unknown;
}>;

function normalizeProviderOptions(options: unknown): NormalizedProviderOptions {
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw categoricalError("invalid live notesnook auth provider options");
    }
    const candidate = options as Record<string, unknown>;
    return {
      handle: candidate.handle,
      passwordSupplier: candidate.passwordSupplier,
      mfaSupplier: candidate.mfaSupplier,
      mfaMaxAttempts: candidate.mfaMaxAttempts,
      passwordMaxAttempts: candidate.passwordMaxAttempts,
      clock: candidate.clock,
      cleanupHook: candidate.cleanupHook,
      logger: candidate.logger,
    };
  } catch {
    throw categoricalError("invalid live notesnook auth provider options");
  }
}

function validateHandle(handle: unknown): asserts handle is NotesnookLiveCoreHandle {
  try {
    if (typeof handle !== "object" || handle === null || Array.isArray(handle)) {
      throw categoricalError("invalid live notesnook handle: expected a factory handle object");
    }
    const h = handle as Record<string, unknown>;
    const userSlot = h.user;
    const tokenSlot = h.token;
    const kvSlot = h.kv;
    if (!userSlot || typeof userSlot !== "object") {
      throw categoricalError("invalid live notesnook handle: user slot is required");
    }
    if (!tokenSlot || typeof tokenSlot !== "object") {
      throw categoricalError("invalid live notesnook handle: token slot is required");
    }
    if (!kvSlot || typeof kvSlot !== "object") {
      throw categoricalError("invalid live notesnook handle: kv slot is required");
    }
    const user = userSlot as Record<string, unknown>;
    for (const method of [
      "authenticateEmail",
      "authenticateMultiFactorCode",
      "authenticatePassword",
      "_login",
      "getUser",
      "logout",
    ]) {
      if (typeof user[method] !== "function") {
        throw categoricalError(`invalid live notesnook handle: user.${method} is required`);
      }
    }
    const token = tokenSlot as Record<string, unknown>;
    for (const method of ["getToken", "_refreshToken"]) {
      if (typeof token[method] !== "function") {
        throw categoricalError(`invalid live notesnook handle: token.${method} is required`);
      }
    }
    const kv = kvSlot as Record<string, unknown>;
    for (const method of ["read", "write", "delete"]) {
      if (typeof kv[method] !== "function") {
        throw categoricalError(`invalid live notesnook handle: kv.${method} is required`);
      }
    }
  } catch (error) {
    if (isAuthProviderError(error)) throw error;
    throw categoricalError("invalid live notesnook handle");
  }
}

function validateLogger(logger: unknown): asserts logger is Logger | null | undefined {
  if (logger === undefined || logger === null) return;
  const requiredMethods = ["info", "debug", "warn", "error", "child", "setSink"] as const;
  let methods: unknown[];
  try {
    if (typeof logger !== "object" || Array.isArray(logger)) {
      throw categoricalError("invalid live notesnook logger: expected a logger object");
    }
    methods = requiredMethods.map((method) => (logger as Record<string, unknown>)[method]);
  } catch {
    throw categoricalError("invalid live notesnook logger: could not be read");
  }
  for (let i = 0; i < requiredMethods.length; i += 1) {
    if (typeof methods[i] !== "function") {
      throw categoricalError(`invalid live notesnook logger: ${requiredMethods[i]} is required`);
    }
  }
}

function validateCredentials(credentials: unknown): AuthCredentials {
  let validRoot = false;
  let username: unknown;
  let password: unknown;
  try {
    validRoot =
      typeof credentials === "object" && credentials !== null && !Array.isArray(credentials);
    if (validRoot) {
      const candidate = credentials as { username?: unknown; password?: unknown };
      username = candidate.username;
      password = candidate.password;
    }
  } catch {
    throw categoricalError("live notesnook login credentials could not be read");
  }
  if (!validRoot) {
    throw categoricalError("live notesnook login requires a credentials object");
  }
  if (typeof username !== "string" || username.length === 0) {
    throw categoricalError("live notesnook login requires a non-empty email");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw categoricalError("live notesnook login requires a non-empty password");
  }
  return { username, password };
}

/**
 * Validate and shape a raw upstream response into a typed envelope.
 * Throws a categorical error on malformed input; the error message
 * never contains any token bytes, password bytes, or MFA code.
 */
function asEnvelope(raw: unknown): NotesnookLiveTokenEnvelope {
  if (raw === undefined || raw === null) {
    throw categoricalError("live notesnook token envelope is missing");
  }
  if (typeof raw !== "object") {
    throw categoricalError("live notesnook token envelope is not an object");
  }
  let access: unknown;
  let refresh: unknown;
  let expiresIn: unknown;
  let scope: unknown;
  let t: unknown;
  try {
    const r = raw as Record<string, unknown>;
    access = r["access_token"];
    refresh = r["refresh_token"];
    expiresIn = r["expires_in"];
    scope = r["scope"];
    t = r["t"];
  } catch {
    throw categoricalError("live notesnook token envelope could not be read");
  }
  if (typeof access !== "string" || access.length === 0) {
    throw categoricalError("live notesnook token envelope is missing access_token");
  }
  if (refresh !== undefined && typeof refresh !== "string") {
    throw categoricalError("live notesnook token envelope has invalid refresh_token");
  }
  if (typeof scope !== "string") {
    throw categoricalError("live notesnook token envelope is missing scope");
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw categoricalError("live notesnook token envelope is missing expires_in");
  }
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
    throw categoricalError("live notesnook token envelope is missing t");
  }
  return Object.freeze({
    access_token: access,
    ...(refresh === undefined ? {} : { refresh_token: refresh }),
    expires_in: expiresIn,
    scope,
    t,
  });
}

/**
 * Translate an upstream token envelope into the public
 * `AuthSession` shape.  Refuses to expose `refresh_token`.  Uses
 * the envelope's `t` value (upstream epoch milliseconds) as the
 * base for `issuedAt` and `expiresAt` — both returned in
 * milliseconds.  The session's `userId` is the upstream user's
 * `id` (no token-derived hash).
 */
function requireAuthenticatedEnvelope(
  envelope: NotesnookLiveTokenEnvelope,
): AuthenticatedTokenEnvelope {
  if (typeof envelope.refresh_token !== "string" || envelope.refresh_token.length === 0) {
    throw categoricalError("live notesnook authenticated token envelope is missing refresh_token");
  }
  return envelope as AuthenticatedTokenEnvelope;
}

function envelopeToSession(
  envelope: AuthenticatedTokenEnvelope,
  user: NotesnookLiveUser | undefined,
  now: number,
): AuthSession {
  const issuedAt = envelope.t;
  const expiresAt = envelope.t + envelope.expires_in * 1000;
  if (!Number.isFinite(now)) {
    throw categoricalError("live notesnook auth clock must return a finite number");
  }
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw categoricalError("live notesnook token envelope expires_at is not after issued_at");
  }
  if (expiresAt <= now) {
    throw categoricalError("live notesnook token envelope is expired");
  }
  if (!user || typeof user.id !== "string" || user.id.length === 0) {
    throw categoricalError("live notesnook user record is missing id");
  }
  const session: AuthSession = {
    userId: user.id,
    accessToken: envelope.access_token,
    issuedAt,
    expiresAt,
  };
  return Object.freeze(session);
}

function scopeContainsMfa(scope: string): boolean {
  return scope === MFA_REQUIRED_SCOPE;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw categoricalError(`live notesnook auth provider ${name} must be a positive integer`);
  }
  return value;
}

/**
 * Convenience factory — equivalent to `new LiveNotesnookAuthProvider(opts)`.
 */
export function createLiveNotesnookAuthProvider(
  options: LiveNotesnookAuthProviderOptions,
): LiveNotesnookAuthProvider {
  return new LiveNotesnookAuthProvider(options);
}
