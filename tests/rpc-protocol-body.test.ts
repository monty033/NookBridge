import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { WIRE_BODY_BYTES } from "../src/core/size-limits.js";
import {
  RPC_ERROR_MESSAGES,
  createRpcFrameParser,
  parseRpcFrame,
  serializeRpcResponse,
  type RpcAnyResponseEnvelope,
} from "../src/service/rpc-protocol.js";

const SHA256 = "a".repeat(64);

function frame(value: unknown): Uint8Array {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const result = new Uint8Array(4 + payload.byteLength);
  new DataView(result.buffer).setUint32(0, payload.byteLength, false);
  result.set(payload, 4);
  return result;
}

function decode(serialized: Uint8Array): unknown {
  const declared = new DataView(
    serialized.buffer,
    serialized.byteOffset,
    serialized.byteLength,
  ).getUint32(0, false);
  return JSON.parse(Buffer.from(serialized.subarray(4, 4 + declared)).toString("utf8"));
}

function createWithBody(body: unknown): Record<string, unknown> {
  return {
    id: "body-request",
    method: "notes.create",
    params: { title: "Title" },
    body,
  };
}

describe("protocol 2 request body declarations", () => {
  it("leaves a request without body unchanged", () => {
    const legacy = {
      id: "single-frame",
      method: "notes.create",
      params: { title: "Title", content: "single frame" },
    };
    expect(parseRpcFrame(frame(legacy))).toEqual(legacy);
    expect(createRpcFrameParser({ allowBody: true })(frame(legacy))).toEqual(legacy);
  });

  it("parses a well-formed declaration only when the parser allows bodies", () => {
    const declaration = { field: "content", bytes: 128, sha256: SHA256 };
    const request = createRpcFrameParser({ allowBody: true })(
      frame(createWithBody(declaration)),
    );
    expect(request.body).toEqual(declaration);
    expect(request.params).toEqual({ title: "Title" });
    expect(Object.isFrozen(request.body)).toBe(true);

    expect(() => parseRpcFrame(frame(createWithBody(declaration)))).toThrow(/rpc protocol/);
    expect(() => createRpcFrameParser()(frame(createWithBody(declaration)))).toThrow(
      /rpc protocol/,
    );
  });

  it.each([
    ["wrong sha256 length", { field: "content", bytes: 1, sha256: "a".repeat(63) }],
    ["zero bytes", { field: "content", bytes: 0, sha256: SHA256 }],
    ["negative bytes", { field: "content", bytes: -1, sha256: SHA256 }],
    ["non-integer bytes", { field: "content", bytes: 1.5, sha256: SHA256 }],
    ["unknown field name", { field: "unknown", bytes: 1, sha256: SHA256 }],
  ])("refuses %s as invalid_request input", (_name, body) => {
    expect(() => createRpcFrameParser({ allowBody: true })(frame(createWithBody(body)))).toThrow(
      /rpc protocol/,
    );
  });
});

describe("protocol 2 response codec", () => {
  it.each([
    ["body_continue", { kind: "body_continue", bytes: 128 }],
    ["capabilities", { kind: "capabilities", protocol: 2 }],
  ] as const)("serializes and round-trips %s", (_name, result) => {
    const serialized = serializeRpcResponse({ id: "response", ok: true, result });
    expect(decode(serialized)).toEqual({ id: "response", ok: true, result });
  });

  it("accepts body_continue at the wire bound and refuses one byte more", () => {
    expect(() =>
      serializeRpcResponse({
        id: "at-limit",
        ok: true,
        result: { kind: "body_continue", bytes: WIRE_BODY_BYTES },
      }),
    ).not.toThrow();
    expect(() =>
      serializeRpcResponse({
        id: "over-limit",
        ok: true,
        result: { kind: "body_continue", bytes: WIRE_BODY_BYTES + 1 },
      }),
    ).toThrow(/rpc protocol/);
  });

  it("serializes an outgoing body declaration with markdown omitted from the result", () => {
    const body = { field: "markdown", bytes: 4, sha256: SHA256 } as const;
    const envelope: RpcAnyResponseEnvelope = {
      id: "body-read",
      ok: true,
      result: {
        kind: "note",
        note: { id: "note-1", title: "Title" },
        contentStatus: "ok",
        markdownBytes: 4,
      },
      body,
    };
    expect(decode(serializeRpcResponse(envelope))).toEqual({
      id: "body-read",
      ok: true,
      result: {
        kind: "note",
        note: { id: "note-1", title: "Title" },
        contentStatus: "ok",
        markdownBytes: 4,
      },
      body,
    });
  });

  it("adds busy to the closed error vocabulary with a fixed message", () => {
    expect(RPC_ERROR_MESSAGES.busy).toBe("Busy");
    expect(
      decode(
        serializeRpcResponse({
          id: "busy",
          ok: false,
          error: { code: "busy", message: RPC_ERROR_MESSAGES.busy },
        }),
      ),
    ).toEqual({
      id: "busy",
      ok: false,
      error: { code: "busy", message: "Busy" },
    });
  });
});
