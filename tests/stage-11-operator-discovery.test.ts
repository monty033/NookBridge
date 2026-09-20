import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { OPERATOR_METHODS } from "../src/service/operator-methods.js";
import { parseRpcFrame, serializeRpcResponse } from "../src/service/rpc-protocol.js";

function frame(method: string, params: Record<string, unknown>): Uint8Array {
  const body = Buffer.from(JSON.stringify({ id: "r1", method, params }), "utf8");
  const output = new Uint8Array(4 + body.length);
  new DataView(output.buffer).setUint32(0, body.length, false);
  output.set(body, 4);
  return output;
}

describe("operator discovery RPC amendment", () => {
  it("admits browse and operator search only on the operator vocabulary", () => {
    expect(OPERATOR_METHODS).toContain("notes.browse");
    expect(OPERATOR_METHODS).toContain("notes.search-operator");
  });

  it("parses bounded discovery parameters", () => {
    expect(parseRpcFrame(frame("notes.browse", { cursor: "cur_a1b2", limit: 10 }))).toMatchObject({
      method: "notes.browse",
      params: { cursor: "cur_a1b2", limit: 10 },
    });
    expect(
      parseRpcFrame(frame("notes.search-operator", { query: "leaf", limit: 10 })),
    ).toMatchObject({
      method: "notes.search-operator",
      params: { query: "leaf", limit: 10 },
    });
  });

  it("serializes bounded daemon-minted discovery handles", () => {
    const frame = serializeRpcResponse({
      id: "r1",
      ok: true,
      result: {
        kind: "operator-page",
        notes: [{ handle: "h_abc123", label: "Trip", bytes: Buffer.byteLength("Trip") }],
        next: "cur_abc123",
      },
    });
    const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
    const response = JSON.parse(
      Buffer.from(frame)
        .subarray(4, length + 4)
        .toString("utf8"),
    ) as {
      readonly result: {
        readonly notes: readonly { handle: string; label: string; bytes: number }[];
        readonly next: string;
      };
    };
    expect(response.result.notes[0]).toEqual({ handle: "h_abc123", label: "Trip", bytes: 4 });
    expect(response.result.next).toBe("cur_abc123");
  });
});
