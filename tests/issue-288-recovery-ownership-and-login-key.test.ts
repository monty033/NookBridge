// Issue #288: recovery must leave state the service user can open, and
// live-login must read the production key from the systemd credential slot.

import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertNoDevelopmentKeyForProduction,
  liveLoginKeysFromEnvironment,
  PRODUCTION_STATE_DIR_FOR_KEYS,
  withLiveLoginKeys,
} from "../src/auth/live-login-runtime.js";
import { alignFreshMemberOwnership } from "../src/operator/recover-bundle.js";
import { PRODUCTION_STATE_DIR } from "../src/operator/production-runtime.js";

const KEY = "issue-288-test-key";
const MEMBERS = ["nookbridge-storage.db", "notesnook.db"] as const;

function credentialsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nb288-cred-"));
  writeFileSync(join(dir, "nookbridge-db-key"), KEY, { mode: 0o600 });
  return dir;
}

function stateWithMembers(): string {
  const stateDir = mkdtempSync(join(tmpdir(), "nb288-state-"));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const name of MEMBERS) {
    writeFileSync(join(stateDir, name), "x", { mode: 0o644 });
  }
  return stateDir;
}

// Records every descriptor-level change so tests can see what root would do.
function recordingOwnership(): {
  calls: Array<["chown" | "chmod", number, number?]>;
  ownership: Parameters<typeof alignFreshMemberOwnership>[1];
} {
  const calls: Array<["chown" | "chmod", number, number?]> = [];
  return {
    calls,
    ownership: {
      fchown: (_fd: number, uid: number, gid: number) => {
        calls.push(["chown", uid, gid]);
      },
      fchmod: (_fd: number, mode: number) => {
        calls.push(["chmod", mode]);
      },
    },
  };
}

describe("issue #288 — fresh members match the state root", () => {
  it("applies the state root's owner and mode 0600 through each member's descriptor", () => {
    const stateDir = stateWithMembers();
    const root = statSync(stateDir);
    const rec = recordingOwnership();

    expect(alignFreshMemberOwnership(stateDir, rec.ownership)).toBe(true);

    expect(rec.calls).toEqual([
      ["chown", root.uid, root.gid],
      ["chmod", 0o600],
      ["chown", root.uid, root.gid],
      ["chmod", 0o600],
    ]);
  });

  it("really sets mode 0600 on a member when run unmocked", () => {
    const stateDir = stateWithMembers();
    expect(alignFreshMemberOwnership(stateDir)).toBe(true);
    for (const name of MEMBERS) {
      expect(statSync(join(stateDir, name)).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses a member that is a symlink, and never touches its target", () => {
    const stateDir = stateWithMembers();
    const outside = mkdtempSync(join(tmpdir(), "nb288-outside-"));
    const target = join(outside, "victim");
    writeFileSync(target, "outside-bytes", { mode: 0o644 });
    const before = statSync(target);
    // Replace a member with a symlink, as the service user could.
    const member = join(stateDir, "notesnook.db");
    unlinkSync(member);
    symlinkSync(target, member);

    const rec = recordingOwnership();
    expect(alignFreshMemberOwnership(stateDir, rec.ownership)).toBe(false);
    expect(rec.calls).toEqual([]);
    const after = statSync(target);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(after.uid).toBe(before.uid);
  });

  it("refuses a member with a second hard link, and changes nothing", () => {
    const stateDir = stateWithMembers();
    const outside = mkdtempSync(join(tmpdir(), "nb288-hard-"));
    const alias = join(outside, "alias");
    linkSync(join(stateDir, "notesnook.db"), alias);

    const rec = recordingOwnership();
    expect(alignFreshMemberOwnership(stateDir, rec.ownership)).toBe(false);
    expect(rec.calls).toEqual([]);
  });

  it("reports failure when a required member is missing", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nb288-missing-"));
    expect(alignFreshMemberOwnership(stateDir)).toBe(false);
  });
});

describe("issue #288 — live-login reads the systemd credential key", () => {
  it("returns no key store when CREDENTIALS_DIRECTORY is unset or empty", () => {
    expect(liveLoginKeysFromEnvironment({})).toBeUndefined();
    expect(liveLoginKeysFromEnvironment({ CREDENTIALS_DIRECTORY: "" })).toBeUndefined();
  });

  it("reads the key from $CREDENTIALS_DIRECTORY/nookbridge-db-key", () => {
    const keys = liveLoginKeysFromEnvironment({ CREDENTIALS_DIRECTORY: credentialsDir() });
    expect(keys?.getDatabaseKey()).toBe(KEY);
  });

  it("withLiveLoginKeys leaves options unchanged without a credential directory", () => {
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

  it("refuses a development key for the production state directory when no key is supplied", () => {
    expect(PRODUCTION_STATE_DIR_FOR_KEYS).toBe("/var/lib/nookbridge");
    expect(PRODUCTION_STATE_DIR).toBe(PRODUCTION_STATE_DIR_FOR_KEYS);
    expect(() => assertNoDevelopmentKeyForProduction(PRODUCTION_STATE_DIR_FOR_KEYS, false)).toThrow(
      "production state requires the systemd credential key",
    );
  });

  it("allows production state when a caller key is supplied", () => {
    expect(() =>
      assertNoDevelopmentKeyForProduction(PRODUCTION_STATE_DIR_FOR_KEYS, true),
    ).not.toThrow();
  });

  it("allows a non-production state directory without a caller key", () => {
    expect(() => assertNoDevelopmentKeyForProduction("/tmp/somewhere", false)).not.toThrow();
  });
});
