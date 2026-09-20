import { describe, expect, it } from "vitest";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";

describe("operator mutation handler", () => {
  it("dispatches edit preimage, apply edit, and apply undo", async () => {
    const calls: string[] = [];
    const handler = createOperatorDiscoveryHandler({
      browse: async () => ({ notes: [], next: null }),
      search: async () => ({ notes: [], next: null }),
      editPreimage: async ({ id }) => {
        calls.push(`preimage:${id}`);
        return { kind: "preimage", id, revision: "rev_1", markdown: "before", contentBytes: 6 };
      },
      applyEdit: async ({ id, expectedRevision, markdown }) => {
        calls.push(`edit:${id}:${expectedRevision}:${markdown}`);
        return { kind: "edit", id, appliedFields: ["content"], revision: "rev_2", contentBytes: 5 };
      },
      applyUndo: async ({ id, operationHandle, expectedRevision }) => {
        calls.push(`undo:${id}:${operationHandle}:${expectedRevision}`);
        return { kind: "undo", id, appliedFields: ["content"], revision: "rev_3", contentBytes: 6 };
      },
      operationStatus: async ({ operationHandle }) => ({
        kind: "operation-status",
        operationHandle,
        state: "committed",
        id: "note-1",
      }),
      operationList: async () => ({ kind: "operation-list", handles: ["op_1"] }),
    });

    const peer = { uid: 1, gid: 2, groups: [] as string[] };
    const responses = await Promise.all([
      handler(
        { id: "1", method: "notes.edit-preimage", params: { id: "note-1" } } as RpcRequest,
        peer,
      ),
      handler(
        {
          id: "2",
          method: "notes.apply-edit",
          params: { id: "note-1", expectedRevision: "rev_1", markdown: "after" },
        } as RpcRequest,
        peer,
      ),
      handler(
        {
          id: "3",
          method: "notes.apply-undo",
          params: { id: "note-1", operationHandle: "op_1", expectedRevision: "rev_2" },
        } as RpcRequest,
        peer,
      ),
    ]);

    expect(responses).toEqual([
      {
        id: "1",
        ok: true,
        result: {
          kind: "preimage",
          id: "note-1",
          revision: "rev_1",
          markdown: "before",
          contentBytes: 6,
        },
      },
      {
        id: "2",
        ok: true,
        result: {
          kind: "edit",
          id: "note-1",
          appliedFields: ["content"],
          revision: "rev_2",
          contentBytes: 5,
        },
      },
      {
        id: "3",
        ok: true,
        result: {
          kind: "undo",
          id: "note-1",
          appliedFields: ["content"],
          revision: "rev_3",
          contentBytes: 6,
        },
      },
    ]);
    expect(calls).toEqual(["preimage:note-1", "edit:note-1:rev_1:after", "undo:note-1:op_1:rev_2"]);
  });

  it("dispatches operation status and list", async () => {
    const handler = createOperatorDiscoveryHandler({
      browse: async () => ({ notes: [], next: null }),
      search: async () => ({ notes: [], next: null }),
      operationStatus: async ({ operationHandle }) => ({
        kind: "operation-status",
        operationHandle,
        state: "prepared",
      }),
      operationList: async () => ({ kind: "operation-list", handles: ["op_1", "op_2"] }),
    });

    const peer = { uid: 1, gid: 2, groups: [] as string[] };
    expect(
      await handler(
        {
          id: "1",
          method: "notes.operation-status",
          params: { operationHandle: "op_1" },
        } as RpcRequest,
        peer,
      ),
    ).toEqual({
      id: "1",
      ok: true,
      result: { kind: "operation-status", operationHandle: "op_1", state: "prepared" },
    });
    expect(
      await handler({ id: "2", method: "notes.operation-list", params: {} } as RpcRequest, peer),
    ).toEqual({
      id: "2",
      ok: true,
      result: { kind: "operation-list", handles: ["op_1", "op_2"] },
    });
  });

  it("normalizes mutation failures without exposing causes", async () => {
    const handler = createOperatorDiscoveryHandler({
      browse: async () => ({ notes: [], next: null }),
      search: async () => ({ notes: [], next: null }),
      editPreimage: async () => {
        throw new Error("secret body and path");
      },
    });
    const peer = { uid: 1, gid: 2, groups: [] as string[] };
    await expect(
      handler(
        { id: "1", method: "notes.edit-preimage", params: { id: "note-1" } } as RpcRequest,
        peer,
      ),
    ).resolves.toEqual({
      id: "1",
      ok: false,
      error: { code: "service_unavailable", message: "Service unavailable" },
    });
  });
});
