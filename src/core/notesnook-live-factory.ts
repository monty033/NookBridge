/**
 * Stage 2B-live — minimal lazy narrow real-core factory.
 *
 * This module owns the only runtime import of `@notesnook/core` in
 * NookBridge.  It is intentionally minimal and bounded:
 *
 *   - `@notesnook/core` is loaded via `await import(...)` exclusively
 *     from inside the exported factory function.  An ordinary
 *     `import` of this module does NOT load the pinned real-core
 *     package, so offline tooling (CLI parsing, the existing
 *     Stage 2A auth boundary, etc.) can import the narrow types
 *     without paying the cost (and the network surface) of the real
 *     package.  The test harness uses the injected module seam to
 *     keep `npm test` hermetic.
 *   - The factory accepts the widened
 *     {@link NotesnookDatabaseSetupOptions} surface plus a narrow
 *     cleanup hook and an optional injected module seam.  It
 *     validates every required setup dependency up front, normalizes
 *     hostile getters / constructor / setup / init / handle failures
 *     to a small set of stable categorical errors (no `cause`, no
 *     `__context__`, no raw details — upstream exceptions may carry
 *     secrets, paths, or token bytes).
 *   - It CONSTRUCTS `new Database()` with the resolved module,
 *     synchronously calls the INSTANCE `setup(full options)`
 *     method, then awaits the INSTANCE `init()`.  It returns a
 *     FROZEN narrow handle whose surface is exactly the operations
 *     the next pass of the Stage 2B-live auth boundary needs:
 *     validated user `authenticateEmail` /
 *     `authenticateMultiFactorCode` / `authenticatePassword`,
 *     `getUser`, `logout`, token `getToken` / `_refreshToken`, KV
 *     `read` / `write` / `delete` (via the callable `db.kv()`
 *     accessor), and the `cleanup` hook.  No raw `db`, no generic
 *     transport / request / fetch / mutation access is exposed.
 *   - This factory deliberately does NOT authenticate.  Caller code
 *     (the Stage 2B-live auth runner, future sync runner, etc.)
 *     drives auth/sync separately.  The factory just constructs,
 *     sets up, initialises, and exposes the narrow surface.
 *
 * No state from this module is module-global; everything is held
 * inside the closure produced by `createNotesnookLiveCoreFactory`.
 * Two parallel calls cannot interfere.
 */

import {
  isNotesnookAdapterError,
  markRealCoreModule,
  validateDatabaseSetupOptions,
  type NotesnookDatabaseSetupOptions,
  type NotesnookLiveDatabase,
  type NotesnookRealCoreModule,
} from "./notesnook-core-adapter.js";
import { flattenLiveDatabaseToReadOnly } from "./notesnook-readonly-projection.js";
import type { NotesnookReadOnlyDatabase } from "./notesnook-readonly-adapter.js";
import {
  hasLiveWriteSurface,
  projectLiveDatabaseToWriteCapability,
} from "./notesnook-live-write-capability.js";
import {
  createLiveRemoteSyncCapability,
  createLiveRemoteSyncExecutor,
  type NotesnookLiveRemoteSyncCapability,
} from "./notesnook-live-remote-sync.js";
import { SyncCoordinator } from "./notesnook-sync-coordinator.js";
import type { SyncMetadataStateStore } from "./notesnook-sync-coordinator.js";

import type { NotesnookLiveWriteCapability } from "./notesnook-write-admin.js";
import {
  createNotesnookLocalConflictObserver,
  type NotesnookLocalConflictObserver,
  type NotesnookLocalConflictSource,
} from "./notesnook-local-conflict-projection.js";

// ---------------------------------------------------------------------------
// Options, narrow types, and cleanup hook.
// ---------------------------------------------------------------------------

/**
 * The token envelope the upstream `Database.tokenManager.getToken()`
 * returns.  The factory exposes only `getToken` and `_refreshToken`
 * on the narrow handle; refresh bodies are owned by the caller and
 * are not surfaced here.
 */
export interface NotesnookLiveTokenEnvelope {
  access_token: string;
  /** Absent on the temporary email/MFA grant; required after login completes. */
  refresh_token?: string;
  expires_in: number;
  scope: string;
  t: number;
}

/**
 * The verified upstream user record the factory returns from
 * `getUser()`.  Only the structurally validated fields downstream
 * needs are kept; raw upstream `User` is not exposed.
 */
export interface NotesnookLiveUser {
  id: string;
  email: string;
}

/**
 * The verified upstream key under which the encrypted token envelope
 * is persisted on the `Database.kv` accessor.  Mirrors the key the
 * Stage 2B-live `NotesnookAuthProvider` already uses so that the
 * auth runner can read what the factory can write.
 */
export const NOTESNOOK_LIVE_KV_TOKEN_KEY = "token" as const;

/**
 * The key shape the upstream `KVStorage` accepts on its
 * `read` / `write` / `delete` methods.  Only the literal
 * `"token"` key is allowed through the narrow handle so the
 * factory cannot be used as a generic database handle.
 */
export type NotesnookLiveKvKey = "token";

/**
 * The closed narrow surface the factory returns.  Every member is
 * structurally validated, every method is wrapped so a throwing
 * hostile getter / method body never leaks a `cause` or `__context__`
 * out of the boundary.
 */
export interface NotesnookLiveCoreHandle {
  readonly user: Readonly<{
    authenticateEmail: (email: string) => Promise<unknown>;
    authenticateMultiFactorCode: (code: string, type: "app") => Promise<unknown>;
    authenticatePassword: (email: string, password: string) => Promise<unknown>;
    /**
     * Forward the narrow password-only subset of the pinned
     * `@notesnook/core@8.1.3` `user._login(...)` contract.  The
     * provider supplies both the SHA-256 `hashedPassword` for the auth
     * grant and the plaintext `password` solely so upstream can derive
     * the local crypto key after authentication.  MFA fields and all
     * other upstream options remain intentionally unreachable.
     */
    _login: (args: { email: string; password: string; hashedPassword: string }) => Promise<void>;
    getUser: () => Promise<NotesnookLiveUser | undefined>;
    /**
     * Forward `clearLocal: boolean` to the pinned
     * `@notesnook/core@8.1.3` upstream `user.logout(clearLocal)`. The
     * provider is the only caller; production callers always pass
     * `true` so the upstream cache is wiped on logout.
     */
    logout: (clearLocal: boolean) => Promise<void>;
  }>;
  readonly token: Readonly<{
    getToken: () => Promise<NotesnookLiveTokenEnvelope | undefined>;
    _refreshToken: (forceRenew: boolean) => Promise<void>;
  }>;
  readonly kv: Readonly<{
    read: (key: NotesnookLiveKvKey) => Promise<unknown>;
    write: (key: NotesnookLiveKvKey, value: unknown) => Promise<void>;
    delete: (key: NotesnookLiveKvKey) => Promise<void>;
  }>;
  /**
   * Cleanup hook.  Drains in-memory proxies that were constructed
   * by the factory so a hostile module that captured one cannot
   * probe them once the boundary is closed.  Idempotent.
   */
  readonly cleanup: () => Promise<void>;
  /** True once `init()` has resolved.  Never becomes false again. */
  readonly initialized: boolean;
  /** Flattened Stage 3 read-only surface; absent on legacy auth-only fakes. */
  readonly readOnly?: NotesnookReadOnlyDatabase;
  /**
   * Separately named Stage 4 local write capability; absent on legacy
   * auth-only fakes.  This is a DISTINCT surface from `readOnly`: nothing
   * projects one into the other, so an existing read-only caller cannot
   * acquire a write path.  The raw `Database` is not reachable through it.
   */
  readonly localWrite?: NotesnookLiveWriteCapability;
  /** Separately named explicit remote synchronization capability. */
  readonly remoteSync?: NotesnookLiveRemoteSyncCapability;
  /**
   * Separately named Stage 5 read-only local-conflict observer; absent on
   * legacy auth-only fakes and on databases whose `notes` slot does not
   * expose the structural `conflicted.ids()` / `note(id)` shape required
   * for safe observation.  Distinct from `readOnly` / `localWrite` /
   * `remoteSync`: the conflict observer cannot reach any other surface.
   */
  readonly localConflictObserver?: NotesnookLocalConflictObserver;
}

/**
 * Caller-supplied options for the live-core factory.  Callers MUST
 * supply the closed real-upstream setup options surface plus a
 * cleanup hook the factory invokes on subsequent cleanup calls.
 *
 * The `injectedModule` seam is OPTIONAL and exists exclusively for
 * offline tests.  When omitted, the factory uses `await import(...)`
 * to load the pinned `@notesnook/core` package; when supplied, the
 * dynamic import is skipped entirely.
 */
export type NotesnookLiveFactoryOptions = Readonly<{
  /** Closed real-upstream setup options surface.  Validated. */
  setup: NotesnookDatabaseSetupOptions;
  /**
   * Cleanup hook invoked by `handle.cleanup()`; the factory does
   * NOT call `db.reset()` directly — that destructive step is the
   * caller's responsibility.  The hook is required so the caller
   * owns the destructive boundary.
   */
  onCleanup: () => void | Promise<void>;
  /**
   * Optional injected module seam.  Offline tests pass a fake here
   * to keep `npm test` hermetic; production callers MUST omit it
   * so the factory takes the dynamic-import path.
   */
  injectedModule?: NotesnookRealCoreModule;
  /** Shared closed state owned by the production runtime. */
  lifecycle?: NotesnookLiveCoreLifecycle;
  /** State-store seam supplied by the owning production runtime. */
  syncStateStore?: SyncMetadataStateStore;
}>;

/** Shared lifecycle across the runtime, narrow handle, and providers. */
export interface NotesnookLiveCoreLifecycle {
  isClosed(): boolean;
  close(): void;
}

/**
 * Public, exported factory shape.  Tests and production code call
 * this; the underlying dynamic import lives inside the closure.
 */
export type NotesnookLiveCoreFactory = (
  options: NotesnookLiveFactoryOptions,
) => Promise<NotesnookLiveCoreHandle>;

// ---------------------------------------------------------------------------
// Public factory — exported.
// ---------------------------------------------------------------------------

/**
 * Create the narrow live-core handle.
 *
 * Behaviour:
 *
 *   1. Validate the closed real-upstream setup options via
 *      {@link validateDatabaseSetupOptions}.  Unknown roots /
 *      unknown options / missing required dependencies fail
 *      immediately with a categorical error.
 *   2. Resolve the `NotesnookRealCoreModule`: production callers
 *      get it through a lazy `await import("@notesnook/core")` call
 *      that ONLY runs inside this function; offline tests pass a
 *      pre-marked fake through `options.injectedModule`.
 *   3. Construct `new Database()`, synchronously call
 *      `Database.setup(full options)`, then await `init()`.  Each
 *      step is wrapped so a throwing hostile getter / constructor /
 *      setup / init body never exposes its `cause` or `__context__`.
 *   4. Probe `db.user`, `db.tokenManager`, and `db.kv`.  Each is
 *      wrapped behind narrow accessors whose return values go
 *      through a hostile-proxy normalizer before being handed back
 *      to the caller.
 *   5. Return a frozen handle exposing exactly the methods listed
 *      in {@link NotesnookLiveCoreHandle}; preserve the supplied
 *      `onCleanup` hook so callers can wire destructive teardown.
 *   6. The factory NEVER calls `authenticateEmail`,
 *      `authenticatePassword`, `_refreshToken`, or any network /
 *      sync function.  Auth remains a caller responsibility.
 */
export async function createNotesnookLiveCoreFactory(
  options: NotesnookLiveFactoryOptions,
): Promise<NotesnookLiveCoreHandle> {
  // Step 1 — normalize and validate options inside one protected boundary.
  // In particular, do not read `options.setup` before a hostile getter has
  // been converted into a categorical error.
  const normalized = normalizeFactoryOptions(options);
  const ensureOpen = () => ensureLifecycleOpen(normalized.lifecycle);
  ensureOpen();

  // Step 2 — resolve the real-core module.  Production path is a
  // lazy dynamic import; offline tests pass an injected seam.
  const coreModule = normalized.injectedModule ?? (await loadRealCoreModule());

  // Step 3 onward is one resource-owned transaction.  Once Database has
  // been constructed, every setup/init/shape failure gets the same teardown
  // opportunity as an ordinary cleanup, even though no handle is returned.
  try {
    const db = safeConstructDatabase(coreModule);
    safeSetupDatabase(db, normalized.setup);
    safeConfigureProductionHosts(db, normalized.injectedModule === undefined);
    await safeInitDatabase(db);
    ensureOpen();

    // Step 4 — validate the live handle exposes the slots downstream needs.
    const userManager = readDbObjectSlot(
      db,
      "user",
      "Notesnook database handle is missing user slot",
    );
    const tokenManager = readDbObjectSlot(
      db,
      "tokenManager",
      "Notesnook database handle is missing tokenManager slot",
    );
    const kvAccessor = readDbKvAccessor(db);
    const kv = normalizeKvAccessor(kvAccessor, ensureOpen);

    // Step 5 — capture each method once behind narrow, lifecycle-checked
    // wrappers.  No generic Database/storage object escapes this boundary.
    const user = wrapUserManager(userManager, ensureOpen);
    const token = wrapTokenManager(tokenManager, ensureOpen);
    const readOnly =
      normalized.injectedModule === undefined || hasReadOnlyProjectionSurface(db)
        ? guardReadOnlyProjection(flattenLiveDatabaseToReadOnly(db), ensureOpen)
        : undefined;
    // Stage 4: the write capability is built from a separate projection of
    // the same opened database.  It is optional so legacy injected auth-only
    // fakes remain valid, and it never widens `readOnly`.
    let sharedCoordinator: SyncCoordinator | undefined;
    const localWrite =
      normalized.injectedModule === undefined || hasLiveWriteSurface(db)
        ? (() => {
            sharedCoordinator = new SyncCoordinator({
              executor: createLiveRemoteSyncExecutor(db as unknown as object, ensureOpen),
              ...(normalized.syncStateStore === undefined
                ? {}
                : { stateStore: normalized.syncStateStore }),
            });
            return projectLiveDatabaseToWriteCapability(db as unknown as object, ensureOpen, {
              coordinator: sharedCoordinator,
              database: db as unknown as object,
            });
          })()
        : undefined;
    const remoteSync =
      localWrite === undefined || sharedCoordinator === undefined
        ? undefined
        : createLiveRemoteSyncCapability(
            () => sharedCoordinator!.requestSync(),
            ensureOpen,
            db as unknown as object,
          );
    // Stage 5: the local-conflict observer is built from the same opened
    // database but only over the structural `notes.conflicted.ids()` /
    // `notes.note(id)` shape.  It is optional so legacy injected auth-only
    // fakes (and any database whose `notes` slot is absent or malformed)
    // remain valid, and it never widens `readOnly` / `localWrite` /
    // `remoteSync`.
    const localConflictObserver =
      normalized.injectedModule === undefined
        ? buildLiveLocalConflictObserver(db as unknown as object, ensureOpen)
        : buildOptionalLiveLocalConflictObserver(db as unknown as object, ensureOpen);

    // Step 6 — assemble the frozen handle.  A cleanup attempt is published
    // before its first await; concurrent callers therefore await the exact
    // same attempt.  Failed attempts are not memoized, so callers can safely
    // retry teardown while the lifecycle remains fail-closed at the boundary.
    let cleanupInFlight: Promise<void> | undefined;
    let cleanupCompleted = false;
    const cleanup = (): Promise<void> => {
      if (cleanupCompleted) return Promise.resolve();
      if (cleanupInFlight) return cleanupInFlight;
      const attempt = (async () => {
        await teardownResources(normalized.lifecycle, normalized.onCleanup);
        cleanupCompleted = true;
      })();
      const published = attempt.finally(() => {
        if (cleanupInFlight === published) cleanupInFlight = undefined;
      });
      cleanupInFlight = published;
      return published;
    };

    const handle: NotesnookLiveCoreHandle = Object.freeze({
      user,
      token,
      kv,
      initialized: true,
      cleanup,
      ...(readOnly === undefined ? {} : { readOnly }),
      ...(localWrite === undefined ? {} : { localWrite }),
      ...(remoteSync === undefined ? {} : { remoteSync }),
      ...(localConflictObserver === undefined ? {} : { localConflictObserver }),
    });

    return handle;
  } catch (error) {
    // Teardown errors are deliberately suppressed here: the construction
    // failure remains categorical, while the teardown helper still attempts
    // both lifecycle close and the supplied cleanup hook.
    await bestEffortTeardown(normalized.lifecycle, normalized.onCleanup);
    if (isFactoryError(error) || isNotesnookAdapterError(error)) throw error;
    throw factoryError("Notesnook live core setup failed");
  }
}

type NormalizedFactoryOptions = Readonly<{
  setup: NotesnookDatabaseSetupOptions;
  onCleanup: () => void | Promise<void>;
  injectedModule?: NotesnookRealCoreModule;
  lifecycle: NotesnookLiveCoreLifecycle;
  syncStateStore?: SyncMetadataStateStore;
}>;

function normalizeFactoryOptions(options: unknown): NormalizedFactoryOptions {
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw factoryError("invalid Notesnook live factory options");
    }
    const candidate = options as Record<string, unknown>;
    const setup = candidate.setup;
    const onCleanup = candidate.onCleanup;
    const injectedModule = candidate.injectedModule;
    const lifecycle = candidate.lifecycle;
    const syncStateStore = candidate.syncStateStore;
    const validatedSetup = validateDatabaseSetupOptions(setup);
    if (typeof onCleanup !== "function") {
      throw factoryError("onCleanup hook is required");
    }
    if (lifecycle !== undefined) {
      if (typeof lifecycle !== "object" || lifecycle === null || Array.isArray(lifecycle)) {
        throw factoryError("invalid Notesnook live runtime lifecycle");
      }
      const lifecycleRecord = lifecycle as Record<string, unknown>;
      if (
        typeof lifecycleRecord.isClosed !== "function" ||
        typeof lifecycleRecord.close !== "function"
      ) {
        throw factoryError("invalid Notesnook live runtime lifecycle");
      }
    }
    if (syncStateStore !== undefined) {
      if (typeof syncStateStore !== "object" || syncStateStore === null) {
        throw factoryError("invalid sync metadata state store");
      }
    }
    return {
      setup: validatedSetup,
      onCleanup: onCleanup as () => void | Promise<void>,
      ...(injectedModule === undefined
        ? {}
        : { injectedModule: injectedModule as NotesnookRealCoreModule }),
      lifecycle:
        lifecycle === undefined ? createLifecycle() : (lifecycle as NotesnookLiveCoreLifecycle),
      ...(syncStateStore === undefined
        ? {}
        : { syncStateStore: syncStateStore as SyncMetadataStateStore }),
    };
  } catch (error) {
    if (isFactoryError(error) || isNotesnookAdapterError(error)) throw error;
    throw factoryError("invalid Notesnook live factory options");
  }
}

function ensureLifecycleOpen(lifecycle: NotesnookLiveCoreLifecycle): void {
  try {
    if (lifecycle.isClosed()) throw factoryError("live-login runtime is closed");
  } catch (error) {
    if (isFactoryError(error)) throw error;
    throw factoryError("live-login runtime lifecycle is unavailable");
  }
}

function createLifecycle(): NotesnookLiveCoreLifecycle {
  let closed = false;
  return Object.freeze({
    isClosed: () => closed,
    close: () => {
      closed = true;
    },
  });
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

const REAL_CORE_PACKAGE_NAME = "@notesnook/core";

/**
 * Lazy dynamic import of the pinned real-core package.  This is
 * the ONLY place in the source tree that resolves the package; it
 * is awaited inside the exported factory so ordinary imports of
 * this module never load it.
 */
async function loadRealCoreModule(): Promise<NotesnookRealCoreModule> {
  try {
    // `import(...)` returns `unknown`.  We reject any value that is
    // not shaped like `NotesnookRealCoreModule` (structural surface
    // check); the runtime type of the import is whatever upstream
    // shipped at the pinned version.
    const imported: unknown = await import(REAL_CORE_PACKAGE_NAME);

    // Per the pinned `@notesnook/core@8.1.3` d.ts the shape is
    // `declare class Database { ... setup(options): void; init(): Promise<void>; ... }`.
    if (
      !imported ||
      typeof imported !== "object" ||
      typeof (imported as { Database?: unknown }).Database !== "function"
    ) {
      throw factoryError("Notesnook real-core module is missing a constructable Database");
    }
    return markRealCoreModule(imported as NotesnookRealCoreModule);
  } catch (error) {
    if (isFactoryError(error)) throw error;
    throw factoryError("failed to load Notesnook real-core module");
  }
}

/**
 * Construct `new Database()` with hostile-getter normalization.
 * A module whose `Database` is missing, inaccessible, or not a
 * constructable class is rejected with a categorical error before
 * the database is instantiated.
 */
function safeConstructDatabase(coreModule: NotesnookRealCoreModule): NotesnookLiveDatabase {
  let ctor: unknown;
  try {
    ctor = (coreModule as { Database: unknown }).Database;
  } catch {
    throw factoryError("Notesnook Database is not accessible");
  }
  // Real upstream `Database` is declared as a class — `typeof` is
  // "function" for ES classes.  Refuse anything else up front.
  if (typeof ctor !== "function") {
    throw factoryError("Notesnook Database is not a constructable class");
  }

  let database: unknown;
  try {
    database = new (ctor as new () => NotesnookLiveDatabase)();
  } catch {
    throw factoryError("Notesnook Database constructor failed");
  }
  if (!database || typeof database !== "object") {
    throw factoryError("Notesnook Database constructor did not return an object");
  }
  // Note: `db.setup` and `db.init` are required INSTANCE methods
  // per the pinned `@notesnook/core@8.1.3` d.ts; the per-slot
  // enforcement happens in `safeSetupDatabase` / `safeInitDatabase`
  // and uses categorical errors keyed off the failing slot.
  return database as NotesnookLiveDatabase;
}

/**
 * Synchronously call `db.setup(full options)` with hostile-proxy
 * normalization.  Per the pinned `@notesnook/core@8.1.3` d.ts,
 * `setup` is an INSTANCE method on the database, not a static
 * method on the module.  Setup is synchronous in the real upstream;
 * the awaited call to `init()` happens separately.
 */
function safeSetupDatabase(
  database: NotesnookLiveDatabase,
  setupOptions: NotesnookDatabaseSetupOptions,
): void {
  let setupFn: unknown;
  try {
    setupFn = (database as { setup?: unknown }).setup;
  } catch {
    throw factoryError("Notesnook Database.setup is not accessible");
  }
  if (typeof setupFn !== "function") {
    throw factoryError("Notesnook Database.setup is not a function");
  }
  try {
    (setupFn as (options: NotesnookDatabaseSetupOptions) => void).call(database, setupOptions);
  } catch {
    throw factoryError("Notesnook Database.setup rejected the supplied options");
  }
}

/**
 * Set the pinned public Notesnook service endpoints explicitly.  Core derives
 * localhost defaults from ambient NODE_ENV at module-load time, which is
 * unsuitable for an operator-facing production command.
 */
function safeConfigureProductionHosts(database: NotesnookLiveDatabase, required: boolean): void {
  let hostFn: unknown;
  try {
    hostFn = (database as { host?: unknown }).host;
  } catch {
    if (!required) return;
    throw factoryError("Notesnook Database.host is not accessible");
  }
  if (typeof hostFn !== "function") {
    if (!required) return;
    throw factoryError("Notesnook Database.host is not a function");
  }
  try {
    hostFn.call(database, {
      AUTH_HOST: "https://auth.streetwriters.co",
      API_HOST: "https://api.notesnook.com",
      SSE_HOST: "https://events.streetwriters.co",
      SUBSCRIPTIONS_HOST: "https://subscriptions.streetwriters.co",
      ISSUES_HOST: "https://issues.streetwriters.co",
    });
  } catch {
    throw factoryError("Notesnook Database.host rejected production hosts");
  }
}

/**
 * Await `db.init()` with hostile-promise normalization.  Per the
 * pinned `@notesnook/core@8.1.3` d.ts, `init` is an INSTANCE method
 * on the database that resolves once the database is ready to
 * serve.  A throwing / rejecting init body is mapped to a
 * categorical error whose message carries no upstream detail.
 */
async function safeInitDatabase(database: NotesnookLiveDatabase): Promise<void> {
  let initFn: unknown;
  try {
    initFn = (database as { init?: unknown }).init;
  } catch {
    throw factoryError("Notesnook Database.init is not accessible");
  }
  if (typeof initFn !== "function") {
    throw factoryError("Notesnook Database.init is not a function");
  }
  try {
    const awaited = (initFn as () => void | PromiseLike<void>).call(database);
    if (awaited && typeof (awaited as { then?: unknown }).then === "function") {
      await awaited;
    }
  } catch {
    throw factoryError("Notesnook Database.init failed");
  }
}

function buildLiveLocalConflictObserver(
  database: object,
  ensureOpen: () => void,
): NotesnookLocalConflictObserver {
  const source = readLocalConflictSource(database, true);
  if (source === undefined) throw factoryError("local conflict observer surface is unavailable");
  const observer = createNotesnookLocalConflictObserver(source);
  return Object.freeze({
    listLocalConflicts: async () => {
      ensureOpen();
      return observer.listLocalConflicts();
    },
    observeNoteConflict: async (id: string) => {
      ensureOpen();
      return observer.observeNoteConflict(id);
    },
  });
}

function buildOptionalLiveLocalConflictObserver(
  database: object,
  ensureOpen: () => void,
): NotesnookLocalConflictObserver | undefined {
  try {
    return buildLiveLocalConflictObserver(database, ensureOpen);
  } catch {
    return undefined;
  }
}

function readLocalConflictSource(
  database: object,
  required: boolean,
): NotesnookLocalConflictSource | undefined {
  try {
    const notes = Reflect.get(database, "notes");
    if (notes === undefined || notes === null) {
      if (required) throw factoryError("local conflict notes slot is unavailable");
      return undefined;
    }
    if (typeof notes !== "object") {
      throw factoryError("local conflict notes slot is unavailable");
    }
    const conflicted = Reflect.get(notes, "conflicted");
    if (conflicted === null || typeof conflicted !== "object") {
      throw factoryError("local conflict selector is unavailable");
    }
    const ids = Reflect.get(conflicted, "ids");
    const note = Reflect.get(notes, "note");
    if (typeof ids !== "function" || typeof note !== "function") {
      throw factoryError("local conflict observer methods are unavailable");
    }
    const selector = Object.freeze({
      ids: () => Reflect.apply(ids, conflicted, []),
    });
    const sourceNotes = Object.freeze({
      conflicted: selector,
      note: (id: string) => Reflect.apply(note, notes, [id]),
    });
    return Object.freeze({ notes: sourceNotes }) as NotesnookLocalConflictSource;
  } catch (error) {
    if (isFactoryError(error)) throw error;
    throw factoryError("local conflict observer surface is unavailable");
  }
}

function hasReadOnlyProjectionSurface(database: NotesnookLiveDatabase): boolean {
  try {
    return ["syncer", "notebooks", "notes", "lookup", "lastSynced", "hasUnsyncedChanges"].every(
      (slot) => slot in (database as unknown as object),
    );
  } catch {
    // Production construction will call the projection and return its
    // categorical slot error; legacy injected auth-only fakes simply
    // remain without the optional Stage 3 surface.
    return false;
  }
}

function guardReadOnlyProjection(
  readOnly: NotesnookReadOnlyDatabase,
  ensureOpen: () => void,
): NotesnookReadOnlyDatabase {
  const listNotebooksWithParents = readOnly.listNotebooksWithParents;
  const findNotesByTitle = readOnly.findNotesByTitle;
  const findNoteIdsByNotebook = readOnly.findNoteIdsByNotebook;
  return Object.freeze({
    lastSynced: async () => {
      ensureOpen();
      return readOnly.lastSynced();
    },
    hasUnsyncedChanges: async () => {
      ensureOpen();
      return readOnly.hasUnsyncedChanges();
    },
    sync: async (options: Parameters<NotesnookReadOnlyDatabase["sync"]>[0]) => {
      ensureOpen();
      return readOnly.sync(options);
    },
    listNotebooks: async () => {
      ensureOpen();
      return readOnly.listNotebooks();
    },
    ...(listNotebooksWithParents === undefined
      ? {}
      : {
          listNotebooksWithParents: async () => {
            ensureOpen();
            return listNotebooksWithParents();
          },
        }),
    listNotes: async () => {
      ensureOpen();
      return readOnly.listNotes();
    },
    ...(findNotesByTitle === undefined
      ? {}
      : {
          findNotesByTitle: async (title: string) => {
            ensureOpen();
            return findNotesByTitle(title);
          },
        }),
    ...(findNoteIdsByNotebook === undefined
      ? {}
      : {
          findNoteIdsByNotebook: async (notebookId: string) => {
            ensureOpen();
            return findNoteIdsByNotebook(notebookId);
          },
        }),
    noteMetadata: async (id: string) => {
      ensureOpen();
      return readOnly.noteMetadata(id);
    },
    search: async (query: string) => {
      ensureOpen();
      return readOnly.search(query);
    },
  });
}

/**
 * Read the `user` / `tokenManager` slots off the live `Database`
 * instance.  These are pre-built object managers, so we require
 * an object slot.  Normalizes a hostile getter (an accessor that
 * throws, returns a proxy whose internal slot is missing, or
 * returns a primitive) into a categorical error.
 */
function readDbObjectSlot(
  database: NotesnookLiveDatabase,
  slot: "user" | "tokenManager",
  message: string,
): unknown {
  let value: unknown;
  try {
    value = (database as unknown as Record<string, unknown>)[slot];
  } catch {
    throw factoryError(message);
  }
  if (!value || typeof value !== "object") {
    throw factoryError(message);
  }
  return value;
}

/**
 * Read the `kv` slot off the live `Database` instance.  Per the
 * pinned `@notesnook/core@8.1.3` d.ts, `kv` is `KVStorageAccessor`,
 * i.e. a CALLABLE `() => KVStorage` — NOT a plain `KVStorage`
 * object.  Calling it returns a fresh `KVStorage` snapshot.  We
 * therefore require `db.kv` to be a function: passing the
 * accessor itself around to the narrow handle keeps the surface
 * minimal (the handle invokes `db.kv()` per call to obtain the
 * live storage for the underlying `read` / `write` / `delete`).
 */
function readDbKvAccessor(database: NotesnookLiveDatabase): unknown {
  let value: unknown;
  try {
    value = (database as unknown as Record<string, unknown>).kv;
  } catch {
    throw factoryError("Notesnook database handle is missing kv slot");
  }
  if (typeof value !== "function") {
    throw factoryError("Notesnook database handle is missing kv slot");
  }
  return value;
}

/**
 * Normalize the live `Database.kv` accessor into the narrow
 * `read` / `write` / `delete` triple the narrow handle exposes.
 * The literal key `"token"` is the only one accepted.
 *
 * Every property read against the live storage snapshot — and the
 * call to the storage method itself — runs inside the SAME protected
 * try boundary so a hostile getter that throws on `storage.read`
 * (or `.write` / `.delete`) maps to a categorical error rather than
 * leaking the raw getter throw.
 */
function normalizeKvAccessor(
  kvAccessor: unknown,
  ensureOpen: () => void,
): NotesnookLiveCoreHandle["kv"] {
  // Invoke the live accessor; any hostile getter or non-storage
  // return maps to a categorical error without leaking the raw
  // detail.  `enforceStorageShape` (declared below) folds the
  // structural property-read check into the same protected try so
  // a hostile `storage.read` getter cannot bubble either.
  const callAccessor = (): unknown => {
    try {
      const storage = (kvAccessor as () => unknown)();
      enforceStorageShape(storage);
      return storage;
    } catch (error) {
      if (isFactoryError(error)) throw error;
      throw factoryError("Notesnook kv accessor threw");
    }
  };

  const readStorage = (storage: unknown): unknown => {
    try {
      enforceStorageShape(storage);
      const fn = (storage as { read?: unknown }).read;
      if (typeof fn !== "function") {
        throw factoryError("Notesnook kv accessor returned an invalid storage");
      }
      return fn;
    } catch (error) {
      if (isFactoryError(error)) throw error;
      // A hostile getter on `storage.read` throws here — map it
      // to the categorical "invalid storage" error so the raw
      // getter throw cannot leak out.
      throw factoryError("Notesnook kv accessor returned an invalid storage");
    }
  };

  const writeStorage = (storage: unknown): unknown => {
    try {
      enforceStorageShape(storage);
      const fn = (storage as { write?: unknown }).write;
      if (typeof fn !== "function") {
        throw factoryError("Notesnook kv accessor returned an invalid storage");
      }
      return fn;
    } catch (error) {
      if (isFactoryError(error)) throw error;
      throw factoryError("Notesnook kv accessor returned an invalid storage");
    }
  };

  const deleteStorage = (storage: unknown): unknown => {
    try {
      enforceStorageShape(storage);
      const fn = (storage as { delete?: unknown }).delete;
      if (typeof fn !== "function") {
        throw factoryError("Notesnook kv accessor returned an invalid storage");
      }
      return fn;
    } catch (error) {
      if (isFactoryError(error)) throw error;
      throw factoryError("Notesnook kv accessor returned an invalid storage");
    }
  };

  const read = async (key: NotesnookLiveKvKey) => {
    ensureOpen();
    enforceKvKey(key);
    const storage = callAccessor();
    const fn = readStorage(storage) as (k: NotesnookLiveKvKey) => Promise<unknown>;
    try {
      return await fn.call(storage, key);
    } catch (error) {
      if (isFactoryError(error)) throw error;
      throw factoryError("Notesnook kv read failed");
    }
  };

  const write = async (key: NotesnookLiveKvKey, value: unknown) => {
    ensureOpen();
    enforceKvKey(key);
    const storage = callAccessor();
    const fn = writeStorage(storage) as (k: NotesnookLiveKvKey, v: unknown) => Promise<void>;
    try {
      await fn.call(storage, key, value);
    } catch (error) {
      if (isFactoryError(error)) throw error;
      throw factoryError("Notesnook kv write failed");
    }
  };

  const del = async (key: NotesnookLiveKvKey) => {
    ensureOpen();
    enforceKvKey(key);
    const storage = callAccessor();
    const fn = deleteStorage(storage) as (k: NotesnookLiveKvKey) => Promise<void>;
    try {
      await fn.call(storage, key);
    } catch (error) {
      if (isFactoryError(error)) throw error;
      throw factoryError("Notesnook kv delete failed");
    }
  };

  return Object.freeze({ read, write, delete: del });
}

/**
 * Structural check that the value returned from `db.kv()` is a
 * non-null object (or function).  Throws a categorical
 * `Notesnook kv accessor returned an invalid storage` error when
 * the value is missing / non-object / hostile-getter-failed.  This
 * is the same protected boundary every storage-slot reader in
 * {@link normalizeKvAccessor} goes through so a hostile `storage.read`
 * getter throw does NOT leak out of the factory.
 */
function enforceStorageShape(storage: unknown): void {
  if (
    storage === null ||
    storage === undefined ||
    (typeof storage !== "object" && typeof storage !== "function")
  ) {
    throw factoryError("Notesnook kv accessor returned an invalid storage");
  }
}

function enforceKvKey(key: unknown): asserts key is NotesnookLiveKvKey {
  if (key !== NOTESNOOK_LIVE_KV_TOKEN_KEY) {
    throw factoryError("Notesnook kv key is not permitted");
  }
}

/**
 * Wrap the user manager into a narrow, hostile-getter-safe
 * surface.  Every method body is captured once at construction
 * time so a later flip on the upstream object cannot poison the
 * handle.
 */
function wrapUserManager(
  userManager: unknown,
  ensureOpen: () => void,
): NotesnookLiveCoreHandle["user"] {
  if (!userManager || typeof userManager !== "object") {
    throw factoryError("Notesnook user manager is not an object");
  }
  // Capture the required method slots up-front.  Each accessor
  // call is wrapped so a subsequent hostile proxy cannot trap the
  // narrow handle.
  const slotAuthEmail = readUserFn(userManager, "authenticateEmail");
  const slotMfa = readUserFn(userManager, "authenticateMultiFactorCode");
  const slotPassword = readUserFn(userManager, "authenticatePassword");
  const slotLogin = readUserFn(userManager, "_login");
  const slotGetUser = readUserFn(userManager, "getUser");
  const slotLogout = readUserFn(userManager, "logout");

  return Object.freeze({
    authenticateEmail: wrapAsyncSingleArg(
      slotAuthEmail,
      "user.authenticateEmail failed",
      ensureOpen,
    ),
    authenticateMultiFactorCode: wrapAsyncMfa(
      slotMfa,
      "user.authenticateMultiFactorCode failed",
      ensureOpen,
    ),
    authenticatePassword: wrapAsyncPassword(
      slotPassword,
      "user.authenticatePassword failed",
      ensureOpen,
    ),
    _login: wrapAsyncLogin(slotLogin, "user._login failed", ensureOpen),
    getUser: wrapGetUser(slotGetUser, ensureOpen),
    logout: wrapAsyncLogout(slotLogout, "user.logout failed", ensureOpen),
  });
}

/**
 * Capture a single user-manager slot as a function that returns
 * `unknown`.  We then trust individual wrappers (e.g.
 * `wrapAsyncSingleArg`) to type-check the call; the captured
 * closure binds `this` to the original user-manager slot so a
 * hostile proxy swap on the live handle cannot unbind the call.
 */
function readUserFn(userManager: unknown, slot: string): (...args: unknown[]) => unknown {
  let fn: unknown;
  try {
    fn = (userManager as Record<string, unknown>)[slot];
  } catch {
    throw factoryError(`Notesnook user manager is missing ${slot}`);
  }
  if (typeof fn !== "function") {
    throw factoryError(`Notesnook user manager is missing ${slot}`);
  }
  return (...args: unknown[]) => {
    try {
      return (fn as (...args: unknown[]) => unknown).apply(userManager, args);
    } catch {
      throw factoryError(`Notesnook user.${slot} threw synchronously`);
    }
  };
}

function wrapAsyncSingleArg(
  fn: (...args: unknown[]) => unknown,
  message: string,
  ensureOpen: () => void,
): (arg: string) => Promise<unknown> {
  return async (arg: string) => {
    ensureOpen();
    if (typeof arg !== "string") {
      throw factoryError("Notesnook authenticateEmail requires a string email");
    }
    try {
      const result: unknown = fn(arg);
      return await (result as unknown);
    } catch {
      throw factoryError(message);
    }
  };
}

function wrapAsyncMfa(
  fn: (...args: unknown[]) => unknown,
  message: string,
  ensureOpen: () => void,
): (code: string, type: "app") => Promise<unknown> {
  return async (code: string, type: "app") => {
    ensureOpen();
    if (typeof code !== "string") {
      throw factoryError("Notesnook authenticateMultiFactorCode requires a string code");
    }
    if (type !== "app") {
      throw factoryError('Notesnook authenticateMultiFactorCode requires type "app"');
    }
    try {
      const result: unknown = fn(code, type);
      return await (result as unknown);
    } catch {
      throw factoryError(message);
    }
  };
}

function wrapAsyncPassword(
  fn: (...args: unknown[]) => unknown,
  message: string,
  ensureOpen: () => void,
): (email: string, password: string) => Promise<unknown> {
  return async (email: string, password: string) => {
    ensureOpen();
    if (typeof email !== "string") {
      throw factoryError("Notesnook authenticatePassword requires a string email");
    }
    if (typeof password !== "string") {
      throw factoryError("Notesnook authenticatePassword requires a string password");
    }
    try {
      const result: unknown = fn(email, password);
      return await (result as unknown);
    } catch {
      throw factoryError(message);
    }
  };
}

function wrapAsyncLogin(
  fn: (...args: unknown[]) => unknown,
  message: string,
  ensureOpen: () => void,
): NotesnookLiveCoreHandle["user"]["_login"] {
  return async (args) => {
    ensureOpen();

    let email: unknown;
    let password: unknown;
    let hashedPassword: unknown;
    try {
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw factoryError("Notesnook _login requires an arguments object");
      }
      const candidate = args as Record<string, unknown>;
      email = candidate.email;
      password = candidate.password;
      hashedPassword = candidate.hashedPassword;
    } catch (error) {
      if (isFactoryError(error)) throw error;
      throw factoryError("Notesnook _login arguments could not be read");
    }

    if (typeof email !== "string" || email.length === 0) {
      throw factoryError("Notesnook _login requires a non-empty string email");
    }
    if (typeof password !== "string" || password.length === 0) {
      throw factoryError("Notesnook _login requires a non-empty string password");
    }
    if (typeof hashedPassword !== "string" || hashedPassword.length === 0) {
      throw factoryError("Notesnook _login requires a non-empty string hashedPassword");
    }

    try {
      await (fn({ email, password, hashedPassword }) as unknown);
    } catch {
      throw factoryError(message);
    }
  };
}

function wrapGetUser(
  fn: (...args: unknown[]) => unknown,
  ensureOpen: () => void,
): () => Promise<NotesnookLiveUser | undefined> {
  return async () => {
    ensureOpen();
    try {
      const raw: unknown = fn();
      const awaited: unknown = await (raw as unknown);
      return normalizeUser(awaited);
    } catch {
      throw factoryError("user.getUser failed");
    }
  };
}

/**
 * Wrap the upstream user.logout seam so the narrow handle forwards
 * the caller's `clearLocal: boolean` to the pinned
 * `@notesnook/core@8.1.3` upstream.  Per the pinned d.ts the
 * upstream call is `user.logout(clearLocal: boolean)`.  NookBridge
 * always passes `true` from the auth provider so the upstream
 * cache is wiped on logout; the explicit boolean parameter
 * preserves the upstream contract without widening the surface.
 */
function wrapAsyncLogout(
  fn: (...args: unknown[]) => unknown,
  message: string,
  ensureOpen: () => void,
): (clearLocal: boolean) => Promise<void> {
  return async (clearLocal: boolean) => {
    ensureOpen();
    if (typeof clearLocal !== "boolean") {
      throw factoryError("Notesnook logout requires a boolean clearLocal");
    }
    try {
      const result: unknown = fn(clearLocal);
      await (result as unknown);
    } catch {
      throw factoryError(message);
    }
  };
}

/**
 * Normalize a hostile upstream `User` value into the narrow
 * {@link NotesnookLiveUser} shape (or undefined).  Proxies that
 * return primitives, throw on key access, or omit `id` / `email`
 * are rejected with a categorical error.
 */
function normalizeUser(raw: unknown): NotesnookLiveUser | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    throw factoryError("Notesnook user.getUser returned a non-object");
  }
  let id: unknown;
  let email: unknown;
  try {
    id = (raw as { id?: unknown }).id;
    email = (raw as { email?: unknown }).email;
  } catch {
    throw factoryError("Notesnook user.getUser rejected property access");
  }
  if (typeof id !== "string" || id.length === 0) {
    throw factoryError("Notesnook user.getUser did not return a string id");
  }
  if (typeof email !== "string" || email.length === 0) {
    throw factoryError("Notesnook user.getUser did not return a string email");
  }
  // Freeze so downstream consumers cannot mutate a hostile returned object.
  return Object.freeze({ id, email });
}

/**
 * Wrap the token manager into the narrow `getToken` /
 * `_refreshToken` surface, normalizing hostile upstream returns
 * into the closed {@link NotesnookLiveTokenEnvelope} shape (or
 * undefined).
 */
function wrapTokenManager(
  tokenManager: unknown,
  ensureOpen: () => void,
): NotesnookLiveCoreHandle["token"] {
  if (!tokenManager || typeof tokenManager !== "object") {
    throw factoryError("Notesnook token manager is not an object");
  }

  const slots = {
    getToken: readTokenSlot(tokenManager, "getToken"),
    _refreshToken: readTokenSlot(tokenManager, "_refreshToken"),
  };

  return Object.freeze({
    getToken: async () => {
      ensureOpen();
      try {
        const raw: unknown = await slots.getToken();
        return normalizeTokenEnvelope(raw);
      } catch (error) {
        // Factory-generated validation errors (e.g. a hostile
        // envelope missing `access_token`) propagate unchanged so
        // the categorical message reaches the caller; only
        // arbitrary upstream throws / rejections are normalized to
        // the generic `token.getToken failed` boundary error.
        if (isFactoryError(error)) throw error;
        throw factoryError("token.getToken failed");
      }
    },
    _refreshToken: async (forceRenew: boolean) => {
      ensureOpen();
      if (typeof forceRenew !== "boolean") {
        throw factoryError("Notesnook _refreshToken requires a boolean forceRenew");
      }
      try {
        await slots._refreshToken(forceRenew);
      } catch (error) {
        if (isFactoryError(error)) throw error;
        throw factoryError("token._refreshToken failed");
      }
    },
  });
}

function readTokenSlot(tokenManager: unknown, slot: string): (...args: unknown[]) => unknown {
  let fn: unknown;
  try {
    fn = (tokenManager as Record<string, unknown>)[slot];
  } catch {
    throw factoryError(`Notesnook token manager is missing ${slot}`);
  }
  if (typeof fn !== "function") {
    throw factoryError(`Notesnook token manager is missing ${slot}`);
  }
  return (...args: unknown[]) => {
    try {
      return (fn as (...args: unknown[]) => unknown).apply(tokenManager, args);
    } catch {
      throw factoryError(`Notesnook token.${slot} threw synchronously`);
    }
  };
}

/**
 * Normalize an upstream token envelope into the closed
 * {@link NotesnookLiveTokenEnvelope} shape (or undefined when
 * upstream reports "no current token").  Every hostile getter
 * branch is mapped to a categorical error.
 */
function normalizeTokenEnvelope(raw: unknown): NotesnookLiveTokenEnvelope | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    throw factoryError("Notesnook token.getToken returned a non-object");
  }
  let access: unknown;
  let refresh: unknown;
  let expires: unknown;
  let scope: unknown;
  let t: unknown;
  try {
    const r = raw as Record<string, unknown>;
    access = r.access_token;
    refresh = r.refresh_token;
    expires = r.expires_in;
    scope = r.scope;
    t = r.t;
  } catch {
    throw factoryError("Notesnook token.getToken rejected property access");
  }
  if (typeof access !== "string" || access.length === 0) {
    throw factoryError("Notesnook token.getToken did not return an access_token");
  }
  if (refresh !== undefined && typeof refresh !== "string") {
    throw factoryError("Notesnook token.getToken returned an invalid refresh_token");
  }
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0) {
    throw factoryError("Notesnook token.getToken did not return a positive numeric expires_in");
  }
  if (typeof scope !== "string") {
    throw factoryError("Notesnook token.getToken did not return a string scope");
  }
  if (typeof t !== "number" || !Number.isFinite(t)) {
    throw factoryError("Notesnook token.getToken did not return a numeric t");
  }
  return Object.freeze({
    access_token: access,
    ...(refresh === undefined ? {} : { refresh_token: refresh }),
    expires_in: expires,
    scope,
    t,
  });
}

/**
 * Teardown is a hostile boundary too: lifecycle.close may throw
 * synchronously and onCleanup may throw before returning a thenable.
 * Attempt both actions, preserve only categorical errors, and never
 * attach the hostile value as a cause/context.
 */
async function teardownResources(
  lifecycle: NotesnookLiveCoreLifecycle,
  onCleanup: () => void | Promise<void>,
): Promise<void> {
  let failure: Error | undefined;
  try {
    lifecycle.close();
  } catch {
    failure = factoryError("Notesnook live runtime lifecycle close failed");
  }
  try {
    await invokeCleanupHook(onCleanup);
  } catch (error) {
    failure ??= isFactoryError(error) ? error : factoryError("Notesnook cleanup hook rejected");
  }
  if (failure) throw failure;
}

async function bestEffortTeardown(
  lifecycle: NotesnookLiveCoreLifecycle,
  onCleanup: () => void | Promise<void>,
): Promise<void> {
  try {
    await teardownResources(lifecycle, onCleanup);
  } catch {
    // The construction/setup/init error is the caller-visible categorical
    // failure.  Teardown was still attempted in both branches above.
  }
}

function invokeCleanupHook(onCleanup: () => void | Promise<void>): Promise<void> {
  try {
    return normalizeAsyncVoid(onCleanup());
  } catch {
    return Promise.reject(factoryError("Notesnook cleanup hook rejected"));
  }
}

// ---------------------------------------------------------------------------
// Hostile-proxy normalizers.
// ---------------------------------------------------------------------------

/**
 * Normalize an arbitrary non-undefined value into a `Promise<void>`.
 * Used for the `onCleanup` hook and any other async returns where
 * we accept `void | PromiseLike<void>`.
 */
async function normalizeAsyncVoid(value: unknown): Promise<void> {
  try {
    if (value === undefined || value === null) return;
    if (typeof value === "object" && typeof (value as { then?: unknown }).then === "function") {
      await (value as PromiseLike<void>);
      return;
    }
  } catch {
    throw factoryError("Notesnook cleanup hook rejected");
  }
  throw factoryError("Notesnook cleanup hook returned a non-thenable value");
}

// ---------------------------------------------------------------------------
// Categorical error.
// ---------------------------------------------------------------------------

/**
 * Construct a categorical, chain-free factory error.  We
 * deliberately wipe `cause` and `__context__` so a hostile
 * upstream throw never bubbles a secret-bearing payload out of
 * the boundary.  The error message is one of a small fixed set
 * enumerated above.
 *
 * The factory error is also tagged with a non-enumerable
 * {@link FACTORY_ERROR_MARKER} symbol so the boundary predicates
 * ({@link isFactoryError}) can recognise our own categorical
 * throws and let them propagate unchanged through outer
 * try/catch wrappers (e.g. `token.getToken`'s outer catch), while
 * upstream thrown / rejected values still normalize to the
 * caller's expected categorical message.
 */
const FACTORY_ERROR_MARKER: unique symbol = Symbol("notesnook.factoryError");

function factoryError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  Object.defineProperty(error, FACTORY_ERROR_MARKER, {
    configurable: true,
    value: true,
    enumerable: false,
    writable: false,
  });
  return error;
}

/**
 * Predicate: is `value` an Error thrown by {@link factoryError}?
 * Used by outer wrappers (notably `token.getToken`) to allow our
 * own categorical validation errors to propagate unchanged while
 * still normalising arbitrary upstream throws / rejections to
 * the wrapped boundary's categorical message.
 */
function isFactoryError(value: unknown): value is Error {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      (value as { [FACTORY_ERROR_MARKER]?: unknown })[FACTORY_ERROR_MARKER] === true
    );
  } catch {
    return false;
  }
}
