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
import { chmodSync, existsSync } from "node:fs";
import Database from "better-sqlite3-multiple-ciphers";
import { SqliteDialect } from "@streetwriters/kysely";

import { normaliseStateDir, ensureStateDir } from "../config/state-dir.js";
import { createDevelopmentFileKeyStore } from "../keystore/file-keystore.js";
import type { SecureKeyStore } from "../keystore/keystore.js";
import type { Logger } from "../logging/logger.js";
import { createPersistentStorage } from "../storage/persistent-storage.js";
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
import { PersistentSyncMetadataStateStore } from "../core/notesnook-sync-state-store.js";
import { createLiveNotesnookAuthProvider } from "./live-notesnook-auth-provider.js";
import type { LiveLoginRuntime } from "./admin-command.js";

export type CreateLiveLoginRuntimeOptions = Readonly<{
  stateDir: string;
  logger?: Logger;
  /**
   * Optional caller-selected key backend.  The ordinary CLI path omits this
   * and retains its development-file behavior.  Production provisioning
   * supplies the systemd-credential backend explicitly.
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
      ...(options.injectedModule === undefined ? {} : { injectedModule: options.injectedModule }),
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
          database.pragma(`key="${escapeSqliteKey(key)}"`);
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

function escapeSqliteKey(key: string): string {
  return key.replace(/["\\]/g, "");
}

function runtimeError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  return error;
}
