/**
 * Offline S2 checkpoint probes.
 *
 * This file is deliberately black-box oriented: the auth command, live
 * runner/provider, coordinator, logger, and persistent-storage exports are
 * exercised through the package entry point.  No real account, credential,
 * transport, or network is used.  Every secret-like value is generated at
 * runtime so this file contains no reusable credential material.
 */

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AuthCoordinator,
  LIVE_NOTESNOOK_KV_TOKEN_KEY,
  LiveNotesnookAuthProvider,
  createDevelopmentFileKeyStore,
  createLogger,
  createPersistentStorage,
  ensureStateDir,
  lockPath,
  runAuthCommand,
  type AuthSession,
  type Logger,
  type NotesnookLiveCoreHandle,
  type NotesnookLiveTokenEnvelope,
  type NotesnookLiveUser,
  type SecretPrompt,
} from "../src/index.js";

function runtimeCanary(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

function runtimeEmail(): string {
  return `${runtimeCanary(12)}@example.test`;
}

function runtimePrompt(email: string, password: string): SecretPrompt {
  return {
    writeLine: () => {},
    async readSecretLine({ prompt }) {
      if (prompt === "email") return Buffer.from(email, "utf8");
      if (prompt === "password") return Buffer.from(password, "utf8");
      return null;
    },
  };
}

interface LiveFixture {
  handle: NotesnookLiveCoreHandle;
  envelope: NotesnookLiveTokenEnvelope;
  user: NotesnookLiveUser;
  session: AuthSession;
  tokenGetCalls: { count: number };
  refreshCalls: { count: number };
  kvToken: { value: unknown };
}

function makeLiveFixture(): LiveFixture {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const envelope: NotesnookLiveTokenEnvelope = {
    access_token: runtimeCanary(),
    refresh_token: runtimeCanary(),
    expires_in: 3600,
    scope: "notes",
    t: Math.floor(now / 1000),
  };
  const user: NotesnookLiveUser = { id: runtimeCanary(12), email: runtimeEmail() };
  const tokenGetCalls = { count: 0 };
  const refreshCalls = { count: 0 };
  const kvToken = { value: envelope as unknown };

  const handle: NotesnookLiveCoreHandle = {
    user: {
      authenticateEmail: async () => envelope,
      authenticateMultiFactorCode: async () => undefined,
      authenticatePassword: async () => undefined,
      getUser: async () => user,
      logout: async () => undefined,
    },
    token: {
      getToken: async () => {
        tokenGetCalls.count += 1;
        return kvToken.value as NotesnookLiveTokenEnvelope | undefined;
      },
      _refreshToken: async () => {
        // This fake token manager would issue a fresh token if reached.
        refreshCalls.count += 1;
        kvToken.value = {
          ...envelope,
          access_token: runtimeCanary(),
          refresh_token: runtimeCanary(),
        };
      },
    },
    kv: {
      read: async () => kvToken.value,
      write: async (_key, value) => {
        kvToken.value = value;
      },
      delete: async (key) => {
        if (key === LIVE_NOTESNOOK_KV_TOKEN_KEY) kvToken.value = undefined;
      },
    },
    cleanup: async () => undefined,
    initialized: true,
  };

  const session: AuthSession = Object.freeze({
    userId: user.id,
    accessToken: envelope.access_token,
    issuedAt: now,
    expiresAt: now + envelope.expires_in * 1000,
  });
  return { handle, envelope, user, session, tokenGetCalls, refreshCalls, kvToken };
}

function throwingLogger(canary: string): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {
      throw new Error(canary);
    },
    warn: () => {},
    error: () => {},
    child: () => logger,
    setSink: () => {},
  };
  return logger;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

describe("offline S2 checkpoint — public credential-carrier boundary", () => {
  it("rejects split and equals argv forms plus own, inherited, empty, and undefined env carriers", async () => {
    const forbiddenFlags = [
      "--password",
      "--passwd",
      "--mfa",
      "--totp",
      "--secret",
      "--stdin-secret",
      "--token",
    ] as const;
    const forbiddenEnv = [
      "NOOKBRIDGE_PASSWORD",
      "NOOKBRIDGE_PASSWD",
      "NOOKBRIDGE_MFA",
      "NOOKBRIDGE_TOTP",
      "NOOKBRIDGE_SECRET",
      "NOOKCTL_PASSWORD",
      "NOOKCTL_MFA",
    ] as const;

    for (const flag of forbiddenFlags) {
      for (const argv of [
        ["login", flag, runtimeCanary()],
        ["login", `${flag}=${runtimeCanary()}`],
      ]) {
        const result = await runAuthCommand({ argv, env: {} });
        expect(result).toEqual(expect.objectContaining({ kind: "error", exitCode: 2 }));
        if (result.kind !== "error") throw new Error("expected categorical argv rejection");
        expect(result.message).toBe(
          `refusing to read credentials from CLI flag ${flag}; use an interactive TTY prompt`,
        );
        expect(result.message).not.toMatch(/[a-f0-9]{48}/);
      }
    }

    for (const carrier of forbiddenEnv) {
      for (const value of ["", undefined, runtimeCanary()] as const) {
        const env: Record<string, string | undefined> = { [carrier]: value };
        const result = await runAuthCommand({ argv: ["status"], env });
        expect(result).toEqual(expect.objectContaining({ kind: "error", exitCode: 2 }));
        if (result.kind !== "error") throw new Error("expected categorical env rejection");
        expect(result.message).toBe(
          `refusing to read credentials from environment variable ${carrier}; use an interactive TTY prompt`,
        );
        if (value) expect(result.message).not.toContain(value);
      }

      const inheritedCanary = runtimeCanary();
      const inheritedEnv = Object.create({ [carrier]: inheritedCanary }) as Record<
        string,
        string | undefined
      >;
      const inheritedResult = await runAuthCommand({ argv: ["status"], env: inheritedEnv });
      expect(inheritedResult).toEqual(expect.objectContaining({ kind: "error", exitCode: 2 }));
      if (inheritedResult.kind !== "error") throw new Error("expected inherited env rejection");
      expect(inheritedResult.message).toBe(
        `refusing to read credentials from environment variable ${carrier}; use an interactive TTY prompt`,
      );
      expect(inheritedResult.message).not.toContain(inheritedCanary);
    }
  });
});

describe("offline S2 checkpoint — public live runner isolation", () => {
  it("does not invoke fetch/network and returns only a refresh-token-free session", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error(runtimeCanary());
    });
    vi.stubGlobal("fetch", fetchSpy);

    const fixture = makeLiveFixture();
    const email = runtimeEmail();
    const password = runtimeCanary();
    try {
      const result = await runAuthCommand({
        argv: ["login"],
        env: {},
        prompt: runtimePrompt(email, password),
        exerciseLiveLogin: true,
        liveProviderFactory: () =>
          new LiveNotesnookAuthProvider({
            handle: fixture.handle,
            cleanupHook: async () => undefined,
          }),
      });

      expect(result.kind).toBe("live-login");
      if (result.kind !== "live-login") throw new Error("expected live-login result");
      expect(Object.keys(result.session).sort()).toEqual([
        "accessToken",
        "expiresAt",
        "issuedAt",
        "userId",
      ]);
      expect("refresh_token" in result.session).toBe(false);
      expect(JSON.stringify(result)).not.toContain(password);
      expect(JSON.stringify(result)).not.toContain(email);
      expect(JSON.stringify(result)).not.toContain(fixture.envelope.refresh_token);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});

describe("offline S2 checkpoint — logout invalidation", () => {
  it("rejects direct refresh after logout before a token manager can resurrect kv.token", async () => {
    const fixture = makeLiveFixture();
    const provider = new LiveNotesnookAuthProvider({
      handle: fixture.handle,
      cleanupHook: async () => undefined,
    });
    const loggedIn = await provider.login({
      username: runtimeEmail(),
      password: runtimeCanary(),
    });
    const tokenReadsBeforeLogout = fixture.tokenGetCalls.count;

    await provider.logout(loggedIn);
    expect(fixture.kvToken.value).toBeUndefined();

    await expect(provider.refresh(loggedIn)).rejects.toThrow(
      /refresh unavailable without an active session/,
    );
    expect(fixture.refreshCalls.count).toBe(0);
    expect(fixture.tokenGetCalls.count).toBe(tokenReadsBeforeLogout);
    expect(fixture.kvToken.value).toBeUndefined();
  });
});

describe("offline S2 checkpoint — composed logger boundary", () => {
  it("keeps auth committed when both provider and outer logger failures contain raw text", async () => {
    const loggerCanary = runtimeCanary();
    const fixture = makeLiveFixture();
    const provider = new LiveNotesnookAuthProvider({
      handle: fixture.handle,
      cleanupHook: async () => undefined,
      logger: throwingLogger(loggerCanary),
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => fixture.session.issuedAt,
      logger: throwingLogger(loggerCanary),
    });

    const state = await coordinator.login({
      username: runtimeEmail(),
      password: runtimeCanary(),
    });
    expect(state.status).toBe("authenticated");
    expect(JSON.stringify(state)).not.toContain(loggerCanary);

    await expect(coordinator.logout()).resolves.toBeUndefined();
    expect(coordinator.status()).toEqual({ status: "signed-out" });
  });
});

describe("offline S2 checkpoint — persistent filesystem hygiene", () => {
  it("creates restrictive state/key/db/lock modes and leaves no canary in files or diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "nookbridge-s2-"));
    const dbPath = join(root, "nookbridge.db");
    const keyPath = join(root, "db.key");
    const canaries = [runtimeCanary(), runtimeCanary(), runtimeCanary()];
    const diagnostics: string[] = [];
    let storage: ReturnType<typeof createPersistentStorage> | undefined;

    try {
      ensureStateDir(root);
      const keys = createDevelopmentFileKeyStore({ keyPath, generateIfMissing: true });
      const logger = createLogger({ sink: (line) => diagnostics.push(line) });
      storage = createPersistentStorage({ stateDir: root, dbPath, keys, logger });
      await storage.write(LIVE_NOTESNOOK_KV_TOKEN_KEY, {
        access_token: canaries[0],
        refresh_token: canaries[1],
        opaque: canaries[2],
      });
      logger.info("credential diagnostic", {
        password: canaries[0],
        token: canaries[1],
        secret: canaries[2],
      });

      expect(mode(root)).toBe(0o700);
      expect(mode(keyPath)).toBe(0o600);
      expect(mode(dbPath)).toBe(0o600);
      expect(mode(lockPath(root))).toBe(0o600);
      expect(diagnostics.join("\n")).not.toContain(canaries[0]);
      expect(diagnostics.join("\n")).not.toContain(canaries[1]);
      expect(diagnostics.join("\n")).not.toContain(canaries[2]);

      for (const file of filesUnder(root)) {
        const bytes = readFileSync(file);
        const text = bytes.toString("utf8");
        for (const canary of canaries) expect(text).not.toContain(canary);
      }
    } finally {
      storage?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
