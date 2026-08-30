/**
 * Stage 5 §6 — black-box offline CLI tests for the gated operator
 * `nookctl conflicts` tree.
 *
 * The suite exercises the real exported CLI dispatcher seam with an
 * injected runtime, mirroring the Stage 3 / Stage 4 operator test
 * pattern.  Nothing in this file imports the live Notesnook runtime
 * and nothing reaches the network; the observer comes from a
 * deterministic in-memory fake.
 *
 * The behaviour asserted here is exactly the gate ordering pinned in
 * the Stage 5 §6 contract:
 *
 *   1. parse → reject forbidden credential / body / id / revision
 *      carriers before runtime construction;
 *   2. require exact `NOOKBRIDGE_ENABLE_LIVE_SYNC=1` before runtime
 *      construction;
 *   3. construct the production runtime, then call only the
 *      separately named local-conflict observer;
 *   4. cleanup exactly once on success AND failure;
 *   5. user-facing output is fixed categorical text only —
 *      supplied title, internal id, body, revision, path, upstream
 *      message, cause, and stack are NEVER echoed.
 */

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import process from "node:process";

import {
  formatConflictCommandResult,
  formatConflictHelp,
  parseConflictCommand,
  runConflictCommand,
  type RunConflictCommandOptions,
} from "../src/core/notesnook-conflict-admin.js";
import type {
  NotesnookLocalConflictObservation,
  NotesnookLocalConflictObserver,
} from "../src/core/notesnook-local-conflict-projection.js";

const ENABLED_ENV = Object.freeze({ NOOKBRIDGE_ENABLE_LIVE_SYNC: "1" }) as Readonly<
  Record<string, string | undefined>
>;

type FakeRuntime = {
  calls: string[];
  cleanupCalls: number;
  observer: NotesnookLocalConflictObserver;
};

function makeFakeObserver(
  behavior: "detecting" | "fresh" | "fail",
): NotesnookLocalConflictObserver {
  if (behavior === "fail") {
    return Object.freeze({
      listLocalConflicts: async () => {
        throw new Error("CANARY-UPSTREAM-MESSAGE /var/state/db.key token=abc123");
      },
      observeNoteConflict: async (
        id: string,
      ): Promise<false | NotesnookLocalConflictObservation> => {
        throw new Error(`CANARY-UPSTREAM-MESSAGE note=${id}`);
      },
    });
  }
  if (behavior === "fresh") {
    return Object.freeze({
      listLocalConflicts: async () => Object.freeze([]),
      observeNoteConflict: async (
        id: string,
      ): Promise<false | NotesnookLocalConflictObservation> => {
        if (id === "title-detecting") return false;
        return false as const;
      },
    });
  }
  return Object.freeze({
    listLocalConflicts: async () =>
      Object.freeze([Object.freeze({ id: "conflict-note", title: "Locally conflicted note" })]),
    observeNoteConflict: async (id: string): Promise<false | NotesnookLocalConflictObservation> => {
      if (id !== "conflict-note") return false;
      return Object.freeze({
        id,
        title: "Locally conflicted note",
        conflicted: true as const,
      });
    },
  });
}

function makeFakeRuntime(observer: NotesnookLocalConflictObserver): FakeRuntime {
  const calls: string[] = [];
  let cleanupCalls = 0;
  return {
    calls,
    get cleanupCalls() {
      return cleanupCalls;
    },
    set cleanupCalls(value: number) {
      cleanupCalls = value;
    },
    observer,
  };
}

function makeObserverRuntime(behavior: "detecting" | "fresh" | "fail"): {
  runtime: () => Promise<{
    observer: NotesnookLocalConflictObserver;
    cleanup: () => Promise<void>;
  }>;
  calls: string[];
  cleanupCount(): number;
} {
  const state = makeFakeRuntime(makeFakeObserver(behavior));
  return {
    runtime: async () => {
      state.calls.push("createObserverRuntime");
      return {
        observer: state.observer,
        cleanup: async () => {
          state.calls.push("cleanup");
          state.cleanupCalls += 1;
        },
      };
    },
    calls: state.calls,
    cleanupCount: () => state.cleanupCalls,
  };
}

// ---------------------------------------------------------------------------
// Help text is fixed and does not echo any caller input.
// ---------------------------------------------------------------------------

describe("nookctl conflicts — help text", () => {
  it("renders a stable, fixed-text help banner", () => {
    const text = formatConflictHelp();
    expect(text).toContain("nookctl conflicts");
    expect(text).toContain("nookctl conflicts help");
    expect(text).toContain("nookctl conflicts list");
    expect(text).toContain("nookctl conflicts observe");
    expect(text).toContain("NOOKBRIDGE_ENABLE_LIVE_SYNC");
    for (const forbidden of ["refused", "threw", "/var/state", "PRIVATE"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("the parser recognises `help`, `--help`, and `-h` without the gate", () => {
    const parsed = parseConflictCommand(["help"], {});
    expect(parsed.kind).toBe("parsed");
    if (parsed.kind === "parsed") {
      expect(parsed.command.kind).toBe("help");
    }
    expect(parseConflictCommand(["--help"], {}).kind).toBe("parsed");
    expect(parseConflictCommand(["-h"], {}).kind).toBe("parsed");
  });

  it("the empty-argv path returns a parsed `help` and never constructs the runtime", async () => {
    let constructed = false;
    const result = await runConflictCommand({
      argv: [],
      env: {},
      createObserverRuntime: async () => {
        constructed = true;
        return {
          observer: makeFakeObserver("detecting"),
          cleanup: async () => undefined,
        };
      },
    });
    expect(constructed).toBe(false);
    expect(result.kind).toBe("help");
    if (result.kind === "help") expect(result.text).toContain("nookctl conflicts");
  });

  it("help is available even when the live-sync gate is unset", async () => {
    const result = await runConflictCommand({
      argv: ["help"],
      env: {},
      createObserverRuntime: async () => {
        throw new Error("runtime must not be constructed for help");
      },
    });
    expect(result.kind).toBe("help");
  });
});

// ---------------------------------------------------------------------------
// Gate ordering: parse → credential/body/id/revision rejection → gate →
// runtime construction → observer → cleanup.
// ---------------------------------------------------------------------------

describe("nookctl conflicts — gate ordering", () => {
  it("rejects the command when the live-sync gate is unset and never constructs the runtime", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["list"],
      env: {},
      createObserverRuntime: gate.runtime,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    if (result.kind === "error") {
      expect(result.message).toContain("NOOKBRIDGE_ENABLE_LIVE_SYNC");
    }
    expect(gate.calls).toEqual([]);
  });

  it("rejects a non-`1` gate value and never constructs the runtime", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["list"],
      env: { NOOKBRIDGE_ENABLE_LIVE_SYNC: "true" },
      createObserverRuntime: gate.runtime,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    expect(gate.calls).toEqual([]);
  });

  it("rejects malformed/unknown invocations before runtime construction", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["bogus"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    expect(gate.calls).toEqual([]);
  });

  it("rejects every forbidden credential carrier before runtime construction", async () => {
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
    ];
    for (const flag of forbidden) {
      const gate = makeObserverRuntime("detecting");
      const result = await runConflictCommand({
        argv: ["list", flag, "x"],
        env: ENABLED_ENV,
        createObserverRuntime: gate.runtime,
      });
      expect(result, flag).toMatchObject({ kind: "error", exitCode: 2 });
      if (result.kind === "error") {
        expect(result.message, flag).not.toContain(flag.slice(2));
      }
      expect(gate.calls, flag).toEqual([]);
    }
  });

  it("rejects body / file / stdin carriers before runtime construction", async () => {
    const forbidden = [
      "--content",
      "--body",
      "--markdown",
      "--fragment",
      "--text",
      "--file",
      "--content-file",
      "--stdin",
    ];
    for (const flag of forbidden) {
      const gate = makeObserverRuntime("detecting");
      const result = await runConflictCommand({
        argv: ["observe", "--title", "x", flag, "y"],
        env: ENABLED_ENV,
        createObserverRuntime: gate.runtime,
      });
      expect(result, flag).toMatchObject({ kind: "error", exitCode: 2 });
      expect(gate.calls, flag).toEqual([]);
    }
  });

  it("rejects id, revision, and other unsupported flags before runtime construction", async () => {
    const forbidden = [
      "--note-id",
      "--expect-revision",
      "--rev",
      "--id",
      "--database",
      "--raw",
      "--force",
      "--send",
      "--full",
    ];
    for (const flag of forbidden) {
      const gate = makeObserverRuntime("detecting");
      const result = await runConflictCommand({
        argv: ["list", flag, "x"],
        env: ENABLED_ENV,
        createObserverRuntime: gate.runtime,
      });
      expect(result, flag).toMatchObject({ kind: "error", exitCode: 2 });
      expect(gate.calls, flag).toEqual([]);
    }
  });

  it("rejects credential environment variables before runtime construction", async () => {
    const gate = makeObserverRuntime("detecting");
    const env = { NOOKBRIDGE_ENABLE_LIVE_SYNC: "1", NOOKBRIDGE_PASSWORD: "x" };
    const result = await runConflictCommand({
      argv: ["list"],
      env,
      createObserverRuntime: gate.runtime,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    expect(gate.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Observer behaviour: detection vs fresh fetch-only, observe-by-title vs
// observe-by-fresh-title.
// ---------------------------------------------------------------------------

describe("nookctl conflicts — list / observe outcomes", () => {
  it("returns a categorical `observed` outcome when the projection detects a marker", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result.kind).toBe("report");
    if (result.kind === "report") {
      expect(result.report).toEqual({ kind: "observed", count: 1 });
    }
    expect(gate.calls).toEqual(["createObserverRuntime", "cleanup"]);
    expect(gate.cleanupCount()).toBe(1);
  });

  it("returns a categorical `not-observed` outcome for a fresh fetch-only database", async () => {
    const gate = makeObserverRuntime("fresh");
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result.kind).toBe("report");
    if (result.kind === "report") {
      expect(result.report).toEqual({ kind: "not-observed", count: 0 });
    }
    expect(gate.calls).toEqual(["createObserverRuntime", "cleanup"]);
  });

  it("returns a categorical `observed` outcome for an exact-title match", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["observe", "--title", "Locally conflicted note"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result.kind).toBe("report");
    if (result.kind === "report") {
      expect(result.report).toEqual({ kind: "observed" });
    }
    expect(gate.calls).toEqual(["createObserverRuntime", "cleanup"]);
  });

  it("returns a categorical `not-observed` outcome for an unknown exact title", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["observe", "--title", "No such note title"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result.kind).toBe("report");
    if (result.kind === "report") {
      expect(result.report).toEqual({ kind: "not-observed" });
    }
    expect(gate.calls).toEqual(["createObserverRuntime", "cleanup"]);
  });

  it("treats a fresh fetch-only database with a matching id as `not-observed`", async () => {
    const gate = makeObserverRuntime("fresh");
    const result = await runConflictCommand({
      argv: ["observe", "--title", "title-detecting"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result.kind).toBe("report");
    if (result.kind === "report") {
      expect(result.report).toEqual({ kind: "not-observed" });
    }
    expect(gate.calls).toEqual(["createObserverRuntime", "cleanup"]);
  });
});

// ---------------------------------------------------------------------------
// Title validation: reject empty / oversized / control / ID-like titles
// without echoing caller text.
// ---------------------------------------------------------------------------

describe("nookctl conflicts — title validation", () => {
  it("rejects an empty --title", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["observe", "--title", ""],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    expect(gate.calls).toEqual([]);
  });

  it("rejects an oversized --title", async () => {
    const gate = makeObserverRuntime("detecting");
    const oversized = "x".repeat(513);
    const result = await runConflictCommand({
      argv: ["observe", "--title", oversized],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    expect(gate.calls).toEqual([]);
  });

  it("rejects a control-character --title", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["observe", "--title", "bad\u0001title"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    expect(gate.calls).toEqual([]);
  });

  it("rejects an ID-shaped --title (looks like a Notesnook note id)", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["observe", "--title", "vV0eHj6QXlf3DtSd8M4kFLk5"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    expect(gate.calls).toEqual([]);
  });

  it("rejects a --title that begins with `--`", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["observe", "--title", "--flag"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    expect(gate.calls).toEqual([]);
  });

  it("does not echo the supplied title into the error message", async () => {
    const gate = makeObserverRuntime("detecting");
    const title = "CANARY-OBSERVE-TITLE-SECRET";
    const result = await runConflictCommand({
      argv: ["observe", "--title", title],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    if (result.kind === "error") {
      expect(result.message).not.toContain(title);
      expect(result.message).not.toContain(title.slice(0, 8));
    }
  });
});

// ---------------------------------------------------------------------------
// Output boundary: never echo the supplied title, internal id, body,
// revision, path, upstream message, cause, or stack — on success OR
// failure.
// ---------------------------------------------------------------------------

describe("nookctl conflicts — output boundary (negative containment)", () => {
  const SECRET_TITLE = "CANARY TITLE LEAK 9b71";
  const SECRET_ID = "vV0eHj6QXlf3DtSd8M4kFLk5";
  const SECRET_BODY = "CANARY-BODY-LEAK-PRIVATE-CONTENT-7d11";
  const SECRET_PATH = "/var/state/nookbridge-stage5-canary";
  const SECRET_UPSTREAM = "CANARY-UPSTREAM-MESSAGE-secret-stack-trace-bd22";
  const SECRET_REVISION = "rev_0123456789abcdef0123456789abcdef";

  it("a successful observe prints only categorical text", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["observe", "--title", SECRET_TITLE],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result.kind).toBe("report");
    const text = formatConflictCommandResult(result);
    for (const forbidden of [
      SECRET_TITLE,
      SECRET_ID,
      SECRET_BODY,
      SECRET_PATH,
      SECRET_UPSTREAM,
      SECRET_REVISION,
      "Locally conflicted note",
      "conflict-note",
      "id:",
      "title:",
      "observing",
      "observing",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).toContain("observed");
  });

  it("a successful list prints only the categorical count and category", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result.kind).toBe("report");
    const text = formatConflictCommandResult(result);
    expect(text).toContain("observed");
    expect(text).toContain("1");
    for (const forbidden of [
      SECRET_TITLE,
      SECRET_ID,
      SECRET_BODY,
      SECRET_PATH,
      "Locally conflicted note",
      "conflict-note",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("a not-observed report prints only the categorical `not-observed` text", async () => {
    const gate = makeObserverRuntime("fresh");
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result.kind).toBe("report");
    const text = formatConflictCommandResult(result);
    expect(text).toContain("not-observed");
    for (const forbidden of [SECRET_TITLE, SECRET_ID, SECRET_BODY, SECRET_PATH]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("an upstream-throwing observer is mapped to a fixed categorical error without leaking secrets", async () => {
    const gate = makeObserverRuntime("fail");
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error result");
    const text = formatConflictCommandResult(result);
    for (const forbidden of [
      SECRET_UPSTREAM,
      "CANARY",
      "/var/state",
      "hunter2",
      "db.key",
      "token=",
      "stack",
      "    at ",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(gate.cleanupCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: cleanup exactly once on success AND failure; runtime must
// remain unusable after cleanup.
// ---------------------------------------------------------------------------

describe("nookctl conflicts — runtime lifecycle", () => {
  it("awaits cleanup exactly once on success", async () => {
    const gate = makeObserverRuntime("detecting");
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result.kind).toBe("report");
    expect(gate.calls.filter((c) => c === "cleanup")).toHaveLength(1);
  });

  it("awaits cleanup exactly once when the observer throws", async () => {
    const gate = makeObserverRuntime("fail");
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result.kind).toBe("error");
    expect(gate.cleanupCount()).toBe(1);
  });

  it("awaits cleanup exactly once when runtime construction throws", async () => {
    let attempts = 0;
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: async () => {
        attempts += 1;
        throw new Error("CANARY-RUNTIME-BUILD-FAILURE");
      },
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 3 });
    expect(attempts).toBe(1);
  });

  it("fails closed (exit code 3) when cleanup itself throws", async () => {
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: async () => ({
        observer: makeFakeObserver("detecting"),
        cleanup: async () => {
          throw new Error("CANARY-CLEANUP-FAILURE");
        },
      }),
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 3 });
    if (result.kind === "error") {
      expect(result.message).toContain("teardown");
      expect(result.message).not.toContain("CANARY");
    }
  });

  it("the observer returned after cleanup is unusable", async () => {
    let closed = false;
    const observer: NotesnookLocalConflictObserver = Object.freeze({
      listLocalConflicts: async () => {
        if (closed) throw new Error("observer-closed");
        return Object.freeze([]);
      },
      observeNoteConflict: async (_id: string) => {
        if (closed) throw new Error("observer-closed");
        return false as const;
      },
    });
    const runtime = await (async () => ({
      observer,
      cleanup: async () => {
        closed = true;
      },
    }))();
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: async () => runtime,
    });
    expect(result.kind).toBe("report");
    // The seam itself enforced `closed` post-cleanup; the second call
    // must surface that the capability is unusable.
    await expect(observer.listLocalConflicts()).rejects.toThrow("observer-closed");
  });
});

// ---------------------------------------------------------------------------
// No sync, no mutation: the seam must NEVER call upstream syncer,
// transport, or write surfaces.
// ---------------------------------------------------------------------------

describe("nookctl conflicts — no sync or mutation calls", () => {
  it("the observer shape only exposes read-only list / observe methods", async () => {
    const observer = makeFakeObserver("detecting");
    expect(Object.getOwnPropertyNames(observer).sort()).toEqual([
      "listLocalConflicts",
      "observeNoteConflict",
    ]);
    expect(Object.isFrozen(observer)).toBe(true);
    for (const forbidden of [
      "sync",
      "requestSync",
      "send",
      "full",
      "force",
      "delete",
      "update",
      "create",
      "database",
      "db",
      "user",
      "token",
      "kv",
      "syncer",
      "transport",
      "collection",
    ]) {
      expect(
        (observer as unknown as Record<string, unknown>)[forbidden],
        forbidden,
      ).toBeUndefined();
    }
  });

  it("does not call the live syncer or any transport tier", async () => {
    const touched: string[] = [];
    const observer: NotesnookLocalConflictObserver = Object.freeze({
      listLocalConflicts: async () => {
        touched.push("listLocalConflicts");
        return Object.freeze([]);
      },
      observeNoteConflict: async (_id: string) => {
        touched.push("observeNoteConflict");
        return false as const;
      },
    });
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: async () => ({
        observer,
        cleanup: async () => undefined,
      }),
    });
    expect(result.kind).toBe("report");
    expect(touched).toEqual(["listLocalConflicts"]);
    expect(touched).not.toContain("syncer.start");
    expect(touched).not.toContain("sync");
  });
});

// ---------------------------------------------------------------------------
// Existing command regression: the prior CLI subcommands remain reachable
// and a malformed `conflicts` invocation does not silently fall through.
// ---------------------------------------------------------------------------

describe("nookctl conflicts — existing command regression", () => {
  it("an unknown subcommand is rejected with a fixed categorical message", async () => {
    const result = await runConflictCommand({
      argv: ["resolve"],
      env: ENABLED_ENV,
      createObserverRuntime: async () => {
        throw new Error("runtime must not be constructed");
      },
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    if (result.kind === "error") {
      expect(result.message).toContain("nookctl conflicts");
      expect(result.message).toContain("unknown");
    }
  });

  it("`list` with no extra argv is the only valid no-flag form", async () => {
    const gate = makeObserverRuntime("fresh");
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result.kind).toBe("report");
  });

  it("`list --foo` is rejected before runtime construction", async () => {
    const gate = makeObserverRuntime("fresh");
    const result = await runConflictCommand({
      argv: ["list", "--foo"],
      env: ENABLED_ENV,
      createObserverRuntime: gate.runtime,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    expect(gate.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The `conflicts` tree is reachable from the CLI dispatcher itself (not
// only from `runConflictCommand` in isolation).
// ---------------------------------------------------------------------------

describe("nookctl CLI dispatcher — conflicts surface", () => {
  it("dispatches `nookctl conflicts help` without constructing any runtime", async () => {
    const mod = await import("../src/cli.js");
    const lines: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await mod.run([process.argv[0] as string, "nookctl", "conflicts", "help"]);
      expect(code).toBe(0);
      const joined = lines.join("");
      expect(joined).toContain("nookctl conflicts");
      expect(joined).toContain("NOOKBRIDGE_ENABLE_LIVE_SYNC");
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
  });

  it("dispatches `nookctl conflicts list` without the gate and never constructs the runtime", async () => {
    const mod = await import("../src/cli.js");
    const lines: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await mod.run([process.argv[0] as string, "nookctl", "conflicts", "list"]);
      expect(code).toBe(2);
      const joined = lines.join("");
      expect(joined).toContain("NOOKBRIDGE_ENABLE_LIVE_SYNC");
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
  });

  it("dispatches an unknown `conflicts` subcommand with a categorical error", async () => {
    const mod = await import("../src/cli.js");
    const lines: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await mod.run([process.argv[0] as string, "nookctl", "conflicts", "resolve"]);
      expect(code).toBe(2);
      const joined = lines.join("");
      expect(joined).toContain("nookctl conflicts");
      expect(joined).toContain("unknown");
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
  });
});

// ---------------------------------------------------------------------------
// Run-options normalisation.
// ---------------------------------------------------------------------------

describe("runConflictCommand — input normalisation", () => {
  it("returns a categorical error for non-array argv", async () => {
    const result = await runConflictCommand({
      argv: undefined as unknown as readonly string[],
      env: ENABLED_ENV,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
  });

  it("returns a categorical error for non-object env", async () => {
    const result = await runConflictCommand({
      argv: ["list"],
      env: null as unknown as Readonly<Record<string, string | undefined>>,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
  });

  it("returns a categorical error when runtime factory is missing for non-help", async () => {
    const result = await runConflictCommand({
      argv: ["list"],
      env: ENABLED_ENV,
    });
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
  });
});

// ---------------------------------------------------------------------------
// Smoke: runtime seam shape parity with the existing seams.
// ---------------------------------------------------------------------------

describe("RunConflictCommandOptions type seam", () => {
  it("accepts the documented option shape", async () => {
    const options: RunConflictCommandOptions = {
      argv: ["list"],
      env: ENABLED_ENV,
      createObserverRuntime: async () => ({
        observer: makeFakeObserver("detecting"),
        cleanup: async () => undefined,
      }),
    };
    const result = await runConflictCommand(options);
    expect(result.kind).toBe("report");
  });
});
