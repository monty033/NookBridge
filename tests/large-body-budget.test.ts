import { describe, expect, it } from "vitest";

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
