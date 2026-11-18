// Issue #288: recovery must leave state the service user can open, and the
// auth commands must read the production key from the systemd credential slot.
// Every test runs under temp directories; none touches /var/lib/nookbridge.

import {
  linkSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertCallerOwnsStateRoot,
  assertNoDevelopmentKeyForProduction,
  liveLoginKeysFromEnvironment,
  PRODUCTION_STATE_DIR_FOR_KEYS,
  withLiveLoginKeys,
} from "../src/auth/live-login-runtime.js";
import { PRODUCTION_STATE_DIR } from "../src/operator/production-runtime.js";
import {
  alignFreshMemberOwnership,
  reinitializeProductionBundle,
} from "../src/operator/recover-bundle.js";
import { SqliteStorage } from "../src/storage/sqlite-storage.js";

const KEY = "issue-288-test-key";
const REQUIRED = ["nookbridge-storage.db", "notesnook.db"] as const;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function credentialsDir(key: string = KEY): string {
  const dir = tempDir("nb288-cred-");
  writeFileSync(join(dir, "nookbridge-db-key"), key, { mode: 0o600 });
  return dir;
}

function stateWithPlainMembers(): string {
  const stateDir = tempDir("nb288-state-");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const name of REQUIRED) writeFileSync(join(stateDir, name), "x", { mode: 0o644 });
  return stateDir;
}

// A real encrypted bundle, so the reinitialize probe sees healthy members.
function encryptedBundle(): { stateDir: string; credentials: string } {
  const root = tempDir("nb288-bundle-");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const name of REQUIRED) {
    const storage = new SqliteStorage({
      dbPath: join(stateDir, name),
      key: KEY,
      withExtensions: false,
    });
    storage.exec("CREATE TABLE IF NOT EXISTS bundle_marker(value TEXT)");
    storage.run("INSERT INTO bundle_marker(value) VALUES(?)", [name]);
    storage.close();
  }
  return { stateDir, credentials: credentialsDir() };
}

// Records every descriptor-level change, standing in for root's chown/chmod.
function recorder(): {
  calls: Array<["chown", number, number] | ["chmod", number]>;
  seam: {
    fchown: (fd: number, uid: number, gid: number) => void;
    fchmod: (fd: number, mode: number) => void;
  };
} {
  const calls: Array<["chown", number, number] | ["chmod", number]> = [];
  return {
    calls,
    seam: {
      fchown: (_fd, uid, gid) => {
        calls.push(["chown", uid, gid]);
      },
      fchmod: (_fd, mode) => {
        calls.push(["chmod", mode]);
      },
    },
  };
}

describe("issue #288 — fresh members match the state root", () => {
  it("applies the state root's owner and mode 0600 to each member", () => {
    const stateDir = stateWithPlainMembers();
    const root = statSync(stateDir);
    const rec = recorder();

    expect(alignFreshMemberOwnership(stateDir, rec.seam)).toBe(true);

    expect(rec.calls).toEqual([
      ["chown", root.uid, root.gid],
      ["chmod", 0o600],
      ["chown", root.uid, root.gid],
      ["chmod", 0o600],
    ]);
  });

  it("really sets mode 0600 on each member when run unmocked", () => {
    const stateDir = stateWithPlainMembers();
    expect(alignFreshMemberOwnership(stateDir)).toBe(true);
    for (const name of REQUIRED) {
      expect(statSync(join(stateDir, name)).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses a member that is a symlink, and changes nothing", () => {
    const stateDir = stateWithPlainMembers();
    const outside = tempDir("nb288-outside-");
    const target = join(outside, "victim");
    writeFileSync(target, "outside-bytes", { mode: 0o644 });
    const before = statSync(target);
    unlinkSync(join(stateDir, "notesnook.db"));
    symlinkSync(target, join(stateDir, "notesnook.db"));

    const rec = recorder();
    expect(alignFreshMemberOwnership(stateDir, rec.seam)).toBe(false);
    expect(rec.calls).toEqual([]);
    expect(statSync(target).mode & 0o777).toBe(before.mode & 0o777);
  });

  it("refuses a member with a second hard link, and changes nothing", () => {
    const stateDir = stateWithPlainMembers();
    linkSync(join(stateDir, "notesnook.db"), join(tempDir("nb288-hard-"), "alias"));

    const rec = recorder();
    expect(alignFreshMemberOwnership(stateDir, rec.seam)).toBe(false);
    expect(rec.calls).toEqual([]);
  });

  it("refuses a member that is not the inode the reinitialize step created", () => {
    const stateDir = stateWithPlainMembers();
    // Identity recorded for a different inode than the file now on disk.
    const bogus = new Map([
      ["nookbridge-storage.db", { dev: 0, ino: 0 }],
      ["notesnook.db", { dev: 0, ino: 0 }],
    ]);
    const rec = recorder();
    expect(alignFreshMemberOwnership(stateDir, rec.seam, bogus)).toBe(false);
    expect(rec.calls).toEqual([]);
  });

  it("reports failure when a required member is missing", () => {
    expect(alignFreshMemberOwnership(tempDir("nb288-missing-"))).toBe(false);
  });
});

describe("issue #288 — the reinitialize call site applies ownership", () => {
  it("reinitialize runs the ownership seam on both fresh members", () => {
    const { stateDir, credentials } = encryptedBundle();
    const rec = recorder();

    const result = reinitializeProductionBundle({
      stateDir,
      credentialsDirectory: credentials,
      ownership: rec.seam,
    });

    expect(result.kind).toBe("reinitialized");
    // Two members, each chowned then chmodded, proves the call site runs.
    expect(rec.calls.filter((c) => c[0] === "chown")).toHaveLength(REQUIRED.length);
    expect(rec.calls.filter((c) => c[0] === "chmod")).toHaveLength(REQUIRED.length);
  });

  it("a refused alignment fails with exit 3 and leaves the manifest resumable", () => {
    const { stateDir, credentials } = encryptedBundle();
    const refusing = {
      fchown: () => {
        throw new Error("simulated ownership refusal");
      },
      fchmod: () => undefined,
    };

    const result = reinitializeProductionBundle({
      stateDir,
      credentialsDirectory: credentials,
      ownership: refusing,
    });

    expect(result).toEqual({
      kind: "error",
      exitCode: 3,
      message: "state ownership is not usable by the service user",
    });
    // The manifest is left at `initializing`, so a rerun can resume it.
    const quarantineRoot = join(stateDir, ".recovery-quarantine");
    const entries = readdirOrEmpty(quarantineRoot);
    expect(entries.length).toBeGreaterThan(0);
    const manifest = JSON.parse(
      readFileSync(join(quarantineRoot, entries[0] as string, "recovery-manifest.json"), "utf8"),
    ) as { status: string };
    expect(manifest.status).toBe("initializing");
  });
});

describe("issue #288 — the auth commands read the systemd credential key", () => {
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

  it("the auth call site in the CLI routes through the shared runtime wrapper", () => {
    // Source contract on the auth createRuntime block only.  It must call the
    // shared wrapper with the environment, and must not build the bare runtime
    // directly, which would drop CREDENTIALS_DIRECTORY.
    const cli = readFileSync(resolve("src/cli.ts"), "utf8");
    const start = cli.indexOf("createRuntime: async ({ stateDir: runtimeStateDir })");
    expect(start).toBeGreaterThan(-1);
    const end = cli.indexOf("\n      },", start);
    expect(end).toBeGreaterThan(start);
    const block = cli.slice(start, end);
    expect(block).toMatch(/return createAuthLiveLoginRuntime\(\{/);
    expect(block).toMatch(/environment,/);
    expect(block).not.toContain("createProductionLiveLoginRuntime");
  });
});

describe("issue #288 — the caller must own the state root", () => {
  it("refuses when the state root belongs to another user", () => {
    const stateDir = tempDir("nb288-owner-");
    const root = statSync(stateDir);
    expect(() => assertCallerOwnsStateRoot(stateDir, root.uid + 1)).toThrow(
      "state directory is owned by another user",
    );
  });

  it("allows the owner of the state root", () => {
    const stateDir = tempDir("nb288-owner-ok-");
    const root = statSync(stateDir);
    expect(() => assertCallerOwnsStateRoot(stateDir, root.uid)).not.toThrow();
  });

  it("allows a state root that does not exist yet", () => {
    expect(() =>
      assertCallerOwnsStateRoot(join(tempDir("nb288-absent-"), "not-created"), 0),
    ).not.toThrow();
  });

  it("skips the check where the platform cannot report a uid", () => {
    const stateDir = tempDir("nb288-no-uid-");
    expect(() => assertCallerOwnsStateRoot(stateDir, undefined)).not.toThrow();
  });
});

describe("issue #288 — the production-key guard", () => {
  it("refuses a development key for the production directory when no key is supplied", () => {
    expect(PRODUCTION_STATE_DIR_FOR_KEYS).toBe("/var/lib/nookbridge");
    expect(PRODUCTION_STATE_DIR).toBe(PRODUCTION_STATE_DIR_FOR_KEYS);
    expect(() => assertNoDevelopmentKeyForProduction(PRODUCTION_STATE_DIR_FOR_KEYS, false)).toThrow(
      "production state requires the systemd credential key",
    );
  });

  it("refuses a symlink alias that reaches the production directory", () => {
    const production = tempDir("nb288-prod-");
    const alias = join(tempDir("nb288-alias-"), "link");
    symlinkSync(production, alias);
    expect(() => assertNoDevelopmentKeyForProduction(alias, false, production)).toThrow(
      "production state requires the systemd credential key",
    );
  });

  it("allows production state when a caller key is supplied", () => {
    expect(() =>
      assertNoDevelopmentKeyForProduction(PRODUCTION_STATE_DIR_FOR_KEYS, true),
    ).not.toThrow();
  });

  it("allows an unrelated directory without a caller key", () => {
    const other = tempDir("nb288-other-");
    expect(() =>
      assertNoDevelopmentKeyForProduction(other, false, tempDir("nb288-p2-")),
    ).not.toThrow();
  });
});

function readdirOrEmpty(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
