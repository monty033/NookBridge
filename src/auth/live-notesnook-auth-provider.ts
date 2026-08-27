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
 *        a. `core.user.authenticateEmail(email)`
 *        b. IF the response carries `scope` containing
 *           `auth:grant_types:mfa`, call the injected MFA supplier
 *           and then `core.user.authenticateMultiFactorCode(code, "app")`
 *        c. Call the injected password supplier OR the supplied
 *           initial password via `core.user.authenticatePassword(email, password)`.
 *      The MFA branch is conditional on the SCOPE returned by step
 *      (a); the password branch uses the supplied initial password
 *      first, then the supplier on rejection.  No password / MFA
 *      code is ever persisted on the provider.
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
import {
  isAuthProviderError,
  markAuthProviderError,
  type AuthCredentials,
  type AuthProvider,
  type AuthSession,
} from "./types.js";

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
const SCOPE_SEPARATOR = " ";

/**
 * Caller-supplied function used by the provider to obtain a fresh
 * password attempt when the upstream `authenticatePassword` call
 * rejects the previous one.  Returning `null` signals that no
 * further password is available — the provider rejects the login.
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
 * Caller-supplied cleanup hook invoked AFTER `token` removal
 * completes (whether or not upstream logout succeeded).  The hook
 * is the ONLY path through which the provider can clear local
 * encrypted state.  Production code wires this to whatever
 * destructive boundary owns `db.reset()` in a later slice; offline
 * tests inject a stub that just records the call.
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
export class LiveNotesnookAuthProvider implements AuthProvider {
  private readonly handle: NotesnookLiveCoreHandle;
  private readonly passwordSupplier: LivePasswordSupplier;
  private readonly mfaSupplier: LiveMfaSupplier;
  private readonly mfaMaxAttempts: number;
  private readonly passwordMaxAttempts: number;
  private readonly clock: () => number;
  private readonly cleanupHook: LiveCleanupHook;
  private readonly logger: Logger | undefined;

  /**
   * Operation epoch: bumped on logout, cancelPending, and every
   * login/refresh start.  Login captures its generation before its
   * initial wait so logout cannot follow a stale login.  Refresh
   * guards against logout-without-an-active-session and against
   * concurrent refreshes.
   */
  private operationEpoch = 0;
  /**
   * True once a login or successful restore has activated a session.
   * Cleared by logout and cancelPending.  Refresh requires this to
   * be true at entry.
   */
  private hasActiveSession = false;
  /** Tracks the most recent refresh promise so a competing caller is rejected. */
  private refreshInFlight: Promise<AuthSession> | undefined;
  /** Tracks the most recent logout promise so re-entry is idempotent. */
  private logoutInFlight: Promise<void> | undefined;

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
   * Drive the upstream login sequence and return a normalized,
   * refresh-token-free `AuthSession`.  No credential is held on the
   * provider instance — each retry loop variable is local to the
   * method.
   *
   * Order:
   *   1. `handle.user.authenticateEmail(email)`.
   *   2. If the response's scope contains `auth:grant_types:mfa`,
   *      call the injected MFA supplier and then
   *      `handle.user.authenticateMultiFactorCode(code, "app")`.
   *   3. Call `handle.user.authenticatePassword(email, password)`
   *      with the supplied initial password; on rejection, consult
   *      the injected password supplier up to `passwordMaxAttempts`
   *      times.
   *   4. After success, call `handle.token.getToken()` to read the
   *      canonical upstream envelope, normalize it, and read the
   *      upstream user via `handle.user.getUser()`.  Both reads
   *      happen inside the same operation epoch.
   *   5. Return a frozen, refresh-token-free `AuthSession`.
   */
  async login(credentials: AuthCredentials): Promise<AuthSession> {
    const validated = validateCredentials(credentials);
    const epoch = ++this.operationEpoch;
    await this.waitForLogout();
    this.ensureOperationCurrent(epoch);
    const { username, password } = validated;

    // Step 1: upstream authenticateEmail.
    let initialRaw: unknown;
    try {
      initialRaw = await this.handle.user.authenticateEmail(username);
    } catch {
      this.ensureOperationCurrent(epoch);
      throw categoricalError("live notesnook email authentication failed");
    }
    this.ensureOperationCurrent(epoch);

    // Step 2: optional MFA.  Branch on the SCOPE carried by the
    // email response, not on a separate flag.
    const initialEnvelope = asEnvelope(initialRaw);
    if (scopeContainsMfa(initialEnvelope.scope)) {
      await this.submitMfaWithRetry(epoch, initialEnvelope);
      this.ensureOperationCurrent(epoch);
    }

    // Step 3: password.
    await this.submitPasswordWithRetry(epoch, username, password);
    this.ensureOperationCurrent(epoch);

    // Step 4: read the canonical upstream envelope + user.
    const envelope = await this.readEnvelopeIfCurrent(epoch);
    const user = await this.readUserIfCurrent(epoch);
    this.ensureOperationCurrent(epoch);

    const session = envelopeToSession(envelope, user, this.providerNow());
    this.hasActiveSession = true;
    this.logInfo("live.notesnook.auth.login", { status: "authenticated", userId: session.userId });
    return session;
  }

  /**
   * Refresh the canonical upstream envelope by calling
   * `handle.token._refreshToken(true)` and then re-reading
   * `handle.token.getToken()`.  Refresh-after-logout is rejected;
   * concurrent refreshes converge to a single upstream round
   * with the loser rejected deterministically.
   */
  async refresh(_session: AuthSession): Promise<AuthSession> {
    if (this.logoutInFlight) {
      throw categoricalError("live notesnook refresh unavailable during logout");
    }
    if (!this.hasActiveSession) {
      throw categoricalError("live notesnook refresh unavailable without an active session");
    }
    if (this.refreshInFlight) {
      throw categoricalError("live notesnook refresh already in progress");
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
   * Logout: revoke the upstream token, delete the local `token`
   * envelope through the narrow KV accessor, then invoke the
   * injected cleanup hook.  All three steps are independent — a
   * failure in any one is reported as a categorical error after
   * the others have been attempted.  No `db.reset()` or generic
   * destructive operation is invoked directly.
   */
  async logout(_session: AuthSession): Promise<void> {
    if (this.logoutInFlight) return this.logoutInFlight;
    ++this.operationEpoch;
    this.hasActiveSession = false;
    const operation = this.logoutInternal();
    this.logoutInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.logoutInFlight === operation) this.logoutInFlight = undefined;
    }
  }

  /**
   * Cancel pending login / refresh completions without requiring an
   * active session.  Used by the runner to invalidate stale state
   * after a failure or a user-initiated cancellation.
   */
  cancelPending(): void {
    ++this.operationEpoch;
    this.hasActiveSession = false;
  }

  // ---------------------------------------------------------------------
  // Internal implementations.
  // ---------------------------------------------------------------------

  private async refreshInternal(epoch: number): Promise<AuthSession> {
    try {
      await this.handle.token._refreshToken(true);
    } catch {
      throw categoricalError("live notesnook token refresh failed");
    }
    this.ensureOperationCurrent(epoch);
    const envelope = await this.readEnvelopeIfCurrent(epoch);
    const user = await this.readUserIfCurrent(epoch);
    this.ensureOperationCurrent(epoch);
    const session = envelopeToSession(envelope, user, this.providerNow());
    this.hasActiveSession = true;
    this.logInfo("live.notesnook.auth.refresh", {
      status: "authenticated",
      userId: session.userId,
    });
    return session;
  }

  private async logoutInternal(): Promise<void> {
    let failure: Error | undefined;
    // Step 1: revoke the upstream token.  The narrow handle
    // forwards `clearLocal: boolean` to the pinned upstream; we
    // always pass `true` so the upstream cache is wiped on
    // logout.  No boolean argument is exposed through this
    // provider — the `true` is a production-only invariant.
    try {
      await this.handle.user.logout(true);
    } catch {
      failure = categoricalError("live notesnook logout failed");
    }
    // Step 2: delete the local token envelope.  Idempotent —
    // upstream `db.reset()` does NOT clear token, so this is the
    // explicit boundary for the local envelope.
    try {
      await this.handle.kv.delete(LIVE_NOTESNOOK_KV_TOKEN_KEY);
    } catch {
      failure ??= categoricalError("live notesnook token cleanup failed");
    }
    // Step 3: invoke the cleanup hook.  The hook is the only path
    // through which a generic destructive boundary is reached.
    try {
      await this.cleanupHook();
    } catch {
      failure ??= categoricalError("live notesnook local-state cleanup failed");
    }
    if (failure) throw failure;
    this.logInfo("live.notesnook.auth.logout", { status: "signed-out" });
  }

  private async waitForLogout(): Promise<void> {
    if (this.logoutInFlight) await this.logoutInFlight;
  }

  private ensureOperationCurrent(epoch: number): void {
    if (this.operationEpoch !== epoch) {
      throw categoricalError("live notesnook auth operation superseded");
    }
  }

  private providerNow(): number {
    try {
      return this.clock();
    } catch {
      throw categoricalError("live notesnook auth clock failed");
    }
  }

  /** Logging is best-effort; a logger throw never propagates past this seam. */
  private logInfo(message: string, record: { status: string; userId?: string }): void {
    try {
      this.logger?.info(message, record);
    } catch {
      // A logger failure must never turn a successful auth operation into a
      // raw, potentially secret-bearing error after persistence completed.
    }
  }

  private async readEnvelopeIfCurrent(epoch: number): Promise<NotesnookLiveTokenEnvelope> {
    this.ensureOperationCurrent(epoch);
    let raw: unknown;
    try {
      raw = await this.handle.token.getToken();
    } catch {
      throw categoricalError("live notesnook token read failed");
    }
    this.ensureOperationCurrent(epoch);
    return asEnvelope(raw);
  }

  private async readUserIfCurrent(epoch: number): Promise<NotesnookLiveUser | undefined> {
    this.ensureOperationCurrent(epoch);
    let user: NotesnookLiveUser | undefined;
    try {
      user = await this.handle.user.getUser();
    } catch {
      throw categoricalError("live notesnook user read failed");
    }
    this.ensureOperationCurrent(epoch);
    return user;
  }

  /**
   * Submit the password to the upstream handle, retrying through
   * the injected supplier on rejection.  The initial password is
   * held in a local variable only; it is never persisted, logged,
   * or stored on the provider instance.
   */
  private async submitPasswordWithRetry(
    epoch: number,
    email: string,
    initialPassword: string,
  ): Promise<void> {
    let currentPassword = initialPassword;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.passwordMaxAttempts; attempt += 1) {
      this.ensureOperationCurrent(epoch);
      try {
        await this.handle.user.authenticatePassword(email, currentPassword);
        this.ensureOperationCurrent(epoch);
        return;
      } catch {
        this.ensureOperationCurrent(epoch);
        lastError = categoricalError("live notesnook password authentication failed");
        if (attempt === this.passwordMaxAttempts) break;
        let next: string | null;
        try {
          next = await this.passwordSupplier();
        } catch {
          this.ensureOperationCurrent(epoch);
          throw categoricalError("live notesnook password supplier failed");
        }
        this.ensureOperationCurrent(epoch);
        if (next === null) break;
        if (typeof next !== "string" || next.length === 0) {
          throw categoricalError("live notesnook password supplier returned invalid input");
        }
        currentPassword = next;
      }
    }
    throw lastError ?? categoricalError("live notesnook password authentication failed");
  }

  /**
   * Collect an MFA code from the injected supplier, retrying up to
   * `mfaMaxAttempts` times.  The envelope is not consumed — this
   * method only drives the upstream MFA round.  Throws on
   * exhaustion with a categorical error.
   */
  private async submitMfaWithRetry(
    epoch: number,
    _initialEnvelope: NotesnookLiveTokenEnvelope,
  ): Promise<void> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.mfaMaxAttempts; attempt += 1) {
      this.ensureOperationCurrent(epoch);
      let code: string | null;
      try {
        code = await this.mfaSupplier();
      } catch {
        this.ensureOperationCurrent(epoch);
        throw categoricalError("live notesnook MFA supplier failed");
      }
      this.ensureOperationCurrent(epoch);
      if (code === null) {
        throw categoricalError("live notesnook MFA input ended before a code was entered");
      }
      if (typeof code !== "string" || code.length === 0) {
        throw categoricalError("live notesnook MFA supplier returned invalid input");
      }
      try {
        await this.handle.user.authenticateMultiFactorCode(code, "app");
        this.ensureOperationCurrent(epoch);
        return;
      } catch {
        this.ensureOperationCurrent(epoch);
        lastError = categoricalError("live notesnook MFA authentication failed");
        continue;
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
  if (typeof refresh !== "string" || refresh.length === 0) {
    throw categoricalError("live notesnook token envelope is missing refresh_token");
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
    refresh_token: refresh,
    expires_in: expiresIn,
    scope,
    t,
  });
}

/**
 * Translate an upstream token envelope into the public
 * `AuthSession` shape.  Refuses to expose `refresh_token`.  Uses
 * the envelope's `t` value (upstream unix epoch seconds) as the
 * base for `issuedAt` and `expiresAt` — both returned in
 * milliseconds.  The session's `userId` is the upstream user's
 * `id` (no token-derived hash).
 */
function envelopeToSession(
  envelope: NotesnookLiveTokenEnvelope,
  user: NotesnookLiveUser | undefined,
  now: number,
): AuthSession {
  const issuedAt = envelope.t * 1000;
  const expiresAt = (envelope.t + envelope.expires_in) * 1000;
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
  for (const part of scope.split(SCOPE_SEPARATOR)) {
    if (part === MFA_REQUIRED_SCOPE) return true;
  }
  return false;
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
