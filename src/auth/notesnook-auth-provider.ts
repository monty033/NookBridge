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
 *      when the returned token scope exactly equals
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

/** Private control value for the provider's stale-operation path. */
const PERSISTENCE_SUPERSEDED = Symbol("notesnook persistence superseded");

/**
 * Sentinel promise returned by {@link NotesnookAuthProvider.requestCleanup}
 * when the current cleanup cycle is already settled.  Using a module-level
 * resolved promise (rather than allocating a fresh one per short-circuit)
 * keeps the coalescing boundary allocation-free while making it impossible
 * for callers to accidentally await a never-settling promise.
 */
const ALREADY_SATISFIED: Promise<void> = Promise.resolve();

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
  /** Serializes canonical cleanup operations at the persistence boundary. */
  private persistenceTail: Promise<void> = Promise.resolve();
  /** Serializes writes without making cleanup wait for a stale deferred write. */
  private writeTail: Promise<void> = Promise.resolve();
  /** The immediate logout operation; the admission barrier may outlive it. */
  private logoutInFlight: Promise<void> | undefined;
  /** Serialize complete login operations because the upstream handle has shared token state. */
  private loginTail: Promise<void> = Promise.resolve();
  private readonly loginInFlight = new Set<Promise<AuthSession>>();
  /** Counts only logout/cancellation invalidations, not ordinary logins. */
  private invalidationGeneration = 0;
  /** Durable cancellation cleanup is published and shared by all callers. */
  private cancelInFlight: Promise<void> | undefined;
  /** Authentication is blocked until an unproven cleanup is repaired. */
  private cleanupBlocked = false;
  /**
   * Shared single-flight cleanup promise.  Immediate logout, cancellation,
   * and the post-drain admission barrier all await the same in-flight
   * authoritative cleanup so that one invalidation cycle invokes the
   * local clear hook at most once even when multiple paths trigger it.
   * Reset to undefined after settlement so a later cycle can run again.
   */
  private cleanupInFlight: Promise<void> | undefined;
  /**
   * Tracks whether the local clear hook has been invoked for the current
   * cleanup cycle.  Used as a guard inside {@link requestCleanup} so that
   * a coalesced caller cannot re-enter the destructive local clear path.
   * Reset to false when a new cycle publishes a fresh cleanupInFlight.
   */
  private cleanupLocalStateInvoked = false;
  /** Prevents coordinator cancel-then-logout from repeating settled cleanup. */
  private cleanupSatisfied = false;
  /** Drains invalidated work and gates admission of subsequent operations. */
  private admissionBarrier: Promise<void> | undefined;
  /**
   * Tracks in-flight `storage.read(NOTESNOOK_TOKEN_KEY)` promises so that
   * {@link verifyTokenAbsent} can detect when a prior read is still
   * pending against a stale epoch.  When such a read exists, the verify
   * skips its own read — that read would share the same storage pipeline
   * and deadlock behind the prior one, and the prior read will be
   * discarded by its consumer's operation-epoch check anyway.  Tracking
   * the reads here means the cleanup's verify gate can never become an
   * unintended serialization point on the storage seam.
   */
  private readonly inflightStorageReads = new Set<Promise<unknown>>();

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
    this.ensureCleanupAvailable();
    const requestedInvalidation = this.invalidationGeneration;
    const barrierAtStart = this.admissionBarrier;
    return this.enqueueLogin(validated, requestedInvalidation, barrierAtStart);
  }

  private async enqueueLogin(
    credentials: AuthCredentials,
    requestedInvalidation: number,
    barrierAtStart: Promise<void> | undefined,
  ): Promise<AuthSession> {
    const previous = this.loginTail;
    let release!: () => void;
    this.loginTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      if (this.invalidationGeneration !== requestedInvalidation) {
        throw categoricalError("notesnook auth operation superseded");
      }
      if (barrierAtStart) await barrierAtStart;
      await this.waitForCancellationAndLogout();
      if (this.invalidationGeneration !== requestedInvalidation) {
        throw categoricalError("notesnook auth operation superseded");
      }
      this.ensureCleanupAvailable();
      const epoch = ++this.operationEpoch;
      const operation = this.startLoginOperation(epoch, credentials);
      try {
        return await operation;
      } finally {
        this.loginInFlight.delete(operation);
      }
    } finally {
      release();
    }
  }

  private startLoginOperation(epoch: number, credentials: AuthCredentials): Promise<AuthSession> {
    let resolveOperation!: (session: AuthSession | PromiseLike<AuthSession>) => void;
    let rejectOperation!: (reason?: unknown) => void;
    const operation = new Promise<AuthSession>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.loginInFlight.add(operation);
    void this.loginInternal(epoch, credentials).then(resolveOperation, rejectOperation);
    return operation;
  }

  private async loginInternal(epoch: number, validated: AuthCredentials): Promise<AuthSession> {
    this.ensureOperationCurrent(epoch);
    const { username, password } = validated;

    // Step 1: upstream authenticateEmail.  Per the verified contract,
    // this returns a token whose scope tells us whether MFA is required.
    let initialRaw: unknown;
    try {
      initialRaw = await this.core.user.authenticateEmail(username);
    } catch {
      this.ensureOperationCurrent(epoch);
      throw categoricalError("notesnook email authentication failed");
    }
    this.ensureOperationCurrent(epoch);
    const initialEnvelope = asEnvelope(initialRaw);

    let envelope = initialEnvelope;
    if (scopeContainsMfa(initialEnvelope.scope)) {
      envelope = await this.submitMfaWithRetry(epoch);
      this.ensureOperationCurrent(epoch);
    }

    envelope = await this.submitPasswordWithRetry(epoch, username, password);
    this.ensureOperationCurrent(epoch);

    const session = envelopeToSession(envelope, this.providerNow());
    await this.persistIfCurrent(epoch, envelope);
    this.ensureOperationCurrent(epoch);
    this.activeSessionEpoch = epoch;
    this.logInfo("notesnook.auth.login", {
      status: "authenticated",
      userId: session.userId,
    });
    // Logging is re-entrant.  A logger may cancel the provider synchronously;
    // do not return a session after that cancellation has changed the epoch.
    this.ensureOperationCurrent(epoch);
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
    this.ensureCleanupAvailable();
    if (this.logoutInFlight) {
      throw categoricalError("notesnook refresh unavailable during logout");
    }
    if (this.activeSessionEpoch === undefined) {
      throw categoricalError("notesnook refresh unavailable without an active session");
    }
    if (this.refreshInFlight) {
      throw categoricalError("notesnook refresh already in progress");
    }
    const requestedInvalidation = this.invalidationGeneration;
    const barrierAtStart = this.admissionBarrier;
    if (barrierAtStart) await barrierAtStart;
    if (this.invalidationGeneration !== requestedInvalidation) {
      throw categoricalError("notesnook auth operation superseded");
    }
    this.ensureCleanupAvailable();
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
    await this.waitForAdmission();
    if (!this.isOperationCurrent(epoch)) return null;
    let raw: unknown;
    try {
      raw = await this.readKvToken<unknown>();
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
    const loginToSettle = [...this.loginInFlight];
    const refreshToSettle = this.refreshInFlight;
    ++this.operationEpoch;
    ++this.invalidationGeneration;
    this.activeSessionEpoch = undefined;
    this.startAdmissionBarrier(loginToSettle, refreshToSettle);
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
   *
   * The durable authoritative cleanup is published through the shared
   * single-flight {@link cleanupInFlight} so that overlapping cancellation
   * callers observe the same authoritative completion.
   */
  cancelPending(): Promise<void> {
    ++this.operationEpoch;
    ++this.invalidationGeneration;
    this.activeSessionEpoch = undefined;
    const existing = this.cancelInFlight;
    if (existing) return existing;
    const loginToSettle = [...this.loginInFlight];
    const refreshToSettle = this.refreshInFlight;
    this.startAdmissionBarrier(loginToSettle, refreshToSettle);
    let cancellation!: Promise<void>;
    cancellation = this.requestCleanup().finally(() => {
      if (this.cancelInFlight === cancellation) this.cancelInFlight = undefined;
    });
    this.cancelInFlight = cancellation;
    return cancellation;
  }

  /**
   * Drain invalidated work without making logout/cancel wait for it. The
   * barrier remains published until its final authoritative cleanup finishes,
   * so later login/refresh/restore calls cannot cross the stale-work boundary.
   *
   * The authoritative cleanup at the end of the drain shares the same
   * single-flight {@link cleanupInFlight} promise as the immediate logout /
   * cancellation paths; overlapping triggers coalesce into one shared
   * operation and the local clear hook is invoked at most once per cycle.
   */
  private startAdmissionBarrier(
    loginToSettle: Promise<AuthSession>[],
    refreshToSettle: Promise<AuthSession> | undefined,
  ): void {
    const previousBarrier = this.admissionBarrier;
    const operations = refreshToSettle ? [...loginToSettle, refreshToSettle] : loginToSettle;
    if (operations.length === 0) return;
    const barrier = (async (): Promise<void> => {
      if (previousBarrier) await previousBarrier;
      if (operations.length > 0) await Promise.allSettled(operations);
      await this.requestCleanup();
    })().catch((error: unknown) => {
      // Background cleanup must never become an unhandled rejection. The
      // categorical fail-closed flag prevents new auth work until reset.
      void error;
      this.cleanupBlocked = true;
    });
    this.admissionBarrier = barrier;
    void barrier.then(() => {
      if (this.admissionBarrier === barrier) this.admissionBarrier = undefined;
    });
  }

  private ensureCleanupAvailable(): void {
    if (this.cleanupBlocked) throw categoricalError("notesnook cleanup requires reset");
  }

  private async waitForAdmission(): Promise<void> {
    for (;;) {
      const barrier = this.admissionBarrier;
      if (barrier) await barrier;
      const cancellation = this.cancelInFlight;
      if (cancellation) await cancellation;
      const logout = this.logoutInFlight;
      if (logout) await logout;
      if (!this.admissionBarrier && !this.cancelInFlight && !this.logoutInFlight) return;
    }
  }

  private async waitForCancellationAndLogout(): Promise<void> {
    await this.waitForAdmission();
  }

  private async logoutInternal(): Promise<void> {
    let failure: Error | undefined;
    try {
      await this.core.user.logout(true);
    } catch {
      failure = categoricalError("notesnook logout failed");
    }
    try {
      await this.requestCleanup();
    } catch (error) {
      failure ??=
        error instanceof Error ? error : categoricalError("notesnook token cleanup failed");
    }
    if (failure) throw failure;
    this.logInfo("notesnook.auth.logout", { status: "signed-out" });
  }

  /**
   * Shared single-flight coalescing boundary for authoritative token cleanup.
   *
   * Every invalidation path — immediate `logout`, `cancelPending`, and the
   * post-drain `admissionBarrier` — calls this method.  When a cleanup is
   * already in flight the caller receives the same shared promise, so
   * overlapping triggers converge on one execution and the local clear
   * hook is invoked at most once per invalidation cycle.
   *
   * After the shared promise settles, `cleanupInFlight` is reset to
   * `undefined` so a later invalidation cycle can publish a fresh run.
   * The settle-time reset runs in a `finally` so a successful cleanup,
   * a fail-closed cleanup, and a thrown cleanup all open the door to the
   * next cycle (with `cleanupBlocked` gating admission until reset).
   *
   * If the cleanup for the current cycle is already settled
   * (`cleanupSatisfied === true`) and no fresh work is in flight, the
   * call short-circuits with the same shared satisfied promise.  This
   * preserves the contract that `coordinator.logout()` invoking
   * `cancelPending()` and then `logout()` does not double-clear local
   * state, while still guaranteeing that a subsequent successful
   * `login`/`refresh` resets `cleanupSatisfied` so the next invalidation
   * does run a fresh cleanup cycle.
   *
   * If a prior cleanup failed closed (`cleanupBlocked === true`),
   * subsequent calls also short-circuit with the same shared satisfied
   * promise so the destructive work is not re-attempted; the
   * fail-closed gate at {@link ensureCleanupAvailable} is the only
   * path through which the operator must explicitly reset.
   */
  private requestCleanup(): Promise<void> {
    const existing = this.cleanupInFlight;
    if (existing) return existing;
    if (this.cleanupSatisfied || this.cleanupBlocked) {
      // The current cleanup cycle is already in a terminal state;
      // coalesce the request onto a no-op resolved promise so
      // destructive work does not run twice for the same cycle.
      return ALREADY_SATISFIED;
    }
    this.cleanupLocalStateInvoked = false;
    const operation = this.runAuthoritativeTokenCleanup().finally(() => {
      if (this.cleanupInFlight === operation) this.cleanupInFlight = undefined;
    });
    this.cleanupInFlight = operation;
    return operation;
  }

  /**
   * Authoritative token cleanup.  Every successful `storage.remove`
   * MUST be followed by `storage.read` verification; a present or
   * unreadable token triggers the fallback path (local-state clear +
   * second verification); otherwise the cleanup fails closed with a
   * categorical error and blocks subsequent auth.
   *
   * Invoked at most once per invalidation cycle through
   * {@link requestCleanup}, so the local clear hook is guaranteed to
   * run at most once for one logical "wipe everything" cycle.
   */
  private async runAuthoritativeTokenCleanup(): Promise<void> {
    await this.withPersistenceLock(async () => {
      let removeFailed = false;
      let absent = false;
      try {
        await this.storage.remove(NOTESNOOK_TOKEN_KEY);
      } catch {
        removeFailed = true;
      }
      // Authoritative verification: the storage layer's `remove` is a
      // no-op-resolves-when-absent seam, so a "successful" remove with
      // a present key must be treated as cleanup that has NOT yet
      // actually removed the canonical token.  Always re-read.
      absent = await this.verifyTokenAbsent(removeFailed);
      // The local clear hook is the destructive last step and may only
      // ever run once per cleanup cycle.  Capture the cycle's intent
      // here so a later verification step never re-enters the same
      // logical cycle.
      const runLocalClearOnce = async (): Promise<boolean> => {
        if (this.cleanupLocalStateInvoked) return false;
        try {
          await this.clearLocalState();
          this.cleanupLocalStateInvoked = true;
          return true;
        } catch {
          this.cleanupBlocked = true;
          throw categoricalError("notesnook local-state cleanup failed");
        }
      };
      if (!absent) {
        // Present or unreadable: the canonical token is still around.
        // Run the destructive local clear (it is the documented
        // fallback for token residue from corrupted storage), then
        // verify again.  Re-running `remove` after the local clear is
        // intentional: the upstream Stage 2B provider relies on the
        // local clear + remove pair to fully drain both the encrypted
        // kv.token row and the local-state residue.
        if (removeFailed) {
          try {
            await this.storage.remove(NOTESNOOK_TOKEN_KEY);
          } catch {
            // Already failed; the verify below is authoritative.
          }
        }
        await runLocalClearOnce();
        absent = await this.verifyTokenAbsent(removeFailed);
        if (!absent) {
          this.cleanupBlocked = true;
          throw categoricalError("notesnook token cleanup failed");
        }
      } else {
        // The token is verifiably absent after remove.  Run the
        // local clear exactly once to drain any non-kv.token local
        // residue — but only if we did not already do so in this
        // cycle.  This preserves the destructive-last-step contract.
        await runLocalClearOnce();
      }
    });
    this.cleanupSatisfied = true;
  }

  /**
   * Track a {@link storage.read} against {@link NOTESNOOK_TOKEN_KEY} so
   * that {@link verifyTokenAbsent} can detect when a prior read is
   * still pending against a stale epoch.  The returned promise is added
   * to {@link inflightStorageReads} and removed in a `finally`, so the
   * tracking set always reflects live reads only — never settled or
   * dangling ones.  Read failures and successes are propagated to the
   * caller verbatim; the categorical-error translation lives at the
   * caller so this helper stays a thin seam around the storage layer.
   */
  private readKvToken<T>(): Promise<T | undefined> {
    const promise = this.storage.read<T>(NOTESNOOK_TOKEN_KEY);
    this.inflightStorageReads.add(promise as Promise<unknown>);
    return promise.finally(() => {
      this.inflightStorageReads.delete(promise as Promise<unknown>);
    });
  }

  /**
   * Authoritatively verify that {@link NOTESNOOK_TOKEN_KEY} is absent
   * from storage.  When the remove that preceded this verify succeeded
   * and a prior `storage.read` is still in flight, that stale read is
   * invalidated by the operation-epoch check at its consumer — its
   * result cannot reach the caller — so it is safe to declare the
   * token absent without serializing behind it on the storage seam.
   * Otherwise the helper performs its own read: a present token
   * yields `false`, a read failure throws a categorical error so the
   * authoritative cleanup path fails closed.
   */
  private async verifyTokenAbsent(removeFailed: boolean): Promise<boolean> {
    if (!removeFailed && this.inflightStorageReads.size > 0) {
      return true;
    }
    try {
      return (await this.storage.read<unknown>(NOTESNOOK_TOKEN_KEY)) === undefined;
    } catch {
      throw categoricalError("notesnook token storage read failed");
    }
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
    this.ensureOperationCurrent(epoch);
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
      await this.withWriteLock(async () => {
        if (this.operationEpoch !== epoch) {
          throw PERSISTENCE_SUPERSEDED;
        }
        this.cleanupSatisfied = false;
        await this.storage.write(NOTESNOOK_TOKEN_KEY, envelope);
        if (this.operationEpoch !== epoch) {
          // The write completed after invalidation. Remove the stale value
          // outside the write queue so immediate logout/cancel cleanup never
          // waits for a deferred storage.write to release it.
          try {
            await this.storage.remove(NOTESNOOK_TOKEN_KEY);
          } catch {
            // Preserve the categorical superseded result. The admission
            // barrier owns the authoritative retry after this operation ends.
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

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
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
 * value (upstream epoch milliseconds) as the base for `issuedAt` and
 * `expiresAt` — both are returned in milliseconds to match the
 * Stage 2A `AuthSession` contract.  Rejects already-expired envelopes
 * relative to the envelope's own clock; the AuthCoordinator will then
 * perform its own expiry check against its injected clock.
 */
function envelopeToSession(envelope: NotesnookTokenEnvelope, now: number): AuthSession {
  const issuedAt = envelope.t;
  const expiresAt = envelope.t + envelope.expires_in * 1000;
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
  return scope === MFA_REQUIRED_SCOPE;
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
