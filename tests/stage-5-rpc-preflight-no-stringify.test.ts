/**
 * R16: the response preflight must refuse an over-budget envelope BEFORE
 * JSON.stringify runs.  The protocol module binds `JSON.stringify` once at
 * load time, so a spy installed after import can never observe it.  This
 * file therefore installs a counting wrapper FIRST and imports the module
 * dynamically afterwards.  The control case proves the wrapper really does
 * observe the serializer's call, so the "not called" assertions cannot
 * silently become vacuous.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type * as ProtocolModule from "../src/service/rpc-protocol.js";

type Protocol = typeof ProtocolModule;

const realStringify = JSON.stringify;
let calls = 0;
let protocol: Protocol;

beforeAll(async () => {
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    calls += 1;
    return realStringify(...args);
  }) as typeof JSON.stringify;
  protocol = await import("../src/service/rpc-protocol.js");
});

/** Outcome of one serialization: did it throw, and did it reach JSON.stringify. */
function attempt(envelope: unknown): { threw: boolean; stringifyCalls: number } {
  const before = calls;
  let threw = false;
  try {
    protocol.serializeRpcResponse(envelope as never);
  } catch (error) {
    // Only the size rejection counts as a refusal; any other protocol or
    // validation error is a broken fixture and must fail loudly.
    const message = error instanceof Error ? error.message : String(error);
    if (!/response (field )?exceeds maximum response bytes/.test(message)) throw error;
    threw = true;
  }
  return { threw, stringifyCalls: calls - before };
}

const quote = '"'.repeat(256);
/** 24-byte rendering of a finite non-negative double (17 digits at exponent -6). */
const WIDE_NUMBER = 0.0000012345678901234567;
const notebooksOf = (n: number, requestId: string, timestamp: number) => ({
  id: requestId,
  ok: true,
  result: {
    kind: "notebooks",
    notebooks: Array.from({ length: n }, () => ({
      id: quote,
      title: quote,
      dateCreated: timestamp,
      dateModified: timestamp,
    })),
  },
});
const notebooks = (n: number) => notebooksOf(n, "iiiiiiiiii", 1.5e18);
const notebooksWide = (n: number) => notebooksOf(n, "r".repeat(282), WIDE_NUMBER);
const operatorPage = (n: number) => ({
  id: "iiiiiiiiii",
  ok: true,
  result: {
    kind: "operator-page",
    notes: Array.from({ length: n }, () => ({ handle: quote, label: quote, bytes: 256 })),
    next: null,
  },
});
const operationList = (handles: number, unresolved: number) => ({
  id: "iiiiiiiiii",
  ok: true,
  result: {
    kind: "operation-list",
    handles: Array.from({ length: handles }, () => quote),
    unresolvedHandles: Array.from({ length: unresolved }, () => quote),
  },
});

/**
 * Invariant for an array-producing method: every count either serializes or
 * is refused with ZERO stringify calls (never "stringify then reject"), and
 * the boundary is crossed exactly once.  Returns the largest count that fits.
 */
function sweep(build: (n: number) => unknown, max: number): number {
  let largestFit = -1;
  let refused = false;
  for (let n = 1; n <= max; n += 1) {
    const outcome = attempt(build(n));
    if (outcome.threw) {
      expect(outcome.stringifyCalls, `n=${n} was stringified before being rejected`).toBe(0);
      refused = true;
    } else {
      expect(outcome.stringifyCalls).toBe(1);
      expect(refused, `n=${n} fits after a smaller count was refused`).toBe(false);
      largestFit = n;
    }
  }
  expect(refused, "sweep never reached the response bound").toBe(true);
  return largestFit;
}

describe("preflight refuses before JSON.stringify (patched before import)", () => {
  it("control: the wrapper observes a real serializer call", () => {
    const outcome = attempt({ id: "ok", ok: true, result: { kind: "search", notes: [] } });
    expect(outcome).toEqual({ threw: false, stringifyCalls: 1 });
  });

  it("rejects an over-length id with no stringify call", () => {
    const huge = "x".repeat(protocol.STAGE5_RPC_LIMITS.maxResponseBytes + 1);
    const outcome = attempt({ id: huge, ok: true, result: { kind: "search", notes: [] } });
    expect(outcome).toEqual({ threw: true, stringifyCalls: 0 });
  });

  it("notebooks: 59 of the reviewer's shape is refused pre-stringify, 58 fits", () => {
    expect(attempt(notebooks(59))).toEqual({ threw: true, stringifyCalls: 0 });
    expect(attempt(notebooks(58))).toEqual({ threw: false, stringifyCalls: 1 });
  });

  it("notebooks: every count serializes or is refused pre-stringify", () => {
    expect(sweep((n) => notebooks(n), 64)).toBe(58);
  });

  it("notebooks with 24-byte timestamps: 58 would overflow after stringify, so it is refused before", () => {
    expect(String(WIDE_NUMBER)).toHaveLength(24);
    expect(attempt(notebooksWide(58))).toEqual({ threw: true, stringifyCalls: 0 });
    expect(attempt(notebooksWide(57))).toEqual({ threw: false, stringifyCalls: 1 });
    expect(sweep((n) => notebooksWide(n), 64)).toBe(57);
  });

  it("edit and undo results (hard-coded appliedFields) still serialize", () => {
    for (const kind of ["edit", "undo"] as const) {
      const result = {
        kind,
        id: "n1",
        appliedFields: ["content"],
        revision: "rev_0123456789abcdef0123456789abcdef",
        contentBytes: 1,
      };
      expect(attempt({ id: "x", ok: true, result })).toEqual({ threw: false, stringifyCalls: 1 });
    }
  });

  it("operator page: every count serializes or is refused pre-stringify", () => {
    expect(sweep((n) => operatorPage(n), 100)).toBeGreaterThan(0);
  });

  it("operation list: every unresolved-handle count serializes or is refused pre-stringify", () => {
    expect(sweep((n) => operationList(64, n), 64)).toBeGreaterThan(0);
  });
});
