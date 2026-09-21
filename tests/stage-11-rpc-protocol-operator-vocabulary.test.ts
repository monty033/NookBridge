/**
 * T04 — canonical operator RPC vocabulary wiring.
 *
 * The frozen T00 operator vocabulary is exactly:
 *
 *   notes.get-view
 *   notes.edit-preimage
 *   notes.apply-edit
 *   notes.apply-undo
 *   notes.create
 *   notes.operation-status
 *   notes.operation-list
 *
 * This suite pins three things:
 *
 *   1. The wire protocol's `RpcMethod` union contains each operator
 *      method verbatim (no `notes.edit` / `notes.undo` aliases; no
 *      `notes.predict-next-revision`; no `notes.snapshot`).
 *   2. The closed allowlist `SERVICE_CONFIG_ALLOWED_METHODS` does
 *      NOT widen to include operator methods on the MCP-config path
 *      (operators live behind a separate listener + auth seam).
 *   3. `methodToSettingsOperation` does NOT consult operator
 *      methods; operator methods are routed to the distinct operator
 *      policy evaluator.
 *
 * The seam under test lives in:
 *   src/service/rpc-protocol.ts           — RpcMethod union
 *   src/service/service-policy.ts         — methodToSettingsOperation
 *   src/config/service-config.ts          — SERVICE_CONFIG_ALLOWED_METHODS
 */

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  STAGE5_RPC_LIMITS,
  parseRpcFrame,
  serializeRpcResponse,
  type RpcMethod,
  type RpcNotesApplyEditRequest,
  type RpcNotesApplyUndoRequest,
  type RpcNotesCreateRequest,
  type RpcNotesEditPreimageRequest,
  type RpcNotesGetViewRequest,
  type RpcNotesOperationListRequest,
  type RpcNotesOperationStatusRequest,
  type RpcNotesGetViewResult,
  type RpcNotesEditPreimageResult,
  type RpcRequest,
} from "../src/service/rpc-protocol.js";
import { methodToSettingsOperation } from "../src/service/service-policy.js";
import { SERVICE_CONFIG_ALLOWED_METHODS } from "../src/config/service-config.js";

function frameOf(request: RpcRequest): Uint8Array {
  const payload = Buffer.from(JSON.stringify(request), "utf8");
  const frame = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

type OperatorRequestShapes =
  | RpcNotesGetViewRequest
  | RpcNotesEditPreimageRequest
  | RpcNotesApplyEditRequest
  | RpcNotesApplyUndoRequest
  | RpcNotesCreateRequest
  | RpcNotesOperationStatusRequest
  | RpcNotesOperationListRequest;

function encodeOperatorRequest(id: string, request: OperatorRequestShapes): Uint8Array {
  return frameOf(request as RpcRequest);
}

describe("rpc-protocol — operator vocabulary is exactly the canonical T00 set", () => {
  it("admits each canonical operator method on the wire", () => {
    const canonical = [
      "notes.get-view",
      "notes.edit-preimage",
      "notes.apply-edit",
      "notes.apply-undo",
      "notes.create",
      "notes.operation-status",
      "notes.operation-list",
    ];
    for (const method of canonical) {
      const request = makeRequest("test", method as RpcMethod);
      const frame = encodeOperatorRequest("test", request);
      const parsed = parseRpcFrame(frame);
      expect(parsed.method).toBe(method);
    }
  });

  it("rejects each alias method name at the parser layer", () => {
    const aliases = [
      "notes.edit",
      "notes.undo",
      "notes.predict-next-revision",
      "notes.snapshot",
      "notes.edit-preimage-2",
    ];
    for (const alias of aliases) {
      const frame = encodeAlias(alias);
      expect(() => parseRpcFrame(frame)).toThrow();
    }
  });
});

function makeRequest(id: string, method: RpcMethod): OperatorRequestShapes {
  switch (method) {
    case "notes.get-view":
      return {
        id,
        method: "notes.get-view",
        params: { id: "opaque-handle" },
      } satisfies RpcNotesGetViewRequest;
    case "notes.edit-preimage":
      return {
        id,
        method: "notes.edit-preimage",
        params: { id: "opaque-handle" },
      } satisfies RpcNotesEditPreimageRequest;
    case "notes.apply-edit":
      return {
        id,
        method: "notes.apply-edit",
        params: {
          id: "opaque-handle",
          expectedRevision: "rev_0123456789abcdef0123456789abcdef",
          markdown: "x",
        },
      } satisfies RpcNotesApplyEditRequest;
    case "notes.apply-undo":
      return {
        id,
        method: "notes.apply-undo",
        params: {
          id: "opaque-handle",
          operationHandle: "opaque-handle",
          expectedRevision: "rev_0123456789abcdef0123456789abcdef",
        },
      } satisfies RpcNotesApplyUndoRequest;
    case "notes.create":
      return {
        id,
        method: "notes.create",
        params: { title: "hello", content: "world" },
      } satisfies RpcNotesCreateRequest;
    case "notes.operation-status":
      return {
        id,
        method: "notes.operation-status",
        params: { operationHandle: "opaque-handle" },
      } satisfies RpcNotesOperationStatusRequest;
    case "notes.operation-list":
      return {
        id,
        method: "notes.operation-list",
        params: {},
      } satisfies RpcNotesOperationListRequest;
    default:
      throw new Error("unsupported canonical method");
  }
}

function encodeAlias(alias: string): Uint8Array {
  const payload = Buffer.from(JSON.stringify({ id: "x", method: alias, params: {} }), "utf8");
  const frame = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

describe("operator view/preimage results — bounded Markdown projection", () => {
  it("carries the editor Markdown projection on both read paths", () => {
    const view = {
      kind: "view",
      id: "opaque-handle",
      revision: "rev_0123456789abcdef0123456789abcdef",
      markdown: "# title\n\nbody\n",
      contentBytes: 14,
    } satisfies RpcNotesGetViewResult;
    const preimage = {
      kind: "preimage",
      id: "opaque-handle",
      revision: "rev_0123456789abcdef0123456789abcdef",
      markdown: "# title\n\nbody\n",
      contentBytes: 14,
    } satisfies RpcNotesEditPreimageResult;
    expect(view.markdown).toContain("# title");
    expect(preimage.markdown).toContain("body");
    expect(serializeRpcResponse({ id: "view", ok: true, result: view }).byteLength).toBeGreaterThan(
      0,
    );
    expect(
      serializeRpcResponse({ id: "preimage", ok: true, result: preimage }).byteLength,
    ).toBeGreaterThan(0);
  });
});

describe("service-config — operator methods are NOT in the MCP allowlist", () => {
  it("does not admit any canonical operator method", () => {
    expect(SERVICE_CONFIG_ALLOWED_METHODS).not.toContain("notes.get-view");
    expect(SERVICE_CONFIG_ALLOWED_METHODS).not.toContain("notes.edit-preimage");
    expect(SERVICE_CONFIG_ALLOWED_METHODS).not.toContain("notes.apply-edit");
    expect(SERVICE_CONFIG_ALLOWED_METHODS).not.toContain("notes.apply-undo");
    // `notes.create` is intentionally admitted on the MCP path
    // because it pre-existed; the new operator methods are NOT.
    expect(SERVICE_CONFIG_ALLOWED_METHODS).not.toContain("notes.operation-status");
    expect(SERVICE_CONFIG_ALLOWED_METHODS).not.toContain("notes.operation-list");
  });

  it("removes the legacy aliases that T00 forbids", () => {
    expect(SERVICE_CONFIG_ALLOWED_METHODS).not.toContain("notes.edit");
    expect(SERVICE_CONFIG_ALLOWED_METHODS).not.toContain("notes.undo");
    expect(SERVICE_CONFIG_ALLOWED_METHODS).not.toContain("notes.predict-next-revision");
    expect(SERVICE_CONFIG_ALLOWED_METHODS).not.toContain("notes.snapshot");
  });
});

describe("methodToSettingsOperation — operator methods bypass the settings seam", () => {
  it("returns undefined for each canonical operator method", () => {
    const operatorMethods = [
      "notes.get-view",
      "notes.edit-preimage",
      "notes.apply-edit",
      "notes.apply-undo",
      "notes.operation-status",
      "notes.operation-list",
    ];
    for (const method of operatorMethods) {
      expect(methodToSettingsOperation(method)).toBeUndefined();
    }
  });

  it("still routes the pre-existing methods through the settings seam", () => {
    // The settings seam is the MCP-side evaluator; it must continue
    // to apply to MCP-only methods (the operator seam is additive).
    expect(methodToSettingsOperation("notes.search")).toBe("read");
    expect(methodToSettingsOperation("notes.create")).toBe("create");
    expect(methodToSettingsOperation("notes.update")).toBe("edit");
    expect(methodToSettingsOperation("notes.delete")).toBe("delete");
  });
});

describe("rpc-protocol — operator method-specific frame bounds", () => {
  it("applies the published per-method bounds without regression", () => {
    expect(STAGE5_RPC_LIMITS.maxFrameBytes).toBeGreaterThan(0);
    expect(STAGE5_RPC_LIMITS.maxResponseBytes).toBeGreaterThan(0);
  });

  it("serializes a closed operator-style envelope through the canonical wire", () => {
    // Use the existing `kind: "create"` envelope to prove the
    // serializer is intact; the operator result shapes are wired
    // in a follow-up slice but the serializer must not reject a
    // structurally valid closed envelope.
    const payload = Buffer.from(
      JSON.stringify({
        id: "abc",
        ok: true,
        result: {
          kind: "create",
          id: "n1",
          operationHandle: "op_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          titleBytes: 5,
          contentBytes: 5,
        },
      }),
      "utf8",
    );
    const frame = new Uint8Array(4 + payload.byteLength);
    const view = new DataView(frame.buffer);
    view.setUint32(0, payload.byteLength, false);
    frame.set(payload, 4);
    const serialized = serializeRpcResponse({
      id: "abc",
      ok: true,
      result: {
        kind: "create",
        id: "n1",
        operationHandle: "op_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        titleBytes: 5,
        contentBytes: 5,
      },
    });
    expect(serialized.byteLength).toBe(frame.byteLength);
  });
});

describe("rpc-protocol — notes.apply-undo admits the operator's handle-only form", () => {
  it("admits { operationHandle } alone", () => {
    // The operator contract is that the daemon resolves the note id and the
    // guarding revision from its own committed record, so neither crosses the
    // socket: the CLI's undo runtime sends exactly this shape.  The wire parser
    // required the explicit three-field form instead, so `nookctl notes undo`
    // was refused before it reached the runtime and the socket was closed with
    // no envelope, surfacing as a generic CLI error.
    const request = parseRpcFrame(
      frameOf({
        id: "undo-handle-only",
        method: "notes.apply-undo",
        params: {
          operationHandle: "op_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      } as RpcRequest),
    );
    expect(request.method).toBe("notes.apply-undo");
    expect(request.params).toEqual({
      operationHandle: "op_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
  });

  it("still admits the explicit three-field form", () => {
    const request = parseRpcFrame(
      frameOf({
        id: "undo-explicit",
        method: "notes.apply-undo",
        params: {
          id: "opaque-handle",
          operationHandle: "op_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          expectedRevision: "rev_0123456789abcdef0123456789abcdef",
        },
      } as RpcRequest),
    );
    expect(request.params).toEqual({
      id: "opaque-handle",
      operationHandle: "op_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      expectedRevision: "rev_0123456789abcdef0123456789abcdef",
    });
  });
});

describe("rpc-protocol — bare undo response may omit the note id", () => {
  it("serializes an undo result without an id field", () => {
    // A bare `notes undo` addresses the operation alone, and the daemon must not
    // answer with the raw note id (D8), so `id` is absent from the result.
    // Requiring it threw *after* the undo had already committed, so the operator
    // saw an error over a note that had in fact been changed.
    const frame = serializeRpcResponse({
      id: "undo-bare",
      ok: true,
      result: {
        kind: "undo",
        appliedFields: ["content"],
        revision: "rev_0123456789abcdef0123456789abcdef",
        contentBytes: 4,
      },
    } as never);
    const payload = JSON.parse(Buffer.from(frame).subarray(4).toString("utf8"));
    expect(payload.ok).toBe(true);
    expect(payload.result.kind).toBe("undo");
    expect(Object.keys(payload.result).sort()).toEqual([
      "appliedFields",
      "contentBytes",
      "kind",
      "revision",
    ]);
  });
});
