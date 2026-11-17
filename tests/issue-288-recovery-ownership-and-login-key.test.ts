// Issue #288: recovery must leave state the service user can open, and
// live-login must read the production key from the systemd credential slot.

import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  liveLoginKeysFromEnvironment,
  PRODUCTION_STATE_DIR_FOR_KEYS,
  withLiveLoginKeys,
  createProductionLiveLoginRuntime,
} from "../src/auth/live-login-runtime.js";
import { alignFreshMemberOwnership } from "../src/operator/recover-bundle.js";

const KEY = "issue-288-test-key";

function credentialsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nb288-cred-"));
  writeFileSync(join(dir, "nookbridge-db-key"), KEY, { mode: 0o600 });
  return dir;
}

describe("issue #288 — fresh members match the state root", () => {
  it("sets fresh required members to mode 0600 and the root's owner", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nb288-state-"));
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // Stand in for fresh members created with a permissive mode.
    for (const name of ["nookbridge-storage.db", "notesnook.db"]) {
      writeFileSync(join(stateDir, name), "x", { mode: 0o644 });
    }

    expect(alignFreshMemberOwnership(stateDir)).toBe(true);

    const rootUid = statSync(stateDir).uid;
    for (const name of ["nookbridge-storage.db", "notesnook.db"]) {
      const st = statSync(join(stateDir, name));
      expect(st.mode & 0o777).toBe(0o600);
      expect(st.uid).toBe(rootUid);
    }
  });

  it("hands every fresh member the state root's uid and gid", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nb288-chown-"));
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    for (const name of ["nookbridge-storage.db", "notesnook.db"]) {
      writeFileSync(join(stateDir, name), "x", { mode: 0o600 });
    }
    const root = statSync(stateDir);
    const calls: Array<[string, number, number]> = [];
    const spy = (path: string, uid: number, gid: number): void => {
      calls.push([path, uid, gid]);
    };

    expect(alignFreshMemberOwnership(stateDir, spy)).toBe(true);

    expect(calls).toEqual([
      [join(stateDir, "nookbridge-storage.db"), root.uid, root.gid],
      [join(stateDir, "notesnook.db"), root.uid, root.gid],
    ]);
  });

  it("reports failure instead of succeeding when a member is missing", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nb288-missing-"));
    expect(alignFreshMemberOwnership(stateDir)).toBe(false);
  });
});

describe("issue #288 — live-login reads the systemd credential key", () => {
  it("returns no key store when CREDENTIALS_DIRECTORY is unset", () => {
    expect(liveLoginKeysFromEnvironment({})).toBeUndefined();
    expect(liveLoginKeysFromEnvironment({ CREDENTIALS_DIRECTORY: "" })).toBeUndefined();
  });

  it("reads the key from $CREDENTIALS_DIRECTORY/nookbridge-db-key", () => {
    const keys = liveLoginKeysFromEnvironment({ CREDENTIALS_DIRECTORY: credentialsDir() });
    expect(keys).toBeDefined();
    expect(keys?.getDatabaseKey()).toBe(KEY);
  });

  it("withLiveLoginKeys leaves options untouched without a credential directory", () => {
    const options = { stateDir: "/tmp/somewhere" };
    expect(withLiveLoginKeys(options, {})).toBe(options);
  });

  it("withLiveLoginKeys adds the systemd key store when a credential directory exists", () => {
    const out = withLiveLoginKeys(
      { stateDir: "/tmp/somewhere" },
      { CREDENTIALS_DIRECTORY: credentialsDir() },
    );
    expect(out.keys?.getDatabaseKey()).toBe(KEY);
  });

  it("refuses to mint a development key for the production state directory", async () => {
    expect(PRODUCTION_STATE_DIR_FOR_KEYS).toBe("/var/lib/nookbridge");
    await expect(
      createProductionLiveLoginRuntime({ stateDir: PRODUCTION_STATE_DIR_FOR_KEYS }),
    ).rejects.toThrow("production state requires the systemd credential key");
  });
});
