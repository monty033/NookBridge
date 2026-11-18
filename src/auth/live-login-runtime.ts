/**
 * Explicit operator-only runtime for `nookctl auth live-login`.
 *
 * This module is intentionally reached only after the CLI has accepted the
 * exact live-login subcommand, the non-secret opt-in, and the credential
 * carrier policy.  It owns the concrete local resources used by the real
 * Notesnook core, but exposes only a provider factory and an idempotent
 * cleanup function to the command runner.
 *
 * The `injectedModule` option is a test-only seam.  Production callers omit
 * it, which leaves the real package import lazy inside
 * `createNotesnookLiveCoreFactory`.
 *
 * Stage 5 service-boundary refactor:
 *
 *   The shared real-core setup / cleanup mechanics live in
 *   {@link createProductionRuntimeCore}.  The CLI live-login path
 *   wires its existing development-file key store into the seam so
 *   the existing behavior and tests are preserved unchanged.  The
 *   dedicated service runtime (Task 3) composes the same seam with a
 *   caller-supplied production-safe key store.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, realpathSync, statSync } from "node:fs";
import Database from "better-sqlite3-multiple-ciphers";
import { SqliteDialect } from "@streetwriters/kysely";

import { normaliseStateDir, ensureStateDir } from "../config/state-dir.js";
import { createDevelopmentFileKeyStore } from "../keystore/file-keystore.js";
import {
  createSystemdCredentialKeyStore,
  NOOKBRIDGE_DB_KEY_LABEL,
} from "../keystore/systemd-credential-keystore.js";
import type { SecureKeyStore } from "../keystore/keystore.js";
import type { Logger } from "../logging/logger.js";
import { createPersistentStorage } from "../storage/persistent-storage.js";
import { validateSqlcipherKey } from "../storage/sqlcipher-key.js";
import type {
  NotesnookDatabaseSetupOptions,
  NotesnookIFileStorage,
  NotesnookRealCoreModule,
} from "../core/notesnook-core-adapter.js";
import {
  createNotesnookLiveCoreFactory,
  type NotesnookLiveCoreHandle,
  type NotesnookLiveCoreLifecycle,
} from "../core/notesnook-live-factory.js";
import type { NotesnookWriteOrigin } from "../core/notesnook-write-composition.js";
import { PersistentSyncMetadataStateStore } from "../core/notesnook-sync-state-store.js";
import { PersistentNotesnookRecoveryJournal } from "../core/notesnook-recovery-journal.js";
import { createLiveNotesnookAuthProvider } from "./live-notesnook-auth-provider.js";
import type { LiveLoginRuntime } from "./admin-command.js";

/**
 * The production state directory.  `operator/production-runtime.ts` re-exports
 * this as `PRODUCTION_STATE_DIR`, so there is one source of truth.
 */
export const PRODUCTION_STATE_DIR_FOR_KEYS = "/var/lib/nookbridge" as const;

/**
 * Name of the environment variable that carries the systemd credentials
 * directory.  Defined here because this module reads it; `operator/
 * production-runtime.ts` re-exports it.
 */
export const CREDENTIALS_DIRECTORY_ENV = "CREDENTIALS_DIRECTORY" as const;

/**
 * Refuse to create a development key file inside the production state
 * directory.  Production state holds its key only in the systemd credential
 * slot; a development key minted there would be a second, unrelated key next
 * to production data (issue #288).
 *
 * Pure: it inspects the path and the presence of a caller key store and writes
 * nothing, so tests can exercise it without touching the real directory.
 */
export function assertNoDevelopmentKeyForProduction(
  stateDir: string,
  keysSupplied: boolean,
  productionDir: string = PRODUCTION_STATE_DIR_FOR_KEYS,
): void {
  if (keysSupplied) return;
  if (isSameDirectory(stateDir, productionDir)) {
    throw new Error("production state requires the systemd credential key");
  }
}

/**
 * True when both paths name the same directory, by resolved path or by device
 * and inode.  A symlink or bind mount that reaches the production directory is
 * caught, not only the literal string.  An absent side is simply not a match.
 */
function isSameDirectory(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    if (realpathSync(a) === realpathSync(b)) return true;
  } catch {
    /* an absent side cannot be resolved; try the inode comparison */
  }
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * Select the systemd credential key store from `CREDENTIALS_DIRECTORY`.
 *
 * Returns `undefined` when the variable is unset or empty, so the caller keeps
 * its default.  A relative directory yields a store whose key is undefined,
 * which fails closed inside the store, so it never falls back to a dev key.
 */
export function liveLoginKeysFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): SecureKeyStore | undefined {
  const credentialsDirectory = environment[CREDENTIALS_DIRECTORY_ENV];
  if (typeof credentialsDirectory !== "string" || credentialsDirectory.length === 0) {
    return undefined;
  }
  return createSystemdCredentialKeyStore({
    credentialsDirectory,
    credentialName: NOOKBRIDGE_DB_KEY_LABEL,
  });
}

/**
 * Add the systemd credential key to live-login runtime options when the
 * environment supplies one.  Used by the `auth` commands.  Without a credential
 * directory the options are returned unchanged, and production state then
 * refuses to start (see `assertNoDevelopmentKeyForProduction`).
 */
export function withLiveLoginKeys<T extends { stateDir: string }>(
  options: T,
  environment: Readonly<Record<string, string | undefined>>,
): T & { keys?: SecureKeyStore } {
  const keys = liveLoginKeysFromEnvironment(environment);
  return keys === undefined ? options : { ...options, keys };
}

/**
 * Build the live-login runtime for the `auth` commands (live-login, status and
 * logout).  They share one factory, so the systemd credential key reaches all
 * three from `CREDENTIALS_DIRECTORY`.
 */
export async function createAuthLiveLoginRuntime(
  input: Readonly<{
    stateDir: string;
    environment: Readonly<Record<string, string | undefined>>;
    logger?: Logger;
  }>,
): Promise<LiveLoginRuntime> {
  const base: CreateLiveLoginRuntimeOptions =
    input.logger === undefined
      ? { stateDir: input.stateDir }
      : { stateDir: input.stateDir, logger: input.logger };
  return createProductionLiveLoginRuntime(withLiveLoginKeys(base, input.environment));
}

export type CreateLiveLoginRuntimeOptions = Readonly<{
  stateDir: string;
  logger?: Logger;
  /**
   * Optional caller-selected key backend.  When omitted, a non-production
   * state directory keeps its development key file.  The production state
   * directory refuses to run without a caller key, so no development key is
   * ever created there.  The `auth live-login` path supplies the systemd key
   * through `withLiveLoginKeys`.
   */
  keys?: SecureKeyStore;
  /** Offline test seam; never pass this from the CLI. */
  injectedModule?: NotesnookRealCoreModule;
}>;

/**
 * Build the real local runtime for the gated live-login command.
 *
 * No upstream authentication occurs here.  The returned provider factory is
 * invoked by the live runner after the TTY prompt has collected credentials.
 */
export async function createProductionLiveLoginRuntime(
  options: CreateLiveLoginRuntimeOptions,
): Promise<LiveLoginRuntime> {
  const normalized = normalizeRuntimeOptions(options);
  const stateDir = normaliseStateDir(normalized.stateDir);
  assertNoDevelopmentKeyForProduction(stateDir, normalized.keys !== undefined);
  const keys =
    normalized.keys ??
    createDevelopmentFileKeyStore({
      keyPath: `${stateDir}/.d/db.key`,
      generateIfMissing: true,
    });

  const core = await createProductionRuntimeCore({
    stateDir,
    keys,
    ...(normalized.logger === undefined ? {} : { logger: normalized.logger }),
    ...(normalized.injectedModule === undefined
      ? {}
      : { injectedModule: normalized.injectedModule }),
  });

  return {
    providerFactory: ({ passwordSupplier, mfaSupplier }) => {
      ensureRuntimeOpen(core.lifecycle);
      return createLiveNotesnookAuthProvider({
        handle: core.handle,
        passwordSupplier,
        mfaSupplier,
        cleanupHook: () => undefined,
        ...(normalized.logger === undefined ? {} : { logger: normalized.logger }),
      });
    },
    cleanup: core.cleanup,
    ...(core.handle.readOnly === undefined ? {} : { readOnly: core.handle.readOnly }),
    ...(core.handle.localWrite === undefined ? {} : { localWrite: core.handle.localWrite }),
    ...(core.handle.remoteSync === undefined ? {} : { remoteSync: core.handle.remoteSync }),
    ...(core.handle.localConflictObserver === undefined
      ? {}
      : { localConflictObserver: core.handle.localConflictObserver }),
    ...(core.handle.localConflictInspector === undefined
      ? {}
      : { localConflictInspector: core.handle.localConflictInspector }),
  };
}

// ---------------------------------------------------------------------------
// Shared setup/cleanup seam.
//
// The CLI live-login path and the dedicated Stage 5 service runtime share
// the same real-core setup / cleanup mechanics.  The seam takes a fully
// caller-supplied {@link SecureKeyStore} so each caller is responsible for
// selecting the appropriate backend (development-file vs systemd-credential).
// The seam never decides a backend itself and never logs key material.
// ---------------------------------------------------------------------------

export type ProductionRuntimeCoreOptions = Readonly<{
  stateDir: string;
  keys: SecureKeyStore;
  logger?: Logger;
  injectedModule?: NotesnookRealCoreModule;
  /** Fixed write origin for the local-write capability; forwarded unchanged. */
  localWriteOrigin?: NotesnookWriteOrigin;
  /** Also build the operator-origin local-write capability; forwarded unchanged. */
  operatorLocalWrite?: true;
}>;

export type ProductionRuntimeCore = Readonly<{
  handle: NotesnookLiveCoreHandle;
  lifecycle: NotesnookLiveCoreLifecycle;
  storage: ReturnType<typeof createPersistentStorage>;
  /** Idempotent cleanup.  Categorical errors only. */
  cleanup: () => Promise<void>;
}>;

/**
 * Open the encrypted persistent store, instantiate the narrowed
 * real-core handle, and prepare an idempotent cleanup that closes
 * storage/core handles exactly once.
 *
 * The seam is intentionally minimal: callers decide the key
 * backend and own the lifecycle; this helper only owns the resource
 * acquisition / release plumbing.  Callers must guard backend
 * selection upstream — this helper does not refuse a development-file
 * backend on its own because the CLI development flow legitimately
 * uses one.
 */
export async function createProductionRuntimeCore(
  options: ProductionRuntimeCoreOptions,
): Promise<ProductionRuntimeCore> {
  let storage: ReturnType<typeof createPersistentStorage> | undefined;
  const sqliteDatabases = new Set<InstanceType<typeof Database>>();
  let handle: NotesnookLiveCoreHandle | undefined;
  const lifecycle: NotesnookLiveCoreLifecycle = createRuntimeLifecycle();

  try {
    const stateDir = normaliseStateDir(options.stateDir);
    ensureStateDir(stateDir);

    const key = options.keys.getDatabaseKey();
    if (!key) {
      throw runtimeError(
        options.keys.backend === "development-file"
          ? "live-login local key is unavailable"
          : "live-login key material is unavailable",
      );
    }

    storage = createPersistentStorage({
      stateDir,
      dbPath: `${stateDir}/nookbridge-storage.db`,
      keys: options.keys,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

    const setup = buildSetupOptions(stateDir, key, sqliteDatabases, storage, options.logger);
    handle = await createNotesnookLiveCoreFactory({
      setup,
      onCleanup: () => undefined,
      lifecycle,
      // The shared coordinator created by the live factory persists only
      // bounded queue metadata through the already-open encrypted store.
      syncStateStore: new PersistentSyncMetadataStateStore(storage),
      recoveryJournal: new PersistentNotesnookRecoveryJournal(storage),
      ...(options.injectedModule === undefined ? {} : { injectedModule: options.injectedModule }),
      ...(options.localWriteOrigin === undefined
        ? {}
        : { localWriteOrigin: options.localWriteOrigin }),
      ...(options.operatorLocalWrite === undefined
        ? {}
        : { operatorLocalWrite: options.operatorLocalWrite }),
    });
    hardenLiveSqliteDatabases(sqliteDatabases);

    const liveHandle = handle;
    const liveStorage = storage;
    return {
      handle: liveHandle,
      lifecycle,
      storage: liveStorage,
      cleanup: async () => {
        if (lifecycle.isClosed()) return;
        lifecycle.close();
        let failure: Error | undefined;
        try {
          await liveHandle.cleanup();
        } catch {
          failure = runtimeError("live-login core cleanup failed");
        } finally {
          closeDatabases(sqliteDatabases);
          liveStorage.close();
        }
        if (failure) throw failure;
      },
    };
  } catch {
    lifecycle.close();
    closeDatabases(sqliteDatabases);
    try {
      storage?.close();
    } catch {
      // PersistentStorage.close is best effort; keep the public error stable.
    }
    throw runtimeError("live-login local runtime initialization failed");
  }
}

type NormalizedRuntimeOptions = Readonly<{
  stateDir: string;
  logger?: Logger;
  keys?: SecureKeyStore;
  injectedModule?: NotesnookRealCoreModule;
}>;

function normalizeRuntimeOptions(options: unknown): NormalizedRuntimeOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("invalid live-login runtime options");
  }
  const candidate = options as Record<string, unknown>;
  const stateDir = candidate.stateDir;
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    throw new Error("invalid live-login runtime state directory");
  }
  const logger = candidate.logger;
  if (logger !== undefined && (typeof logger !== "object" || logger === null)) {
    throw new Error("invalid live-login runtime logger");
  }
  const keys = candidate.keys;
  if (
    keys !== undefined &&
    (typeof keys !== "object" ||
      keys === null ||
      Array.isArray(keys) ||
      typeof (keys as Record<string, unknown>).getDatabaseKey !== "function")
  ) {
    throw new Error("invalid live-login runtime key store");
  }
  const injectedModule = candidate.injectedModule;
  return {
    stateDir,
    ...(logger === undefined ? {} : { logger: logger as Logger }),
    ...(keys === undefined ? {} : { keys: keys as SecureKeyStore }),
    ...(injectedModule === undefined
      ? {}
      : { injectedModule: injectedModule as NotesnookRealCoreModule }),
  };
}

function buildSetupOptions(
  stateDir: string,
  key: string,
  sqliteDatabases: Set<InstanceType<typeof Database>>,
  storage: ReturnType<typeof createPersistentStorage>,
  _logger: Logger | undefined,
): NotesnookDatabaseSetupOptions {
  // Refuse an unrepresentable key before any login database is created, so a
  // refusal cannot leave a file keyed by something other than what was read.
  const validatedKey = validateSqlcipherKey(key);
  return {
    sqliteOptions: {
      // `_init` is upstream's bootstrap callback (`@notesnook/core@8.1.3`
      // `createDatabase`: `options.dialect(name, () => db.connection().execute(...))`).
      // It MUST NOT be forwarded to kysely as `onCreateConnection`: upstream
      // already drives the bootstrap itself, and wiring it here re-enters the
      // driver from inside `SqliteDriver.init()`
      // (onCreateConnection -> bootstrap -> connection() -> driver init ...),
      // which overflows the stack before `Database.init()` can resolve.
      dialect: (name, _init) => {
        if (name !== "notesnook" && name !== "notesnook-logs") {
          throw runtimeError("live-login requested an unsupported SQLite database");
        }
        const dbPath = `${stateDir}/${name}.db`;
        const database = new Database(dbPath);
        try {
          hardenLiveSqlitePath(dbPath);
          database.pragma("cipher='sqlcipher'");
          database.pragma(`key="${validatedKey}"`);
          hardenLiveSqlitePath(dbPath);
          sqliteDatabases.add(database);
          return new SqliteDialect({ database });
        } catch {
          try {
            database.close();
          } catch {
            // best effort
          }
          throw runtimeError("live-login SQLite initialization failed");
        }
      },
      journalMode: "WAL",
      synchronous: "normal",
    },
    storage,
    fs: createClosedFileStorage(),
    compressor: {
      compress: async (data: string) => data,
      decompress: async (data: string) => data,
    },
    batchSize: 100,
  };
}

/**
 * Closed, offline file adapter.  Live-login does not sync files; methods
 * which would perform file transport fail categorically instead of gaining a
 * hidden network path through the core.
 */
function createClosedFileStorage(): NotesnookIFileStorage {
  const unsupported = (): never => {
    throw runtimeError("live-login file transport is unavailable");
  };
  const cancellable = () => ({
    execute: async () => unsupported(),
    cancel: async () => undefined,
  });
  return {
    downloadFile: cancellable,
    uploadFile: cancellable,
    readEncrypted: async () => undefined,
    writeEncryptedBase64: async () => unsupported(),
    deleteFile: async () => false,
    exists: async () => false,
    bulkExists: async () => [],
    getUploadedFileSize: async () => 0,
    clearFileStorage: async () => undefined,
    hashBase64: async (data: string) => ({
      hash: createHash("sha256").update(data, "utf8").digest("base64"),
      type: "sha256",
    }),
  };
}

function closeDatabases(databases: Set<InstanceType<typeof Database>>): void {
  for (const database of databases) {
    try {
      database.close();
    } catch {
      // best effort; the caller still receives the categorical operation error
    }
  }
  databases.clear();
}

function createRuntimeLifecycle(): NotesnookLiveCoreLifecycle {
  const state = { closed: false };
  return {
    isClosed: () => state.closed,
    close: () => {
      state.closed = true;
    },
  };
}

function ensureRuntimeOpen(lifecycle: NotesnookLiveCoreLifecycle): void {
  if (lifecycle.isClosed()) throw runtimeError("live-login runtime is closed");
}

function hardenLiveSqliteDatabases(databases: Set<InstanceType<typeof Database>>): void {
  for (const database of databases) {
    let path: string;
    try {
      path = database.name;
    } catch {
      throw runtimeError("live-login SQLite path is unavailable");
    }
    hardenLiveSqlitePath(path);
  }
}

function hardenLiveSqlitePath(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const candidate = `${path}${suffix}`;
    try {
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    } catch {
      throw runtimeError("live-login SQLite permissions could not be hardened");
    }
  }
}

function runtimeError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  return error;
}
