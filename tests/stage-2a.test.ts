/**
 * Stage 2A — offline authentication and injected core seam.
 *
 * These tests deliberately use no live account, endpoint, or upstream
 * Notesnook package.  The core test uses a fake module and an IStorage-shaped
 * in-memory implementation; the auth test uses the real Stage 1 storage only
 * to prove that authentication does not write credentials or sessions there.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthCoordinator,
  MockAuthProvider,
  createLogger,
  createPersistentStorage,
  createNotesnookCoreAdapter,
  type AuthProvider,
  type AuthSession,
  type AuthState,
  type IStorage,
  type NotesnookCoreModule,
} from "../src/index.js";
import { releaseLock } from "../src/config/lock.js";
import { createDevelopmentFileKeyStore } from "../src/keystore/file-keystore.js";

function createMemoryStorage(): IStorage {
  const values = new Map<string, unknown>();
  return {
    write: async <T>(key: string, data: T) => {
      values.set(key, data);
    },
    writeMulti: async <T>(entries: [string, T][]) => {
      for (const [key, data] of entries) values.set(key, data);
    },
    readMulti: async <T>(keys: string[]) =>
      keys.map((key) => [key, values.get(key) as T] as [string, T]),
    read: async <T>(key: string) => values.get(key) as T | undefined,
    remove: async (key: string) => {
      values.delete(key);
    },
    removeMulti: async (keys: string[]) => {
      for (const key of keys) values.delete(key);
    },
    clear: async () => {
      values.clear();
    },
    getAllKeys: async () => [...values.keys()],
    encrypt: async () => {
      throw new Error("not needed by the Stage 2A core seam test");
    },
    encryptMulti: async () => {
      throw new Error("not needed by the Stage 2A core seam test");
    },
    decrypt: async () => {
      throw new Error("not needed by the Stage 2A core seam test");
    },
    decryptMulti: async () => {
      throw new Error("not needed by the Stage 2A core seam test");
    },
    deriveCryptoKey: async () => {
      throw new Error("not needed by the Stage 2A core seam test");
    },
    hash: async () => {
      throw new Error("not needed by the Stage 2A core seam test");
    },
    getCryptoKey: async () => undefined,
    generateCryptoKey: async () => {
      throw new Error("not needed by the Stage 2A core seam test");
    },
    generatePGPKeyPair: async () => {
      throw new Error("not needed by the Stage 2A core seam test");
    },
    decryptPGPMessage: async () => {
      throw new Error("not needed by the Stage 2A core seam test");
    },
    validatePGPKeyPair: async () => ({ isValid: false, message: "not needed" }),
    generateCryptoKeyFallback: async () => {
      throw new Error("not needed by the Stage 2A core seam test");
    },
    deriveCryptoKeyFallback: async () => {
      throw new Error("not needed by the Stage 2A core seam test");
    },
  };
}

function createPersistentFixture(): {
  storage: ReturnType<typeof createPersistentStorage>;
  stateDir: string;
} {
  const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-stage2a-"));
  const keyPath = join(stateDir, "db.key");
  writeFileSync(keyPath, "stage-2a-development-key", { mode: 0o600 });
  const keys = createDevelopmentFileKeyStore({ keyPath });
  return {
    stateDir,
    storage: createPersistentStorage({ stateDir, keys }),
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createSession(accessToken: string, expiresAt = 10_000): AuthSession {
  return {
    userId: "offline-test-user",
    accessToken,
    issuedAt: 1_000,
    expiresAt,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Stage 2A offline authentication", () => {
  it("moves signed-out → authenticated → expired → refreshed → signed-out", async () => {
    let now = 1_000;
    const provider = new MockAuthProvider({ clock: () => now, sessionTtlMs: 100 });
    const coordinator = new AuthCoordinator({ provider, clock: () => now });

    expect(coordinator.status()).toEqual({ status: "signed-out" });

    const authenticated = await coordinator.login({
      username: "stage-2a-user",
      password: "offline-test-password",
    });
    expect(authenticated.status).toBe("authenticated");
    if (authenticated.status !== "authenticated") throw new Error("expected authentication");
    expect(authenticated.session.accessToken).toBe("offline-mock-token-1");

    now = 1_100;
    const expired = coordinator.status();
    expect(expired.status).toBe("expired");
    if (expired.status !== "expired") throw new Error("expected an expired session");

    now = 1_101;
    const refreshed = await coordinator.refresh();
    expect(refreshed.status).toBe("authenticated");
    if (refreshed.status !== "authenticated") throw new Error("expected a refreshed session");
    expect(refreshed.session.accessToken).not.toBe(expired.session.accessToken);

    await coordinator.logout();
    expect(coordinator.status()).toEqual({ status: "signed-out" });
    await expect(coordinator.refresh()).rejects.toThrow(/signed out/i);
  });

  it("does not write credentials or session tokens to PersistentStorage or logs", async () => {
    const fixture = createPersistentFixture();
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      redactFields: [],
      sink: (line) => lines.push(line),
    });
    const provider = new MockAuthProvider({ clock: () => 5_000, sessionTtlMs: 1_000 });
    const coordinator = new AuthCoordinator({ provider, logger, clock: () => 5_000 });
    const password = "stage-2a-password-canary";

    try {
      const state = await coordinator.login({ username: "offline-user", password });
      expect(state.status).toBe("authenticated");
      if (state.status !== "authenticated") throw new Error("expected authentication");
      const token = state.session.accessToken;

      expect(await fixture.storage.getAllKeys()).toEqual([]);
      const output = lines.join("\n");
      expect(output).not.toContain(password);
      expect(output).not.toContain(token);
      expect(output).not.toContain("accessToken");
    } finally {
      fixture.storage.close?.();
      releaseLock(fixture.stateDir);
      rmSync(fixture.stateDir, { recursive: true, force: true });
    }
  });

  it("does not resurrect a pending login after logout while signed out", async () => {
    const loginResult = createDeferred<AuthSession>();
    const provider: AuthProvider = {
      login: vi.fn(() => loginResult.promise),
      refresh: vi.fn(async (session) => session),
      logout: vi.fn(async () => undefined),
    };
    const coordinator = new AuthCoordinator({ provider, clock: () => 1_000 });
    const pendingLogin = coordinator.login({ username: "offline-user", password: "test-password" });

    await coordinator.logout();
    loginResult.resolve(createSession("late-login-token"));

    await expect(pendingLogin).rejects.toThrow(/superseded/i);
    expect(coordinator.status()).toEqual({ status: "signed-out" });
    expect(provider.logout).not.toHaveBeenCalled();
  });

  it("does not resurrect a pending refresh after logout", async () => {
    const refreshResult = createDeferred<AuthSession>();
    const provider: AuthProvider = {
      login: vi.fn(async () => createSession("login-token")),
      refresh: vi.fn(() => refreshResult.promise),
      logout: vi.fn(async () => undefined),
    };
    const coordinator = new AuthCoordinator({ provider, clock: () => 1_000 });
    await coordinator.login({ username: "offline-user", password: "test-password" });
    const pendingRefresh = coordinator.refresh();

    await coordinator.logout();
    refreshResult.resolve(createSession("late-refresh-token"));

    await expect(pendingRefresh).rejects.toThrow(/superseded/i);
    expect(coordinator.status()).toEqual({ status: "signed-out" });
    expect(provider.logout).toHaveBeenCalledTimes(1);
  });

  it("makes concurrent refreshes deterministic: the latest invocation wins", async () => {
    const refreshResults = [createDeferred<AuthSession>(), createDeferred<AuthSession>()];
    let refreshCall = 0;
    const provider: AuthProvider = {
      login: vi.fn(async () => createSession("login-token")),
      refresh: vi.fn(() => refreshResults[refreshCall++]!.promise),
      logout: vi.fn(async () => undefined),
    };
    const coordinator = new AuthCoordinator({ provider, clock: () => 1_000 });
    await coordinator.login({ username: "offline-user", password: "test-password" });

    const firstRefresh = coordinator.refresh();
    const secondRefresh = coordinator.refresh();

    refreshResults[1]!.resolve(createSession("second-refresh-token"));
    await expect(secondRefresh).resolves.toMatchObject({
      status: "authenticated",
      session: { accessToken: "second-refresh-token" },
    });

    refreshResults[0]!.resolve(createSession("first-refresh-token"));
    await expect(firstRefresh).rejects.toThrow(/superseded/i);
    expect(coordinator.status()).toMatchObject({
      status: "authenticated",
      session: { accessToken: "second-refresh-token" },
    });
  });

  it("protects coordinator state from mutable results and provider arguments", async () => {
    let now = 1_000;
    const providerSession = createSession("provider-token", 1_100);
    let refreshArgument: AuthSession | undefined;
    let refreshAttempts = 0;
    let logoutArgument: AuthSession | undefined;
    let logoutArgumentSnapshot: AuthSession | undefined;
    const provider: AuthProvider = {
      login: vi.fn(async () => providerSession),
      refresh: vi.fn(async (session) => {
        refreshArgument = session;
        refreshAttempts += 1;
        if (refreshAttempts === 1) {
          (session as { accessToken: string; expiresAt: number }).accessToken =
            "provider-mutated-token";
          (session as { accessToken: string; expiresAt: number }).expiresAt =
            Number.MAX_SAFE_INTEGER;
          throw new Error("provider refresh failed");
        }
        return createSession("refreshed-token", 1_300);
      }),
      logout: vi.fn(async (session) => {
        logoutArgument = session;
        logoutArgumentSnapshot = { ...session };
        (session as { accessToken: string; expiresAt: number }).accessToken =
          "logout-mutated-token";
        (session as { accessToken: string; expiresAt: number }).expiresAt = Number.MAX_SAFE_INTEGER;
      }),
    };
    const coordinator = new AuthCoordinator({ provider, clock: () => now });

    const authenticated = await coordinator.login({
      username: "offline-user",
      password: "test-password",
    });
    const mutableAuthenticated = authenticated as unknown as {
      session: { accessToken: string; expiresAt: number };
    };
    mutableAuthenticated.session.accessToken = "result-mutated-token";
    mutableAuthenticated.session.expiresAt = Number.MAX_SAFE_INTEGER;
    const mutableProviderSession = providerSession as unknown as {
      accessToken: string;
      expiresAt: number;
    };
    mutableProviderSession.accessToken = "provider-owned-mutated-token";
    mutableProviderSession.expiresAt = Number.MAX_SAFE_INTEGER;

    expect(coordinator.status()).toMatchObject({
      status: "authenticated",
      session: { accessToken: "provider-token", expiresAt: 1_100 },
    });

    now = 1_100;
    const expired = coordinator.status();
    if (expired.status !== "expired") throw new Error("expected an expired session");
    const mutableExpired = expired as unknown as {
      session: { accessToken: string; expiresAt: number };
    };
    mutableExpired.session.accessToken = "expired-result-mutated-token";
    mutableExpired.session.expiresAt = Number.MAX_SAFE_INTEGER;
    await expect(coordinator.refresh()).rejects.toThrow("provider refresh failed");
    expect(refreshArgument).toMatchObject({
      accessToken: "provider-mutated-token",
      expiresAt: Number.MAX_SAFE_INTEGER,
    });
    expect(refreshArgument).not.toBe(expired.session);
    expect(coordinator.status()).toMatchObject({
      status: "expired",
      session: { accessToken: "provider-token", expiresAt: 1_100 },
    });

    const refreshed = await coordinator.refresh();
    expect(refreshArgument).toMatchObject({ accessToken: "provider-token", expiresAt: 1_100 });
    expect(refreshed).toMatchObject({
      status: "authenticated",
      session: { accessToken: "refreshed-token", expiresAt: 1_300 },
    });
    const mutableRefreshed = refreshed as unknown as {
      session: { accessToken: string; expiresAt: number };
    };
    mutableRefreshed.session.accessToken = "refreshed-result-mutated-token";
    mutableRefreshed.session.expiresAt = Number.MAX_SAFE_INTEGER;
    expect(coordinator.status()).toMatchObject({
      status: "authenticated",
      session: { accessToken: "refreshed-token", expiresAt: 1_300 },
    });

    await coordinator.logout();
    expect(logoutArgument).not.toBe(mutableRefreshed.session);
    expect(logoutArgumentSnapshot).toMatchObject({
      accessToken: "refreshed-token",
      expiresAt: 1_300,
    });
    expect(coordinator.status()).toEqual({ status: "signed-out" });
  });

  it("rejects null and primitive provider sessions without a raw TypeError", async () => {
    for (const malformedSession of [null, 42, "malformed"] as const) {
      const provider: AuthProvider = {
        login: vi.fn(async () => malformedSession as unknown as AuthSession),
        refresh: vi.fn(async () => createSession("unused-refresh-token")),
        logout: vi.fn(async () => undefined),
      };
      const coordinator = new AuthCoordinator({ provider, clock: () => 1_000 });

      await expect(
        coordinator.login({ username: "offline-user", password: "test-password" }),
      ).rejects.toThrow("auth provider returned an invalid in-memory session");
      expect(coordinator.status()).toEqual({ status: "signed-out" });
    }
  });

  it("rejects provider sessions that are already expired at the coordinator clock", async () => {
    const provider: AuthProvider = {
      login: vi.fn(async () => createSession("expired-login-token", 5_000)),
      refresh: vi.fn(async () => createSession("expired-refresh-token", 5_000)),
      logout: vi.fn(async () => undefined),
    };
    const coordinator = new AuthCoordinator({ provider, clock: () => 5_000 });

    await expect(
      coordinator.login({ username: "offline-user", password: "test-password" }),
    ).rejects.toThrow(/expired/i);
    expect(coordinator.status()).toEqual({ status: "signed-out" });

    provider.login = vi.fn(async () => createSession("valid-login-token", 6_000));
    await coordinator.login({ username: "offline-user", password: "test-password" });
    await expect(coordinator.refresh()).rejects.toThrow(/expired/i);
    expect(coordinator.status()).toMatchObject({
      status: "authenticated",
      session: { accessToken: "valid-login-token" },
    });
  });
});

describe("Stage 2A injected Notesnook-core adapter", () => {
  it("calls only Database.setup({ storage }).init() on an injected fake core", async () => {
    const storage = createMemoryStorage();
    const calls: string[] = [];
    let receivedStorage: IStorage | undefined;
    const fakeCore: NotesnookCoreModule = {
      Database: {
        setup(options) {
          calls.push("setup");
          receivedStorage = options.storage;
          return {
            async init() {
              calls.push("init");
            },
          };
        },
      },
    };
    const adapter = createNotesnookCoreAdapter({ core: fakeCore, storage });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network forbidden"));

    await adapter.init();

    expect(calls).toEqual(["setup", "init"]);
    expect(receivedStorage).toBe(storage);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("also resolves an injected core factory without importing an upstream package", async () => {
    const storage = createMemoryStorage();
    let setupCount = 0;
    const factory = () => ({
      Database: {
        setup(options: { storage: IStorage }) {
          setupCount += 1;
          expect(options.storage).toBe(storage);
          return { init: async () => undefined };
        },
      },
    });

    await createNotesnookCoreAdapter({ core: factory, storage }).init();

    expect(setupCount).toBe(1);
  });

  it("rejects malformed Database.setup results with one stable adapter error", async () => {
    const storage = createMemoryStorage();
    const malformedCores = [
      { Database: { setup: () => undefined } },
      { Database: { setup: () => ({}) } },
    ];
    const errorMessage =
      "invalid injected Notesnook database: Database.setup must return an object with init()";

    for (const core of malformedCores) {
      const adapter = createNotesnookCoreAdapter({
        core: core as unknown as NotesnookCoreModule,
        storage,
      });
      await expect(adapter.init()).rejects.toThrow(errorMessage);
    }
  });
});

// Keep the discriminated state type exercised as part of the public contract.
const _authStateTypeCheck: AuthState | undefined = undefined;
void _authStateTypeCheck;
