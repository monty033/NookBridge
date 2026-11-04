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
  withSharedMutex,
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

  describe("shared mode", () => {
    interface Gate {
      readonly promise: Promise<void>;
      readonly open: () => void;
    }
    function gate(): Gate {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { promise, open };
    }
    /** Let every already-resolved continuation run. */
    async function settle(): Promise<void> {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    it("runs shared holders concurrently", async () => {
      const db = makeDatabase();
      const first = gate();
      const second = gate();
      const order: string[] = [];
      const a = withSharedMutex(db, "test:a", async () => {
        order.push("a:enter");
        await first.promise;
        order.push("a:exit");
      });
      const b = withSharedMutex(db, "test:b", async () => {
        order.push("b:enter");
        await second.promise;
        order.push("b:exit");
      });
      await settle();
      // Both are inside before either leaves.
      expect(order).toEqual(["a:enter", "b:enter"]);
      expect(peekMutex(db)).toEqual({ depth: 2, queued: 0 });
      second.open();
      first.open();
      await Promise.all([a, b]);
      expect(peekMutex(db)).toEqual({ depth: 0, queued: 0 });
    });

    it("makes a shared request wait for an exclusive holder", async () => {
      const db = makeDatabase();
      const hold = gate();
      const order: string[] = [];
      const writer = withMutex(db, "test:w", async () => {
        order.push("w:enter");
        await hold.promise;
        order.push("w:exit");
      });
      const reader = withSharedMutex(db, "test:r", async () => {
        order.push("r:enter");
      });
      await settle();
      expect(order).toEqual(["w:enter"]);
      hold.open();
      await Promise.all([writer, reader]);
      expect(order).toEqual(["w:enter", "w:exit", "r:enter"]);
    });

    it("makes an exclusive request wait for every shared holder", async () => {
      const db = makeDatabase();
      const first = gate();
      const second = gate();
      const order: string[] = [];
      const a = withSharedMutex(db, "test:a", async () => {
        await first.promise;
        order.push("a:exit");
      });
      const b = withSharedMutex(db, "test:b", async () => {
        await second.promise;
        order.push("b:exit");
      });
      const writer = withMutex(db, "test:w", async () => {
        order.push("w:enter");
      });
      await settle();
      first.open();
      await settle();
      // One reader is still inside, so the writer must still be waiting.
      expect(order).toEqual(["a:exit"]);
      second.open();
      await Promise.all([a, b, writer]);
      expect(order).toEqual(["a:exit", "b:exit", "w:enter"]);
    });

    it("prefers a queued writer over a shared request that arrives later", async () => {
      const db = makeDatabase();
      const early = gate();
      const order: string[] = [];
      const reader1 = withSharedMutex(db, "test:r1", async () => {
        order.push("r1:enter");
        await early.promise;
        order.push("r1:exit");
      });
      const writer = withMutex(db, "test:w", async () => {
        order.push("w:enter");
        order.push("w:exit");
      });
      // Arrives while the writer is queued: a free-for-all would admit it
      // alongside r1 and starve the writer.
      const reader2 = withSharedMutex(db, "test:r2", async () => {
        order.push("r2:enter");
      });
      await settle();
      expect(order).toEqual(["r1:enter"]);
      expect(peekMutex(db)).toEqual({ depth: 1, queued: 2 });
      early.open();
      await Promise.all([reader1, writer, reader2]);
      expect(order).toEqual(["r1:enter", "r1:exit", "w:enter", "w:exit", "r2:enter"]);
    });

    it("admits every shared request queued behind a writer together once it leaves", async () => {
      const db = makeDatabase();
      const hold = gate();
      const inside = gate();
      const order: string[] = [];
      const writer = withMutex(db, "test:w", () => hold.promise);
      const readers = [1, 2, 3].map((n) =>
        withSharedMutex(db, `test:r${n}`, async () => {
          order.push(`r${n}:enter`);
          await inside.promise;
        }),
      );
      await settle();
      expect(order).toEqual([]);
      hold.open();
      await settle();
      expect(order).toEqual(["r1:enter", "r2:enter", "r3:enter"]);
      expect(peekMutex(db)).toEqual({ depth: 3, queued: 0 });
      inside.open();
      await Promise.all([writer, ...readers]);
    });

    it("does not let shared waiters make an exclusive request fail admission", async () => {
      const db = makeDatabase();
      const hold = gate();
      const writer = withMutex(db, "test:holder", () => hold.promise);
      // Far beyond the exclusive cap of 64, within the shared cap.
      const readers = Array.from({ length: 150 }, (_, i) =>
        withSharedMutex(db, `test:r${i}`, async () => i),
      );
      const queuedWriter = withMutex(db, "test:next", async () => "written");
      await settle();
      expect(peekMutex(db).queued).toBe(151);
      hold.open();
      await expect(queuedWriter).resolves.toBe("written");
      await expect(Promise.all(readers)).resolves.toHaveLength(150);
      await writer;
    });

    it("rejects only shared requests once the shared cap is reached", async () => {
      const db = makeDatabase();
      const hold = gate();
      const writer = withMutex(db, "test:holder", () => hold.promise);
      const outcomes: Array<Promise<"ok" | "rejected">> = [];
      for (let i = 0; i < 200; i++) {
        outcomes.push(
          withSharedMutex(db, "test:r", async () => "ok" as const).catch((error: unknown) => {
            expect(String(error)).toMatch(/queue depth exceeded/);
            return "rejected" as const;
          }),
        );
      }
      // The exclusive queue is untouched by a full shared queue.
      const queuedWriter = withMutex(db, "test:w", async () => "written");
      hold.open();
      const settled = await Promise.all(outcomes);
      expect(settled.filter((value) => value === "ok")).toHaveLength(192);
      expect(settled.filter((value) => value === "rejected")).toHaveLength(8);
      await expect(queuedWriter).resolves.toBe("written");
      await writer;
      expect(peekMutex(db)).toEqual({ depth: 0, queued: 0 });
    });

    it("still rejects an exclusive request past its own cap while shared ones queue", async () => {
      const db = makeDatabase();
      const hold = gate();
      const holder = withSharedMutex(db, "test:holder", () => hold.promise);
      const writers = Array.from({ length: 64 }, () =>
        withMutex(db, "test:w", async () => "ok").catch(() => "rejected"),
      );
      await expect(withMutex(db, "test:over", async () => "ok")).rejects.toThrow(
        /queue depth exceeded/,
      );
      // Shared requests queue behind those writers and are unaffected.
      const reader = withSharedMutex(db, "test:r", async () => "read");
      hold.open();
      await holder;
      await expect(reader).resolves.toBe("read");
      await expect(Promise.all(writers)).resolves.toEqual(Array(64).fill("ok"));
    });

    it("releases the lock when a shared function throws", async () => {
      const db = makeDatabase();
      await expect(
        withSharedMutex(db, "test:throw", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(peekMutex(db)).toEqual({ depth: 0, queued: 0 });
      await expect(withMutex(db, "test:after", async () => "recovered")).resolves.toBe("recovered");
    });

    it("releases a waiting writer when the last shared holder throws", async () => {
      const db = makeDatabase();
      const hold = gate();
      const reader = withSharedMutex(db, "test:r", async () => {
        await hold.promise;
        throw new Error("boom");
      });
      const writer = withMutex(db, "test:w", async () => "written");
      hold.open();
      await expect(reader).rejects.toThrow("boom");
      await expect(writer).resolves.toBe("written");
    });

    it("applies the same argument validation as the exclusive gate", async () => {
      const db = makeDatabase();
      await expect(withSharedMutex(null, "test", async () => 1)).rejects.toThrow(/invalid_input/);
      await expect(withSharedMutex(db, "", async () => 1)).rejects.toThrow(/invalid_input/);
      await expect(
        withSharedMutex(db, "ok", null as unknown as () => Promise<number>),
      ).rejects.toThrow(/invalid_input/);
    });
  });
});
