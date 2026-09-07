import { TextDecoder, TextEncoder } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { handleRpcRequest, type RpcHandlerRuntimeLike } from "../src/service/rpc-handler.js";
import {
  createReadOnlyServicePolicy,
  createReadWriteNoDeleteServicePolicy,
} from "../src/service/service-policy.js";
import {
  parseRpcFrame,
  serializeRpcResponse,
  type RpcNotesSyncRequest,
} from "../src/service/rpc-protocol.js";

const SYNC_REQUEST: RpcNotesSyncRequest = Object.freeze({
  id: "sync-1",
  method: "notes.sync",
  params: Object.freeze({}),
});

function encodeFrame(payload: object): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const frame = new Uint8Array(4 + bytes.length);
  frame[0] = (bytes.length >>> 24) & 0xff;
  frame[1] = (bytes.length >>> 16) & 0xff;
  frame[2] = (bytes.length >>> 8) & 0xff;
  frame[3] = bytes.length & 0xff;
  frame.set(bytes, 4);
  return frame;
}

function runtime(sync: () => Promise<unknown>): RpcHandlerRuntimeLike {
  return Object.freeze({
    search: vi.fn(async () => []),
    requestSync: sync,
  }) as unknown as RpcHandlerRuntimeLike;
}

describe("Stage 7 Slice 4 — outbound sync RPC", () => {
  it("accepts notes.sync with exactly empty params on the wire", () => {
    const parsed = parseRpcFrame(encodeFrame({ id: "wire-1", method: "notes.sync", params: {} }));
    expect(parsed.id).toBe("wire-1");
    expect(parsed.method).toBe("notes.sync");
    expect(parsed.params).toEqual({});
  });

  it("serializes only the categorical sync result fields", () => {
    const frame = serializeRpcResponse({
      id: "wire-2",
      ok: true,
      result: { kind: "sync", status: "synced", pendingSync: false, attempts: 1 },
    });
    const payload = new TextDecoder().decode(frame.subarray(4));
    expect(payload).toBe(
      '{"id":"wire-2","ok":true,"result":{"kind":"sync","status":"synced","pendingSync":false,"attempts":1}}',
    );
  });

  it("runs an explicit sync under readWriteNoDelete and returns only bounded status", async () => {
    const sync = vi.fn(async () => ({
      status: "synced" as const,
      pendingSync: false,
      attempts: 1,
      startedAt: 123,
      localCommitted: true,
      remoteSynced: true,
    }));

    const response = await handleRpcRequest(
      SYNC_REQUEST,
      runtime(sync),
      createReadWriteNoDeleteServicePolicy(),
    );

    expect(sync).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      id: "sync-1",
      ok: true,
      result: {
        kind: "sync",
        status: "synced",
        pendingSync: false,
        attempts: 1,
      },
    });
  });

  it("denies outbound sync under readOnly before touching the runtime", async () => {
    const sync = vi.fn(async () => ({
      status: "synced" as const,
      pendingSync: false,
      attempts: 1,
    }));

    const response = await handleRpcRequest(
      SYNC_REQUEST,
      runtime(sync),
      createReadOnlyServicePolicy(),
    );

    expect(sync).not.toHaveBeenCalled();
    expect(response).toEqual({
      id: "sync-1",
      ok: false,
      error: { code: "permission_denied", message: "Permission denied" },
    });
  });
});
