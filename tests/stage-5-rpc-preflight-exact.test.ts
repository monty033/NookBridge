/** R16: exact JSON-encoded byte accounting for the response preflight (synthetic data only). */
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { handleRpcRequest, type RpcHandlerRuntimeLike } from "../src/service/rpc-handler.js";
import {
  fitsResponsePreflight,
  jsonStringUtf8Bytes,
  serializeRpcResponse,
  STAGE5_RPC_LIMITS,
  type RpcRequest,
} from "../src/service/rpc-protocol.js";

const MAX = STAGE5_RPC_LIMITS.maxResponseBytes;
const OVERHEAD = 1024;
const REVISION = "rev_0123456789abcdef0123456789abcdef";
const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");
const actualJsonBytes = (value: string): number => byteLength(JSON.stringify(value)) - 2;

const classes: ReadonlyArray<readonly [string, string]> = [
  ["double quote", '"'],
  ["backslash", "\\"],
  ["short escapes", "\b\f\n\r\t"],
  ["U+0001", "\u0001"],
  ["U+001F", "\u001f"],
  ["U+007F", "\u007f"],
  ["U+0080", "\u0080"],
  ["U+07FF", "߿"],
  ["U+0800", "ࠀ"],
  ["U+2028", " "],
  ["U+FFFF", "￿"],
  ["valid surrogate pair", "😀"],
  ["lone high surrogate", "\ud83d"],
  ["lone low surrogate", "\ude00"],
  ["reversed pair", "\ude00\ud83d"],
];

const noteRuntime = (data: string, extra: Partial<RpcHandlerRuntimeLike> = {}) =>
  ({
    search: async () => [],
    noteMetadata: async (id: string) => ({ id, title: "Memo", revision: REVISION }),
    readOnly: { readOperatorNoteContent: vi.fn(async () => ({ type: "html" as const, data })) },
    ...extra,
  }) as RpcHandlerRuntimeLike;

const getRequest = (id: string) =>
  ({ id, method: "notes.get", params: { id: "note-1" } }) as unknown as RpcRequest;

const htmlOf = (markdownLength: number): string => `<p>${"a".repeat(markdownLength)}</p>`;

/** Bytes charged by the serializer for everything except the Markdown. */
function fixedBytes(requestId: string): number {
  return byteLength(requestId) + byteLength("note-1") + byteLength("Memo") + byteLength(REVISION);
}

describe("jsonStringUtf8Bytes", () => {
  it.each(classes)("matches JSON.stringify for %s", (_name, s) => {
    for (const candidate of [s, s.repeat(7), `a${s}b`]) {
      expect(jsonStringUtf8Bytes(candidate, MAX)).toBe(actualJsonBytes(candidate));
    }
  });

  it("matches JSON.stringify for 2,000 seeded random mixed strings", () => {
    let seed = 0x2545f491;
    const next = (): number => {
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed;
    };
    const pool = [0x22, 0x5c, 0x08, 0x0a, 0x01, 0x1f, 0x41, 0x7f, 0x80, 0x7ff, 0x800, 0x2028];
    for (let n = 0; n < 2000; n += 1) {
      const length = next() % 40;
      let s = "";
      for (let i = 0; i < length; i += 1) {
        const roll = next() % 4;
        if (roll === 0) s += String.fromCharCode(pool[next() % pool.length] as number);
        else if (roll === 1) s += String.fromCharCode(0xd800 + (next() % 0x800));
        else if (roll === 2) s += String.fromCodePoint(0x10000 + (next() % 0xfffff));
        else s += String.fromCharCode(next() % 0x10000);
      }
      const bytes = jsonStringUtf8Bytes(s, MAX);
      expect(bytes).toBe(actualJsonBytes(s));
      expect(bytes).toBeGreaterThanOrEqual(s.length);
    }
  });

  it("stops past the budget and rejects over-length strings", () => {
    expect(jsonStringUtf8Bytes("\u0001".repeat(100), 10)).toBeGreaterThan(10);
    const huge = "x".repeat(MAX + 1);
    expect(jsonStringUtf8Bytes(huge, MAX)).toBeGreaterThan(MAX);
    expect(fitsResponsePreflight([huge])).toBe(false);
    expect(() =>
      serializeRpcResponse({ id: huge, ok: true, result: { kind: "search", notes: [] } }),
    ).toThrow(/rpc protocol/);
    // That no JSON.stringify call happens is asserted non-vacuously in
    // stage-5-rpc-preflight-no-stringify.test.ts, which patches it before import.
  });
});

describe("fitsResponsePreflight boundary", () => {
  it("fits 10,752 U+0001 units and 10,752 lone surrogates, not 10,753", () => {
    for (const unit of ["\u0001", "\ud83d"]) {
      expect(fitsResponsePreflight([unit.repeat(10_752)])).toBe(true);
      expect(fitsResponsePreflight([unit.repeat(10_753)])).toBe(false);
    }
  });

  it.each(classes)("agrees with serializeRpcResponse near the cap for %s", (_name, s) => {
    // Repeats can merge across the boundary (a reversed pair forms valid
    // pairs), so find the largest fitting repeat count by measurement.
    const limit = MAX - OVERHEAD;
    let fitting = Math.floor(limit / actualJsonBytes(s));
    while (actualJsonBytes(s.repeat(fitting + 1)) <= limit) fitting += 1;
    while (actualJsonBytes(s.repeat(fitting)) > limit) fitting -= 1;
    for (const repeats of [fitting - 1, fitting, fitting + 1]) {
      const id = s.repeat(repeats);
      let serializes = true;
      try {
        serializeRpcResponse({ id, ok: true, result: { kind: "search", notes: [] } });
      } catch {
        serializes = false;
      }
      expect(fitsResponsePreflight([id])).toBe(serializes);
    }
    expect(fitsResponsePreflight([s.repeat(fitting)])).toBe(true);
    expect(fitsResponsePreflight([s.repeat(fitting + 1)])).toBe(false);
  });
});

describe("fitsResponsePreflight with array structure", () => {
  // 10 notebooks of 256-quote ids/titles (1,024 string bytes each) behind a
  // 54,200-character request id: 54,200 + 10,240 = 64,440 string bytes, so
  // the flat 1,024 allowance fits but 10 x 100 structure bytes (allowance
  // 1,160) does not.
  const quote = '"'.repeat(256);
  const requestId = "r".repeat(54_200);
  const notebooks = Array.from({ length: 10 }, () => ({
    id: quote,
    title: quote,
    dateCreated: 1.5e18,
    dateModified: 1.5e18,
  }));
  const fields = [requestId, ...notebooks.flatMap((n) => [n.id, n.title])];

  it("agrees with the serializer once structure is supplied", () => {
    expect(fitsResponsePreflight(fields)).toBe(true);
    expect(fitsResponsePreflight(fields, 10 * 100)).toBe(false);
    expect(() =>
      serializeRpcResponse({ id: requestId, ok: true, result: { kind: "notebooks", notebooks } }),
    ).toThrow(/rpc protocol/);
  });

  it("keeps the 1,024 floor for small structure", () => {
    expect(fitsResponsePreflight(["a"], 100)).toBe(true);
    expect(fitsResponsePreflight(["a".repeat(MAX - OVERHEAD)], 100)).toBe(true);
    expect(fitsResponsePreflight(["a".repeat(MAX - OVERHEAD + 1)], 100)).toBe(false);
  });
});

describe("notes.get exact accounting", () => {
  it("returns ok for an ~11 KB pure-ASCII note", async () => {
    const response = await handleRpcRequest(getRequest("get-1"), noteRuntime(htmlOf(11_000)));
    expect(response).toMatchObject({ ok: true, result: { kind: "note", contentStatus: "ok" } });
    expect(() => serializeRpcResponse(response)).not.toThrow();
  });

  it("is ok at exactly id + metadata + Markdown + 1,024 = 65,536 and oversize one byte more", async () => {
    const requestId = "get-1";
    const markdownLength = MAX - OVERHEAD - fixedBytes(requestId);
    const exact = await handleRpcRequest(
      getRequest(requestId),
      noteRuntime(htmlOf(markdownLength)),
    );
    expect(exact).toMatchObject({ ok: true, result: { contentStatus: "ok" } });
    if (!exact.ok || exact.result.kind !== "note") throw new Error("expected note result");
    expect(exact.result.markdown).toHaveLength(markdownLength);
    expect(() => serializeRpcResponse(exact)).not.toThrow();

    const over = await handleRpcRequest(
      getRequest(requestId),
      noteRuntime(htmlOf(markdownLength + 1)),
    );
    expect(over).toMatchObject({ ok: true, result: { contentStatus: "oversize" } });
    expect(() => serializeRpcResponse(over)).not.toThrow();
  });

  it("charges the request id: a long id degrades to oversize, never a protocol error", async () => {
    const longId = "r".repeat(300);
    // Fits if the request id were ignored, but not once its 300 bytes count.
    const markdownLength = MAX - OVERHEAD - fixedBytes("") - 100;
    const response = await handleRpcRequest(
      getRequest(longId),
      noteRuntime(htmlOf(markdownLength)),
    );
    expect(response).toMatchObject({
      id: longId,
      ok: true,
      result: { kind: "note", contentStatus: "oversize" },
    });
    expect(() => serializeRpcResponse(response)).not.toThrow();
  });
});

describe("notes.get request id at the echo limit", () => {
  // The oversize envelope echoes the request id plus note id, title and
  // revision, so it fits only while id + metadata + 1,024 <= 65,536.
  const limit = MAX - OVERHEAD - fixedBytes("");

  it("still degrades to oversize and serializes at the longest echoable id", async () => {
    const requestId = "r".repeat(limit);
    const response = await handleRpcRequest(getRequest(requestId), noteRuntime(htmlOf(10)));
    expect(response).toMatchObject({ ok: true, result: { contentStatus: "oversize" } });
    expect(() => serializeRpcResponse(response)).not.toThrow();
  });

  it("cannot be echoed one character longer: the serializer rejects (connection closes)", async () => {
    const requestId = "r".repeat(limit + 1);
    const response = await handleRpcRequest(getRequest(requestId), noteRuntime(htmlOf(10)));
    expect(response).toMatchObject({ ok: true, result: { contentStatus: "oversize" } });
    expect(() => serializeRpcResponse(response)).toThrow(/rpc protocol/);
  });
});

describe("operator view and preimage responses", () => {
  const markdown = "a".repeat(11_000);
  const base = { id: "handle-1", revision: REVISION, markdown, contentBytes: 11_000 };

  it.each(["view", "preimage"] as const)("serializes an ~11 KB ASCII %s", (kind) => {
    expect(() =>
      serializeRpcResponse({ id: "op-1", ok: true, result: { kind, ...base } }),
    ).not.toThrow();
  });
});

describe("limits lock", () => {
  it("STAGE5_RPC_LIMITS keeps its current values", () => {
    expect({ ...STAGE5_RPC_LIMITS }).toEqual({
      maxFrameBytes: 65_536,
      maxQueryBytes: 512,
      maxContentBytes: 4096,
      maxResponseBytes: 65_536,
      maxSearchHits: 64,
      maxTitleBytes: 256,
      maxIdentifierBytes: 256,
    });
  });
});
