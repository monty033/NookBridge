/**
 * Per-Database mutex unit tests.
 *
 * Astra finding P1-1: the per-composition `localDepth` counter does not
 * serialise across composition instances. This module proves the new
 * `withMutex` primitive provides the cross-instance serialization the
 * composition now relies on.
 *
 * The tests are deterministic, do not import any Notesnook modules, and
 * use only plain objects as the database identity.
 */

import { setTimeout as nodeSetTimeout } from "node:timers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetMutexForTesting,
  peekMutex,
  withMutex,
} from "../src/core/notesnook-database-mutex.js";

function makeDatabase(): object {
  return Object.freeze(Object.create(null));
}

describe("notesnook-database-mutex", () => {
  beforeEach(() => {
    // Reset only test databases by relying on per-test isolation; the
    // production module keeps state in a WeakMap that GCs with the
    // database identity. The reset helper is exercised separately.
  });

  it("runs the function under the gate and returns its value", async () => {
    const db = makeDatabase();
    const result = await withMutex(db, "test:create", async () => 42);
    expect(result).toBe(42);
    expect(peekMutex(db)).toEqual({ depth: 0, queued: 0 });
  });

  it("serialises two overlapping calls on the same database", async () => {
    const db = makeDatabase();
    const order: string[] = [];

    const slow = withMutex(db, "test:slow", async () => {
      order.push("slow:enter");
      await new Promise((resolve) => nodeSetTimeout(resolve, 30));
      order.push("slow:exit");
      return "slow";
    });

    const fast = withMutex(db, "test:fast", async () => {
      order.push("fast:enter");
      order.push("fast:exit");
      return "fast";
    });

    const [a, b] = await Promise.all([slow, fast]);
    expect([a, b]).toEqual(["slow", "fast"]);
    // Either slow finishes entirely before fast runs, or fast queues
    // behind slow and runs after slow:exit. Either ordering proves
    // they did not run interleaved.
    const slowIndex = order.indexOf("slow:exit");
    const fastEnter = order.indexOf("fast:enter");
    expect(fastEnter >= slowIndex).toBe(true);
  });

  it("releases the gate even when the function throws", async () => {
    const db = makeDatabase();
    await expect(
      withMutex(db, "test:throw", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(peekMutex(db)).toEqual({ depth: 0, queued: 0 });
    const result = await withMutex(db, "test:after-throw", async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("treats two distinct database identities as independent gates", async () => {
    const dbA = makeDatabase();
    const dbB = makeDatabase();
    const order: string[] = [];

    const a = withMutex(dbA, "test:A", async () => {
      order.push("A:enter");
      await new Promise((resolve) => nodeSetTimeout(resolve, 20));
      order.push("A:exit");
    });

    const b = withMutex(dbB, "test:B", async () => {
      order.push("B:enter");
      order.push("B:exit");
    });

    await Promise.all([a, b]);
    // B does not block on A: B's enter must precede A's exit because A
    // and B use independent gates.
    const aExit = order.indexOf("A:exit");
    const bEnter = order.indexOf("B:enter");
    expect(bEnter < aExit).toBe(true);
  });

  it("rejects queue overflow rather than growing forever", async () => {
    const db = makeDatabase();
    let releaseHolder!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withMutex(db, "test:holder", () => held);
    const pendingProbe = (): Promise<"ok"> =>
      withMutex(db, "test:overflow", async () => "ok" as const);
    let overflowed = false;
    for (let i = 0; i < 200; i++) {
      const probe = pendingProbe();
      const sentinel = probe.then(
        () => "ok" as const,
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      await Promise.resolve();
      const winner = await raceSettledOrPending(sentinel);
      if (
        winner.kind === "settled" &&
        typeof winner.value !== "string" &&
        winner.value.kind === "rejected"
      ) {
        expect(String(winner.value.error)).toMatch(/queue depth exceeded/);
        expect(peekMutex(db).depth).toBe(1);
        overflowed = true;
        break;
      }
    }
    releaseHolder();
    await holder;
    expect(overflowed).toBe(true);
  });

  async function raceSettledOrPending(
    sentinel: Promise<"ok" | { kind: "rejected"; error: unknown }>,
  ): Promise<
    { kind: "settled"; value: "ok" | { kind: "rejected"; error: unknown } } | { kind: "pending" }
  > {
    type Outcome =
      | { kind: "settled"; value: "ok" | { kind: "rejected"; error: unknown } }
      | { kind: "pending" };
    const settled = sentinel.then((value) => ({ kind: "settled" as const, value }));
    const timer = new Promise<Outcome>((resolve) => {
      nodeSetTimeout(() => resolve({ kind: "pending" as const }), 5);
    });
    return Promise.race<Outcome>([settled, timer]);
  }

  it("rejects non-object database arguments", async () => {
    await expect(withMutex(null, "test", async () => 1)).rejects.toThrow(/invalid_input/);
    await expect(withMutex("not-an-object", "test", async () => 1)).rejects.toThrow(
      /invalid_input/,
    );
    await expect(withMutex(42, "test", async () => 1)).rejects.toThrow(/invalid_input/);
    await expect(withMutex(undefined as unknown as object, "test", () => 1)).rejects.toThrow(
      /invalid_input/,
    );
  });

  it("rejects invalid labels and non-function callbacks", async () => {
    const db = makeDatabase();
    await expect(withMutex(db, "", async () => 1)).rejects.toThrow(/invalid_input/);
    await expect(withMutex(db, "x".repeat(65), async () => 1)).rejects.toThrow(/invalid_input/);
    await expect(withMutex(db, "ok", null as unknown as () => Promise<number>)).rejects.toThrow(
      /invalid_input/,
    );
  });

  it("peekMutex reports depth=0 and queued=0 for a fresh database", () => {
    expect(peekMutex(makeDatabase())).toEqual({ depth: 0, queued: 0 });
  });

  it("peekMutex reports the in-flight depth while a holder runs", async () => {
    const db = makeDatabase();
    let observed: { depth: number; queued: number } | undefined;
    const held = withMutex(db, "test:hold", async () => {
      observed = peekMutex(db);
      await new Promise((resolve) => nodeSetTimeout(resolve, 10));
    });
    await held;
    expect(observed).toEqual({ depth: 1, queued: 0 });
  });

  it("__resetMutexForTesting removes the gate entry", async () => {
    const db = makeDatabase();
    await withMutex(db, "test:warm", async () => undefined);
    expect(__resetMutexForTesting(db)).toBe(true);
    expect(__resetMutexForTesting(db)).toBe(false);
  });
});
