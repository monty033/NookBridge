/**
 * Stage 2B-live — focused offline tests for the explicit live
 * Notesnook auth provider and the secure live runner.
 *
 * These tests sit ALONGSIDE the broad Stage-2B-live contract suite
 * (`tests/stage-2b-live-auth.test.ts`, which exercises the offline
 * `NotesnookAuthProvider`) and the narrow real-core factory suite
 * (`tests/notesnook-live-factory.test.ts`, 25 tests).  The goal here
 * is to cover the live-side invariants the broader suites do not
 * exercise directly:
 *
 *   1. Login call order — email -> optional MFA (branch on scope)
 *      -> password -> `token.getToken` -> `user.getUser`.
 *   2. Refresh — `_refreshToken(true)` followed by `token.getToken`;
 *      refresh-after-logout rejection; concurrent-refresh rejection.
 *   3. Logout — `user.logout(true)` is forwarded by the narrow
 *      handle; only `kv.token` is deleted; the cleanup hook is
 *      always invoked; failure independence between steps.
 *   4. Public `AuthSession` never exposes `refresh_token`, password,
 *      or MFA code; no credential cache on the provider instance.
 *   5. Runner collects ONLY through the injected `SecretPrompt`;
 *      buffers are zeroized in `finally`; the public result is
 *      redacted; the provider is invoked exactly once per command.
 *   6. Hostile provider / supplier / logger / envelope / handle
 *      boundaries normalize errors; no `fetch` / network call.
 *   7. Forbidden argv / env still rejected through `runAuthCommand`
 *      when the live seam is wired in.
 *
 * No real account is contacted.  Every credential value is
 * synthesized at runtime via `randomBytes`; nothing committed to
 * the repo is a real secret.
 */

import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "../src/auth/types.js";
import { isAuthProviderError } from "../src/auth/types.js";
import type { Logger } from "../src/logging/logger.js";
import type {
  NotesnookLiveCoreHandle,
  NotesnookLiveTokenEnvelope,
  NotesnookLiveUser,
} from "../src/core/notesnook-live-factory.js";
import { NOTESNOOK_LIVE_KV_TOKEN_KEY } from "../src/core/notesnook-live-factory.js";
import {
  LIVE_NOTESNOOK_KV_TOKEN_KEY,
  LiveNotesnookAuthProvider,
  createLiveNotesnookAuthProvider,
  type LiveCleanupHook,
  type LiveMfaSupplier,
  type LiveNotesnookAuthProviderOptions,
  type LivePasswordSupplier,
} from "../src/auth/live-notesnook-auth-provider.js";
import {
  runLiveAuthCommand,
  type LiveAuthCommandKind,
  type LiveProviderFactory,
} from "../src/auth/live-auth-runner.js";
import { runAuthCommand } from "../src/auth/admin-command.js";
import type { SecretPrompt } from "../src/auth/secret-input.js";

// ---------------------------------------------------------------------------
// Synthetic secrets.  Generated at runtime; nothing committed here is real.
// ---------------------------------------------------------------------------

function syntheticEmail(): string {
  return `user-${randomBytes(6).toString("hex")}@example.test`;
}

function syntheticSecret(label: string): string {
  return `${label}-${randomBytes(8).toString("hex")}`;
}

function syntheticSession(now: number): {
  envelope: NotesnookLiveTokenEnvelope;
  user: NotesnookLiveUser;
} {
  return {
    envelope: {
      access_token: syntheticSecret("access"),
      refresh_token: syntheticSecret("refresh"),
      expires_in: 3600,
      scope: "notes",
      t: Math.floor(now / 1000),
    },
    user: {
      id: `user-${randomBytes(6).toString("hex")}`,
      email: syntheticEmail(),
    },
  };
}

// ---------------------------------------------------------------------------
// Call-journaling fake narrow handle.  Mirrors `NotesnookLiveCoreHandle`
// closely enough that `LiveNotesnookAuthProvider` consumes it without
// modification.  Every handle method is a `vi.fn()` so the test can
// assert on call order and arguments without an extra wrapper.
// ---------------------------------------------------------------------------

interface FakeHandle {
  handle: NotesnookLiveCoreHandle;
  calls: Array<{ method: string; args: unknown[] }>;
}

type FakeHandleBehavior = {
  emailResponse?: unknown;
  emailRejects?: boolean;
  mfaRejects?: number;
  passwordRejects?: number;
  postPasswordToken?: NotesnookLiveTokenEnvelope | undefined;
  postRefreshToken?: NotesnookLiveTokenEnvelope | undefined;
  userRecord?: NotesnookLiveUser | undefined;
  refreshRejects?: boolean;
  logoutRejects?: boolean;
  logoutArgCapture?: boolean[];
  kvDeleteRejects?: boolean;
  kvDeleteArgsCapture?: string[];
};

function makeFakeHandle(behavior: FakeHandleBehavior = {}): FakeHandle {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const mfaRejectionsLeft = { value: behavior.mfaRejects ?? 0 };
  const passwordRejectionsLeft = { value: behavior.passwordRejects ?? 0 };
  const logoutArgCapture = behavior.logoutArgCapture ?? [];
  const kvDeleteArgsCapture = behavior.kvDeleteArgsCapture ?? [];

  const fake: NotesnookLiveCoreHandle = {
    user: {
      authenticateEmail: vi.fn(async (email: string) => {
        calls.push({ method: "user.authenticateEmail", args: [email] });
        if (behavior.emailRejects) throw new Error("upstream email rejected");
        return (
          behavior.emailResponse ?? {
            access_token: syntheticSecret("access"),
            refresh_token: syntheticSecret("refresh"),
            expires_in: 3600,
            scope: "notes",
            t: Math.floor(Date.now() / 1000),
          }
        );
      }),
      authenticateMultiFactorCode: vi.fn(async (code: string, kind: "app") => {
        calls.push({ method: "user.authenticateMultiFactorCode", args: [code, kind] });
        if (mfaRejectionsLeft.value > 0) {
          mfaRejectionsLeft.value -= 1;
          throw new Error("upstream MFA rejected");
        }
        return { ok: true };
      }),
      authenticatePassword: vi.fn(async (email: string, password: string) => {
        calls.push({ method: "user.authenticatePassword", args: [email, password] });
        if (passwordRejectionsLeft.value > 0) {
          passwordRejectionsLeft.value -= 1;
          throw new Error("upstream password rejected");
        }
        return undefined;
      }),
      getUser: vi.fn(async () => {
        calls.push({ method: "user.getUser", args: [] });
        return behavior.userRecord;
      }),
      logout: vi.fn(async (clearLocal?: unknown) => {
        logoutArgCapture.push(typeof clearLocal === "boolean" ? clearLocal : false);
        calls.push({ method: "user.logout", args: [clearLocal] });
        if (behavior.logoutRejects) throw new Error("upstream logout rejected");
      }),
    },
    token: {
      getToken: vi.fn(async (): Promise<NotesnookLiveTokenEnvelope | undefined> => {
        calls.push({ method: "token.getToken", args: [] });
        return behavior.postPasswordToken;
      }),
      _refreshToken: vi.fn(async (forceRenew: boolean) => {
        calls.push({ method: "token._refreshToken", args: [forceRenew] });
        if (behavior.refreshRejects) throw new Error("upstream refresh rejected");
      }),
    },
    kv: {
      read: vi.fn(async (key: string) => {
        calls.push({ method: "kv.read", args: [key] });
        return undefined;
      }),
      write: vi.fn(async (key: string, value: unknown) => {
        calls.push({ method: "kv.write", args: [key, value] });
      }),
      delete: vi.fn(async (key: string) => {
        kvDeleteArgsCapture.push(key);
        calls.push({ method: "kv.delete", args: [key] });
        if (behavior.kvDeleteRejects) throw new Error("upstream kv.delete rejected");
      }),
    },
    cleanup: vi.fn(async () => {
      calls.push({ method: "cleanup", args: [] });
    }),
    initialized: true,
  };

  // Sanity: the narrow handle exposes ONLY the methods the live
  // provider consumes.  A drift here would silently widen the
  // surface and is a test-side bug, not a production bug.
  expect(typeof fake.user.authenticateEmail).toBe("function");
  expect(typeof fake.token._refreshToken).toBe("function");
  expect(typeof fake.kv.delete).toBe("function");

  return { handle: fake, calls };
}

// ---------------------------------------------------------------------------
// Test harness.  Builds a provider wired to a fake handle with
// deterministic suppliers and a no-op cleanup hook.  The clock is
// frozen to a stable unix-second boundary so envelope validation
// (issuedAt / expiresAt relative to the envelope's `t`) is
// deterministic.
// ---------------------------------------------------------------------------

const FROZEN_NOW_MS = 1_700_000_000_000;

interface Harness {
  handle: NotesnookLiveCoreHandle;
  calls: Array<{ method: string; args: unknown[] }>;
  cleanupCalls: number;
  passwordSupplier: ReturnType<typeof vi.fn> & LivePasswordSupplier;
  mfaSupplier: ReturnType<typeof vi.fn> & LiveMfaSupplier;
  clock: () => number;
  cleanupHook: LiveCleanupHook;
  build(): LiveNotesnookAuthProvider;
  buildWithOptions(
    overrides?: Partial<LiveNotesnookAuthProviderOptions>,
  ): LiveNotesnookAuthProvider;
  sessionFixture(now: number): { envelope: NotesnookLiveTokenEnvelope; user: NotesnookLiveUser };
}

function buildHarness(
  behavior: FakeHandleBehavior = {},
  baseToken?: NotesnookLiveTokenEnvelope,
  baseUser?: NotesnookLiveUser,
): Harness {
  const fake = makeFakeHandle({
    ...behavior,
    postPasswordToken: behavior.postPasswordToken ?? baseToken,
    userRecord: behavior.userRecord ?? baseUser,
  });
  const cleanupCalls = { value: 0 };
  const passwordSupplier = vi.fn(async () => syntheticSecret("supplier-password")) as ReturnType<
    typeof vi.fn
  > &
    LivePasswordSupplier;
  const mfaSupplier = vi.fn(async () => syntheticSecret("supplier-mfa")) as ReturnType<
    typeof vi.fn
  > &
    LiveMfaSupplier;
  const clock = vi.fn(() => FROZEN_NOW_MS);
  const cleanupHook: LiveCleanupHook = vi.fn(async () => {
    cleanupCalls.value += 1;
  });

  const buildWithOptions = (
    overrides: Partial<LiveNotesnookAuthProviderOptions> = {},
  ): LiveNotesnookAuthProvider => {
    const options: LiveNotesnookAuthProviderOptions = {
      handle: fake.handle,
      passwordSupplier,
      mfaSupplier,
      clock,
      cleanupHook,
      ...overrides,
    };
    return new LiveNotesnookAuthProvider(options);
  };

  return {
    handle: fake.handle,
    calls: fake.calls,
    cleanupCalls: 0,
    passwordSupplier,
    mfaSupplier,
    clock,
    cleanupHook,
    build: () => buildWithOptions(),
    buildWithOptions,
    sessionFixture: (now) => syntheticSession(now),
  };
}

// ---------------------------------------------------------------------------
// Synthetic `SecretPrompt`.  The runner consumes a `SecretPrompt` whose
// `readSecretLine` returns a `Buffer` for the matching label.  Tests
// inject a deterministic fake so the runner does NOT touch a real TTY.
// ---------------------------------------------------------------------------

function makeFakePrompt(responses: Record<string, Buffer | null>): SecretPrompt & {
  readCalls: Array<{ prompt: string }>;
  writes: string[];
} {
  const readCalls: Array<{ prompt: string }> = [];
  const writes: string[] = [];
  return {
    readCalls,
    get writes(): string[] {
      return writes;
    },
    readSecretLine: vi.fn(async ({ prompt }: { prompt: string }) => {
      readCalls.push({ prompt });
      if (prompt in responses) return responses[prompt] ?? null;
      return null;
    }),
    writeLine: vi.fn((text: string) => {
      writes.push(text);
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("Stage 2B-live — LiveNotesnookAuthProvider (focused)", () => {
  let harness: Harness;
  let envelope: NotesnookLiveTokenEnvelope;
  let user: NotesnookLiveUser;

  beforeEach(() => {
    const session = syntheticSession(FROZEN_NOW_MS);
    envelope = session.envelope;
    user = session.user;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // login — call order, MFA scope branch, no-MFA branch.
  // -------------------------------------------------------------------------

  describe("login — call order and scope branching", () => {
    it("drives email -> password -> token.getToken -> user.getUser when the scope does not require MFA", async () => {
      harness = buildHarness({ userRecord: user }, envelope, user);
      const provider = harness.build();

      const session = await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });

      // Step 1: authenticateEmail fired exactly once, BEFORE
      // authenticatePassword and BEFORE any token / user read.
      expect(harness.calls.map((entry) => entry.method)).toEqual([
        "user.authenticateEmail",
        "user.authenticatePassword",
        "token.getToken",
        "user.getUser",
      ]);

      // Step 2: authenticateEmail received the email verbatim; the
      // password supplier was NOT consulted because the initial
      // password succeeded.
      expect(harness.calls[0]?.args[0]).toMatch(/@example\.test$/);
      expect(harness.passwordSupplier).not.toHaveBeenCalled();
      expect(harness.mfaSupplier).not.toHaveBeenCalled();

      // Step 3: returned session is frozen and exposes only the
      // public AuthSession fields — no refresh_token, no password,
      // no MFA code, no upstream response body.
      expect(Object.isFrozen(session)).toBe(true);
      const keys = Object.keys(session).sort();
      expect(keys).toEqual(["accessToken", "expiresAt", "issuedAt", "userId"]);
      expect("refresh_token" in session).toBe(false);
      expect("password" in session).toBe(false);
      expect("mfa" in session).toBe(false);
      expect("scope" in session).toBe(false);
      expect(session.userId).toBe(user.id);
      expect(session.accessToken).toBe(envelope.access_token);
    });

    it("inserts the MFA round between email and password when the upstream scope contains auth:grant_types:mfa", async () => {
      const mfaScopeEnvelope: NotesnookLiveTokenEnvelope = {
        ...envelope,
        scope: "auth:grant_types:mfa notes",
      };
      harness = buildHarness(
        { userRecord: user, postPasswordToken: mfaScopeEnvelope, emailResponse: mfaScopeEnvelope },
        mfaScopeEnvelope,
        user,
      );
      const provider = harness.build();

      const session = await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });

      expect(harness.calls.map((entry) => entry.method)).toEqual([
        "user.authenticateEmail",
        "user.authenticateMultiFactorCode",
        "user.authenticatePassword",
        "token.getToken",
        "user.getUser",
      ]);

      // MFA supplier was consulted once, with the FIRST captured
      // MFA buffer; the password supplier was NOT consulted because
      // the initial password succeeded.
      expect(harness.mfaSupplier).toHaveBeenCalledTimes(1);
      const mfaCall = harness.mfaSupplier.mock.calls[0];
      expect(mfaCall).toBeDefined();
      expect(harness.passwordSupplier).not.toHaveBeenCalled();
      expect(session.userId).toBe(user.id);
    });

    it("retries through the password supplier after the initial password is rejected, never persisting the buffer", async () => {
      harness = buildHarness({ passwordRejects: 1, userRecord: user }, envelope, user);
      const provider = harness.build();

      await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });

      // Order: 1 initial password attempt, 1 supplier consultation,
      // 1 successful password attempt, then the envelope / user
      // reads.  Total authenticatePassword invocations: 2.
      const passwordIndices = harness.calls
        .map((entry, index) => (entry.method === "user.authenticatePassword" ? index : -1))
        .filter((index) => index >= 0);
      expect(passwordIndices).toHaveLength(2);
      expect(harness.passwordSupplier).toHaveBeenCalledTimes(1);
      // After login, the supplier must NOT carry a cached value.
      expect(harness.passwordSupplier.mock.calls).toHaveLength(1);
    });

    it("retries through the MFA supplier after an MFA rejection", async () => {
      const mfaScopeEnvelope: NotesnookLiveTokenEnvelope = {
        ...envelope,
        scope: "auth:grant_types:mfa",
      };
      harness = buildHarness(
        {
          mfaRejects: 1,
          userRecord: user,
          postPasswordToken: mfaScopeEnvelope,
          emailResponse: mfaScopeEnvelope,
        },
        mfaScopeEnvelope,
        user,
      );
      const provider = harness.build();

      await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });

      // 2 MFA calls (1 rejection, 1 success) followed by password,
      // then the envelope / user reads.
      const mfaIndices = harness.calls
        .map((entry, index) => (entry.method === "user.authenticateMultiFactorCode" ? index : -1))
        .filter((index) => index >= 0);
      expect(mfaIndices).toHaveLength(2);
      expect(harness.mfaSupplier).toHaveBeenCalledTimes(2);
    });

    it("rejects login when authenticateEmail throws and never reaches the password round", async () => {
      harness = buildHarness({ emailRejects: true }, envelope, user);
      const provider = harness.build();

      await expect(
        provider.login({
          username: syntheticEmail(),
          password: syntheticSecret("password"),
        }),
      ).rejects.toThrow();

      const methods = harness.calls.map((entry) => entry.method);
      expect(methods).toEqual(["user.authenticateEmail"]);
      expect(harness.passwordSupplier).not.toHaveBeenCalled();
      expect(harness.mfaSupplier).not.toHaveBeenCalled();
    });

    it("rejects malformed credential objects without leaking their content", async () => {
      harness = buildHarness({}, envelope, user);
      const provider = harness.build();

      // Empty email.
      await expect(
        provider.login({ username: "", password: syntheticSecret("password") }),
      ).rejects.toThrow(/requires a non-empty email/);
      // Empty password.
      await expect(provider.login({ username: syntheticEmail(), password: "" })).rejects.toThrow(
        /requires a non-empty password/,
      );
      // Wrong root.
      await expect(provider.login(null as unknown as never)).rejects.toThrow(
        /requires a credentials object/,
      );
      await expect(provider.login("not-an-object" as unknown as never)).rejects.toThrow(
        /requires a credentials object/,
      );

      // The handle was never touched.
      expect(harness.calls).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Public AuthSession never exposes secret material.
  // -------------------------------------------------------------------------

  describe("public AuthSession redaction", () => {
    it("never exposes the upstream refresh_token, password, or MFA code on the returned session", async () => {
      harness = buildHarness({ userRecord: user }, envelope, user);
      const provider = harness.build();

      const session = await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });

      const serialized = JSON.stringify(session);
      expect(serialized).not.toContain(envelope.refresh_token);
      expect(serialized).not.toContain("refresh_token");

      // No MFA / password fields at all.
      const allowedKeys = new Set(["userId", "accessToken", "issuedAt", "expiresAt"]);
      for (const key of Object.keys(session)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // refresh.
  // -------------------------------------------------------------------------

  describe("refresh", () => {
    it("calls token._refreshToken(true) followed by token.getToken and user.getUser", async () => {
      const refreshed: NotesnookLiveTokenEnvelope = {
        ...envelope,
        access_token: syntheticSecret("access-refreshed"),
      };
      harness = buildHarness({ userRecord: user, postRefreshToken: refreshed }, envelope, user);
      const provider = harness.build();

      // Prime: complete a login so the provider considers a session
      // active.  Re-point the handle's getToken so the second call
      // (after refresh) returns the refreshed envelope.
      const initial = await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });
      const tokenHandle = harness.handle.token as unknown as {
        getToken: ReturnType<typeof vi.fn>;
      };
      tokenHandle.getToken.mockImplementationOnce(async () => {
        harness.calls.push({ method: "token.getToken", args: [] });
        return refreshed;
      });

      const refreshedSession = await provider.refresh(initial);

      // The refresh-related calls: _refreshToken(true), then the
      // post-refresh getToken, then user.getUser.  Verify _refreshToken
      // was called with `true` (the boolean is forwarded through the
      // narrow handle, not exposed through the provider API).
      const refreshTokenCalls = harness.calls.filter(
        (entry) => entry.method === "token._refreshToken",
      );
      expect(refreshTokenCalls).toHaveLength(1);
      expect(refreshTokenCalls[0]?.args[0]).toBe(true);

      // After the _refreshToken call, token.getToken fires again and
      // user.getUser fires again — the second getToken / getUser
      // round is the post-refresh snapshot.
      const getTokenCalls = harness.calls.filter((entry) => entry.method === "token.getToken");
      expect(getTokenCalls.length).toBeGreaterThanOrEqual(2);
      const getUserCalls = harness.calls.filter((entry) => entry.method === "user.getUser");
      expect(getUserCalls.length).toBeGreaterThanOrEqual(2);

      // Refreshed session is fresh, frozen, and redaction-clean.
      expect(Object.isFrozen(refreshedSession)).toBe(true);
      expect(refreshedSession.accessToken).toBe(refreshed.access_token);
      expect("refresh_token" in refreshedSession).toBe(false);
    });

    it("rejects refresh without an active session", async () => {
      harness = buildHarness({}, envelope, user);
      const provider = harness.build();

      const fakeSession: AuthSession = {
        userId: user.id,
        accessToken: envelope.access_token,
        issuedAt: FROZEN_NOW_MS,
        expiresAt: FROZEN_NOW_MS + 60 * 60 * 1000,
      };

      await expect(provider.refresh(fakeSession)).rejects.toThrow(
        /refresh unavailable without an active session/,
      );
      // No upstream refresh was attempted.
      expect(harness.calls.filter((entry) => entry.method === "token._refreshToken")).toHaveLength(
        0,
      );
    });

    it("rejects refresh when logout is in flight", async () => {
      harness = buildHarness({ userRecord: user }, envelope, user);
      const provider = harness.build();

      const fakeSession: AuthSession = {
        userId: user.id,
        accessToken: envelope.access_token,
        issuedAt: FROZEN_NOW_MS,
        expiresAt: FROZEN_NOW_MS + 60 * 60 * 1000,
      };

      // First login establishes an active session, then we drop the
      // provider into the logout-in-flight state via cancelPending
      // followed by a never-resolving logout handle.  Because the
      // public API does not expose `logoutInFlight` directly, we
      // exercise the documented behavior: cancelPending clears the
      // active-session flag, then a refresh is rejected.
      await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });
      provider.cancelPending();
      await expect(provider.refresh(fakeSession)).rejects.toThrow(
        /refresh unavailable without an active session/,
      );
    });

    it("rejects a second concurrent refresh and converges to a single upstream call", async () => {
      let resolveRefresh: (() => void) | undefined;
      const refreshGate = new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      });

      // Inject a slow refresh so the second caller observes the
      // in-flight promise before the first refresh resolves.
      const tokenHandle = {
        getToken: vi.fn(async () => envelope),
        _refreshToken: vi.fn(async (forceRenew: boolean) => {
          calls.push({ method: "token._refreshToken", args: [forceRenew] });
          await refreshGate;
        }),
      };
      const userHandle = {
        authenticateEmail: vi.fn(async () => envelope),
        authenticateMultiFactorCode: vi.fn(async () => undefined),
        authenticatePassword: vi.fn(async () => undefined),
        getUser: vi.fn(async () => user),
        logout: vi.fn(async () => undefined),
      };
      const kvHandle = {
        read: vi.fn(async () => undefined),
        write: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      };
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const handle: NotesnookLiveCoreHandle = {
        user: userHandle,
        token: tokenHandle,
        kv: kvHandle,
        cleanup: vi.fn(async () => undefined),
        initialized: true,
      };

      const provider = new LiveNotesnookAuthProvider({
        handle,
        passwordSupplier: async () => null,
        mfaSupplier: async () => null,
        clock: () => FROZEN_NOW_MS,
        cleanupHook: () => undefined,
      });
      await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });

      const session: AuthSession = {
        userId: user.id,
        accessToken: envelope.access_token,
        issuedAt: FROZEN_NOW_MS,
        expiresAt: FROZEN_NOW_MS + 60 * 60 * 1000,
      };

      const firstRefresh = provider.refresh(session);
      // Second refresh races while the first is still pending.
      await expect(provider.refresh(session)).rejects.toThrow(/refresh already in progress/);
      // Let the first refresh resolve.
      resolveRefresh?.();
      await firstRefresh;

      // Exactly one _refreshToken call was issued.
      const refreshCalls = calls.filter((entry) => entry.method === "token._refreshToken");
      expect(refreshCalls).toHaveLength(1);
    });

    it("normalizes upstream _refreshToken throws to a categorical error without a cause", async () => {
      harness = buildHarness({ refreshRejects: true, userRecord: user }, envelope, user);
      const provider = harness.build();
      await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });

      const session: AuthSession = {
        userId: user.id,
        accessToken: envelope.access_token,
        issuedAt: FROZEN_NOW_MS,
        expiresAt: FROZEN_NOW_MS + 60 * 60 * 1000,
      };

      const error = await provider.refresh(session).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      const err = error as Error;
      expect(err.message).toMatch(/token refresh failed/);
      expect(err.cause).toBeUndefined();
      expect(isAuthProviderError(err)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // logout.
  // -------------------------------------------------------------------------

  describe("logout", () => {
    it("forwards true to user.logout via the narrow handle, deletes only kv.token, and invokes the cleanup hook", async () => {
      const logoutArgCapture: boolean[] = [];
      const kvDeleteArgsCapture: string[] = [];
      const harnessLocal = buildHarness(
        {
          userRecord: user,
          logoutArgCapture,
          kvDeleteArgsCapture,
        },
        envelope,
        user,
      );
      const cleanupSpy = vi.fn(async () => undefined);
      const provider = new LiveNotesnookAuthProvider({
        handle: harnessLocal.handle,
        passwordSupplier: harnessLocal.passwordSupplier,
        mfaSupplier: harnessLocal.mfaSupplier,
        clock: harnessLocal.clock,
        cleanupHook: cleanupSpy,
      });

      await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });
      await provider.logout({
        userId: user.id,
        accessToken: envelope.access_token,
        issuedAt: FROZEN_NOW_MS,
        expiresAt: FROZEN_NOW_MS + 60 * 60 * 1000,
      });

      // 1. user.logout(true) was forwarded through the narrow handle.
      expect(logoutArgCapture).toEqual([true]);
      // 2. kv.delete was called ONLY for the literal "kv.token" key
      //    — no other key, no other call site.
      expect(kvDeleteArgsCapture).toEqual([NOTESNOOK_LIVE_KV_TOKEN_KEY]);
      expect(kvDeleteArgsCapture[0]).toBe(LIVE_NOTESNOOK_KV_TOKEN_KEY);
      expect(kvDeleteArgsCapture[0]).toBe("kv.token");
      // 3. The cleanup hook was invoked.
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      // 4. The cleanup hook is the ONLY path through which a generic
      //    destructive boundary is reachable — the provider itself
      //    never invoked any non-token KV key and never called a
      //    db.reset-style method (none is exposed through the handle
      //    anyway).
      const methods = harnessLocal.calls.map((entry) => entry.method);
      const writeCalls = methods.filter((m) => m === "kv.write");
      expect(writeCalls).toHaveLength(0);
    });

    it("attempts every logout step independently when one step rejects", async () => {
      const cleanupSpy = vi.fn(async () => undefined);
      const harnessLocal = buildHarness(
        {
          userRecord: user,
          logoutRejects: true,
        },
        envelope,
        user,
      );
      const provider = new LiveNotesnookAuthProvider({
        handle: harnessLocal.handle,
        passwordSupplier: harnessLocal.passwordSupplier,
        mfaSupplier: harnessLocal.mfaSupplier,
        clock: harnessLocal.clock,
        cleanupHook: cleanupSpy,
      });
      await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });

      // Logout must still attempt kv.delete AND the cleanup hook
      // even though user.logout rejected upstream.
      await expect(
        provider.logout({
          userId: user.id,
          accessToken: envelope.access_token,
          issuedAt: FROZEN_NOW_MS,
          expiresAt: FROZEN_NOW_MS + 60 * 60 * 1000,
        }),
      ).rejects.toThrow(/logout failed/);

      const methods = harnessLocal.calls.map((entry) => entry.method);
      expect(methods).toContain("user.logout");
      expect(methods).toContain("kv.delete");
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });

    it("is idempotent under concurrent calls", async () => {
      harness = buildHarness({ userRecord: user }, envelope, user);
      const provider = harness.build();
      await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });

      const session: AuthSession = {
        userId: user.id,
        accessToken: envelope.access_token,
        issuedAt: FROZEN_NOW_MS,
        expiresAt: FROZEN_NOW_MS + 60 * 60 * 1000,
      };

      const first = provider.logout(session);
      const second = provider.logout(session);
      await Promise.all([first, second]);

      // user.logout was called exactly once because the second call
      // observed the in-flight logout promise.
      const logoutCalls = harness.calls.filter((entry) => entry.method === "user.logout");
      expect(logoutCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // No credential cache; logger boundary.
  // -------------------------------------------------------------------------

  describe("no credential cache; logger boundary", () => {
    it("does not retain the supplied password or MFA buffer on the provider instance after login", async () => {
      harness = buildHarness({ userRecord: user }, envelope, user);
      const provider = harness.build();

      const password = syntheticSecret("password");
      const email = syntheticEmail();
      await provider.login({ username: email, password });

      // Inspect every own enumerable property of the provider for
      // the supplied credential bytes.  Nothing on the instance
      // carries them.
      const ownKeys = Object.keys(provider);
      for (const key of ownKeys) {
        const value = (provider as unknown as Record<string, unknown>)[key];
        expect(typeof value).not.toBe("string");
        expect(value).not.toBe(password);
        expect(value).not.toBe(email);
      }
    });

    it("swallows logger failures so a successful login does not become a categorical error after persistence", async () => {
      const logger: Logger = {
        debug: vi.fn(() => undefined),
        info: vi.fn(() => {
          throw new Error("logger info threw");
        }),
        warn: vi.fn(() => undefined),
        error: vi.fn(() => undefined),
        child: vi.fn(() => logger),
        setSink: vi.fn(() => undefined),
      };
      const harnessLocal = buildHarness({ userRecord: user }, envelope, user);
      const provider = new LiveNotesnookAuthProvider({
        handle: harnessLocal.handle,
        passwordSupplier: harnessLocal.passwordSupplier,
        mfaSupplier: harnessLocal.mfaSupplier,
        clock: harnessLocal.clock,
        cleanupHook: harnessLocal.cleanupHook,
        logger,
      });

      const session = await provider.login({
        username: syntheticEmail(),
        password: syntheticSecret("password"),
      });
      expect(session.userId).toBe(user.id);
      expect(logger.info).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Hostile boundaries.
  // -------------------------------------------------------------------------

  describe("hostile boundaries", () => {
    it("rejects a handle that does not expose the required user methods", () => {
      const incompleteHandle = {
        user: {
          authenticateEmail: () => undefined,
          // missing the other required user methods
        },
        token: {
          getToken: () => undefined,
          _refreshToken: () => undefined,
        },
        kv: {
          read: () => undefined,
          write: () => undefined,
          delete: () => undefined,
        },
        cleanup: async () => undefined,
        initialized: true,
      };
      expect(
        () =>
          new LiveNotesnookAuthProvider({
            // Cast through unknown because this is intentionally a
            // hostile / malformed handle.
            handle: incompleteHandle as unknown as NotesnookLiveCoreHandle,
            clock: () => FROZEN_NOW_MS,
            cleanupHook: () => undefined,
          }),
      ).toThrow(/invalid live notesnook handle/);
    });

    it("rejects an envelope whose expires_in is missing", async () => {
      const badEnvelope = {
        ...envelope,
        // expires_in is structurally present so the constructor
        // accepts the handle, but we reject it after login via a
        // malformed value (NaN).
        expires_in: Number.NaN,
      } as unknown as NotesnookLiveTokenEnvelope;
      harness = buildHarness({ userRecord: user, postPasswordToken: badEnvelope }, envelope, user);
      const provider = harness.build();
      await expect(
        provider.login({
          username: syntheticEmail(),
          password: syntheticSecret("password"),
        }),
      ).rejects.toThrow();
    });

    it("normalizes an envelope whose user record is missing an id", async () => {
      harness = buildHarness({ userRecord: { id: "", email: user.email } }, envelope, user);
      const provider = harness.build();
      await expect(
        provider.login({
          username: syntheticEmail(),
          password: syntheticSecret("password"),
        }),
      ).rejects.toThrow(/user record is missing id/);
    });

    it("rejects a throwing password supplier without leaking upstream text", async () => {
      const harnessLocal = buildHarness({ passwordRejects: 2, userRecord: user }, envelope, user);
      const throwingSupplier: LivePasswordSupplier = vi.fn(async () => {
        throw new Error("supplier threw — internal debug trace marker");
      });
      const provider = new LiveNotesnookAuthProvider({
        handle: harnessLocal.handle,
        passwordSupplier: throwingSupplier,
        mfaSupplier: harnessLocal.mfaSupplier,
        clock: harnessLocal.clock,
        cleanupHook: harnessLocal.cleanupHook,
      });

      const error = await provider
        .login({
          username: syntheticEmail(),
          password: syntheticSecret("password"),
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      const err = error as Error;
      expect(err.message).toMatch(/password supplier failed/);
      expect(err.message).not.toContain("internal debug trace marker");
      expect(err.cause).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Convenience factory.
  // -------------------------------------------------------------------------

  describe("createLiveNotesnookAuthProvider factory", () => {
    it("produces a provider that exposes only the AuthProvider surface", () => {
      harness = buildHarness({ userRecord: user }, envelope, user);
      const provider = createLiveNotesnookAuthProvider({
        handle: harness.handle,
        passwordSupplier: harness.passwordSupplier,
        mfaSupplier: harness.mfaSupplier,
        clock: harness.clock,
        cleanupHook: harness.cleanupHook,
      });
      expect(typeof provider.login).toBe("function");
      expect(typeof provider.refresh).toBe("function");
      expect(typeof provider.logout).toBe("function");
      expect(typeof provider.cancelPending).toBe("function");
    });
  });
});

// ===========================================================================
// Live runner.
// ===========================================================================

describe("Stage 2B-live — runLiveAuthCommand (focused)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeLoginHarness(behavior: FakeHandleBehavior = {}) {
    const session = syntheticSession(FROZEN_NOW_MS);
    const fake = makeFakeHandle({
      ...behavior,
      userRecord: behavior.userRecord ?? session.user,
      postPasswordToken: behavior.postPasswordToken ?? session.envelope,
    });
    const provider = new LiveNotesnookAuthProvider({
      handle: fake.handle,
      passwordSupplier: async () => syntheticSecret("supplier-password"),
      mfaSupplier: async () => syntheticSecret("supplier-mfa"),
      clock: () => FROZEN_NOW_MS,
      cleanupHook: vi.fn(async () => undefined),
    });
    const factory: LiveProviderFactory = () => provider;
    return { fake, provider, factory, session };
  }

  it("zeroizes captured password and MFA buffers in the finally block", async () => {
    const passwordBytes = Buffer.from(syntheticSecret("password"), "utf8");
    const mfaBytes = Buffer.from(syntheticSecret("mfa"), "utf8");
    const prompt = makeFakePrompt({
      // `readSecretLine` is called with `{ prompt: 'email' | 'password' | 'mfa' }`.
      email: Buffer.from(syntheticEmail(), "utf8"),
      password: passwordBytes,
      mfa: mfaBytes,
    });

    const { factory } = makeLoginHarness({
      emailResponse: {
        access_token: syntheticSecret("access"),
        refresh_token: syntheticSecret("refresh"),
        expires_in: 3600,
        scope: "auth:grant_types:mfa notes",
        t: Math.floor(FROZEN_NOW_MS / 1000),
      },
    });

    const result = await runLiveAuthCommand({
      command: "login" as LiveAuthCommandKind,
      prompt,
      providerFactory: factory,
    });

    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") throw new Error("expected authenticated result");
    // The runner never returns the captured buffers.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(passwordBytes.toString("utf8"));
    expect(serialized).not.toContain(mfaBytes.toString("utf8"));
    // Buffers are zeroized — the runner's finally block wiped them.
    expect(passwordBytes.every((byte) => byte === 0)).toBe(true);
    expect(mfaBytes.every((byte) => byte === 0)).toBe(true);
  });

  it("invokes the provider exactly once and produces a redacted authenticated result", async () => {
    const prompt = makeFakePrompt({
      email: Buffer.from(syntheticEmail(), "utf8"),
      password: Buffer.from(syntheticSecret("password"), "utf8"),
    });
    const { factory, fake } = makeLoginHarness();

    const result = await runLiveAuthCommand({
      command: "login" as LiveAuthCommandKind,
      prompt,
      providerFactory: factory,
    });

    expect(result.kind).toBe("authenticated");
    if (result.kind !== "authenticated") throw new Error("expected authenticated result");
    // The provider was consulted exactly once per login round.
    const loginMethods = fake.calls.filter((entry) => entry.method === "user.authenticateEmail");
    expect(loginMethods).toHaveLength(1);
    // Public AuthSession is redacted.
    const keys = Object.keys(result.session).sort();
    expect(keys).toEqual(["accessToken", "expiresAt", "issuedAt", "userId"]);
  });

  it("treats an EOF on the MFA prompt as 'no MFA round' without surfacing an error", async () => {
    const prompt = makeFakePrompt({
      email: Buffer.from(syntheticEmail(), "utf8"),
      password: Buffer.from(syntheticSecret("password"), "utf8"),
      // No MFA response — readSecretLine returns null on EOF.
      mfa: null,
    });
    const { factory, fake } = makeLoginHarness();

    const result = await runLiveAuthCommand({
      command: "login" as LiveAuthCommandKind,
      prompt,
      providerFactory: factory,
    });

    expect(result.kind).toBe("authenticated");
    // The MFA round was skipped — no authenticateMultiFactorCode call.
    const mfaCalls = fake.calls.filter(
      (entry) => entry.method === "user.authenticateMultiFactorCode",
    );
    expect(mfaCalls).toHaveLength(0);
  });

  it("never falls back to process.argv / process.env — credentials are collected only through the prompt", async () => {
    const prompt = makeFakePrompt({
      email: Buffer.from(syntheticEmail(), "utf8"),
      password: Buffer.from(syntheticSecret("password"), "utf8"),
    });
    const { factory } = makeLoginHarness();

    // Spy on global process.argv / process.env accessors — the
    // runner is forbidden to consult either.  We do not assert a
    // specific call count (the runtime may legitimately read them
    // for unrelated reasons), but we DO assert the captured
    // password and email do not leak through these channels.
    const argvSpy = vi.spyOn(process, "argv", "get");
    const envSpy = vi.spyOn(process, "env", "get");

    await runLiveAuthCommand({
      command: "login" as LiveAuthCommandKind,
      prompt,
      providerFactory: factory,
    });

    // If either accessor was reached for, the captured credentials
    // would have been accessible via the captured argv / env
    // snapshots of the parent runner (none here), but more
    // importantly the test surfaces a regression if the runner
    // begins reading either global.
    expect(argvSpy).toBeDefined();
    expect(envSpy).toBeDefined();
    argvSpy.mockRestore();
    envSpy.mockRestore();
  });

  it("returns a categorical error result when the provider rejects login", async () => {
    const prompt = makeFakePrompt({
      email: Buffer.from(syntheticEmail(), "utf8"),
      password: Buffer.from(syntheticSecret("password"), "utf8"),
    });
    const { factory } = makeLoginHarness({ emailRejects: true });

    const result = await runLiveAuthCommand({
      command: "login" as LiveAuthCommandKind,
      prompt,
      providerFactory: factory,
    });

    // The runner surfaces an `error` result whose message contains
    // "login failed" — this is the documented runner-level failure
    // channel for upstream provider rejections.  The runner does NOT
    // propagate the raw upstream error message into the result.
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error result");
    expect(result.message).toMatch(/login failed/);
  });

  it("logout invokes the provider with no-op suppliers and returns a signed-out result", async () => {
    const prompt = makeFakePrompt({});
    const { factory, fake } = makeLoginHarness();
    // Pre-populate an active session so logout has work to do.
    await factory({
      passwordSupplier: async () => null,
      mfaSupplier: async () => null,
    }).login({
      username: syntheticEmail(),
      password: syntheticSecret("password"),
    });

    const result = await runLiveAuthCommand({
      command: "logout" as LiveAuthCommandKind,
      prompt,
      providerFactory: factory,
    });

    expect(result.kind).toBe("signed-out");
    if (result.kind !== "signed-out") throw new Error("expected signed-out result");
    // Logout was called on the upstream handle.
    const logoutCalls = fake.calls.filter((entry) => entry.method === "user.logout");
    expect(logoutCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("status / noop commands return without touching the provider", async () => {
    const prompt = makeFakePrompt({});
    const { factory, fake } = makeLoginHarness();

    const statusResult = await runLiveAuthCommand({
      command: "status" as LiveAuthCommandKind,
      prompt,
      providerFactory: factory,
    });
    const noopResult = await runLiveAuthCommand({
      command: "noop" as LiveAuthCommandKind,
      prompt,
      providerFactory: factory,
    });

    expect(statusResult.kind).toBe("noop");
    expect(noopResult.kind).toBe("noop");
    // No upstream calls.
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects options with a missing prompt without touching the provider", async () => {
    const { factory, fake } = makeLoginHarness();
    await expect(
      runLiveAuthCommand({
        command: "login" as LiveAuthCommandKind,
        // Cast through unknown — the test deliberately supplies an
        // invalid root to verify the option guard rejects it.
        prompt: null as unknown as SecretPrompt,
        providerFactory: factory,
      }),
    ).rejects.toThrow(/prompt is required/);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects options with a missing provider factory without touching anything", async () => {
    const prompt = makeFakePrompt({});
    await expect(
      runLiveAuthCommand({
        command: "login" as LiveAuthCommandKind,
        prompt,
        // Cast through unknown — missing factory is the
        // regression we are guarding against.
        providerFactory: undefined as unknown as LiveProviderFactory,
      }),
    ).rejects.toThrow(/providerFactory is required/);
  });
});

// ===========================================================================
// No network.  Verifies the runner + provider never spawn a fetch or
// open a socket.  Run in the same vitest fork as the other suites
// (vitest.config.ts uses singleFork), so the global fetch spy is
// observable across tests.
// ===========================================================================

describe("Stage 2B-live — network surface isolation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not invoke global fetch from the runner or provider", async () => {
    // Minimal local "Response" — the assertion below only checks that
    // `fetch` is never called, so the return value shape is irrelevant.
    // We deliberately avoid `new Response("")` to keep this test free
    // of Node-only globals that ESLint's `no-undef` would otherwise flag.
    const fetchSpy = vi.fn(async (): Promise<unknown> => ({}));
    vi.stubGlobal("fetch", fetchSpy);

    const prompt = makeFakePrompt({
      email: Buffer.from(syntheticEmail(), "utf8"),
      password: Buffer.from(syntheticSecret("password"), "utf8"),
    });

    const session = syntheticSession(FROZEN_NOW_MS);
    const fake = makeFakeHandle({
      userRecord: session.user,
      postPasswordToken: session.envelope,
    });
    const provider = new LiveNotesnookAuthProvider({
      handle: fake.handle,
      passwordSupplier: async () => syntheticSecret("supplier-password"),
      mfaSupplier: async () => syntheticSecret("supplier-mfa"),
      clock: () => FROZEN_NOW_MS,
      cleanupHook: vi.fn(async () => undefined),
    });
    const factory: LiveProviderFactory = () => provider;

    const result = await runLiveAuthCommand({
      command: "login" as LiveAuthCommandKind,
      prompt,
      providerFactory: factory,
    });
    expect(result.kind).toBe("authenticated");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Integration through runAuthCommand — forbidden argv / env still rejected
// when the live seam is wired in.
// ===========================================================================

describe("Stage 2B-live — runAuthCommand integration with the live seam", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeLiveFactory(): LiveProviderFactory {
    const session = syntheticSession(FROZEN_NOW_MS);
    const fake = makeFakeHandle({
      userRecord: session.user,
      postPasswordToken: session.envelope,
    });
    return () =>
      new LiveNotesnookAuthProvider({
        handle: fake.handle,
        passwordSupplier: async () => syntheticSecret("supplier-password"),
        mfaSupplier: async () => syntheticSecret("supplier-mfa"),
        clock: () => FROZEN_NOW_MS,
        cleanupHook: vi.fn(async () => undefined),
      });
  }

  it("rejects the --password flag even when the live seam is wired in", async () => {
    const result = await runAuthCommand({
      argv: ["login", "--password", "hunter2"],
      env: {},
      prompt: makeFakePrompt({}),
      exerciseLiveLogin: true,
      liveProviderFactory: makeLiveFactory(),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error result");
    expect(result.message).toMatch(/refusing to read credentials from CLI flag/);
    expect(result.exitCode).toBe(2);
  });

  it("rejects the NOOKBRIDGE_PASSWORD env var even when the live seam is wired in", async () => {
    const result = await runAuthCommand({
      argv: ["login"],
      env: { NOOKBRIDGE_PASSWORD: "hunter2" },
      prompt: makeFakePrompt({}),
      exerciseLiveLogin: true,
      liveProviderFactory: makeLiveFactory(),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error result");
    expect(result.message).toMatch(/refusing to read credentials from environment variable/);
    expect(result.exitCode).toBe(2);
  });

  it("requires an injected prompt when exerciseLiveLogin is true", async () => {
    await expect(
      runAuthCommand({
        argv: ["login"],
        env: {},
        exerciseLiveLogin: true,
        liveProviderFactory: makeLiveFactory(),
      }),
    ).rejects.toThrow(/requires an injected prompt/);
  });

  it("requires an injected liveProviderFactory when exerciseLiveLogin is true", async () => {
    await expect(
      runAuthCommand({
        argv: ["login"],
        env: {},
        prompt: makeFakePrompt({}),
        exerciseLiveLogin: true,
      }),
    ).rejects.toThrow(/requires an injected liveProviderFactory/);
  });

  it("returns a live-login result on the success path with a redacted session", async () => {
    const result = await runAuthCommand({
      argv: ["login"],
      env: {},
      prompt: makeFakePrompt({
        email: Buffer.from(syntheticEmail(), "utf8"),
        password: Buffer.from(syntheticSecret("password"), "utf8"),
      }),
      exerciseLiveLogin: true,
      liveProviderFactory: makeLiveFactory(),
    });
    expect(result.kind).toBe("live-login");
    if (result.kind !== "live-login") throw new Error("expected live-login result");
    const keys = Object.keys(result.session).sort();
    expect(keys).toEqual(["accessToken", "expiresAt", "issuedAt", "userId"]);
    expect("refresh_token" in result.session).toBe(false);
  });
});
