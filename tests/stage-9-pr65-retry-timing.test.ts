/**
 * PR-65 P1-4 — closed retry-timing suite.
 *
 *   - backoffDelay returns the configured base delay at attempt 1
 *     (no zero-second wait), applies 0.75×–1.25× multiplicative jitter,
 *     grows exponentially per attempt, and caps at MAX_DELAY_MS.
 *   - classifySyncFailure routes persistent categories (invalid_input,
 *     permission_denied, vault_locked, stale_revision, conflict,
 *     not_found) to `failed`; everything else is transient.
 *   - createLiveRemoteSyncExecutor propagates a bounded Retry-After hint
 *     on transient failures and never retries a persistent failure.
 *   - The coordinator's default sleep actually awaits (no no-op).
 */

import { describe, expect, it } from "vitest";

import { SyncCoordinator } from "../src/core/notesnook-sync-coordinator.js";
import {
  classifySyncFailure,
  createLiveRemoteSyncExecutor,
} from "../src/core/notesnook-live-remote-sync.js";

const SEED_NOW = 1_700_000_000_000;

function fakeDatabase(syncerResult: unknown): object {
  return {
    syncer: {
      start: async () => syncerResult,
    },
  };
}

function liveEnsureOpen(): void {
  /* always open in tests */
}

describe("PR-65 P1-4 — closed retry timing", () => {
  describe("classifySyncFailure", () => {
    it("routes invalid_input, permission_denied, vault_locked, stale_revision, conflict, not_found to persistent", () => {
      for (const code of [
        "invalid_input",
        "permission_denied",
        "vault_locked",
        "stale_revision",
        "conflict",
        "not_found",
      ]) {
        expect(classifySyncFailure({ code })).toEqual({ kind: "persistent" });
      }
    });

    it("routes sync_failed and service_unavailable to transient without a hint", () => {
      expect(classifySyncFailure({ code: "sync_failed" })).toEqual({ kind: "transient" });
      expect(classifySyncFailure({ code: "service_unavailable" })).toEqual({
        kind: "transient",
      });
    });

    it("routes an unannotated thrown error to transient", () => {
      expect(classifySyncFailure(new Error("network"))).toEqual({ kind: "transient" });
    });

    it("propagates a bounded retryAfterMs hint on transient failures", () => {
      expect(classifySyncFailure({ code: "service_unavailable", retryAfterMs: 5_000 })).toEqual({
        kind: "transient",
        retryAfterMs: 5_000,
      });
      expect(classifySyncFailure({ retryAfterMs: 250 })).toEqual({
        kind: "transient",
        retryAfterMs: 250,
      });
    });

    it("rejects a non-integer or negative retryAfterMs", () => {
      expect(classifySyncFailure({ code: "sync_failed", retryAfterMs: -1 })).toEqual({
        kind: "transient",
      });
      expect(classifySyncFailure({ code: "sync_failed", retryAfterMs: 1.5 })).toEqual({
        kind: "transient",
      });
      expect(classifySyncFailure({ code: "sync_failed", retryAfterMs: "1000" })).toEqual({
        kind: "transient",
      });
    });

    it("treats a hostile non-record input as persistent", () => {
      expect(classifySyncFailure("not-a-record")).toEqual({ kind: "persistent" });
      expect(classifySyncFailure(undefined)).toEqual({ kind: "persistent" });
    });
  });

  describe("createLiveRemoteSyncExecutor — persistent vs transient", () => {
    it("returns failed (no retry) when upstream throws a persistent category", async () => {
      const executor = createLiveRemoteSyncExecutor(
        fakeDatabase(Promise.reject(Object.assign(new Error("vault"), { code: "vault_locked" }))),
        liveEnsureOpen,
      );
      const result = await executor({ pending: [] });
      expect(result).toEqual({ status: "failed" });
    });

    it("returns retry (no hint) when upstream throws a transient category without a hint", async () => {
      const executor = createLiveRemoteSyncExecutor(
        fakeDatabase(Promise.reject(Object.assign(new Error("net"), { code: "sync_failed" }))),
        liveEnsureOpen,
      );
      const result = await executor({ pending: [] });
      expect(result).toEqual({ status: "retry" });
    });

    it("propagates a bounded retryAfterMs hint through to the coordinator", async () => {
      const executor = createLiveRemoteSyncExecutor(
        fakeDatabase(
          Promise.reject(
            Object.assign(new Error("net"), {
              code: "service_unavailable",
              retryAfterMs: 4_000,
            }),
          ),
        ),
        liveEnsureOpen,
      );
      const result = await executor({ pending: [] });
      expect(result).toEqual({ status: "retry", retryAfterMs: 4_000 });
    });

    it("returns confirmed when upstream resolves true", async () => {
      const executor = createLiveRemoteSyncExecutor(
        fakeDatabase(Promise.resolve(true)),
        liveEnsureOpen,
      );
      const result = await executor({ pending: [] });
      expect(result).toEqual({ status: "confirmed" });
    });

    it("returns failed when upstream resolves false", async () => {
      const executor = createLiveRemoteSyncExecutor(
        fakeDatabase(Promise.resolve(false)),
        liveEnsureOpen,
      );
      const result = await executor({ pending: [] });
      expect(result).toEqual({ status: "failed" });
    });
  });

  describe("SyncCoordinator backoff jitter and minimum interval", () => {
    it("applies the configured base delay on the first attempt when transient throws", async () => {
      const slept: number[] = [];
      const executor = async (): Promise<{ status: "retry" }> => ({ status: "retry" });
      const coordinator = new SyncCoordinator({
        executor,
        sleep: async (delayMs) => {
          slept.push(delayMs);
        },
        // jitter: deterministic 1.0 → max factor 1.25, but floor is baseDelayMs
        jitter: () => 1.0,
        baseDelayMs: 200,
        maxAttempts: 3,
        now: () => SEED_NOW,
      });
      const result = await coordinator.requestSync();
      expect(result.status).toBe("failed");
      // Three attempts means two backoffs; the minimum is 200ms (the base)
      for (const delay of slept) {
        expect(delay).toBeGreaterThanOrEqual(200);
      }
    });

    it("uses a bounded jitter factor between 0.75 and 1.25", async () => {
      const slept: number[] = [];
      const executor = async (): Promise<{ status: "retry" }> => ({ status: "retry" });
      const coordinator = new SyncCoordinator({
        executor,
        sleep: async (delayMs) => {
          slept.push(delayMs);
        },
        jitter: () => 0,
        baseDelayMs: 100,
        maxAttempts: 3,
        now: () => SEED_NOW,
      });
      await coordinator.requestSync();
      // jitter=0 → 0.75 factor → first backoff should be 75ms but the
      // minimum-interval rule clamps it back to 100ms.
      expect(slept[0]).toBe(100);
      // jitter=0 still applies 0.75 to the second-attempt delay (200ms);
      // the result is 150ms, again above the 100ms minimum.
      expect(slept[1]).toBe(150);
    });

    it("caps the backoff at MAX_DELAY_MS", async () => {
      const slept: number[] = [];
      const executor = async (): Promise<{ status: "retry" }> => ({ status: "retry" });
      const coordinator = new SyncCoordinator({
        executor,
        sleep: async (delayMs) => {
          slept.push(delayMs);
        },
        jitter: () => 1.0,
        baseDelayMs: 1_000,
        maxAttempts: 8,
        now: () => SEED_NOW,
      });
      await coordinator.requestSync();
      // The 60_000 cap is enforced even with full jitter (1.25).
      for (const delay of slept) {
        expect(delay).toBeLessThanOrEqual(60_000);
      }
    });

    it("honours a bounded retryAfterMs returned by the executor", async () => {
      const slept: number[] = [];
      let attempt = 0;
      const executor = async (): Promise<
        { status: "retry"; retryAfterMs?: number } | { status: "confirmed" }
      > => {
        attempt += 1;
        if (attempt < 2) return { status: "retry", retryAfterMs: 750 };
        return { status: "confirmed" };
      };
      const coordinator = new SyncCoordinator({
        executor,
        sleep: async (delayMs) => {
          slept.push(delayMs);
        },
        jitter: () => 0.5,
        baseDelayMs: 100,
        retryAfterCapMs: 30_000,
        maxAttempts: 3,
        now: () => SEED_NOW,
      });
      const result = await coordinator.requestSync();
      expect(result.status).toBe("synced");
      expect(slept[0]).toBe(750);
    });

    it("the default sleep actually awaits (no no-op)", async () => {
      // Without injecting a custom sleep, a transient executor still
      // blocks for at least the configured base delay before retrying.
      // This is the regression test for the P1-4 `DEFAULT_SLEEP` no-op.
      let attempts = 0;
      const executor = async (): Promise<{ status: "retry" } | { status: "confirmed" }> => {
        attempts += 1;
        if (attempts < 2) return { status: "retry" };
        return { status: "confirmed" };
      };
      const coordinator = new SyncCoordinator({
        executor,
        // baseDelayMs: 10 keeps the test fast.
        baseDelayMs: 10,
        maxAttempts: 2,
        now: () => SEED_NOW,
      });
      const startedAt = Date.now();
      const result = await coordinator.requestSync();
      const elapsed = Date.now() - startedAt;
      expect(result.status).toBe("synced");
      // Without the fix this completes in <5ms; the fix should be at
      // least ~10ms (the base delay).
      expect(elapsed).toBeGreaterThanOrEqual(8);
    });
  });
});

describe("R3 — throttling across requests", () => {
  function seedPending(coordinator: SyncCoordinator): void {
    coordinator.recordLocalCommit({
      operation: "create",
      id: "note-R3",
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });
  }

  function thrownCode(build: () => unknown): unknown {
    try {
      build();
    } catch (error) {
      return (error as { code?: unknown }).code;
    }
    throw new Error("expected construction to fail");
  }

  it("1: a request inside minIntervalMs of a synced drain waits the remainder before the executor", async () => {
    let clock = 1_000;
    const events: string[] = [];
    const coordinator = new SyncCoordinator({
      executor: async () => {
        events.push("execute");
        return { status: "confirmed" as const };
      },
      sleep: async (delayMs) => {
        events.push(`sleep:${delayMs}`);
      },
      now: () => clock,
      minIntervalMs: 2_000,
    });
    seedPending(coordinator);

    await expect(coordinator.requestSync()).resolves.toMatchObject({ status: "synced" });
    clock = 1_500;
    await expect(coordinator.requestSync()).resolves.toMatchObject({ status: "synced" });
    expect(events).toEqual(["execute", "sleep:1500", "execute"]);
  });

  it("2: a request after a final-attempt Retry-After waits the remainder of the hint", async () => {
    let clock = 1_000;
    let calls = 0;
    const events: string[] = [];
    const coordinator = new SyncCoordinator({
      executor: async () => {
        calls++;
        events.push("execute");
        return calls === 1
          ? { status: "retry" as const, retryAfterMs: 30_000 }
          : { status: "confirmed" as const };
      },
      sleep: async (delayMs) => {
        events.push(`sleep:${delayMs}`);
      },
      now: () => clock,
      maxAttempts: 1,
    });
    seedPending(coordinator);

    await expect(coordinator.requestSync()).resolves.toMatchObject({ status: "failed" });
    clock = 2_000;
    await expect(coordinator.requestSync()).resolves.toMatchObject({ status: "synced" });
    expect(events).toEqual(["execute", "sleep:29000", "execute"]);
  });

  it("3: a Retry-After above the default cap is capped in the pre-wait", async () => {
    let clock = 1_000;
    let calls = 0;
    const events: string[] = [];
    const coordinator = new SyncCoordinator({
      executor: async () => {
        calls++;
        events.push("execute");
        return calls === 1
          ? { status: "retry" as const, retryAfterMs: 120_000 }
          : { status: "confirmed" as const };
      },
      sleep: async (delayMs) => {
        events.push(`sleep:${delayMs}`);
      },
      now: () => clock,
      maxAttempts: 1,
    });
    seedPending(coordinator);

    await expect(coordinator.requestSync()).resolves.toMatchObject({ status: "failed" });
    clock = 2_000;
    await expect(coordinator.requestSync()).resolves.toMatchObject({ status: "synced" });
    expect(events).toEqual(["execute", "sleep:29000", "execute"]);
  });

  it("4: concurrent requests during the pre-wait share one flight and one executor call", async () => {
    let clock = 1_000;
    const events: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const coordinator = new SyncCoordinator({
      executor: async () => {
        events.push("execute");
        return { status: "confirmed" as const };
      },
      sleep: async (delayMs) => {
        events.push(`sleep:${delayMs}`);
        await gate;
      },
      now: () => clock,
      minIntervalMs: 2_000,
    });
    seedPending(coordinator);
    await coordinator.requestSync();

    clock = 1_500;
    const first = coordinator.requestSync();
    const second = coordinator.requestSync();
    const third = coordinator.requestSync();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(events).toEqual(["execute", "sleep:1500"]);

    openGate();
    await expect(first).resolves.toMatchObject({ status: "synced" });
    expect(events).toEqual(["execute", "sleep:1500", "execute"]);
  });

  it("5: a request after the hold has passed does not pre-wait", async () => {
    let clock = 1_000;
    const events: string[] = [];
    const coordinator = new SyncCoordinator({
      executor: async () => {
        events.push("execute");
        return { status: "confirmed" as const };
      },
      sleep: async (delayMs) => {
        events.push(`sleep:${delayMs}`);
      },
      now: () => clock,
      minIntervalMs: 2_000,
    });
    seedPending(coordinator);

    await coordinator.requestSync();
    clock = 3_500;
    await expect(coordinator.requestSync()).resolves.toMatchObject({ status: "synced" });
    expect(events).toEqual(["execute", "execute"]);
  });

  it("6: a pre-wait sleep that rejects fails the flight without calling the executor", async () => {
    let clock = 1_000;
    const events: string[] = [];
    const coordinator = new SyncCoordinator({
      executor: async () => {
        events.push("execute");
        return { status: "confirmed" as const };
      },
      sleep: async (delayMs) => {
        events.push(`sleep:${delayMs}`);
        throw new Error("cancelled");
      },
      now: () => clock,
      minIntervalMs: 2_000,
    });
    seedPending(coordinator);

    await coordinator.requestSync();
    clock = 1_500;
    await expect(coordinator.requestSync()).resolves.toMatchObject({
      status: "failed",
      errorCode: "sync_failed",
      attempts: 1,
      remoteSynced: false,
    });
    expect(events).toEqual(["execute", "sleep:1500"]);
  });

  it.each([-1, 60_001, 1.5])(
    "7: rejects minIntervalMs %s with invalid_input at construction",
    (minIntervalMs) => {
      expect(
        thrownCode(
          () =>
            new SyncCoordinator({
              executor: async () => ({ status: "confirmed" as const }),
              minIntervalMs,
            }),
        ),
      ).toBe("invalid_input");
    },
  );

  it("8: without the option, an immediate second request pre-waits the 2000 ms default", async () => {
    const clock = 1_000;
    const events: string[] = [];
    const coordinator = new SyncCoordinator({
      executor: async () => {
        events.push("execute");
        return { status: "confirmed" as const };
      },
      sleep: async (delayMs) => {
        events.push(`sleep:${delayMs}`);
      },
      now: () => clock,
    });
    seedPending(coordinator);

    await coordinator.requestSync();
    await coordinator.requestSync();
    expect(events).toEqual(["execute", "sleep:2000", "execute"]);
  });

  it("9: the hold is in memory only, so a restarted coordinator does not pre-wait", async () => {
    const clock = 1_000;
    const events: string[] = [];
    const stored: unknown[] = [];
    const stateStore = {
      load: () => stored.at(-1),
      save: (state: unknown) => {
        stored.push(state);
      },
    };
    const executor = async () => {
      events.push("execute");
      return { status: "confirmed" as const };
    };
    const sleep = async (delayMs: number) => {
      events.push(`sleep:${delayMs}`);
    };
    const first = new SyncCoordinator({ executor, sleep, now: () => clock, stateStore });
    seedPending(first);
    await first.requestSync();

    const restarted = new SyncCoordinator({ executor, sleep, now: () => clock, stateStore });
    await expect(restarted.requestSync()).resolves.toMatchObject({ status: "synced" });
    expect(events).toEqual(["execute", "execute"]);
  });
});
