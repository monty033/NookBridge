/**
 * Stage 2B-live — deterministic fake Notesnook UserManager/TokenManager
 * core fixture.
 *
 * The fixture models an in-memory Notesnook server + an injected
 * database handle whose surface mirrors the upstream
 * `@notesnook/core@8.1.3` UserManager/TokenManager contract documented
 * in `docs/upstream-contract.md`.  It is the ONLY place we ever call a
 * fake authenticateEmail / authenticateMultiFactorCode /
 * authenticatePassword / _refreshToken / logout: the production code
 * never speaks to a real Notesnook account.
 *
 * Every test value (password, MFA code, access token, refresh token)
 * is generated at runtime by this fixture; nothing committed to the
 * repository is a real secret.
 */

import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { IStorage } from "../../src/storage/istorage.js";
import type { NotesnookDatabaseHandle } from "../../src/auth/notesnook-auth-provider.js";

/**
 * Internal persisted shape for the fake Notesnook token envelope.
 * Mirrors the verified upstream shape:
 *   { access_token, t, expires_in, scope, refresh_token }
 */
export type FakeNotesnookToken = Readonly<{
  access_token: string;
  t: number;
  expires_in: number;
  scope: string;
  refresh_token: string;
}>;

/**
 * Public, narrowed shape of the database handle the
 * `NotesnookAuthProvider` consumes.  Kept in sync with the real
 * production type but exposed here for test ergonomics.  The
 * call-journal lives on the fixture (not on the handle) so it does
 * not leak through the production-shaped type.
 */
export type FakeCoreHandle = NotesnookDatabaseHandle;

/**
 * A single call into the fake core.  Only the methods the
 * NotesnookAuthProvider needs are enumerated; any other method
 * recorded here is a test-side bug.
 */
export type FakeCoreCall =
  | { method: "authenticateEmail"; args: [string] }
  | { method: "authenticateMultiFactorCode"; args: [string, "app"] }
  | { method: "authenticatePassword"; args: [string, string] }
  | { method: "_refreshToken"; args: [boolean] }
  | { method: "logout"; args: [boolean] }
  | { method: "getUser"; args: [] };

/**
 * Modes the fake core supports.  Each mode models a distinct scenario
 * from the Stage 2B-live plan; the provider is required to drive them
 * deterministically.
 */
export type FakeCoreMode =
  | "no-mfa"
  | "mfa-required"
  | "mfa-retry"
  | "password-retry"
  | "refresh-fails"
  | "malformed-token";

/**
 * A bag of configuration knobs the fixture exposes to the test
 * author.  Every option has a sane default and never requires the
 * caller to construct a Notesnook account, environment, or upstream
 * module instance.
 */
export type FakeCoreFixtureOptions = Readonly<{
  mode?: FakeCoreMode;
  /**
   * Logical time the fixture considers "now" (milliseconds).  Tests
   * bump this to simulate the access token going past its expiry.
   */
  now?: number;
  /** Access-token TTL in ms.  Defaults to one hour.  Negative values
   *  produce envelopes whose `expires_in` would be `<= 0`; the
   *  envelope itself remains structurally valid and is used by the
   *  provider's "already-expired" guard tests. */
  accessTokenTtlMs?: number;
  /** Optional simulated delay applied to `_refreshToken`. */
  refreshDelayMs?: number;
  /**
   * Optional IStorage to use as the envelope backend.  When omitted
   * the fixture spins up a tiny in-memory IStorage.  The production
   * code path always passes a real PersistentStorage — the test
   * surface keeps the choice explicit so both code paths are covered.
   */
  storage?: IStorage;
}>;

/**
 * Public interface of the fake-core bundle a test owns.
 */
export type FakeCoreFixture = {
  handle: FakeCoreHandle;
  /**
   * The IStorage backing the fake core's `tokenManager.getToken()`
   * and the envelope the provider writes through `kv.token`.  When
   * the caller passes a PersistentStorage via `options.storage` this
   * field points at that PersistentStorage; otherwise it points at a
   * fixture-owned in-memory IStorage.  Tests that want to assert
   * persistence behaviour pass the PersistentStorage here AND use the
   * same reference for the provider.
   */
  storage: IStorage;
  /**
   * Test-only journal of every call the provider made through the
   * handle.  Surfaced at the fixture level (rather than the handle)
   * so test code reads `fixture.calls` without leaking the property
   * through the production-shaped NotesnookDatabaseHandle type.
   */
  readonly calls: ReadonlyArray<FakeCoreCall>;
  /** Bumpable logical clock — tests set this to simulate elapsed time. */
  now: number;
  /** Test-only mutable buckets used to drive scripted rejection behaviour. */
  mfaCodesToReject: Set<string> | undefined;
  passwordsToReject: Set<string> | undefined;
  /**
   * Tear-down hook — closes any held resources.  Tests that use a
   * shared PersistentStorage must call this AFTER they are done with
   * the fixture but BEFORE they close the storage.
   */
  close: () => void;
};

/**
 * Construct a fake upstream Notesnook server + database handle bundle
 * for a single test.  The handle returned exposes the same surface the
 * production provider consumes, but every method body is a scripted
 * in-memory implementation that records its arguments so tests can
 * assert on call ordering and contents.
 *
 * The fixture never touches the network.  It is the only sanctioned
 * Notesnook-shaped test double in the repository.
 */
export function createFakeCoreFixture(options: FakeCoreFixtureOptions = {}): FakeCoreFixture {
  const mode: FakeCoreMode = options.mode ?? "no-mfa";
  const inMemoryStorage = options.storage ?? createInMemoryStorage();
  const accessTokenTtlMs = options.accessTokenTtlMs ?? 60 * 60 * 1000;
  const refreshDelayMs = options.refreshDelayMs ?? 0;

  // Mutable clock + mutable state buckets.  Declared BEFORE the
  // handle so the handle's method closures can read the live values.
  const nowRef: { value: number } = { value: options.now ?? 1_000 };
  const state: {
    mfaCodesToReject: Set<string> | undefined;
    passwordsToReject: Set<string> | undefined;
  } = {
    mfaCodesToReject: undefined,
    passwordsToReject: undefined,
  };
  const calls: FakeCoreCall[] = [];
  const refreshTokensIssued = new Map<string, { refresh_token: string; issuedAt: number }>();

  function issueTokenForNow(): FakeNotesnookToken {
    return issueToken(scopeForMode(mode), accessTokenTtlMs, refreshTokensIssued, nowRef.value);
  }

  const handle: FakeCoreHandle = {
    user: {
      async authenticateEmail(email: string): Promise<FakeNotesnookToken> {
        calls.push({ method: "authenticateEmail", args: [email] });
        if (mode === "malformed-token") {
          return {
            access_token: "",
            t: 1,
            expires_in: 60,
            scope: "offline_access",
            refresh_token: "",
          } as unknown as FakeNotesnookToken;
        }
        return issueTokenForNow();
      },
      async authenticateMultiFactorCode(code: string, type: "app"): Promise<FakeNotesnookToken> {
        calls.push({ method: "authenticateMultiFactorCode", args: [code, type] });
        if (state.mfaCodesToReject?.has(code)) {
          throw new Error("invalid MFA code");
        }
        return issueTokenForNow();
      },
      async authenticatePassword(email: string, password: string): Promise<FakeNotesnookToken> {
        calls.push({ method: "authenticatePassword", args: [email, password] });
        if (state.passwordsToReject?.has(password)) {
          throw new Error("invalid password");
        }
        return issueTokenForNow();
      },
      async getUser(): Promise<{ id: string; email: string }> {
        calls.push({ method: "getUser", args: [] });
        return { id: `notesnook-user-${randomBytes(8).toString("hex")}`, email: "" };
      },
      async logout(clearLocal: boolean): Promise<void> {
        calls.push({ method: "logout", args: [clearLocal] });
        return;
      },
    },
    tokenManager: {
      async getToken(): Promise<FakeNotesnookToken | undefined> {
        // Read directly from the persisted kv.token envelope so the
        // restoreSession() path sees a hydrated value.
        const envelope = await inMemoryStorage.read<FakeNotesnookToken>("kv.token");
        return envelope;
      },
      async _refreshToken(forceRenew: boolean): Promise<FakeNotesnookToken> {
        calls.push({ method: "_refreshToken", args: [forceRenew] });
        if (refreshDelayMs > 0) {
          await delay(refreshDelayMs);
        }
        if (mode === "refresh-fails") {
          throw new Error("invalid_grant: refresh token revoked");
        }
        return issueTokenForNow();
      },
    },
  };

  // The call journal is exposed at the fixture level (see above) so
  // the production-shaped handle type is not widened with a test-only
  // property.

  // Mutable fixture object: tests bump `now` to simulate elapsed
  // time and poke the rejection buckets.
  const fixture: FakeCoreFixture = {
    handle,
    storage: inMemoryStorage,
    calls,
    get now() {
      return nowRef.value;
    },
    set now(value: number) {
      nowRef.value = value;
    },

    set mfaCodesToReject(value) {
      state.mfaCodesToReject = value;
    },
    get mfaCodesToReject() {
      return state.mfaCodesToReject;
    },
    set passwordsToReject(value) {
      state.passwordsToReject = value;
    },
    get passwordsToReject() {
      return state.passwordsToReject;
    },
    close: () => {
      // No held resources.  The IStorage (if in-memory) is GC'd with
      // the closure; tests using a shared PersistentStorage are
      // responsible for closing that separately.
    },
  };

  return fixture;
}

function issueToken(
  scope: string,
  accessTokenTtlMs: number,
  refreshTokensIssued: Map<string, { refresh_token: string; issuedAt: number }>,
  nowMs: number,
): FakeNotesnookToken {
  const access = `access-${randomBytes(12).toString("hex")}`;
  const refresh = `refresh-${randomBytes(12).toString("hex")}`;
  refreshTokensIssued.set(access, { refresh_token: refresh, issuedAt: nowMs });
  // The upstream `t` field is unix epoch seconds.
  const expiresInSec = Math.floor(accessTokenTtlMs / 1000);
  const tSec = Math.floor(nowMs / 1000);
  return {
    access_token: access,
    t: tSec,
    expires_in: expiresInSec,
    scope,
    refresh_token: refresh,
  };
}

function scopeForMode(mode: FakeCoreMode): string {
  switch (mode) {
    case "mfa-required":
    case "mfa-retry":
      return "auth:grant_types:mfa offline_access";
    case "no-mfa":
    case "password-retry":
    case "refresh-fails":
    case "malformed-token":
      return "offline_access";
  }
}

/**
 * Minimal in-memory IStorage implementation.  Used by the fixture when
 * the caller does not supply a real PersistentStorage — it is the
 * smallest seam that lets the fake core's `tokenManager.getToken()`
 * read back the envelope the fake's upstream calls return.
 */
function createInMemoryStorage(): IStorage {
  const values = new Map<string, unknown>();
  return {
    write: async <T>(key: string, data: T) => {
      values.set(key, data);
    },
    writeMulti: async <T>(entries: [string, T][]) => {
      for (const [k, v] of entries) values.set(k, v);
    },
    read: async <T>(key: string) => values.get(key) as T | undefined,
    readMulti: async <T>(keys: string[]) =>
      keys.map((key) => [key, values.get(key) as T] as [string, T]),
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
      throw new Error("not used by the fake core fixture");
    },
    encryptMulti: async () => {
      throw new Error("not used by the fake core fixture");
    },
    decrypt: async () => {
      throw new Error("not used by the fake core fixture");
    },
    decryptMulti: async () => {
      throw new Error("not used by the fake core fixture");
    },
    deriveCryptoKey: async () => {
      throw new Error("not used by the fake core fixture");
    },
    hash: async () => {
      throw new Error("not used by the fake core fixture");
    },
    getCryptoKey: async () => undefined,
    generateCryptoKey: async () => {
      throw new Error("not used by the fake core fixture");
    },
    generatePGPKeyPair: async () => {
      throw new Error("not used by the fake core fixture");
    },
    decryptPGPMessage: async () => {
      throw new Error("not used by the fake core fixture");
    },
    validatePGPKeyPair: async () => ({ isValid: false, message: "not used" }),
    generateCryptoKeyFallback: async () => {
      throw new Error("not used by the fake core fixture");
    },
    deriveCryptoKeyFallback: async () => {
      throw new Error("not used by the fake core fixture");
    },
  };
}
