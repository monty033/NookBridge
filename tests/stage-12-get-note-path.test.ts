/** Regression coverage for exact-path notes.get across RPC and MCP boundaries. */
import { describe, expect, it, vi } from "vitest";
import { handleRpcRequest, type RpcHandlerRuntimeLike } from "../src/service/rpc-handler.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import { ExactNotePathError } from "../src/service/exact-note-path-resolver.js";
import { NookdSocketClient } from "../src/mcp/socket-client.js";
import { buildNookMcpServer } from "../src/mcp/nook-mcp-server.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";

const request = (params: Record<string, unknown>) =>
  ({ id: "get-1", method: "notes.get", params }) as unknown as RpcRequest;
const runtime = (overrides: Partial<RpcHandlerRuntimeLike> = {}): RpcHandlerRuntimeLike => ({
  search: async () => [],
  noteMetadata: async (id) => ({ id, title: "Memo", notebookId: "nb" }),
  resolveNotePath: async () => ({
    id: "opaque",
    expectedRevision: "rev_0123456789abcdef0123456789abcdef",
  }),
  // Mirrors the trusted index shape resolveTrustedNotebookPath reads: the
  // resolved note's real notebook is "Private" regardless of the caller's path.
  notebookIndex: { resolvePath: () => "Private" } as never,
  readOnly: {
    readOperatorNoteContent: vi.fn(async () => ({ type: "html" as const, data: "<p>Hello</p>" })),
  },
  ...overrides,
});

describe("notes.get exact path", () => {
  it("resolves a path, authorizes its notebook context, and returns bounded content", async () => {
    const reader = vi.fn(async () => ({ type: "html" as const, data: "<p>Hello</p>" }));
    const resolveNotePath = vi.fn(async () => ({
      id: "opaque",
      expectedRevision: "rev_0123456789abcdef0123456789abcdef",
    }));
    const r = runtime({ resolveNotePath, readOnly: { readOperatorNoteContent: reader } });
    const response = await handleRpcRequest(
      request({ path: "Private/Memo" }),
      r,
      createReadWriteNoDeleteServicePolicy(() => ({ allowed: true })),
    );
    expect(resolveNotePath).toHaveBeenCalledWith("Private/Memo");
    expect(reader).toHaveBeenCalledWith("opaque");
    expect(response).toMatchObject({ ok: true, result: { kind: "note", contentStatus: "ok" } });
    expect(response.ok && response.result.kind === "note" && response.result.markdown).toContain(
      "Hello",
    );
  });
  it("does not read locked path-resolved notes", async () => {
    const reader = vi.fn(async () => ({ type: "html" as const, data: "<p>Hello</p>" }));
    const r = runtime({
      noteMetadata: async (id) => ({ id, title: "Memo", notebookId: "nb", locked: true }),
      readOnly: { readOperatorNoteContent: reader },
    });
    const response = await handleRpcRequest(request({ path: "Private/Memo" }), r);
    expect(response).toMatchObject({ ok: true, result: { contentStatus: "locked" } });
    expect(response.ok && response.result.kind === "note" && "markdown" in response.result).toBe(
      false,
    );
    expect(
      response.ok && response.result.kind === "note" && "markdownBytes" in response.result,
    ).toBe(false);
    expect(reader).not.toHaveBeenCalled();
  });
  it.each([
    ["not_found", "not_found"],
    ["ambiguous", "invalid_request"],
  ] as const)("maps resolver %s", async (code, expected) => {
    const r = runtime({
      resolveNotePath: async () => {
        throw new ExactNotePathError(code as "not_found" | "ambiguous");
      },
    });
    expect(await handleRpcRequest(request({ path: "Private/Memo" }), r)).toMatchObject({
      ok: false,
      error: { code: expected },
    });
  });
  it("rejects mixed or empty path/id forms", async () => {
    for (const params of [{}, { id: "opaque", path: "Private/Memo" }, { notebookPath: "Private" }])
      expect(await handleRpcRequest(request(params), runtime())).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
  });
  it("denies based on the resolved path context before content read", async () => {
    const reader = vi.fn();
    const evaluate = vi.fn((_op: string, context: { notebookPath?: string }) => ({
      allowed: context.notebookPath !== "Private",
    }));
    const response = await handleRpcRequest(
      request({ path: "Private/Memo" }),
      runtime({ readOnly: { readOperatorNoteContent: reader } }),
      createReadWriteNoDeleteServicePolicy(evaluate as never),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(reader).not.toHaveBeenCalled();
  });

  it("denies when a permitted path resolves to a note actually in a denied notebook", async () => {
    // The caller asks for "Public/Memo" (permitted), but the resolver returns a
    // note whose real notebook is "Private" (denied). Authorization must follow
    // the resolved note, not the caller's claim, and never read content.
    const reader = vi.fn(async () => ({ type: "html" as const, data: "<p>Secret</p>" }));
    const evaluate = vi.fn((_op: string, context: { notebookPath?: string }) => ({
      allowed: context.notebookPath !== "Private",
    }));
    const response = await handleRpcRequest(
      request({ path: "Public/Memo" }),
      runtime({ readOnly: { readOperatorNoteContent: reader } }),
      createReadWriteNoDeleteServicePolicy(evaluate as never),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(reader).not.toHaveBeenCalled();
  });

  it("with a settings evaluator, refuses a resolved note that is in no notebook without reading it", async () => {
    // Deliberate, documented behavior until a reserved `<root>` notebook
    // context exists: an unconfirmed notebook context must never be treated
    // as permission to read, matching notes.get by id.
    const reader = vi.fn(async () => ({ type: "html" as const, data: "<p>Root</p>" }));
    const response = await handleRpcRequest(
      request({ path: "Memo" }),
      runtime({
        noteMetadata: async (id) => ({ id, title: "Memo" }),
        readOnly: { readOperatorNoteContent: reader },
      }),
      createReadWriteNoDeleteServicePolicy((() => ({ allowed: true })) as never),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(reader).not.toHaveBeenCalled();
  });

  it("MCP get schema and dispatch accepts the exact path alternative", async () => {
    const client = new NookdSocketClient({ socketPath: "/nonexistent/nookd.sock" });
    const getNote = vi
      .spyOn(client, "getNote")
      .mockResolvedValue({ ok: false, code: "not_found" } as Awaited<
        ReturnType<NookdSocketClient["getNote"]>
      >);
    const server = buildNookMcpServer({ client });
    const result = await server.callTool("notesnook_get_note", { path: "Private/Memo" });
    expect(result.isError).toBe(true);
    expect(getNote).toHaveBeenCalledWith({ path: "Private/Memo" });
    expect(
      (await server.callTool("notesnook_get_note", { notebookPath: "Private", noteTitle: "Memo" }))
        .isError,
    ).toBe(true);
    expect(getNote).toHaveBeenLastCalledWith({ notebookPath: "Private", noteTitle: "Memo" });
    const callsBeforeMixed = getNote.mock.calls.length;
    expect(
      (await server.callTool("notesnook_get_note", { id: "x", path: "Private/Memo" })).isError,
    ).toBe(true);
    // A mixed id+path request is refused before it ever reaches the daemon.
    expect(getNote.mock.calls.length).toBe(callsBeforeMixed);
  });
});
