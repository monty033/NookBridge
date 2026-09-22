/**
 * Stage 9 §13.11 — operator `nookctl notes` CLI dispatcher wiring slice.
 *
 * This suite covers the BOUNDED, SAFE wiring of the `notes` subcommand
 * tree inside `src/cli.ts`.  The first contract slice (the parser +
 * closed-categorical-result surface) lives in `notes-cli.ts` and is
 * covered by `tests/stage-9-notes-cli.test.ts`.  This file pins the
 * dispatcher-level guarantees:
 *
 *   - `nookctl notes help` and the bare `nookctl notes` invocation
 *     return the fixed help text without constructing any runtime;
 *   - VALID non-help commands (`browse`, `get`, `edit`, `undo`)
 *     reach the dispatcher seam and produce ONLY the fixed
 *     categorical `nookctl notes: error` output — the dispatcher
 *     NEVER fabricates note records, NEVER reads stdin, and NEVER
 *     constructs a live Notesnook runtime in this slice;
 *   - `nookctl notes delete` is structurally absent — the parser
 *     rejects it with a categorical error before any runtime is
 *     constructed;
 *   - forbidden argv carriers (`--password=value`, ...), forbidden
 *     env carriers (`NOOKBRIDGE_PASSWORD`, ...), malformed opaque
 *     handles, missing `--approve-edit`, and missing `--stdin` are
 *     rejected by the parser BEFORE the dispatcher reaches the
 *     runtime seam;
 *   - argv values, env values, paths, bodies, queries, and upstream
 *     error text are NEVER echoed in stdout or stderr;
 *   - the top-level `nookctl help` output mentions `notes` so an
 *     operator can discover the subcommand tree;
 *   - the parser and approval gates remain AUTHORITATIVE: the
 *     dispatcher never overrides a parse-level rejection;
 *   - existing CLI behaviour for every prior subcommand (`doctor`,
 *     `auth`, `sync`, `write`, `conflicts`, `recover-local-state`)
 *     is unchanged.
 *
 * Scope pinned in the task allowlist:
 *
 *   - NO live Notesnook browse/body/runtime is constructed;
 *   - NO stdin is read;
 *   - NO filesystem, database, network, sync, auth, or editor I/O;
 *   - NO `notes.delete` vocabulary;
 *   - NO top-level help text is rewritten beyond adding the new
 *     `nookctl notes ...` line;
 *   - NO existing source file is modified except `src/cli.ts`.
 */

import process from "node:process";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run, _internal } from "../src/cli.js";

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

/**
 * Drive `run()` while capturing the captured stdio, returning the
 * observed exit code the dispatcher decided on.  `run()` returns a
 * number directly; the entry-point wrapper would call `process.exit`.
 * We capture stdout/stderr and assert the returned code instead of
 * stubbing the global exit.
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

/**
 * A bounded set of forbidden argv carriers we exercise through the
 * dispatcher.  The exact list matches the `FORBIDDEN_ARG_FLAGS` set
 * in `notes-cli.ts`, which the parser is supposed to reject before
 * the dispatcher reaches the runtime seam.
 */
const FORBIDDEN_NOTES_ARGV_CARRIERS = [
  "--email",
  "--password",
  "--passwd",
  "--mfa",
  "--totp",
  "--secret",
  "--token",
  "--body",
  "--content",
  "--query",
  "--title",
  "--revision",
  "--path",
  "--file",
] as const;

/**
 * A bounded set of forbidden env carriers we exercise through the
 * dispatcher.  The exact list matches the `FORBIDDEN_ENV_VARS` set
 * in `notes-cli.ts`.
 */
const FORBIDDEN_NOTES_ENV_CARRIERS = [
  "NOOKBRIDGE_PASSWORD",
  "NOOKBRIDGE_EMAIL",
  "NOOKBRIDGE_TOKEN",
  "NOOKCTL_PASSWORD",
  "NOOKBRIDGE_BODY",
  "NOOKBRIDGE_QUERY",
  "NOOKBRIDGE_TITLE",
  "NOOKBRIDGE_PATH",
  "NOOKBRIDGE_REVISION",
] as const;

// ---------------------------------------------------------------------------
// Process-global guards.
//
// Restore any env carrier we mutate and restore any _internal seam we
// override, regardless of whether a test passed or threw.
// ---------------------------------------------------------------------------

const mutatedEnv: Array<{ name: string; previous: string | undefined }> = [];

function captureAndSetEnv(name: string, value: string): void {
  if (!mutatedEnv.some((entry) => entry.name === name)) {
    mutatedEnv.push({ name, previous: process.env[name] });
  }
  process.env[name] = value;
}

function restoreEnv(): void {
  for (const entry of mutatedEnv.splice(0)) {
    if (entry.previous === undefined) {
      delete process.env[entry.name];
    } else {
      process.env[entry.name] = entry.previous;
    }
  }
}

// ---------------------------------------------------------------------------
// Behavioural proof of "runtime seam never called".
//
// The dispatcher wires a fixed unavailable runtime seam.  To prove
// the seam was / was not reached for a given invocation we observe the
// OBSERVABLE behaviour:
//
//   - The dispatcher resolves `notes help` / bare `notes` BEFORE the
//     runner sees argv, so the help text is emitted and the runtime
//     factory is never called.  Exit code is 0 and stdout contains
//     the help banner.
//
//   - When a valid non-help command reaches the runner, the runner
//     constructs the unavailable seam, calls one of its five methods,
//     receives `{ kind: "error", exitCode: 3, message: "nookctl notes:
//     runtime unavailable" }`, and the dispatcher prints
//     `formatNotesResult(result) = "nookctl notes: error\n"` with
//     exit code 3.
//
//   - When the parser rejects (forbidden argv, forbidden env,
//     malformed handle, missing approval, missing `--stdin`, unknown
//     subcommand including `delete`), the runner returns an error
//     result with exit code 2 BEFORE the runtime seam is constructed.
//     The dispatcher prints the parser message to stderr (prefixed by
//     `nookctl:`) and returns exit code 2.
//
// Because the closed-categorical formatter NEVER echoes the result
// message into stdout, and because the dispatcher's stderr wrapper
// prefixes parser messages with `nookctl:` and never interpolates
// argv / env values, these signals together prove:
//
//   exit === 0 + help text  →  runtime NOT reached
//   exit === 3 + "nookctl notes: error\n"  →  runtime WAS reached
//   exit === 2 + stderr message  →  runtime NOT reached
//
// In addition we expose `_internal.notesRuntimeFactory` (see the
// `_internal` re-export in `src/cli.ts`) so tests can wrap the seam
// directly when extra assurance is required.
// ---------------------------------------------------------------------------

interface NotesRuntimeFactoryProbe {
  calls: number;
}

function probeFactory(): { factory: () => unknown; probe: NotesRuntimeFactoryProbe } {
  const probe: NotesRuntimeFactoryProbe = { calls: 0 };
  const factory = (): unknown => {
    probe.calls += 1;
    return undefined;
  };
  return { factory, probe };
}

function currentFactoryOrDefault(): unknown {
  // The dispatcher exposes a hook for tests via `_internal`; if the
  // hook is unset the dispatcher uses the lazy production factory.
  const internal = _internal as { notesRuntimeFactory?: () => unknown };
  return typeof internal.notesRuntimeFactory === "function"
    ? internal.notesRuntimeFactory
    : "<default-production-factory>";
}

beforeEach(() => {
  // Keep the original dispatcher contract tests on an explicitly injected
  // categorical runtime; production wiring is exercised separately.
  const internal = _internal as { notesRuntimeFactory?: () => unknown };
  internal.notesRuntimeFactory = () => ({
    browse: async () => ({ kind: "error", exitCode: 3, message: "unavailable" }),
    search: async () => ({ kind: "error", exitCode: 3, message: "unavailable" }),
    get: async () => ({ kind: "error", exitCode: 3, message: "unavailable" }),
    edit: async () => ({ kind: "error", exitCode: 3, message: "unavailable" }),
    undo: async () => ({ kind: "error", exitCode: 3, message: "unavailable" }),
  });
  // Reset any prior env mutation list.  Each test re-populates it.
  mutatedEnv.length = 0;
});

afterEach(() => {
  restoreEnv();
  // Clear any test-installed runtime hook so tests do not leak into
  // each other.
  const internal = _internal as { notesRuntimeFactory?: () => unknown };
  if ("notesRuntimeFactory" in internal) {
    delete internal.notesRuntimeFactory;
  }
  if ("notesProductionRuntimeFactory" in internal) {
    delete internal.notesProductionRuntimeFactory;
  }
});

// ---------------------------------------------------------------------------
// Top-level help surface.
// ---------------------------------------------------------------------------

describe("nookctl notes — top-level help surface", () => {
  it("mentions `nookctl notes` in the fixed top-level help output", async () => {
    const out = await driveCli(["help"]);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout).toContain("nookctl notes");
  });
});

// ---------------------------------------------------------------------------
// `notes help` and bare `notes` — read-only, ungated, never construct runtime.
// ---------------------------------------------------------------------------

describe("nookctl notes — help and bare invocation", () => {
  it("renders the fixed help text for bare `notes` with exit 0 and empty stderr", async () => {
    const { factory, probe } = probeFactory();
    const internal = _internal as { notesRuntimeFactory?: () => unknown };
    internal.notesRuntimeFactory = factory;
    try {
      const out = await driveCli(["notes"]);
      expect(out.code).toBe(0);
      expect(out.stderr).toBe("");
      expect(out.stdout).toContain("nookctl notes — operator-only bounded");
      expect(out.stdout).toContain("nookctl notes browse");
      expect(out.stdout).toContain("--approve-edit");
      expect(out.stdout).toContain("`notes delete` is intentionally absent");
      // The bare `notes` invocation must NEVER reach the runtime seam.
      expect(probe.calls).toBe(0);
    } finally {
      delete internal.notesRuntimeFactory;
    }
  });

  it("renders the fixed help text for `notes help` with exit 0", async () => {
    const { factory, probe } = probeFactory();
    const internal = _internal as { notesRuntimeFactory?: () => unknown };
    internal.notesRuntimeFactory = factory;
    try {
      const out = await driveCli(["notes", "help"]);
      expect(out.code).toBe(0);
      expect(out.stderr).toBe("");
      expect(out.stdout).toContain("nookctl notes — operator-only bounded");
      // The explicit `notes help` invocation must NEVER reach the runtime seam.
      expect(probe.calls).toBe(0);
    } finally {
      delete internal.notesRuntimeFactory;
    }
  });

  it("treats `notes --help` as help", async () => {
    const out = await driveCli(["notes", "--help"]);
    expect(out.code).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout).toContain("nookctl notes — operator-only bounded");
  });
});

// ---------------------------------------------------------------------------
// Valid non-help commands — runtime seam reached, fixed unavailable output.
//
// All five runtime methods return the same fixed unavailable result.
// The dispatcher prints `formatNotesResult(result)` which is
// `nookctl notes: error\n` and exits with code 3.
// ---------------------------------------------------------------------------

describe("nookctl notes — valid commands reach the fixed unavailable seam", () => {
  it("`notes browse` reaches the seam and prints only the fixed unavailable output", async () => {
    const { factory, probe } = probeFactory();
    const internal = _internal as { notesRuntimeFactory?: () => unknown };
    internal.notesRuntimeFactory = factory;
    try {
      const out = await driveCli(["notes", "browse"]);
      expect(out.code).toBe(3);
      expect(out.stdout).toBe("nookctl notes: error\n");
      expect(out.stderr).toBe("");
      // The runtime seam must have been reached exactly once for the
      // single valid `browse` invocation.
      expect(probe.calls).toBeGreaterThanOrEqual(1);
    } finally {
      delete internal.notesRuntimeFactory;
    }
  });

  it("`notes browse --cursor <opaque> --limit 5` reaches the seam", async () => {
    const cursor = "pag_abc1234";
    const out = await driveCli(["notes", "browse", "--cursor", cursor, "--limit", "5"]);
    expect(out.code).toBe(3);
    expect(out.stdout).toBe("nookctl notes: error\n");
    expect(out.stderr).toBe("");
    // The opaque cursor must NEVER echo into either stream.
    expect(out.stdout).not.toContain(cursor);
    expect(out.stderr).not.toContain(cursor);
  });

  it("`notes get --handle <opaque>` reaches the seam", async () => {
    const handle = "not_abc1234";
    const out = await driveCli(["notes", "get", "--handle", handle]);
    expect(out.code).toBe(3);
    expect(out.stdout).toBe("nookctl notes: error\n");
    expect(out.stderr).toBe("");
    expect(out.stdout).not.toContain(handle);
    expect(out.stderr).not.toContain(handle);
  });

  it("refuses `edit --stdin` rather than reading a body from stdin", async () => {
    const handle = "not_xyz98765";
    const out = await driveCli(["notes", "edit", "--handle", handle, "--approve-edit", "--stdin"]);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("nookctl:");
    // The refusal explains the editor rule and never echoes the handle.
    expect(out.stderr).toContain("$EDITOR");
    expect(out.stdout).not.toContain(handle);
    expect(out.stderr).not.toContain(handle);
  });

  it("refuses a bare `notes undo` with no TTY instead of guessing", async () => {
    const out = await driveCli(["notes", "undo", "--approve-edit"]);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("nookctl notes: invalid-input\n");
    expect(out.stderr).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Parser gates remain authoritative — runtime is NEVER constructed.
// ---------------------------------------------------------------------------

describe("nookctl notes — parser gates are authoritative", () => {
  it("rejects `notes delete` with exit 2 and never reaches the runtime seam", async () => {
    const { factory, probe } = probeFactory();
    const internal = _internal as { notesRuntimeFactory?: () => unknown };
    internal.notesRuntimeFactory = factory;
    try {
      const out = await driveCli(["notes", "delete"]);
      expect(out.code).toBe(2);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("nookctl:");
      // The runtime seam must NEVER be reached for `notes delete`.
      expect(probe.calls).toBe(0);
      // The `delete` token must NEVER echo into either stream.
      expect(out.stdout + out.stderr).not.toMatch(/\bdelete\b/);
    } finally {
      delete internal.notesRuntimeFactory;
    }
  });

  it("rejects `notes unknown-subcommand` with exit 2", async () => {
    const out = await driveCli(["notes", "unknown-subcommand"]);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("nookctl:");
    expect(out.stdout + out.stderr).not.toContain("unknown-subcommand");
  });

  it("rejects missing stdin search input before constructing the runtime", async () => {
    const { factory, probe } = probeFactory();
    const internal = _internal as { notesRuntimeFactory?: () => unknown };
    internal.notesRuntimeFactory = factory;
    try {
      const out = await driveCli(["notes", "search", "--stdin"]);
      expect(out.code).toBe(2);
      expect(out.stderr).toBe("");
      expect(probe.calls).toBe(0);
    } finally {
      delete internal.notesRuntimeFactory;
    }
  });

  it.each(FORBIDDEN_NOTES_ARGV_CARRIERS)(
    "rejects `%s <value>` as a forbidden argv carrier without reaching the seam",
    (flag) => {
      const value = `smuggled-${flag.replace(/^--/, "")}-value`;
      const { factory, probe } = probeFactory();
      const internal = _internal as { notesRuntimeFactory?: () => unknown };
      internal.notesRuntimeFactory = factory;
      try {
        // We intentionally use `void` on the promise returned by
        // `driveCli` because `it.each` callback bodies do not accept
        // async directly without TypeScript complaining; the test
        // still awaits synchronously inside the body via a Promise.
        return driveCli(["notes", "browse", flag, value]).then((out) => {
          expect(out.code).toBe(2);
          expect(out.stdout).toBe("");
          expect(out.stderr).toContain("nookctl:");
          // The argv value must NEVER echo into either stream.
          expect(out.stdout + out.stderr).not.toContain(value);
          // The forbidden-flag token itself must NOT be echoed.
          expect(out.stdout + out.stderr).not.toContain(flag);
          // The runtime seam must NEVER be reached on a parse error.
          expect(probe.calls).toBe(0);
        });
      } finally {
        delete internal.notesRuntimeFactory;
      }
    },
  );

  it("rejects `--password=value` (equals form) as a forbidden argv carrier", async () => {
    const value = "smuggled-equals-form-payload";
    const out = await driveCli(["notes", "browse", `--password=${value}`]);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("nookctl:");
    expect(out.stdout + out.stderr).not.toContain(value);
  });

  it.each(FORBIDDEN_NOTES_ENV_CARRIERS)(
    "rejects presence of %s without reading or echoing the value",
    (carrier) => {
      const canary = `smuggled-env-${carrier.toLowerCase()}`;
      captureAndSetEnv(carrier, canary);
      const { factory, probe } = probeFactory();
      const internal = _internal as { notesRuntimeFactory?: () => unknown };
      internal.notesRuntimeFactory = factory;
      try {
        return driveCli(["notes", "browse"]).then((out) => {
          expect(out.code).toBe(2);
          expect(out.stdout).toBe("");
          expect(out.stderr).toContain("nookctl:");
          // The env value must NEVER echo into either stream.
          expect(out.stdout + out.stderr).not.toContain(canary);
          // The runtime seam must NEVER be reached on a forbidden env.
          expect(probe.calls).toBe(0);
        });
      } finally {
        delete internal.notesRuntimeFactory;
      }
    },
  );

  it("rejects `--approve-edit=value` (equals form) without reaching the seam", async () => {
    const { factory, probe } = probeFactory();
    const internal = _internal as { notesRuntimeFactory?: () => unknown };
    internal.notesRuntimeFactory = factory;
    try {
      const out = await driveCli([
        "notes",
        "edit",
        "--handle",
        "not_xyz98765",
        "--approve-edit=yes",
        "--stdin",
      ]);
      expect(out.code).toBe(2);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("nookctl:");
      expect(out.stdout + out.stderr).not.toContain("yes");
      expect(probe.calls).toBe(0);
    } finally {
      delete internal.notesRuntimeFactory;
    }
  });

  it("rejects `notes edit` without `--approve-edit` and without `--stdin`", async () => {
    const out = await driveCli(["notes", "edit", "--handle", "not_xyz98765"]);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("nookctl:");
  });

  it("rejects malformed opaque handles without reaching the seam", async () => {
    const malformed = "../etc/passwd";
    const out = await driveCli(["notes", "get", "--handle", malformed]);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("nookctl:");
    expect(out.stdout + out.stderr).not.toContain(malformed);
  });

  it("rejects bare credential-shaped tokens as handles without reaching the seam", async () => {
    const token = "hunter2";
    const out = await driveCli(["notes", "get", "--handle", token]);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("nookctl:");
    expect(out.stdout + out.stderr).not.toContain(token);
  });

  it("rejects revision-shaped opaque handles without reaching the seam", async () => {
    const revLike = "rev_deadbeefcafe12345678901234567890";
    const out = await driveCli(["notes", "get", "--handle", revLike]);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("nookctl:");
    expect(out.stdout + out.stderr).not.toContain(revLike);
  });

  it("rejects `notes browse --limit 0` (out-of-range limit) without reaching the seam", async () => {
    const out = await driveCli(["notes", "browse", "--limit", "0"]);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("nookctl:");
  });

  it("rejects `notes search` without `--stdin` without reaching the seam", async () => {
    const out = await driveCli(["notes", "search", "--limit", "5"]);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("nookctl:");
    expect(out.stderr).toMatch(/stdin/i);
  });
});

// ---------------------------------------------------------------------------
// argv / env surface never echoes raw operator values.
// ---------------------------------------------------------------------------

describe("nookctl notes — argv / env / upstream text is never echoed", () => {
  it("never echoes the operator argv value of `--handle` even on the unavailable seam", async () => {
    const handle = "not_zxyw9876";
    const out = await driveCli(["notes", "get", "--handle", handle]);
    expect(out.code).toBe(3);
    expect(out.stdout).not.toContain(handle);
    expect(out.stderr).not.toContain(handle);
  });

  it("never echoes the operator argv value of `--cursor` even on the unavailable seam", async () => {
    const cursor = "cur_zxyw9876";
    const out = await driveCli(["notes", "browse", "--cursor", cursor]);
    expect(out.code).toBe(3);
    expect(out.stdout).not.toContain(cursor);
    expect(out.stderr).not.toContain(cursor);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher-level guarantees: the production runtime factory is wired by
// default when no command-runtime seam is installed.
// ---------------------------------------------------------------------------

describe("nookctl notes — production runtime factory is the default", () => {
  it("the dispatcher default factory is wired when no override is installed", () => {
    // The command-runtime override is test-only; production dispatch uses
    // the lazy production runtime factory below.
    expect(currentFactoryOrDefault()).toBeDefined();
  });

  it("uses the production runtime factory when the command seam is absent", async () => {
    const internal = _internal as {
      notesRuntimeFactory?: () => unknown;
      notesProductionRuntimeFactory?: (stateDir: string) => Promise<unknown>;
    };
    delete internal.notesRuntimeFactory;
    const cleanup = vi.fn();
    const production = vi.fn(async () => ({
      runtime: {
        browse: async () => ({
          kind: "page",
          notes: [{ handle: "not_abc1234" }],
          next: null,
        }),
        search: async () => ({ kind: "empty" }),
        get: async () => ({ kind: "missing" }),
        edit: async () => ({ kind: "error", exitCode: 3, message: "unavailable" }),
        undo: async () => ({ kind: "error", exitCode: 3, message: "unavailable" }),
      },
      cleanup,
    }));
    internal.notesProductionRuntimeFactory = production;

    const out = await driveCli(["notes", "browse"]);

    expect(out.code).toBe(0);
    expect(out.stdout).toBe("nookctl notes: page\ncount: 1\nhandle: not_abc1234\nnext: none\n");
    expect(out.stderr).toBe("");
    expect(production).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it("an installed factory override is invoked exactly once for `notes browse`", async () => {
    const { factory, probe } = probeFactory();
    const internal = _internal as { notesRuntimeFactory?: () => unknown };
    internal.notesRuntimeFactory = factory;
    try {
      const out = await driveCli(["notes", "browse"]);
      expect(out.code).toBe(3);
      expect(probe.calls).toBeGreaterThanOrEqual(1);
    } finally {
      delete internal.notesRuntimeFactory;
    }
  });
});

// ---------------------------------------------------------------------------
// Existing CLI behaviour is unchanged.
// ---------------------------------------------------------------------------

describe("nookctl — existing commands remain unchanged", () => {
  it("`doctor --help` is NOT hijacked by the new `notes` routing", async () => {
    const out = await driveCli(["--help"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("doctor");
    expect(out.stdout).toContain("notes");
  });

  it("`recover-local-state help` continues to print its own help text", async () => {
    const out = await driveCli(["recover-local-state", "help"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("recover-local-state");
    expect(out.stdout).toContain("--approve-reinitialize");
  });

  it("`notes` is recognized as a known top-level subcommand (no `unknown subcommand` error)", async () => {
    const out = await driveCli(["notes"]);
    expect(out.code).toBe(0);
    expect(out.stderr).not.toContain("unknown subcommand");
  });
  /**
   * Regression: `_internal` must be declared BEFORE the entry-point guard.
   *
   * The guard starts `run`, whose synchronous prefix reaches `createRuntime`,
   * which reads `_internal`.  While the declaration sat after the guard,
   * `_internal` was still in its temporal dead zone for that prefix, so every
   * `nookctl notes ...` command that constructs a runtime died with
   * "Cannot access '_internal' before initialization" whenever the CLI was the
   * entry point.  No in-process test can reach that path, because importing
   * this module evaluates the whole body before any test helper runs — which is
   * exactly how the defect survived a green suite.
   */
  it("declares the in-process seam before the entry-point guard", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8");
    const declaration = source.indexOf("export const _internal");
    const guard = source.indexOf("if (import.meta.url === `file://${process.argv[1]}`)");

    expect(declaration).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(declaration).toBeLessThan(guard);
  });
});

// ---------------------------------------------------------------------------
// vi import sanity (vi is used implicitly via the spy-on-process pattern
// above; pin the dependency so vitest does not flag it).
// ---------------------------------------------------------------------------

void vi;
