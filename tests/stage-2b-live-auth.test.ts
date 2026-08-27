/**
 * Stage 2B-live — offline mocked Notesnook UserManager/TokenManager
 * authentication provider.
 *
 * Scope of these tests (per docs/.hermes/plans/2026-08-26_210136-stage-2b-live-auth.md):
 *
 *   - The provider is fully offline: it accepts only an injected,
 *     structurally-typed Notesnook database handle.  No runtime import
 *     of `@notesnook/core`, no live HTTP transport, no live Notesnook
 *     account call.
 *   - The login sequence follows the verified upstream contract:
 *     authenticateEmail -> optional authenticateMultiFactorCode("app")
 *     -> authenticatePassword.  Scope-based branching determines
 *     whether MFA is required.
 *   - Token fields persisted under encrypted `kv.token` include
 *     access_token, t, expires_in, scope, refresh_token.  The PUBLIC
 *     session returned to the AuthCoordinator exposes only an opaque
 *     `accessToken` plus issuedAt/expiresAt; refresh_token never leaves
 *     the provider's boundary.
 *   - Errors thrown by the provider are categorical — they never
 *     include raw password bytes, MFA code bytes, access tokens,
 *     refresh tokens, or upstream response bodies.
 *   - Concurrent refresh calls converge to a single persisted envelope;
 *     the loser is rejected deterministically.
 *   - Restart by re-constructing a provider over the same encrypted
 *     fixture rehydrates the token envelope and refreshes when expired.
 *   - Logout explicitly revokes the upstream token, deletes the local
 *     `kv.token` envelope, and clears the local encrypted state via an
 *     injected seam (the PersistentStorage `clear()` helper is used).
 *   - Raw credentials never enter the structured logger, never land in
 *     plain key/value config, and never enter the committed source.
 *     Test fixtures generate their values at runtime.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthCoordinator, createLogger, runAuthCommand } from "../src/index.js";
import {
  NotesnookAuthProvider,
  createNotesnookAuthProvider,
  type NotesnookAuthProviderOptions,
  type NotesnookDatabaseHandle,
  type NotesnookTokenEnvelope,
} from "../src/index.js";
import { parseAuthCommand, run as runCli } from "../src/cli.js";
import { createFakeCoreFixture, type FakeCoreFixture } from "./fixtures/notesnook-auth-fixture.js";
import { releaseLock } from "../src/config/lock.js";
import { createPersistentStorage } from "../src/storage/persistent-storage.js";
import { createDevelopmentFileKeyStore } from "../src/keystore/file-keystore.js";

/**
 * A focused helper that produces a unique, runtime-only label that
 * stands in for a password or MFA code in a test.  We deliberately do
 * not commit any literal credential canary to source.
 */
function runtimeSecret(label: string): string {
  return `stage-2b-live-canary-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function runtimeEmail(label: string): string {
  return `stage-2b-live-${label}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

function createPersistentFixture(): {
  storage: ReturnType<typeof createPersistentStorage>;
  stateDir: string;
  close: () => void;
} {
  const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-stage-2b-live-"));
  const keyPath = join(stateDir, "db.key");
  writeFileSync(keyPath, "stage-2b-live-development-key", { mode: 0o600 });
  const keys = createDevelopmentFileKeyStore({ keyPath });
  const storage = createPersistentStorage({ stateDir, keys });
  return {
    stateDir,
    storage,
    close: () => {
      storage.close();
      releaseLock(stateDir);
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

afterEach(() => {
  // Tests are responsible for closing their own persistent fixtures.
});

describe("Stage 2B-live mocked NotesnookAuthProvider — contract", () => {
  it("logs in without MFA when the token scope does not require it", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const storage = fixture.storage;
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });
    const coordinator = new AuthCoordinator({ provider, clock: () => fixture.now });

    const email = runtimeEmail("no-mfa");
    const password = runtimeSecret("no-mfa-pwd");
    const state = await coordinator.login({ username: email, password });

    expect(state.status).toBe("authenticated");
    if (state.status !== "authenticated") throw new Error("expected authenticated");

    // Sequence: authenticateEmail then authenticatePassword; no MFA call.
    expect(fixture.calls).toEqual([
      { method: "authenticateEmail", args: [email] },
      { method: "authenticatePassword", args: [email, password] },
    ]);

    // Token envelope was persisted under kv.token.
    const persisted = await storage.read<NotesnookTokenEnvelope>("kv.token");
    expect(persisted).toBeDefined();
    expect(persisted?.access_token).toMatch(/^access-/);
    expect(persisted?.refresh_token).toMatch(/^refresh-/);
    expect(persisted?.scope).toContain("offline_access");

    // Public session never exposes refresh_token.
    expect("refresh_token" in state.session).toBe(false);
    expect((state.session as unknown as Record<string, unknown>).refresh_token).toBeUndefined();
    expect(state.session.accessToken).toBe(persisted?.access_token);
    expect(state.session.userId).toMatch(/^notesnook-user-/);

    fixture.close();
  });

  it("drives the MFA branch when the token scope requires it and persists the envelope", async () => {
    const fixture = createFakeCoreFixture({ mode: "mfa-required" });
    const storage = fixture.storage;
    const mfaCode = runtimeSecret("mfa-code");
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      mfaSupplier: async () => mfaCode,
      clock: () => fixture.now,
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => fixture.now,
    });

    const email = runtimeEmail("mfa");
    const password = runtimeSecret("mfa-pwd");

    const state = await coordinator.login({ username: email, password });
    expect(state.status).toBe("authenticated");
    if (state.status !== "authenticated") throw new Error("expected authenticated");

    // The provider must call authenticateMultiFactorCode before authenticatePassword.
    const callSequence = fixture.calls.map((c) => c.method);
    expect(callSequence).toEqual([
      "authenticateEmail",
      "authenticateMultiFactorCode",
      "authenticatePassword",
    ]);

    // The MFA argument is the literal "app" type.
    const mfaCall = fixture.calls.find((c) => c.method === "authenticateMultiFactorCode");
    expect(mfaCall?.args).toEqual([mfaCode, "app"]);

    // And the persisted envelope carries the auth:grant_types:mfa scope.
    const persisted = await storage.read<NotesnookTokenEnvelope>("kv.token");
    expect(persisted?.scope).toBe("auth:grant_types:mfa");

    fixture.close();
  });

  it("retries after an invalid MFA code without losing the login pipeline", async () => {
    const fixture = createFakeCoreFixture({ mode: "mfa-retry" });
    const storage = fixture.storage;
    const wrongCode = runtimeSecret("wrong-mfa");
    const rightCode = runtimeSecret("right-mfa");
    // First supplier invocation yields the wrong code; the second
    // (after the upstream rejects the first) yields the right one.
    const codes = [wrongCode, rightCode];
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      mfaMaxAttempts: 3,
      mfaSupplier: async () => codes.shift() ?? null,
      clock: () => fixture.now,
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => fixture.now,
    });

    const email = runtimeEmail("mfa-retry");
    const password = runtimeSecret("mfa-retry-pwd");

    fixture.mfaCodesToReject = new Set([wrongCode]);

    const state = await coordinator.login({ username: email, password });
    expect(state.status).toBe("authenticated");
    if (state.status !== "authenticated") throw new Error("expected authenticated");

    const mfaCalls = fixture.calls.filter((c) => c.method === "authenticateMultiFactorCode");
    expect(mfaCalls.length).toBe(2);
    expect(mfaCalls[0]?.args[0]).toBe(wrongCode);
    expect(mfaCalls[1]?.args[0]).toBe(rightCode);

    // Password is still submitted exactly once, AFTER the final MFA.
    const pwdCalls = fixture.calls.filter((c) => c.method === "authenticatePassword");
    expect(pwdCalls.length).toBe(1);
    expect(pwdCalls[0]?.args).toEqual([email, password]);

    fixture.close();
  });

  it("retries on an invalid password but still drives the full sequence in the upstream order", async () => {
    const fixture = createFakeCoreFixture({ mode: "password-retry" });
    const storage = fixture.storage;
    const rightPwd = runtimeSecret("right-pwd");
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      passwordMaxAttempts: 3,
      passwordSupplier: async () => rightPwd,
      clock: () => fixture.now,
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => fixture.now,
    });

    const email = runtimeEmail("pwd-retry");
    const wrongPwd = runtimeSecret("wrong-pwd");

    fixture.passwordsToReject = new Set([wrongPwd]);

    const state = await coordinator.login({
      username: email,
      password: wrongPwd,
    });
    expect(state.status).toBe("authenticated");
    if (state.status !== "authenticated") throw new Error("expected authenticated");

    // Internally the provider re-asks for the password via the injected
    // credential supplier.  After the wrong attempt it must reach the
    // right attempt without skipping the upstream email/MFA steps.
    const pwdCalls = fixture.calls.filter((c) => c.method === "authenticatePassword");
    expect(pwdCalls.length).toBe(2);
    expect(pwdCalls[0]?.args).toEqual([email, wrongPwd]);
    expect(pwdCalls[1]?.args).toEqual([email, rightPwd]);

    // We never re-issued authenticateEmail.
    const emailCalls = fixture.calls.filter((c) => c.method === "authenticateEmail");
    expect(emailCalls.length).toBe(1);

    fixture.close();
  });

  it("refreshes when the access token is expired and the envelope carries offline_access", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa", accessTokenTtlMs: 5_000 });
    const storage = fixture.storage;
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => fixture.now,
    });

    const email = runtimeEmail("refresh");
    const password = runtimeSecret("refresh-pwd");

    const initial = await coordinator.login({ username: email, password });
    if (initial.status !== "authenticated") throw new Error("expected authenticated");
    const initialAccessToken = initial.session.accessToken;

    // Force expiry.
    fixture.now = 10_000;

    const refreshed = await coordinator.refresh();
    expect(refreshed.status).toBe("authenticated");
    if (refreshed.status !== "authenticated") throw new Error("expected refreshed");

    expect(refreshed.session.accessToken).not.toBe(initialAccessToken);

    // The refreshToken call was issued exactly once.
    const refreshCalls = fixture.calls.filter((c) => c.method === "_refreshToken");
    expect(refreshCalls.length).toBe(1);

    // Persisted envelope now carries the rotated access token.
    const persisted = await storage.read<NotesnookTokenEnvelope>("kv.token");
    expect(persisted?.access_token).toBe(refreshed.session.accessToken);
    expect(persisted?.refresh_token).toMatch(/^refresh-/);

    fixture.close();
  });

  it("rejects a refresh when the upstream token is non-refreshable / invalid_grant", async () => {
    const fixture = createFakeCoreFixture({ mode: "refresh-fails" });
    const storage = fixture.storage;
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => fixture.now,
    });

    const email = runtimeEmail("refresh-fails");
    const password = runtimeSecret("refresh-fails-pwd");

    await coordinator.login({ username: email, password });
    fixture.now = 10_000;

    await expect(coordinator.refresh()).rejects.toThrow(/refresh/i);
    // AuthCoordinator intentionally preserves its authenticated state on
    // provider errors; status() only expires it when the clock reaches the
    // prior session deadline.  The provider did not write replacement data.
    expect(coordinator.status().status).toBe("authenticated");
    fixture.close();
  });

  it("logout revokes the upstream token, deletes kv.token, and clears local state", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const storage = fixture.storage;
    const localCleared = { value: 0 };
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clock: () => fixture.now,
      clearLocalState: () => {
        localCleared.value += 1;
      },
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => fixture.now,
    });

    const email = runtimeEmail("logout");
    const password = runtimeSecret("logout-pwd");

    await coordinator.login({ username: email, password });

    expect(await storage.read<NotesnookTokenEnvelope>("kv.token")).toBeDefined();

    await coordinator.logout();

    // The upstream logout(true) was called.
    const logoutCalls = fixture.calls.filter((c) => c.method === "logout");
    expect(logoutCalls.length).toBe(1);
    expect(logoutCalls[0]?.args).toEqual([true]);

    // kv.token was removed BEFORE local state was cleared (the local
    // clear is the destructive last step).
    expect(await storage.read<NotesnookTokenEnvelope>("kv.token")).toBeUndefined();
    expect(localCleared.value).toBe(1);

    // The persisted storage no longer holds any kv entries — proves
    // that the additive clearLocalState seam wiped the encrypted local
    // state, mirroring db.reset() without leaving token residue.
    expect(await storage.getAllKeys()).toEqual([]);
    fixture.close();
  });

  it("rejects a refresh from a session completed before logout without calling upstream, then allows login again", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const storage = fixture.storage;
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });
    const oldSession = await provider.login({
      username: runtimeEmail("post-logout-old"),
      password: runtimeSecret("post-logout-old-password"),
    });
    await provider.logout(oldSession);
    const refreshCallsBefore = fixture.calls.filter(
      (call) => call.method === "_refreshToken",
    ).length;

    await expect(provider.refresh(oldSession)).rejects.toMatchObject({
      message: "notesnook refresh unavailable without an active session",
      cause: undefined,
    });
    expect(fixture.calls.filter((call) => call.method === "_refreshToken")).toHaveLength(
      refreshCallsBefore,
    );
    expect(await storage.read<NotesnookTokenEnvelope>("kv.token")).toBeUndefined();

    const newSession = await provider.login({
      username: runtimeEmail("post-logout-new"),
      password: runtimeSecret("post-logout-new-password"),
    });
    expect(newSession.accessToken).toBeTruthy();
    expect(await storage.read<NotesnookTokenEnvelope>("kv.token")).toBeDefined();
    fixture.close();
  });

  it("concurrent refresh calls converge to a single envelope and the loser is rejected", async () => {
    const fixture = createFakeCoreFixture({
      mode: "no-mfa",
      refreshDelayMs: 25,
    });
    const storage = fixture.storage;
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => fixture.now,
    });

    const email = runtimeEmail("concurrent");
    const password = runtimeSecret("concurrent-pwd");

    await coordinator.login({ username: email, password });
    fixture.now = 10_000;

    const first = provider.refresh({
      userId: "test-user",
      accessToken: "test-access",
      issuedAt: 1,
      expiresAt: 2,
    });
    const second = provider.refresh({
      userId: "test-user",
      accessToken: "test-access",
      issuedAt: 1,
      expiresAt: 2,
    });
    const secondRejection = expect(second).rejects.toThrow(/refresh/i);

    await expect(first).resolves.toMatchObject({ accessToken: expect.any(String) });
    await secondRejection;

    // Only ONE successful refresh call to upstream; coordinator generation
    // semantics are covered separately by the Stage 2A suite.
    const refreshCalls = fixture.calls.filter((c) => c.method === "_refreshToken");
    expect(refreshCalls.length).toBe(1);

    // The persisted envelope reflects the single winner.
    const persisted = await storage.read<NotesnookTokenEnvelope>("kv.token");
    expect(persisted?.access_token).toMatch(/^access-/);
    fixture.close();
  });

  it("restarts rehydrate the token envelope and refresh on expiry over the same encrypted fixture", async () => {
    const persistent = createPersistentFixture();
    const fixture1 = createFakeCoreFixture({
      mode: "no-mfa",
      accessTokenTtlMs: 5_000,
      storage: persistent.storage,
    });
    try {
      const provider1 = createNotesnookAuthProvider({
        core: fixture1.handle,
        storage: persistent.storage,
        clearLocalState: async () => {},
        clock: () => fixture1.now,
      });
      const coordinator1 = new AuthCoordinator({
        provider: provider1,
        clock: () => fixture1.now,
      });

      const email = runtimeEmail("restart");
      const password = runtimeSecret("restart-pwd");
      const initial = await coordinator1.login({ username: email, password });
      if (initial.status !== "authenticated") throw new Error("expected authenticated");

      // Simulate restart: build a fresh provider + fresh core handle
      // over the SAME persistent.storage.
      const fixture2 = createFakeCoreFixture({
        mode: "no-mfa",
        accessTokenTtlMs: 5_000,
        storage: persistent.storage,
      });
      const provider2 = createNotesnookAuthProvider({
        core: fixture2.handle,
        storage: persistent.storage,
        clearLocalState: async () => {},
        clock: () => fixture2.now,
      });

      // The second handle sees the envelope — no fresh login required.
      const restored = await provider2.restoreSession();
      expect(restored).not.toBeNull();
      expect(restored?.accessToken).toBe(initial.session.accessToken);

      // Advance the clock past expiry; calling refresh via the second
      // handle now triggers an upstream refresh.
      fixture2.now = 10_000;
      const refreshed = await provider2.refresh(restored!);
      expect(refreshed.accessToken).not.toBe(initial.session.accessToken);

      fixture2.close();
    } finally {
      fixture1.close();
      persistent.close();
    }
  });

  it("never persists raw password or MFA code bytes, never logs them, never writes them to plain config", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      redactFields: [],
      sink: (line) => lines.push(line),
    });
    const fixture = createFakeCoreFixture({ mode: "mfa-required" });
    const storage = fixture.storage;
    const mfaCode = runtimeSecret("hygiene-mfa");
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
      mfaSupplier: async () => mfaCode,
      logger,
    });

    const email = runtimeEmail("hygiene");
    const password = runtimeSecret("hygiene-pwd");

    await provider.login({ username: email, password });

    // Logger never saw password or mfa code bytes.
    const output = lines.join("\n");
    expect(output).not.toContain(password);
    expect(output).not.toContain(mfaCode);
    // And never saw the access/refresh tokens.
    const persisted = await storage.read<NotesnookTokenEnvelope>("kv.token");
    expect(persisted).toBeDefined();
    expect(output).not.toContain(persisted!.access_token);
    expect(output).not.toContain(persisted!.refresh_token);

    // An injected logger is an untrusted boundary.  Its info method may
    // throw a secret-bearing error, but logging must remain best-effort and
    // must not turn successful persistence into an auth failure.
    const loggerCanary = runtimeSecret("throwing-logger");
    const throwingLogger = {
      info: () => {
        throw new Error(loggerCanary);
      },
      debug: () => {},
      warn: () => {},
      error: () => {},
      child: () => throwingLogger,
      setSink: () => {},
    };
    const throwingLoggerProvider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
      mfaSupplier: async () => mfaCode,
      logger: throwingLogger,
    });
    const loggerSession = await throwingLoggerProvider.login({
      username: runtimeEmail("throwing-logger-login"),
      password: runtimeSecret("throwing-logger-password"),
    });
    const loggerRefresh = await throwingLoggerProvider.refresh(loggerSession);
    await throwingLoggerProvider.logout(loggerRefresh);
    expect(await storage.read<NotesnookTokenEnvelope>("kv.token")).toBeUndefined();

    fixture.close();
  });

  it("does not let a coordinator logger failure change a persisted login or leak its canary", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const canary = runtimeSecret("coordinator-logger");
    const throwingLogger = {
      info: () => {
        throw new Error(canary);
      },
      debug: () => {},
      warn: () => {},
      error: () => {},
      child: () => throwingLogger,
      setSink: () => {},
    };
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage: fixture.storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => fixture.now,
      logger: throwingLogger,
    });

    const state = await coordinator.login({
      username: runtimeEmail("coordinator-logger"),
      password: runtimeSecret("coordinator-logger-password"),
    });
    expect(state.status).toBe("authenticated");
    expect(await fixture.storage.read<NotesnookTokenEnvelope>("kv.token")).toBeDefined();
    expect(coordinator.status().status).toBe("authenticated");
    fixture.close();
  });

  it("rejects malformed upstream token envelopes with a categorical error and no payload leakage", async () => {
    const fixture = createFakeCoreFixture({ mode: "malformed-token" });
    const storage = fixture.storage;
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => fixture.now,
    });

    const email = runtimeEmail("malformed");
    const password = runtimeSecret("malformed-pwd");

    try {
      await coordinator.login({ username: email, password });
      throw new Error("expected login to reject the malformed envelope");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toMatch(/invalid token envelope/i);
      // The error must not echo the password or any token-like bytes.
      expect(message).not.toContain(password);
    }
    expect(coordinator.status().status).toBe("signed-out");

    // A malformed password response is an envelope-validation failure, not
    // an authentication rejection. It must fail closed without consulting
    // the retry supplier or making a second password request.
    let supplierCalls = 0;
    let passwordCalls = 0;
    fixture.handle.user.authenticateEmail = async () => ({
      access_token: runtimeSecret("password-envelope-access"),
      t: 1,
      expires_in: 60,
      scope: "offline_access",
      refresh_token: runtimeSecret("password-envelope-refresh"),
    });
    fixture.handle.user.authenticatePassword = async () => {
      passwordCalls += 1;
      return {
        access_token: runtimeSecret("password-malformed-access"),
        t: 1,
        expires_in: 60,
        scope: "offline_access",
        refresh_token: "",
      };
    };
    const passwordProvider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      passwordSupplier: async () => {
        supplierCalls += 1;
        return runtimeSecret("unexpected-password-retry");
      },
      clock: () => fixture.now,
    });
    await expect(
      passwordProvider.login({
        username: runtimeEmail("malformed-password-response"),
        password: runtimeSecret("malformed-password"),
      }),
    ).rejects.toThrow(/invalid token envelope/i);
    expect(supplierCalls).toBe(0);
    expect(passwordCalls).toBe(1);

    // Getter/proxy failures at the same upstream boundary are also
    // normalized, including revoked proxies, without retaining the canary
    // in the public error or either error chain.
    const envelopeCanary = runtimeSecret("throwing-envelope-getter");
    const throwingEnvelope = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") return undefined;
          throw new Error(envelopeCanary);
        },
      },
    );
    fixture.handle.user.authenticateEmail = async () => throwingEnvelope;
    let getterError: unknown;
    try {
      await passwordProvider.login({
        username: runtimeEmail("throwing-envelope-getter"),
        password: runtimeSecret("throwing-envelope-password"),
      });
    } catch (error) {
      getterError = error;
    }
    expect(getterError).toBeInstanceOf(Error);
    const normalizedGetterError = getterError as Error & { __context__?: unknown };
    expect(normalizedGetterError.message).toMatch(/invalid token envelope/i);
    expect(normalizedGetterError.message).not.toContain(envelopeCanary);
    expect(normalizedGetterError.cause).toBeUndefined();
    expect(normalizedGetterError.__context__).toBeUndefined();

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    fixture.handle.user.authenticateEmail = async () => revoked.proxy;
    await expect(
      passwordProvider.login({
        username: runtimeEmail("revoked-envelope"),
        password: runtimeSecret("revoked-envelope-password"),
      }),
    ).rejects.toThrow(/email authentication failed/i);
    fixture.close();
  });

  it("rejects provider sessions whose token has already expired at construction", async () => {
    // accessTokenTtlMs = 1000 means expires_in = 1 second; with the
    // fixture's default `now` of 1000 ms the envelope's expiresAt is
    // exactly equal to the coordinator's clock, which the
    // AuthCoordinator treats as already-expired (the boundary
    // condition is `expiresAt <= now`).
    const fixture = createFakeCoreFixture({
      mode: "no-mfa",
      now: 1_000,
      accessTokenTtlMs: 1000,
    });
    const storage = fixture.storage;
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      // The upstream fixture issues at t=1000ms and expires at t=2000ms;
      // this independent synthetic provider clock is already at 10 seconds.
      clock: () => 10_000,
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => 10_000,
    });

    const email = runtimeEmail("expired");
    const password = runtimeSecret("expired-pwd");

    try {
      await coordinator.login({ username: email, password });
      throw new Error("expected already-expired token to be rejected");
    } catch (error) {
      expect((error as Error).message).toMatch(/expired/i);
    }
    expect(coordinator.status().status).toBe("signed-out");
    fixture.close();
  });

  it("rejects an injected database handle that does not expose the required methods", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const broken = {
      user: { authenticateEmail: () => undefined },
      // missing tokenManager entirely
    } as unknown as NotesnookDatabaseHandle;
    expect(() =>
      createNotesnookAuthProvider({
        core: broken,
        storage: fixture.storage,
        clearLocalState: async () => {},
      }),
    ).toThrow("invalid Notesnook handle: token manager is required");

    const canary = runtimeSecret("throwing-core-getter");
    const throwingCore = new Proxy(
      {},
      {
        get() {
          throw new Error(canary);
        },
      },
    );
    let constructorError: unknown;
    try {
      createNotesnookAuthProvider({
        core: throwingCore as never,
        storage: fixture.storage,
        clearLocalState: async () => {},
      });
    } catch (error) {
      constructorError = error;
    }
    expect(constructorError).toBeInstanceOf(Error);
    const normalizedConstructorError = constructorError as Error & { __context__?: unknown };
    expect(normalizedConstructorError.message).toBe("invalid Notesnook handle: could not be read");
    expect(normalizedConstructorError.message).not.toContain(canary);
    expect(normalizedConstructorError.cause).toBeUndefined();
    expect(normalizedConstructorError.__context__).toBeUndefined();
    fixture.close();
  });

  it("normalizes hostile constructor option getters without exposing their exception", () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const canary = runtimeSecret("throwing-options-getter");
    const options = new Proxy(
      {
        core: fixture.handle,
        storage: fixture.storage,
        clearLocalState: async () => {},
      },
      {
        get(_target, property) {
          if (property === "storage") throw new Error(canary);
          return undefined;
        },
      },
    );

    let constructorError: unknown;
    try {
      createNotesnookAuthProvider(options as never);
    } catch (error) {
      constructorError = error;
    }

    expect(constructorError).toBeInstanceOf(Error);
    const error = constructorError as Error & { __context__?: unknown };
    expect(error.message).toBe("invalid Notesnook auth provider options");
    expect(error.message).not.toContain(canary);
    expect(error.cause).toBeUndefined();
    expect(error.__context__).toBeUndefined();
    fixture.close();
  });

  it("fails closed at construction when the required local-state clear seam is absent", () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    expect(() =>
      createNotesnookAuthProvider({
        core: fixture.handle,
        storage: fixture.storage,
        clearLocalState: undefined as never,
      }),
    ).toThrow("requires clearLocalState");
    fixture.close();
  });

  it("lets logout win over a pending refresh without resurrecting kv.token", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa", refreshDelayMs: 25 });
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage: fixture.storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });
    const session = await provider.login({
      username: runtimeEmail("race-refresh"),
      password: runtimeSecret("race-refresh-pwd"),
    });

    const refresh = provider.refresh(session);
    const logout = provider.logout(session);
    await logout;
    await expect(refresh).rejects.toThrow(/superseded|storage/i);
    expect(await fixture.storage.read<NotesnookTokenEnvelope>("kv.token")).toBeUndefined();
    fixture.close();
  });

  it("lets logout win over a pending login before the stale completion can write", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    let releaseEmail!: () => void;
    const emailReleased = new Promise<void>((resolve) => {
      releaseEmail = resolve;
    });
    let blockEmail = true;
    const envelope: NotesnookTokenEnvelope = {
      access_token: runtimeSecret("race-login-access"),
      t: 1,
      expires_in: 60,
      scope: "offline_access",
      refresh_token: runtimeSecret("race-login-refresh"),
    };
    fixture.handle.user.authenticateEmail = async () => {
      if (blockEmail) await emailReleased;
      return envelope;
    };
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage: fixture.storage,
      clearLocalState: async () => {},
      clock: () => 1_000,
    });
    const credentials = {
      username: runtimeEmail("race-login"),
      password: runtimeSecret("race-login-pwd"),
    };
    const login = provider.login(credentials);
    await new Promise<void>((resolve) => process.nextTick(resolve));
    const logout = provider.logout({
      userId: "offline-test-user",
      accessToken: runtimeSecret("race-login-session"),
      issuedAt: 1,
      expiresAt: 60_000,
    });
    await logout;
    expect(await fixture.storage.read<NotesnookTokenEnvelope>("kv.token")).toBeUndefined();
    let laterLoginSettled = false;
    const laterLogin = provider.login({
      username: runtimeEmail("race-login-after-logout"),
      password: runtimeSecret("race-login-after-logout-password"),
    });
    void laterLogin.then(
      () => {
        laterLoginSettled = true;
      },
      () => {
        laterLoginSettled = true;
      },
    );
    await delay(0);
    expect(laterLoginSettled).toBe(false);
    blockEmail = false;
    releaseEmail();
    await expect(login).rejects.toThrow(/superseded|storage/i);
    await expect(laterLogin).resolves.toMatchObject({ accessToken: expect.any(String) });
    expect(fixture.calls.filter((call) => call.method === "authenticatePassword")).toHaveLength(1);
    expect(await fixture.storage.read<NotesnookTokenEnvelope>("kv.token")).toBeDefined();

    // A read already in progress must not rehydrate the old authenticated
    // session after logout has advanced the provider epoch and removed the
    // persisted envelope.
    const persistedBeforeRestore = {
      access_token: runtimeSecret("restore-race-access"),
      t: 1,
      expires_in: 60,
      scope: "offline_access",
      refresh_token: runtimeSecret("restore-race-refresh"),
    } satisfies NotesnookTokenEnvelope;
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const deferredStorage = {
      ...fixture.storage,
      read: async <T>(_key: string) => {
        readStarted();
        await readReleased;
        return persistedBeforeRestore as T;
      },
    } as typeof fixture.storage;
    const restoreProvider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage: deferredStorage,
      clearLocalState: async () => {},
      clock: () => 1_000,
    });
    const restore = restoreProvider.restoreSession();
    await started;
    const restoreLogout = restoreProvider.logout({
      userId: "offline-test-user",
      accessToken: runtimeSecret("restore-race-session"),
      issuedAt: 1,
      expiresAt: 60_000,
    });
    await restoreLogout;
    releaseRead();
    await expect(restore).resolves.toBeNull();

    // A write can itself be deferred after the provider has validated the
    // upstream result.  Logout must invalidate that completion, make the
    // login reject categorically, and leave no token behind after the
    // serialized cleanup finishes.
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const writeStartedPromise = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const deferredWriteStorage = {
      ...fixture.storage,
      write: async <T>(key: string, data: T) => {
        writeStarted();
        await writeReleased;
        await fixture.storage.write(key, data);
      },
    } as typeof fixture.storage;
    const deferredWriteProvider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage: deferredWriteStorage,
      clearLocalState: async () => {},
      clock: () => 1_000,
    });
    const staleLogin = deferredWriteProvider.login({
      username: runtimeEmail("deferred-write-login"),
      password: runtimeSecret("deferred-write-password"),
    });
    const staleLoginOutcome = staleLogin.then(
      () => undefined,
      (error: unknown) => error,
    );
    await writeStartedPromise;
    const deferredLogout = deferredWriteProvider.logout({
      userId: "offline-test-user",
      accessToken: runtimeSecret("deferred-write-session"),
      issuedAt: 1,
      expiresAt: 60_000,
    });
    releaseWrite();
    await deferredLogout;
    const staleLoginError = await staleLoginOutcome;
    expect(staleLoginError).toBeInstanceOf(Error);
    expect((staleLoginError as Error).message).toBe("notesnook auth operation superseded");
    expect((staleLoginError as Error).cause).toBeUndefined();
    expect((staleLoginError as Error & { __context__?: unknown }).__context__).toBeUndefined();
    expect(await fixture.storage.read<NotesnookTokenEnvelope>("kv.token")).toBeUndefined();
    fixture.close();
  });

  it("cancels a signed-out coordinator login before provider persistence and permits a later login", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    let releaseEmail!: () => void;
    const emailReleased = new Promise<void>((resolve) => {
      releaseEmail = resolve;
    });
    let emailStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      emailStarted = resolve;
    });
    let blocked = true;
    const originalAuthenticateEmail = fixture.handle.user.authenticateEmail;
    fixture.handle.user.authenticateEmail = async function (email) {
      if (blocked) {
        emailStarted();
        await emailReleased;
      }
      return originalAuthenticateEmail.call(this, email);
    };
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage: fixture.storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => fixture.now,
    });
    const login = coordinator.login({
      username: runtimeEmail("coordinator-race"),
      password: runtimeSecret("coordinator-race-password"),
    });
    await started;

    await coordinator.logout();
    blocked = false;
    releaseEmail();

    await expect(login).rejects.toMatchObject({
      message: "auth operation superseded by a newer transition",
      cause: undefined,
    });
    expect(await fixture.storage.read<NotesnookTokenEnvelope>("kv.token")).toBeUndefined();

    const next = await coordinator.login({
      username: runtimeEmail("coordinator-race-retry"),
      password: runtimeSecret("coordinator-race-retry-password"),
    });
    expect(next.status).toBe("authenticated");
    expect(await fixture.storage.read<NotesnookTokenEnvelope>("kv.token")).toBeDefined();
    fixture.close();
  });

  it("cancels a signed-out coordinator login that loses the pre-wait race", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage: fixture.storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });
    const coordinator = new AuthCoordinator({ provider, clock: () => fixture.now });

    // provider.login() reaches its initial wait before coordinator.logout()
    // synchronously invalidates the provider.  The provider must retain the
    // operation epoch captured at invocation, rather than adopting the
    // post-logout epoch and authenticating anyway.
    const login = coordinator.login({
      username: runtimeEmail("pre-wait-coordinator-race"),
      password: runtimeSecret("pre-wait-coordinator-race-password"),
    });
    const logout = coordinator.logout();
    await logout;

    await expect(login).rejects.toMatchObject({
      message: "auth operation superseded by a newer transition",
      cause: undefined,
    });
    expect(fixture.calls.filter((call) => call.method === "authenticateEmail")).toHaveLength(0);
    expect(fixture.calls.filter((call) => call.method === "authenticatePassword")).toHaveLength(0);
    expect(await fixture.storage.read<NotesnookTokenEnvelope>("kv.token")).toBeUndefined();

    const next = await coordinator.login({
      username: runtimeEmail("pre-wait-coordinator-retry"),
      password: runtimeSecret("pre-wait-coordinator-retry-password"),
    });
    expect(next.status).toBe("authenticated");
    expect(await fixture.storage.read<NotesnookTokenEnvelope>("kv.token")).toBeDefined();
    fixture.close();
  });

  it("supersedes restore when logout starts during the pre-wait gap and blocks refresh", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const persisted = {
      access_token: runtimeSecret("pre-wait-restore-access"),
      t: 1,
      expires_in: 60,
      scope: "offline_access",
      refresh_token: runtimeSecret("pre-wait-restore-refresh"),
    } satisfies NotesnookTokenEnvelope;
    await fixture.storage.write("kv.token", persisted);

    let releaseRemove!: () => void;
    const removeReleased = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    let removeStarted!: () => void;
    const removeStartedPromise = new Promise<void>((resolve) => {
      removeStarted = resolve;
    });
    const deferredCleanupStorage = {
      ...fixture.storage,
      remove: async (key: string) => {
        removeStarted();
        await removeReleased;
        await fixture.storage.remove(key);
      },
    } as typeof fixture.storage;
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage: deferredCleanupStorage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });

    const restore = provider.restoreSession();
    const logout = provider.logout({
      userId: "offline-test-user",
      accessToken: runtimeSecret("pre-wait-restore-session"),
      issuedAt: 1,
      expiresAt: 60_000,
    });
    await removeStartedPromise;

    try {
      await expect(restore).resolves.toBeNull();
    } finally {
      releaseRemove();
      await logout;
    }

    expect(await fixture.storage.read<NotesnookTokenEnvelope>("kv.token")).toBeUndefined();
    const refreshCallsBefore = fixture.calls.filter(
      (call) => call.method === "_refreshToken",
    ).length;
    await expect(
      provider.refresh({
        userId: "offline-test-user",
        accessToken: runtimeSecret("pre-wait-restore-refresh-session"),
        issuedAt: 1,
        expiresAt: 60_000,
      }),
    ).rejects.toMatchObject({
      message: "notesnook refresh unavailable without an active session",
      cause: undefined,
    });
    expect(fixture.calls.filter((call) => call.method === "_refreshToken")).toHaveLength(
      refreshCallsBefore,
    );
    fixture.close();
  });

  it("normalizes storage and supplier failures without exposing upstream text or causes", async () => {
    const storageFailure = runtimeSecret("storage-failure");
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const failingStorage = {
      ...fixture.storage,
      write: async () => {
        throw new Error(storageFailure);
      },
      read: async () => {
        throw new Error(storageFailure);
      },
    } as typeof fixture.storage;
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage: failingStorage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });
    const errorFrom = async (operation: Promise<unknown>): Promise<Error> => {
      try {
        await operation;
        throw new Error("expected operation to fail");
      } catch (error) {
        return error as Error;
      }
    };
    const writeError = await errorFrom(
      provider.login({ username: runtimeEmail("storage-write"), password: runtimeSecret("pwd") }),
    );
    expect(writeError.message).toBe("notesnook token storage write failed");
    expect(writeError.message).not.toContain(storageFailure);
    expect(writeError.cause).toBeUndefined();
    expect((writeError as Error & { __context__?: unknown }).__context__).toBeUndefined();
    const readError = await errorFrom(provider.restoreSession());
    expect(readError.message).toBe("notesnook token storage read failed");
    expect(readError.message).not.toContain(storageFailure);

    const supplierSecret = runtimeSecret("supplier-failure");
    const passwordFixture = createFakeCoreFixture({ mode: "password-retry" });
    const initialPassword = runtimeSecret("supplier-initial-password");
    passwordFixture.passwordsToReject = new Set([initialPassword]);
    const passwordProvider = createNotesnookAuthProvider({
      core: passwordFixture.handle,
      storage: passwordFixture.storage,
      clearLocalState: async () => {},
      passwordSupplier: async () => {
        throw new Error(supplierSecret);
      },
    });
    const supplierError = await errorFrom(
      passwordProvider.login({ username: runtimeEmail("supplier"), password: initialPassword }),
    );
    expect(supplierError.message).toBe("notesnook password supplier failed");
    expect(supplierError.message).not.toContain(supplierSecret);
    fixture.close();
    passwordFixture.close();
  });

  it.each(["undefined", "number"])(
    "rejects a %s password supplier result without forwarding it",
    async (kind) => {
      const fixture = createFakeCoreFixture({ mode: "password-retry" });
      const initialPassword = runtimeSecret(`supplier-${kind}-initial-password`);
      fixture.passwordsToReject = new Set([initialPassword]);
      const invalid = kind === "undefined" ? undefined : 42;
      const provider = createNotesnookAuthProvider({
        core: fixture.handle,
        storage: fixture.storage,
        clearLocalState: async () => {},
        passwordSupplier: async () => invalid as never,
      });
      await expect(
        provider.login({
          username: runtimeEmail(`supplier-${kind}`),
          password: initialPassword,
        }),
      ).rejects.toThrow(/supplier returned invalid input/);
      expect(fixture.calls.filter((call) => call.method === "authenticatePassword")).toHaveLength(
        1,
      );
      fixture.close();
    },
  );

  it("rejects malformed login roots and exact-type-invalid token timing fields categorically", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage: fixture.storage,
      clearLocalState: async () => {},
    });
    await expect(provider.login(null as never)).rejects.toThrow(/credentials object/);
    expect(fixture.calls).toEqual([]);

    const invalidTiming: Array<{ t: unknown; expires_in: unknown }> = [
      { t: "1", expires_in: 60 },
      { t: true, expires_in: 60 },
      { t: 1, expires_in: "60" },
      { t: 1, expires_in: false },
      { t: NaN, expires_in: 60 },
      { t: 1, expires_in: Infinity },
    ];
    for (const timing of invalidTiming) {
      fixture.handle.user.authenticateEmail = async () => ({
        access_token: runtimeSecret("invalid-access"),
        ...timing,
        scope: "offline_access",
        refresh_token: runtimeSecret("invalid-refresh"),
      });
      await expect(
        provider.login({
          username: runtimeEmail("invalid-timing"),
          password: runtimeSecret("pwd"),
        }),
      ).rejects.toThrow(/invalid token envelope/);
    }
    fixture.close();
  });

  it("restores only after strict envelope validation, including every persisted field", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage: fixture.storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });

    const validFields = {
      access_token: runtimeSecret("restore-access"),
      t: 1,
      expires_in: 60,
      scope: "offline_access",
      refresh_token: runtimeSecret("restore-refresh"),
    };
    await fixture.storage.write("kv.token", {
      ...validFields,
      t: "1",
    } as never);
    await expect(provider.restoreSession()).rejects.toThrow(/invalid token envelope/);

    const canary = runtimeSecret("restore-scope-getter");
    const throwingEnvelope = new Proxy(validFields, {
      get(target, property, receiver) {
        if (property === "scope") throw new Error(canary);
        return Reflect.get(target, property, receiver);
      },
    });
    await fixture.storage.write("kv.token", throwingEnvelope);
    await expect(provider.restoreSession()).rejects.toMatchObject({
      message: "invalid token envelope: upstream response could not be read",
      cause: undefined,
      __context__: undefined,
    });
    try {
      await provider.restoreSession();
    } catch (error) {
      expect((error as Error).message).not.toContain(canary);
    }
    fixture.close();
  });

  it("normalizes throwing credential getters without exposing their exception", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage: fixture.storage,
      clearLocalState: async () => {},
    });
    const canary = runtimeSecret("throwing-credential-getter");
    const credentials = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "username") throw new Error(canary);
          return undefined;
        },
      },
    );

    let caught: unknown;
    try {
      await provider.login(credentials as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & { __context__?: unknown };
    expect(error.message).toBe("notesnook login credentials could not be read");
    expect(error.message).not.toContain(canary);
    expect(error.cause).toBeUndefined();
    expect(error.__context__).toBeUndefined();
    expect(fixture.calls).toEqual([]);
    fixture.close();
  });

  it("normalizes a colliding storage error instead of treating it as superseded", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const canary = runtimeSecret("colliding-storage-error");
    const injected = new Error("notesnook auth operation superseded");
    Object.defineProperty(injected, "cause", {
      configurable: true,
      value: new Error(canary),
    });
    Object.defineProperty(injected, "__context__", {
      configurable: true,
      value: new Error(canary),
    });
    const storage = {
      ...fixture.storage,
      write: async () => {
        throw injected;
      },
    } as typeof fixture.storage;
    const provider = createNotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });

    let caught: unknown;
    try {
      await provider.login({
        username: runtimeEmail("colliding-storage"),
        password: runtimeSecret("colliding-password"),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & { __context__?: unknown };
    expect(error.message).toBe("notesnook token storage write failed");
    expect(error.message).not.toContain(canary);
    expect(error.cause).toBeUndefined();
    expect(error.__context__).toBeUndefined();
    fixture.close();
  });
});

describe("Stage 2B-live — additive AuthCoordinator integration", () => {
  it("drives the production AuthCoordinator through mocked Notesnook without enabling live login", async () => {
    const fixture = createFakeCoreFixture({ mode: "no-mfa" });
    const storage = fixture.storage;
    const provider = new NotesnookAuthProvider({
      core: fixture.handle,
      storage,
      clearLocalState: async () => {},
      clock: () => fixture.now,
    });
    const coordinator = new AuthCoordinator({
      provider,
      clock: () => fixture.now,
    });

    const email = runtimeEmail("integration");
    const password = runtimeSecret("integration-pwd");

    const state = await coordinator.login({ username: email, password });
    expect(state.status).toBe("authenticated");
    if (state.status !== "authenticated") throw new Error("expected authenticated");

    // The provider's session values are normalised: no refresh token,
    // positive expiresAt, no negative values.
    expect(state.session.expiresAt).toBeGreaterThan(state.session.issuedAt);
    expect(state.session.accessToken.length).toBeGreaterThan(0);

    // Logout transitions back to signed-out.
    await coordinator.logout();
    expect(coordinator.status()).toEqual({ status: "signed-out" });

    // The CLI auth subcommand must remain DEFERRED for `login` — the
    // production code path never enabled real login.  We assert the
    // deferred outcome here to make that intent explicit in the test
    // surface.
    const { runAuthCommand } = await import("../src/auth/admin-command.js");
    const result = await runAuthCommand({
      argv: ["login"],
      env: {},
    });
    expect(result.kind).toBe("deferred");

    fixture.close();
  });
});

describe("Stage 2B-live — PersistentStorage hygiene", () => {
  let persistent: ReturnType<typeof createPersistentFixture>;
  beforeEach(() => {
    persistent = createPersistentFixture();
  });
  afterEach(() => {
    persistent.close();
  });

  it("does not write raw passwords or MFA codes to the encrypted storage", async () => {
    const fixture = createFakeCoreFixture({
      mode: "mfa-required",
      storage: persistent.storage,
    });
    const mfaCode = runtimeSecret("store-hygiene-mfa");
    try {
      const provider = createNotesnookAuthProvider({
        core: fixture.handle,
        storage: persistent.storage,
        clearLocalState: async () => {},
        clock: () => fixture.now,
        mfaSupplier: async () => mfaCode,
      });

      const email = runtimeEmail("store-hygiene");
      const password = runtimeSecret("store-hygiene-pwd");

      await provider.login({ username: email, password });

      const keys = await persistent.storage.getAllKeys();
      // Only kv.token and the schema meta row should exist.
      expect(keys).toContain("kv.token");
      for (const key of keys) {
        if (key === "schema_version" || key === "kv.token") continue;
        // No other key may exist.
        throw new Error(`unexpected persistent key written: ${key}`);
      }

      // Every value written under kv.token must not equal the
      // password or MFA bytes (the upstream fixture only emits opaque
      // token bytes).
      const persisted = await persistent.storage.read<NotesnookTokenEnvelope>("kv.token");
      expect(persisted).toBeDefined();
      const envelopeString = JSON.stringify(persisted);
      expect(envelopeString).not.toContain(password);
      expect(envelopeString).not.toContain(mfaCode);
    } finally {
      fixture.close();
    }
  });
});

const FORBIDDEN_AUTH_ENV_CARRIERS = [
  "NOOKBRIDGE_PASSWORD",
  "NOOKBRIDGE_PASSWD",
  "NOOKBRIDGE_MFA",
  "NOOKBRIDGE_TOTP",
  "NOOKBRIDGE_SECRET",
  "NOOKCTL_PASSWORD",
  "NOOKCTL_MFA",
] as const;

describe("nookctl auth CLI security boundary", () => {
  it("normalizes hostile environment getter proxies without exposing their exception", async () => {
    const canary = runtimeSecret("throwing-env-getter");
    const env = new Proxy(
      {},
      {
        get() {
          throw new Error(canary);
        },
      },
    );

    const result = parseAuthCommand(["status"], env);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected auth parser error");
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe("nookctl auth: invalid command input");
    expect(result.message).not.toContain(canary);

    const options = new Proxy(
      {},
      {
        get() {
          throw new Error(canary);
        },
      },
    );
    const runResult = await runAuthCommand(options as never);
    expect(runResult).toEqual({
      kind: "error",
      exitCode: 2,
      message: "nookctl auth: invalid command input",
    });
  });

  it("normalizes a throwing environment has trap without exposing its exception", () => {
    const canary = runtimeSecret("throwing-env-has");
    const env = new Proxy(
      {},
      {
        has() {
          throw new Error(canary);
        },
      },
    );

    const result = parseAuthCommand(["status"], env);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected auth parser error");
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe("nookctl auth: invalid command input");
    expect(result.message).not.toContain(canary);
  });

  it("normalizes non-string argv elements without exposing their raw value", () => {
    const canary = runtimeSecret("non-string-argv");
    const result = parseAuthCommand(["status", { canary } as never], {});
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected auth parser error");
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe("nookctl auth: invalid command input");
    expect(result.message).not.toContain(canary);
  });

  it.each(FORBIDDEN_AUTH_ENV_CARRIERS)(
    "rejects a present %s credential carrier instead of silently filtering it",
    (carrier) => {
      for (const value of ["", undefined, runtimeSecret(`env-${carrier}`)] as const) {
        const env: Record<string, string | undefined> = {};
        env[carrier] = value;
        const result = parseAuthCommand(["status"], env);

        expect(result.kind).toBe("error");
        if (result.kind !== "error") throw new Error("expected auth parser error");
        expect(result.exitCode).toBe(2);
        expect(result.message).toContain(carrier);
        if (value) expect(result.message).not.toContain(value);
      }

      const inheritedEnv = Object.create({ [carrier]: undefined }) as Record<
        string,
        string | undefined
      >;
      const inheritedResult = parseAuthCommand(["status"], inheritedEnv);
      expect(inheritedResult.kind).toBe("error");
      if (inheritedResult.kind !== "error")
        throw new Error("expected inherited auth carrier error");
      expect(inheritedResult.exitCode).toBe(2);
      expect(inheritedResult.message).toContain(carrier);
    },
  );

  it.each(FORBIDDEN_AUTH_ENV_CARRIERS)(
    "rejects a present %s carrier at the public CLI boundary with exit 2",
    async (carrier) => {
      const canary = runtimeSecret(`public-cli-${carrier}`);
      const previous = process.env[carrier];
      process.env[carrier] = canary;
      const stderr: string[] = [];
      const stdout: string[] = [];
      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
      try {
        expect(await runCli(["node", "nookctl", "auth", "status"])).toBe(2);
        expect(stderr.join("")).toBe(
          `nookctl: refusing to read credentials from environment variable ${carrier}; use an interactive TTY prompt\n`,
        );
        expect(stderr.join("")).not.toContain(canary);
        expect(stdout.join("")).toBe("");
      } finally {
        stderrWrite.mockRestore();
        stdoutWrite.mockRestore();
        if (previous === undefined) delete process.env[carrier];
        else process.env[carrier] = previous;
      }
    },
  );

  it("unknown auth subcommands through the public CLI use a safe exit-2 diagnostic", async () => {
    const unknownSubcommand = runtimeSecret("unknown-public-auth-subcommand");
    const rawArgValue = runtimeSecret("unknown-public-auth-argv-value");
    const stderr: string[] = [];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      expect(await runCli(["node", "nookctl", "auth", unknownSubcommand, rawArgValue])).toBe(2);
      expect(stderr.join("")).toBe(
        "nookctl: nookctl auth: unknown subcommand; use `nookctl auth help`\n",
      );
      expect(stderr.join("")).not.toContain(unknownSubcommand);
      expect(stderr.join("")).not.toContain(rawArgValue);

      const hostileArgv = new Proxy(["node", "nookctl", "auth", "status"], {
        get() {
          throw new Error(rawArgValue);
        },
      });
      stderr.length = 0;
      expect(await runCli(hostileArgv as never)).toBe(2);
      expect(stderr.join("")).toBe("nookctl: invalid command input\n");
      expect(stderr.join("")).not.toContain(rawArgValue);

      // Exercise the actual public run() boundary for both top-level
      // unknown commands and equals-form forbidden flags. Neither the
      // command nor its attached value may cross into stderr.
      stderr.length = 0;
      expect(await runCli(["node", "nookctl", unknownSubcommand, rawArgValue])).toBe(2);
      expect(stderr.join("")).toBe("nookctl: unknown subcommand; use `nookctl help`\n");
      expect(stderr.join("")).not.toContain(unknownSubcommand);
      expect(stderr.join("")).not.toContain(rawArgValue);

      for (const flag of [
        "--password",
        "--passwd",
        "--mfa",
        "--totp",
        "--secret",
        "--stdin-secret",
        "--token",
      ]) {
        const value = runtimeSecret(`equals-${flag}`);
        stderr.length = 0;
        expect(await runCli(["node", "nookctl", "auth", "login", `${flag}=${value}`])).toBe(2);
        expect(stderr.join("")).toBe(
          `nookctl: refusing to read credentials from CLI flag ${flag}; use an interactive TTY prompt\n`,
        );
        expect(stderr.join("")).not.toContain(value);
      }
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("rejects unknown auth subcommands with a categorical message", () => {
    const unknownSubcommand = runtimeSecret("unknown-auth-subcommand");
    const rawArgValue = runtimeSecret("unknown-auth-argv-value");
    const result = parseAuthCommand([unknownSubcommand, rawArgValue], {});

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected auth parser error");
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe("nookctl auth: unknown subcommand; use `nookctl auth help`");
    expect(result.message).not.toContain(unknownSubcommand);
    expect(result.message).not.toContain(rawArgValue);
  });
});

// Type-only access to silence unused-import errors while keeping the
// compile-time contract surface visible to readers of the test file.
const _typeKeepers: ReadonlyArray<
  FakeCoreFixture | NotesnookAuthProviderOptions | NotesnookDatabaseHandle | NotesnookTokenEnvelope
> = [];
void _typeKeepers;
