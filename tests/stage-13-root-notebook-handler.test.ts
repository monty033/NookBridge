/** Handler coverage for the reserved <root> context: confirmed vs unconfirmed. */
import { describe, expect, it, vi } from "vitest";
import { handleRpcRequest, type RpcHandlerRuntimeLike } from "../src/service/rpc-handler.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";

const req = (params: Record<string, unknown>) =>
  ({ id: "r-1", method: "notes.get", params }) as unknown as RpcRequest;

const rootNote =
  (extra: Record<string, unknown> = {}) =>
  async (id: string) =>
    ({ id, title: "Memo", ...extra }) as never;

const runtime = (
  noteMetadata: (id: string) => Promise<never>,
  reader = vi.fn(async () => ({ type: "html" as const, data: "<p>Hello</p>" })),
): RpcHandlerRuntimeLike => ({
  search: async () => [],
  noteMetadata: noteMetadata as unknown as NonNullable<RpcHandlerRuntimeLike["noteMetadata"]>,
  resolveNotePath: async () => ({
    id: "opaque",
    expectedRevision: "rev_0123456789abcdef0123456789abcdef",
  }),
  readOnly: { readOperatorNoteContent: reader },
});

// Policy: allow only when the evaluator receives the root context
// (no notebookPath); records what it saw.
const policyFor = (seen: unknown[]) =>
  createReadWriteNoDeleteServicePolicy((_op, ctx) => {
    seen.push(ctx);
    return { allowed: ctx.notebookPath === undefined };
  });

describe("notes.get — notes confirmed to be outside every notebook", () => {
  it("authorizes a confirmed root note with a notebook-less context and returns content", async () => {
    const seen: unknown[] = [];
    const reader = vi.fn(async () => ({ type: "html" as const, data: "<p>Hello</p>" }));
    const r = runtime(rootNote({ notebookAbsenceConfirmed: true }), reader);
    const response = await handleRpcRequest(req({ id: "n1" }), r, policyFor(seen));
    expect(seen).toEqual([{ noteTitle: "Memo" }]);
    expect(response).toMatchObject({ ok: true, result: { kind: "note", contentStatus: "ok" } });
    expect(reader).toHaveBeenCalledWith("n1");
  });

  it("does not leak the confirmation flag into the client-visible note", async () => {
    const r = runtime(rootNote({ notebookAbsenceConfirmed: true }));
    const response = await handleRpcRequest(req({ id: "n1" }), r, policyFor([]));
    expect(JSON.stringify(response)).not.toContain("notebookAbsenceConfirmed");
  });

  it("keeps not_found when absence is NOT confirmed", async () => {
    const reader = vi.fn(async () => ({ type: "html" as const, data: "<p>x</p>" }));
    const response = await handleRpcRequest(
      req({ id: "n1" }),
      runtime(rootNote(), reader),
      policyFor([]),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([false, "true", 1, null])("ignores a non-true confirmation value %j", async (value) => {
    const response = await handleRpcRequest(
      req({ id: "n1" }),
      runtime(rootNote({ notebookAbsenceConfirmed: value })),
      policyFor([]),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("applies a deny rule for <root> before reading content", async () => {
    const reader = vi.fn(async () => ({ type: "html" as const, data: "<p>x</p>" }));
    const deny = createReadWriteNoDeleteServicePolicy(() => ({ allowed: false }));
    const response = await handleRpcRequest(
      req({ id: "n1" }),
      runtime(rootNote({ notebookAbsenceConfirmed: true }), reader),
      deny,
    );
    expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(reader).not.toHaveBeenCalled();
  });

  it("withholds content of a locked root note", async () => {
    const reader = vi.fn(async () => ({ type: "html" as const, data: "<p>x</p>" }));
    const r = runtime(rootNote({ notebookAbsenceConfirmed: true, locked: true }), reader);
    const response = await handleRpcRequest(req({ id: "n1" }), r, policyFor([]));
    expect(response).toMatchObject({ ok: true, result: { contentStatus: "locked" } });
    expect(reader).not.toHaveBeenCalled();
  });

  it("a note with a notebook id never takes the root path even if flagged", async () => {
    const seen: unknown[] = [];
    const r = runtime(rootNote({ notebookId: "nb", notebookAbsenceConfirmed: true }));
    const response = await handleRpcRequest(req({ id: "n1" }), r, policyFor(seen));
    // No trusted notebook index -> unresolvable notebook stays not_found.
    expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(seen).toEqual([]);
  });

  it("applies the same rule to path reads of a root note", async () => {
    const seen: unknown[] = [];
    const response = await handleRpcRequest(
      req({ path: "Memo" }),
      runtime(rootNote({ notebookAbsenceConfirmed: true })),
      policyFor(seen),
    );
    expect(response).toMatchObject({ ok: true, result: { contentStatus: "ok" } });
    expect(seen).toEqual([{ noteTitle: "Memo" }, { noteTitle: "Memo" }]);
  });

  it("path read of an unconfirmed note stays not_found", async () => {
    const response = await handleRpcRequest(
      req({ path: "Memo" }),
      runtime(rootNote()),
      policyFor([]),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
