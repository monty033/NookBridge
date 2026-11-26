import { describe, expect, it } from "vitest";

import { WIRE_BODY_BYTES } from "../src/core/size-limits.js";
import { buildServiceAuditRecord } from "../src/service/service-audit.js";

import { createLargeBodyBudget } from "../src/service/large-body-budget.js";

describe("large body budget", () => {
  it("admits one body, refuses a concurrent body, and reacquires after release", () => {
    const budget = createLargeBodyBudget();
    const first = budget.tryAcquire(128);
    expect(first).toMatchObject({ kind: "acquired", bytes: 128 });
    expect(budget.tryAcquire(256)).toEqual({ kind: "busy" });

    if (first.kind !== "acquired") throw new Error("expected the first lease");
    first.release();
    expect(budget.tryAcquire(256)).toMatchObject({ kind: "acquired", bytes: 256 });
  });

  it("makes release idempotent without releasing a newer lease", () => {
    const budget = createLargeBodyBudget();
    const first = budget.tryAcquire(128);
    if (first.kind !== "acquired") throw new Error("expected the first lease");

    first.release();
    expect(() => first.release()).not.toThrow();

    const second = budget.tryAcquire(256);
    if (second.kind !== "acquired") throw new Error("expected the second lease");
    first.release();
    expect(budget.tryAcquire(512)).toEqual({ kind: "busy" });
    second.release();
  });
});

describe("wire bound", () => {
  it("accepts a body at the wire bound and refuses one byte more", () => {
    const budget = createLargeBodyBudget();
    const lease = budget.tryAcquire(WIRE_BODY_BYTES);
    expect(lease.kind).toBe("acquired");
    if (lease.kind === "acquired") lease.release();
    // The parser refuses this before the budget is consulted; reaching the
    // budget with it is a caller bug, so it fails loudly instead of sizing a
    // buffer the wire never allowed.
    expect(() => budget.tryAcquire(WIRE_BODY_BYTES + 1)).toThrow(RangeError);
  });
});

describe("audit vocabulary", () => {
  it("accepts every outcome the type allows, including the refusals it gained", () => {
    // The type and the runtime list are two halves of one closed set. When they
    // disagree the audit throws and the catch swallows it, so the refusal is
    // simply never recorded — a silent gap, not a visible error.
    for (const outcome of ["too_large", "busy"] as const) {
      const record = buildServiceAuditRecord({
        event: "rpc.request.received",
        outcome,
        method: "notes.create",
        requestIdEcho: false,
        latencyMs: 1,
        peerCredentials: "verified",
      });
      expect(record.outcome).toBe(outcome);
    }
  });
});
