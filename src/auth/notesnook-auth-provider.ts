/**
 * Stage 2B-live — offline mocked Notesnook UserManager/TokenManager
 * authentication provider.
 *
 * This module translates the verified upstream `@notesnook/core@8.1.3`
 * authentication sequence into the existing Stage 2A
 * `AuthCoordinator` boundary.  It is **strictly offline**: the
 * provider never imports `@notesnook/core`, never opens a network
 * socket, and never talks to a real Notesnook account.  It accepts
 * only an injected, structurally-typed database handle whose methods
 * mirror the upstream `Database.user` and `Database.tokenManager`
 * surface documented in `docs/upstream-contract.md`.
 *
 * Verified upstream contract (pinned commit
 * `c9c4936d9e8222b86204781cd1c93cdf2a1738d3`):
 *
 *   1. `db.user.authenticateEmail(email)`
 *   2. (Optional) `db.user.authenticateMultiFactorCode(code, "app")`
 *      when the returned token scope contains
 *      `auth:grant_types:mfa`.
 *   3. `db.user.authenticatePassword(email, password)`
 *   4. `db.tokenManager._refreshToken(true)` for refresh.
 *   5. `db.user.logout(true)` for logout.  The provider must also
 *      delete `kv.token` explicitly because `db.reset()` does NOT
 *      clear it on its own.
 *
 * Token shape (verified upstream): the response carries
 * `access_token`, `t`, `expires_in`, `scope`, `refresh_token`.  The
 * provider persists this envelope under `kv.token` and translates it
 * into the public `AuthSession` shape, which intentionally does NOT
 * expose the refresh token to upstream callers.
 *
 * Hard invariants:
 *
 *   - The provider accepts only an injected database handle whose
 *     shape matches {@link NotesnookDatabaseHandle}.  It never accepts
 *     arbitrary transports or a generic core passthrough.
 *   - `refresh_token` never appears in the public session returned to
 *     the AuthCoordinator; the only path to it is the encrypted
 *     `kv.token` envelope in IStorage.
 *   - Errors thrown by the provider are categorical — they never
 *     include raw password bytes, MFA codes, access tokens, refresh
 *     tokens, or upstream response bodies.
 *   - Concurrent refresh calls converge to a single persisted envelope;
 *     losers are rejected deterministically.
 *   - Logout revokes the upstream token, deletes `kv.token` BEFORE
 *     clearing local state, and clears local state via the REQUIRED
 *     injected seam (`clearLocalState`) so the caller controls the
 *     destructive step.  `db.reset()` is not invoked directly here —
 *     the seam is the explicit boundary.
 *   - Raw credentials never enter the structured logger.  All log
 *     records carry only an opaque identifier derived from the
 *     normalized session and never the token bytes.
 */

import type { Logger } from "../logging/logger.js";
import type { IStorage } from "../storage/istorage.js";
import {
  markAuthProviderError,
  type AuthCredentials,
  type AuthProvider,
  type AuthSession,
} from "./types.js";

/**
 * The verified upstream token envelope shape.  Persisted under
 * `kv.token` in the encrypted IStorage; never returned in public
 * session state.
 */
export type NotesnookTokenEnvelope = Readonly<{
  access_token: string;
  t: number;
  expires_in: number;
  scope: string;
  refresh_token: string;
}>;

/**
 * The narrowed structural shape the provider accepts from callers.
 * Mirrors the relevant subset of the upstream `@notesnook/core`
 * `Database.user` and `Database.tokenManager` surfaces.  Keeping the
 * shape explicit (rather than `unknown` or `any`) is what makes the
 * provider a narrow seam rather than a generic core passthrough.
 */
export interface NotesnookUserManager {
  authenticateEmail(email: string): Promise<unknown>;
  authenticateMultiFactorCode(code: string, type: "app"): Promise<unknown>;
  authenticatePassword(email: string, password: string, hashed?: boolean): Promise<unknown>;
  getUser(): Promise<{ id: string; email: string }>;
  logout(clearLocal: boolean): Promise<void>;
}

export interface NotesnookTokenManager {
  getToken(): Promise<unknown>;
  _refreshToken(forceRenew: boolean): Promise<unknown>;
}

export interface NotesnookDatabaseHandle {
  user: NotesnookUserManager;
  tokenManager: NotesnookTokenManager;
}

/**
 * Caller-supplied function used by the provider to obtain a second
 * password attempt when an upstream `authenticatePassword` call
 * rejects the first attempt.  Production code wires this to the
 * Stage 2B interactive TTY prompt; tests inject a stub that returns
 * a deterministic value.
 *
 * Returning `null` signals that no further password is available —
 * the provider rejects the login.
 */
export type PasswordSupplier = () => Promise<string | null>;

/**
 * Caller-supplied function used by the provider to obtain an MFA
 * code when the upstream scope requires one.  Same null-signal
 * semantics as {@link PasswordSupplier}.
 */
export type MfaSupplier = () => Promise<string | null>;

/**
 * Options accepted by the provider constructor.
 *
 * `clearLocalState` is the only seam through which the provider can
 * wipe local encrypted state.  The seam is REQUIRED so the provider
 * never invokes `db.reset()` itself — `db.reset()` is a destructive
 * upstream operation that the production code path will own in a
 * later slice.
 */
export type NotesnookAuthProviderOptions = Readonly<{
  /** Injected database handle. */
  core: NotesnookDatabaseHandle;
  /** Injected encrypted IStorage used to persist `kv.token`. */
  storage: IStorage;
  /** Optional injected password supplier for retry paths. */
  passwordSupplier?: PasswordSupplier;
  /** Optional injected MFA supplier. */
  mfaSupplier?: MfaSupplier;
  /** Maximum attempts the MFA supplier is consulted.  Defaults to 3. */
  mfaMaxAttempts?: number;
  /** Maximum attempts the password supplier is consulted.  Defaults to 3. */
  passwordMaxAttempts?: number;
  /** Clock used to reject envelopes that are already expired. */
  clock?: () => number;
  /**
   *     Required hook invoked AFTER `kv.token` is removed and AFTER
   *     `user.logout(true)` resolves.  The hook is the only path through
   *     which the provider wipes local encrypted state; callers that wire
   *     it to `db.reset()` must do so explicitly.
   */
  clearLocalState: () => void | Promise<void>;
  /** Optional structured logger.  No credentials are ever logged. */
  logger?: Logger;
}>;

/** The key under which the provider persists the token envelope. */
export const NOTESNOOK_TOKEN_KEY = "kv.token" as const;

/**
 * Default MFA retry attempts.  Mirrors the Stage 2B secret-input
 * `DEFAULT_MAX_ATTEMPTS` boundary.
 */
const DEFAULT_MFA_MAX_ATTEMPTS = 3;

/**
 * Default password retry attempts.  The Stage 2B TTY pipeline caps at
 * 3 reads; we mirror that here so the upstream retry loop and the
 * downstream credential-collection loop agree.
 */
const DEFAULT_PASSWORD_MAX_ATTEMPTS = 3;

/**
 * Sentinel scope value the upstream `authenticateEmail` returns when
 * the account requires MFA on top of the email + password round.
 */
const MFA_REQUIRED_SCOPE = "auth:grant_types:mfa" as const;

const SCOPE_SEPARATOR = " ";

/** Private control value for the provider's stale-operation path. */
const PERSISTENCE_SUPERSEDED = Symbol("notesnook persistence superseded");

/**
 * The mocked Notesnook auth provider.  Implements `AuthProvider` so
 * it composes with the existing Stage 2A `AuthCoordinator`.  No
 * runtime `@notesnook/core` import, no live transport, no signup,
 * no MFA enrollment, no password reset, no SSE, no sync, and no
 * generic core passthrough.
 */
export class NotesnookAuthProvider implements AuthProvider {
  private readonly core: NotesnookDatabaseHandle;
  private readonly storage: IStorage;
  private readonly passwordSupplier: PasswordSupplier;
  private readonly mfaSupplier: MfaSupplier;
  private readonly mfaMaxAttempts: number;
  private readonly passwordMaxAttempts: number;
  private readonly clock: () => number;
  private readonly clearLocalState: () => void | Promise<void>;
  private readonly logger: Logger | undefined;
  /**
   * At most one refresh may be in flight.  A competing call is rejected
   * rather than queued, so the provider has one deterministic persistence
   * winner; the coordinator's generation guards remain unchanged.
   */
  private refreshInFlight: Promise<AuthSession> | undefined;
  /** Invalidates completions from login/refresh when logout begins. */
  private operationEpoch = 0;
  /** A refresh is valid only after login/restore has activated this session. */
  private activeSessionEpoch: number | undefined;
  /** Serializes the remove/write critical section at the persistence boundary. */
  private persistenceTail: Promise<void> = Promise.resolve();
  /** A login may follow logout, but refresh may not race it. */
  private logoutInFlight: Promise<void> | undefined;

  constructor(options: NotesnookAuthProviderOptions) {
    const normalized = normalizeProviderOptions(options);
    validateCore(normalized.core);
    validateStorage(normalized.storage);
    if (typeof normalized.clearLocalState !== "function") {
      throw categoricalError("notesnook auth provider requires clearLocalState");
    }
    const passwordSupplier = normalized.passwordSupplier ?? defaultPasswordSupplier;
    if (typeof passwordSupplier !== "function") {
      throw categoricalError("notesnook auth provider password supplier must be a function");
    }
    const mfaSupplier = normalized.mfaSupplier ?? defaultMfaSupplier;
    if (typeof mfaSupplier !== "function") {
      throw categoricalError("notesnook auth provider MFA supplier must be a function");
    }
    const clock = normalized.clock ?? Date.now;
    if (typeof clock !== "function") {
      throw categoricalError("notesnook auth provider clock must be a function");
    }
    validateLogger(normalized.logger);
    this.core = normalized.core;
    this.storage = normalized.storage;
    this.passwordSupplier = passwordSupplier as PasswordSupplier;
    this.mfaSupplier = mfaSupplier as MfaSupplier;
    this.mfaMaxAttempts = positiveInteger(
      normalized.mfaMaxAttempts ?? DEFAULT_MFA_MAX_ATTEMPTS,
      "mfaMaxAttempts",
    );
    this.passwordMaxAttempts = positiveInteger(
      normalized.passwordMaxAttempts ?? DEFAULT_PASSWORD_MAX_ATTEMPTS,
      "passwordMaxAttempts",
    );
    this.clock = clock as () => number;
    const hook = normalized.clearLocalState;
    this.clearLocalState = () => hook();
    this.logger = normalized.logger as Logger | undefined;
  }

  /**
   * Drive the upstream login sequence and return a normalized,
   * refresh-token-free session.  The session's `expiresAt` reflects
   * the upstream `expires_in` value against the provider's internal
   * clock (the call-site clock that {@link NotesnookAuthProvider}
   * uses to derive `issuedAt`).
   */
  async login(credentials: AuthCredentials): Promise<AuthSession> {
    const validated = validateCredentials(credentials);
    // Capture this operation's generation before any await.  In particular,
    // a signed-out coordinator login can be paused here while logout calls
    // cancelPending(); adopting the post-logout epoch would let that stale
    // login authenticate and persist a token anyway.
    const epoch = ++this.operationEpoch;
    await this.waitForLogout();
    this.ensureOperationCurrent(epoch);
    const { username, password } = validated;

    // Step 1: upstream authenticateEmail.  Per the verified contract,
    // this returns a token whose scope tells us whether MFA is
    // required.
    let initialRaw: unknown;
    try {
      initialRaw = await this.core.user.authenticateEmail(username);
    } catch {
      this.ensureOperationCurrent(epoch);
      throw categoricalError("notesnook email authentication failed");
    }
    this.ensureOperationCurrent(epoch);
    const initialEnvelope = asEnvelope(initialRaw);

    // Step 2: optional MFA.  When the upstream scope contains the
    // `auth:grant_types:mfa` marker we MUST submit an MFA code via
    // `authenticateMultiFactorCode(code, "app")` before the password
    // round.  We re-issue the email-auth round so the MFA submission
    // path is observable in the call journal.
    let envelope = initialEnvelope;
    if (scopeContainsMfa(initialEnvelope.scope)) {
      envelope = await this.submitMfaWithRetry(epoch);
      this.ensureOperationCurrent(epoch);
    }

    // Step 3: password.  Retry up to `passwordMaxAttempts` against
    // the same upstream handle without re-issuing authenticateEmail.
    envelope = await this.submitPasswordWithRetry(epoch, username, password);
    this.ensureOperationCurrent(epoch);

    // Validate and translate before persisting.  Invalid or expired
    // envelopes must never reach the storage boundary.
    const session = envelopeToSession(envelope, this.providerNow());
    await this.persistIfCurrent(epoch, envelope);
    this.ensureOperationCurrent(epoch);
    this.activeSessionEpoch = epoch;
    this.logInfo("notesnook.auth.login", {
      status: "authenticated",
      userId: session.userId,
    });
    return session;
  }

  /**
   * Refresh the persisted envelope by calling the narrow upstream
   * `tokenManager._refreshToken(true)` seam.
   * and translating the returned envelope into a normalized session.
   *
   * Concurrent calls to {@link refresh} from the same provider
   * instance are serialized via an in-memory gate so only one
   * upstream refreshToken round happens at a time.  The loser of the
   * race rejects deterministically with a categorical error and never
   * mutates the persisted envelope.
   */
  async refresh(_session: AuthSession): Promise<AuthSession> {
    if (this.logoutInFlight) {
      throw categoricalError("notesnook refresh unavailable during logout");
    }
    if (this.activeSessionEpoch === undefined) {
      throw categoricalError("notesnook refresh unavailable without an active session");
    }
    if (this.refreshInFlight) {
      throw categoricalError("notesnook refresh already in progress");
    }
    const epoch = ++this.operationEpoch;
    const operation = this.refreshInternal(epoch);
    this.refreshInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.refreshInFlight === operation) this.refreshInFlight = undefined;
    }
  }

  /**
   * Rehydrate an existing session directly from the encrypted
   * `kv.token` envelope.  Returns `null` only when no envelope exists.
   * A present envelope is untrusted persisted state: malformed or expired
   * data fails with a stable categorical validation error rather than being
   * silently treated as a signed-out state.
   */
  async restoreSession(): Promise<AuthSession | null> {
    // This generation must be captured synchronously.  If logout starts
    // after the initial no-op wait has been checked but before its
    // continuation runs, the read is still part of the stale restore.
    const epoch = this.operationEpoch;
    await this.waitForLogout();
    if (!this.isOperationCurrent(epoch)) return null;
    let raw: unknown;
    try {
      raw = await this.storage.read<unknown>(NOTESNOOK_TOKEN_KEY);
    } catch {
      if (!this.isOperationCurrent(epoch)) return null;
      throw categoricalError("notesnook token storage read failed");
    }
    // Logout invalidates all in-flight operations, including reads that
    // began before it removed kv.token. Never rehydrate a stale value that
    // crossed that boundary after the read resolved.
    if (!this.isOperationCurrent(epoch)) return null;
    if (raw === undefined) return null;
    if (!this.isOperationCurrent(epoch)) return null;
    const envelope = asEnvelope(raw);
    if (!this.isOperationCurrent(epoch)) return null;
    const session = envelopeToSession(envelope, this.providerNow());
    if (!this.isOperationCurrent(epoch)) return null;
    this.activeSessionEpoch = epoch;
    return session;
  }

  /**
   * Logout: revoke the upstream token (passing `true` so the
   * upstream handle clears its own cache), delete the local
   * `kv.token` envelope, and clear the local encrypted state via
   * the injected `clearLocalState` seam.  The local clear runs
   * AFTER the envelope removal so a crash between the two leaves
   * the encrypted state tokenless rather than the other way around.
   */
  async logout(_session: AuthSession): Promise<void> {
    if (this.logoutInFlight) return this.logoutInFlight;
    ++this.operationEpoch;
    this.activeSessionEpoch = undefined;
    const operation = this.logoutInternal();
    this.logoutInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.logoutInFlight === operation) this.logoutInFlight = undefined;
    }
  }

  /**
   * Invalidate pending login/refresh completions without requiring a current
   * public session. The persistence guard observes this epoch before and
   * after every token write, so a cancelled login cannot recreate kv.token.
   */
  cancelPending(): void {
    ++this.operationEpoch;
    this.activeSessionEpoch = undefined;
  }

  private async logoutInternal(): Promise<void> {
    let failure: Error | undefined;
    try {
      await this.core.user.logout(true);
    } catch {
      failure = categoricalError("notesnook logout failed");
    }
    await this.withPersistenceLock(async () => {
      // Always delete the local envelope — even if upstream logout
      // throws.  Upstream `db.reset()` does not remove kv.token.
      try {
        await this.storage.remove(NOTESNOOK_TOKEN_KEY);
      } catch {
        failure ??= categoricalError("notesnook token cleanup failed");
      }
      try {
        // This required seam is deliberately after token removal and
        // remains inside the persistence critical section.
        await this.clearLocalState();
      } catch {
        failure ??= categoricalError("notesnook local-state cleanup failed");
      }
    });
    if (failure) throw failure;
    this.logInfo("notesnook.auth.logout", { status: "signed-out" });
  }

  /**
   * Internal refresh path.  Serialized by the public `refresh` gate so
   * two concurrent refreshes converge to a single upstream round.
   */
  private async refreshInternal(epoch: number): Promise<AuthSession> {
    let raw: unknown;
    try {
      raw = await this.core.tokenManager._refreshToken(true);
    } catch {
      throw categoricalError("notesnook token refresh failed");
    }
    const envelope = asEnvelope(raw);
    // Validate and translate before persisting.  A malformed or expired
    // refresh response must not overwrite the last valid envelope.
    const session = envelopeToSession(envelope, this.providerNow());
    await this.persistIfCurrent(epoch, envelope);
    this.activeSessionEpoch = epoch;
    this.logInfo("notesnook.auth.refresh", {
      status: "authenticated",
      userId: session.userId,
    });
    return session;
  }

  private async waitForLogout(): Promise<void> {
    if (this.logoutInFlight) await this.logoutInFlight;
  }

  private ensureOperationCurrent(epoch: number): void {
    if (!this.isOperationCurrent(epoch)) {
      throw categoricalError("notesnook auth operation superseded");
    }
  }

  private isOperationCurrent(epoch: number): boolean {
    return this.operationEpoch === epoch;
  }

  private providerNow(): number {
    try {
      return this.clock();
    } catch {
      throw categoricalError("notesnook auth clock failed");
    }
  }

  /** Logging is an untrusted injected boundary and is always best-effort. */
  private logInfo(message: string, record: { status: string; userId?: string }): void {
    try {
      this.logger?.info(message, record);
    } catch {
      // A logger failure must never turn a successful auth operation into a
      // raw, potentially secret-bearing error after persistence completed.
    }
  }

  private async persistIfCurrent(epoch: number, envelope: NotesnookTokenEnvelope): Promise<void> {
    try {
      await this.withPersistenceLock(async () => {
        if (this.operationEpoch !== epoch) {
          throw PERSISTENCE_SUPERSEDED;
        }
        await this.storage.write(NOTESNOOK_TOKEN_KEY, envelope);
        if (this.operationEpoch !== epoch) {
          // The write was allowed to finish inside the lock, but logout (or
          // another newer operation) invalidated this result while storage
          // was awaiting.  Remove the stale value before releasing the lock;
          // logout then performs its own idempotent cleanup after us.
          try {
            await this.storage.remove(NOTESNOOK_TOKEN_KEY);
          } catch {
            // Preserve the categorical superseded result.  A concurrent
            // logout owns the next cleanup turn and will retry removal.
          }
          throw PERSISTENCE_SUPERSEDED;
        }
      });
    } catch (error) {
      if (error === PERSISTENCE_SUPERSEDED) {
        throw categoricalError("notesnook auth operation superseded");
      }
      throw categoricalError("notesnook token storage write failed");
    }
  }

  private async withPersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.persistenceTail;
    let release!: () => void;
    this.persistenceTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Submit the password to the upstream handle, retrying through the
   * injected supplier on rejection.  Returns the final envelope on
   * success and throws on exhaustion.  The initial password is held
   * in a local variable only for the lifetime of this call — it is
   * never persisted, logged, or stored on the provider instance.
   */
  private async submitPasswordWithRetry(
    epoch: number,
    email: string,
    initialPassword: string,
  ): Promise<NotesnookTokenEnvelope> {
    let currentPassword = initialPassword;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.passwordMaxAttempts; attempt += 1) {
      this.ensureOperationCurrent(epoch);
      let raw: unknown;
      try {
        raw = await this.core.user.authenticatePassword(email, currentPassword);
      } catch {
        this.ensureOperationCurrent(epoch);
        lastError = categoricalError("notesnook password authentication failed");
        if (attempt === this.passwordMaxAttempts) break;
        let next: string | null;
        try {
          next = await this.passwordSupplier();
        } catch {
          this.ensureOperationCurrent(epoch);
          throw categoricalError("notesnook password supplier failed");
        }
        this.ensureOperationCurrent(epoch);
        if (next === null) break;
        if (typeof next !== "string" || next.length === 0) {
          throw categoricalError("notesnook password supplier returned invalid input");
        }
        currentPassword = next;
        continue;
      }
      // Envelope validation is deliberately outside the authentication
      // catch: a malformed success response is not a retryable password
      // failure and must never prompt for, or submit, another password.
      this.ensureOperationCurrent(epoch);
      return asEnvelope(raw);
    }
    throw lastError ?? categoricalError("notesnook password authentication failed");
  }

  /**
   * Collect an MFA code from the injected supplier, retrying up to
   * `mfaMaxAttempts` times.  Throws on exhaustion with a categorical
   * error message that contains no MFA code bytes.
   */
  private async submitMfaWithRetry(epoch: number): Promise<NotesnookTokenEnvelope> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.mfaMaxAttempts; attempt += 1) {
      this.ensureOperationCurrent(epoch);
      let code: string | null;
      try {
        code = await this.mfaSupplier();
      } catch {
        this.ensureOperationCurrent(epoch);
        throw categoricalError("notesnook MFA supplier failed");
      }
      this.ensureOperationCurrent(epoch);
      if (code === null) {
        throw categoricalError("mfa input ended before a code was entered");
      }
      if (typeof code !== "string" || code.length === 0) {
        throw categoricalError("notesnook MFA supplier returned invalid input");
      }
      let raw: unknown;
      try {
        raw = await this.core.user.authenticateMultiFactorCode(code, "app");
      } catch {
        this.ensureOperationCurrent(epoch);
        lastError = categoricalError("notesnook MFA authentication failed");
        continue;
      }
      this.ensureOperationCurrent(epoch);
      return asEnvelope(raw);
    }
    throw lastError ?? categoricalError("notesnook MFA authentication failed");
  }

  /**
   * No per-instance password cache — passwords flow through local
   * variables inside `submitPasswordWithRetry` only and never live
   * on the provider instance.
   */
}

// ---------------------------------------------------------------------------
// Helpers — kept local so the public surface stays narrow.
// ---------------------------------------------------------------------------

type NormalizedProviderOptions = Readonly<{
  core: unknown;
  storage: unknown;
  passwordSupplier: unknown;
  mfaSupplier: unknown;
  mfaMaxAttempts: unknown;
  passwordMaxAttempts: unknown;
  clock: unknown;
  clearLocalState: unknown;
  logger: unknown;
}>;

/**
 * Read the complete constructor option boundary before validating any member.
 * Option objects are caller-controlled runtime values: getters, proxies, and
 * revoked proxies must never be able to leak their exception text or chain.
 */
function normalizeProviderOptions(options: unknown): NormalizedProviderOptions {
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw categoricalError("invalid Notesnook auth provider options");
    }
    const candidate = options as Record<string, unknown>;
    return {
      core: candidate.core,
      storage: candidate.storage,
      passwordSupplier: candidate.passwordSupplier,
      mfaSupplier: candidate.mfaSupplier,
      mfaMaxAttempts: candidate.mfaMaxAttempts,
      passwordMaxAttempts: candidate.passwordMaxAttempts,
      clock: candidate.clock,
      clearLocalState: candidate.clearLocalState,
      logger: candidate.logger,
    };
  } catch {
    throw categoricalError("invalid Notesnook auth provider options");
  }
}

/** Create a stable provider error with no upstream cause/context attached. */
function categoricalError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  return markAuthProviderError(error);
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
    throw categoricalError("notesnook login credentials could not be read");
  }
  if (!validRoot) {
    throw categoricalError("notesnook login requires a credentials object");
  }
  if (typeof username !== "string" || username.length === 0) {
    throw categoricalError("notesnook login requires a non-empty email");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw categoricalError("notesnook login requires a non-empty password");
  }
  return { username, password };
}

/**
 * Default no-op suppliers.  Production callers MUST inject a real
 * supplier (the Stage 2B TTY prompt); tests inject a deterministic
 * stub.  When the default is used the provider cannot retry — that
 * is intentional: a default is a refusal-by-omission.
 */
const defaultPasswordSupplier: PasswordSupplier = async () => null;
const defaultMfaSupplier: MfaSupplier = async () => null;

/**
 * Branded type guard for the upstream database handle.  Rejects
 * handles that do not expose the methods the provider needs.
 */
function validateCore(core: unknown): asserts core is NotesnookDatabaseHandle {
  const requiredUserMethods = [
    "authenticateEmail",
    "authenticateMultiFactorCode",
    "authenticatePassword",
    "getUser",
    "logout",
  ] as const;
  const requiredTokenMethods = ["getToken", "_refreshToken"] as const;
  let validRoot = false;
  let user: unknown;
  let tokenManager: unknown;
  let userMethods: unknown[] | undefined;
  let tokenMethods: unknown[] | undefined;
  try {
    validRoot = typeof core === "object" && core !== null && !Array.isArray(core);
    if (validRoot) {
      const candidate = core as { user?: unknown; tokenManager?: unknown };
      user = candidate.user;
      tokenManager = candidate.tokenManager;
      if (user && typeof user === "object") {
        userMethods = requiredUserMethods.map(
          (method) => (user as Record<string, unknown>)[method],
        );
      }
      if (tokenManager && typeof tokenManager === "object") {
        tokenMethods = requiredTokenMethods.map(
          (method) => (tokenManager as Record<string, unknown>)[method],
        );
      }
    }
  } catch {
    // Property getters, proxies, and revoked proxies are caller-controlled
    // runtime values. Do not allow their exception text or chains to cross
    // the constructor boundary.
    throw categoricalError("invalid Notesnook handle: could not be read");
  }
  if (!validRoot) {
    throw categoricalError("invalid Notesnook handle: expected a database object");
  }
  if (!user || typeof user !== "object") {
    throw categoricalError("invalid Notesnook handle: user manager is required");
  }
  if (!tokenManager || typeof tokenManager !== "object") {
    throw categoricalError("invalid Notesnook handle: token manager is required");
  }
  for (let i = 0; i < requiredUserMethods.length; i += 1) {
    if (typeof userMethods?.[i] !== "function") {
      throw categoricalError(
        `invalid Notesnook handle: user.${requiredUserMethods[i]} is required`,
      );
    }
  }
  for (let i = 0; i < requiredTokenMethods.length; i += 1) {
    if (typeof tokenMethods?.[i] !== "function") {
      throw categoricalError(
        `invalid Notesnook handle: tokenManager.${requiredTokenMethods[i]} is required`,
      );
    }
  }
}

/** Validate the storage methods used by this provider's persistence seam. */
function validateStorage(storage: unknown): asserts storage is IStorage {
  const requiredMethods = ["read", "write", "remove"] as const;
  let validRoot = false;
  let methods: unknown[] | undefined;
  try {
    validRoot = typeof storage === "object" && storage !== null && !Array.isArray(storage);
    if (validRoot) {
      methods = requiredMethods.map((method) => (storage as Record<string, unknown>)[method]);
    }
  } catch {
    throw categoricalError("invalid Notesnook storage: could not be read");
  }
  if (!validRoot) {
    throw categoricalError("invalid Notesnook storage: expected a storage object");
  }
  for (let i = 0; i < requiredMethods.length; i += 1) {
    if (typeof methods?.[i] !== "function") {
      throw categoricalError(`invalid Notesnook storage: ${requiredMethods[i]} is required`);
    }
  }
}

function validateLogger(logger: unknown): asserts logger is Logger | null | undefined {
  if (logger === undefined || logger === null) return;
  const requiredMethods = ["info", "debug", "warn", "error", "child", "setSink"] as const;
  let methods: unknown[];
  try {
    if (typeof logger !== "object" || Array.isArray(logger)) {
      throw categoricalError("invalid Notesnook logger: expected a logger object");
    }
    methods = requiredMethods.map((method) => (logger as Record<string, unknown>)[method]);
  } catch {
    throw categoricalError("invalid Notesnook logger: could not be read");
  }
  for (let i = 0; i < requiredMethods.length; i += 1) {
    if (typeof methods[i] !== "function") {
      throw categoricalError(`invalid Notesnook logger: ${requiredMethods[i]} is required`);
    }
  }
}

/**
 * Validate and shape a raw upstream response into a typed envelope.
 * Throws a categorical error on malformed input; the error message
 * never contains any token bytes or password/MFA code.
 */
function asEnvelope(raw: unknown): NotesnookTokenEnvelope {
  if (typeof raw !== "object" || raw === null) {
    throw categoricalError("invalid token envelope: upstream returned a non-object");
  }
  let access: unknown;
  let t: unknown;
  let expiresIn: unknown;
  let scope: unknown;
  let refresh: unknown;
  try {
    const r = raw as Record<string, unknown>;
    access = r["access_token"];
    t = r["t"];
    expiresIn = r["expires_in"];
    scope = r["scope"];
    refresh = r["refresh_token"];
  } catch {
    // Upstream responses are untrusted runtime values. In particular,
    // getters, proxies, and revoked proxies must not leak their exception
    // text, cause, context, or response payload.
    throw categoricalError("invalid token envelope: upstream response could not be read");
  }
  if (typeof access !== "string" || access.length === 0) {
    throw categoricalError("invalid token envelope: missing access_token");
  }
  if (typeof refresh !== "string" || refresh.length === 0) {
    throw categoricalError("invalid token envelope: missing refresh_token");
  }
  if (typeof scope !== "string") {
    throw categoricalError("invalid token envelope: missing scope");
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw categoricalError("invalid token envelope: missing expires_in");
  }
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
    throw categoricalError("invalid token envelope: missing t");
  }
  return {
    access_token: access,
    t,
    expires_in: expiresIn,
    scope,
    refresh_token: refresh,
  };
}

/**
 * Translate an upstream token envelope into the public AuthSession
 * shape.  Refuses to expose `refresh_token`.  Uses the envelope's `t`
 * value (upstream unix epoch seconds) as the base for `issuedAt` and
 * `expiresAt` — both are returned in milliseconds to match the
 * Stage 2A `AuthSession` contract.  Rejects already-expired envelopes
 * relative to the envelope's own clock; the AuthCoordinator will then
 * perform its own expiry check against its injected clock.
 */
function envelopeToSession(envelope: NotesnookTokenEnvelope, now: number): AuthSession {
  const issuedAt = envelope.t * 1000;
  const expiresAt = (envelope.t + envelope.expires_in) * 1000;
  if (!Number.isFinite(now)) {
    throw categoricalError("notesnook auth clock must return a finite number");
  }
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw categoricalError("invalid token envelope: expires_at is not after issued_at");
  }
  if (expiresAt <= now) {
    throw categoricalError("notesnook token envelope is expired");
  }
  const userId = `notesnook-user-${shortHash(envelope.access_token)}`;
  // Deliberately construct the public session WITHOUT refresh_token.
  const session: AuthSession = {
    userId,
    accessToken: envelope.access_token,
    issuedAt,
    expiresAt,
  };
  return Object.freeze(session);
}

function shortHash(value: string): string {
  // Tiny non-cryptographic hash for the synthetic user id only.
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function scopeContainsMfa(scope: string): boolean {
  for (const part of scope.split(SCOPE_SEPARATOR)) {
    if (part === MFA_REQUIRED_SCOPE) return true;
  }
  return false;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw categoricalError(`notesnook auth provider ${name} must be a positive integer`);
  }
  return value;
}

/**
 * Convenience factory — equivalent to `new NotesnookAuthProvider(opts)`.
 */
export function createNotesnookAuthProvider(
  options: NotesnookAuthProviderOptions,
): NotesnookAuthProvider {
  return new NotesnookAuthProvider(options);
}
