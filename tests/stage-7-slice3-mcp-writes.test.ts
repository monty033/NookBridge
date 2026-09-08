/**
 * Stage 7 Slice 3 — bounded MCP write surface.
 *
 * This test is intentionally limited to the MCP boundary. Service/runtime
 * authorization and the framed protocol are covered by the existing Slice 3
 * tests; these cases prove only the seven-tool MCP surface and its typed
 * socket-client projection/error seam.
 */

import { describe, expect, it, vi } from "vitest";

import {
  FORBIDDEN_TOOL_NAMES,
  NOOK_MCP_ALLOWED_TOOL_NAMES,
  buildNookMcpServer,
} from "../src/mcp/nook-mcp-server.js";
import { NookdSocketClient } from "../src/mcp/socket-client.js";

const REVISION = "rev_00000000000000000000000000000001";

type ToolResult = Awaited<ReturnType<ReturnType<typeof buildNookMcpServer>["callTool"]>>;

type CreateClient = NookdSocketClient & {
  createNote: (params: { title: string; content: string; notebookId?: string }) => Promise<unknown>;
};

function makeClient(): CreateClient {
  const client = new NookdSocketClient({
    socketPath: "/tmp/nook-mcp-slice3-never-used.sock",
    connect: async () => {
      throw new Error("socket must not be touched by this test");
    },
  }) as CreateClient;
  Object.defineProperty(client, "createNote", {
    configurable: true,
    value: vi.fn(),
  });
  return client;
}

function payload(result: ToolResult): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  if (block?.type !== "text") throw new Error("missing text result");
  return JSON.parse(block.text) as Record<string, unknown>;
}

function schemaFor(name: string): Record<string, unknown> {
  const client = makeClient();
  const tool = buildNookMcpServer({ client }).tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool.inputSchema as Record<string, unknown>;
}

describe("Stage 7 Slice 3 — bounded MCP write surface", () => {
  it("registers the four reads plus exactly create, append, and update", () => {
    const client = makeClient();
    const server = buildNookMcpServer({ client });

    expect(NOOK_MCP_ALLOWED_TOOL_NAMES).toEqual([
      "notesnook_search_notes",
      "notesnook_status",
      "notesnook_list_notebooks",
      "notesnook_get_note",
      "notesnook_create_note",
      "notesnook_append_note",
      "notesnook_update_note",
      "notesnook_delete_note",
      "notesnook_sync",
    ]);
    expect(server.tools.map((tool) => tool.name)).toEqual(NOOK_MCP_ALLOWED_TOOL_NAMES);
    expect(server.tools).toHaveLength(9);
    expect(server.tools.map((tool) => tool.name)).toContain("notesnook_delete_note");
    expect(FORBIDDEN_TOOL_NAMES).not.toContain("notesnook_delete_note");
  });

  it("advertises closed bounded schemas for all three writes", () => {
    expect(schemaFor("notesnook_create_note")).toMatchObject({
      type: "object",
      required: ["title", "content"],
      additionalProperties: false,
    });
    expect(schemaFor("notesnook_create_note").properties).toEqual({
      title: expect.objectContaining({ type: "string", minLength: 1 }),
      content: expect.objectContaining({ type: "string", minLength: 1 }),
      notebookId: expect.objectContaining({ type: "string", minLength: 1 }),
    });

    expect(schemaFor("notesnook_append_note")).toMatchObject({
      type: "object",
      required: ["id", "markdownFragment", "expectedRevision"],
      additionalProperties: false,
    });
    expect(Object.keys(schemaFor("notesnook_append_note").properties as object).sort()).toEqual([
      "expectedRevision",
      "id",
      "markdownFragment",
    ]);

    expect(schemaFor("notesnook_update_note")).toMatchObject({
      type: "object",
      required: ["id", "expectedRevision", "patch"],
      additionalProperties: false,
    });
    const updateProperties = schemaFor("notesnook_update_note").properties as Record<
      string,
      unknown
    >;
    expect(Object.keys(updateProperties).sort()).toEqual(["expectedRevision", "id", "patch"]);
    expect(updateProperties.patch).toEqual(
      expect.objectContaining({
        type: "object",
        additionalProperties: false,
        minProperties: 1,
      }),
    );
    expect(
      Object.keys((updateProperties.patch as Record<string, unknown>).properties as object).sort(),
    ).toEqual(["content", "favorite", "notebookId", "pinned", "tags", "title"]);
  });

  it("returns the opaque revision from bounded note metadata", async () => {
    const client = makeClient();
    Object.defineProperty(client, "getNote", {
      configurable: true,
      value: vi.fn().mockResolvedValue({
        ok: true,
        envelope: {
          id: "rpc-get-1",
          ok: true,
          result: {
            kind: "note",
            note: { id: "note-1", title: "Title", revision: REVISION },
          },
        },
      }),
    });
    const server = buildNookMcpServer({ client });

    const result = await server.callTool("notesnook_get_note", { id: "note-1" });

    expect(result.isError).toBeFalsy();
    expect(payload(result)).toEqual({
      kind: "note",
      note: { id: "note-1", title: "Title", revision: REVISION },
    });
  });

  it("calls typed write methods and projects only safe bounded results", async () => {
    const client = makeClient();
    const createNote = client.createNote as ReturnType<typeof vi.fn>;
    createNote.mockResolvedValue({
      ok: true,
      envelope: {
        id: "rpc-1",
        ok: true,
        result: {
          kind: "create",
          id: "note-1",
          titleBytes: 5,
          contentBytes: 4,
          localCommitted: true,
          body: "secret",
        },
      },
    });
    const appendNote = vi.spyOn(client, "appendNote").mockResolvedValue({
      ok: true,
      envelope: {
        id: "rpc-2",
        ok: true,
        result: { kind: "append", id: "note-1", fragmentBytes: 4 },
      },
    });
    const updateNote = vi.spyOn(client, "updateNote").mockResolvedValue({
      ok: true,
      envelope: {
        id: "rpc-3",
        ok: true,
        result: { kind: "update", id: "note-1", appliedFields: ["title"], contentBytes: 8 },
      },
    });
    const server = buildNookMcpServer({ client });

    const create = await server.callTool("notesnook_create_note", {
      title: "Title",
      content: "Body",
      notebookId: "nb-1",
    });
    const append = await server.callTool("notesnook_append_note", {
      id: "note-1",
      markdownFragment: "frag",
      expectedRevision: REVISION,
    });
    const update = await server.callTool("notesnook_update_note", {
      id: "note-1",
      expectedRevision: REVISION,
      patch: { title: "New title" },
    });

    expect(create.isError).toBeFalsy();
    expect(payload(create)).toEqual({
      kind: "create",
      id: "note-1",
      titleBytes: 5,
      contentBytes: 4,
    });
    expect(append.isError).toBeFalsy();
    expect(payload(append)).toEqual({ kind: "append", id: "note-1", fragmentBytes: 4 });
    expect(update.isError).toBeFalsy();
    expect(payload(update)).toEqual({
      kind: "update",
      id: "note-1",
      appliedFields: ["title"],
      contentBytes: 8,
    });
    expect(JSON.stringify(create)).not.toContain("secret");
    expect(createNote).toHaveBeenCalledWith({
      title: "Title",
      content: "Body",
      notebookId: "nb-1",
    });
    expect(appendNote).toHaveBeenCalledWith({
      id: "note-1",
      markdownFragment: "frag",
      expectedRevision: REVISION,
    });
    expect(updateNote).toHaveBeenCalledWith({
      id: "note-1",
      expectedRevision: REVISION,
      patch: { title: "New title" },
    });
  });

  it("rejects malformed write inputs before invoking the socket client", async () => {
    const client = makeClient();
    const createNote = client.createNote as ReturnType<typeof vi.fn>;
    const appendNote = vi.spyOn(client, "appendNote");
    const updateNote = vi.spyOn(client, "updateNote");
    const server = buildNookMcpServer({ client });

    const cases: Array<[string, Record<string, unknown>]> = [
      ["notesnook_create_note", { title: "Title", content: "Body", extra: true }],
      ["notesnook_create_note", { title: "", content: "Body" }],
      [
        "notesnook_append_note",
        { id: "note-1", markdownFragment: "frag", expectedRevision: "bad" },
      ],
      ["notesnook_append_note", { id: "note-1", markdownFragment: "", expectedRevision: REVISION }],
      ["notesnook_update_note", { id: "note-1", expectedRevision: REVISION, patch: {} }],
      [
        "notesnook_update_note",
        { id: "note-1", expectedRevision: REVISION, patch: { deleted: true } },
      ],
      ["notesnook_update_note", { id: "note-1", expectedRevision: REVISION, patch: { title: "" } }],
      // Disallowed control character inside an append fragment must still fail closed.
      [
        "notesnook_append_note",
        { id: "note-1", markdownFragment: "frag\u0000bad", expectedRevision: REVISION },
      ],
    ];
    for (const [name, args] of cases) {
      const result = await server.callTool(name, args);
      expect(result.isError).toBe(true);
      expect(payload(result)).toEqual({ code: "invalid_request", message: "Invalid request" });
    }
    expect(createNote).not.toHaveBeenCalled();
    expect(appendNote).not.toHaveBeenCalled();
    expect(updateNote).not.toHaveBeenCalled();
  });

  it("permits structural whitespace in append fragments while still rejecting other control bytes", async () => {
    const client = makeClient();
    const appendNote = vi.spyOn(client, "appendNote");
    appendNote.mockResolvedValue({
      ok: true,
      envelope: {
        id: "rpc-1",
        ok: true,
        result: { kind: "append", id: "note-1", fragmentBytes: 11 },
      },
    });
    const server = buildNookMcpServer({ client });

    const allowed: string[] = ["\nBounded append.", "line1\r\nline2", "col1\tcol2"];
    for (const markdownFragment of allowed) {
      const result = await server.callTool("notesnook_append_note", {
        id: "note-1",
        markdownFragment,
        expectedRevision: REVISION,
      });
      expect(result.isError).toBeFalsy();
      expect(appendNote).toHaveBeenLastCalledWith({
        id: "note-1",
        markdownFragment,
        expectedRevision: REVISION,
      });
    }

    const blocked: string[] = ["frag\u0000null", "frag\u0007bell", "frag\u001bescape"];
    for (const markdownFragment of blocked) {
      const result = await server.callTool("notesnook_append_note", {
        id: "note-1",
        markdownFragment,
        expectedRevision: REVISION,
      });
      expect(result.isError).toBe(true);
      expect(payload(result)).toEqual({ code: "invalid_request", message: "Invalid request" });
    }
  });

  it("maps socket failures safely and fails closed on malformed envelopes", async () => {
    const client = makeClient();
    const appendNote = vi.spyOn(client, "appendNote");
    const updateNote = vi.spyOn(client, "updateNote");
    const createNote = client.createNote as ReturnType<typeof vi.fn>;
    const server = buildNookMcpServer({ client });

    appendNote.mockResolvedValue({ ok: false, code: "stale_revision" });
    const stale = await server.callTool("notesnook_append_note", {
      id: "note-1",
      markdownFragment: "frag",
      expectedRevision: REVISION,
    });
    expect(stale.isError).toBe(true);
    // PR-64 P1-6 — closed vocabulary: `stale_revision` is no longer
    // collapsed into `service_unavailable` at the MCP boundary.
    expect(payload(stale)).toEqual({ code: "stale_revision", message: "Stale revision" });

    updateNote.mockResolvedValue({
      ok: true,
      envelope: { id: "rpc-4", ok: true, result: { kind: "update", id: "note-1" } },
    } as never);
    const malformed = await server.callTool("notesnook_update_note", {
      id: "note-1",
      expectedRevision: REVISION,
      patch: { pinned: true },
    });
    expect(malformed.isError).toBe(true);
    expect(payload(malformed)).toEqual({
      code: "service_unavailable",
      message: "Service unavailable",
    });

    createNote.mockResolvedValue({
      ok: true,
      envelope: { id: "rpc-5", ok: true, result: { kind: "create" } },
    });
    const malformedCreate = await server.callTool("notesnook_create_note", {
      title: "Title",
      content: "Body",
    });
    expect(malformedCreate.isError).toBe(true);
    expect(payload(malformedCreate)).toEqual({
      code: "service_unavailable",
      message: "Service unavailable",
    });
  });

  it("passes the closed error vocabulary through unchanged (P1-6)", async () => {
    // Every Stage 5 RPC code reaches the MCP boundary as the matching
    // MCP code so the agent receives the same closed semantics the
    // daemon emits.  No silent collapse into `service_unavailable`.
    const client = makeClient();
    const appendNote = vi.spyOn(client, "appendNote");
    const server = buildNookMcpServer({ client });

    const cases = [
      { socket: "stale_revision", mcp: "stale_revision" },
      { socket: "conflict", mcp: "conflict" },
      { socket: "vault_locked", mcp: "vault_locked" },
      { socket: "sync_failed", mcp: "sync_failed" },
      { socket: "permission_denied", mcp: "permission_denied" },
      { socket: "invalid_request", mcp: "invalid_request" },
      { socket: "not_found", mcp: "not_found" },
      { socket: "service_unavailable", mcp: "service_unavailable" },
    ] as const;

    for (const { socket, mcp } of cases) {
      appendNote.mockResolvedValue({ ok: false, code: socket });
      const result = await server.callTool("notesnook_append_note", {
        id: "note-1",
        markdownFragment: "frag",
        expectedRevision: REVISION,
      });
      expect(result.isError).toBe(true);
      expect(payload(result).code).toBe(mcp);
    }
  });
});
