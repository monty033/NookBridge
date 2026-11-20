/**
 * #316 — `nookctl notes abandon-conflict`: the confirmation-gated client of
 * `notes.abandon-resolve`. Every refusal here must happen before the socket is used.
 */

import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli.js";
import {
  ABANDON_CONFLICT_CONFIRMATION,
  ABANDON_CONFLICT_PROMPT,
  createProductionAbandonConflictPorts,
  formatAbandonConflictHelp,
  parseAbandonConflictArgs,
  runAbandonConflict,
  type AbandonConflictPorts,
} from "../src/operator/notes-abandon-conflict-cli.js";

const HANDLE = `op_${"a".repeat(64)}`;
const RAW_NOTE_ID = "NOTE-RAW-ID-66e1";
const BODY_MARKER = "BODY-MARKER-4d20";
const DIGEST = "c".repeat(64);

const ABANDONED = {
  ok: true,
  result: {
    kind: "conflict-abandon",
    outcome: "abandoned",
    originalTitle: "Field notes",
    copyTitle: "Field notes (bridge copy)",
  },
};

function harness(overrides: Partial<AbandonConflictPorts> = {}) {
  const calls: string[] = [];
  const ports: AbandonConflictPorts = {
    interactive: true,
    confirm: async () => {
      calls.push("confirm");
      return ABANDON_CONFLICT_CONFIRMATION;
    },
    abandon: async () => {
      calls.push("abandon");
      return ABANDONED;
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

describe("parseAbandonConflictArgs", () => {
  it("accepts exactly --handle <opaque-handle>", () => {
    expect(parseAbandonConflictArgs(["--handle", HANDLE])).toEqual({
      kind: "parsed",
      handle: HANDLE,
    });
  });

  it("names the absence of a skip flag without echoing the rejected value", () => {
    const result = parseAbandonConflictArgs(["--yes", "--handle", HANDLE]);
    expect(result).toMatchObject({ kind: "error" });
    expect(JSON.stringify(result)).not.toContain("--yes");
    expect((result as { message: string }).message).toContain("no flag that skips confirmation");
  });

  it("requires a handle", () => {
    expect(parseAbandonConflictArgs([])).toMatchObject({ kind: "error" });
  });

  it("accepts the help forms", () => {
    expect(parseAbandonConflictArgs(["help"])).toEqual({ kind: "help" });
    expect(formatAbandonConflictHelp()).toContain("nookctl notes abandon-conflict --handle");
  });
});

describe("runAbandonConflict — refusals that send nothing", () => {
  it("refuses a non-interactive invocation before any prompt or socket call", async () => {
    const { calls, ports } = harness({ interactive: false });
    const io = sink();
    const code = await runAbandonConflict(["--handle", HANDLE], ports, io.writer);
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(io.text.stderr).toContain("requires an interactive terminal");
    expect(io.text.stderr).toContain("nothing was changed");
  });

  it("refuses when no confirmation seam exists, even on a terminal", async () => {
    const { calls, ports } = harness({ confirm: undefined });
    const io = sink();
    expect(await runAbandonConflict(["--handle", HANDLE], ports, io.writer)).toBe(2);
    expect(calls).toEqual([]);
  });

  it("treats anything but the exact phrase as a cancel, with no socket call", async () => {
    for (const answer of ["", "abandon", "ABANDON ", " ABANDON", "yes"]) {
      const { calls, ports } = harness({ confirm: async () => answer });
      const io = sink();
      expect(await runAbandonConflict(["--handle", HANDLE], ports, io.writer)).toBe(1);
      expect(calls).toEqual([]);
      expect(io.text.stdout).toContain("cancelled");
    }
  });

  it("cancels when the confirmation seam fails, with no socket call", async () => {
    const { calls, ports } = harness({
      confirm: async () => {
        throw new Error("closed");
      },
    });
    const io = sink();
    expect(await runAbandonConflict(["--handle", HANDLE], ports, io.writer)).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe("runAbandonConflict — happy path", () => {
  it("prompts with the exact phrase and sends the handle and phrase, with no binding", async () => {
    const abandon = async (params: unknown) => {
      expect(params).toEqual({ id: HANDLE, confirmation: ABANDON_CONFLICT_CONFIRMATION });
      return ABANDONED;
    };
    const confirm = async (prompt: string) => {
      expect(prompt).toBe(ABANDON_CONFLICT_PROMPT);
      return ABANDON_CONFLICT_CONFIRMATION;
    };
    const io = sink();
    const code = await runAbandonConflict(
      ["--handle", HANDLE],
      { interactive: true, confirm, abandon },
      io.writer,
    );
    expect(code).toBe(0);
  });

  it("prints the two titles and states nothing was uploaded", async () => {
    const { ports } = harness();
    const io = sink();
    expect(await runAbandonConflict(["--handle", HANDLE], ports, io.writer)).toBe(0);
    expect(io.text.stdout).toContain("abandoned");
    expect(io.text.stdout).toContain("original: Field notes");
    expect(io.text.stdout).toContain("copy: Field notes (bridge copy)");
    expect(io.text.stdout).toContain("uploaded: no");
    expect(io.text.stdout).toContain("inspect both notes");
  });

  it("prints no id, body, digest or path", async () => {
    const { ports } = harness({
      abandon: async () => ({
        ...ABANDONED,
        result: { ...ABANDONED.result, id: RAW_NOTE_ID, body: BODY_MARKER, digest: DIGEST },
      }),
    });
    const io = sink();
    await runAbandonConflict(["--handle", HANDLE], ports, io.writer);
    const output = io.text.stdout + io.text.stderr;
    expect(output).not.toContain(RAW_NOTE_ID);
    expect(output).not.toContain(BODY_MARKER);
    expect(output).not.toContain(DIGEST);
    expect(output).not.toContain(HANDLE);
  });

  it("withholds a title that is not displayable rather than printing it", async () => {
    const { ports } = harness({
      abandon: async () => ({
        ok: true,
        result: { ...ABANDONED.result, copyTitle: "bad\u0007title" },
      }),
    });
    const io = sink();
    expect(await runAbandonConflict(["--handle", HANDLE], ports, io.writer)).toBe(0);
    expect(io.text.stdout).toContain("titles: withheld");
    expect(io.text.stdout).not.toContain("bad");
  });
});

describe("runAbandonConflict — daemon refusals and failures", () => {
  it.each([
    ["permission_denied", "denied", 1],
    ["invalid_request", "invalid-input", 1],
    ["not_found", "missing", 1],
  ])("maps the daemon code %s to %s, exit %i", async (code, name, exit) => {
    const { ports } = harness({ abandon: async () => ({ ok: false, code }) });
    const io = sink();
    expect(await runAbandonConflict(["--handle", HANDLE], ports, io.writer)).toBe(exit);
    expect(io.text.stdout).toBe(`nookctl notes abandon-conflict: ${name}\n`);
  });

  it("reports service_unavailable for an unclassified daemon code, with no cause forwarded", async () => {
    const { ports } = harness({
      abandon: async () => ({ ok: false, code: "service_unavailable" }),
    });
    const io = sink();
    expect(await runAbandonConflict(["--handle", HANDLE], ports, io.writer)).toBe(3);
    expect(io.text.stdout).toContain("service_unavailable");
  });

  it("reports service_unavailable when the socket call throws, with no cause forwarded", async () => {
    const { ports } = harness({
      abandon: async () => {
        throw new Error("socket path /run/secret leaked");
      },
    });
    const io = sink();
    expect(await runAbandonConflict(["--handle", HANDLE], ports, io.writer)).toBe(3);
    expect(io.text.stdout + io.text.stderr).not.toContain("secret");
  });

  it("rejects an outcome other than abandoned as an invalid response", async () => {
    const { ports } = harness({
      abandon: async () => ({
        ok: true,
        result: { kind: "conflict-abandon", outcome: "resolved" },
      }),
    });
    const io = sink();
    expect(await runAbandonConflict(["--handle", HANDLE], ports, io.writer)).toBe(3);
    expect(io.text.stdout).toContain("invalid_response");
  });

  it("rejects a bare non-envelope reply as an invalid response", async () => {
    const { ports } = harness({ abandon: async () => ({ kind: "conflict-abandon" }) });
    const io = sink();
    expect(await runAbandonConflict(["--handle", HANDLE], ports, io.writer)).toBe(3);
  });
});

describe("production ports", () => {
  it("send only the handle and the phrase over the socket", async () => {
    const request = vi.fn(async () => ABANDONED);
    const ports = createProductionAbandonConflictPorts(
      { input: process.stdin, output: process.stdout },
      { request } as never,
    );
    await ports.abandon({ id: HANDLE, confirmation: ABANDON_CONFLICT_CONFIRMATION });
    expect(request).toHaveBeenCalledWith("notes.abandon-resolve", {
      id: HANDLE,
      confirmation: ABANDON_CONFLICT_CONFIRMATION,
    });
  });
});

describe("routing through nookctl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is reached from `nookctl notes abandon-conflict`, and refuses without a terminal", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await run(["node", "nookctl", "notes", "abandon-conflict", "--handle", HANDLE]);
    expect(code).toBe(2);
    const text = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("nookctl notes abandon-conflict: requires an interactive terminal");
  });
});
