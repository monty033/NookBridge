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
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import Database from "better-sqlite3-multiple-ciphers";
import { SqliteDialect } from "@streetwriters/kysely";

import { normaliseStateDir, ensureStateDir } from "../config/state-dir.js";
import { createDevelopmentFileKeyStore } from "../keystore/file-keystore.js";
import type { Logger } from "../logging/logger.js";
import { createPersistentStorage } from "../storage/persistent-storage.js";
import type {
  NotesnookDatabaseSetupOptions,
  NotesnookIFileStorage,
  NotesnookRealCoreModule,
} from "../core/notesnook-core-adapter.js";
import {
  createNotesnookLiveCoreFactory,
  type NotesnookLiveCoreLifecycle,
  type NotesnookLiveCoreHandle,
} from "../core/notesnook-live-factory.js";
import { createLiveNotesnookAuthProvider } from "./live-notesnook-auth-provider.js";
import type { LiveLoginRuntime } from "./admin-command.js";

export type CreateLiveLoginRuntimeOptions = Readonly<{
  stateDir: string;
  logger?: Logger;
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
  let storage: ReturnType<typeof createPersistentStorage> | undefined;
  const sqliteDatabases = new Set<InstanceType<typeof Database>>();
  let handle: NotesnookLiveCoreHandle | undefined;
  const lifecycle: NotesnookLiveCoreLifecycle = createRuntimeLifecycle();

  try {
    const normalized = normalizeRuntimeOptions(options);
    const stateDir = normaliseStateDir(normalized.stateDir);
    ensureStateDir(stateDir);

    const keys = createDevelopmentFileKeyStore({
      keyPath: `${stateDir}/.d/db.key`,
      generateIfMissing: true,
    });
    const key = keys.getDatabaseKey();
    if (!key) throw runtimeError("live-login local key is unavailable");

    storage = createPersistentStorage({
      stateDir,
      dbPath: `${stateDir}/nookbridge-storage.db`,
      keys,
      ...(normalized.logger === undefined ? {} : { logger: normalized.logger }),
    });

    const setup = buildSetupOptions(stateDir, key, sqliteDatabases, storage, normalized.logger);
    handle = await createNotesnookLiveCoreFactory({
      setup,
      onCleanup: () => undefined,
      lifecycle,
      ...(normalized.injectedModule === undefined
        ? {}
        : { injectedModule: normalized.injectedModule }),
    });
    hardenLiveSqliteDatabases(sqliteDatabases);

    const liveHandle = handle;
    const liveStorage = storage;
    return {
      providerFactory: ({ passwordSupplier, mfaSupplier }) => {
        ensureRuntimeOpen(lifecycle);
        return createLiveNotesnookAuthProvider({
          handle: liveHandle,
          passwordSupplier,
          mfaSupplier,
          cleanupHook: () => undefined,
          ...(normalized.logger === undefined ? {} : { logger: normalized.logger }),
        });
      },
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
  const injectedModule = candidate.injectedModule;
  return {
    stateDir,
    ...(logger === undefined ? {} : { logger: logger as Logger }),
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
