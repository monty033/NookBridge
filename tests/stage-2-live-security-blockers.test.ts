import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  LiveNotesnookAuthProvider,
  type LiveNotesnookAuthProviderOptions,
} from "../src/auth/live-notesnook-auth-provider.js";
import type { NotesnookLiveCoreHandle } from "../src/core/notesnook-live-factory.js";
import { createNotesnookLiveCoreFactory } from "../src/core/notesnook-live-factory.js";
import {
  markRealCoreModule,
  validateDatabaseSetupOptions,
  type NotesnookDatabaseSetupOptions,
  type NotesnookRealCoreModule,
} from "../src/core/notesnook-core-adapter.js";
import { createPersistentStorage } from "../src/storage/persistent-storage.js";
import type { SecureKeyStore } from "../src/keystore/keystore.js";
import type { Logger } from "../src/logging/logger.js";
import { isLocked, lockPath, releaseLock } from "../src/config/lock.js";

const LEAK_CANARY = "security-blocker-runtime-canary";

function makeProviderOptions(handle: NotesnookLiveCoreHandle): LiveNotesnookAuthProviderOptions {
  return {
    handle,
    cleanupHook: () => undefined,
  };
}

function validSetup(): NotesnookDatabaseSetupOptions {
  return {
    sqliteOptions: { dialect: () => ({}) },
    storage: {},
    fs: {},
    compressor: {},
    batchSize: 1,
  } as unknown as NotesnookDatabaseSetupOptions;
}

function makeLiveModule(): NotesnookRealCoreModule {
  const user = {
    authenticateEmail: vi.fn(async () => ({ scope: "notes" })),
    authenticateMultiFactorCode: vi.fn(async () => undefined),
    authenticatePassword: vi.fn(async () => undefined),
    _login: vi.fn(async () => undefined),
    getUser: vi.fn(async () => ({ id: "user-1", email: "user@example.test" })),
    logout: vi.fn(async () => undefined),
  };
  const tokenManager = {
    getToken: vi.fn(async () => ({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      scope: "notes",
      t: Date.now(),
    })),
    _refreshToken: vi.fn(async () => undefined),
  };
  const kvStorage = {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };

  class FakeDatabase {
    readonly user = user;
    readonly tokenManager = tokenManager;
    readonly kv = () => kvStorage;

    setup(_options: NotesnookDatabaseSetupOptions): void {
      // Deliberately empty: this probe exercises the factory lifecycle boundary.
    }

    async init(): Promise<void> {
      return undefined;
    }
  }

  return markRealCoreModule({
    Database: FakeDatabase,
  });
}

describe("Stage 2B-live security blocker regressions", () => {
  it("normalizes a hostile provider handle getter to a stable chain-free error", () => {
    const handle = new Proxy(
      {},
      {
        get() {
          throw new Error(`hostile handle getter ${LEAK_CANARY}`);
        },
      },
    ) as NotesnookLiveCoreHandle;

    let caught: unknown;
    try {
      new LiveNotesnookAuthProvider(makeProviderOptions(handle));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toBe("invalid live notesnook handle");
    expect(error.message).not.toContain(LEAK_CANARY);
    expect(error.cause).toBeUndefined();
    expect((error as Error & { __context__?: unknown }).__context__).toBeUndefined();
  });

  it("does not reflect a hostile unknown setup property name in diagnostics", () => {
    const hostileName = `unknown-${LEAK_CANARY}`;
    const setup = {
      ...validSetup(),
      [hostileName]: true,
    };

    let caught: unknown;
    try {
      validateDatabaseSetupOptions(setup);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toBe("invalid Notesnook setup options: unknown option");
    expect(error.message).not.toContain(hostileName);
    expect(error.cause).toBeUndefined();
    expect((error as Error & { __context__?: unknown }).__context__).toBeUndefined();
  });

  it("closes SQLite and removes the lock when the open logger fails", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-logger-failure-"));
    let logger: Logger;
    logger = {
      debug: vi.fn(() => undefined),
      info: vi.fn(() => {
        throw new Error(`hostile logger ${LEAK_CANARY}`);
      }),
      warn: vi.fn(() => undefined),
      error: vi.fn(() => undefined),
      child: vi.fn(() => logger),
      setSink: vi.fn(() => undefined),
    };
    const keys: SecureKeyStore = {
      backend: "none",
      productionSafe: false,
      getDatabaseKey: () => "offline-test-key",
    };

    try {
      expect(() => createPersistentStorage({ stateDir, keys, logger })).toThrow(
        "failed to initialise encrypted SQLite storage",
      );
      expect(isLocked(stateDir)).toBe(false);
      expect(existsSync(lockPath(stateDir))).toBe(false);
    } finally {
      releaseLock(stateDir);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("creates an internal lifecycle and rejects every wrapped operation after cleanup", async () => {
    const onCleanup = vi.fn(() => undefined);
    const handle = await createNotesnookLiveCoreFactory({
      setup: validSetup(),
      onCleanup,
      injectedModule: makeLiveModule(),
    });

    await handle.cleanup();
    await handle.cleanup();
    expect(onCleanup).toHaveBeenCalledTimes(1);

    const operations = [
      handle.user.authenticateEmail("user@example.test"),
      handle.user.authenticateMultiFactorCode("123456", "app"),
      handle.user.authenticatePassword("user@example.test", "password"),
      handle.user.getUser(),
      handle.user.logout(true),
      handle.token.getToken(),
      handle.token._refreshToken(true),
      handle.kv.read("token"),
      handle.kv.write("token", { value: "x" }),
      handle.kv.delete("token"),
    ];

    const results = await Promise.all(
      operations.map(async (operation) => {
        try {
          await operation;
          return undefined;
        } catch (error) {
          return error;
        }
      }),
    );
    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe("live-login runtime is closed");
    }
  });
});
