import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WIRE_BODY_BYTES } from "../src/core/size-limits.js";
import {
  RPC_ERROR_MESSAGES,
  createRpcFrameParser,
  createRpcResponseSerializer,
  isRpcProtocolOversizeError,
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

describe("request body wire bound", () => {
  const parser = createRpcFrameParser({ allowBody: true });
  const declaration = (bytes: number): unknown => ({
    id: "r",
    method: "notes.create",
    params: { title: "t" },
    body: { field: "content", bytes, sha256: SHA256 },
  });

  it("accepts exactly the wire bound", () => {
    expect(parser(frame(declaration(WIRE_BODY_BYTES)))).toBeDefined();
  });

  it("refuses one byte over the bound as a size refusal, not a malformed one", () => {
    let thrown: unknown;
    try {
      parser(frame(declaration(WIRE_BODY_BYTES + 1)));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    // The daemon answers `too_large` for this and `invalid_request` for a
    // malformed declaration, so the two must stay distinguishable.
    expect(isRpcProtocolOversizeError(thrown)).toBe(true);
  });

  it("does not classify a malformed declaration as a size refusal", () => {
    let thrown: unknown;
    try {
      parser(frame({ ...(declaration(4) as object), body: { field: "content", bytes: 0, sha256: SHA256 } }));
    } catch (error) {
      thrown = error;
    }
    expect(isRpcProtocolOversizeError(thrown)).toBe(false);
  });
});

describe("protocol 2 response codec", () => {
  // The serializer takes the same explicit policy as the parser: protocol-2
  // shapes exist only on a path that opted in.
  const serializeProtocol2 = createRpcResponseSerializer({ allowBody: true });

  it.each([
    ["body_continue", { kind: "body_continue", bytes: 128 }],
    ["capabilities", { kind: "capabilities", protocol: 2 }],
  ] as const)("serializes and round-trips %s", (_name, result) => {
    const serialized = serializeProtocol2({ id: "response", ok: true, result });
    expect(decode(serialized)).toEqual({ id: "response", ok: true, result });
  });

  it("accepts body_continue at the wire bound and refuses one byte more", () => {
    expect(() =>
      serializeProtocol2({
        id: "at-limit",
        ok: true,
        result: { kind: "body_continue", bytes: WIRE_BODY_BYTES },
      }),
    ).not.toThrow();
    expect(() =>
      serializeProtocol2({
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
    expect(decode(serializeProtocol2(envelope))).toEqual({
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

  it("declares each error message exactly once", () => {
    // The serializer refuses an envelope whose message is not the table's
    // string for its code, so a second assignment for the same code does not
    // just win — it makes the producer's message wrong and the refusal
    // unserialisable. This is that check, at the source.
    const source = readFileSync("src/service/rpc-protocol.ts", "utf8");
    // Both spellings, any spacing: a duplicate is a duplicate whether it is
    // written with a dot or an index, and a scan that only knows one form is
    // the kind of test that agrees with itself.
    const assignments = [
      ...source.matchAll(/rpcErrorMessages\s*(?:\.([a-z_]+)|\[\s*"([a-z_]+)"\s*\])\s*=/g),
    ].map((match) => match[1] ?? match[2]);
    expect(assignments.length).toBe(new Set(assignments).size);
    for (const code of Object.keys(RPC_ERROR_MESSAGES)) {
      expect(assignments.filter((name) => name === code)).toHaveLength(1);
    }
  });

  it("adds busy to the closed error vocabulary with a fixed message", () => {
    expect(RPC_ERROR_MESSAGES.busy).toBe("Service busy");
    expect(
      decode(
        serializeProtocol2({
          id: "busy",
          ok: false,
          error: { code: "busy", message: RPC_ERROR_MESSAGES.busy },
        }),
      ),
    ).toEqual({
      id: "busy",
      ok: false,
      error: { code: "busy", message: "Service busy" },
    });
  });
});

describe("legacy response serializer", () => {
  it.each([
    ["an outgoing body", { id: "r", ok: true, result: { kind: "note" }, body: { field: "markdown", bytes: 4, sha256: SHA256 } }],
    ["body_continue", { id: "r", ok: true, result: { kind: "body_continue", bytes: 4 } }],
    ["capabilities", { id: "r", ok: true, result: { kind: "capabilities", protocol: 2 } }],
  ] as const)("refuses %s without the protocol-2 policy", (_name, envelope) => {
    expect(() => serializeRpcResponse(envelope as unknown as RpcAnyResponseEnvelope)).toThrow(
      /not permitted on this path/,
    );
  });
});
