/**
 * Stage 9.5 (PR-66) — production database-bundle recovery.
 *
 * These tests drive the bundle-aware `nookctl recover-local-state` surface
 * against disposable temp fixtures only.  Nothing here touches live state,
 * authentication, or the network.
 *
 * Required properties under test:
 *
 *   1. credential boundary — the key is read only from the systemd
 *      `$CREDENTIALS_DIRECTORY/nookbridge-db-key` slot; argv and env
 *      carriers are refused (presence alone, values never read);
 *   2. bundle scope — the three production members plus their `-wal` and
 *      `-shm` sidecars move as one unit; a partial bundle is refused;
 *   3. exclusive ownership — a live lock refuses mutation and is held for
 *      the whole mutation; a stale lock file alone is not trusted;
 *   4. crash checkpoints — a manifest is written before the first move and
 *      a rerun resumes or refuses, never guesses;
 *   5. same-filesystem no-clobber moves, 0o700 quarantine modes, opaque
 *      ids, categorical output with no paths/keys/note data;
 *   6. the default inspect path is read-only — no writable handle, no byte
 *      changes;
 *   7. a failed move does not leave a quarantine entry that blocks later
 *      runs (the `safeRmQuarantineEntry` directory bug);
 *   8. `--approve-reinitialize` AND the D2 acknowledgment flag are both
 *      required; either one missing refuses.
 *
 * The test file intentionally uses literal flag strings and public entry
 * points only, so it compiles and fails meaningfully against the pre-fix
 * source (the bundle subcommand is unknown before the fix).
 */

import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";

import { run } from "../src/cli.js";
import { ensureStateDir } from "../src/config/state-dir.js";
import { lockPath, releaseLock, tryAcquireLock } from "../src/config/lock.js";
import {
  formatBundleRecoveryHelp,
  formatRecoverLocalStateHelp,
  parseRecoverLocalStateCommand,
  runRecoverLocalState,
} from "../src/operator/recover-local-state.js";
import {
  discardEmptyEntry,
  inspectProductionBundle,
  removeBundleQuarantineEntry,
} from "../src/operator/recover-bundle.js";
import { QUARANTINE_ID_PATTERN } from "../src/operator/recover-quarantine.js";
import { SqliteStorage, inspectEncryptedSqlite } from "../src/storage/sqlite-storage.js";
import type * as SqliteModule from "../src/storage/sqlite-storage.js";
import type * as CryptoModule from "node:crypto";
import type * as QuarantineModule from "../src/operator/recover-quarantine.js";
import type * as LocalStateModule from "../src/operator/recover-local-state.js";

/**
 * G2 probe recorder.  `vi.hoisted` runs before imports so the `vi.mock`
 * factory below can reference it.  Populated by the transparent
 * `inspectEncryptedSqlite` wrapper; read only by the G2 test (cleared in its
 * `beforeEach`).
 */
const probeCalls = vi.hoisted(
  () =>
    [] as Array<{
      dbPath: string;
      walExists: boolean;
      walSize: number;
      shmExists: boolean;
      shmSize: number;
    }>,
);

/**
 * Optional hook invoked by the wrapper at each probe call.  The G2 test leaves
 * it unset; the L (lock) tests install a hook to observe or perturb the state
 * at probe time.  Cleared after every L test so no other test is affected.
 */
const probeHook = vi.hoisted(() => ({
  onProbe: undefined as (() => void) | undefined,
}));

/**
 * Optional hook invoked before each `moveNoReplace` call.  Only the rollback
 * compensation test installs it, to plant an occupant so an undo move fails.
 * Cleared in that test's `finally`.
 */
const moveHook = vi.hoisted(() => ({
  beforeMove: undefined as ((source: string, destination: string) => void) | undefined,
}));

/**
 * Fails fresh-state creation for the member whose path ends with `failOn`.
 * Used to crash initialization after an earlier member already exists.  Unset
 * in every other test.
 */
const freshInitHook = vi.hoisted(() => ({
  failOn: undefined as string | undefined,
}));

/**
 * Env snapshots the parser receives from the CLI.  Recorded only; the wrapper
 * below passes every call through unchanged.  Guard C1 reads it to prove a
 * forbidden carrier value never reaches the parser input.
 */
const parseEnvSeen = vi.hoisted(() => [] as Array<Record<string, string | undefined>>);

/** Credential directories the CLI passes to the bundle runner.  Guard C2 reads it. */
const credentialDirsSeen = vi.hoisted(() => [] as Array<string | undefined>);

// Pass-through wrapper: the real no-clobber move runs after the hook.
vi.mock("../src/operator/recover-quarantine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof QuarantineModule>();
  return {
    ...actual,
    moveNoReplace: (source: string, destination: string): boolean => {
      moveHook.beforeMove?.(source, destination);
      return actual.moveNoReplace(source, destination);
    },
  };
});

// Random draws are real unless a test arms `randomHook.fixed`, which makes the
// manifest temporary's name predictable for the exclusive-create regression.
const randomHook = vi.hoisted(() => ({ fixed: false }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof CryptoModule>();
  return {
    ...actual,
    randomBytes: (size: number): Buffer =>
      randomHook.fixed ? Buffer.alloc(size, 0xab) : actual.randomBytes(size),
  };
});

// Pass-through wrapper on the parser: records the env snapshot it receives.
vi.mock("../src/operator/recover-local-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof LocalStateModule>();
  return {
    ...actual,
    parseRecoverLocalStateCommand: (
      args: string[],
      env: Record<string, string | undefined>,
    ): ReturnType<typeof actual.parseRecoverLocalStateCommand> => {
      parseEnvSeen.push(env);
      return actual.parseRecoverLocalStateCommand(args, env);
    },
    runRecoverLocalState: (options: Parameters<typeof actual.runRecoverLocalState>[0]) => {
      credentialDirsSeen.push(options.credentialsDirectory);
      return actual.runRecoverLocalState(options);
    },
  };
});

// Transparent delegate: records what the probe-time copy looks like without
// changing the inspection result or `SqliteStorage` for any other test.
vi.mock("../src/storage/sqlite-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SqliteModule>();
  const fs = await import("node:fs");
  // Pass-through subclass: throws only for the member named by `freshInitHook`.
  class HookedSqliteStorage extends actual.SqliteStorage {
    constructor(opts: SqliteModule.SqliteStorageOptions) {
      if (freshInitHook.failOn !== undefined && opts.dbPath.endsWith(freshInitHook.failOn)) {
        throw new Error("injected fresh-state initialization failure");
      }
      super(opts);
    }
  }
  return {
    ...actual,
    SqliteStorage: HookedSqliteStorage,
    inspectEncryptedSqlite: (options: { dbPath: string; key: string }) => {
      probeHook.onProbe?.();
      const wal = `${options.dbPath}-wal`;
      const shm = `${options.dbPath}-shm`;
      const walExists = fs.existsSync(wal);
      const shmExists = fs.existsSync(shm);
      probeCalls.push({
        dbPath: options.dbPath,
        walExists,
        walSize: walExists ? fs.statSync(wal).size : -1,
        shmExists,
        shmSize: shmExists ? fs.statSync(shm).size : -1,
      });
      return actual.inspectEncryptedSqlite(options);
    },
  };
});

const BUNDLE_MEMBERS = ["nookbridge-storage.db", "notesnook.db", "notesnook-logs.db"] as const;
const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;
const APPROVE = "--approve-reinitialize";
const ACK = "--accept-unsynced-loss";
const ROLLBACK = "--approve-rollback";
const MANIFEST_NAME = "recovery-manifest.json";

const roots: string[] = [];

function mkRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

type BundleFixture = {
  stateDir: string;
  credentialsDir: string;
  key: string;
  memberBytes: Record<string, Buffer>;
};

/** Full production bundle + a systemd-shaped credential directory. */
function buildBundleFixture(
  rootDir: string,
  options: { key?: string; sidecars?: boolean } = {},
): BundleFixture {
  const stateDir = join(rootDir, "state");
  const credentialsDir = join(rootDir, "credentials");
  const key = options.key ?? "stage9-bundle-recovery-key";
  ensureStateDir(stateDir);
  mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
  chmodSync(credentialsDir, 0o700);
  writeFileSync(join(credentialsDir, "nookbridge-db-key"), key, { mode: 0o600 });

  const memberBytes: Record<string, Buffer> = {};
  for (const member of BUNDLE_MEMBERS) {
    const dbPath = join(stateDir, member);
    const storage = new SqliteStorage({ dbPath, key, withExtensions: false });
    // Force real encrypted pages so the on-disk bytes are meaningful and a
    // wrong key is detectable (an untouched empty file has no ciphertext).
    storage.exec("CREATE TABLE IF NOT EXISTS bundle_marker(value TEXT)");
    storage.run("INSERT INTO bundle_marker(value) VALUES(?)", [member]);
    storage.close();
    memberBytes[member] = readFileSync(dbPath);
  }
  if (options.sidecars === true) {
    for (const member of BUNDLE_MEMBERS) {
      for (const suffix of SIDECAR_SUFFIXES) {
        writeFileSync(
          join(stateDir, `${member}${suffix}`),
          Buffer.from(`${member}${suffix}-bytes`),
        );
      }
    }
  }
  return { stateDir, credentialsDir, key, memberBytes };
}

function runBundle(argv: readonly string[], stateDir: string, credentialsDir?: string) {
  return runRecoverLocalState({
    argv: [...argv],
    env: {},
    stateDir,
    dbPath: join(stateDir, "nookbridge.db"),
    ...(credentialsDir === undefined ? {} : { credentialsDirectory: credentialsDir }),
  });
}

function quarantineRoot(stateDir: string): string {
  return join(stateDir, ".recovery-quarantine");
}

function snapshotTree(root: string): Record<string, { size: number; hash: string; mode: string }> {
  const out: Record<string, { size: number; hash: string; mode: string }> = {};
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      const relative = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(absolute);
      if (st.isDirectory()) {
        out[relative] = { size: 0, hash: "dir", mode: (st.mode & 0o777).toString(8) };
        walk(absolute, relative);
      } else if (st.isFile()) {
        out[relative] = {
          size: st.size,
          hash: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
          mode: (st.mode & 0o777).toString(8),
        };
      }
    }
  };
  walk(root, "");
  return out;
}

/**
 * Snapshot every bundle member's exact bytes and inode.  A refusal test uses
 * this to prove the state was untouched, not merely that it still exists.
 */
function snapshotMembers(stateDir: string): Record<string, { bytes: string; ino: number }> {
  const out: Record<string, { bytes: string; ino: number }> = {};
  for (const member of BUNDLE_MEMBERS) {
    const path = join(stateDir, member);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    out[member] = { bytes: readFileSync(path).toString("hex"), ino: stat.ino };
  }
  return out;
}

/**
 * Recursive snapshot of every file under `root` keyed by relative path, with
 * exact bytes and inode.  Used by refusal tests to prove nothing moved, was
 * replaced, or was re-created.
 */
function snapshotTreeWithInodes(root: string): Record<string, { bytes: string; ino: number }> {
  const out: Record<string, { bytes: string; ino: number }> = {};
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      const relative = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute, relative);
      } else if (stat.isFile()) {
        out[relative] = { bytes: readFileSync(absolute).toString("hex"), ino: stat.ino };
      }
    }
  };
  walk(root, "");
  return out;
}

function hashFileOrAbsent(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "ABSENT";
  }
}

/** Per-member hashes of the database file and each sidecar suffix. */
function readBundleSidecarHashes(stateDir: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const member of BUNDLE_MEMBERS) {
    const entry: Record<string, string> = {
      "": hashFileOrAbsent(join(stateDir, member)),
    };
    for (const suffix of SIDECAR_SUFFIXES) {
      entry[suffix] = hashFileOrAbsent(join(stateDir, `${member}${suffix}`));
    }
    out[member] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Property 6 + property 5 — read-only bundle inspection.
// ---------------------------------------------------------------------------

describe("bundle inspect — read-only categorical probe", () => {
  it("reports a full bundle healthy without changing any byte", async () => {
    // No WAL sidecars here: SQLite may legitimately refresh the shared-memory
    // `-shm` index when a WAL is present, but the DATABASE contents and the
    // file set must not change.  The sidecar-preservation case is covered by
    // the reinitialize tests.
    const root = mkRoot("nookbridge-bundle-inspect-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const before = snapshotTree(stateDir);

    const result = await runBundle(["bundle", "inspect"], stateDir, credentialsDir);

    expect(result.kind).toBe("bundle-inspection");
    if (result.kind !== "bundle-inspection") return;
    expect(result.result.kind).toBe("healthy");
    expect(snapshotTree(stateDir)).toEqual(before);
    expect(existsSync(quarantineRoot(stateDir))).toBe(false);
  });

  it("does not create a writable handle or new sidecars during inspect", async () => {
    const root = mkRoot("nookbridge-bundle-inspect-nohandle-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);

    const result = await runBundle(["bundle", "inspect"], stateDir, credentialsDir);

    expect(result.kind).toBe("bundle-inspection");
    if (result.kind !== "bundle-inspection") return;
    expect(result.result.kind).toBe("healthy");
    for (const member of BUNDLE_MEMBERS) {
      expect(readFileSync(join(stateDir, member)).equals(memberBytes[member]!)).toBe(true);
      expect(existsSync(join(stateDir, `${member}-wal`))).toBe(false);
      expect(existsSync(join(stateDir, `${member}-shm`))).toBe(false);
    }
  });

  it("reports a partial bundle categorically and mutates nothing", async () => {
    const root = mkRoot("nookbridge-bundle-inspect-partial-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    rmSync(join(stateDir, "notesnook-logs.db"));
    const before = snapshotTree(stateDir);

    const result = await runBundle(["bundle", "inspect"], stateDir, credentialsDir);

    expect(result.kind).toBe("bundle-inspection");
    if (result.kind !== "bundle-inspection") return;
    expect(result.result.kind).toBe("partial");
    expect(snapshotTree(stateDir)).toEqual(before);
  });

  it("reports locked (read-only) when a live holder owns the state", async () => {
    const root = mkRoot("nookbridge-bundle-inspect-locked-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    writeFileSync(lockPath(stateDir), `${process.pid}\n`);
    const before = snapshotTree(stateDir);

    const result = await runBundle(["bundle", "inspect"], stateDir, credentialsDir);

    expect(result.kind).toBe("bundle-inspection");
    if (result.kind !== "bundle-inspection") return;
    expect(result.result.kind).toBe("locked");
    expect(snapshotTree(stateDir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Property 2 + property 5 — atomic bundle quarantine.
// ---------------------------------------------------------------------------

describe("bundle reinitialize — atomic three-member quarantine", () => {
  it("quarantines all three members and reinitializes a fresh bundle", async () => {
    const root = mkRoot("nookbridge-bundle-quarantine-");
    const { stateDir, credentialsDir, key, memberBytes } = buildBundleFixture(root);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;
    expect(result.quarantineId).toMatch(/^[a-f0-9]{8}-[a-z0-9]{12,13}$/);

    const qRoot = quarantineRoot(stateDir);
    const entry = join(qRoot, result.quarantineId);
    expect((lstatSync(qRoot).mode & 0o777).toString(8)).toBe("700");
    expect((lstatSync(entry).mode & 0o777).toString(8)).toBe("700");

    // Manifest is written into the entry (crash checkpoint).
    const manifestPath = join(entry, MANIFEST_NAME);
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { status?: unknown };
    expect(manifest.status).toBe("complete");
    expect((lstatSync(manifestPath).mode & 0o777).toString(8)).toBe("600");

    for (const member of BUNDLE_MEMBERS) {
      expect(memberBytes[member]!.length).toBeGreaterThan(0);
      // Original bytes preserved bit-for-bit inside the opaque entry.
      expect(readFileSync(join(entry, member)).equals(memberBytes[member]!)).toBe(true);
      // A fresh encrypted member replaced it at the state root: a distinct
      // inode, not the moved original.
      expect(existsSync(join(stateDir, member))).toBe(true);
      expect(lstatSync(join(stateDir, member)).ino).not.toBe(lstatSync(join(entry, member)).ino);
      expect(inspectEncryptedSqlite({ dbPath: join(stateDir, member), key }).status).toBe(
        "healthy",
      );
    }

    // The freshly initialized bundle inspects healthy.
    const followUp = await runBundle(["bundle", "inspect"], stateDir, credentialsDir);
    expect(followUp.kind).toBe("bundle-inspection");
    if (followUp.kind !== "bundle-inspection") return;
    expect(followUp.result.kind).toBe("healthy");
  });

  it("preserves -wal and -shm sidecars byte-for-byte", async () => {
    const root = mkRoot("nookbridge-bundle-sidecars-");
    const { stateDir, credentialsDir } = buildBundleFixture(root, { sidecars: true });

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;
    const entry = join(quarantineRoot(stateDir), result.quarantineId);

    for (const member of BUNDLE_MEMBERS) {
      for (const suffix of SIDECAR_SUFFIXES) {
        const name = `${member}${suffix}`;
        const preserved = join(entry, name);
        expect(existsSync(preserved)).toBe(true);
        expect(readFileSync(preserved, "utf8")).toBe(`${name}-bytes`);
        // The live sidecar was moved, not copied.
        expect(existsSync(join(stateDir, name))).toBe(false);
      }
    }
  });

  it("refuses a partial bundle and leaves it untouched", async () => {
    const root = mkRoot("nookbridge-bundle-partial-refuse-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    rmSync(join(stateDir, "notesnook.db"));
    const before = snapshotTreeWithInodes(stateDir);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message.toLowerCase()).toContain("partial");
    expect(existsSync(quarantineRoot(stateDir))).toBe(false);
    // Every remaining file keeps its exact bytes and inode, not just a length.
    expect(snapshotTreeWithInodes(stateDir)).toEqual(before);
  });

  it("emits categorical output with no paths, keys, or member names", async () => {
    const root = mkRoot("nookbridge-bundle-categorical-");
    const { stateDir, credentialsDir, key } = buildBundleFixture(root);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;

    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain(stateDir);
    expect(rendered).not.toContain(credentialsDir);
    expect(rendered).not.toContain(key);
    for (const member of BUNDLE_MEMBERS) {
      expect(rendered).not.toContain(member);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 3 — exclusive ownership.
// ---------------------------------------------------------------------------

describe("bundle reinitialize — exclusive ownership", () => {
  it("refuses while a live holder owns the lock and does not mutate", async () => {
    const root = mkRoot("nookbridge-bundle-lock-live-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);
    writeFileSync(lockPath(stateDir), `${process.pid}\n`);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message.toLowerCase()).toContain("locked");
    expect(existsSync(quarantineRoot(stateDir))).toBe(false);
    for (const member of BUNDLE_MEMBERS) {
      expect(readFileSync(join(stateDir, member)).equals(memberBytes[member]!)).toBe(true);
    }
  });

  it("does not trust a stale lock file alone; the holder is provably gone", async () => {
    const root = mkRoot("nookbridge-bundle-lock-stale-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    // A pid far above pid_max is provably not alive (ESRCH).
    writeFileSync(lockPath(stateDir), "2147483646\n");

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("reinitialized");
    // The lock is released after the mutation.
    expect(existsSync(lockPath(stateDir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 4 — crash checkpoints: resume or refuse, never guess.
// ---------------------------------------------------------------------------

function plantIncompleteEntry(
  stateDir: string,
  id: string,
  manifest: unknown,
  moveMember?: string,
): string {
  const entry = join(quarantineRoot(stateDir), id);
  mkdirSync(entry, { recursive: true, mode: 0o700 });
  chmodSync(entry, 0o700);
  if (moveMember !== undefined) {
    renameSync(join(stateDir, moveMember), join(entry, moveMember));
  }
  writeFileSync(join(entry, MANIFEST_NAME), JSON.stringify(manifest), { mode: 0o600 });
  return entry;
}

/**
 * Backdate a directory past the sweep's age gate, so the guard a sweep test
 * pins is the only thing that can keep or remove it.
 */
function backdate(path: string): void {
  const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(path, past, past);
}

// ---------------------------------------------------------------------------
// P1-9 review fixes: inspect takes the lock before reading presence; a crash
// after every member moved is resumable; a symlinked quarantine root is refused.
// ---------------------------------------------------------------------------

describe("bundle review fixes — lock order and quarantine root", () => {
  it("inspect reports locked, not partial, while a live holder owns the lock", () => {
    const root = mkRoot("nookbridge-bundle-inspect-lock-first-");
    const { stateDir, key } = buildBundleFixture(root);
    // A mutation mid-move leaves a partial root.  An unlocked read would report
    // it as partial; the lock must be taken before presence is read.
    rmSync(join(stateDir, "notesnook.db"));
    writeFileSync(lockPath(stateDir), `${process.pid}\n`, { mode: 0o600 });

    const result = inspectProductionBundle(stateDir, key);

    expect(result.kind).toBe("locked");
    expect(readFileSync(lockPath(stateDir), "utf8")).toBe(`${process.pid}\n`);
  });

  it("reinitialize resumes a checkpoint in which every member already moved", async () => {
    const root = mkRoot("nookbridge-bundle-resume-all-moved-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);
    const id = "c0ffee00-0123456789ab";
    const entry = plantIncompleteEntry(stateDir, id, {
      version: 1,
      id,
      status: "incomplete",
      items: BUNDLE_MEMBERS.map((name) => ({ name, state: "moved" })),
    });
    // A crash after the last member move leaves an empty state root.
    for (const member of BUNDLE_MEMBERS) {
      renameSync(join(stateDir, member), join(entry, member));
    }

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;
    expect(result.quarantineId).toBe(id);
    for (const member of BUNDLE_MEMBERS) {
      expect(readFileSync(join(entry, member)).equals(memberBytes[member]!)).toBe(true);
      expect(existsSync(join(stateDir, member))).toBe(true);
    }
  });

  it("reinitialize refuses a symlinked quarantine root and moves nothing outside", async () => {
    const root = mkRoot("nookbridge-bundle-symlink-quarantine-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);
    const outside = mkRoot("nookbridge-bundle-symlink-quarantine-target-");
    symlinkSync(outside, quarantineRoot(stateDir));

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    for (const member of BUNDLE_MEMBERS) {
      expect(readFileSync(join(stateDir, member)).equals(memberBytes[member]!)).toBe(true);
    }
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rollback refuses a symlinked quarantine root and restores nothing from outside", async () => {
    const root = mkRoot("nookbridge-bundle-rollback-symlink-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const outside = mkRoot("nookbridge-bundle-rollback-symlink-target-");
    const id = "decade00-0123456789ab";
    const entry = join(outside, id);
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(entry, MANIFEST_NAME),
      JSON.stringify({
        version: 1,
        id,
        status: "complete",
        items: BUNDLE_MEMBERS.map((name) => ({ name, state: "moved" })),
      }),
      { mode: 0o600 },
    );
    for (const member of BUNDLE_MEMBERS) {
      renameSync(join(stateDir, member), join(entry, member));
    }
    symlinkSync(outside, quarantineRoot(stateDir));

    const result = await runBundle(["bundle", "rollback", ROLLBACK, id], stateDir, credentialsDir);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    for (const member of BUNDLE_MEMBERS) {
      expect(existsSync(join(stateDir, member))).toBe(false);
      expect(existsSync(join(entry, member))).toBe(true);
    }
  });
});

describe("bundle reinitialize — crash checkpoints", () => {
  it("resumes an incomplete checkpoint instead of guessing", async () => {
    const root = mkRoot("nookbridge-bundle-resume-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);
    const id = "deadbeef-0123456789ab";
    plantIncompleteEntry(
      stateDir,
      id,
      {
        version: 1,
        id,
        status: "incomplete",
        items: [
          { name: "nookbridge-storage.db", state: "moved" },
          { name: "notesnook.db", state: "pending" },
          { name: "notesnook-logs.db", state: "pending" },
        ],
      },
      "nookbridge-storage.db",
    );

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;
    expect(result.quarantineId).toBe(id);

    const entry = join(quarantineRoot(stateDir), id);
    for (const member of BUNDLE_MEMBERS) {
      expect(readFileSync(join(entry, member)).equals(memberBytes[member]!)).toBe(true);
      expect(existsSync(join(stateDir, member))).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(entry, MANIFEST_NAME), "utf8")) as {
      status?: unknown;
    };
    expect(manifest.status).toBe("complete");
  });

  it("refuses a malformed manifest rather than guessing", async () => {
    const root = mkRoot("nookbridge-bundle-refuse-malformed-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);
    const id = "feedface-0123456789ab";
    const entry = join(quarantineRoot(stateDir), id);
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    chmodSync(entry, 0o700);
    writeFileSync(join(entry, MANIFEST_NAME), "{not-json", { mode: 0o600 });

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message.toLowerCase()).toContain("quarantine");
    for (const member of BUNDLE_MEMBERS) {
      expect(readFileSync(join(stateDir, member)).equals(memberBytes[member]!)).toBe(true);
    }
  });

  it("refuses a checkpoint that claims a move the filesystem contradicts", async () => {
    const root = mkRoot("nookbridge-bundle-refuse-contradiction-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);
    const id = "abad1dea-0123456789ab";
    plantIncompleteEntry(stateDir, id, {
      version: 1,
      id,
      status: "incomplete",
      items: [
        { name: "nookbridge-storage.db", state: "moved" },
        { name: "notesnook.db", state: "pending" },
        { name: "notesnook-logs.db", state: "pending" },
      ],
    });

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    for (const member of BUNDLE_MEMBERS) {
      expect(readFileSync(join(stateDir, member)).equals(memberBytes[member]!)).toBe(true);
    }
  });

  it("refuses when source and destination are different inodes", async () => {
    const root = mkRoot("nookbridge-bundle-refuse-inode-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const id = "cafebabe-0123456789ab";
    const entry = plantIncompleteEntry(stateDir, id, {
      version: 1,
      id,
      status: "incomplete",
      items: [
        { name: "nookbridge-storage.db", state: "pending" },
        { name: "notesnook.db", state: "pending" },
        { name: "notesnook-logs.db", state: "pending" },
      ],
    });
    // A second, distinct inode at the destination while the source remains.
    writeFileSync(join(entry, "nookbridge-storage.db"), "different-inode");

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
  });

  // Reviewer blocker: a resumed checkpoint used to skip the probe, so a pending
  // member that became unreadable after the first run was quarantined anyway.
  it("resume probes the pending members before quarantining anything", async () => {
    const root = mkRoot("nookbridge-bundle-resume-probe-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const id = "b00b1e55-0123456789ab";
    plantIncompleteEntry(
      stateDir,
      id,
      {
        version: 1,
        id,
        status: "incomplete",
        items: [
          { name: "nookbridge-storage.db", state: "moved" },
          { name: "notesnook.db", state: "pending" },
          { name: "notesnook-logs.db", state: "pending" },
        ],
      },
      "nookbridge-storage.db",
    );
    // The pending member is unreadable now; the first run never saw this state.
    writeFileSync(join(stateDir, "notesnook.db"), "not a database");
    const before = readFileSync(join(stateDir, "notesnook.db"));

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    // Nothing was quarantined: the pending member is still in the state root.
    expect(readFileSync(join(stateDir, "notesnook.db")).equals(before)).toBe(true);
    expect(existsSync(join(quarantineRoot(stateDir), id, "notesnook.db"))).toBe(false);
  });

  // Regression pin for the crash window the resume probe must not break: a
  // crash after the rename but before the manifest write leaves a pending entry
  // whose source is already gone.  reconcileItem resolves it as moved, so the
  // resume must still complete.
  it("resume still completes a pending member that a crash already moved", async () => {
    const root = mkRoot("nookbridge-bundle-resume-crashmove-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);
    const id = "c0ffee00-0123456789ab";
    const entry = plantIncompleteEntry(
      stateDir,
      id,
      {
        version: 1,
        id,
        status: "incomplete",
        items: [
          { name: "nookbridge-storage.db", state: "pending" },
          { name: "notesnook.db", state: "pending" },
          { name: "notesnook-logs.db", state: "pending" },
        ],
      },
      "nookbridge-storage.db",
    );

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;
    expect(result.quarantineId).toBe(id);
    expect(
      readFileSync(join(entry, "nookbridge-storage.db")).equals(
        memberBytes["nookbridge-storage.db"]!,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 1 — credential boundary.
// ---------------------------------------------------------------------------

describe("bundle recovery — credential boundary", () => {
  it("reads the key only from the credential slot, not from env or argv", async () => {
    const root = mkRoot("nookbridge-bundle-cred-source-");
    const { stateDir, key } = buildBundleFixture(root);

    // No credential directory at all: the key cannot be sourced.
    const noCreds = await runBundle(["bundle", "reinitialize", APPROVE, ACK], stateDir);
    expect(noCreds.kind).toBe("error");
    if (noCreds.kind !== "error") return;
    expect(noCreds.exitCode).toBe(2);
    expect(noCreds.message.toLowerCase()).toContain("key");
    expect(existsSync(quarantineRoot(stateDir))).toBe(false);

    // A credential slot with a different key cannot unlock the bundle:
    // the probe must be categorical, not a healthy guess.
    const wrongCreds = join(root, "wrong-credentials");
    mkdirSync(wrongCreds, { mode: 0o700 });
    chmodSync(wrongCreds, 0o700);
    writeFileSync(join(wrongCreds, "nookbridge-db-key"), `${key}-different`, { mode: 0o600 });
    const inspected = await runBundle(["bundle", "inspect"], stateDir, wrongCreds);
    expect(inspected.kind).toBe("bundle-inspection");
    if (inspected.kind !== "bundle-inspection") return;
    expect(inspected.result.kind).toBe("corrupt");
  });

  it("refuses forbidden argv credential carriers", () => {
    const parsed = parseRecoverLocalStateCommand(
      ["bundle", "reinitialize", APPROVE, ACK, "--db-key", "hunter2"],
      {},
    );
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.message).not.toContain("hunter2");
  });

  it("refuses forbidden env key carriers on presence alone", () => {
    const parsed = parseRecoverLocalStateCommand(["bundle", "inspect"], {
      NOOKBRIDGE_DB_KEY: "smuggled-key",
    });
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.message).not.toContain("smuggled-key");
  });

  // Guard G3 (mutant C1): NOOKBRIDGE_DATABASE_KEY is refused on presence alone.
  it("parser refuses NOOKBRIDGE_DATABASE_KEY presence alone", () => {
    const parsed = parseRecoverLocalStateCommand(["bundle", "inspect"], {
      NOOKBRIDGE_DATABASE_KEY: "smuggled-key",
    });
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.message).not.toContain("smuggled-key");
  });
});

// ---------------------------------------------------------------------------
// Property 8 — approval gates.
// ---------------------------------------------------------------------------

describe("bundle reinitialize — approval gates", () => {
  it("refuses without the D2 acknowledgment flag", async () => {
    const root = mkRoot("nookbridge-bundle-gate-ack-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);

    const result = await runBundle(["bundle", "reinitialize", APPROVE], stateDir, credentialsDir);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain(ACK);
    expect(existsSync(quarantineRoot(stateDir))).toBe(false);
  });

  it("refuses without --approve-reinitialize", async () => {
    const root = mkRoot("nookbridge-bundle-gate-approve-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);

    const result = await runBundle(["bundle", "reinitialize", ACK], stateDir, credentialsDir);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain(APPROVE);
    expect(existsSync(quarantineRoot(stateDir))).toBe(false);
  });

  it("refuses a repeated flag rather than treating it as the second gate", async () => {
    const root = mkRoot("nookbridge-bundle-gate-dup-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, APPROVE],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    expect(existsSync(quarantineRoot(stateDir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property 8 (D2) — exact bundle gate refusal and state immutability.
//
// The exact refusal text is the literal emitted by the parser in
// `src/operator/recover-local-state.ts` (the `bundle`/`reinitialize` case):
//   `nookctl recover-local-state bundle reinitialize requires
//    --approve-reinitialize --accept-unsynced-loss`
// with exit code 2.  Every refusal must also leave the quarantine root
// absent and every state member's bytes AND inode unchanged.
// ---------------------------------------------------------------------------

describe("bundle reinitialize — D2 gate refusal (exact) and state immutability", () => {
  const EXACT_GATE_REFUSAL =
    "nookctl recover-local-state bundle reinitialize requires --approve-reinitialize --accept-unsynced-loss";

  async function expectGateRefusal(extra: readonly string[]): Promise<void> {
    const root = mkRoot("nookbridge-bundle-d2gate-");
    const { stateDir, credentialsDir } = buildBundleFixture(root, { sidecars: true });
    const before = snapshotMembers(stateDir);

    const result = await runBundle(["bundle", "reinitialize", ...extra], stateDir, credentialsDir);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe(EXACT_GATE_REFUSAL);
    expect(existsSync(quarantineRoot(stateDir))).toBe(false);
    expect(snapshotMembers(stateDir)).toEqual(before);
  }

  it("(a) refuses --approve-reinitialize alone", async () => {
    await expectGateRefusal([APPROVE]);
  });

  it("(b) refuses --accept-unsynced-loss alone", async () => {
    await expectGateRefusal([ACK]);
  });

  it("(c) refuses --approve-reinitialize plus one unrelated extra flag", async () => {
    await expectGateRefusal([APPROVE, "--dry-run"]);
  });

  it("(d) refuses --accept-unsynced-loss plus one unrelated extra flag", async () => {
    await expectGateRefusal([ACK, "--dry-run"]);
  });

  it("(e) positive control: both required flags together succeed", async () => {
    const root = mkRoot("nookbridge-bundle-d2gate-ok-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const before = snapshotMembers(stateDir);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;
    expect(result.quarantineId).toMatch(/^[a-f0-9]{8}-[a-z0-9]{12,13}$/);
    // The positive control must actually mutate: an entry exists and the
    // live members are no longer the pre-run inodes.
    expect(existsSync(join(quarantineRoot(stateDir), result.quarantineId))).toBe(true);
    const after = snapshotMembers(stateDir);
    for (const member of BUNDLE_MEMBERS) {
      expect(after[member]?.ino).not.toBe(before[member]?.ino);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 7 — the quarantine rm bug: a failed/empty entry must not block.
// ---------------------------------------------------------------------------

describe("quarantine collision — a preserved entry still refuses", () => {
  it("still refuses when the quarantine entry actually preserves state", async () => {
    const root = mkRoot("nookbridge-bundle-rmbug-preserved-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const id = "0123abcd-0123456789ab";
    const entry = join(quarantineRoot(stateDir), id);
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    chmodSync(entry, 0o700);
    writeFileSync(
      join(entry, MANIFEST_NAME),
      JSON.stringify({ version: 1, id, status: "complete", items: [] }),
    );

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message.toLowerCase()).toContain("quarantine");
  });
});

// ---------------------------------------------------------------------------
// Property 7 (bundle path) — recursive removal result.
//
// `removeBundleQuarantineEntry` is the bundle-specific primitive the bundle
// scan uses to clear a leftover entry.  The regression is that a DIRECTORY
// must be removed recursively and the result observed, not merely that no
// exception escaped.  The shared development helper keeps its non-recursive
// upstream semantics and is not exercised here.
// ---------------------------------------------------------------------------

describe("quarantine removal regression — recursive removal result", () => {
  it("returns true and removes an empty directory remnant", () => {
    const root = mkRoot("nookbridge-bundle-rm-result-empty-");
    const remnant = join(root, "entry");
    mkdirSync(remnant, { mode: 0o700 });
    expect(existsSync(remnant)).toBe(true);

    const removed = removeBundleQuarantineEntry(remnant);

    expect(removed).toBe(true);
    expect(existsSync(remnant)).toBe(false);
  });

  it("returns true and removes a nested remnant recursively", () => {
    const root = mkRoot("nookbridge-bundle-rm-result-nested-");
    const remnant = join(root, "entry");
    mkdirSync(join(remnant, "nested", "deeper"), { recursive: true, mode: 0o700 });
    writeFileSync(join(remnant, "nested", "deeper", "leftover"), "stale");
    expect(existsSync(join(remnant, "nested", "deeper", "leftover"))).toBe(true);

    const removed = removeBundleQuarantineEntry(remnant);

    expect(removed).toBe(true);
    expect(existsSync(remnant)).toBe(false);
  });

  it("removes an empty remnant at the bundle quarantine target so reinitialize proceeds", async () => {
    const root = mkRoot("nookbridge-bundle-rm-remnant-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const remnant = join(quarantineRoot(stateDir), "deadbeef-0123456789ab");
    mkdirSync(remnant, { recursive: true, mode: 0o700 });
    chmodSync(remnant, 0o700);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    // Observable post-state: the remnant is gone and a fresh entry exists,
    // rather than a "quarantine collision" refusal.
    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;
    expect(existsSync(remnant)).toBe(false);
    expect(existsSync(join(quarantineRoot(stateDir), result.quarantineId))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI dispatch — the systemd credential directory wiring (D3).
// ---------------------------------------------------------------------------

describe("CLI dispatcher — bundle recovery credential directory", () => {
  async function driveCli(
    argv: readonly string[],
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const captured = { stdout: "", stderr: "" };
    const originalStdout = process.stdout.write.bind(process.stdout);
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await run(["node", "nookctl", ...argv]);
      return { stdout: captured.stdout, stderr: captured.stderr, code };
    } finally {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    }
  }

  it("reads the bundle key from $CREDENTIALS_DIRECTORY via the CLI", async () => {
    const root = mkRoot("nookbridge-bundle-cli-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const previous = process.env["CREDENTIALS_DIRECTORY"];
    process.env["CREDENTIALS_DIRECTORY"] = credentialsDir;
    try {
      const out = await driveCli([
        "recover-local-state",
        "--state-dir",
        stateDir,
        "bundle",
        "inspect",
      ]);
      expect(out.code).toBe(0);
      expect(out.stdout.toLowerCase()).toContain("healthy");
      expect(existsSync(quarantineRoot(stateDir))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["CREDENTIALS_DIRECTORY"];
      else process.env["CREDENTIALS_DIRECTORY"] = previous;
    }
  });

  // Guard G4 (mutant C2): a relative CREDENTIALS_DIRECTORY must not be used.
  it("relative CREDENTIALS_DIRECTORY is not used to read the key", async () => {
    const root = mkRoot("nookbridge-bundle-cli-relcred-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const relPath = relative(process.cwd(), credentialsDir);
    const snapshotBefore = snapshotRegularFileHashes(stateDir);
    const previous = process.env["CREDENTIALS_DIRECTORY"];
    process.env["CREDENTIALS_DIRECTORY"] = relPath;
    try {
      const out = await driveCli([
        "recover-local-state",
        "--state-dir",
        stateDir,
        "bundle",
        "inspect",
      ]);
      // Observed: the relative path is ignored, so no key is available and the
      // probe returns the categorical indeterminate result without touching
      // state (exit code 0 is what the current code actually does).
      expect(out.code).toBe(0);
      expect(out.stdout.toLowerCase()).not.toContain("healthy");
      expect(out.stdout.toLowerCase()).toContain("indeterminate");
      expect(existsSync(quarantineRoot(stateDir))).toBe(false);
      expect(snapshotRegularFileHashes(stateDir)).toEqual(snapshotBefore);
    } finally {
      if (previous === undefined) delete process.env["CREDENTIALS_DIRECTORY"];
      else process.env["CREDENTIALS_DIRECTORY"] = previous;
    }
  });

  // Guard C2 (mutant C2): the CLI must forward only an absolute credentials
  // directory to the bundle runner.  Recorded at the runner boundary, so a
  // relative value cannot pass merely because a later layer refuses it.
  it("C2 — the CLI forwards only an absolute CREDENTIALS_DIRECTORY to the runner", async () => {
    const root = mkRoot("nookbridge-bundle-cli-c2-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const relPath = relative(process.cwd(), credentialsDir);
    const previous = process.env["CREDENTIALS_DIRECTORY"];
    try {
      // Positive control: an absolute directory reaches the runner unchanged.
      credentialDirsSeen.length = 0;
      process.env["CREDENTIALS_DIRECTORY"] = credentialsDir;
      await driveCli(["recover-local-state", "--state-dir", stateDir, "bundle", "inspect"]);
      expect(credentialDirsSeen).toEqual([credentialsDir]);

      // Negative control: a relative directory must never reach the runner.
      credentialDirsSeen.length = 0;
      process.env["CREDENTIALS_DIRECTORY"] = relPath;
      await driveCli(["recover-local-state", "--state-dir", stateDir, "bundle", "inspect"]);
      expect(credentialDirsSeen).toHaveLength(1);
      expect(credentialDirsSeen[0]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env["CREDENTIALS_DIRECTORY"];
      else process.env["CREDENTIALS_DIRECTORY"] = previous;
    }
  });

  // Guard G5 (mutant C3): bundle help must be dispatched through the CLI.
  it("bundle help prints the bundle recovery help through the CLI", async () => {
    const out = await driveCli(["recover-local-state", "bundle", "help"]);
    const help = formatBundleRecoveryHelp();
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(help.split("\n")[0]);
    // The CLI dispatches help directly: exactly the help text, no extra line.
    expect(out.stdout).toBe(help);
  });
});

// ---------------------------------------------------------------------------
// Help surface.
// ---------------------------------------------------------------------------

describe("bundle recovery help", () => {
  it("documents the bundle subcommand and the D2 acknowledgment", async () => {
    const parsed = parseRecoverLocalStateCommand(["bundle", "help"], {});
    expect(parsed.kind).toBe("parsed");
  });

  it("rejects an unknown bundle subcommand categorically", () => {
    const parsed = parseRecoverLocalStateCommand(["bundle", "nuke"], {});
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.message).not.toContain("nuke");
  });
});

// ---------------------------------------------------------------------------
// T1 — the non-bundle help path is byte-identical to upstream/main.
//
// Expected text copied verbatim from
// `git show upstream/main:src/operator/recover-local-state.ts`.
// The `${APPROVE_REINITIALIZE_FLAG}` / `${APPROVE_ROLLBACK_FLAG}` template
// placeholders in the upstream source resolve to the literal flag strings
// below.
// ---------------------------------------------------------------------------

const UPSTREAM_RECOVER_LOCAL_STATE_HELP = [
  "nookctl recover-local-state — Stage 9 bounded, non-destructive local-state recovery",
  "",
  "Usage:",
  "  nookctl recover-local-state [help]                              show this help",
  "  nookctl recover-local-state inspect [--state-dir <path>]        bounded categorical inspection (default; read-only)",
  "  nookctl recover-local-state reinitialize --approve-reinitialize [--state-dir <path>]",
  "                                                                quarantine the original state and reinitialize",
  "  nookctl recover-local-state rollback --approve-rollback <id> [--state-dir <path>]",
  "                                                                restore the preserved state without copy or clobber",
  "",
  "Options:",
  "  --state-dir <path>    state directory to operate on (default: $NOOKBRIDGE_STATE_DIR)",
  "",
  "Safety contract:",
  "  The default invocation is read-only.  Mutation requires the exact",
  "  --approve-reinitialize or --approve-rollback flag on the same line.",
  "  Credentials, keys, bodies, and contents are never accepted through",
  "  argv or env, never echoed, and never logged.  The original state",
  "  is preserved by a restrictive no-copy, no-clobber move into quarantine",
  "  and rollback restores it without replacing an occupied destination.",
  "",
  "Exit codes:",
  "  0  inspect or quarantine/rollback succeeded",
  "  2  invocation error (missing flag, credential carrier, unsafe state root, ...)",
  "  3  filesystem failure during quarantine/rollback",
  "",
].join("\n");

describe("T1 — dev help is byte-identical to upstream/main", () => {
  it("the non-bundle help path equals the upstream help text exactly", () => {
    expect(formatRecoverLocalStateHelp()).toBe(UPSTREAM_RECOVER_LOCAL_STATE_HELP);
  });

  it("the non-bundle help text contains no bundle lines", () => {
    expect(formatRecoverLocalStateHelp()).not.toContain("bundle");
  });
});

// ---------------------------------------------------------------------------
// T2 — the entry-site cleanup branch in discardEmptyEntry.
//
// The branch serves the fresh-run manifest-write failure and the first-move
// failure: both leave an entry that holds at most the recovery manifest, so
// the entry must be removed rather than left behind.  The direct call makes
// the branch observable: with the branch disabled the entry survives.
// ---------------------------------------------------------------------------

describe("T2 — extra entry cleanup (discardEmptyEntry)", () => {
  it("removes a manifest-only leftover so the next reinitialize starts fresh", async () => {
    const root = mkRoot("nookbridge-bundle-discard-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const oldId = "abadcafe-0123456789ab";
    const entry = join(quarantineRoot(stateDir), oldId);
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    chmodSync(entry, 0o700);
    writeFileSync(
      join(entry, MANIFEST_NAME),
      JSON.stringify({
        version: 1,
        id: oldId,
        status: "incomplete",
        items: [
          { name: "nookbridge-storage.db", state: "pending" },
          { name: "notesnook.db", state: "pending" },
          { name: "notesnook-logs.db", state: "pending" },
        ],
      }),
      { mode: 0o600 },
    );

    discardEmptyEntry(entry);

    // Observable result: the manifest-only leftover is gone.
    expect(existsSync(entry)).toBe(false);

    // Observable outcome: the next reinitialize starts FRESH (new id), not a
    // resume of the leftover checkpoint.
    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;
    expect(result.quarantineId).not.toBe(oldId);
  });

  it("never discards an entry that preserves member bytes", () => {
    const root = mkRoot("nookbridge-bundle-discard-preserved-");
    const stateDir = join(root, "state");
    const entry = join(stateDir, "entry");
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    chmodSync(entry, 0o700);
    writeFileSync(join(entry, MANIFEST_NAME), "{}");
    writeFileSync(join(entry, "nookbridge-storage.db"), "preserved-bytes");

    discardEmptyEntry(entry);

    expect(existsSync(entry)).toBe(true);
    expect(existsSync(join(entry, "nookbridge-storage.db"))).toBe(true);
    expect(readFileSync(join(entry, "nookbridge-storage.db"), "utf8")).toBe("preserved-bytes");
  });
});

// ---------------------------------------------------------------------------
// T3 — bundle inspect against a real SQLite WAL fixture.
//
// Generated entirely in a temp directory: WAL journal mode with one write
// left uncheckpointed, so a real `-wal` file exists.  The guarantee under
// test is that inspect does not change the database bytes or any non-shm
// sidecar; SQLite may legitimately refresh the shared-memory `-shm` index.
// ---------------------------------------------------------------------------

describe("T3 — bundle inspect with a real WAL sidecar", () => {
  it("leaves the database and the -wal sidecar unchanged", async () => {
    const root = mkRoot("nookbridge-bundle-wal-");
    const { stateDir, credentialsDir, key } = buildBundleFixture(root);

    const handles = BUNDLE_MEMBERS.map((member) => {
      const storage = new SqliteStorage({
        dbPath: join(stateDir, member),
        key,
        withExtensions: false,
      });
      storage.db.pragma("journal_mode = WAL");
      storage.db.pragma("wal_autocheckpoint = 0");
      storage.exec("CREATE TABLE IF NOT EXISTS wal_marker(x TEXT)");
      storage.run("INSERT INTO wal_marker(x) VALUES(?)", [member]);
      return storage;
    });

    try {
      for (const member of BUNDLE_MEMBERS) {
        expect(existsSync(join(stateDir, `${member}-wal`))).toBe(true);
        expect(existsSync(join(stateDir, `${member}-shm`))).toBe(true);
      }

      const before = readBundleSidecarHashes(stateDir);

      const result = await runBundle(["bundle", "inspect"], stateDir, credentialsDir);
      expect(result.kind).toBe("bundle-inspection");
      if (result.kind !== "bundle-inspection") return;
      expect(result.result.kind).toBe("healthy");

      const after = readBundleSidecarHashes(stateDir);
      for (const member of BUNDLE_MEMBERS) {
        // Database bytes are unchanged.
        expect(after[member]![""]).toBe(before[member]![""]);
        // Every non-shm sidecar is unchanged.
        for (const suffix of SIDECAR_SUFFIXES) {
          if (suffix === "-shm") continue;
          expect(after[member]![suffix]).toBe(before[member]![suffix]);
        }
      }
      // `-shm` is SQLite's shared-memory index.  It is NOT byte-stable
      // across an inspection: opening the WAL database read-only refreshes
      // it, so this test deliberately does not assert `-shm` equality.
      // Observed here: `-shm` changed for every member that had a `-wal`,
      // while the database and `-wal` bytes were unchanged.  The guarantee
      // asserted instead is that inspect neither deletes the sidecar nor
      // alters the database or non-shm sidecar bytes.
      for (const member of BUNDLE_MEMBERS) {
        expect(existsSync(join(stateDir, `${member}-shm`))).toBe(true);
      }
    } finally {
      for (const handle of handles) handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T5 — inspect must be byte-stable on a WAL-mode bundle (RED).
//
// Production uses WAL journal mode.  This fixture is the crash-leftover shape:
// three encrypted members with live `-wal` and `-shm` files, copied out of a
// live writer.  It is built directly with the production SQLite library rather
// than `buildBundleFixture` (which is rollback-journal/DELETE mode).
// ---------------------------------------------------------------------------

/** name -> sha256 of every regular file in flat `dir`. */
function snapshotRegularFileHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!lstatSync(path).isFile()) continue;
    out[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return out;
}

/**
 * Build a WAL-mode encrypted bundle and copy it (db + present sidecars) into
 * the fixture's state dir while the writers are still open, producing the
 * crash-leftover shape: each member with a live `-wal` and `-shm`.
 */
function buildWalBundleFixture(
  rootDir: string,
  key = "stage9-bundle-recovery-key",
): { stateDir: string; key: string } {
  const sourceDir = join(rootDir, "wal-source");
  const stateDir = join(rootDir, "state");
  mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  chmodSync(sourceDir, 0o700);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);

  const writers: Array<{ close(): void }> = [];
  try {
    for (const member of BUNDLE_MEMBERS) {
      const db = new Database(join(sourceDir, member));
      db.pragma("cipher='sqlcipher'");
      db.pragma(`key="${key}"`);
      db.pragma("journal_mode = WAL");
      db.pragma("wal_autocheckpoint = 0");
      db.exec("CREATE TABLE IF NOT EXISTS wal_marker(x TEXT)");
      db.prepare("INSERT INTO wal_marker(x) VALUES(?)").run(`${member}-row`);
      writers.push(db);
    }
    for (const member of BUNDLE_MEMBERS) {
      for (const suffix of ["", ...SIDECAR_SUFFIXES]) {
        const from = join(sourceDir, `${member}${suffix}`);
        if (!existsSync(from)) continue;
        writeFileSync(join(stateDir, `${member}${suffix}`), readFileSync(from));
      }
    }
  } finally {
    for (const writer of writers) {
      try {
        writer.close();
      } catch {
        /* best-effort */
      }
    }
  }

  for (const member of BUNDLE_MEMBERS) {
    expect(existsSync(join(stateDir, member)), `${member} db missing`).toBe(true);
    expect(existsSync(join(stateDir, `${member}-wal`)), `${member}-wal missing`).toBe(true);
    expect(existsSync(join(stateDir, `${member}-shm`)), `${member}-shm missing`).toBe(true);
  }
  return { stateDir, key };
}

describe("T5 — inspect is byte-stable on a WAL-mode bundle (RED)", () => {
  it("inspect leaves every byte of a WAL-mode bundle unchanged, including -wal and -shm", () => {
    const root = mkRoot("nookbridge-bundle-wal-byte-");
    const { stateDir, key } = buildWalBundleFixture(root);

    const before = snapshotRegularFileHashes(stateDir);
    for (const member of BUNDLE_MEMBERS) {
      expect(Object.keys(before)).toContain(member);
      expect(Object.keys(before)).toContain(`${member}-wal`);
      expect(Object.keys(before)).toContain(`${member}-shm`);
    }

    const result = inspectProductionBundle(stateDir, key);
    expect(result.kind).toBe("healthy");

    const after = snapshotRegularFileHashes(stateDir);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after).toEqual(before);
  });

  it("inspect creates no -shm and changes no -wal byte when -shm is absent", () => {
    const root = mkRoot("nookbridge-bundle-wal-noshm-");
    const { stateDir, key } = buildWalBundleFixture(root);

    // Model a WAL with no shared-memory index.
    for (const member of BUNDLE_MEMBERS) {
      rmSync(join(stateDir, `${member}-shm`), { force: true });
    }
    const before = snapshotRegularFileHashes(stateDir);

    inspectProductionBundle(stateDir, key);

    const after = snapshotRegularFileHashes(stateDir);
    for (const member of BUNDLE_MEMBERS) {
      expect(existsSync(join(stateDir, `${member}-shm`)), `${member}-shm created`).toBe(false);
    }
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// T6 — inspect on a WAL clean-stop bundle (RED before the fix).
//
// A WAL-mode bundle whose writers have closed cleanly: SQLite checkpoints and
// removes `-wal`/`-shm`, leaving only the three database files.  inspect must
// leave the name set and every hash identical.
// ---------------------------------------------------------------------------

function buildWalCleanStopBundleFixture(
  rootDir: string,
  key = "stage9-bundle-recovery-key",
): { stateDir: string; key: string } {
  const stateDir = join(rootDir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);

  const writers: Array<{ close(): void }> = [];
  try {
    for (const member of BUNDLE_MEMBERS) {
      const db = new Database(join(stateDir, member));
      db.pragma("cipher='sqlcipher'");
      db.pragma(`key="${key}"`);
      db.pragma("journal_mode = WAL");
      db.pragma("wal_autocheckpoint = 0");
      db.exec("CREATE TABLE IF NOT EXISTS wal_marker(x TEXT)");
      db.prepare("INSERT INTO wal_marker(x) VALUES(?)").run(`${member}-row`);
      writers.push(db);
    }
  } finally {
    for (const writer of writers) {
      try {
        writer.close();
      } catch {
        /* best-effort */
      }
    }
  }

  // A clean stop leaves no live WAL or SHM.
  for (const member of BUNDLE_MEMBERS) {
    expect(existsSync(join(stateDir, `${member}-wal`)), `${member}-wal present`).toBe(false);
    expect(existsSync(join(stateDir, `${member}-shm`)), `${member}-shm present`).toBe(false);
  }
  return { stateDir, key };
}

describe("T6 — inspect on a WAL clean-stop bundle", () => {
  it("inspect leaves a clean-stopped WAL-mode bundle byte-identical", () => {
    const root = mkRoot("nookbridge-bundle-wal-cleanstop-");
    const { stateDir, key } = buildWalCleanStopBundleFixture(root);

    const before = snapshotRegularFileHashes(stateDir);

    const result = inspectProductionBundle(stateDir, key);
    expect(result.kind).toBe("healthy");

    const after = snapshotRegularFileHashes(stateDir);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after).toEqual(before);
  });

  it("removes its private temp directory after inspect", () => {
    const root = mkRoot("nookbridge-bundle-wal-tempclean-");
    const { stateDir, key } = buildWalCleanStopBundleFixture(root);

    const prefix = "nookbridge-bundle-inspect-";
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));

    const result = inspectProductionBundle(stateDir, key);
    expect(result.kind).toBe("healthy");

    const after = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));
    expect(after.sort()).toEqual(before.sort());
  });
});

// ---------------------------------------------------------------------------
// G1 — a symlinked sidecar must fail closed without reading its target.
//
// Under M16 `copyRegularFile` no longer rejects symlinks, so the copy step
// follows a symlinked `-wal` into a target outside the state directory and the
// probe can report `healthy`.
// ---------------------------------------------------------------------------

describe("G1 — inspect rejects a symlinked -wal sidecar", () => {
  it("inspect fails closed on a symlinked -wal sidecar and does not read its target", () => {
    const root = mkRoot("nookbridge-bundle-symlink-wal-");
    const { stateDir, key } = buildWalBundleFixture(root);
    const member = BUNDLE_MEMBERS[0];

    // Move the real -wal outside the state directory and leave a symlink in
    // its place.
    const targetDir = mkRoot("nookbridge-bundle-symlink-target-");
    const targetPath = join(targetDir, `${member}-wal`);
    renameSync(join(stateDir, `${member}-wal`), targetPath);
    symlinkSync(targetPath, join(stateDir, `${member}-wal`));
    expect(lstatSync(join(stateDir, `${member}-wal`)).isSymbolicLink()).toBe(true);

    const stateBefore = snapshotRegularFileHashes(stateDir);
    const targetBefore = snapshotRegularFileHashes(targetDir);

    const result = inspectProductionBundle(stateDir, key);
    expect(result).toEqual({ kind: "corrupt" });

    expect(snapshotRegularFileHashes(stateDir)).toEqual(stateBefore);
    expect(snapshotRegularFileHashes(targetDir)).toEqual(targetBefore);
    expect(lstatSync(join(stateDir, `${member}-wal`)).isSymbolicLink()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G2 — the probe-time copy must include the present sidecars.
//
// Under M18 sidecars are never copied into the probe directory, so the probe
// sees no WAL content.  The `vi.mock` wrapper below records the probe-time
// shape of each `inspectEncryptedSqlite` call and delegates unchanged.
// ---------------------------------------------------------------------------

describe("G2 — inspect probes a private copy that includes the sidecars", () => {
  beforeEach(() => {
    probeCalls.length = 0;
  });

  it("inspect probes a private copy that includes the -wal and -shm sidecars", () => {
    const root = mkRoot("nookbridge-bundle-probe-copy-");
    const { stateDir, key } = buildWalBundleFixture(root);
    const member = BUNDLE_MEMBERS[0];
    const originalWalSize = lstatSync(join(stateDir, `${member}-wal`)).size;
    const originalShmSize = lstatSync(join(stateDir, `${member}-shm`)).size;

    const result = inspectProductionBundle(stateDir, key);
    expect(result).toEqual({ kind: "healthy" });

    const call = probeCalls.find((entry) => entry.dbPath.endsWith(`/${member}`));
    expect(call).toBeDefined();
    if (call === undefined) return;

    expect(call.walExists).toBe(true);
    expect(call.walSize).toBe(originalWalSize);
    expect(call.shmExists).toBe(true);
    expect(call.shmSize).toBe(originalShmSize);
  });
});

// ---------------------------------------------------------------------------
// L — the state-directory lock must be held for the whole copy-and-probe and
// released on every path, without ever reclaiming a foreign or stale lock.
// RED against the current inspect, which holds no lock at all.
// ---------------------------------------------------------------------------

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ESRCH";
  }
}

describe("L — inspect state lock", () => {
  beforeEach(() => {
    probeCalls.length = 0;
    probeHook.onProbe = undefined;
  });

  afterEach(() => {
    probeHook.onProbe = undefined;
  });

  it("L1 — inspect holds the state lock while it probes the copy", () => {
    const root = mkRoot("nookbridge-bundle-lock-hold-");
    const { stateDir, key } = buildWalBundleFixture(root);
    const lockSeenAtProbe: boolean[] = [];
    probeHook.onProbe = () => {
      lockSeenAtProbe.push(existsSync(lockPath(stateDir)));
    };

    const result = inspectProductionBundle(stateDir, key);

    expect(result).toEqual({ kind: "healthy" });
    expect(lockSeenAtProbe.length).toBeGreaterThan(0);
    expect(lockSeenAtProbe.every((seen) => seen)).toBe(true);
  });

  it("L2 — inspect releases the lock on a healthy bundle and on a probe error", () => {
    // (a) healthy: the lock must not survive the call.
    const healthyRoot = mkRoot("nookbridge-bundle-lock-release-");
    const healthy = buildWalBundleFixture(healthyRoot);
    const healthyResult = inspectProductionBundle(healthy.stateDir, healthy.key);
    expect(healthyResult).toEqual({ kind: "healthy" });
    expect(existsSync(lockPath(healthy.stateDir))).toBe(false);

    // (b) probe error: a probe that throws becomes a categorical result, never
    // an exception, and the lock is still released.
    const errorRoot = mkRoot("nookbridge-bundle-lock-probe-error-");
    const errored = buildWalBundleFixture(errorRoot);
    let armed = true;
    probeHook.onProbe = () => {
      if (armed) {
        armed = false;
        throw new Error("probe boom");
      }
    };

    expect(inspectProductionBundle(errored.stateDir, errored.key)).toEqual({
      kind: "indeterminate",
    });
    expect(existsSync(lockPath(errored.stateDir))).toBe(false);
  });

  it("L3 — inspect refuses a live lock held by another holder and changes no state bytes", () => {
    const root = mkRoot("nookbridge-bundle-lock-live-");
    const { stateDir, key } = buildWalBundleFixture(root);

    const release = tryAcquireLock(stateDir);
    expect(release).not.toBeNull();
    try {
      const before = snapshotRegularFileHashes(stateDir);
      const result = inspectProductionBundle(stateDir, key);
      expect(result).toEqual({ kind: "locked" });
      expect(snapshotRegularFileHashes(stateDir)).toEqual(before);
    } finally {
      releaseLock(stateDir);
    }
  });

  it("L4 — inspect never reclaims a stale lock file", () => {
    const root = mkRoot("nookbridge-bundle-lock-stale-");
    const { stateDir, key } = buildWalBundleFixture(root);

    // A child that has already exited gives a provably dead PID.
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid;
    expect(typeof deadPid).toBe("number");
    expect(isPidAlive(deadPid as number)).toBe(false);

    // Exact format lock.ts writes: "<pid>\n<startTicks|empty>\n".
    const lockContents = `${deadPid as number}\n\n`;
    writeFileSync(lockPath(stateDir), lockContents, { mode: 0o600 });

    const before = snapshotRegularFileHashes(stateDir);
    const result = inspectProductionBundle(stateDir, key);

    expect(result).toEqual({ kind: "locked" });
    expect(existsSync(lockPath(stateDir))).toBe(true);
    expect(readFileSync(lockPath(stateDir), "utf8")).toBe(lockContents);
    expect(snapshotRegularFileHashes(stateDir)).toEqual(before);
  });

  it("L5 — inspect releases only a lock file it still owns", () => {
    const root = mkRoot("nookbridge-bundle-lock-foreign-");
    const { stateDir, key } = buildWalBundleFixture(root);
    const foreign = "foreign-token\n";
    let armed = true;
    probeHook.onProbe = () => {
      if (armed) {
        armed = false;
        writeFileSync(lockPath(stateDir), foreign, { mode: 0o600 });
      }
    };

    inspectProductionBundle(stateDir, key);

    expect(existsSync(lockPath(stateDir))).toBe(true);
    expect(readFileSync(lockPath(stateDir), "utf8")).toBe(foreign);
  });

  // L6 — the cross-process guarantee rests on the atomic "wx" create, so this
  // test races real child processes.  Under a "wx" -> "w" mutant every child
  // would acquire the lock and the win count would be 8, not 1.
  it("L6 — concurrent acquirers: exactly one process wins the state lock", async () => {
    const root = mkRoot("nookbridge-l6-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const barrierDir = join(root, "barrier");
    mkdirSync(barrierDir, { mode: 0o700 });

    const lockModulePath = join(process.cwd(), "src", "config", "lock.ts");
    const childPath = join(root, "child.ts");
    const childSource = `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { tryAcquireLock } from ${JSON.stringify(lockModulePath)};

async function waitFor(file, capMs) {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

const args = process.argv.slice(-3);
const index = args[0];
const childStateDir = args[1];
const childBarrierDir = args[2];
const resultFile = join(childBarrierDir, "result-" + index + ".txt");

if (!(await waitFor(join(childBarrierDir, "go"), 30000))) {
  writeFileSync(resultFile, "timeout " + process.pid);
  process.exit(1);
}

const release = tryAcquireLock(childStateDir);
if (release) {
  writeFileSync(resultFile, "won " + process.pid);
  const released = await waitFor(join(childBarrierDir, "release"), 30000);
  release();
  process.exit(released ? 0 : 1);
}

writeFileSync(resultFile, "lost " + process.pid);
process.exit(0);
`;
    writeFileSync(childPath, childSource);

    const count = 8;
    const resultPaths = Array.from({ length: count }, (_, index) =>
      join(barrierDir, `result-${index}.txt`),
    );
    const stdio: string[] = [];
    let children: ReturnType<typeof spawn>[] = [];
    try {
      const viteNode = join(process.cwd(), "node_modules", ".bin", "vite-node");
      children = Array.from({ length: count }, (_, index) =>
        spawn(viteNode, [childPath, String(index), stateDir, barrierDir], {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
      for (let index = 0; index < children.length; index += 1) {
        stdio[index] = "";
        const child = children[index];
        if (child === undefined) continue;
        child.stdout?.on("data", (chunk: unknown) => {
          stdio[index] = (stdio[index] ?? "") + String(chunk);
        });
        child.stderr?.on("data", (chunk: unknown) => {
          stdio[index] = (stdio[index] ?? "") + String(chunk);
        });
      }

      const waitUntil = async (predicate: () => boolean, capMs: number): Promise<boolean> => {
        const deadline = Date.now() + capMs;
        while (Date.now() < deadline) {
          if (predicate()) return true;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return predicate();
      };
      const waitForExit = (
        child: ReturnType<typeof spawn>,
        capMs: number,
      ): Promise<number | null> =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve(child.exitCode);
            return;
          }
          const timer = setTimeout(() => resolve(null), capMs);
          child.on("exit", (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });

      // The barrier synchronizes the race; no sleep masks it.
      writeFileSync(join(barrierDir, "go"), "");
      const recorded = await waitUntil(() => resultPaths.every((path) => existsSync(path)), 30000);
      const diagnostic = `child stdout/stderr:\n${stdio.join("\n---\n")}`;
      expect(recorded, diagnostic).toBe(true);

      const results = resultPaths.map((path) =>
        existsSync(path) ? readFileSync(path, "utf8").trim() : "",
      );
      const wins = results.filter((result) => result.startsWith("won "));
      const losses = results.filter((result) => result.startsWith("lost "));
      expect(wins.length, diagnostic).toBe(1);
      expect(losses.length, diagnostic).toBe(7);

      const lockFile = lockPath(stateDir);
      expect(existsSync(lockFile)).toBe(true);
      const firstLine = (readFileSync(lockFile, "utf8").split("\n")[0] ?? "").trim();
      expect(firstLine).toBe((wins[0] ?? "").split(/\s+/)[1]);

      writeFileSync(join(barrierDir, "release"), "");
      const codes = await Promise.all(children.map((child) => waitForExit(child, 30000)));
      for (const code of codes) expect(code, diagnostic).toBe(0);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* best-effort */
          }
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it("L7 — inspect unlinks the lock only while it is still the inode it created", () => {
    const root = mkRoot("nookbridge-bundle-lock-inode-");
    const { stateDir, key } = buildWalBundleFixture(root);
    const path = lockPath(stateDir);
    let record = "";
    let armed = true;
    probeHook.onProbe = () => {
      if (!armed) return;
      armed = false;
      // Replace the lock file with a new inode that carries identical bytes.
      record = readFileSync(path, "utf8");
      unlinkSync(path);
      writeFileSync(path, record, { mode: 0o600 });
    };

    inspectProductionBundle(stateDir, key);

    // The release must not unlink a lock file that is no longer the inode it
    // created, even though the bytes still match.
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(record);
  });

  it("L8 — inspect sweeps a stale copy dir whose owner pid is dead", () => {
    const hostTmp = tmpdir();
    const previousTmpdir = process.env["TMPDIR"];
    const privateTmp = mkdtempSync(join(hostTmp, "nookbridge-l8-"));
    process.env["TMPDIR"] = privateTmp;
    try {
      const root = mkRoot("nookbridge-bundle-l8-fixture-");
      const { stateDir, key } = buildWalBundleFixture(root);
      const stateBefore = snapshotRegularFileHashes(stateDir);

      const stale = join(privateTmp, "nookbridge-bundle-inspect-stale");
      mkdirSync(stale, { recursive: true, mode: 0o700 });
      writeFileSync(join(stale, "old.db"), "old");
      const child = spawnSync(process.execPath, ["-e", ""]);
      const deadPid = child.pid;
      expect(typeof deadPid).toBe("number");
      writeFileSync(join(stale, "owner.pid"), String(deadPid));
      backdate(stale);

      inspectProductionBundle(stateDir, key);

      expect(existsSync(stale)).toBe(false);
      expect(snapshotRegularFileHashes(stateDir)).toEqual(stateBefore);
    } finally {
      if (previousTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmpdir;
      rmSync(privateTmp, { recursive: true, force: true });
    }
  });

  it("L9 — inspect keeps a copy dir whose owner pid is alive", () => {
    const hostTmp = tmpdir();
    const previousTmpdir = process.env["TMPDIR"];
    const privateTmp = mkdtempSync(join(hostTmp, "nookbridge-l9-"));
    process.env["TMPDIR"] = privateTmp;
    try {
      const root = mkRoot("nookbridge-bundle-l9-fixture-");
      const { stateDir, key } = buildWalBundleFixture(root);

      const kept = join(privateTmp, "nookbridge-bundle-inspect-alive");
      mkdirSync(kept, { recursive: true, mode: 0o700 });
      writeFileSync(join(kept, "old.db"), "old");
      writeFileSync(join(kept, "owner.pid"), String(process.pid));
      backdate(kept);

      inspectProductionBundle(stateDir, key);

      expect(existsSync(kept)).toBe(true);
      expect(readFileSync(join(kept, "old.db"), "utf8")).toBe("old");
    } finally {
      if (previousTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmpdir;
      rmSync(privateTmp, { recursive: true, force: true });
    }
  });

  it("L10 — inspect never follows or deletes a symlink that matches the prefix", () => {
    const hostTmp = tmpdir();
    const previousTmpdir = process.env["TMPDIR"];
    const privateTmp = mkdtempSync(join(hostTmp, "nookbridge-l10-"));
    process.env["TMPDIR"] = privateTmp;
    try {
      const root = mkRoot("nookbridge-bundle-l10-fixture-");
      const { stateDir, key } = buildWalBundleFixture(root);

      const victim = join(privateTmp, "victim");
      mkdirSync(victim, { mode: 0o700 });
      writeFileSync(join(victim, "keep.txt"), "keep");
      const child = spawnSync(process.execPath, ["-e", ""]);
      const deadPid = child.pid;
      expect(typeof deadPid).toBe("number");
      writeFileSync(join(victim, "owner.pid"), String(deadPid));
      const link = join(privateTmp, "nookbridge-bundle-inspect-link");
      symlinkSync(victim, link);

      inspectProductionBundle(stateDir, key);

      expect(existsSync(victim)).toBe(true);
      expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(link)).toBe(true);
    } finally {
      if (previousTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmpdir;
      rmSync(privateTmp, { recursive: true, force: true });
    }
  });

  it("L11 — inspect leaves a prefixed dir with no owner file alone", () => {
    const hostTmp = tmpdir();
    const previousTmpdir = process.env["TMPDIR"];
    const privateTmp = mkdtempSync(join(hostTmp, "nookbridge-l11-"));
    process.env["TMPDIR"] = privateTmp;
    try {
      const root = mkRoot("nookbridge-bundle-l11-fixture-");
      const { stateDir, key } = buildWalBundleFixture(root);

      const noOwner = join(privateTmp, "nookbridge-bundle-inspect-noowner");
      mkdirSync(noOwner, { recursive: true, mode: 0o700 });
      writeFileSync(join(noOwner, "x.db"), "x");
      backdate(noOwner);

      inspectProductionBundle(stateDir, key);

      expect(existsSync(noOwner)).toBe(true);
    } finally {
      if (previousTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmpdir;
      rmSync(privateTmp, { recursive: true, force: true });
    }
  });

  it("L12 — inspect's copy dir is mode 0700 and records its owner pid while the probe runs", () => {
    const hostTmp = tmpdir();
    const previousTmpdir = process.env["TMPDIR"];
    const privateTmp = mkdtempSync(join(hostTmp, "nookbridge-l12-"));
    process.env["TMPDIR"] = privateTmp;
    try {
      const root = mkRoot("nookbridge-bundle-l12-fixture-");
      const { stateDir, key } = buildWalBundleFixture(root);

      const prefix = "nookbridge-bundle-inspect-";
      let observed = false;
      probeHook.onProbe = () => {
        const entry = readdirSync(privateTmp).find((name) => name.startsWith(prefix));
        expect(entry).toBeDefined();
        if (entry === undefined) return;
        const copyDir = join(privateTmp, entry);
        expect(lstatSync(copyDir).mode & 0o777).toBe(0o700);
        const ownerFile = join(copyDir, "owner.pid");
        expect(existsSync(ownerFile)).toBe(true);
        expect(readFileSync(ownerFile, "utf8")).toBe(String(process.pid));
        observed = true;
      };

      inspectProductionBundle(stateDir, key);

      expect(observed).toBe(true);
    } finally {
      if (previousTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmpdir;
      rmSync(privateTmp, { recursive: true, force: true });
    }
  });

  it("L13 — inspect keeps a copy dir whose owner pid is 1", () => {
    const hostTmp = tmpdir();
    const previousTmpdir = process.env["TMPDIR"];
    const privateTmp = mkdtempSync(join(hostTmp, "nookbridge-l13-"));
    process.env["TMPDIR"] = privateTmp;
    try {
      const root = mkRoot("nookbridge-bundle-l13-fixture-");
      const { stateDir, key } = buildWalBundleFixture(root);

      const kept = join(privateTmp, "nookbridge-bundle-inspect-pid1");
      mkdirSync(kept, { recursive: true, mode: 0o700 });
      writeFileSync(join(kept, "old.db"), "old");
      writeFileSync(join(kept, "owner.pid"), "1");
      backdate(kept);

      inspectProductionBundle(stateDir, key);

      // Pid 1 is EPERM for a non-root user and alive for root: kept either way.
      expect(existsSync(kept)).toBe(true);
      expect(readFileSync(join(kept, "old.db"), "utf8")).toBe("old");
    } finally {
      if (previousTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmpdir;
      rmSync(privateTmp, { recursive: true, force: true });
    }
  });

  // L14 — the age gate: a fresh copy dir with a dead owner is still kept.
  it("L14 — inspect keeps a copy dir younger than the sweep age gate", () => {
    const hostTmp = tmpdir();
    const previousTmpdir = process.env["TMPDIR"];
    const privateTmp = mkdtempSync(join(hostTmp, "nookbridge-l14-"));
    process.env["TMPDIR"] = privateTmp;
    try {
      const root = mkRoot("nookbridge-bundle-l14-fixture-");
      const { stateDir, key } = buildWalBundleFixture(root);

      // Owner pid is dead, but the directory is fresh: the age gate must hold.
      const young = join(privateTmp, "nookbridge-bundle-inspect-young");
      mkdirSync(young, { recursive: true, mode: 0o700 });
      writeFileSync(join(young, "old.db"), "old");
      const child = spawnSync(process.execPath, ["-e", ""]);
      const deadPid = child.pid;
      expect(typeof deadPid).toBe("number");
      writeFileSync(join(young, "owner.pid"), String(deadPid));

      inspectProductionBundle(stateDir, key);

      expect(existsSync(young)).toBe(true);
    } finally {
      if (previousTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmpdir;
      rmSync(privateTmp, { recursive: true, force: true });
    }
  });

  // Guard G1 (mutant M24): the sweep must require current-uid ownership.
  it("sweep does not delete a copy dir owned by another uid", () => {
    const hostTmp = tmpdir();
    const previousTmpdir = process.env["TMPDIR"];
    const privateTmp = mkdtempSync(join(hostTmp, "nookbridge-g1-"));
    process.env["TMPDIR"] = privateTmp;
    const getuid = process.getuid;
    let restoreUid: (() => void) | undefined;
    if (typeof getuid === "function") {
      // `process.getuid` is optional in @types/node; narrow the spy target so
      // the mock typechecks without changing runtime behaviour.
      const spy = vi.spyOn(process as typeof process & { getuid: () => number }, "getuid");
      spy.mockReturnValue(getuid() + 1);
      restoreUid = () => spy.mockRestore();
    }
    try {
      const root = mkRoot("nookbridge-bundle-g1-fixture-");
      const { stateDir, key } = buildWalBundleFixture(root);

      const stale = join(privateTmp, "nookbridge-bundle-inspect-otheruid");
      mkdirSync(stale, { recursive: true, mode: 0o700 });
      writeFileSync(join(stale, "old.db"), "old");
      const child = spawnSync(process.execPath, ["-e", ""]);
      const deadPid = child.pid;
      expect(typeof deadPid).toBe("number");
      writeFileSync(join(stale, "owner.pid"), String(deadPid));
      backdate(stale);

      inspectProductionBundle(stateDir, key);

      // The dir is owned by the real uid, not the stubbed one: kept.
      expect(existsSync(stale)).toBe(true);
    } finally {
      restoreUid?.();
      if (previousTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmpdir;
      rmSync(privateTmp, { recursive: true, force: true });
    }
  });

  // Guard G2 (mutant M26): owner.pid must match /^[1-9][0-9]*$/.
  it("sweep keeps a copy dir whose owner.pid is not a positive integer", () => {
    const hostTmp = tmpdir();
    const previousTmpdir = process.env["TMPDIR"];
    const privateTmp = mkdtempSync(join(hostTmp, "nookbridge-g2-"));
    process.env["TMPDIR"] = privateTmp;
    try {
      const root = mkRoot("nookbridge-bundle-g2-fixture-");
      const { stateDir, key } = buildWalBundleFixture(root);

      const stale = join(privateTmp, "nookbridge-bundle-inspect-nonpositive");
      mkdirSync(stale, { recursive: true, mode: 0o700 });
      writeFileSync(join(stale, "old.db"), "old");
      writeFileSync(join(stale, "owner.pid"), "-99999999");
      backdate(stale);

      inspectProductionBundle(stateDir, key);

      // The negative pid is not a positive integer: kept.
      expect(existsSync(stale)).toBe(true);
    } finally {
      if (previousTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmpdir;
      rmSync(privateTmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — bundle rollback (RED: the command is not implemented yet).
//
// Command shape: `bundle rollback --approve-rollback <id>`, reusing the
// existing APPROVE_ROLLBACK_FLAG.  Refusal messages follow the existing
// dev-path style ("nookctl recover-local-state bundle rollback: ...").
// ---------------------------------------------------------------------------

const ROLLBACK_REQUIRES =
  "nookctl recover-local-state bundle rollback requires --approve-rollback <id>";
const ROLLBACK_OPAQUE = "nookctl recover-local-state bundle rollback: refusing opaque identifier";
const ROLLBACK_OCCUPIED = "nookctl recover-local-state bundle rollback: destination is occupied";
const ROLLBACK_INCOMPLETE =
  "nookctl recover-local-state bundle rollback: preserved state is incomplete";
const ROLLBACK_UNKNOWN =
  "nookctl recover-local-state bundle rollback: unknown quarantine identifier";
const ROLLBACK_ID = "deadbeef-0123456789ab";

function validManifest(id: string): string {
  return JSON.stringify({
    version: 1,
    id,
    status: "complete",
    items: [
      { name: "nookbridge-storage.db", state: "moved" },
      { name: "notesnook.db", state: "moved" },
      { name: "notesnook-logs.db", state: "moved" },
    ],
  });
}

/** Remove the three fresh members so a rollback destination is free. */
function clearFreshMembers(stateDir: string): void {
  for (const member of BUNDLE_MEMBERS) {
    rmSync(join(stateDir, member), { force: true });
  }
}

describe("T4 — bundle rollback (RED)", () => {
  it("(a) round trip restores members and sidecars byte-for-byte with their original inodes", async () => {
    const root = mkRoot("nookbridge-bundle-rb-roundtrip-");
    const { stateDir, credentialsDir } = buildBundleFixture(root, { sidecars: true });
    const before = snapshotTreeWithInodes(stateDir);

    const reinit = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(reinit.kind).toBe("reinitialized");
    if (reinit.kind !== "reinitialized") return;

    clearFreshMembers(stateDir);

    const rolled = await runBundle(
      ["bundle", "rollback", ROLLBACK, reinit.quarantineId],
      stateDir,
      credentialsDir,
    );
    expect(rolled.kind).toBe("rolled-back");
    if (rolled.kind !== "rolled-back") return;
    expect(rolled.quarantineId).toBe(reinit.quarantineId);

    const after = snapshotTreeWithInodes(stateDir);
    for (const [relative, snapshot] of Object.entries(before)) {
      expect(after[relative], relative).toBeDefined();
      expect(after[relative]!.bytes, `${relative} bytes`).toBe(snapshot.bytes);
      expect(after[relative]!.ino, `${relative} inode`).toBe(snapshot.ino);
    }
    expect(existsSync(join(quarantineRoot(stateDir), reinit.quarantineId))).toBe(false);
  });

  it("(b) refuses without --approve-rollback and mutates nothing", async () => {
    const root = mkRoot("nookbridge-bundle-rb-noflag-");
    const { stateDir, credentialsDir } = buildBundleFixture(root, { sidecars: true });
    const before = snapshotTreeWithInodes(stateDir);

    const result = await runBundle(["bundle", "rollback", ROLLBACK_ID], stateDir, credentialsDir);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe(ROLLBACK_REQUIRES);
    expect(snapshotTreeWithInodes(stateDir)).toEqual(before);
  });

  it("(c) refuses a repeated --approve-rollback and an extra unrelated flag, mutating nothing", async () => {
    const root = mkRoot("nookbridge-bundle-rb-shape-");
    const { stateDir, credentialsDir } = buildBundleFixture(root, { sidecars: true });
    const before = snapshotTreeWithInodes(stateDir);

    const repeated = await runBundle(
      ["bundle", "rollback", ROLLBACK, ROLLBACK, ROLLBACK_ID],
      stateDir,
      credentialsDir,
    );
    expect(repeated.kind).toBe("error");
    if (repeated.kind === "error") {
      expect(repeated.exitCode).toBe(2);
      expect(repeated.message).toBe(ROLLBACK_REQUIRES);
    }

    const extra = await runBundle(
      ["bundle", "rollback", ROLLBACK, ROLLBACK_ID, "--dry-run"],
      stateDir,
      credentialsDir,
    );
    expect(extra.kind).toBe("error");
    if (extra.kind === "error") {
      expect(extra.exitCode).toBe(2);
      expect(extra.message).toBe(ROLLBACK_REQUIRES);
    }

    expect(snapshotTreeWithInodes(stateDir)).toEqual(before);
  });

  it("(d) refuses malformed, traversal, and credential-shaped ids, mutating nothing", async () => {
    const ids = ["not-a-valid-id", "../../../etc", "NOOKBRIDGE_PASSWORD=hunter2"];
    for (const id of ids) {
      // Reuse the existing dev-path opaque-id validator; do not define one.
      expect(QUARANTINE_ID_PATTERN.test(id)).toBe(false);
    }

    const root = mkRoot("nookbridge-bundle-rb-ids-");
    const { stateDir, credentialsDir } = buildBundleFixture(root, { sidecars: true });
    const before = snapshotTreeWithInodes(stateDir);

    for (const id of ids) {
      const result = await runBundle(
        ["bundle", "rollback", ROLLBACK, id],
        stateDir,
        credentialsDir,
      );
      expect(result.kind).toBe("error");
      if (result.kind !== "error") continue;
      expect(result.exitCode).toBe(2);
      expect(result.message).toBe(ROLLBACK_OPAQUE);
    }

    expect(snapshotTreeWithInodes(stateDir)).toEqual(before);
  });

  it("(e) refuses when a destination member is already present and never displaces it", async () => {
    const root = mkRoot("nookbridge-bundle-rb-occupied-");
    const { stateDir, credentialsDir } = buildBundleFixture(root, { sidecars: true });

    const reinit = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(reinit.kind).toBe("reinitialized");
    if (reinit.kind !== "reinitialized") return;

    const before = snapshotTreeWithInodes(stateDir);

    const result = await runBundle(
      ["bundle", "rollback", ROLLBACK, reinit.quarantineId],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe(ROLLBACK_OCCUPIED);
    // The existing (fresh) destination files are never displaced.
    expect(snapshotTreeWithInodes(stateDir)).toEqual(before);
  });

  it("(f) refuses an incomplete entry: manifest missing, malformed, or naming an absent member", async () => {
    const cases: Array<{ name: string; setup: (stateDir: string, id: string) => void }> = [
      {
        name: "manifest missing",
        setup: (stateDir, id) => {
          const entry = join(quarantineRoot(stateDir), id);
          mkdirSync(entry, { recursive: true, mode: 0o700 });
          writeFileSync(join(entry, "nookbridge-storage.db"), "preserved");
        },
      },
      {
        name: "manifest malformed",
        setup: (stateDir, id) => {
          const entry = join(quarantineRoot(stateDir), id);
          mkdirSync(entry, { recursive: true, mode: 0o700 });
          writeFileSync(join(entry, MANIFEST_NAME), "{not-json", { mode: 0o600 });
          for (const member of BUNDLE_MEMBERS) {
            writeFileSync(join(entry, member), "preserved");
          }
        },
      },
      {
        name: "member the manifest names is absent",
        setup: (stateDir, id) => {
          const entry = join(quarantineRoot(stateDir), id);
          mkdirSync(entry, { recursive: true, mode: 0o700 });
          writeFileSync(join(entry, MANIFEST_NAME), validManifest(id), { mode: 0o600 });
          writeFileSync(join(entry, "nookbridge-storage.db"), "preserved");
          writeFileSync(join(entry, "notesnook.db"), "preserved");
          // notesnook-logs.db is deliberately missing.
        },
      },
      {
        name: "initializing checkpoint (fresh init interrupted after every move)",
        setup: (stateDir, id) => {
          const entry = join(quarantineRoot(stateDir), id);
          mkdirSync(entry, { recursive: true, mode: 0o700 });
          writeFileSync(
            join(entry, MANIFEST_NAME),
            JSON.stringify({
              version: 1,
              id,
              status: "initializing",
              items: BUNDLE_MEMBERS.map((name) => ({ name, state: "moved" })),
            }),
            { mode: 0o600 },
          );
          for (const member of BUNDLE_MEMBERS) {
            writeFileSync(join(entry, member), "preserved");
          }
        },
      },
    ];

    for (const testCase of cases) {
      const root = mkRoot("nookbridge-bundle-rb-incomplete-");
      const { stateDir, credentialsDir } = buildBundleFixture(root);
      testCase.setup(stateDir, ROLLBACK_ID);
      const before = snapshotTreeWithInodes(stateDir);

      const result = await runBundle(
        ["bundle", "rollback", ROLLBACK, ROLLBACK_ID],
        stateDir,
        credentialsDir,
      );

      expect(result.kind, testCase.name).toBe("error");
      if (result.kind !== "error") continue;
      expect(result.exitCode, testCase.name).toBe(2);
      expect(result.message, testCase.name).toBe(ROLLBACK_INCOMPLETE);
      expect(snapshotTreeWithInodes(stateDir), testCase.name).toEqual(before);
    }
  });

  it("(g) a second rollback with the same id is refused and mutates nothing", async () => {
    const root = mkRoot("nookbridge-bundle-rb-twice-");
    const { stateDir, credentialsDir } = buildBundleFixture(root, { sidecars: true });

    const reinit = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(reinit.kind).toBe("reinitialized");
    if (reinit.kind !== "reinitialized") return;
    clearFreshMembers(stateDir);

    const first = await runBundle(
      ["bundle", "rollback", ROLLBACK, reinit.quarantineId],
      stateDir,
      credentialsDir,
    );
    expect(first.kind).toBe("rolled-back");
    if (first.kind !== "rolled-back") return;

    const afterFirst = snapshotTreeWithInodes(stateDir);

    const second = await runBundle(
      ["bundle", "rollback", ROLLBACK, reinit.quarantineId],
      stateDir,
      credentialsDir,
    );
    expect(second.kind).toBe("error");
    if (second.kind !== "error") return;
    expect(second.exitCode).toBe(2);
    expect(second.message).toBe(ROLLBACK_UNKNOWN);
    expect(snapshotTreeWithInodes(stateDir)).toEqual(afterFirst);
  });

  it("(h) works with no credentials directory set and does not read the key", async () => {
    const root = mkRoot("nookbridge-bundle-rb-nocreds-");
    const { stateDir, credentialsDir } = buildBundleFixture(root, { sidecars: true });

    const reinit = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(reinit.kind).toBe("reinitialized");
    if (reinit.kind !== "reinitialized") return;
    clearFreshMembers(stateDir);

    // No credentialsDirectory argument at all: rollback does not need the key.
    const result = await runBundle(["bundle", "rollback", ROLLBACK, reinit.quarantineId], stateDir);

    expect(result.kind).toBe("rolled-back");
  });

  it("(i) atomic undo: a failed mid-restore move puts completed moves back", async () => {
    const root = mkRoot("nookbridge-bundle-rb-atomic-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);

    const reinit = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(reinit.kind).toBe("reinitialized");
    if (reinit.kind !== "reinitialized") return;
    const entry = join(quarantineRoot(stateDir), reinit.quarantineId);

    // The restore plan is PRODUCTION_BUNDLE_MEMBERS in order, so the first
    // move is `nookbridge-storage.db` and the second is `notesnook.db`.
    const firstMember = BUNDLE_MEMBERS[0];
    const secondMember = BUNDLE_MEMBERS[1];
    const firstEntryPath = join(entry, firstMember);
    const firstBefore = {
      bytes: readFileSync(firstEntryPath).toString("hex"),
      ino: lstatSync(firstEntryPath).ino,
    };

    // Free the fresh destinations the reinitialize wrote, then force the
    // SECOND move to fail after the FIRST succeeds.  The move hook plants an
    // occupant at the second destination AFTER the occupied pre-check has
    // passed, so `linkSync` fails EEXIST on the forward move.
    clearFreshMembers(stateDir);
    moveHook.beforeMove = (_source, destination) => {
      if (destination === join(stateDir, secondMember)) {
        writeFileSync(destination, "occupant");
      }
    };

    const result = await runBundle(
      ["bundle", "rollback", ROLLBACK, reinit.quarantineId],
      stateDir,
      credentialsDir,
    ).finally(() => {
      moveHook.beforeMove = undefined;
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(3);
    expect(result.message).toBe(
      "nookctl recover-local-state bundle rollback: failed to restore preserved state",
    );

    // The completed first move was undone: same bytes and inode, back in the
    // entry, and no longer in the state dir.
    expect(lstatSync(firstEntryPath).ino).toBe(firstBefore.ino);
    expect(readFileSync(firstEntryPath).toString("hex")).toBe(firstBefore.bytes);
    expect(existsSync(join(stateDir, firstMember))).toBe(false);
    // The entry itself survives the failed rollback.
    expect(existsSync(entry)).toBe(true);
  });

  it("(k) a failed undo is reported as a partial restore, not a clean restore failure", async () => {
    const root = mkRoot("nookbridge-bundle-rb-undo-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);

    const reinit = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(reinit.kind).toBe("reinitialized");
    if (reinit.kind !== "reinitialized") return;
    const entry = join(quarantineRoot(stateDir), reinit.quarantineId);

    // Forward move 1 (first member) succeeds; forward move 2 fails because the
    // hook plants an occupant at its destination after the pre-check, as in
    // test (i).  The undo of move 1 is then made to fail by planting an
    // occupant at its vacated entry path.  Forward moves target the state
    // root, so only the undo's destination ends with the quarantine id plus
    // the member name.
    const firstMember = BUNDLE_MEMBERS[0];
    const secondMember = BUNDLE_MEMBERS[1];
    clearFreshMembers(stateDir);
    moveHook.beforeMove = (_source, destination) => {
      if (destination === join(stateDir, secondMember)) {
        writeFileSync(destination, "occupant");
      }
      if (destination.endsWith(join(reinit.quarantineId, firstMember))) {
        writeFileSync(destination, "occupant");
      }
    };

    const result = await runBundle(
      ["bundle", "rollback", ROLLBACK, reinit.quarantineId],
      stateDir,
      credentialsDir,
    ).finally(() => {
      moveHook.beforeMove = undefined;
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(3);
    expect(result.message).toBe(
      "nookctl recover-local-state bundle rollback: restore partially applied; manual recovery required",
    );
    // The undo could not move the first member back, so it is still in the
    // state root and the entry survives for manual recovery.
    expect(existsSync(join(stateDir, firstMember))).toBe(true);
    expect(existsSync(entry)).toBe(true);
  });

  it("(l) a dangling symlink at a restore destination refuses rollback with no moves", async () => {
    const root = mkRoot("nookbridge-bundle-rb-dangling-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);

    const reinit = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(reinit.kind).toBe("reinitialized");
    if (reinit.kind !== "reinitialized") return;
    const entry = join(quarantineRoot(stateDir), reinit.quarantineId);

    // `existsSync` reports a dangling symlink as absent.  The occupied
    // pre-check must still see it, so no member may move.
    const firstMember = BUNDLE_MEMBERS[0];
    const secondMember = BUNDLE_MEMBERS[1];
    clearFreshMembers(stateDir);
    symlinkSync(join(stateDir, "definitely-absent-target"), join(stateDir, secondMember));

    const result = await runBundle(
      ["bundle", "rollback", ROLLBACK, reinit.quarantineId],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe(ROLLBACK_OCCUPIED);
    expect(existsSync(join(entry, firstMember))).toBe(true);
    expect(existsSync(join(stateDir, firstMember))).toBe(false);
    expect(lstatSync(join(stateDir, secondMember)).isSymbolicLink()).toBe(true);
  });

  it("(j) rollback refuses when the state directory lock is held, mutating nothing", async () => {
    const root = mkRoot("nookbridge-bundle-rb-lock-");
    const { stateDir, credentialsDir } = buildBundleFixture(root, { sidecars: true });

    const reinit = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(reinit.kind).toBe("reinitialized");
    if (reinit.kind !== "reinitialized") return;
    // Free the destinations so that, were the lock check absent, the rollback
    // would actually move members and the mutation would be observable.
    clearFreshMembers(stateDir);

    // Same mechanism the reinitialize lock-refusal test uses: a lock file
    // held by this (live) process.
    writeFileSync(lockPath(stateDir), `${process.pid}\n`);
    const before = snapshotTreeWithInodes(stateDir);

    const result = await runBundle(
      ["bundle", "rollback", ROLLBACK, reinit.quarantineId],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe("state directory is currently locked by another process");
    // No member moved and the entry is intact (bytes and inodes unchanged).
    expect(snapshotTreeWithInodes(stateDir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// M — reinitialize integrity probe.
//
// reinitialize must run a healthy read-only integrity probe of the original
// before it moves anything.  A readable-but-unhealthy result is still moved
// (so corruption recovery keeps working); an original that cannot be read or
// classified refuses with no moves.
// ---------------------------------------------------------------------------

describe("M — reinitialize integrity probe", () => {
  it("R1 — reinitialize refuses with no moves when the original cannot be probed", async () => {
    const root = mkRoot("nookbridge-bundle-reinit-probe-");
    const { stateDir } = buildBundleFixture(root);

    // A credentials slot holding a key that does not match the bundle.
    const wrongCredentials = join(root, "wrong-credentials");
    mkdirSync(wrongCredentials, { recursive: true, mode: 0o700 });
    chmodSync(wrongCredentials, 0o700);
    writeFileSync(join(wrongCredentials, "nookbridge-db-key"), "a-different-key", { mode: 0o600 });

    const before = snapshotRegularFileHashes(stateDir);
    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      wrongCredentials,
    );

    expect(result.kind).toBe("error");
    expect(snapshotRegularFileHashes(stateDir)).toEqual(before);
    const qRoot = quarantineRoot(stateDir);
    if (existsSync(qRoot)) {
      expect(readdirSync(qRoot)).toEqual([]);
    }
  });

  it("R-dangling — a dangling -wal symlink refuses reinitialize with no moves", async () => {
    const root = mkRoot("nookbridge-bundle-reinit-dangling-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);

    // A dangling symlink at a recognized sidecar path.  `existsSync` reports
    // false for it, so an existence-based scan would silently skip it and move
    // the database while the symlink stayed behind.
    const member = BUNDLE_MEMBERS[0];
    symlinkSync(join(stateDir, "definitely-absent-target"), join(stateDir, `${member}-wal`));
    expect(existsSync(join(stateDir, `${member}-wal`))).toBe(false);
    expect(lstatSync(join(stateDir, `${member}-wal`)).isSymbolicLink()).toBe(true);

    const before = snapshotRegularFileHashes(stateDir);
    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    // Nothing was moved: the database, its manifest-listed members, and the
    // dangling symlink all remain where they were.
    expect(snapshotRegularFileHashes(stateDir)).toEqual(before);
    expect(lstatSync(join(stateDir, `${member}-wal`)).isSymbolicLink()).toBe(true);
  });

  it("R3 — healthy original reinitializes without re-entering the lock", async () => {
    const root = mkRoot("nookbridge-bundle-reinit-lock-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("reinitialized");
  });

  it("P1 — forbidden env carrier NOOKBRIDGE_DATABASE_KEY is refused", () => {
    const parsed = parseRecoverLocalStateCommand(["bundle", "inspect"], {
      NOOKBRIDGE_DATABASE_KEY: "smuggled",
    });
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.message).not.toContain("smuggled");
  });

  it("P2 — forbidden env carrier NOOKBRIDGE_DB_PASSWORD is refused", () => {
    const parsed = parseRecoverLocalStateCommand(["bundle", "inspect"], {
      NOOKBRIDGE_DB_PASSWORD: "smuggled",
    });
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.message).not.toContain("smuggled");
  });

  // Guard C1 (mutant C1): the CLI snapshot must never copy a forbidden carrier
  // value into the parser input, not merely refuse it downstream.
  it("C1 — the CLI snapshot never copies the forbidden carrier value", async () => {
    const sentinel = "c1-sentinel-do-not-copy";
    const previous = process.env["NOOKBRIDGE_DATABASE_KEY"];
    process.env["NOOKBRIDGE_DATABASE_KEY"] = sentinel;
    parseEnvSeen.length = 0;
    const stderrChunks: string[] = [];
    const originalStdout = process.stdout.write.bind(process.stdout);
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    let code = -1;
    try {
      code = await run(["node", "nookctl", "recover-local-state", "bundle", "inspect"]);
    } finally {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
      if (previous === undefined) delete process.env["NOOKBRIDGE_DATABASE_KEY"];
      else process.env["NOOKBRIDGE_DATABASE_KEY"] = previous;
    }
    expect(code).toBe(2);
    // The parser must have been reached, or the absence checks below are vacuous.
    expect(parseEnvSeen).toHaveLength(1);
    expect(JSON.stringify(parseEnvSeen)).not.toContain(sentinel);
    expect(stderrChunks.join("")).not.toContain(sentinel);
  });

  it("P3 — bundle help is dispatched", () => {
    const parsed = parseRecoverLocalStateCommand(["bundle", "help"], {});
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.command.kind).toBe("bundle-help");
    const help = formatBundleRecoveryHelp();
    expect(help.length).toBeGreaterThan(0);
    expect(help).toContain("bundle");
  });

  it("R2 — reinitialize quarantines a readable-but-corrupt original", async () => {
    const root = mkRoot("nookbridge-bundle-reinit-corrupt-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const primary = join(stateDir, BUNDLE_MEMBERS[0]);

    // Corrupt one data page (fixed pattern, not random).  The fixture is a
    // 4096-byte-page database; prefer offset 8192 (third page) when the file
    // is large enough, else the second page at 4096.
    const bytes = readFileSync(primary);
    const pageSize = 4096;
    const offset = bytes.length >= pageSize * 2 + 512 ? pageSize * 2 : pageSize;
    expect(bytes.length).toBeGreaterThanOrEqual(offset + 512);
    const corrupted = Buffer.from(bytes);
    Buffer.alloc(512, 0xa5).copy(corrupted, offset);
    writeFileSync(primary, corrupted);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;

    // The original was preserved (moved, not replaced): the quarantined copy
    // still carries the 0xa5 pattern at the corrupted offset.
    const quarantined = join(quarantineRoot(stateDir), result.quarantineId, BUNDLE_MEMBERS[0]);
    const preserved = readFileSync(quarantined);
    expect(preserved.length).toBeGreaterThanOrEqual(offset + 512);
    expect(preserved.subarray(offset, offset + 512).equals(Buffer.alloc(512, 0xa5))).toBe(true);
  });

  it("R4 — reinitialize refuses with no moves when the header is destroyed", async () => {
    const root = mkRoot("nookbridge-bundle-reinit-header-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const primary = join(stateDir, BUNDLE_MEMBERS[0]);

    // Destroy the header (offset 0).  Snapshot after corruption so the
    // comparison captures the 0xa5 header.
    const bytes = readFileSync(primary);
    const corrupted = Buffer.from(bytes);
    Buffer.alloc(100, 0xa5).copy(corrupted, 0);
    writeFileSync(primary, corrupted);

    const before = snapshotRegularFileHashes(stateDir);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    expect(snapshotRegularFileHashes(stateDir)).toEqual(before);
    expect(readFileSync(primary).subarray(0, 100).equals(Buffer.alloc(100, 0xa5))).toBe(true);
    const qRoot = quarantineRoot(stateDir);
    if (existsSync(qRoot)) {
      expect(readdirSync(qRoot)).toEqual([]);
    }
  });

  // Guard G6 (mutant M35): the probe's key escaping must match the opener.
  it("probe key escaping agrees with the production opener", async () => {
    const root = mkRoot("nookbridge-bundle-keyescape-");
    const key = "stage9-key\\with-backslash";
    const { stateDir, credentialsDir } = buildBundleFixture(root, { key });

    // Production-opener observation: can SqliteStorage open the member?
    const primary = join(stateDir, BUNDLE_MEMBERS[0]);
    let productionOpens = false;
    try {
      const storage = new SqliteStorage({ dbPath: primary, key, withExtensions: false });
      try {
        storage.all("SELECT count(*) AS n FROM sqlite_master");
        productionOpens = true;
      } finally {
        storage.close();
      }
    } catch {
      productionOpens = false;
    }

    const result = await runBundle(["bundle", "inspect"], stateDir, credentialsDir);
    expect(result.kind).toBe("bundle-inspection");
    if (result.kind !== "bundle-inspection") return;
    // The probe must agree with the production opener's verdict; identity
    // escaping (M35) would make the probe disagree.
    expect(result.result.kind).toBe(productionOpens ? "healthy" : "corrupt");
  });
});

// ---------------------------------------------------------------------------
// Review blockers (Luna, 90d2bea): a crash during fresh-state initialization
// must stay resumable, and a quarantine entry name must be an opaque id.
// ---------------------------------------------------------------------------

describe("bundle reinitialize — initialization checkpoint and entry name", () => {
  afterEach(() => {
    freshInitHook.failOn = undefined;
  });

  it("a fresh-state failure leaves a resumable checkpoint, and a rerun completes it", async () => {
    const root = mkRoot("nookbridge-bundle-init-resume-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);

    // Fail the second member's creation, after the first fresh member exists
    // at its source path.
    freshInitHook.failOn = "notesnook.db";
    let first;
    try {
      first = await runBundle(["bundle", "reinitialize", APPROVE, ACK], stateDir, credentialsDir);
    } finally {
      freshInitHook.failOn = undefined;
    }
    expect(first.kind).toBe("error");
    if (first.kind !== "error") return;
    expect(first.exitCode).toBe(3);

    const qRoot = quarantineRoot(stateDir);
    const ids = readdirSync(qRoot);
    expect(ids).toHaveLength(1);
    const id = ids[0]!;
    const entry = join(qRoot, id);

    // The crashed run must not leave a `complete` checkpoint behind.
    const interrupted = JSON.parse(readFileSync(join(entry, MANIFEST_NAME), "utf8")) as {
      status?: unknown;
    };
    expect(interrupted.status).toBe("initializing");
    // The originals are preserved in the entry, byte-for-byte.
    for (const member of BUNDLE_MEMBERS) {
      expect(readFileSync(join(entry, member)).equals(memberBytes[member]!)).toBe(true);
    }

    // The rerun resumes the same checkpoint instead of refusing it.
    const second = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(second.kind).toBe("reinitialized");
    if (second.kind !== "reinitialized") return;
    expect(second.quarantineId).toBe(id);
    const finished = JSON.parse(readFileSync(join(entry, MANIFEST_NAME), "utf8")) as {
      status?: unknown;
    };
    expect(finished.status).toBe("complete");
  });

  it("refuses a quarantine entry whose name is not an opaque id", async () => {
    const root = mkRoot("nookbridge-bundle-bad-entry-name-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const badId = "not-an-opaque-id";
    plantIncompleteEntry(stateDir, badId, {
      version: 1,
      id: badId,
      status: "incomplete",
      items: [
        { name: "nookbridge-storage.db", state: "pending" },
        { name: "notesnook.db", state: "pending" },
        { name: "notesnook-logs.db", state: "pending" },
      ],
    });
    const before = snapshotRegularFileHashes(stateDir);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    // The malformed name never reaches the operator output.
    expect(JSON.stringify(result)).not.toContain(badId);
    expect(snapshotRegularFileHashes(stateDir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// P1-9 review round 3 — manifest inventory, manifest symlinks, probe failures.
// ---------------------------------------------------------------------------

describe("bundle recovery — review round 3 regressions", () => {
  it("resume refuses a stray sidecar before fresh state is created", async () => {
    const root = mkRoot("nookbridge-bundle-stray-resume-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const id = "5a1ab1e5-0123456789ab";
    // Every member already moved: the crash happened during fresh-state creation,
    // where resume skips the probe and goes straight to initialization.
    const entry = join(quarantineRoot(stateDir), id);
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    chmodSync(entry, 0o700);
    for (const member of BUNDLE_MEMBERS) {
      renameSync(join(stateDir, member), join(entry, member));
    }
    writeFileSync(
      join(entry, MANIFEST_NAME),
      JSON.stringify({
        version: 1,
        id,
        status: "initializing",
        items: BUNDLE_MEMBERS.map((name) => ({ name, state: "moved" })),
      }),
      { mode: 0o600 },
    );
    // A leftover WAL would pair with the fresh database created on resume.
    writeFileSync(join(stateDir, "notesnook.db-wal"), Buffer.from("stale-wal-from-a-crash"));
    const before = snapshotTreeWithInodes(stateDir);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    // Nothing was created beside the stray sidecar; the snapshot is unchanged.
    expect(snapshotTreeWithInodes(stateDir)).toEqual(before);
  });

  it("rollback refuses an entry that preserves a sidecar the manifest does not list", async () => {
    const root = mkRoot("nookbridge-bundle-rb-unlisted-entry-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const id = "0ddba11c-0123456789ab";
    const entry = join(quarantineRoot(stateDir), id);
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    chmodSync(entry, 0o700);
    for (const member of BUNDLE_MEMBERS) {
      renameSync(join(stateDir, member), join(entry, member));
    }
    writeFileSync(join(entry, "notesnook.db-wal"), Buffer.from("preserved-wal-not-listed"));
    writeFileSync(
      join(entry, MANIFEST_NAME),
      JSON.stringify({
        version: 1,
        id,
        status: "complete",
        items: BUNDLE_MEMBERS.map((name) => ({ name, state: "moved" })),
      }),
      { mode: 0o600 },
    );
    const before = snapshotTreeWithInodes(stateDir);

    const result = await runBundle(["bundle", "rollback", ROLLBACK, id], stateDir, credentialsDir);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe(ROLLBACK_INCOMPLETE);
    // No success with a preserved sidecar left behind: nothing moved.
    expect(snapshotTreeWithInodes(stateDir)).toEqual(before);
  });

  it("rollback refuses when an unlisted sidecar sits in the state root beside the restored state", async () => {
    const root = mkRoot("nookbridge-bundle-rb-stray-root-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);

    const reinit = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );
    expect(reinit.kind).toBe("reinitialized");
    if (reinit.kind !== "reinitialized") return;

    clearFreshMembers(stateDir);
    writeFileSync(join(stateDir, "notesnook.db-wal"), Buffer.from("stray-wal"));
    const before = snapshotTreeWithInodes(stateDir);

    const result = await runBundle(
      ["bundle", "rollback", ROLLBACK, reinit.quarantineId],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe(ROLLBACK_OCCUPIED);
    expect(snapshotTreeWithInodes(stateDir)).toEqual(before);
  });

  it("a manifest write never follows a link planted at the old fixed temporary name", async () => {
    const root = mkRoot("nookbridge-bundle-manifest-symlink-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const outside = join(root, "outside-target.txt");
    writeFileSync(outside, "OUTSIDE-ORIGINAL", { mode: 0o600 });
    let planted = false;
    moveHook.beforeMove = (_source, destination) => {
      if (planted) return;
      planted = true;
      // The old writer used `${manifest}.tmp` inside the entry; plant a link there.
      symlinkSync(outside, join(destination, "..", `${MANIFEST_NAME}.tmp`));
    };

    try {
      await runBundle(["bundle", "reinitialize", APPROVE, ACK], stateDir, credentialsDir);
    } finally {
      moveHook.beforeMove = undefined;
    }

    expect(planted).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("OUTSIDE-ORIGINAL");
  });

  it("resume sweeps a manifest temporary left by a crash and completes", async () => {
    const root = mkRoot("nookbridge-bundle-manifest-residue-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);
    const id = "5e1f1e57-0123456789ab";
    const entry = plantIncompleteEntry(
      stateDir,
      id,
      {
        version: 1,
        id,
        status: "incomplete",
        items: [
          { name: "nookbridge-storage.db", state: "moved" },
          { name: "notesnook.db", state: "pending" },
          { name: "notesnook-logs.db", state: "pending" },
        ],
      },
      "nookbridge-storage.db",
    );
    const residue = join(entry, `${MANIFEST_NAME}.4242.0123456789abcdef.tmp`);
    writeFileSync(residue, "half-written-manifest", { mode: 0o600 });

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;
    expect(result.quarantineId).toBe(id);
    expect(existsSync(residue)).toBe(false);
    expect(readFileSync(join(entry, "notesnook.db")).equals(memberBytes["notesnook.db"]!)).toBe(
      true,
    );
  });

  it("resume refuses an entry that holds a file the manifest does not list", async () => {
    const root = mkRoot("nookbridge-bundle-entry-unlisted-resume-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const id = "e7a1e5c0-0123456789ab";
    const entry = plantIncompleteEntry(
      stateDir,
      id,
      {
        version: 1,
        id,
        status: "incomplete",
        items: [
          { name: "nookbridge-storage.db", state: "moved" },
          { name: "notesnook.db", state: "pending" },
          { name: "notesnook-logs.db", state: "pending" },
        ],
      },
      "nookbridge-storage.db",
    );
    writeFileSync(join(entry, "notesnook.db-wal"), Buffer.from("unlisted-preserved-wal"));
    const before = snapshotTreeWithInodes(stateDir);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(snapshotTreeWithInodes(stateDir)).toEqual(before);
  });

  it("a crash that left only a manifest temporary is swept and the entry starts fresh", async () => {
    const root = mkRoot("nookbridge-bundle-temp-only-entry-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);
    const id = "7e11e11e-0123456789ab";
    const entry = join(quarantineRoot(stateDir), id);
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    chmodSync(entry, 0o700);
    writeFileSync(join(entry, `${MANIFEST_NAME}.4242.0123456789abcdef.tmp`), "half-written", {
      mode: 0o600,
    });

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;
    expect(result.quarantineId).not.toBe(id);
    expect(existsSync(entry)).toBe(false);
    expect(
      readFileSync(join(quarantineRoot(stateDir), result.quarantineId, "notesnook.db")).equals(
        memberBytes["notesnook.db"]!,
      ),
    ).toBe(true);
  });

  it("rollback sweeps a manifest temporary left in a complete entry and restores it", async () => {
    const root = mkRoot("nookbridge-bundle-rb-temp-residue-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);
    const id = "5e1f1e58-0123456789ab";
    const entry = join(quarantineRoot(stateDir), id);
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    chmodSync(entry, 0o700);
    for (const member of BUNDLE_MEMBERS) {
      renameSync(join(stateDir, member), join(entry, member));
    }
    writeFileSync(
      join(entry, MANIFEST_NAME),
      JSON.stringify({
        version: 1,
        id,
        status: "complete",
        items: BUNDLE_MEMBERS.map((name) => ({ name, state: "moved" })),
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(entry, `${MANIFEST_NAME}.9.0123456789abcdef.tmp`), "residue", {
      mode: 0o600,
    });

    const result = await runBundle(["bundle", "rollback", ROLLBACK, id], stateDir, credentialsDir);

    expect(result.kind).toBe("rolled-back");
    for (const member of BUNDLE_MEMBERS) {
      expect(readFileSync(join(stateDir, member)).equals(memberBytes[member]!)).toBe(true);
    }
    expect(existsSync(entry)).toBe(false);
  });

  it("resume refuses a symlinked manifest rather than following it", async () => {
    const root = mkRoot("nookbridge-bundle-symlink-manifest-resume-");
    const { stateDir, credentialsDir, memberBytes } = buildBundleFixture(root);
    const id = "5e1f1e55-0123456789ab";
    const entry = join(quarantineRoot(stateDir), id);
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    chmodSync(entry, 0o700);
    renameSync(join(stateDir, "nookbridge-storage.db"), join(entry, "nookbridge-storage.db"));
    const outsideManifest = join(root, "outside-manifest.json");
    writeFileSync(
      outsideManifest,
      JSON.stringify({
        version: 1,
        id,
        status: "incomplete",
        items: [
          { name: "nookbridge-storage.db", state: "moved" },
          { name: "notesnook.db", state: "pending" },
          { name: "notesnook-logs.db", state: "pending" },
        ],
      }),
    );
    symlinkSync(outsideManifest, join(entry, MANIFEST_NAME));

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(readFileSync(join(stateDir, "notesnook.db")).equals(memberBytes["notesnook.db"]!)).toBe(
      true,
    );
  });

  it("rollback refuses a symlinked manifest rather than following it", async () => {
    const root = mkRoot("nookbridge-bundle-symlink-manifest-rb-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const id = "5e1f1e56-0123456789ab";
    const entry = join(quarantineRoot(stateDir), id);
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    chmodSync(entry, 0o700);
    for (const member of BUNDLE_MEMBERS) {
      renameSync(join(stateDir, member), join(entry, member));
    }
    const outsideManifest = join(root, "outside-manifest.json");
    writeFileSync(
      outsideManifest,
      JSON.stringify({
        version: 1,
        id,
        status: "complete",
        items: BUNDLE_MEMBERS.map((name) => ({ name, state: "moved" })),
      }),
    );
    symlinkSync(outsideManifest, join(entry, MANIFEST_NAME));
    const before = snapshotTreeWithInodes(stateDir);

    const result = await runBundle(["bundle", "rollback", ROLLBACK, id], stateDir, credentialsDir);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.message).toBe(ROLLBACK_INCOMPLETE);
    expect(snapshotTreeWithInodes(stateDir)).toEqual(before);
  });

  it("reinitialize turns a probe failure into a categorical refusal and mutates nothing", async () => {
    const root = mkRoot("nookbridge-bundle-probe-throws-reinit-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const before = snapshotTreeWithInodes(stateDir);
    probeHook.onProbe = () => {
      throw new Error("probe boom");
    };

    try {
      const result = await runBundle(
        ["bundle", "reinitialize", APPROVE, ACK],
        stateDir,
        credentialsDir,
      );
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.exitCode).toBe(2);
      expect(result.message).toBe("refusing unprobeable production database bundle");
    } finally {
      probeHook.onProbe = undefined;
    }

    expect(snapshotTreeWithInodes(stateDir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// P1-9 mutation survivors: manifest temporary naming, exclusive create, and the
// resume sweep.  Each test is load-bearing for one mutant in the driver.
// ---------------------------------------------------------------------------

describe("bundle manifest temporaries — naming, exclusive create, sweep", () => {
  it("a manifest write does not depend on the old fixed temporary name being free", async () => {
    const root = mkRoot("nookbridge-bundle-stray-fixed-name-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    let stray: string | undefined;
    moveHook.beforeMove = (_source, destination) => {
      if (stray !== undefined) return;
      // Occupy the old predictable name inside the entry before the next manifest write.
      stray = join(destination, "..", `${MANIFEST_NAME}.tmp`);
      writeFileSync(stray, "STRAY-AT-OLD-NAME", { mode: 0o600 });
    };

    let result: Awaited<ReturnType<typeof runBundle>> | undefined;
    try {
      result = await runBundle(["bundle", "reinitialize", APPROVE, ACK], stateDir, credentialsDir);
    } finally {
      moveHook.beforeMove = undefined;
    }

    expect(stray).toBeDefined();
    expect(result?.kind).toBe("reinitialized");
    expect(readFileSync(stray!, "utf8")).toBe("STRAY-AT-OLD-NAME");
  });

  it("a manifest temporary is created exclusively: a link at its exact name is never followed", async () => {
    const root = mkRoot("nookbridge-bundle-temp-exclusive-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const outside = join(root, "outside-target.txt");
    writeFileSync(outside, "OUTSIDE-ORIGINAL", { mode: 0o600 });
    // Every random draw is fixed, so the temporary's exact name is known in advance.
    const tempName = `${MANIFEST_NAME}.${process.pid}.${"ab".repeat(8)}.tmp`;
    randomHook.fixed = true;
    let planted = false;
    moveHook.beforeMove = (_source, destination) => {
      if (planted) return;
      planted = true;
      // The first manifest temporary was already renamed away, so this name is free
      // for a link.  The next manifest write must refuse it rather than follow it.
      symlinkSync(outside, join(destination, "..", tempName));
    };

    let result: Awaited<ReturnType<typeof runBundle>> | undefined;
    try {
      result = await runBundle(["bundle", "reinitialize", APPROVE, ACK], stateDir, credentialsDir);
    } finally {
      moveHook.beforeMove = undefined;
      randomHook.fixed = false;
    }

    expect(planted).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("OUTSIDE-ORIGINAL");
    expect(result?.kind).toBe("error");
    if (result?.kind !== "error") return;
    expect(result.exitCode).toBe(3);
    expect(result.message).toBe("failed to record recovery manifest");
  });

  it("resume never unlinks a symlink named like a manifest temporary", async () => {
    const root = mkRoot("nookbridge-bundle-temp-symlink-sweep-");
    const { stateDir, credentialsDir } = buildBundleFixture(root);
    const id = "5e1f1e58-0123456789ab";
    const entry = plantIncompleteEntry(
      stateDir,
      id,
      {
        version: 1,
        id,
        status: "incomplete",
        items: [
          { name: "nookbridge-storage.db", state: "moved" },
          { name: "notesnook.db", state: "pending" },
          { name: "notesnook-logs.db", state: "pending" },
        ],
      },
      "nookbridge-storage.db",
    );
    const outside = join(root, "outside-target.txt");
    writeFileSync(outside, "OUTSIDE-ORIGINAL", { mode: 0o600 });
    const link = join(entry, `${MANIFEST_NAME}.4242.0123456789abcdef.tmp`);
    symlinkSync(outside, link);

    const result = await runBundle(
      ["bundle", "reinitialize", APPROVE, ACK],
      stateDir,
      credentialsDir,
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe("refusing inconsistent quarantine state");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("OUTSIDE-ORIGINAL");
  });
});
