/**
 * Stage 5 slice C — operator `nookctl notes resolve-conflict <handle>`.
 *
 * Pins the operator CLI contract for the keep-both resolve:
 *
 *   - the parser accepts exactly `--handle <opaque-handle>` (plus help);
 *     there is no flag that skips confirmation;
 *   - a non-interactive invocation refuses before any inspection, prompt or
 *     socket call;
 *   - the Stage 0 side facts and the binding are printed BEFORE the typed
 *     confirmation, and the resolve is sent only after the exact phrase;
 *   - a refusal or cancel performs zero resolve calls;
 *   - no id, body, path, or digest other than the binding is ever printed.
 */

import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli.js";
import {
  RESOLVE_CONFLICT_CONFIRMATION,
  RESOLVE_CONFLICT_PROMPT,
  createProductionResolveConflictPorts,
  formatResolveConflictHelp,
  parseResolveConflictArgs,
  runResolveConflict,
  type ResolveConflictPorts,
} from "../src/operator/notes-resolve-conflict-cli.js";

const HANDLE = `op_${"a".repeat(64)}`;
const BINDING = "b".repeat(64);
const LOCAL_BODY_MARKER = "LOCAL-BODY-MARKER-7f3a";
const REMOTE_BODY_MARKER = "REMOTE-BODY-MARKER-91c2";
const RAW_NOTE_ID = "NOTE-RAW-ID-55d0";

/** A `notes.inspect-conflict` success envelope around the given closed result fields. */
function inspectionEnvelope(result: Record<string, unknown>): unknown {
  return { id: "inspect-1", ok: true, result: { kind: "conflict-inspection", ...result } };
}

/**
 * The inspected envelope.  Each side also carries a body marker and a raw id,
 * which the daemon never sends, so a test can prove the CLI drops them.
 */
function inspectedReport(overrides: Record<string, unknown> = {}): unknown {
  return inspectionEnvelope({
    outcome: "inspected",
    local: {
      present: true,
      unlocked: true,
      tiptap: true,
      byteSize: 42,
      text: LOCAL_BODY_MARKER,
      id: RAW_NOTE_ID,
    },
    remote: {
      present: true,
      unlocked: true,
      tiptap: true,
      byteSize: 57,
      text: REMOTE_BODY_MARKER,
      id: RAW_NOTE_ID,
    },
    sidesEqual: false,
    remoteHasAttachments: false,
    binding: BINDING,
    ...overrides,
  });
}

const RESOLVED = {
  ok: true,
  result: {
    kind: "conflict-resolve",
    outcome: "resolved",
    originalTitle: "Trip notes",
    copyTitle: "Trip notes (conflict copy)",
  },
};

/**
 * A full set of ports that records every call in order.  Each test replaces
 * only the port it is exercising.
 */
function harness(overrides: Partial<ResolveConflictPorts> = {}) {
  const calls: string[] = [];
  const ports: ResolveConflictPorts = {
    interactive: true,
    inspect: async () => {
      calls.push("inspect");
      return inspectedReport();
    },
    confirm: async () => {
      calls.push("confirm");
      return RESOLVE_CONFLICT_CONFIRMATION;
    },
    resolve: async () => {
      calls.push("resolve");
      return RESOLVED;
    },
    ...overrides,
  };
  return { calls, ports };
}

function sink() {
  const text = { stdout: "", stderr: "" };
  return {
    text,
    writer: {
      stdout: (chunk: string) => {
        text.stdout += chunk;
      },
      stderr: (chunk: string) => {
        text.stderr += chunk;
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseResolveConflictArgs", () => {
  it("accepts exactly --handle <opaque-handle>", () => {
    expect(parseResolveConflictArgs(["--handle", HANDLE])).toEqual({
      kind: "parsed",
      handle: HANDLE,
    });
  });

  it("accepts the help forms", () => {
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      expect(parseResolveConflictArgs(argv)).toEqual({ kind: "help" });
    }
  });

  it.each([
    ["no arguments", []],
    ["a bare positional handle", [HANDLE]],
    ["--yes", ["--handle", HANDLE, "--yes"]],
    ["--force", ["--handle", HANDLE, "--force"]],
    ["--approve-edit", ["--handle", HANDLE, "--approve-edit"]],
    ["--stdin", ["--handle", HANDLE, "--stdin"]],
    ["the =value form", [`--handle=${HANDLE}`]],
    ["a duplicate --handle", ["--handle", HANDLE, "--handle", HANDLE]],
    ["a flag-shaped handle", ["--handle", "--yes"]],
    ["a malformed handle", ["--handle", "not a handle"]],
    ["an extra positional", ["--handle", HANDLE, "extra"]],
  ])("refuses %s", (_label, argv) => {
    const parsed = parseResolveConflictArgs(argv);
    expect(parsed.kind).toBe("error");
  });

  it("names the absence of a confirmation skip without echoing the rejected value", () => {
    const parsed = parseResolveConflictArgs(["--handle", HANDLE, "--yes"]);
    expect(parsed).toMatchObject({ kind: "error" });
    const message = (parsed as { message: string }).message;
    expect(message).toContain("there is no flag that skips confirmation");
    expect(message).not.toContain("--yes");
    expect(message).not.toContain(HANDLE);
  });
});

describe("runResolveConflict — refusals that write nothing", () => {
  it("refuses a non-interactive invocation before any inspection, prompt or resolve", async () => {
    const { calls, ports } = harness({ interactive: false });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(io.text.stderr).toContain("requires an interactive terminal");
    expect(io.text.stderr).toContain("nothing was changed");
  });

  it("refuses when no confirmation seam exists, even on a terminal", async () => {
    const { calls, ports } = harness({ confirm: undefined });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(2);
    expect(calls).toEqual([]);
  });

  it("refuses with exit 3 and no writes when no inspection source is wired", async () => {
    const { calls, ports } = harness({ inspect: undefined });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(3);
    expect(calls).toEqual([]);
    expect(io.text.stderr).toContain("inspection unavailable");
    expect(io.text.stderr).toContain("nothing was changed");
  });

  it.each(["not-conflicted", "not-found"])(
    "stops at a %s inspection without confirming or resolving",
    async (outcome) => {
      const { calls, ports } = harness({
        inspect: async () => {
          calls.push("inspect");
          return inspectionEnvelope({ outcome });
        },
      });
      const io = sink();
      const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
      expect(code).toBe(1);
      expect(calls).toEqual(["inspect"]);
      expect(io.text.stdout).toBe(`nookctl notes resolve-conflict: ${outcome}\n`);
    },
  );

  it("stops at an unreadable inspection and prints only the side facts", async () => {
    const { calls, ports } = harness({
      inspect: async () => {
        calls.push("inspect");
        return inspectionEnvelope({
          outcome: "unreadable",
          local: { present: true, unlocked: false, tiptap: false, byteSize: null },
          remote: { present: true, unlocked: true, tiptap: true, byteSize: 57 },
        });
      },
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(1);
    expect(calls).toEqual(["inspect"]);
    expect(io.text.stdout).toBe(
      [
        "nookctl notes resolve-conflict: unreadable",
        "local-side: locked, other, no text",
        "remote-side: unlocked, tiptap, 57 bytes",
        "",
      ].join("\n"),
    );
  });

  it("rejects a bare Stage 0 report that is not the daemon envelope as an invalid response", async () => {
    const { calls, ports } = harness({
      inspect: async () => {
        calls.push("inspect");
        return {
          kind: "inspected",
          binding: BINDING,
          sidesEqual: false,
          remoteHasAttachments: false,
        };
      },
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(3);
    expect(calls).toEqual(["inspect"]);
    expect(io.text.stderr).toContain("invalid_response");
  });

  it.each([
    ["not_found", "missing"],
    ["vault_locked", "locked"],
    ["permission_denied", "denied"],
  ])("maps an inspection socket refusal %s to exit 1 as %s", async (code, name) => {
    const { calls, ports } = harness({
      inspect: async () => {
        calls.push("inspect");
        return { ok: false, code };
      },
    });
    const io = sink();
    const exit = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(exit).toBe(1);
    expect(calls).toEqual(["inspect"]);
    expect(io.text.stdout).toBe(`nookctl notes resolve-conflict: ${name}\n`);
  });

  it("treats an uncategorised inspection failure as an unavailable service with exit 3", async () => {
    const { calls, ports } = harness({
      inspect: async () => {
        calls.push("inspect");
        return { ok: false, code: "service_unavailable" };
      },
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(3);
    expect(calls).toEqual(["inspect"]);
    expect(io.text.stderr).toContain("service_unavailable");
  });

  it("treats a rejected inspect call as an unavailable service, with no cause forwarded", async () => {
    const { calls, ports } = harness({
      inspect: async () => {
        calls.push("inspect");
        throw new Error("socket closed");
      },
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(3);
    expect(calls).toEqual(["inspect"]);
    expect(io.text.stdout + io.text.stderr).not.toContain("socket closed");
  });

  it("treats an empty answer as a cancel and performs no resolve", async () => {
    const { calls, ports } = harness({
      confirm: async () => {
        calls.push("confirm");
        return "";
      },
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(1);
    expect(calls).toEqual(["inspect", "confirm"]);
    expect(io.text.stdout.endsWith("nookctl notes resolve-conflict: cancelled\n")).toBe(true);
  });

  it.each(["yes", "y", "keep both", "KEEP BOTH ", "keep-both"])(
    "requires the exact phrase and cancels on %j",
    async (answer) => {
      const { calls, ports } = harness({
        confirm: async () => {
          calls.push("confirm");
          return answer;
        },
      });
      const io = sink();
      const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
      expect(code).toBe(1);
      expect(calls).not.toContain("resolve");
    },
  );

  it("cancels when the confirmation seam fails, with no resolve", async () => {
    const { calls, ports } = harness({
      confirm: async () => {
        calls.push("confirm");
        throw new Error("stdin closed");
      },
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(1);
    expect(calls).toEqual(["inspect", "confirm"]);
  });

  it("refuses a malformed binding before any confirmation or resolve", async () => {
    const { calls, ports } = harness({
      inspect: async () => {
        calls.push("inspect");
        return inspectedReport({ binding: "not-hex" });
      },
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(3);
    expect(calls).toEqual(["inspect"]);
  });
});

describe("runResolveConflict — happy path", () => {
  it("prints the side facts and binding before asking for confirmation", async () => {
    const { calls, ports } = harness();
    const io = sink();
    await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(calls).toEqual(["inspect", "confirm", "resolve"]);
    expect(io.text.stdout.startsWith("nookctl notes resolve-conflict: inspected\n")).toBe(true);
    expect(io.text.stdout).toContain("local-side: unlocked, tiptap, 42 bytes\n");
    expect(io.text.stdout).toContain("remote-side: unlocked, tiptap, 57 bytes\n");
    expect(io.text.stdout).toContain("sides-equal: no\n");
    expect(io.text.stdout).toContain("remote-has-attachments: no\n");
    expect(io.text.stdout).toContain(`binding: ${BINDING}\n`);
  });

  it("sends exactly the opaque handle and the reviewed binding to the resolve", async () => {
    const resolve = vi.fn(async () => RESOLVED);
    const { ports } = harness({ resolve });
    await runResolveConflict(["--handle", HANDLE], ports, sink().writer);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ id: HANDLE, binding: BINDING });
  });

  it("prints the categorical outcome and both titles, and states nothing was uploaded", async () => {
    const { ports } = harness();
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(0);
    expect(
      io.text.stdout.endsWith(
        [
          "nookctl notes resolve-conflict: resolved",
          "original: Trip notes",
          "copy: Trip notes (conflict copy)",
          "uploaded: no",
          "",
        ].join("\n"),
      ),
    ).toBe(true);
  });

  it("does not offer a sync or upload command in its output", async () => {
    const { ports } = harness();
    const io = sink();
    await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    const output = io.text.stdout + io.text.stderr;
    expect(output).not.toContain("approve-upload");
    expect(output).not.toContain("sync");
    expect(output).not.toContain("--yes");
  });

  it("prints no id, body, path or digest other than the binding", async () => {
    const { ports } = harness();
    const io = sink();
    await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    const output = io.text.stdout + io.text.stderr;
    for (const forbidden of [
      LOCAL_BODY_MARKER,
      REMOTE_BODY_MARKER,
      RAW_NOTE_ID,
      HANDLE,
      "/var/",
      "/run/",
      "sha256",
    ]) {
      expect(output).not.toContain(forbidden);
    }
    // The only 64-hex token printed is the binding the operator confirmed.
    const hexTokens = output.match(/[0-9a-f]{64}/g) ?? [];
    expect(hexTokens).toEqual([BINDING]);
  });

  it("withholds titles that are not displayable rather than printing them", async () => {
    const { ports } = harness({
      resolve: async () => ({
        ok: true,
        result: {
          kind: "conflict-resolve",
          outcome: "resolved",
          originalTitle: "Trip\nnotes: forged",
          copyTitle: "copy",
        },
      }),
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(0);
    expect(io.text.stdout).toContain("nookctl notes resolve-conflict: resolved\n");
    expect(io.text.stdout).toContain("titles: withheld\n");
    expect(io.text.stdout).not.toContain("forged");
  });
});

describe("runResolveConflict — daemon refusals", () => {
  it("reports stale_revision with whether a copy was created, and exits non-zero", async () => {
    const { ports } = harness({
      resolve: async () => ({
        ok: true,
        result: { kind: "conflict-resolve", outcome: "stale_revision", copyCreated: true },
      }),
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(1);
    expect(
      io.text.stdout.endsWith(
        "nookctl notes resolve-conflict: stale_revision\ncopy-created: yes\n",
      ),
    ).toBe(true);
  });

  it.each([
    "not-conflicted",
    "not-found",
    "vault_locked",
    "unsupported_content",
    "read_failed",
    "copy_failed",
    "copy_unverified",
    "relation_failed",
    "content_write_failed",
    "resolved_flag_pending",
    "post_write_unverified",
  ])("reports the closed outcome %s and exits non-zero", async (outcome) => {
    const { ports } = harness({
      resolve: async () => ({
        ok: true,
        result: { kind: "conflict-resolve", outcome },
      }),
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(1);
    expect(io.text.stdout.endsWith(`nookctl notes resolve-conflict: ${outcome}\n`)).toBe(true);
    expect(io.text.stdout).not.toContain("original:");
  });

  it("rejects an outcome outside the closed list as an invalid response", async () => {
    const { ports } = harness({
      resolve: async () => ({
        ok: true,
        result: { kind: "conflict-resolve", outcome: "something-new" },
      }),
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(3);
    expect(io.text.stdout).not.toContain("something-new");
  });

  it("maps a socket service outage to exit 3 without forwarding a cause", async () => {
    const { ports } = harness({
      resolve: async () => ({ ok: false, code: "service_unavailable" }),
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(3);
    expect(io.text.stdout + io.text.stderr).toContain("service_unavailable");
  });

  it("maps a socket refusal to exit 1 with its categorical name", async () => {
    const { ports } = harness({
      resolve: async () => ({ ok: false, code: "permission_denied" }),
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(1);
    expect(io.text.stdout).toContain("nookctl notes resolve-conflict: denied\n");
  });

  it("treats a rejected resolve call as an unavailable service", async () => {
    const { ports } = harness({
      resolve: async () => {
        throw new Error("socket closed");
      },
    });
    const io = sink();
    const code = await runResolveConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(3);
    expect(io.text.stdout + io.text.stderr).not.toContain("socket closed");
  });
});

describe("resolve-conflict help", () => {
  it("states that the command does not sync or upload and names the approve-upload path", () => {
    const help = formatResolveConflictHelp();
    expect(help).toContain("does not sync or upload");
    expect(help).toContain("approve-upload");
    expect(help).toContain("nookctl notes resolve-conflict --handle <opaque-handle>");
    expect(help).not.toMatch(/--yes|--force/);
  });

  it("documents the typed confirmation phrase", () => {
    expect(formatResolveConflictHelp()).toContain(`type ${RESOLVE_CONFLICT_CONFIRMATION}`);
  });
});

describe("production ports", () => {
  const streams = { input: process.stdin, output: process.stdout };

  it("wires inspect and resolve over the operator socket client, with no database", () => {
    const client = { request: vi.fn(async () => RESOLVED) };
    const ports = createProductionResolveConflictPorts(streams, client as never);
    expect(typeof ports.inspect).toBe("function");
    expect(typeof ports.resolve).toBe("function");
    expect(typeof ports.confirm).toBe("function");
    expect(RESOLVE_CONFLICT_PROMPT).toContain(RESOLVE_CONFLICT_CONFIRMATION);
  });

  it("sends inspect by handle alone and resolve by handle and binding only", async () => {
    const request = vi.fn(async () => RESOLVED);
    const ports = createProductionResolveConflictPorts(streams, { request } as never);
    await ports.inspect?.(HANDLE);
    await ports.resolve({ id: HANDLE, binding: BINDING });
    expect(request).toHaveBeenNthCalledWith(1, "notes.inspect-conflict", { id: HANDLE });
    expect(request).toHaveBeenNthCalledWith(2, "notes.resolve-conflict", {
      id: HANDLE,
      binding: BINDING,
    });
  });

  it("runs inspect, confirm and resolve end to end through the socket client", async () => {
    // The fake socket answers the inspection with the envelope and the resolve
    // with the closed success.  The binding that reaches the resolve must be the
    // one the operator was shown.
    const request = vi.fn(async (method: string) =>
      method === "notes.inspect-conflict" ? inspectedReport() : RESOLVED,
    );
    const ports = createProductionResolveConflictPorts(streams, { request } as never);
    const confirm = vi.fn(async () => RESOLVE_CONFLICT_CONFIRMATION);
    const io = sink();
    const code = await runResolveConflict(
      ["--handle", HANDLE],
      { ...ports, interactive: true, confirm },
      io.writer,
    );
    expect(code).toBe(0);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "notes.inspect-conflict",
      "notes.resolve-conflict",
    ]);
    expect(request).toHaveBeenLastCalledWith("notes.resolve-conflict", {
      id: HANDLE,
      binding: BINDING,
    });
    expect(io.text.stdout).not.toContain(LOCAL_BODY_MARKER);
    expect(io.text.stdout).not.toContain(REMOTE_BODY_MARKER);
    expect(io.text.stdout).not.toContain(RAW_NOTE_ID);
  });
});

describe("nookctl notes resolve-conflict at the CLI entry point", () => {
  it("refuses --yes with exit 2 and no confirmation skip", async () => {
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    let code: number;
    try {
      code = await run([
        "node",
        "nookctl",
        "notes",
        "resolve-conflict",
        "--handle",
        HANDLE,
        "--yes",
      ]);
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("there is no flag that skips confirmation");
  });
});
