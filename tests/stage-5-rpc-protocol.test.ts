/**
 * Stage 5 Task 4 — pure closed framed RPC protocol boundary.
 *
 * This suite is written first (RED), exercises the planned public contract,
 * and is paired with `src/service/rpc-protocol.ts`.  The slice is the
 * minimal framed wire protocol that the future `nookd` daemon will sit
 * behind:
 *
 *   - length-prefixed (4-byte big-endian) framing;
 *   - frame bytes, query bytes, response bytes, and hit count are all
 *     bounded by the published {@link STAGE5_RPC_LIMITS} constants;
 *   - the parser rejects malformed, oversized, truncated, invalid
 *     UTF-8/JSON, root-array, duplicate-key, and inherited-field frames
 *     without ever leaking the raw parser exception, the request value,
 *     or any path / credential carrier;
 *   - only the allowlisted `notes.search` method is accepted; every
 *     other method name is rejected categorically;
 *   - only the bounded `{ query: string }` param shape is accepted;
 *     every additional / unknown / path / core / sync / credential
 *     carrier is rejected categorically;
 *   - the parsed request is a frozen, null-prototype object so a hostile
 *     proxy / inherited getter cannot smuggle data back out;
 *   - the response serializer accepts only approved own fields and
 *     applies the same bounds to the response frame.
 *
 * Tests deliberately never invoke the service runtime, never open a
 * socket, never touch the filesystem, never use generated state, and
 * never reference credential bytes, key bytes, paths, or upstream
 * strings.  Every assertion operates on the public protocol surface.
 */

import { Buffer } from "node:buffer";
import { TextDecoder, TextEncoder } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  STAGE5_RPC_LIMITS,
  isRpcProtocolError,
  parseRpcFrame,
  serializeRpcResponse,
  type RpcRequest,
  type RpcResponseEnvelope,
  type RpcSearchResult,
} from "../src/service/rpc-protocol.js";

// ---------------------------------------------------------------------------
// Constants — the published bounds.  These are part of the public protocol
// surface and must be frozen; downstream callers may read them directly.
// ---------------------------------------------------------------------------

describe("STAGE5_RPC_LIMITS", () => {
  it("is frozen and exposes the four documented bounds", () => {
    expect(Object.isFrozen(STAGE5_RPC_LIMITS)).toBe(true);
    expect(typeof STAGE5_RPC_LIMITS.maxFrameBytes).toBe("number");
    expect(typeof STAGE5_RPC_LIMITS.maxQueryBytes).toBe("number");
    expect(typeof STAGE5_RPC_LIMITS.maxResponseBytes).toBe("number");
    expect(typeof STAGE5_RPC_LIMITS.maxSearchHits).toBe("number");
    expect(STAGE5_RPC_LIMITS.maxFrameBytes).toBeGreaterThan(0);
    expect(STAGE5_RPC_LIMITS.maxQueryBytes).toBeGreaterThan(0);
    expect(STAGE5_RPC_LIMITS.maxResponseBytes).toBeGreaterThan(0);
    expect(STAGE5_RPC_LIMITS.maxSearchHits).toBeGreaterThan(0);
    // query bytes must fit within a single frame
    expect(STAGE5_RPC_LIMITS.maxQueryBytes).toBeLessThanOrEqual(STAGE5_RPC_LIMITS.maxFrameBytes);
  });

  it("rejects mutation", () => {
    expect(() => {
      // any-cast because the published object is intentionally read-only.
      (STAGE5_RPC_LIMITS as unknown as { maxFrameBytes: number }).maxFrameBytes = 1;
    }).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// parseRpcFrame — the input boundary.
//
// Every failure must produce an RpcProtocolError whose message NEVER echoes
// the request value, the method name, the raw parser exception, the path,
// or any credential / key byte.  We assert categorical message prefixes
// instead of full messages so the wire contract is stable but the wording
// can evolve.
// ---------------------------------------------------------------------------

describe("parseRpcFrame", () => {
  // -- Frame / length-prefix plumbing --------------------------------------

  it("rejects an empty buffer", () => {
    expect(() => parseRpcFrame(new Uint8Array(0))).toThrow(/rpc protocol/);
  });

  it("rejects a buffer whose length prefix exceeds maxFrameBytes", () => {
    const buf = new Uint8Array(8);
    writeFrameLength(buf, STAGE5_RPC_LIMITS.maxFrameBytes + 1);
    expect(() => parseRpcFrame(buf)).toThrow(/rpc protocol/);
  });

  it("rejects a frame whose declared length exceeds maxFrameBytes", () => {
    const declared = STAGE5_RPC_LIMITS.maxFrameBytes + 1;
    const frame = new Uint8Array(4 + 16);
    writeFrameLength(frame, declared);
    expect(() => parseRpcFrame(frame)).toThrow(/rpc protocol/);
  });

  it("rejects a truncated frame (declared length greater than payload)", () => {
    const header = new Uint8Array(8);
    writeFrameLength(header, 16); // declares 16 bytes
    // but only 4 bytes of payload follow
    expect(() => parseRpcFrame(header)).toThrow(/rpc protocol/);
  });

  it("treats an all-zero header as zero despite a forged DataView getUint32", () => {
    const payload = encode('{"id":"a","method":"notes.search","params":{"query":"hello"}}');
    const frame = new Uint8Array(4 + payload.length);
    frame.set(payload, 4);
    const originalGetUint32 = DataView.prototype.getUint32;
    DataView.prototype.getUint32 = () => payload.length;

    try {
      expect(() => parseRpcFrame(frame)).toThrow(/declared frame length is zero/);
    } finally {
      DataView.prototype.getUint32 = originalGetUint32;
    }
  });

  it("rejects actual payload bytes when Uint8Array.subarray is overridden", () => {
    const actualPayload = encode("not json");
    const frame = wrapFrame(actualPayload);
    Object.defineProperty(frame, "subarray", {
      configurable: true,
      value: () => encode('{"id":"a","method":"notes.search","params":{"query":"forged"}}'),
    });

    expect(() => parseRpcFrame(frame)).toThrow(/rpc protocol/);
  });

  it("rejects a frame whose declared length is zero", () => {
    const frame = new Uint8Array(4);
    writeFrameLength(frame, 0);
    expect(() => parseRpcFrame(frame)).toThrow(/rpc protocol/);
  });

  // -- JSON validity / shape -----------------------------------------------

  it("rejects invalid UTF-8 in the JSON payload", () => {
    // 0xFF is never a valid UTF-8 start byte.
    const payload = new Uint8Array([0xff, 0xfe, 0xfd]);
    const frame = wrapFrame(payload);
    expect(() => parseRpcFrame(frame)).toThrow(/rpc protocol/);
  });

  it("rejects a valid JSON frame prefixed with a UTF-8 BOM", () => {
    const json = '\uFEFF{"id":"a","method":"notes.search","params":{"query":"hello"}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/BOM/);
  });

  it("rejects syntactically invalid JSON", () => {
    const payload = new TextEncoder().encode("{not json");
    expect(() => parseRpcFrame(wrapFrame(payload))).toThrow(/rpc protocol/);
  });

  it("rejects malformed unicode escapes instead of partially parsing them", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":"\\u12xz"}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects raw control characters inside JSON strings", () => {
    const rawControl = String.fromCharCode(0x01);
    const json = `{"id":"a","method":"notes.search","params":{"query":"x${rawControl}y"}}`;
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("accepts an escaped control character inside a JSON string", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":"x\\u0001y"}}';
    const request = parseRpcFrame(wrapFrame(encode(json)));
    if (request.method !== "notes.search") throw new Error("unexpected method");
    expect(request.params.query).toBe("x\u0001y");
  });

  it("rejects a JSON root that is not an object (array)", () => {
    const payload = new TextEncoder().encode("[1,2,3]");
    expect(() => parseRpcFrame(wrapFrame(payload))).toThrow(/rpc protocol/);
  });

  it("rejects a JSON root that is not an object (scalar)", () => {
    const payload = new TextEncoder().encode('"hello"');
    expect(() => parseRpcFrame(wrapFrame(payload))).toThrow(/rpc protocol/);
  });

  it("rejects a JSON root that is null", () => {
    const payload = new TextEncoder().encode("null");
    expect(() => parseRpcFrame(wrapFrame(payload))).toThrow(/rpc protocol/);
  });

  it("rejects a JSON root with inherited fields (proxy)", () => {
    // Build a JSON string of a plain object, then parse it via a Proxy whose
    // get handler injects an extra field.  The parser must see the proxy
    // own-enumerable keys and reject anything beyond the allowlist.
    const json = '{"id":"a","method":"notes.search","params":{"query":"x"}}';
    const proxied = new Proxy(JSON.parse(json) as Record<string, unknown>, {
      get(target, prop) {
        if (prop === "leak") return "smuggled";
        return (target as Record<string | symbol, unknown>)[prop];
      },
      ownKeys(target) {
        return [...Reflect.ownKeys(target), "leak"];
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === "leak") return { configurable: true, enumerable: true, value: "smuggled" };
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    const payload = new TextEncoder().encode(JSON.stringify(proxied));
    expect(() => parseRpcFrame(wrapFrame(payload))).toThrow(/rpc protocol/);
  });

  it("rejects duplicate JSON keys (last-wins is not accepted)", () => {
    // Manual string with the same key twice; spec requires strict dup detection.
    const dup = '{"id":"a","id":"b","method":"notes.search","params":{"query":"x"}}';
    const payload = new TextEncoder().encode(dup);
    expect(() => parseRpcFrame(wrapFrame(payload))).toThrow(/rpc protocol/);
  });

  it("rejects duplicate keys inside params", () => {
    const dup = '{"id":"a","method":"notes.search","params":{"query":"x","query":"y"}}';
    const payload = new TextEncoder().encode(dup);
    expect(() => parseRpcFrame(wrapFrame(payload))).toThrow(/rpc protocol/);
  });

  // -- Method / id / params allowlist --------------------------------------

  it("rejects an unknown method", () => {
    const json = '{"id":"a","method":"notes.delete","params":{"id":"x"}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects a method that looks like an existing CLI verb", () => {
    const json = '{"id":"a","method":"sync","params":{"type":"full"}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects a missing id", () => {
    const json = '{"method":"notes.search","params":{"query":"x"}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects a missing method", () => {
    const json = '{"id":"a","params":{"query":"x"}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects a missing params", () => {
    const json = '{"id":"a","method":"notes.search"}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects a non-string id", () => {
    const json = '{"id":42,"method":"notes.search","params":{"query":"x"}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects a non-string method", () => {
    const json = '{"id":"a","method":1,"params":{"query":"x"}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects a non-object params", () => {
    const json = '{"id":"a","method":"notes.search","params":"x"}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects unknown own field `path` (filesystem smuggling)", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":"x","path":"/etc/passwd"}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects unknown own field `database` (core smuggling)", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":"x","database":"db"}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects unknown own field `sync` (sync smuggling)", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":"x","sync":{"type":"full"}}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects unknown own field `credential` (credential smuggling)", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":"x","credential":"sekret"}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects unknown own field `core` at request root", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":"x"},"core":"invoke"}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  // -- Query value bounds ---------------------------------------------------

  it("rejects a non-string query", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":42}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects an empty query", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":""}}';
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("rejects an oversized UTF-8 query (byte length > maxQueryBytes)", () => {
    const tooLong = "x".repeat(STAGE5_RPC_LIMITS.maxQueryBytes + 1);
    const json = `{"id":"a","method":"notes.search","params":{"query":"${tooLong}"}}`;
    expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/rpc protocol/);
  });

  it("accepts a query that is exactly at the boundary (UTF-8 byte length == maxQueryBytes)", () => {
    // Single-byte ASCII to keep math simple.
    const boundary = "x".repeat(STAGE5_RPC_LIMITS.maxQueryBytes);
    const json = `{"id":"a","method":"notes.search","params":{"query":"${boundary}"}}`;
    const req = parseRpcFrame(wrapFrame(encode(json)));
    expect(req.method).toBe("notes.search");
    if (req.method !== "notes.search") throw new Error("unexpected method");
    expect(req.params.query.length).toBe(STAGE5_RPC_LIMITS.maxQueryBytes);
  });

  it("rejects an oversized UTF-8 query when Buffer.byteLength is forged", () => {
    const query = "é".repeat(Math.floor(STAGE5_RPC_LIMITS.maxQueryBytes / 2) + 1);
    expect(query.length).toBeLessThanOrEqual(STAGE5_RPC_LIMITS.maxQueryBytes);
    const json = `{"id":"a","method":"notes.search","params":{"query":"${query}"}}`;
    const byteLengthSpy = vi.spyOn(Buffer, "byteLength").mockReturnValue(0);

    try {
      expect(() => parseRpcFrame(wrapFrame(encode(json)))).toThrow(/maximum query bytes/);
    } finally {
      byteLengthSpy.mockRestore();
    }
  });

  // -- Happy path / shape contract -----------------------------------------

  it("parses a minimal valid notes.search request into a frozen null-prototype object", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":"hello"}}';
    const req: RpcRequest = parseRpcFrame(wrapFrame(encode(json)));
    expect(Object.isFrozen(req)).toBe(true);
    expect(Object.getPrototypeOf(req)).toBeNull();
    expect(req.id).toBe("a");
    expect(req.method).toBe("notes.search");
    if (req.method !== "notes.search") throw new Error("unexpected method");
    expect(req.params.query).toBe("hello");
  });

  it("freezes the nested params object too", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":"hello"}}';
    const req = parseRpcFrame(wrapFrame(encode(json)));
    expect(Object.isFrozen(req.params)).toBe(true);
    expect(Object.getPrototypeOf(req.params)).toBeNull();
  });

  it("rejects mutation of parsed fields", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":"hello"}}';
    const req = parseRpcFrame(wrapFrame(encode(json))) as unknown as {
      id: string;
      method: string;
      params: { query: string };
    };
    expect(() => {
      req.id = "b";
    }).toThrow(TypeError);
    expect(() => {
      req.params.query = "world";
    }).toThrow(TypeError);
  });

  it("never echoes the unknown method name into the thrown error", () => {
    const json = '{"id":"a","method":"definitely-a-secret-method-name-XYZ","params":{"query":"x"}}';
    let caught: unknown;
    try {
      parseRpcFrame(wrapFrame(encode(json)));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).not.toMatch(/definitely-a-secret-method-name-XYZ/);
  });

  it("never echoes the query value into the thrown error", () => {
    // The query is intentionally invalid (empty) so the parser rejects
    // it; the rejection message MUST NOT contain the query text.
    const json =
      '{"id":"a","method":"notes.search","params":{"query":"my-secret-query-7c1b","path":"/etc/passwd"}}';
    let caught: unknown;
    try {
      parseRpcFrame(wrapFrame(encode(json)));
    } catch (error) {
      caught = error;
    }
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).not.toMatch(/my-secret-query-7c1b/);
  });

  it("never echoes the path into the thrown error", () => {
    const json = '{"id":"a","method":"notes.search","params":{"query":"x","path":"/etc/passwd"}}';
    let caught: unknown;
    try {
      parseRpcFrame(wrapFrame(encode(json)));
    } catch (error) {
      caught = error;
    }
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).not.toMatch(/\/etc\/passwd/);
  });

  it("clears `cause` and `__context__` on every thrown RpcProtocolError", () => {
    let caught: unknown;
    try {
      parseRpcFrame(new Uint8Array(0));
    } catch (error) {
      caught = error;
    }
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    expect((caught as { __context__?: unknown }).__context__).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// serializeRpcResponse — the output boundary.
//
// The serializer accepts only the approved envelope shape; unknown /
// extra / inherited fields are rejected.  The response bytes are bounded
// by maxResponseBytes — the bound is enforced BEFORE serialization so
// a hostile caller cannot force unbounded allocation.
// ---------------------------------------------------------------------------

describe("serializeRpcResponse", () => {
  it("serializes a success envelope with the documented fields", () => {
    const envelope: RpcResponseEnvelope = {
      id: "a",
      ok: true,
      result: {
        kind: "search",
        notes: [{ title: "First" }, { title: "Second" }],
      } satisfies RpcSearchResult,
    };
    const bytes = serializeRpcResponse(envelope);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const decoded = decode(bytes);
    expect(decoded.id).toBe("a");
    expect(decoded.ok).toBe(true);
    expect(decoded.result?.kind).toBe("search");
    expect(decoded.result?.notes).toEqual([{ title: "First" }, { title: "Second" }]);
  });

  it("serializes a bounded delete result", () => {
    const bytes = serializeRpcResponse({
      id: "delete-rpc",
      ok: true,
      result: { kind: "delete", id: "note-1" },
    });
    expect(decode(bytes)).toEqual({
      id: "delete-rpc",
      ok: true,
      result: { kind: "delete", id: "note-1" },
    });
  });
  it("serializes notes as an array even when Array.prototype.toJSON is polluted", () => {
    const canary = "array-to-json-canary";
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    Object.defineProperty(Array.prototype, "toJSON", {
      configurable: true,
      enumerable: false,
      value: () => ({ leaked: canary }),
      writable: true,
    });

    try {
      const bytes = serializeRpcResponse({
        id: "a",
        ok: true,
        result: { kind: "search", notes: [{ title: "First" }] },
      });
      expect(new TextDecoder().decode(bytes.subarray(4))).not.toContain(canary);
      const decoded = decode(bytes);
      expect(Array.isArray(decoded.result?.notes)).toBe(true);
      expect(decoded.result?.notes).toEqual([{ title: "First" }]);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Array.prototype, "toJSON");
      } else {
        Object.defineProperty(Array.prototype, "toJSON", previous);
      }
    }
  });

  it("keeps the response exact when a title getter pollutes Object.prototype.toJSON", () => {
    const canary = "object-to-json-canary";
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const title = {} as { title: string };
    Object.defineProperty(title, "title", {
      configurable: true,
      enumerable: true,
      get: () => {
        Object.defineProperty(Object.prototype, "toJSON", {
          configurable: true,
          enumerable: false,
          value: () => ({ leaked: canary }),
          writable: true,
        });
        return "First";
      },
    });

    try {
      const bytes = serializeRpcResponse({
        id: "a",
        ok: true,
        result: { kind: "search", notes: [title] },
      });
      const decoded = decode(bytes);
      expect(decoded).toEqual({
        id: "a",
        ok: true,
        result: { kind: "search", notes: [{ title: "First" }] },
      });
      expect(new TextDecoder().decode(bytes.subarray(4))).not.toContain(canary);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Object.prototype, "toJSON");
      } else {
        Object.defineProperty(Object.prototype, "toJSON", previous);
      }
    }
  });

  it("serializes a categorical error envelope without echoing request data", () => {
    const envelope: RpcResponseEnvelope = {
      id: "a",
      ok: false,
      error: { code: "invalid_request", message: "Invalid request" },
    };
    const bytes = serializeRpcResponse(envelope);
    const decoded = decode(bytes);
    expect(decoded.id).toBe("a");
    expect(decoded.ok).toBe(false);
    expect(decoded.error?.code).toBe("invalid_request");
    expect(decoded.error?.message).toBe("Invalid request");
  });

  it("rejects arbitrary error codes and messages", () => {
    expect(() =>
      serializeRpcResponse({
        id: "a",
        ok: false,
        error: { code: "arbitrary_code", message: "arbitrary message" },
      }),
    ).toThrow(/rpc protocol/);
  });

  it("serializes every approved error code with its fixed message", () => {
    const approvedErrors = [
      ["invalid_request", "Invalid request"],
      ["permission_denied", "Permission denied"],
      ["service_unavailable", "Service unavailable"],
      ["sync_failed", "Sync failed"],
      ["vault_locked", "Vault locked"],
      ["not_found", "Not found"],
    ] as const;

    for (const [code, message] of approvedErrors) {
      const decoded = decode(
        serializeRpcResponse({ id: "a", ok: false, error: { code, message } }),
      );
      expect(decoded.error).toEqual({ code, message });
    }
  });

  it("rejects envelopes that carry `query` (request-value smuggling)", () => {
    const envelope = {
      id: "a",
      ok: true,
      result: { kind: "search", notes: [] },
      query: "smuggled",
    } as unknown as RpcResponseEnvelope;
    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
  });

  it("rejects envelopes that carry `path`", () => {
    const envelope = {
      id: "a",
      ok: true,
      result: { kind: "search", notes: [] },
      path: "/etc/passwd",
    } as unknown as RpcResponseEnvelope;
    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
  });

  it("rejects envelopes that carry `credential`", () => {
    const envelope = {
      id: "a",
      ok: true,
      result: { kind: "search", notes: [] },
      credential: "sekret",
    } as unknown as RpcResponseEnvelope;
    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
  });

  it("rejects unknown result discriminators", () => {
    const envelope = {
      id: "a",
      ok: true,
      result: { kind: "delete" },
    } as unknown as RpcResponseEnvelope;
    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
  });

  it("rejects search results that include ids (title-only invariant)", () => {
    const envelope = {
      id: "a",
      ok: true,
      result: {
        kind: "search",
        notes: [{ id: "n1", title: "First" }],
      },
    } as unknown as RpcResponseEnvelope;
    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
  });

  it("rejects search results that include bodies (title-only invariant)", () => {
    const envelope = {
      id: "a",
      ok: true,
      result: {
        kind: "search",
        notes: [{ title: "First", body: "secret note body" }],
      },
    } as unknown as RpcResponseEnvelope;
    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
  });

  it("caps hit count at maxSearchHits", () => {
    const many = Array.from({ length: STAGE5_RPC_LIMITS.maxSearchHits + 1 }, (_, i) => ({
      title: `Note ${i}`,
    }));
    const envelope: RpcResponseEnvelope = {
      id: "a",
      ok: true,
      result: { kind: "search", notes: many },
    };
    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
  });

  it("ignores a custom iterator and uses the bounded numeric notes length", () => {
    const notes: Array<{ title: string }> = [];
    Object.defineProperty(notes, Symbol.iterator, {
      configurable: true,
      value: () => {
        throw new Error("custom iterator must not run");
      },
    });
    const envelope: RpcResponseEnvelope = {
      id: "a",
      ok: true,
      result: { kind: "search", notes },
    };

    const output = serializeRpcResponse(envelope);
    expect(output).toBeInstanceOf(Uint8Array);
    expect(decode(output).result?.notes).toEqual([]);
  });

  it("rejects oversized title bytes (single hit exceeds maxTitleLength * 4)", () => {
    const longTitle = "x".repeat(STAGE5_RPC_LIMITS.maxQueryBytes + 1);
    const envelope: RpcResponseEnvelope = {
      id: "a",
      ok: true,
      result: { kind: "search", notes: [{ title: longTitle }] },
    };
    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
  });

  it("rejects an oversized UTF-16 title before calling Buffer.byteLength", () => {
    const title = "x".repeat(STAGE5_RPC_LIMITS.maxTitleBytes + 1);
    const byteLengthSpy = vi.spyOn(Buffer, "byteLength");

    try {
      expect(() =>
        serializeRpcResponse({
          id: "a",
          ok: true,
          result: { kind: "search", notes: [{ title }] },
        }),
      ).toThrow(/maximum title bytes/);
      expect(byteLengthSpy).not.toHaveBeenCalled();
    } finally {
      byteLengthSpy.mockRestore();
    }
  });

  it("retains the exact UTF-8 title byte bound after the UTF-16 preflight", () => {
    const title = "😀".repeat(Math.floor(STAGE5_RPC_LIMITS.maxTitleBytes / 4) + 1);
    expect(title.length).toBeLessThanOrEqual(STAGE5_RPC_LIMITS.maxTitleBytes);
    expect(() =>
      serializeRpcResponse({
        id: "a",
        ok: true,
        result: { kind: "search", notes: [{ title }] },
      }),
    ).toThrow(/maximum title bytes/);
  });

  it("rejects an oversized UTF-8 title when Buffer.byteLength is forged", () => {
    const title = "é".repeat(Math.floor(STAGE5_RPC_LIMITS.maxTitleBytes / 2) + 1);
    expect(title.length).toBeLessThanOrEqual(STAGE5_RPC_LIMITS.maxTitleBytes);
    const byteLengthSpy = vi.spyOn(Buffer, "byteLength").mockReturnValue(0);

    try {
      expect(() =>
        serializeRpcResponse({
          id: "a",
          ok: true,
          result: { kind: "search", notes: [{ title }] },
        }),
      ).toThrow(/maximum title bytes/);
    } finally {
      byteLengthSpy.mockRestore();
    }
  });

  it("rejects envelopes whose serialized bytes would exceed maxResponseBytes", () => {
    // Build a single hit whose title is just under the per-title byte
    // ceiling, but large enough to push the whole envelope past the
    // response cap.
    const bigTitle = "x".repeat(STAGE5_RPC_LIMITS.maxQueryBytes);
    const envelope: RpcResponseEnvelope = {
      id: "a",
      ok: true,
      result: {
        kind: "search",
        notes: Array.from({ length: STAGE5_RPC_LIMITS.maxSearchHits }, () => ({
          title: bigTitle,
        })),
      },
    };
    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
  });

  it("rejects a frozen envelope with extra own enumerable keys (proxy/inherited guard)", () => {
    const base: RpcResponseEnvelope = {
      id: "a",
      ok: true,
      result: { kind: "search", notes: [] },
    };
    const proxied = new Proxy(base, {
      ownKeys(target) {
        return [...Reflect.ownKeys(target), "leak"];
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === "leak") return { configurable: true, enumerable: true, value: "x" };
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
    expect(() => serializeRpcResponse(proxied)).toThrow(/rpc protocol/);
  });

  it("rejects approved response fields that are own but non-enumerable", () => {
    const envelope = { id: "a", ok: true, result: { kind: "search", notes: [] } };
    Object.defineProperty(envelope, "id", {
      configurable: true,
      enumerable: false,
      value: "a",
      writable: true,
    });

    const result = { kind: "search", notes: [] };
    Object.defineProperty(result, "kind", {
      configurable: true,
      enumerable: false,
      value: "search",
      writable: true,
    });

    const hit = { title: "First" };
    Object.defineProperty(hit, "title", {
      configurable: true,
      enumerable: false,
      value: "First",
      writable: true,
    });

    const error = { code: "invalid_request", message: "Invalid request" };
    Object.defineProperty(error, "code", {
      configurable: true,
      enumerable: false,
      value: "invalid_request",
      writable: true,
    });

    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
    expect(() => serializeRpcResponse({ id: "a", ok: true, result })).toThrow(/rpc protocol/);
    expect(() =>
      serializeRpcResponse({ id: "a", ok: true, result: { kind: "search", notes: [hit] } }),
    ).toThrow(/rpc protocol/);
    expect(() => serializeRpcResponse({ id: "a", ok: false, error })).toThrow(/rpc protocol/);
  });

  it("rejects sparse notes even when Array.prototype supplies an inherited numeric value", () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    Object.defineProperty(Array.prototype, "0", {
      configurable: true,
      enumerable: false,
      value: { title: "inherited" },
      writable: true,
    });

    try {
      const notes = new Array<{ title: string }>(1);
      expect(() =>
        serializeRpcResponse({
          id: "a",
          ok: true,
          result: { kind: "search", notes },
        }),
      ).toThrow(/rpc protocol/);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Array.prototype, "0");
      } else {
        Object.defineProperty(Array.prototype, "0", previous);
      }
    }
  });

  it("rejects inherited enumerable unknown fields on every response object layer", () => {
    const envelope = Object.assign(Object.create({ inheritedMarker: true }), {
      id: "a",
      ok: true,
      result: { kind: "search", notes: [] },
    });
    const result = Object.assign(Object.create({ inheritedMarker: true }), {
      kind: "search",
      notes: [],
    });
    const hit = Object.assign(Object.create({ inheritedMarker: true }), { title: "First" });
    const error = Object.assign(Object.create({ inheritedMarker: true }), {
      code: "invalid_request",
      message: "Invalid request",
    });

    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
    expect(() => serializeRpcResponse({ id: "a", ok: true, result })).toThrow(/rpc protocol/);
    expect(() =>
      serializeRpcResponse({ id: "a", ok: true, result: { kind: "search", notes: [hit] } }),
    ).toThrow(/rpc protocol/);
    expect(() => serializeRpcResponse({ id: "a", ok: false, error })).toThrow(/rpc protocol/);
  });

  it("rejects non-enumerable unknown fields on every response object layer", () => {
    const withHidden = <T extends object>(value: T): T => {
      Object.defineProperty(value, "hiddenMarker", {
        configurable: true,
        enumerable: false,
        value: true,
      });
      return value;
    };
    const envelope = withHidden({ id: "a", ok: true, result: { kind: "search", notes: [] } });
    const result = withHidden({ kind: "search", notes: [] });
    const hit = withHidden({ title: "First" });
    const error = withHidden({ code: "invalid_request", message: "Invalid request" });

    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
    expect(() => serializeRpcResponse({ id: "a", ok: true, result })).toThrow(/rpc protocol/);
    expect(() =>
      serializeRpcResponse({ id: "a", ok: true, result: { kind: "search", notes: [hit] } }),
    ).toThrow(/rpc protocol/);
    expect(() => serializeRpcResponse({ id: "a", ok: false, error })).toThrow(/rpc protocol/);
  });

  it("rejects symbol unknown fields on every response object layer", () => {
    const symbol = Symbol("unknown");
    const withSymbol = <T extends object>(value: T): T => {
      Object.defineProperty(value, symbol, { configurable: true, value: true });
      return value;
    };
    const envelope = withSymbol({ id: "a", ok: true, result: { kind: "search", notes: [] } });
    const result = withSymbol({ kind: "search", notes: [] });
    const hit = withSymbol({ title: "First" });
    const error = withSymbol({ code: "invalid_request", message: "Invalid request" });

    expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
    expect(() => serializeRpcResponse({ id: "a", ok: true, result })).toThrow(/rpc protocol/);
    expect(() =>
      serializeRpcResponse({ id: "a", ok: true, result: { kind: "search", notes: [hit] } }),
    ).toThrow(/rpc protocol/);
    expect(() => serializeRpcResponse({ id: "a", ok: false, error })).toThrow(/rpc protocol/);
  });

  it("rejects inherited non-enumerable unknown fields at every response layer", () => {
    const property = "nonEnumLeak";
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, property);
    Object.defineProperty(Object.prototype, property, {
      configurable: true,
      enumerable: false,
      value: true,
      writable: true,
    });

    try {
      const envelope = { id: "a", ok: true, result: { kind: "search", notes: [] } };
      const result = { kind: "search", notes: [] };
      const hit = { title: "First" };
      const error = { code: "invalid_request", message: "Invalid request" };

      expect(() => serializeRpcResponse(envelope)).toThrow(/rpc protocol/);
      expect(() => serializeRpcResponse({ id: "a", ok: true, result })).toThrow(/rpc protocol/);
      expect(() =>
        serializeRpcResponse({ id: "a", ok: true, result: { kind: "search", notes: [hit] } }),
      ).toThrow(/rpc protocol/);
      expect(() => serializeRpcResponse({ id: "a", ok: false, error })).toThrow(/rpc protocol/);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Object.prototype, property);
      } else {
        Object.defineProperty(Object.prototype, property, previous);
      }
    }
  });

  it("emits a length-prefixed frame whose declared length matches the payload", () => {
    const envelope: RpcResponseEnvelope = {
      id: "a",
      ok: true,
      result: { kind: "search", notes: [{ title: "First" }] },
    };
    const bytes = serializeRpcResponse(envelope);
    const declared = readFrameLength(bytes);
    expect(declared).toBe(bytes.length - 4);
  });

  it("writes the authoritative payload length despite a forged DataView setUint32", () => {
    const originalSetUint32 = DataView.prototype.setUint32;
    DataView.prototype.setUint32 = () => undefined;

    try {
      const bytes = serializeRpcResponse({
        id: "a",
        ok: true,
        result: { kind: "search", notes: [{ title: "First" }] },
      });
      expect(readFrameLength(bytes)).toBe(bytes.length - 4);
      expect(new TextDecoder().decode(bytes.subarray(4))).toContain('"First"');
    } finally {
      DataView.prototype.setUint32 = originalSetUint32;
    }
  });

  it("uses the intrinsic payload byte length despite a forged Uint8Array length", () => {
    const previousLength = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "length");
    Object.defineProperty(Uint8Array.prototype, "length", {
      configurable: true,
      value: 0,
    });

    let bytes: Uint8Array | undefined;
    try {
      bytes = serializeRpcResponse({
        id: "a",
        ok: true,
        result: { kind: "search", notes: [{ title: "First" }] },
      });
    } finally {
      if (previousLength === undefined) {
        Reflect.deleteProperty(Uint8Array.prototype, "length");
      } else {
        Object.defineProperty(Uint8Array.prototype, "length", previousLength);
      }
    }

    expect(bytes).toBeDefined();
    expect(readFrameLength(bytes as Uint8Array)).toBe((bytes as Uint8Array).length - 4);
    expect(decode(bytes as Uint8Array)).toEqual({
      id: "a",
      ok: true,
      result: { kind: "search", notes: [{ title: "First" }] },
    });
  });

  it("copies success and error payloads without dispatching Uint8Array.prototype.set", () => {
    const originalSet = Uint8Array.prototype.set;
    Uint8Array.prototype.set = () => undefined;

    try {
      expect(
        decode(
          serializeRpcResponse({
            id: "a",
            ok: true,
            result: { kind: "search", notes: [{ title: "First" }] },
          }),
        ),
      ).toEqual({
        id: "a",
        ok: true,
        result: { kind: "search", notes: [{ title: "First" }] },
      });
      expect(
        decode(
          serializeRpcResponse({
            id: "a",
            ok: false,
            error: { code: "invalid_request", message: "Invalid request" },
          }),
        ),
      ).toEqual({
        id: "a",
        ok: false,
        error: { code: "invalid_request", message: "Invalid request" },
      });
    } finally {
      Uint8Array.prototype.set = originalSet;
    }
  });

  it("round-trips a valid envelope through parseRpcFrame + serializeRpcResponse", () => {
    const request = parseRpcFrame(
      wrapFrame(encode('{"id":"a","method":"notes.search","params":{"query":"hello"}}')),
    );
    expect(request.id).toBe("a");

    const envelope: RpcResponseEnvelope = {
      id: request.id,
      ok: true,
      result: { kind: "search", notes: [{ title: "Hit" }] },
    };
    const bytes = serializeRpcResponse(envelope);
    const declared = readFrameLength(bytes);
    const payload = bytes.subarray(4, 4 + declared);
    const decoded = JSON.parse(new TextDecoder().decode(payload));
    expect(decoded.id).toBe("a");
    expect(decoded.ok).toBe(true);
    expect(decoded.result.notes).toEqual([{ title: "Hit" }]);
  });
});

// ---------------------------------------------------------------------------
// isRpcProtocolError — predicate must not be fooled by lookalike errors.
// ---------------------------------------------------------------------------

describe("isRpcProtocolError", () => {
  it("returns true for an RpcProtocolError instance", () => {
    let caught: unknown;
    try {
      parseRpcFrame(new Uint8Array(0));
    } catch (error) {
      caught = error;
    }
    expect(isRpcProtocolError(caught)).toBe(true);
  });

  it("returns false for a plain Error", () => {
    expect(isRpcProtocolError(new Error("nope"))).toBe(false);
  });

  it("returns false for a non-error object that mimics an Error shape", () => {
    expect(isRpcProtocolError({ name: "RpcProtocolError", message: "fake" })).toBe(false);
    expect(isRpcProtocolError(null)).toBe(false);
    expect(isRpcProtocolError(undefined)).toBe(false);
    expect(isRpcProtocolError("rpc protocol: foo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Security regression — preflight response-size guard.
//
// The serializer previously called JSON.stringify on every response
// envelope and only checked `maxResponseBytes` AFTER stringify built the
// payload.  A multi-megabyte hostile `id` / `code` / `message` would
// therefore force a multi-megabyte allocation before being rejected.
// These tests prove the new preflight rejects oversized inputs BEFORE
// any stringify-sized allocation can occur, using a deterministic spy
// on `JSON.stringify` and bounded inputs (no giant memory waste).
// ---------------------------------------------------------------------------

describe("security regression: preflight response-size guard", () => {
  // The deterministic seam: spy on JSON.stringify so the test can
  // assert whether stringify ran at all.  Any successful stringify
  // means a payload-sized allocation has already happened, which is
  // exactly what the preflight must prevent.

  // The vi.SpyInstance type is intentionally avoided here so the test
  // file stays free of vitest internal generics; the spy is consumed
  // only through its public MockInstance API below.
  function withStringifySpy(body: (spy: { mock: { calls: unknown[][] } }) => void): void {
    const spy = vi.spyOn(JSON, "stringify") as unknown as {
      mock: { calls: unknown[][] };
    };
    try {
      body(spy);
    } finally {
      vi.mocked(JSON.stringify).mockRestore();
    }
  }

  it("rejects an oversized success id BEFORE JSON.stringify allocates", () => {
    // The smallest input that triggers the per-field preflight bound:
    // one byte over the response cap.  This exercises the same code
    // path that would reject a multi-megabyte hostile id, without
    // actually allocating multi-megabytes.
    const oversized = "x".repeat(STAGE5_RPC_LIMITS.maxResponseBytes + 1);
    withStringifySpy((stringifySpy) => {
      expect(() =>
        serializeRpcResponse({
          id: oversized,
          ok: true,
          result: { kind: "search", notes: [] },
        }),
      ).toThrow(/rpc protocol/);
      // Preflight must reject before stringify runs at all.
      expect(stringifySpy).not.toHaveBeenCalled();
    });
  });

  it("rejects an oversized error code BEFORE JSON.stringify allocates", () => {
    const oversized = "x".repeat(STAGE5_RPC_LIMITS.maxResponseBytes + 1);
    withStringifySpy((stringifySpy) => {
      expect(() =>
        serializeRpcResponse({
          id: "a",
          ok: false,
          error: { code: oversized, message: "m" },
        }),
      ).toThrow(/rpc protocol/);
      expect(stringifySpy).not.toHaveBeenCalled();
    });
  });

  it("rejects an oversized error message BEFORE JSON.stringify allocates", () => {
    const oversized = "x".repeat(STAGE5_RPC_LIMITS.maxResponseBytes + 1);
    withStringifySpy((stringifySpy) => {
      expect(() =>
        serializeRpcResponse({
          id: "a",
          ok: false,
          error: { code: "c", message: oversized },
        }),
      ).toThrow(/rpc protocol/);
      expect(stringifySpy).not.toHaveBeenCalled();
    });
  });

  it("rejects when the raw UTF-8 sum of response-owned strings exceeds the response cap, BEFORE JSON.stringify allocates", () => {
    // Build a sum-of-fields envelope where each individual field is
    // within the per-field bound, but the conservative total exceeds
    // maxResponseBytes.  This exercises the sum-of-fields preflight.
    // Each title is at maxTitleBytes (256); 64 hits maxes the count;
    // the id is sized so the raw sum crosses the response cap.
    const titles = Array.from({ length: STAGE5_RPC_LIMITS.maxSearchHits }, () => ({
      title: "t".repeat(STAGE5_RPC_LIMITS.maxTitleBytes),
    }));
    const idSizer = STAGE5_RPC_LIMITS.maxResponseBytes; // 65536-byte id is right at the per-field boundary
    withStringifySpy((stringifySpy) => {
      expect(() =>
        serializeRpcResponse({
          id: "i".repeat(idSizer),
          ok: true,
          result: { kind: "search", notes: titles },
        }),
      ).toThrow(/rpc protocol/);
      expect(stringifySpy).not.toHaveBeenCalled();
    });
  });

  it("bounds the preflight walk with a cheap UTF-16 .length cap (rejects without Buffer.byteLength walk on a 4x-overlength string)", () => {
    // A string whose UTF-16 .length is over the cheap cap (maxResponseBytes *6).
    // The preflight must reject before the Buffer.byteLength walk runs.
    // We use a string of length maxResponseBytes *7 (458,752 UTF-16 units)
    // which is over the cheap cap and must short-circuit immediately.
    const huge = "x".repeat(STAGE5_RPC_LIMITS.maxResponseBytes * 7);
    withStringifySpy((stringifySpy) => {
      expect(() =>
        serializeRpcResponse({
          id: huge,
          ok: true,
          result: { kind: "search", notes: [] },
        }),
      ).toThrow(/rpc protocol/);
      expect(stringifySpy).not.toHaveBeenCalled();
    });
  });

  it("never echoes the offending response field value into the thrown error", () => {
    const sentinel = "hostile-id-marker-9F2C";
    const oversized = sentinel + "x".repeat(STAGE5_RPC_LIMITS.maxResponseBytes);
    let caught: unknown;
    try {
      serializeRpcResponse({
        id: oversized,
        ok: true,
        result: { kind: "search", notes: [] },
      });
    } catch (error) {
      caught = error;
    }
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).not.toMatch(/hostile-id-marker-9F2C/);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    expect((caught as { __context__?: unknown }).__context__).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Security regression — hostile Proxy / getter inputs.
//
// `parseRpcFrame` and `serializeRpcResponse` both perform property
// access on inputs.  A hostile Proxy whose `get` trap throws must NOT
// leak the raw error: the boundary must normalize it to an
// RpcProtocolError with `cause` and `__context__` cleared, and without
// echoing the hostile message.
// ---------------------------------------------------------------------------

describe("security regression: hostile Proxy / getter inputs", () => {
  function catchThrown(body: () => unknown): unknown {
    try {
      body();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it("parseRpcFrame normalizes hostile getter errors to RpcProtocolError", () => {
    // A Proxy that wraps a real Uint8Array so the `instanceof` check
    // passes, but whose `length` getter throws with a hostile message.
    const hostile = new Proxy(new Uint8Array(8), {
      get(target, prop) {
        if (prop === "length") {
          throw new TypeError("hostile-getter-boom: secret=42");
        }
        return Reflect.get(target, prop);
      },
    });
    const caught = catchThrown(() => parseRpcFrame(hostile as unknown as Uint8Array));
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).not.toMatch(/hostile-getter-boom/);
    expect((caught as Error).message).not.toMatch(/secret=42/);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    expect((caught as { __context__?: unknown }).__context__).toBeUndefined();
  });

  it("parseRpcFrame normalizes hostile getter errors during payload decode", () => {
    // A Proxy whose `subarray` getter throws (covers the body of the
    // parser after the type check has already passed).
    const hostile = new Proxy(new Uint8Array(8), {
      get(target, prop) {
        if (prop === "subarray") {
          throw new RangeError("hostile-subarray-boom: token=ABCDEF");
        }
        return Reflect.get(target, prop);
      },
    });
    const caught = catchThrown(() => parseRpcFrame(hostile as unknown as Uint8Array));
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).not.toMatch(/hostile-subarray-boom/);
    expect((caught as Error).message).not.toMatch(/token=ABCDEF/);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    expect((caught as { __context__?: unknown }).__context__).toBeUndefined();
  });

  it("serializeRpcResponse normalizes hostile getter errors on the envelope root", () => {
    // A Proxy whose `id` getter throws with a hostile message.
    const base = {
      ok: true,
      result: { kind: "search", notes: [] },
    };
    const hostile = new Proxy(base, {
      get(target, prop) {
        if (prop === "id") {
          throw new TypeError("hostile-envelope-boom: credential=hunter2");
        }
        return Reflect.get(target, prop);
      },
    });
    const caught = catchThrown(() =>
      serializeRpcResponse(hostile as unknown as RpcResponseEnvelope),
    );
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).not.toMatch(/hostile-envelope-boom/);
    expect((caught as Error).message).not.toMatch(/credential=hunter2/);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    expect((caught as { __context__?: unknown }).__context__).toBeUndefined();
  });

  it("serializeRpcResponse normalizes hostile getter errors inside result.notes[i].title", () => {
    // A Proxy wrapping a hit whose `title` getter throws.
    const notes = [
      new Proxy(
        { title: "ok" },
        {
          get(target, prop) {
            if (prop === "title") {
              throw new Error("hostile-title-getter-boom: note-corpus=secret");
            }
            return Reflect.get(target, prop);
          },
        },
      ),
    ];
    const envelope = {
      id: "a",
      ok: true,
      result: { kind: "search", notes },
    };
    const caught = catchThrown(() =>
      serializeRpcResponse(envelope as unknown as RpcResponseEnvelope),
    );
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).not.toMatch(/hostile-title-getter-boom/);
    expect((caught as Error).message).not.toMatch(/note-corpus=secret/);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    expect((caught as { __context__?: unknown }).__context__).toBeUndefined();
  });

  it("serializeRpcResponse normalizes hostile JSON.stringify failures (Proxy toJSON throws on the envelope id)", () => {
    // The serializer reconstructs the response payload from primitives
    // (id, title, code, message).  None of those primitives are user
    // objects, so the standard toJSON surface never gets serialized.
    // However, a future change to the serializer that serializes the
    // envelope directly would expose this attack; cover the wrapper
    // contract anyway by checking that an envelope whose id getter
    // throws inside the JSON.stringify path is still normalized.
    //
    // We trigger stringify on a hostile getter that throws only when
    // JSON.stringify recursively walks the envelope: Object.keys on a
    // proxy with ownKeys that throws has the same effect, and the
    // serializer does call Object.keys on the envelope root.
    const hostile = new Proxy(
      { id: "a", ok: true, result: { kind: "search", notes: [] } },
      {
        ownKeys() {
          throw new RangeError("hostile-ownkeys-boom: api-key=XYZ");
        },
        getOwnPropertyDescriptor() {
          throw new RangeError("hostile-ownkeys-boom: api-key=XYZ");
        },
      },
    );
    const caught = catchThrown(() =>
      serializeRpcResponse(hostile as unknown as RpcResponseEnvelope),
    );
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).not.toMatch(/hostile-ownkeys-boom/);
    expect((caught as Error).message).not.toMatch(/api-key=XYZ/);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    expect((caught as { __context__?: unknown }).__context__).toBeUndefined();
  });

  it("passes through existing parseRpcFrame RpcProtocolError messages unchanged (no double-wrap)", () => {
    // The empty Uint8Array triggers the "frame missing length prefix"
    // rejection (the first categorical rejection the parser hits).
    // The boundary must preserve the original message verbatim.
    const caught = catchThrown(() => parseRpcFrame(new Uint8Array(0)));
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/rpc protocol/);
    expect((caught as Error).message).toMatch(/frame missing length prefix/);
  });

  it("passes through existing parseRpcFrame 'not a Uint8Array' messages unchanged (no double-wrap)", () => {
    // Non-Uint8Array input triggers the first categorical rejection
    // in parseRpcFrame.  The boundary must preserve the original
    // message verbatim and not re-wrap it as a generic boundary failure.
    const caught = catchThrown(() => parseRpcFrame("not bytes" as unknown as Uint8Array));
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/input must be a Uint8Array/);
  });

  it("passes through existing serializeRpcResponse RpcProtocolError messages unchanged (no double-wrap)", () => {
    const caught = catchThrown(() =>
      // missing required `result`/`error` field on a true envelope.
      serializeRpcResponse({
        id: "a",
        ok: true,
      } as unknown as RpcResponseEnvelope),
    );
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/unexpected fields/);
  });

  it("reconstructs a marked error from its canonical message after hostile mutation", () => {
    let marked: Error | undefined;
    try {
      parseRpcFrame(new Uint8Array(0));
    } catch (error) {
      marked = error as Error;
    }
    expect(marked).toBeDefined();
    marked!.message = "hostile mutated protocol error";
    Object.defineProperty(marked, "cause", {
      configurable: true,
      value: "hostile cause",
    });
    Object.defineProperty(marked, "__context__", {
      configurable: true,
      value: "hostile context",
    });

    const hostile = new Proxy(
      { id: "a", ok: true, result: { kind: "search", notes: [] } },
      {
        get(target, prop, receiver) {
          if (prop === "id") throw marked;
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const caught = catchThrown(() => serializeRpcResponse(hostile));

    expect(caught).not.toBe(marked);
    expect(isRpcProtocolError(caught)).toBe(true);
    expect((caught as Error).message).toBe("rpc protocol: frame missing length prefix");
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    expect((caught as { __context__?: unknown }).__context__).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Security regressions — intrinsic capture and parser hardening.
// ---------------------------------------------------------------------------

describe("security regression: closed-boundary intrinsic capture", () => {
  it("keeps parsing and serialization on the captured Uint8Array after the global is forged", () => {
    const originalUint8Array = globalThis.Uint8Array;
    const frame = wrapFrame(encode('{"id":"a","method":"notes.search","params":{"query":"x"}}'));

    class ForgedUint8Array extends originalUint8Array {}
    globalThis.Uint8Array = ForgedUint8Array as typeof Uint8Array;

    let request: RpcRequest | undefined;
    let bytes: Uint8Array | undefined;
    try {
      request = parseRpcFrame(frame);
      bytes = serializeRpcResponse({
        id: "a",
        ok: true,
        result: { kind: "search", notes: [{ title: "First" }] },
      });
    } finally {
      globalThis.Uint8Array = originalUint8Array;
    }

    expect(request?.method).toBe("notes.search");
    if (request?.method === "notes.search") expect(request.params.query).toBe("x");
    expect(bytes).toBeInstanceOf(originalUint8Array);
    expect(decode(bytes as Uint8Array).result?.notes).toEqual([{ title: "First" }]);
  });

  it("keeps protocol errors on the captured Error constructor after the global is forged", () => {
    const originalError = globalThis.Error;
    const originalUint8Array = globalThis.Uint8Array;
    class ForgedError extends originalError {
      constructor(message?: string) {
        super(`forged:${message ?? ""}`);
      }
    }
    globalThis.Error = ForgedError as typeof Error;

    let caught: unknown;
    try {
      try {
        parseRpcFrame(new originalUint8Array(0));
      } catch (error) {
        caught = error;
      }
    } finally {
      globalThis.Error = originalError;
    }

    expect(isRpcProtocolError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(originalError);
    expect((caught as Error).message).toBe("rpc protocol: frame missing length prefix");
  });

  it("keeps parsed requests frozen with null prototypes when Object.assign is forged", () => {
    const originalAssign = Object.assign;
    Object.assign = ((target: object, source: object) => source) as typeof Object.assign;

    let request: RpcRequest | undefined;
    try {
      request = parseRpcFrame(
        wrapFrame(encode('{"id":"a","method":"notes.search","params":{"query":"x"}}')),
      );
    } finally {
      Object.assign = originalAssign;
    }

    expect(request).toBeDefined();
    expect(Object.isFrozen(request as RpcRequest)).toBe(true);
    expect(Object.getPrototypeOf(request as RpcRequest)).toBeNull();
    expect(Object.isFrozen((request as RpcRequest).params)).toBe(true);
    expect(Object.getPrototypeOf((request as RpcRequest).params)).toBeNull();
  });

  it("uses the intrinsic JSON serializer when JSON.stringify is forged", () => {
    const originalStringify = JSON.stringify;
    JSON.stringify = (() => '"forged"') as typeof JSON.stringify;

    let bytes: Uint8Array | undefined;
    try {
      bytes = serializeRpcResponse({
        id: "a",
        ok: true,
        result: { kind: "search", notes: [{ title: "First" }] },
      });
    } finally {
      JSON.stringify = originalStringify;
    }

    expect(decode(bytes as Uint8Array)).toEqual({
      id: "a",
      ok: true,
      result: { kind: "search", notes: [{ title: "First" }] },
    });
  });

  it("uses the intrinsic Buffer.from when Buffer.from is forged", () => {
    const originalFrom = Buffer.from;
    Buffer.from = (() => originalFrom("forged")) as typeof Buffer.from;

    let bytes: Uint8Array | undefined;
    try {
      bytes = serializeRpcResponse({
        id: "a",
        ok: true,
        result: { kind: "search", notes: [{ title: "First" }] },
      });
    } finally {
      Buffer.from = originalFrom;
    }

    expect(decode(bytes as Uint8Array)).toEqual({
      id: "a",
      ok: true,
      result: { kind: "search", notes: [{ title: "First" }] },
    });
  });

  it("defeats a forged Object.setPrototypeOf and inherited array toJSON", () => {
    const originalSetPrototypeOf = Object.setPrototypeOf;
    const previousToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    Object.setPrototypeOf = (() => undefined) as typeof Object.setPrototypeOf;
    Object.defineProperty(Array.prototype, "toJSON", {
      configurable: true,
      enumerable: false,
      value: () => ({ leaked: "forged-array" }),
      writable: true,
    });

    let bytes: Uint8Array | undefined;
    try {
      bytes = serializeRpcResponse({
        id: "a",
        ok: true,
        result: { kind: "search", notes: [{ title: "First" }] },
      });
    } finally {
      Object.setPrototypeOf = originalSetPrototypeOf;
      if (previousToJson === undefined) {
        Reflect.deleteProperty(Array.prototype, "toJSON");
      } else {
        Object.defineProperty(Array.prototype, "toJSON", previousToJson);
      }
    }

    expect(new TextDecoder().decode((bytes as Uint8Array).subarray(4))).not.toContain(
      "forged-array",
    );
    expect(decode(bytes as Uint8Array).result?.notes).toEqual([{ title: "First" }]);
  });

  it("never consults a custom notes iterator", () => {
    const notes = [{ title: "First" }];
    Object.defineProperty(notes, Symbol.iterator, {
      configurable: true,
      value: () => {
        throw new Error("custom iterator must not run");
      },
    });

    const bytes = serializeRpcResponse({
      id: "a",
      ok: true,
      result: { kind: "search", notes },
    });
    expect(decode(bytes).result?.notes).toEqual([{ title: "First" }]);
  });

  it("bounds notes numerically when Array.prototype iteration is forged", () => {
    const originalIterator = Array.prototype[Symbol.iterator];
    Array.prototype[Symbol.iterator] = (() => {
      throw new Error("forged iterator must not run");
    }) as unknown as typeof originalIterator;

    let bytes: Uint8Array | undefined;
    try {
      bytes = serializeRpcResponse({
        id: "a",
        ok: true,
        result: { kind: "search", notes: [{ title: "First" }] },
      });
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }

    expect(decode(bytes as Uint8Array).result?.notes).toEqual([{ title: "First" }]);
  });

  it("uses intrinsic String.charCodeAt for UTF-8 limits", () => {
    const originalCharCodeAt = String.prototype.charCodeAt;
    String.prototype.charCodeAt = (() => 0) as typeof String.prototype.charCodeAt;

    try {
      const title = "é".repeat(Math.floor(STAGE5_RPC_LIMITS.maxTitleBytes / 2) + 1);
      expect(() =>
        serializeRpcResponse({
          id: "a",
          ok: true,
          result: { kind: "search", notes: [{ title }] },
        }),
      ).toThrow(/maximum title bytes/);
    } finally {
      String.prototype.charCodeAt = originalCharCodeAt;
    }
  });

  it("uses the intrinsic TextDecoder.decode with fatal UTF-8 validation", () => {
    const originalDecode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = (() => "") as typeof TextDecoder.prototype.decode;

    let request: RpcRequest | undefined;
    try {
      request = parseRpcFrame(
        wrapFrame(encode('{"id":"a","method":"notes.search","params":{"query":"x"}}')),
      );
    } finally {
      TextDecoder.prototype.decode = originalDecode;
    }

    expect(request?.method).toBe("notes.search");
    if (request?.method === "notes.search") expect(request.params.query).toBe("x");
  });

  it("detects duplicate keys with the intrinsic hasOwnProperty", () => {
    const originalHasOwnProperty = Object.prototype.hasOwnProperty;
    Object.prototype.hasOwnProperty = (() => false) as typeof Object.prototype.hasOwnProperty;

    try {
      expect(() =>
        parseRpcFrame(
          wrapFrame(encode('{"id":"a","id":"b","method":"notes.search","params":{"query":"x"}}')),
        ),
      ).toThrow(/duplicate JSON key/);
    } finally {
      Object.prototype.hasOwnProperty = originalHasOwnProperty;
    }
  });

  it("uses intrinsic Object.keys for closed request validation", () => {
    const originalKeys = Object.keys;
    Object.keys = (() => []) as typeof Object.keys;

    let request: RpcRequest | undefined;
    try {
      request = parseRpcFrame(
        wrapFrame(encode('{"id":"a","method":"notes.search","params":{"query":"x"}}')),
      );
    } finally {
      Object.keys = originalKeys;
    }

    expect(request?.id).toBe("a");
  });

  it("uses the intrinsic WeakSet.has for protocol-error identification", () => {
    const originalHas = WeakSet.prototype.has;
    WeakSet.prototype.has = (() => false) as typeof WeakSet.prototype.has;

    let caught: unknown;
    try {
      try {
        parseRpcFrame(new Uint8Array(0));
      } catch (error) {
        caught = error;
      }
      expect(isRpcProtocolError(caught)).toBe(true);
    } finally {
      WeakSet.prototype.has = originalHas;
    }
  });

  it("rejects a number with a missing fraction digit", () => {
    expect(() =>
      parseRpcFrame(wrapFrame(encode('{"id":"a","method":"notes.search","params":{"query":1.}}'))),
    ).toThrow(/payload is not valid JSON/);
  });

  it("rejects a number with a missing exponent digit", () => {
    expect(() =>
      parseRpcFrame(
        wrapFrame(encode('{"id":"a","method":"notes.search","params":{"query":1.e2}}')),
      ),
    ).toThrow(/payload is not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decode(bytes: Uint8Array): {
  id: string;
  ok: boolean;
  result?: { kind: string; notes: Array<{ title: string }> };
  error?: { code: string; message: string };
} {
  const declared = readFrameLength(bytes);
  const payload = bytes.subarray(4, 4 + declared);
  return JSON.parse(new TextDecoder().decode(payload));
}

function wrapFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.length);
  writeFrameLength(frame, payload.length);
  frame.set(payload, 4);
  return frame;
}

function readFrameLength(bytes: Uint8Array): number {
  return (
    (((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0)) >>>
    0
  );
}

function writeFrameLength(frame: Uint8Array, length: number): void {
  frame[0] = (length >>> 24) & 0xff;
  frame[1] = (length >>> 16) & 0xff;
  frame[2] = (length >>> 8) & 0xff;
  frame[3] = length & 0xff;
}

// Force `Buffer` to be referenced so the import is not tree-shaken — the
// slice is intentionally pure but the test mirrors the planned wire shape.
void Buffer;
