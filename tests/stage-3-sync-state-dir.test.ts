import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  resolveSyncStateDir,
  runSyncCommand,
  SyncStateDirUnsetError,
} from "../src/core/notesnook-sync-admin.js";

/**
 * The read-only sync proof is an acceptance gate: its `pass` is what a
 * release claim is allowed to rest on.  Its state directory used to be
 * derived from `process.cwd()` whenever `NOOKBRIDGE_STATE_DIR` was unset,
 * so the proof could run against an implicit, usually empty store and
 * still report `pass` — a green light that proved nothing.
 *
 * These tests pin the closed behavior: an explicit state directory is
 * required, and an unset one is a categorical refusal rather than an
 * implicit store.
 */

const ENABLED_ENV = Object.freeze({ NOOKBRIDGE_ENABLE_LIVE_SYNC: "1" }) as Readonly<
  Record<string, string | undefined>
>;

const STATE_DIR_ENV = "NOOKBRIDGE_STATE_DIR";

describe("sync state directory resolution", () => {
  it("reports an unset state directory when the variable is absent", () => {
    expect(resolveSyncStateDir({})).toEqual({ kind: "unset" });
  });

  it("treats blank values as unset", () => {
    expect(resolveSyncStateDir({ [STATE_DIR_ENV]: "" })).toEqual({ kind: "unset" });
    expect(resolveSyncStateDir({ [STATE_DIR_ENV]: "   " })).toEqual({ kind: "unset" });
  });

  it("treats a non-string carrier as unset instead of coercing it", () => {
    const hostile = { [STATE_DIR_ENV]: 7 } as unknown as Readonly<
      Record<string, string | undefined>
    >;
    expect(resolveSyncStateDir(hostile)).toEqual({ kind: "unset" });
  });

  it("returns the configured state directory unchanged", () => {
    expect(resolveSyncStateDir({ [STATE_DIR_ENV]: "/var/lib/nookbridge" })).toEqual({
      kind: "resolved",
      stateDir: "/var/lib/nookbridge",
    });
  });
});

describe("sync proof refuses an implicit state directory", () => {
  it("maps an unset state directory to a categorical refusal naming the variable", async () => {
    const result = await runSyncCommand({
      argv: ["read-only"],
      env: ENABLED_ENV,
      createProofRuntime: async () => {
        throw new SyncStateDirUnsetError();
      },
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain(STATE_DIR_ENV);
  });

  it("never yields a report when the state directory is unset", async () => {
    const result = await runSyncCommand({
      argv: ["read-only"],
      env: ENABLED_ENV,
      createProofRuntime: async () => {
        throw new SyncStateDirUnsetError();
      },
    });

    expect(result.kind).not.toBe("report");
  });

  it("keeps the generic construction failure for an unrelated error", async () => {
    const result = await runSyncCommand({
      argv: ["read-only"],
      env: ENABLED_ENV,
      createProofRuntime: async () => {
        throw new Error("unrelated construction failure");
      },
    });

    expect(result).toMatchObject({ kind: "error", exitCode: 3 });
    if (result.kind !== "error") return;
    expect(result.message).not.toContain(STATE_DIR_ENV);
  });

  it("does not require a state directory to render `sync help`", async () => {
    const result = await runSyncCommand({ argv: ["help"], env: {} });
    expect(result.kind).toBe("help");
  });

  it("still reports the disabled live gate before any state directory concern", async () => {
    const result = await runSyncCommand({
      argv: ["read-only"],
      env: {},
      createProofRuntime: async () => {
        throw new SyncStateDirUnsetError();
      },
    });

    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    if (result.kind !== "error") return;
    expect(result.message).toContain("NOOKBRIDGE_ENABLE_LIVE_SYNC");
  });
});

type CapturedWrites = Readonly<{ lines: string[]; restore: () => void }>;

function captureCliWrites(): CapturedWrites {
  const lines: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const record = (chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  process.stdout.write = record as unknown as typeof process.stdout.write;
  process.stderr.write = record as unknown as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    },
  };
}

describe("nookctl CLI — sync refuses an implicit state directory", () => {
  it("refuses `sync read-only` when NOOKBRIDGE_STATE_DIR is unset", async () => {
    const mod = await import("../src/cli.js");
    const originalCwd = process.cwd();
    const scratch = mkdtempSync(join(tmpdir(), "nookbridge-sync-state-dir-"));
    const hadStateDir = Object.prototype.hasOwnProperty.call(process.env, STATE_DIR_ENV);
    const previousStateDir = process.env[STATE_DIR_ENV];
    const previousGate = process.env.NOOKBRIDGE_ENABLE_LIVE_SYNC;
    const captured = captureCliWrites();

    try {
      delete process.env[STATE_DIR_ENV];
      process.env.NOOKBRIDGE_ENABLE_LIVE_SYNC = "1";
      process.chdir(scratch);

      const code = await mod.run([process.argv[0] as string, "nookctl", "sync", "read-only"]);
      const joined = captured.lines.join("");

      expect(code).toBe(2);
      expect(joined).toContain(STATE_DIR_ENV);
      expect(joined).not.toContain('"kind":"pass"');
      expect(joined).not.toContain("var/state");
    } finally {
      captured.restore();
      process.chdir(originalCwd);
      if (hadStateDir && previousStateDir !== undefined) {
        process.env[STATE_DIR_ENV] = previousStateDir;
      } else {
        delete process.env[STATE_DIR_ENV];
      }
      if (previousGate === undefined) delete process.env.NOOKBRIDGE_ENABLE_LIVE_SYNC;
      else process.env.NOOKBRIDGE_ENABLE_LIVE_SYNC = previousGate;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("still reports the disabled gate first when the live gate is absent", async () => {
    const mod = await import("../src/cli.js");
    const hadStateDir = Object.prototype.hasOwnProperty.call(process.env, STATE_DIR_ENV);
    const previousStateDir = process.env[STATE_DIR_ENV];
    const previousGate = process.env.NOOKBRIDGE_ENABLE_LIVE_SYNC;
    const captured = captureCliWrites();

    try {
      delete process.env[STATE_DIR_ENV];
      delete process.env.NOOKBRIDGE_ENABLE_LIVE_SYNC;

      const code = await mod.run([process.argv[0] as string, "nookctl", "sync", "read-only"]);
      const joined = captured.lines.join("");

      expect(code).toBe(2);
      expect(joined).toContain("NOOKBRIDGE_ENABLE_LIVE_SYNC");
    } finally {
      captured.restore();
      if (hadStateDir && previousStateDir !== undefined) {
        process.env[STATE_DIR_ENV] = previousStateDir;
      } else {
        delete process.env[STATE_DIR_ENV];
      }
      if (previousGate === undefined) delete process.env.NOOKBRIDGE_ENABLE_LIVE_SYNC;
      else process.env.NOOKBRIDGE_ENABLE_LIVE_SYNC = previousGate;
    }
  });
});
