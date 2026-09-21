/**
 * T09 — `nookctl notes create` and the D11 title rule.
 *
 * D11 freezes the behaviour: the title comes from the **first level-1
 * heading** of the editor document, that heading is **retained** in the
 * body, and a document with no H1 fails with `invalid-input` rather than
 * the command guessing a title from a paragraph or an H2.
 *
 * The body, like `notes edit`, is edited in `$EDITOR`: it can never arrive
 * through argv, env or stdin.
 */

import { describe, expect, it, vi } from "vitest";

import {
  deriveCreateTitle,
  formatNotesHelp,
  formatNotesResult,
  parseNotesCommand,
  runNotesCommand,
  type NotesCategoricalResult,
  type NotesCommandRuntime,
} from "../src/operator/notes-cli.js";
import { createNotesCommandRuntimeFromOperatorSocket } from "../src/operator/notes-production-runtime.js";

const EMPTY_ENV: Readonly<Record<string, string | undefined>> = {};

function stubRuntime(overrides: Partial<NotesCommandRuntime> = {}): NotesCommandRuntime {
  return {
    browse: async () => ({ kind: "empty" }),
    search: async () => ({ kind: "empty" }),
    get: async () => ({ kind: "missing" }),
    edit: async () => ({ kind: "unchanged" }),
    create: async () => ({ kind: "invalid-input" }),
    operations: async () => ({ kind: "operations", handles: [] }),
    undo: async () => ({ kind: "undone" }),
    ...overrides,
  } as NotesCommandRuntime;
}

describe("notes create — parser", () => {
  it("parses the approval-gated bare form", () => {
    const parsed = parseNotesCommand(["create", "--approve-edit"], EMPTY_ENV);
    expect(parsed).toEqual({
      kind: "parsed",
      command: { kind: "create", subcommand: "create" },
    });
  });

  it("parses an optional notebook selector", () => {
    const parsed = parseNotesCommand(
      ["create", "--approve-edit", "--notebook-id", "nb_abc123"],
      EMPTY_ENV,
    );
    expect(parsed).toEqual({
      kind: "parsed",
      command: { kind: "create", subcommand: "create", notebookId: "nb_abc123" },
    });
  });

  it("requires the approval flag", () => {
    const parsed = parseNotesCommand(["create"], EMPTY_ENV);
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") throw new Error("unreachable");
    expect(parsed.message).toContain("--approve-edit");
  });

  it("rejects a duplicated approval flag", () => {
    expect(parseNotesCommand(["create", "--approve-edit", "--approve-edit"], EMPTY_ENV).kind).toBe(
      "error",
    );
  });

  it("refuses a body supplied on stdin", () => {
    const parsed = parseNotesCommand(["create", "--approve-edit", "--stdin"], EMPTY_ENV);
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") throw new Error("unreachable");
    expect(parsed.message).toContain("$EDITOR");
  });

  it("never accepts a title on argv", () => {
    expect(
      parseNotesCommand(["create", "--approve-edit", "--title", "Leaked"], EMPTY_ENV).kind,
    ).toBe("error");
  });

  it("rejects an unknown flag", () => {
    expect(
      parseNotesCommand(["create", "--approve-edit", "--handle", "h_abc"], EMPTY_ENV).kind,
    ).toBe("error");
  });

  it("rejects an oversized notebook selector", () => {
    const oversized = "n".repeat(129);
    expect(
      parseNotesCommand(["create", "--approve-edit", "--notebook-id", oversized], EMPTY_ENV).kind,
    ).toBe("error");
  });
});

describe("notes create — D11 title rule", () => {
  it("takes the title from the first level-1 heading", () => {
    expect(deriveCreateTitle("# Errand list\n\nmilk\n")).toBe("Errand list");
  });

  it("takes only the first heading when several are present", () => {
    expect(deriveCreateTitle("# First\n\n# Second\n")).toBe("First");
  });

  it("ignores a later H1 when the document starts with prose", () => {
    expect(deriveCreateTitle("intro paragraph\n\n# Later heading\n")).toBe("Later heading");
  });

  it("trims surrounding whitespace from the heading text", () => {
    expect(deriveCreateTitle("#    Padded title   \n")).toBe("Padded title");
  });

  it("does not treat an H2 as the title", () => {
    expect(deriveCreateTitle("## Section\n\nbody\n")).toBeUndefined();
  });

  it("does not treat a hash without a space as a heading", () => {
    expect(deriveCreateTitle("#nothashtag\n\nbody\n")).toBeUndefined();
  });

  it("returns undefined when there is no H1 at all", () => {
    expect(deriveCreateTitle("just prose\n\n- a list item\n")).toBeUndefined();
    expect(deriveCreateTitle("")).toBeUndefined();
  });
});

describe("notes create — runner", () => {
  it("dispatches to the runtime and reports a categorical result", async () => {
    const create = vi.fn(async (): Promise<NotesCategoricalResult> => ({ kind: "created" }));
    const result = await runNotesCommand({
      argv: ["create", "--approve-edit"],
      env: EMPTY_ENV,
      createRuntime: () => stubRuntime({ create }),
    });
    expect(result).toEqual({ kind: "created" });
    expect(create).toHaveBeenCalledWith({});
  });

  it("passes the notebook selector through", async () => {
    const create = vi.fn(async (): Promise<NotesCategoricalResult> => ({ kind: "created" }));
    await runNotesCommand({
      argv: ["create", "--approve-edit", "--notebook-id", "nb_xyz"],
      env: EMPTY_ENV,
      createRuntime: () => stubRuntime({ create }),
    });
    expect(create).toHaveBeenCalledWith({ notebookId: "nb_xyz" });
  });

  it("does not construct the runtime without the approval flag", async () => {
    const createRuntime = vi.fn(() => stubRuntime());
    const result = await runNotesCommand({
      argv: ["create"],
      env: EMPTY_ENV,
      createRuntime,
    });
    expect(result.kind).toBe("error");
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("formats the created result", () => {
    expect(formatNotesResult({ kind: "created" })).toBe("nookctl notes: created\n");
  });

  it("documents create in the help text", () => {
    const help = formatNotesHelp();
    expect(help).toContain("nookctl notes create");
    expect(help).toContain("first level-1 heading");
  });
});

describe("notes create — operator socket runtime", () => {
  type SocketClient = Parameters<typeof createNotesCommandRuntimeFromOperatorSocket>[0];

  function client(request: ReturnType<typeof vi.fn>): SocketClient {
    return { request } as unknown as SocketClient;
  }

  it("creates with the first H1 as title and keeps the heading in the body", async () => {
    const request = vi.fn(async () => ({
      ok: true as const,
      result: { kind: "create", id: "not_opaque", titleBytes: 5, contentBytes: 12 },
    }));
    const runtime = createNotesCommandRuntimeFromOperatorSocket(client(request), {
      createBody: async () => ({ kind: "edited", markdown: "# Title\n\nbody\n" }),
    });

    expect(await runtime.create({})).toEqual({ kind: "created" });
    expect(request).toHaveBeenCalledWith("notes.create", {
      title: "Title",
      content: "# Title\n\nbody\n",
    });
  });

  it("fails categorical and sends nothing when there is no H1", async () => {
    const request = vi.fn(async () => ({ ok: true as const, result: { kind: "create" } }));
    const runtime = createNotesCommandRuntimeFromOperatorSocket(client(request), {
      createBody: async () => ({ kind: "edited", markdown: "prose only\n" }),
    });

    expect(await runtime.create({})).toEqual({ kind: "invalid-input" });
    expect(request).not.toHaveBeenCalled();
  });

  it("fails categorical when the editor is refused or untouched", async () => {
    const request = vi.fn(async () => ({ ok: true as const, result: { kind: "create" } }));
    const refused = createNotesCommandRuntimeFromOperatorSocket(client(request), {
      createBody: async () => ({ kind: "refused" }),
    });
    expect((await refused.create({})).kind).toBe("error");

    const untouched = createNotesCommandRuntimeFromOperatorSocket(client(request), {
      createBody: async () => ({ kind: "unchanged" }),
    });
    expect(await untouched.create({})).toEqual({ kind: "invalid-input" });
    expect(request).not.toHaveBeenCalled();
  });

  it("maps a daemon refusal without forwarding the cause", async () => {
    const request = vi.fn(async () => ({
      ok: false as const,
      code: "invalid_request",
    }));
    const runtime = createNotesCommandRuntimeFromOperatorSocket(client(request), {
      createBody: async () => ({ kind: "edited", markdown: "# Title\n" }),
    });

    expect(await runtime.create({})).toEqual({ kind: "invalid-input" });
  });
});
