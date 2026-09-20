import { describe, expect, it } from "vitest";

import { createNotesCommandRuntimeFromOperatorSocket } from "../src/operator/notes-production-runtime.js";
import type { OperatorSocketResult } from "../src/operator/operator-socket-client.js";

const HANDLE = `h_${"Ab12".repeat(6)}`;
const OPERATION = `op_${"a".repeat(64)}`;
const REVISION = `rev_${"a".repeat(32)}`;
const MARKDOWN = "# Title\n\nbody\n";

type Handler = (
  params: Record<string, unknown>,
) => OperatorSocketResult | Promise<OperatorSocketResult>;

function client(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    request: async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<OperatorSocketResult> => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) return { ok: false, code: "service_unavailable" };
      return await handler(params);
    },
    callsTo: (method: string) => calls.filter((call) => call.method === method),
  };
}

const preimage = (): OperatorSocketResult => ({
  ok: true,
  result: {
    kind: "preimage",
    id: HANDLE,
    revision: REVISION,
    markdown: MARKDOWN,
    contentBytes: MARKDOWN.length,
  },
});

describe("operator-socket notes write runtime", () => {
  it("captures the preimage, edits in $EDITOR, then applies", async () => {
    const socket = client({
      "notes.edit-preimage": () => preimage(),
      "notes.apply-edit": () => ({
        ok: true,
        result: {
          kind: "edit",
          id: HANDLE,
          appliedFields: ["content"],
          revision: REVISION,
          contentBytes: 5,
        },
      }),
    });
    const runtime = createNotesCommandRuntimeFromOperatorSocket(socket, {
      editBody: async (markdown) => ({ kind: "edited", markdown: `${markdown}edited\n` }),
    });

    await expect(runtime.edit({ handle: HANDLE })).resolves.toEqual({ kind: "updated" });

    // The preimage is captured BEFORE the body is applied, and the apply
    // carries the preimage revision — never a predicted one.
    expect(socket.calls.map((call) => call.method)).toEqual([
      "notes.edit-preimage",
      "notes.apply-edit",
    ]);
    expect(socket.callsTo("notes.apply-edit")[0]!.params).toEqual({
      id: HANDLE,
      expectedRevision: REVISION,
      markdown: `${MARKDOWN}edited\n`,
    });
  });

  it("applies nothing when the operator saves unchanged", async () => {
    const socket = client({ "notes.edit-preimage": () => preimage() });
    const runtime = createNotesCommandRuntimeFromOperatorSocket(socket, {
      editBody: async () => ({ kind: "unchanged" }),
    });

    await expect(runtime.edit({ handle: HANDLE })).resolves.toEqual({ kind: "unchanged" });
    expect(socket.callsTo("notes.apply-edit")).toHaveLength(0);
  });

  it("surfaces a stale revision as a conflict rather than an update", async () => {
    const socket = client({
      "notes.edit-preimage": () => preimage(),
      "notes.apply-edit": () => ({ ok: false, code: "stale_revision" }),
    });
    const runtime = createNotesCommandRuntimeFromOperatorSocket(socket, {
      editBody: async () => ({ kind: "edited", markdown: "changed\n" }),
    });

    await expect(runtime.edit({ handle: HANDLE })).resolves.toEqual({ kind: "conflict" });
  });

  it("refuses when the editor cannot run, without touching the note", async () => {
    const socket = client({ "notes.edit-preimage": () => preimage() });
    const runtime = createNotesCommandRuntimeFromOperatorSocket(socket, {
      editBody: async () => ({ kind: "refused" }),
    });

    await expect(runtime.edit({ handle: HANDLE })).resolves.toEqual({
      kind: "error",
      exitCode: 3,
      message: "nookctl notes: editor unavailable",
    });
    expect(socket.callsTo("notes.apply-edit")).toHaveLength(0);
  });

  it("refuses a missing handle before opening an editor", async () => {
    const socket = client({ "notes.edit-preimage": () => ({ ok: false, code: "not_found" }) });
    let editorOpened = false;
    const runtime = createNotesCommandRuntimeFromOperatorSocket(socket, {
      editBody: async () => {
        editorOpened = true;
        return { kind: "unchanged" };
      },
    });

    await expect(runtime.edit({ handle: HANDLE })).resolves.toEqual({ kind: "missing" });
    expect(editorOpened).toBe(false);
  });

  it("undoes by operation handle alone — no note id, no revision", async () => {
    const socket = client({
      "notes.apply-undo": () => ({
        ok: true,
        result: { kind: "undo", appliedFields: ["content"], revision: REVISION, contentBytes: 4 },
      }),
    });
    const runtime = createNotesCommandRuntimeFromOperatorSocket(socket);

    await expect(runtime.undo({ operationHandle: OPERATION })).resolves.toEqual({ kind: "undone" });
    expect(socket.callsTo("notes.apply-undo")[0]!.params).toEqual({ operationHandle: OPERATION });
  });

  it("refuses a malformed operation handle before contacting the daemon", async () => {
    const socket = client({});
    const runtime = createNotesCommandRuntimeFromOperatorSocket(socket);

    await expect(runtime.undo({ operationHandle: "../etc/passwd" })).resolves.toEqual({
      kind: "invalid-input",
    });
    expect(socket.calls).toHaveLength(0);
  });

  it("lists only handles the daemon actually minted", async () => {
    const socket = client({
      "notes.operation-list": () => ({
        ok: true,
        result: { kind: "operation-list", handles: [OPERATION, "/etc/passwd", "nope"] },
      }),
    });
    const runtime = createNotesCommandRuntimeFromOperatorSocket(socket);

    await expect(runtime.operations()).resolves.toEqual({
      kind: "operations",
      handles: [OPERATION],
    });
  });
});
