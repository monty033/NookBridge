/**
 * Stage 9 — bounded, non-destructive local-state recovery.
 *
 * These tests cover the `nookctl recover-local-state` slice defined in
 * docs/stage-9-recovery.md and the implementation plan §10.3.  They
 * drive the parser, runner, and the in-process CLI dispatcher against
 * disposable temp fixtures only.  Nothing here touches live state,
 * authentication, or the network.
 *
 * The contract that this suite enforces is the exact security
 * boundary pinned in the task allowlist:
 *
 *   - read-only default (inspect) never mutates state;
 *   - `--approve-reinitialize` is the exact opt-in for mutation;
 *   - credentials / keys / body / path details are never accepted
 *     through argv or env, never echoed, never logged;
 *   - symlink / non-directory / system-path / locked / missing /
 *     corrupt / collision cases fail closed before any mutation;
 *   - quarantine is restrictive (0o700) and the original state
 *     survives untouched;
 *   - rollback restores the preserved state by rename only;
 *   - the in-process CLI rejects credential carriers and does not
 *     construct recovery state before the explicit gate.
 */

import { Buffer } from "node:buffer";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run } from "../src/cli.js";
import { ensureStateDir } from "../src/config/state-dir.js";
import {
  parseRecoverLocalStateCommand,
  runRecoverLocalState,
  formatRecoverLocalStateHelp,
} from "../src/operator/recover-local-state.js";
import { SqliteStorage } from "../src/storage/sqlite-storage.js";
import { lockPath } from "../src/config/lock.js";

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

/** Create a state dir + valid encrypted DB + dev key file. */
function buildHealthyFixture(rootDir: string): {
  stateDir: string;
  dbPath: string;
  key: string;
} {
  const stateDir = join(rootDir, "state");
  const dbPath = join(stateDir, "nookbridge.db");
  const key = "stage9-recovery-test-key";
  ensureStateDir(stateDir);
  const storage = new SqliteStorage({ dbPath, key });
  storage.close();
  const keyDir = join(stateDir, ".d");
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  chmodSync(keyDir, 0o700);
  writeFileSync(join(keyDir, "db.key"), key, { mode: 0o600 });
  return { stateDir, dbPath, key };
}

describe("parseRecoverLocalStateCommand — argv / env credential boundary", () => {
  it("treats the bare `recover-local-state` invocation as `inspect`", () => {
    const parsed = parseRecoverLocalStateCommand([], {});
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.command.kind).toBe("inspect");
  });

  it("recognises `inspect` as the explicit read-only default", () => {
    const parsed = parseRecoverLocalStateCommand(["inspect"], {});
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind !== "parsed") return;
    expect(parsed.command.kind).toBe("inspect");
  });

  it("refuses `--password` as an argv credential carrier", () => {
    const parsed = parseRecoverLocalStateCommand(["inspect", "--password", "hunter2"], {});
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.exitCode).toBe(2);
    // The message must NEVER echo the value or the env/argv path.
    expect(parsed.message).not.toContain("hunter2");
    expect(parsed.message.toLowerCase()).toContain("credential");
  });

  it("refuses `--password=value` argv credential carriers", () => {
    const parsed = parseRecoverLocalStateCommand(["--password=sup3r-secret"], {});
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.exitCode).toBe(2);
    expect(parsed.message).not.toContain("sup3r-secret");
  });

  it("refuses every forbidden credential argv flag (one per carrier)", () => {
    const forbidden = [
      "--email",
      "--username",
      "--password",
      "--passwd",
      "--mfa",
      "--totp",
      "--secret",
      "--token",
      "--access-token",
      "--refresh-token",
      "--db-key",
      "--database-key",
      "--body",
      "--content",
      "--note",
    ];
    for (const flag of forbidden) {
      const parsed = parseRecoverLocalStateCommand(["inspect", flag, "leaf"], {});
      expect(parsed.kind, `flag ${flag} should be rejected`).toBe("error");
    }
  });

  it("refuses forbidden credential env vars (presence alone, no value read)", () => {
    const parsed = parseRecoverLocalStateCommand(["inspect"], { NOOKBRIDGE_PASSWORD: "smuggled" });
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.exitCode).toBe(2);
    expect(parsed.message).not.toContain("smuggled");
  });

  it("requires `--approve-reinitialize` for the reinitialize subcommand", () => {
    const parsed = parseRecoverLocalStateCommand(["reinitialize"], {});
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.exitCode).toBe(2);
    expect(parsed.message.toLowerCase()).toContain("--approve-reinitialize");
  });

  it("requires `--approve-rollback <id>` for the rollback subcommand", () => {
    const parsed = parseRecoverLocalStateCommand(["rollback"], {});
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.exitCode).toBe(2);
  });

  it("rejects an unknown subcommand with a categorical message", () => {
    const parsed = parseRecoverLocalStateCommand(["nuke"], { APPROVE_REINITIALIZE: "1" });
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.exitCode).toBe(2);
    expect(parsed.message).not.toContain("nuke");
  });

  it("refuses credential-shaped quarantine identifiers", () => {
    const parsed = parseRecoverLocalStateCommand(
      ["rollback", "--approve-rollback", "NOOKBRIDGE_PASSWORD=hunter2"],
      {},
    );
    expect(parsed.kind).toBe("error");
  });
});

describe("runRecoverLocalState — bounded categorical inspection", () => {
  it("reports a healthy fixture without mutating state", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-healthy-");
    const { stateDir, dbPath, key } = buildHealthyFixture(root);

    const before = readStateFingerprint(stateDir, dbPath, key);
    const result = await runRecoverLocalState({
      argv: ["inspect"],
      env: {},
      stateDir,
      dbPath,
      dbKey: key,
    });
    expect(result.kind).toBe("inspection");
    if (result.kind !== "inspection") return;
    expect(result.result.kind).toBe("healthy");

    const after = readStateFingerprint(stateDir, dbPath, key);
    expect(after).toEqual(before);
  });

  it("reports `missing` when the database file is absent", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-missing-");
    const stateDir = join(root, "state");
    ensureStateDir(stateDir);
    const dbPath = join(stateDir, "nookbridge.db");

    const result = await runRecoverLocalState({
      argv: ["inspect"],
      env: {},
      stateDir,
      dbPath,
    });
    expect(result.kind).toBe("inspection");
    if (result.kind !== "inspection") return;
    expect(result.result.kind).toBe("missing");
  });

  it("reports `corrupt` when the database file is unreadable bytes", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-corrupt-");
    const { stateDir, dbPath } = buildHealthyFixture(root);
    // Truncate the encrypted DB to garbage — the inspect probe must
    // report `corrupt` without opening a write handle.
    writeFileSync(dbPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));

    const result = await runRecoverLocalState({
      argv: ["inspect"],
      env: {},
      stateDir,
      dbPath,
      dbKey: "stage9-recovery-test-key",
    });
    expect(result.kind).toBe("inspection");
    if (result.kind !== "inspection") return;
    expect(result.result.kind).toBe("corrupt");
  });

  it("refuses a symlink state root before any inspection runs", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-symlink-");
    const realDir = join(root, "real");
    const linkDir = join(root, "link");
    ensureStateDir(realDir);
    try {
      mkdirSync(linkDir, { recursive: true });
    } catch {
      /* linkDir may not exist on platforms without symlink; test is skipped via try/catch */
    }
    let symlinked = false;
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(realDir, linkDir, "dir");
      symlinked = true;
    } catch {
      // Symlink not supported in this environment — skip the assertion.
      return;
    }
    expect(symlinked).toBe(true);

    const result = await runRecoverLocalState({
      argv: ["inspect"],
      env: {},
      stateDir: linkDir,
      dbPath: join(linkDir, "nookbridge.db"),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message.toLowerCase()).toContain("symlink");
    expect(result.message).not.toContain(linkDir);
  });

  it("refuses a non-directory state root", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-notdir-");
    const file = join(root, "not-a-dir");
    writeFileSync(file, "regular file");

    const result = await runRecoverLocalState({
      argv: ["inspect"],
      env: {},
      stateDir: file,
      dbPath: join(file, "nookbridge.db"),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message.toLowerCase()).toContain("not a directory");
    expect(result.message).not.toContain(file);
  });

  it("refuses a system-path state root (path traversal guard)", async () => {
    const result = await runRecoverLocalState({
      argv: ["inspect"],
      env: {},
      stateDir: "/etc",
      dbPath: "/etc/nookbridge.db",
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message.toLowerCase()).toMatch(/system|unsafe/);
    expect(result.message).not.toContain("/etc");
  });

  it("reports `locked` when the single-instance lock file is present", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-locked-");
    const { stateDir, dbPath } = buildHealthyFixture(root);
    // Simulate an active lock by writing the lock file ourselves.
    writeFileSync(lockPath(stateDir), `${process.pid}\n`);

    const result = await runRecoverLocalState({
      argv: ["inspect"],
      env: {},
      stateDir,
      dbPath,
    });
    expect(result.kind).toBe("inspection");
    if (result.kind !== "inspection") return;
    expect(result.result.kind).toBe("locked");
  });

  it("does not construct any recovery state for the bare default invocation", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-noconstruct-");
    const { stateDir, dbPath } = buildHealthyFixture(root);
    const quarantineDir = join(stateDir, ".recovery-quarantine");
    const beforeQuarantine = existsSync(quarantineDir);

    const result = await runRecoverLocalState({
      argv: [],
      env: {},
      stateDir,
      dbPath,
    });
    expect(result.kind).toBe("inspection");
    const afterQuarantine = existsSync(quarantineDir);
    expect(afterQuarantine).toBe(beforeQuarantine);
  });
});

describe("runRecoverLocalState — quarantine and reinitialize", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env["NOOKBRIDGE_ENABLE_LIVE_AUTH"];
    // Recovery is operator-only; ensure the live auth gate is irrelevant
    // (the slice must not depend on it).
    delete process.env["NOOKBRIDGE_ENABLE_LIVE_AUTH"];
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env["NOOKBRIDGE_ENABLE_LIVE_AUTH"];
    } else {
      process.env["NOOKBRIDGE_ENABLE_LIVE_AUTH"] = originalKey;
    }
  });

  it("refuses reinitialize without `--approve-reinitialize` even with the env flag", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-noapprove-");
    const { stateDir, dbPath } = buildHealthyFixture(root);

    const result = await runRecoverLocalState({
      argv: ["reinitialize"],
      env: { APPROVE_REINITIALIZE: "1" },
      stateDir,
      dbPath,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    // Quarantine must NOT exist (mutation never ran).
    const quarantineDir = join(stateDir, ".recovery-quarantine");
    expect(existsSync(quarantineDir)).toBe(false);
  });

  it("quarantines the original state with restrictive mode and returns an opaque id", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-quarantine-");
    const { stateDir, dbPath, key } = buildHealthyFixture(root);
    const dbBytesBefore = readFileBytes(dbPath);

    const result = await runRecoverLocalState({
      argv: ["reinitialize", "--approve-reinitialize"],
      env: {},
      stateDir,
      dbPath,
      dbKey: key,
    });
    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;

    // The opaque id must be opaque (not a path or DB hex).
    expect(result.quarantineId).toMatch(/^[a-z0-9-]+$/i);
    expect(result.quarantineId.length).toBeGreaterThanOrEqual(8);

    const quarantineRoot = join(stateDir, ".recovery-quarantine");
    const st = lstatSync(quarantineRoot);
    expect(st.isDirectory()).toBe(true);
    expect((st.mode & 0o777).toString(8)).toBe("700");
    const entryStat = lstatSync(join(quarantineRoot, result.quarantineId));
    expect((entryStat.mode & 0o777).toString(8)).toBe("700");

    // Original database bytes are preserved bit-for-bit inside the quarantine.
    const quarantinedPath = join(quarantineRoot, result.quarantineId, "nookbridge.db");
    const bytesAfter = readFileBytes(quarantinedPath);
    expect(bytesAfter.equals(dbBytesBefore)).toBe(true);
  });

  it("quarantines corrupt bytes before reinitializing fresh state", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-corrupt-");
    const { stateDir, dbPath, key } = buildHealthyFixture(root);
    const corruptBytes = Buffer.from("corrupt-database-fixture", "utf8");
    writeFileSync(dbPath, corruptBytes);

    const result = await runRecoverLocalState({
      argv: ["reinitialize", "--approve-reinitialize"],
      env: {},
      stateDir,
      dbPath,
      dbKey: key,
    });
    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;

    const quarantinedPath = join(
      stateDir,
      ".recovery-quarantine",
      result.quarantineId,
      "nookbridge.db",
    );
    expect(readFileBytes(quarantinedPath).equals(corruptBytes)).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    expect(readFileBytes(dbPath).equals(corruptBytes)).toBe(false);
  });

  it("returns `reinitialized` and a fresh empty state after quarantine", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-reinit-");
    const { stateDir, dbPath, key } = buildHealthyFixture(root);

    const result = await runRecoverLocalState({
      argv: ["reinitialize", "--approve-reinitialize"],
      env: {},
      stateDir,
      dbPath,
      dbKey: key,
    });
    expect(result.kind).toBe("reinitialized");
    if (result.kind !== "reinitialized") return;
    expect(existsSync(dbPath)).toBe(true);
    expect(
      lstatSync(dbPath).ino !==
        lstatSync(join(stateDir, ".recovery-quarantine", result.quarantineId, "nookbridge.db")).ino,
    ).toBe(true);
    const quarantineId = result.quarantineId;

    const followUp = await runRecoverLocalState({
      argv: ["reinitialize", "--approve-reinitialize"],
      env: {},
      stateDir,
      dbPath,
      dbKey: key,
    });
    expect(followUp.kind).toBe("error");
    if (followUp.kind !== "error") return;
    expect(followUp.exitCode).toBe(2);
    expect(followUp.message.toLowerCase()).toContain("quarantine");
    expect(followUp.message).not.toContain(quarantineId);
  });

  it("refuses a reinitialize collision when the quarantine root already has entries", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-collision-");
    const { stateDir, dbPath } = buildHealthyFixture(root);
    // Plant a stale quarantine entry under the same root.
    const quarantineRoot = join(stateDir, ".recovery-quarantine");
    mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(quarantineRoot, "existing-stale-entry"), "stale");

    const result = await runRecoverLocalState({
      argv: ["reinitialize", "--approve-reinitialize"],
      env: {},
      stateDir,
      dbPath,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message.toLowerCase()).toContain("collision");
    // Original state must remain untouched.
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe("runRecoverLocalState — rollback", () => {
  it("rolls the preserved state back without copying or clobbering", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-rollback-");
    const { stateDir, dbPath, key } = buildHealthyFixture(root);
    const originalBytes = readFileBytes(dbPath);

    const quarantined = await runRecoverLocalState({
      argv: ["reinitialize", "--approve-reinitialize"],
      env: {},
      stateDir,
      dbPath,
      dbKey: key,
    });
    expect(quarantined.kind).toBe("reinitialized");
    if (quarantined.kind !== "reinitialized") return;

    // Remove only the fresh state to make the rollback destination empty.
    rmSync(dbPath);

    const rolled = await runRecoverLocalState({
      argv: ["rollback", "--approve-rollback", quarantined.quarantineId],
      env: {},
      stateDir,
      dbPath,
    });
    expect(rolled.kind).toBe("rolled-back");
    if (rolled.kind !== "rolled-back") return;
    expect(rolled.quarantineId).toBe(quarantined.quarantineId);

    // The original bytes are restored bit-for-bit.
    expect(existsSync(dbPath)).toBe(true);
    expect(readFileBytes(dbPath).equals(originalBytes)).toBe(true);
  });

  it("refuses rollback when the destination would be occupied", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-rollback-occ-");
    const { stateDir, dbPath, key } = buildHealthyFixture(root);

    const quarantined = await runRecoverLocalState({
      argv: ["reinitialize", "--approve-reinitialize"],
      env: {},
      stateDir,
      dbPath,
      dbKey: key,
    });
    expect(quarantined.kind).toBe("reinitialized");
    if (quarantined.kind !== "reinitialized") return;

    // Recreate a state file at the original path to occupy the destination.
    writeFileSync(dbPath, "occupying-content");

    const result = await runRecoverLocalState({
      argv: ["rollback", "--approve-rollback", quarantined.quarantineId],
      env: {},
      stateDir,
      dbPath,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message.toLowerCase()).toContain("occupied");
    expect(result.message).not.toContain(quarantined.quarantineId);
  });

  it("refuses rollback with an unknown opaque identifier", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-rollback-unknown-");
    const { stateDir, dbPath } = buildHealthyFixture(root);

    const result = await runRecoverLocalState({
      argv: ["rollback", "--approve-rollback", "deadbeef-0123456789ab"],
      env: {},
      stateDir,
      dbPath,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message.toLowerCase()).toContain("unknown");
    expect(result.message).not.toContain("deadbeef-0123456789ab");
  });

  it("refuses rollback identifiers that escape the fixed state root", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-rollback-traversal-");
    const { stateDir, dbPath } = buildHealthyFixture(root);

    const result = await runRecoverLocalState({
      argv: ["rollback", "--approve-rollback", "../../../etc"],
      env: {},
      stateDir,
      dbPath,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message.toLowerCase()).toMatch(/identifier|opaque/);
  });
});

describe("CLI dispatcher — `nookctl recover-local-state`", () => {
  /**
   * Drive `run()` against the captured stdio, returning the exit code
   * the dispatcher decided on.  `run()` returns a number directly;
   * the entry-point wrapper would call `process.exit`.  We capture
   * stdout/stderr and assert the returned code instead of stubbing
   * the global exit.
   */
  async function driveCli(argv: readonly string[]): Promise<{
    stdout: string;
    stderr: string;
    code: number;
  }> {
    const captured: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
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

  it("runs read-only inspection when invoked without a subcommand", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-cli-default-");
    const { stateDir } = buildHealthyFixture(root);
    const out = await driveCli(["recover-local-state", "--state-dir", resolve(stateDir)]);
    expect(out.code).toBe(0);
    expect(out.stdout.toLowerCase()).toContain("healthy");
    expect(existsSync(join(stateDir, ".recovery-quarantine"))).toBe(false);
  });

  it("renders help only for the explicit help subcommand", async () => {
    const out = await driveCli(["recover-local-state", "help"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("recover-local-state");
    expect(out.stdout).toContain("--approve-reinitialize");
  });

  it("rejects argv credential carriers without constructing any recovery state", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-cli-creds-");
    const { stateDir } = buildHealthyFixture(root);
    const stateDirResolved = resolve(stateDir);

    const out = await driveCli([
      "recover-local-state",
      "--state-dir",
      stateDirResolved,
      "inspect",
      "--password",
      "hunter2",
    ]);
    expect(out.code).toBe(2);
    expect(out.stderr).not.toContain("hunter2");
    const bypass = await driveCli(["recover-local-state", "--state-dir", "--password=secret"]);
    expect(bypass.code).toBe(2);
    expect(bypass.stderr).not.toContain("secret");
    // No quarantine side-effect.
    expect(existsSync(join(stateDir, ".recovery-quarantine"))).toBe(false);
  });

  it("runs inspect without --approve-reinitialize and does not construct recovery state", async () => {
    const root = mkRoot("nookbridge-stage9-recovery-cli-inspect-");
    const { stateDir, dbPath } = buildHealthyFixture(root);
    const stateDirResolved = resolve(stateDir);
    const quarantineRoot = join(stateDir, ".recovery-quarantine");

    const out = await driveCli(["recover-local-state", "--state-dir", stateDirResolved, "inspect"]);
    expect(out.code).toBe(0);
    expect(out.stdout.toLowerCase()).toContain("healthy");
    // Read-only path must not construct recovery state.
    expect(existsSync(quarantineRoot)).toBe(false);
    // The DB must still be the original file (no rename has occurred).
    expect(existsSync(dbPath)).toBe(true);
  });

  it("formatRecoverLocalStateHelp mentions the exact approval flag", () => {
    const help = formatRecoverLocalStateHelp();
    expect(help).toContain("--approve-reinitialize");
    expect(help).toContain("--approve-rollback");
    expect(help.toLowerCase()).toContain("non-destructive");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStateFingerprint(
  stateDir: string,
  dbPath: string,
  key: string,
): { dbBytes: Buffer; dbStat: { mode: string } } {
  const dbBytes = readFileBytes(dbPath);
  const storage = new SqliteStorage({ dbPath, key });
  storage.close();
  const dbStat = lstatSync(dbPath);
  void stateDir;
  return { dbBytes, dbStat: { mode: (dbStat.mode & 0o777).toString(8) } };
}

function readFileBytes(path: string): Buffer {
  return readFileSync(path);
}

// Ensure permissions stay restrictive across the suite.
function _unusedChmodRef(): void {
  // Touch chmodSync so the linter does not strip the import on platforms
  // where it is statically analysable as unused.
  void chmodSync;
}
void _unusedChmodRef;
