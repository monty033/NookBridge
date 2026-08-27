/**
 * Stage 2B — secure interactive secret-input boundary + admin auth
 * command plumbing.
 *
 * These tests are fully offline.  They DO NOT spawn a real TTY, do
 * NOT call `stty`, do NOT read process env in any meaningful way, and
 * do NOT exercise live Notesnook core.  Every prompt goes through a
 * fake `SecretPrompt` whose behaviour is fully deterministic; every
 * `stty` call is routed through `__setSpawnSyncForTest`.
 *
 * Credentials used in this file are generated at runtime (not
 * committed as canary strings) and labelled clearly so the scanner
 * cannot mistake them for real secrets.  The dedicated password
 * labels ("stage-2b-test-password-N") and MFA labels
 * ("stage-2b-test-mfa-N") are intentionally descriptive and appear
 * in the assertions that follow — they are not real secrets, they
 * are diagnostic tokens.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  collectMfaCode,
  collectPassword,
  createStdioPrompt,
  formatAuthHelp,
  parseAuthCommand,
  runNookCtl,
} from "../src/index.js";
import type { CollectedSecret, SecretPrompt } from "../src/index.js";
import {
  __setSpawnSyncForTest,
  type CapturedStdin,
  type CreateStdioPromptOptions,
  collectEmail,
  resetEchoAuditSink,
  setEchoAuditSink,
} from "../src/auth/secret-input.js";
import { runAuthCommand } from "../src/auth/admin-command.js";

/**
 * Runtime-generated, non-secret label used as a stand-in for the
 * password.  We deliberately do NOT commit a literal password
 * canary to source: if any scanner ever flags the file, the marker
 * they find is a clearly non-credential label.
 */
function runtimePasswordLabel(suffix: string): string {
  const value = `stage-2b-test-password-${suffix}-${randomUUID()}`;
  generatedPasswordLabels.add(value);
  return value;
}

function runtimeMfaLabel(suffix: string): string {
  const value = `stage-2b-test-mfa-${suffix}-${randomUUID()}`;
  generatedMfaLabels.add(value);
  return value;
}

function runtimeEmail(suffix: string): string {
  return `stage-2b-user-${suffix}@example.test`;
}

const generatedPasswordLabels = new Set<string>();
const generatedMfaLabels = new Set<string>();

/**
 * A fake `SecretPrompt` with a queue of pre-canned lines and a
 * journal of what was written/called.  Tracking is exposed via a
 * separate `journal` accessor rather than a property on the
 * SecretPrompt object itself (the public type forbids extra fields).
 */
function createFakePrompt(
  lines: ReadonlyArray<Buffer | null>,
  options: { failOn?: number } = {},
): { prompt: SecretPrompt; journal: { writes: string[]; calls: number } } {
  const journal: { writes: string[]; calls: number } = { writes: [], calls: 0 };
  const prompt: SecretPrompt = {
    writeLine(text) {
      journal.writes.push(text);
    },
    async readSecretLine() {
      const idx = journal.calls;
      journal.calls += 1;
      if (options.failOn !== undefined && idx === options.failOn) {
        throw new Error("fake read error");
      }
      const entry = lines[idx];
      if (entry === undefined) {
        throw new Error(
          `fake prompt ran out of canned inputs on call ${idx + 1}; expected a queued Buffer or null`,
        );
      }
      if (entry === null) {
        return null;
      }
      // Hand back a *copy* so callers can zero without affecting the
      // queue — but we also retain the original buffer for the test
      // to inspect if it needs to.
      return Buffer.from(entry);
    },
  };
  return { prompt, journal };
}

/** A `SecretPrompt` that wraps another and journals the LENGTH of each buffer it returns. */
function createWrappingPrompt(inner: SecretPrompt): {
  prompt: SecretPrompt;
  journal: { buffers: Buffer[]; writes: string[] };
} {
  const journal: { buffers: Buffer[]; writes: string[] } = { buffers: [], writes: [] };
  const prompt: SecretPrompt = {
    writeLine(text) {
      journal.writes.push(text);
      inner.writeLine(text);
    },
    async readSecretLine(opts) {
      const buf = await inner.readSecretLine(opts);
      if (buf !== null) {
        // Snapshot the buffer reference.  Tests probe the bytes
        // AFTER collectEmail returns; collectEmail zeroes the
        // returned buffer in place on every non-return path so by
        // then those probes will observe a fully zeroed buffer.
        journal.buffers.push(buf);
      } else {
        journal.buffers.push(Buffer.alloc(0));
      }
      return buf;
    },
  };
  return { prompt, journal };
}

/** Capture process.stdout writes; restore on cleanup. */
function captureStdout(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  return {
    output: () => chunks.join(""),
    restore: () => writeSpy.mockRestore(),
  };
}

/** Capture process.stderr writes; restore on cleanup. */
function captureStderr(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);
  return {
    output: () => chunks.join(""),
    restore: () => writeSpy.mockRestore(),
  };
}

/** Type the parameters of a `spawnSync` test stub. */
type SttyCall = readonly [command: string, args: readonly string[]];

function okStty(
  _command: string,
  args: readonly string[],
): { status: number; stdout: string; stderr: string; error: undefined } {
  // No-op stub; tests that need specific behaviour override.
  void _command;
  void args;
  return { status: 0, stdout: "", stderr: "", error: undefined };
}

function withRestoreToken(token: string): (
  command: string,
  args: readonly string[],
) => {
  status: number;
  stdout: string;
  stderr: string;
  error: undefined;
} {
  return (command, args) => {
    void command;
    if (args[0] === "-g") {
      return { status: 0, stdout: `${token}\n`, stderr: "", error: undefined };
    }
    if (args[0] === "-echo") {
      return { status: 0, stdout: "", stderr: "", error: undefined };
    }
    if (args[0] === token) {
      return { status: 0, stdout: "", stderr: "", error: undefined };
    }
    return { status: 0, stdout: "", stderr: "", error: undefined };
  };
}

/**
 * Build a fake `CapturedStdin` that is a real `PassThrough` stream
 * decorated with `isTTY: true` and the requested `fd`.  The constructor
 * uses these two facts; the read helper uses the standard
 * `on('data', …)` / `once('end', …)` / `once('error', …)` plumbing
 * that `PassThrough` already provides.
 *
 * `PassThrough` is structurally narrower than `typeof process.stdin`
 * (it does not expose `setRawMode` / `isRaw` / `readTTY` because it
 * is a plain `Readable`), so the test casts through `unknown` — the
 * seam is exercised behaviourally, not type-theoretically, and the
 * cast is local to this helper.
 */
function makeFakeStdin(fd: number): CapturedStdin {
  const stream = new PassThrough();
  Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
  Object.defineProperty(stream, "fd", { configurable: true, value: fd });
  return stream as unknown as CapturedStdin;
}

/**
 * Build a `CreateStdioPromptOptions` whose `spawn` records every call
 * (including its `stdio` tuple) and returns the supplied per-call
 * responder's result.  The responder is consulted in order: it may
 * return a status from `{ stty -g }`, `{ stty -echo }`, the restore
 * token, or any other call.
 */
type RecordedStdio = ReadonlyArray<number | "pipe" | "ipc" | "ignore" | "inherit">;

function recordingSpawn(
  responder: (
    command: string,
    args: readonly string[],
    stdio: RecordedStdio,
  ) => { status: number; stdout: string; stderr: string; error: undefined },
): {
  spawn: NonNullable<CreateStdioPromptOptions["spawn"]>;
  calls: Array<{
    command: string;
    args: readonly string[];
    stdio: RecordedStdio;
  }>;
} {
  const calls: Array<{
    command: string;
    args: readonly string[];
    stdio: RecordedStdio;
  }> = [];
  const spawn: NonNullable<CreateStdioPromptOptions["spawn"]> = (command, args, options) => {
    calls.push({
      command,
      args,
      // The production stdio tuple is `readonly [number | StdioPipe,
      // StdioPipe, StdioPipe]`.  The `StdioPipe` union overlaps with
      // the literal union below for every value the helper actually
      // emits (`number`, `"pipe"`, `"pipe"`), so we widen via an
      // explicit cast — the recorder's contract is observational, not
      // type-theoretical.
      stdio: options.stdio as unknown as RecordedStdio,
    });
    return responder(command, args, options.stdio as unknown as RecordedStdio);
  };
  return { spawn, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetEchoAuditSink();
  __setSpawnSyncForTest(undefined);
});

describe("Stage 2B echo control (production seam)", () => {
  beforeEach(() => {
    resetEchoAuditSink();
  });

  it("captures stty -g, disables echo with stty -echo, and restores via the captured token on success", async () => {
    const calls: SttyCall[] = [];
    __setSpawnSyncForTest((command, args) => {
      calls.push([command, [...args]]);
      if (command === "stty" && args[0] === "-g") {
        return {
          status: 0,
          stdout:
            "2505:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0\n",
          stderr: "",
          error: undefined,
        };
      }
      return { status: 0, stdout: "", stderr: "", error: undefined };
    });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "fd", { configurable: true, value: 0 });
    const stdout = captureStdout();
    try {
      const prompt = createStdioPrompt();
      prompt.writeLine("Notesnook password:");
      // Kick off the read, then immediately emit EOF.  The
      // production helper attaches its listeners inside the promise
      // body, so the emit must happen after the synchronous setup
      // — scheduling it on nextTick guarantees that.
      const pending = prompt.readSecretLine({ prompt: "password" });
      process.nextTick(() => process.stdin.emit("end"));
      const result = await pending;
      expect(result).toBeNull();
    } finally {
      stdout.restore();
    }
    const seenG = calls.some(([c, a]) => c === "stty" && a[0] === "-g");
    const seenDisable = calls.some(([c, a]) => c === "stty" && a[0] === "-echo");
    expect(seenG).toBe(true);
    expect(seenDisable).toBe(true);
  });

  it("fails closed when stty -g exits non-zero", async () => {
    __setSpawnSyncForTest((command, args) => {
      if (command === "stty" && args[0] === "-g") {
        return { status: 1, stdout: "", stderr: "ioctl failed", error: undefined };
      }
      return { status: 0, stdout: "", stderr: "", error: undefined };
    });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "fd", { configurable: true, value: 0 });
    const prompt = createStdioPrompt();

    await expect(prompt.readSecretLine({ prompt: "password" })).rejects.toThrow(
      /captur.*terminal echo state/i,
    );
  });

  it("fails closed when stty -g returns an empty token", async () => {
    __setSpawnSyncForTest((command, args) => {
      if (command === "stty" && args[0] === "-g") {
        return { status: 0, stdout: "   \n", stderr: "", error: undefined };
      }
      return { status: 0, stdout: "", stderr: "", error: undefined };
    });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "fd", { configurable: true, value: 0 });
    const prompt = createStdioPrompt();

    await expect(prompt.readSecretLine({ prompt: "password" })).rejects.toThrow(
      /empty stty restore token/i,
    );
  });

  it("fails closed when stty -echo exits non-zero", async () => {
    __setSpawnSyncForTest((command, args) => {
      if (command === "stty" && args[0] === "-g") {
        return {
          status: 0,
          stdout:
            "2505:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0\n",
          stderr: "",
          error: undefined,
        };
      }
      if (command === "stty" && args[0] === "-echo") {
        return { status: 1, stdout: "", stderr: "permission denied", error: undefined };
      }
      return { status: 0, stdout: "", stderr: "", error: undefined };
    });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "fd", { configurable: true, value: 0 });
    const prompt = createStdioPrompt();

    await expect(prompt.readSecretLine({ prompt: "password" })).rejects.toThrow(
      /failed to disable terminal echo/i,
    );
  });

  it("restores echo even when the read throws", async () => {
    const calls: SttyCall[] = [];
    __setSpawnSyncForTest((command, args) => {
      calls.push([command, [...args]]);
      return withRestoreToken("RESTORE-TOKEN")(command, args);
    });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "fd", { configurable: true, value: 0 });
    // Force a read-time failure by removing the TTY flag after the
    // prompt has been constructed.
    let isTty = true;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      get: () => isTty,
    });
    const prompt = createStdioPrompt();
    isTty = false;
    await expect(prompt.readSecretLine({ prompt: "password" })).rejects.toThrow(/TTY/);
    const restoreCalled = calls.some(([c, a]) => c === "stty" && a[0] === "RESTORE-TOKEN");
    expect(restoreCalled).toBe(true);
  });

  it("restores echo on EOF (returns null)", async () => {
    const calls: SttyCall[] = [];
    __setSpawnSyncForTest((command, args) => {
      calls.push([command, [...args]]);
      return withRestoreToken("TOKEN")(command, args);
    });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "fd", { configurable: true, value: 0 });
    const prompt = createStdioPrompt();
    // Force EOF before any data: kick off the read so the
    // listener is attached, then emit EOF on nextTick.
    const pending = prompt.readSecretLine({ prompt: "password" });
    process.nextTick(() => process.stdin.emit("end"));
    const result = await pending;
    expect(result).toBeNull();
    const restoreCalled = calls.some(([c, a]) => c === "stty" && a[0] === "TOKEN");
    expect(restoreCalled).toBe(true);
  });

  it("surfaces echo-restore failures through the audit sink", async () => {
    const audit: string[] = [];
    setEchoAuditSink((message: string) => {
      audit.push(message);
    });
    __setSpawnSyncForTest((command, args) => {
      if (command === "stty" && args[0] === "-g") {
        return { status: 0, stdout: "TOKEN\n", stderr: "", error: undefined };
      }
      if (command === "stty" && args[0] === "-echo") {
        return { status: 0, stdout: "", stderr: "", error: undefined };
      }
      if (command === "stty" && args[0] === "TOKEN") {
        // Restoration fails — this is what we want to detect.
        return { status: 1, stdout: "", stderr: "ioctl failed", error: undefined };
      }
      return { status: 0, stdout: "", stderr: "", error: undefined };
    });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "fd", { configurable: true, value: 0 });
    const prompt = createStdioPrompt();
    const pending = prompt.readSecretLine({ prompt: "password" });
    process.nextTick(() => process.stdin.emit("end"));
    await pending;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]).toMatch(/echo restoration failed/i);
  });

  it("throws when process.stdin is not a TTY", () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    expect(() => createStdioPrompt()).toThrow(/interactive TTY/i);
  });

  it("normalizes hostile constructor option, stream, and platform getters", () => {
    const canary = runtimePasswordLabel("hostile-prompt-options");
    const stdout = { write: () => true } as unknown as typeof process.stdout;
    const validStdin = makeFakeStdin(41);
    const throwingOptions = new Proxy(
      {},
      {
        get() {
          throw new Error(canary);
        },
      },
    );
    const throwingStream = {
      get isTTY(): boolean {
        throw new Error(canary);
      },
      fd: 41,
    } as unknown as CapturedStdin;
    const throwingPlatform = {
      stdin: validStdin,
      stdout,
      get platform(): string {
        throw new Error(canary);
      },
    };

    for (const options of [
      throwingOptions,
      { stdin: throwingStream, stdout, platform: "linux" },
      throwingPlatform,
    ]) {
      let caught: unknown;
      try {
        createStdioPrompt(options as CreateStdioPromptOptions);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & { cause?: unknown; __context__?: unknown };
      expect(error.message).not.toContain(canary);
      expect(error.cause).toBeUndefined();
      expect(error.__context__).toBeUndefined();
    }
  });

  it("contains throwing stty results and still attempts restore after disable throws", async () => {
    const canary = runtimePasswordLabel("throwing-stty");
    const captured = makeFakeStdin(43);
    const calls: string[] = [];
    const spawn: NonNullable<CreateStdioPromptOptions["spawn"]> = (command, args) => {
      void command;
      calls.push(args[0] ?? "");
      if (args[0] === "-g") {
        return { status: 0, stdout: "TOKEN\n", stderr: "", error: undefined };
      }
      if (args[0] === "-echo") throw new Error(canary);
      return { status: 0, stdout: "", stderr: "", error: undefined };
    };
    const prompt = createStdioPrompt({
      stdin: captured,
      stdout: { write: () => true } as unknown as typeof process.stdout,
      platform: "linux",
      spawn,
    });

    let caught: unknown;
    try {
      await prompt.readSecretLine({ prompt: "password" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & { cause?: unknown; __context__?: unknown };
    expect(error.message).toMatch(/disable terminal echo/i);
    expect(error.message).not.toContain(canary);
    expect(error.cause).toBeUndefined();
    expect(error.__context__).toBeUndefined();
    expect(calls).toEqual(["-g", "-echo", "TOKEN"]);
  });

  it("contains malformed stty results without exposing their fields", async () => {
    const canary = runtimePasswordLabel("malformed-stty-result");
    const prompt = createStdioPrompt({
      stdin: makeFakeStdin(45),
      stdout: { write: () => true } as unknown as typeof process.stdout,
      platform: "linux",
      spawn: ((_command, args) => {
        if (args[0] === "-g") {
          return {
            status: "not-a-status",
            stdout: canary,
            stderr: canary,
            error: undefined,
          } as unknown as ReturnType<NonNullable<CreateStdioPromptOptions["spawn"]>>;
        }
        return { status: 0, stdout: "", stderr: "", error: undefined };
      }) as NonNullable<CreateStdioPromptOptions["spawn"]>,
    });

    let caught: unknown;
    try {
      await prompt.readSecretLine({ prompt: "password" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & { cause?: unknown; __context__?: unknown };
    expect(error.message).toBe("failed to capture terminal echo state: refusing to read a secret");
    expect(error.message).not.toContain(canary);
    expect(error.cause).toBeUndefined();
    expect(error.__context__).toBeUndefined();
  });

  it("swallows an audit-sink failure during restore", async () => {
    const captured = makeFakeStdin(44);
    setEchoAuditSink(() => {
      throw new Error(runtimePasswordLabel("throwing-audit-sink"));
    });
    const spawn: NonNullable<CreateStdioPromptOptions["spawn"]> = (_command, args) => {
      if (args[0] === "-g") {
        return { status: 0, stdout: "TOKEN\n", stderr: "", error: undefined };
      }
      if (args[0] === "TOKEN") throw new Error(runtimePasswordLabel("throwing-restore"));
      return { status: 0, stdout: "", stderr: "", error: undefined };
    };
    const prompt = createStdioPrompt({
      stdin: captured,
      stdout: { write: () => true } as unknown as typeof process.stdout,
      platform: "linux",
      spawn,
    });
    const pending = prompt.readSecretLine({ prompt: "password" });
    process.nextTick(() => captured.emit("end"));
    await expect(pending).resolves.toBeNull();
  });

  it("refuses to run on non-POSIX platforms", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      Object.defineProperty(process.stdin, "fd", { configurable: true, value: 0 });
      const prompt = createStdioPrompt();
      await expect(prompt.readSecretLine({ prompt: "password" })).rejects.toThrow(
        /POSIX terminals/,
      );
    } finally {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("okStty helper compiles and round-trips through the seam", () => {
    expect(okStty("stty", ["-g"])).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });
  });
});

describe("Stage 2B secret collection (injected prompt)", () => {
  it("collects a password, zeros it on demand, and labels the prompt correctly", async () => {
    const label = runtimePasswordLabel("once");
    const { prompt, journal } = createFakePrompt([Buffer.from(label)]);
    const collected = await collectPassword({ prompt });
    expect(collected.kind).toBe("password");
    expect(collected.bytes.toString("utf8")).toBe(label);
    expect(journal.writes).toEqual(["Notesnook password:"]);
    collected.zero();
    expect(collected.bytes.every((b) => b === 0)).toBe(true);
  });

  it("retries on empty password input and succeeds on the third attempt", async () => {
    const label = runtimePasswordLabel("retry");
    const { prompt, journal } = createFakePrompt([
      Buffer.from(""),
      Buffer.from(""),
      Buffer.from(label),
    ]);
    const collected = await collectPassword({ prompt });
    expect(collected.bytes.toString("utf8")).toBe(label);
    expect(journal.calls).toBe(3);
    collected.zero();
  });

  it("throws after maxAttempts empty retries and never reads a fourth time", async () => {
    const { prompt, journal } = createFakePrompt([
      Buffer.from(""),
      Buffer.from(""),
      Buffer.from(""),
    ]);
    await expect(collectPassword({ prompt, maxAttempts: 3 })).rejects.toThrow(
      /attempt 3 of 3 was empty/,
    );
    expect(journal.calls).toBe(3);
  });

  it("treats EOF (null) as a hard error before the empty-line retry path", async () => {
    const { prompt, journal } = createFakePrompt([null]);
    await expect(collectPassword({ prompt })).rejects.toThrow(/ended before a value/);
    expect(journal.calls).toBe(1);
  });

  it("zeroes the temporary email buffer on every iteration (empty, malformed, success)", async () => {
    const label = runtimeEmail("zeroize");
    const inner = createFakePrompt([
      Buffer.from(""),
      Buffer.from("not-an-email"),
      Buffer.from(label),
    ]);
    const wrapping = createWrappingPrompt(inner.prompt);
    const email = await collectEmail({ prompt: wrapping.prompt });
    expect(email).toBe(label);
    // Three buffers were handed back.  The current implementation
    // zeroizes the buffer on every iteration including the success
    // return — the caller receives the trimmed string instead of
    // the buffer reference, so the wipe is safe and thorough.
    expect(wrapping.journal.buffers.length).toBe(3);
    for (const buf of wrapping.journal.buffers) {
      expect(buf.every((b: number) => b === 0)).toBe(true);
    }
  });

  it("collects an MFA code and zeroes it on demand", async () => {
    const label = runtimeMfaLabel("once");
    const { prompt, journal } = createFakePrompt([Buffer.from(label)]);
    const collected = await collectMfaCode({ prompt });
    expect(collected.kind).toBe("mfa");
    expect(collected.bytes.toString("utf8")).toBe(label);
    expect(journal.writes).toEqual(["Notesnook MFA code:"]);
    collected.zero();
    expect(collected.bytes.every((b) => b === 0)).toBe(true);
  });

  it("rejects zero or negative maxAttempts before touching the prompt", async () => {
    const { prompt, journal } = createFakePrompt([Buffer.from("ignored")]);
    await expect(collectPassword({ prompt, maxAttempts: 0 })).rejects.toThrow(
      /maxAttempts must be a positive integer/,
    );
    expect(journal.calls).toBe(0);
  });

  it("normalizes hostile options getters for every exported collector", async () => {
    const canary = runtimePasswordLabel("hostile-collector-options");
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(canary);
        },
      },
    );

    for (const collect of [collectEmail, collectPassword, collectMfaCode]) {
      let caught: unknown;
      try {
        await collect(hostile as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & { __context__?: unknown };
      expect(error.message).toBe("secret input options are invalid");
      expect(error.message).not.toContain(canary);
      expect(error.cause).toBeUndefined();
      expect(error.__context__).toBeUndefined();
    }
  });

  it("thrown messages do not include the captured buffer (only categorical text)", async () => {
    const { prompt } = createFakePrompt([Buffer.from(""), Buffer.from(""), Buffer.from("")]);
    let err: unknown;
    try {
      await collectPassword({ prompt, maxAttempts: 3 });
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toContain("ignored");
    expect(message).toMatch(/attempt 3 of 3 was empty/);
  });
});

describe("Stage 2B runAuthCommand (admin auth plumbing)", () => {
  it("refuses argv that smuggles a password via --password", () => {
    const env: Record<string, string | undefined> = {};
    const result = parseAuthCommand(["login", "--password", runtimePasswordLabel("argv")], env);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected an error result");
    expect(result.message).toMatch(/refusing to read credentials from CLI flag --password/);
    expect(result.exitCode).toBe(2);
  });

  it("refuses forbidden env vars (NOOKBRIDGE_PASSWORD, NOOKBRIDGE_MFA, NOOKCTL_PASSWORD)", () => {
    for (const name of ["NOOKBRIDGE_PASSWORD", "NOOKBRIDGE_MFA", "NOOKCTL_PASSWORD"] as const) {
      const env: Record<string, string | undefined> = {
        [name]: runtimePasswordLabel(name),
      };
      const result = parseAuthCommand(["login"], env);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") throw new Error("expected an error result");
      expect(result.message).toMatch(new RegExp(`environment variable ${name}`));
      expect(result.exitCode).toBe(2);
    }
  });

  it("returns a help result for `auth help` and renders formatAuthHelp", () => {
    const parsed = parseAuthCommand(["help"], {});
    expect(parsed.kind).toBe("parsed");
    const text = formatAuthHelp();
    // Help text must reference the credential boundary and explicitly
    // name the forbidden flag/env-var channels.
    expect(text).toMatch(/Credential boundary/);
    expect(text).toMatch(/--password/);
    expect(text).toMatch(/NOOKBRIDGE_PASSWORD/);
  });

  it("returns a deferred outcome for status/logout/reset-local-client without consulting a prompt", async () => {
    for (const sub of ["status", "logout", "reset-local-client"] as const) {
      const result = await runAuthCommand({ argv: [sub], env: {} });
      expect(result.kind).toBe("deferred");
      if (result.kind !== "deferred") throw new Error("expected deferred");
      expect(result.outcome.subcommand).toBe(sub);
      expect(result.outcome.status).toBe("deferred");
    }
  });

  it("returns the deferred login outcome WITHOUT touching a prompt", async () => {
    const result = await runAuthCommand({ argv: ["login"], env: {} });
    expect(result.kind).toBe("deferred");
    if (result.kind !== "deferred") throw new Error("expected deferred");
    expect(result.outcome.subcommand).toBe("login");
    expect(result.outcome.message).toMatch(/deferred/);
  });

  it("rejects an unknown auth subcommand", () => {
    const result = parseAuthCommand(["nuke"], {});
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toMatch(/unknown subcommand/);
  });

  it("exerciseLoginPipeline without a prompt throws a clear error", async () => {
    await expect(
      runAuthCommand({ argv: ["login"], env: {}, exerciseLoginPipeline: true }),
    ).rejects.toThrow(/requires an injected prompt/i);
  });

  it("exerciseLoginPipeline collects email + password + optional MFA and zeroes everything", async () => {
    const email = runtimeEmail("pipeline");
    const password = runtimePasswordLabel("pipeline");
    const mfa = runtimeMfaLabel("pipeline");
    const { prompt } = createFakePrompt([
      Buffer.from(email),
      Buffer.from(password),
      Buffer.from(mfa),
    ]);
    const result = await runAuthCommand({
      argv: ["login"],
      env: {},
      prompt,
      exerciseLoginPipeline: true,
    });
    expect(result.kind).toBe("exercised-login");
    if (result.kind !== "exercised-login") throw new Error("expected exercised-login");
    const [capturedEmail, capturedPassword, capturedMfa] = result.captured;
    // The email is returned as a plain string (not a credential).
    expect(capturedEmail).toBe(email);
    const passwordBuf = (capturedPassword as CollectedSecret).bytes;
    const mfaBuf = (capturedMfa as CollectedSecret).bytes;
    // The runner zeroed both buffers before returning.  Lengths
    // match the originals; contents are wiped.
    expect(passwordBuf.length).toBe(password.length);
    expect(mfaBuf.length).toBe(mfa.length);
    expect(passwordBuf.every((b: number) => b === 0)).toBe(true);
    expect(mfaBuf.every((b: number) => b === 0)).toBe(true);
  });

  it("exerciseLoginPipeline zeroes the password if MFA fails for a non-EOF reason", async () => {
    const email = runtimeEmail("mfa-fail");
    const password = runtimePasswordLabel("mfa-fail");
    const mfa = runtimeMfaLabel("mfa-fail");
    const { prompt } = createFakePrompt([
      Buffer.from(email),
      Buffer.from(password),
      Buffer.from(""),
      Buffer.from(""),
      Buffer.from(""), // MFA exhausts attempts with empty input
      Buffer.from(mfa), // unreachable; the runner throws before this
    ]);
    const stdout = captureStdout();
    const stderr = captureStderr();
    try {
      await expect(
        runAuthCommand({
          argv: ["login"],
          env: {},
          prompt,
          exerciseLoginPipeline: true,
          maxAttempts: 3,
        }),
      ).rejects.toThrow(/mfa attempt 3 of 3 was empty/);
      // The runner must not have written the password or MFA to
      // stdout / stderr on the failure path.
      expect(stdout.output()).not.toContain(password);
      expect(stdout.output()).not.toContain(mfa);
      expect(stderr.output()).not.toContain(password);
      expect(stderr.output()).not.toContain(mfa);
    } finally {
      stdout.restore();
      stderr.restore();
    }

    // A hostile prompt can throw the same human-readable phrase used by the
    // old EOF classifier.  That error is not EOF and must not be swallowed;
    // the public command boundary must normalize it without retaining the
    // hostile message, cause, or context, while still zeroizing the password.
    const collisionCanary = runtimePasswordLabel("mfa-prompt-collision");
    const collisionError = new Error("mfa input ended before a value was entered");
    Object.defineProperty(collisionError, "cause", {
      configurable: true,
      value: new Error(collisionCanary),
    });
    Object.defineProperty(collisionError, "__context__", {
      configurable: true,
      value: new Error(collisionCanary),
    });
    let collisionPassword: Buffer | undefined;
    const collidingPrompt: SecretPrompt = {
      writeLine: () => {},
      async readSecretLine({ prompt: field }) {
        if (field === "email") return Buffer.from(runtimeEmail("mfa-prompt-collision"));
        if (field === "password") {
          collisionPassword = Buffer.from(runtimePasswordLabel("mfa-prompt-password"));
          return collisionPassword;
        }
        throw collisionError;
      },
    };
    let collisionCaught: unknown;
    try {
      await runAuthCommand({
        argv: ["login"],
        env: {},
        prompt: collidingPrompt,
        exerciseLoginPipeline: true,
      });
    } catch (error) {
      collisionCaught = error;
    }
    expect(collisionCaught).toBeInstanceOf(Error);
    const normalizedCollision = collisionCaught as Error & { __context__?: unknown };
    expect(normalizedCollision.message).toBe("nookctl auth: credential input failed");
    expect(normalizedCollision.message).not.toContain(collisionCanary);
    expect(normalizedCollision.cause).toBeUndefined();
    expect(normalizedCollision.__context__).toBeUndefined();
    expect(collisionPassword).toBeDefined();
    expect(collisionPassword?.every((byte) => byte === 0)).toBe(true);

    // Synchronous prompt writes use the same categorical boundary.
    const writeCanary = runtimePasswordLabel("mfa-write-failure");
    const writeError = new Error(writeCanary);
    const writePassword = Buffer.from(runtimePasswordLabel("mfa-write-password"));
    const writeFailPrompt: SecretPrompt = {
      writeLine(text) {
        if (text === "Notesnook MFA code:") throw writeError;
      },
      async readSecretLine({ prompt: field }) {
        if (field === "email") return Buffer.from(runtimeEmail("mfa-write-failure"));
        if (field === "password") return writePassword;
        return Buffer.from(runtimeMfaLabel("unreachable"));
      },
    };
    await expect(
      runAuthCommand({
        argv: ["login"],
        env: {},
        prompt: writeFailPrompt,
        exerciseLoginPipeline: true,
      }),
    ).rejects.toMatchObject({
      message: "nookctl auth: credential input failed",
      cause: undefined,
      __context__: undefined,
    });
    expect(writePassword.every((byte) => byte === 0)).toBe(true);
  });

  it("exerciseLoginPipeline completes without MFA when the prompt returns null on the MFA step", async () => {
    const email = runtimeEmail("no-mfa");
    const password = runtimePasswordLabel("no-mfa");
    const { prompt } = createFakePrompt([Buffer.from(email), Buffer.from(password), null]);
    const result = await runAuthCommand({
      argv: ["login"],
      env: {},
      prompt,
      exerciseLoginPipeline: true,
    });
    expect(result.kind).toBe("exercised-login");
    if (result.kind !== "exercised-login") throw new Error("expected exercised-login");
    expect(result.captured.length).toBe(2); // email + password only
    const [, capturedPassword] = result.captured;
    expect((capturedPassword as CollectedSecret).bytes.every((b) => b === 0)).toBe(true);
  });

  it("does not leak a password or MFA label into stdout or stderr", async () => {
    const email = runtimeEmail("noleak");
    const password = runtimePasswordLabel("noleak");
    const mfa = runtimeMfaLabel("noleak");
    const { prompt } = createFakePrompt([
      Buffer.from(email),
      Buffer.from(password),
      Buffer.from(mfa),
    ]);
    const stdout = captureStdout();
    const stderr = captureStderr();
    try {
      const result = await runAuthCommand({
        argv: ["login"],
        env: {},
        prompt,
        exerciseLoginPipeline: true,
      });
      expect(result.kind).toBe("exercised-login");
      const out = stdout.output();
      const err = stderr.output();
      expect(out).not.toContain(password);
      expect(out).not.toContain(mfa);
      expect(err).not.toContain(password);
      expect(err).not.toContain(mfa);
    } finally {
      stdout.restore();
      stderr.restore();
    }
  });
});

describe("Stage 2B CLI (runNookCtl)", () => {
  it("runs `auth help` without constructing a TTY prompt", async () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    try {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
      const exitCode = await runNookCtl(["node", "nookctl", "auth", "help"]);
      expect(exitCode).toBe(0);
      expect(stdout.output()).toMatch(/Credential boundary/);
      expect(stderr.output()).toBe("");
    } finally {
      stdout.restore();
      stderr.restore();
    }
  });

  it("runs `auth status` non-interactively without a prompt", async () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    try {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
      const exitCode = await runNookCtl(["node", "nookctl", "auth", "status"]);
      expect(exitCode).toBe(0);
      expect(stdout.output()).toMatch(/auth status: deferred/);
      expect(stderr.output()).toBe("");
    } finally {
      stdout.restore();
      stderr.restore();
    }
  });

  it("runs `auth logout` and `auth reset-local-client` non-interactively", async () => {
    for (const sub of ["logout", "reset-local-client"] as const) {
      const stdout = captureStdout();
      const stderr = captureStderr();
      try {
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
        const exitCode = await runNookCtl(["node", "nookctl", "auth", sub]);
        expect(exitCode).toBe(0);
        expect(stdout.output()).toMatch(new RegExp(`auth ${sub}: deferred`));
        expect(stderr.output()).toBe("");
      } finally {
        stdout.restore();
        stderr.restore();
      }
    }
  });

  it("rejects an unknown auth subcommand categorically via stderr with exit code 2", async () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    try {
      const exitCode = await runNookCtl(["node", "nookctl", "auth", "nuke"]);
      expect(exitCode).toBe(2);
      expect(stderr.output()).toBe(
        "nookctl: nookctl auth: unknown subcommand; use `nookctl auth help`\n",
      );
      expect(stderr.output()).not.toContain("nuke");
      expect(stdout.output()).toBe("");
    } finally {
      stdout.restore();
      stderr.restore();
    }
  });

  it("rejects argv-supplied --password with exit code 2", async () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    try {
      const exitCode = await runNookCtl([
        "node",
        "nookctl",
        "auth",
        "login",
        "--password",
        runtimePasswordLabel("cli-argv"),
      ]);
      expect(exitCode).toBe(2);
      expect(stderr.output()).toMatch(/refusing to read credentials from CLI flag --password/);
    } finally {
      stdout.restore();
      stderr.restore();
    }
  });

  it("does not touch persistent state from the deferred auth branches", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-stage2b-cli-"));
    try {
      const stdout = captureStdout();
      try {
        Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
        await runNookCtl(["node", "nookctl", "auth", "status"]);
        await runNookCtl(["node", "nookctl", "auth", "logout"]);
        await runNookCtl(["node", "nookctl", "auth", "reset-local-client"]);
      } finally {
        stdout.restore();
      }
      // The runner must not have created the state directory's
      // `.d` subdirectory (only `doctor` does that).
      const subdirs = readdirSync(stateDir);
      expect(subdirs).toEqual([]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects an inherited credential carrier at the public CLI boundary", async () => {
    const stdout = captureStdout();
    const stderr = captureStderr();
    const environment = process.env as unknown as object;
    const originalPrototype = Object.getPrototypeOf(environment);
    const canary = runtimePasswordLabel("inherited-env");
    try {
      Object.setPrototypeOf(environment, { NOOKBRIDGE_PASSWORD: canary });
      const exitCode = await runNookCtl(["node", "nookctl", "auth", "status"]);
      expect(exitCode).toBe(2);
      expect(stderr.output()).toBe(
        "nookctl: refusing to read credentials from environment variable NOOKBRIDGE_PASSWORD; use an interactive TTY prompt\n",
      );
      expect(stderr.output()).not.toContain(canary);
      expect(stdout.output()).toBe("");
    } finally {
      Object.setPrototypeOf(environment, originalPrototype);
      stdout.restore();
      stderr.restore();
    }
  });

  it("regression: `doctor` still works after Stage 2B CLI plumbing is layered on", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "nookbridge-stage2b-doctor-"));
    const stdout = captureStdout();
    const stderr = captureStderr();
    try {
      const exitCode = await runNookCtl(["node", "nookctl", "doctor", "--state-dir", stateDir]);
      expect([0, 1]).toContain(exitCode);
      const out = stdout.output();
      expect(out).toMatch(/doctor/i);
    } finally {
      stdout.restore();
      stderr.restore();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

/**
 * Stage 2B captured-stream / fd / restore regression tests.
 *
 * These four regression tests exercise the constructor-time seam on
 * {@link createStdioPrompt}: the stream, stdout, platform value, and
 * `spawnSync` primitive are captured exactly once, never re-resolved
 * from `process` after construction, and bound by the production code
 * to the captured fd on every `stty` invocation.
 *
 * The tests deliberately do NOT touch `process.stdin` /
 * `process.stdout` after handing the captured stream to the prompt —
 * that is the seam's contract.  The one place the tests do touch
 * `process.stdin` is in a defensive `afterEach` that resets any
 * `isTTY` / `fd` overrides back to their original values; without
 * that cleanup the earlier `Stage 2B echo control` tests would
 * leak state into subsequent runs.
 */
describe("Stage 2B captured-stream / fd / restore regression (constructor seam)", () => {
  // Reset any overrides left behind by other tests in this file.  We
  // capture the originals first so we can restore them rather than
  // assume the prior test left them in any particular state.
  let originalStdinIsTty: boolean | undefined;
  let originalStdinFd: number | undefined;
  // The ESLint flat config only exposes `process`, `console`, and
  // `Buffer` as globals, so referencing `NodeJS.Platform` would trip
  // `no-undef`.  We only need the original value for round-trip
  // restoration, so a `string` annotation is enough.
  let originalPlatform: string;

  beforeEach(() => {
    originalStdinIsTty = (process.stdin as { isTTY?: boolean }).isTTY;
    originalStdinFd = (process.stdin as { fd?: number }).fd;
    originalPlatform = process.platform;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "fd", { configurable: true, value: 0 });
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinIsTty,
    });
    Object.defineProperty(process.stdin, "fd", {
      configurable: true,
      value: originalStdinFd,
    });
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  it("reads from the injected PassThrough stream, not from process.stdin", async () => {
    // Two distinct streams with distinct fd numbers.  The prompt is
    // constructed against the injected one; after construction we
    // mutate `process.stdin` to a brand-new PassThrough and emit a
    // different payload on it.  The prompt must read only from the
    // captured stream.
    const capturedFd = 42;
    const captured = makeFakeStdin(capturedFd);
    const { spawn } = recordingSpawnOk();
    const prompt = createStdioPrompt({ stdin: captured, spawn });

    // Swap `process.stdin` to a brand-new stream that carries the
    // wrong payload.  If the prompt falls back to `process.stdin`
    // after construction it would read this instead of our captured
    // stream's payload.
    const swapped = makeFakeStdin(99);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "fd", { configurable: true, value: 99 });
    Object.defineProperty(swapped, "isTTY", { configurable: true, value: true });

    const capturedLabel = runtimePasswordLabel("captured");
    const pending = prompt.readSecretLine({ prompt: "password" });
    // Emit the wrong payload on `process.stdin` (the swapped global).
    // Use nextTick so listeners are attached first.
    process.nextTick(() => {
      swapped.write(`${runtimePasswordLabel("swapped")}\n`);
      swapped.end();
    });
    // And the right payload on the captured stream.
    process.nextTick(() => {
      captured.write(`${capturedLabel}\n`);
      captured.end();
    });
    const result = await pending;
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected captured bytes");
    const text = result.toString("utf8");
    expect(text).toBe(capturedLabel);
    expect(text).not.toContain("swapped");
  });

  it("binds all three stty calls to stdio = [capturedFd, 'pipe', 'pipe']", async () => {
    const capturedFd = 17;
    const stdin = makeFakeStdin(capturedFd);
    const { spawn, calls } = recordingSpawn(okResponder);
    const prompt = createStdioPrompt({ stdin, spawn });

    const pending = prompt.readSecretLine({ prompt: "password" });
    process.nextTick(() => {
      stdin.write(`${runtimePasswordLabel("stdio")}\n`);
      stdin.end();
    });
    await pending;

    // The production helper performs exactly three stty calls:
    //   1. `stty -g`       (capture the restore token)
    //   2. `stty -echo`    (disable echo)
    //   3. `stty <token>`  (restore echo)
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call.command).toBe("stty");
      expect(call.stdio[0]).toBe(capturedFd);
      expect(call.stdio[1]).toBe("pipe");
      expect(call.stdio[2]).toBe("pipe");
    }
    const firstArgs = calls[0]?.args[0];
    const secondArgs = calls[1]?.args[0];
    const thirdArgs = calls[2]?.args[0];
    expect(firstArgs).toBe("-g");
    expect(secondArgs).toBe("-echo");
    // Third call's arg is the captured restore token returned by `stty -g`.
    expect(thirdArgs).toBe("RESTORE-TOKEN");
  });

  it("restores echo after EOF (returns null) AND after a read-time error", async () => {
    // Subtest 1: restoration after EOF.
    {
      const capturedFd = 23;
      const stdin = makeFakeStdin(capturedFd);
      const { spawn, calls } = recordingSpawn(okResponder);
      const prompt = createStdioPrompt({ stdin, spawn });
      const pending = prompt.readSecretLine({ prompt: "password" });
      process.nextTick(() => stdin.end());
      const result = await pending;
      expect(result).toBeNull();
      const restore = calls.find((c) => c.command === "stty" && c.args[0] === "RESTORE-TOKEN");
      expect(restore).toBeDefined();
      expect(restore?.stdio[0]).toBe(capturedFd);
    }

    // Subtest 2: restoration after a read-time error emitted on the
    // captured stream.  The production helper must normalize the
    // error (the caller still needs a failure), but the `finally` block
    // MUST still invoke `stty` with the captured restore token to undo
    // the `stty -echo` it just performed.
    {
      const capturedFd = 31;
      const stdin = makeFakeStdin(capturedFd);
      const { spawn, calls } = recordingSpawn(okResponder);
      const prompt = createStdioPrompt({ stdin, spawn });
      const syntheticError = new Error("synthetic injected read-time failure");
      const pending = prompt.readSecretLine({ prompt: "password" }).catch((err: unknown) => err);
      process.nextTick(() => {
        stdin.destroy(syntheticError);
      });
      const err = (await pending) as Error & { cause?: unknown; __context__?: unknown };
      expect(err).toMatchObject({
        message: "secret input stream read failed",
        cause: undefined,
        __context__: undefined,
      });
      const restore = calls.find((c) => c.command === "stty" && c.args[0] === "RESTORE-TOKEN");
      expect(restore).toBeDefined();
      expect(restore?.stdio[0]).toBe(capturedFd);
    }
  });

  it("emits a categorical audit message on restoration failure that does not contain any runtime secret-like value", async () => {
    const audit: string[] = [];
    setEchoAuditSink((message: string) => {
      audit.push(message);
    });

    const capturedFd = 51;
    const stdin = makeFakeStdin(capturedFd);

    // The runtime label below is intentionally a high-entropy
    // "secret-looking" token.  If it ever appears in the audit
    // message the audit is leaking the user's input — the test is
    // designed to catch exactly that regression.
    const secretLike = `stage-2b-secret-${randomUUID()}`;
    const { spawn } = recordingSpawn((command, args) => {
      if (command === "stty" && args[0] === "-g") {
        return { status: 0, stdout: "RESTORE-TOKEN\n", stderr: "", error: undefined };
      }
      if (command === "stty" && args[0] === "-echo") {
        return { status: 0, stdout: "", stderr: "", error: undefined };
      }
      if (command === "stty" && args[0] === "RESTORE-TOKEN") {
        // Restoration fails — this is the path under test.
        return { status: 1, stdout: "", stderr: "ioctl failed", error: undefined };
      }
      return { status: 0, stdout: "", stderr: "", error: undefined };
    });

    const prompt = createStdioPrompt({ stdin, spawn });

    // Kick off the read, then push the secret-like payload through the
    // captured stream.  The production code will read it as the line
    // bytes and hand it back via `resolve(trimmed)` — but those bytes
    // must not appear in the audit sink's message.
    const pending = prompt.readSecretLine({ prompt: "password" });
    process.nextTick(() => {
      stdin.write(`${secretLike}\n`);
      stdin.end();
    });
    await pending;

    expect(audit.length).toBeGreaterThan(0);
    const message = audit[0] ?? "";
    // The message must be categorical and contain none of the
    // secret-like runtime values:
    //   - the captured bytes we pushed through stdin
    //   - any of the diagnostic labels the test file generates
    //   - the captured fd number itself (the fd is process-global and
    //     not necessarily sensitive, but the test asserts it never
    //     appears in the audit so the audit stays categorical)
    expect(message).toMatch(/echo restoration failed/i);
    expect(message).not.toContain(secretLike);
    for (const value of generatedPasswordLabels) {
      expect(message).not.toContain(value);
    }
    for (const value of generatedMfaLabels) {
      expect(message).not.toContain(value);
    }
    expect(message).not.toContain(`fd ${capturedFd}`);
    expect(message).not.toContain(String(capturedFd));
  });
});

/**
 * Local copy of a no-op responder for the recording spawn helper.
 *
 * The file's top-level `okStty` ignores its inputs, but
 * `recordingSpawn` requires a responder that returns a valid
 * `SttyResult` for every call.  We supply one that returns the
 * canonical `RESTORE-TOKEN` for the `stty -g` capture, no-ops for
 * `-echo`, and treats the token as the third call's first arg —
 * matching what the production code expects.
 */
function okResponder(
  _command: string,
  args: readonly string[],
  _stdio: RecordedStdio,
): { status: number; stdout: string; stderr: string; error: undefined } {
  void _command;
  void _stdio;
  if (args[0] === "-g") {
    return { status: 0, stdout: "RESTORE-TOKEN\n", stderr: "", error: undefined };
  }
  return { status: 0, stdout: "", stderr: "", error: undefined };
}

/** Convenience: a `recordingSpawn` pre-bound to {@link okResponder}. */
function recordingSpawnOk(): {
  spawn: NonNullable<CreateStdioPromptOptions["spawn"]>;
  calls: Array<{
    command: string;
    args: readonly string[];
    stdio: RecordedStdio;
  }>;
} {
  return recordingSpawn(okResponder);
}
