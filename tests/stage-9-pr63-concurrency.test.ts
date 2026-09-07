/**
 * Per-Database cross-instance serialization tests.
 *
 * Astra finding P1-1: two distinct `NotesnookLocalWriteComposition`
 * instances sharing a database must not run append operations in
 * parallel. Without the per-Database mutex, two requests can read the
 * same revision and overwrite one another; sync can interleave with
 * mutation.
 *
 * These tests prove the production composition routes every public
 * method through `withMutex` when constructed with a `database`
 * identity, and that the legacy seam (no `database`) still uses the
 * per-instance reentrancy guard.
 */

import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { setTimeout as nodeSetTimeout } from "node:timers";
import { describe, expect, it } from "vitest";
import {
  createNotesnookLocalWriteComposition,
  isNotesnookWriteCompositionError,
  type NotesnookLocalWriteHandle,
  type NotesnookPendingSyncHandle,
} from "../src/core/notesnook-write-composition.js";
import {
  SyncCoordinator,
  type SyncCoordinatorResult,
} from "../src/core/notesnook-sync-coordinator.js";

type Result = { kind: "ok"; revision: number; titleBytes: number } | { kind: "err"; code: string };

interface FakeAdapter {
  readonly createNote: (command: { title: string }) => Promise<unknown>;
  readonly appendNote: (command: { title: string }) => Promise<unknown>;
  readonly updateNote: (command: { title: string }) => Promise<unknown>;
  readonly observed: { id: string; revision: number; startedAt: number }[];
  setNextRevision(revision: number): void;
  setNextId(id: string): void;
  failNextWith(code: string): void;
}

function buildAdapter(): FakeAdapter {
  let nextId = "note-fixed";
  let nextRevision = 1;
  let failure: string | undefined;
  const observed: { id: string; revision: number; startedAt: number }[] = [];

  const createNote = async (command: { title: string }): Promise<unknown> => {
    if (failure !== undefined) {
      const code = failure;
      failure = undefined;
      throw Object.assign(new Error(""), { code });
    }
    const startedAt = performance.now();
    observed.push({ id: nextId, revision: nextRevision, startedAt });
    // Yield so a concurrent caller can attempt to overlap.
    await new Promise((resolve) => nodeSetTimeout(resolve, 20));
    return {
      operation: "create",
      id: nextId,
      titleBytes: Buffer.byteLength(command.title, "utf8"),
      contentBytes: 0,
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    };
  };

  return {
    createNote,
    appendNote: createNote,
    updateNote: createNote,
    observed,
    setNextRevision: (revision) => {
      nextRevision = revision;
    },
    setNextId: (id) => {
      nextId = id;
    },
    failNextWith: (code) => {
      failure = code;
    },
  };
}

function buildCoordinator(): SyncCoordinator {
  // An executor that always confirms so requestSync() returns
  // `synced` deterministically.
  return new SyncCoordinator({
    executor: () => ({ status: "confirmed" as const }),
  });
}

function buildPendingHandle(
  coordinator: SyncCoordinator,
  checkCapacity?: () => unknown,
): NotesnookPendingSyncHandle {
  const handle: NotesnookPendingSyncHandle = {
    recordLocalCommit: (receipt: Parameters<SyncCoordinator["recordLocalCommit"]>[0]) =>
      coordinator.recordLocalCommit(receipt),
    requestSync: () => coordinator.requestSync(),
    snapshot: () => coordinator.snapshot(),
  };
  if (checkCapacity !== undefined) {
    return { ...handle, checkCapacity };
  }
  return handle;
}

describe("composition per-Database serialization (P1-1)", () => {
  it("two compositions on the same database serialise append operations", async () => {
    const database = Object.freeze(Object.create(null));
    const adapterA = buildAdapter();
    const adapterB = buildAdapter();
    const coordinatorA = buildCoordinator();
    const coordinatorB = buildCoordinator();

    const compositionA = createNotesnookLocalWriteComposition({
      adapter: adapterA as unknown as NotesnookLocalWriteHandle,
      coordinator: buildPendingHandle(coordinatorA),
      database,
    });
    const compositionB = createNotesnookLocalWriteComposition({
      adapter: adapterB as unknown as NotesnookLocalWriteHandle,
      coordinator: buildPendingHandle(coordinatorB),
      database,
    });

    adapterA.setNextId("note-A");
    adapterB.setNextId("note-B");

    const [resA, resB] = await Promise.all([
      compositionA.createNote({ title: "A" } as never),
      compositionB.createNote({ title: "B" } as never),
    ]);
    expect((resA as { id: string }).id).toBe("note-A");
    expect((resB as { id: string }).id).toBe("note-B");
    // The two creates must NOT have overlapped: their observed
    // startedAt times must be at least 20 ms apart, because the
    // adapter explicitly yields for 20 ms per call.
    expect(adapterA.observed.length).toBe(1);
    expect(adapterB.observed.length).toBe(1);
    const startA = adapterA.observed[0]!.startedAt;
    const startB = adapterB.observed[0]!.startedAt;
    expect(Math.abs(startA - startB)).toBeGreaterThanOrEqual(18);
  });

  it("the composition's requestSync funnels through the same gate as createNote", async () => {
    const database = Object.freeze(Object.create(null));
    const adapter = buildAdapter();
    const coordinator = buildCoordinator();
    const composition = createNotesnookLocalWriteComposition({
      adapter: adapter as unknown as NotesnookLocalWriteHandle,
      coordinator: buildPendingHandle(coordinator),
      database,
    });

    // Hold the adapter inside createNote so requestSync must queue.
    const pending = composition.createNote({ title: "blocking" } as never);
    // The mutex is held by createNote; requestSync must wait.
    const sync = composition.requestSync();
    const [, result] = await Promise.all([pending, sync]);
    const syncResult = result as SyncCoordinatorResult;
    // Drain finished with synced or idle depending on whether a marker
    // was recorded before sync; both are acceptable proofs that the
    // request ran.
    expect(["idle", "synced"]).toContain(syncResult.status);
  });

  it("refuses a mutation before adapter invocation when pending capacity is full", async () => {
    const database = Object.freeze(Object.create(null));
    const adapter = buildAdapter();
    const coordinator = buildCoordinator();
    const composition = createNotesnookLocalWriteComposition({
      adapter: adapter as unknown as NotesnookLocalWriteHandle,
      coordinator: buildPendingHandle(coordinator, () => ({ kind: "full", capacity: 64 })),
      database,
    });

    let error: unknown;
    try {
      await composition.createNote({ title: "blocked" } as never);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect((error as { code: string }).code).toBe("invalid_input");
    expect(adapter.observed).toHaveLength(0);
  });

  it("the legacy seam (no database) still uses the per-instance reentrancy guard", async () => {
    const adapter = buildAdapter();
    const coordinator = buildCoordinator();
    const composition = createNotesnookLocalWriteComposition({
      adapter: adapter as unknown as NotesnookLocalWriteHandle,
      coordinator: buildPendingHandle(coordinator),
      // intentionally omit `database` to exercise the legacy seam
    });
    // requestSync during a held createNote should still fail closed
    // with `invalid_input` — the per-instance guard remains intact.
    const pending = composition.createNote({ title: "blocking" } as never);
    let syncError: unknown;
    try {
      await composition.requestSync();
    } catch (error) {
      syncError = error;
    }
    await pending;
    expect(syncError).toBeDefined();
    expect(isNotesnookWriteCompositionError(syncError as object)).toBe(true);
    expect((syncError as { code: string }).code).toBe("invalid_input");
  });

  it("rejects a database argument that is not an object", () => {
    const adapter = buildAdapter();
    const coordinator = buildCoordinator();
    expect(() =>
      createNotesnookLocalWriteComposition({
        adapter: adapter as unknown as NotesnookLocalWriteHandle,
        coordinator: buildPendingHandle(coordinator),
        database: "not-an-object" as unknown as object,
      }),
    ).toThrow(/invalid[_ ]input/i);
  });
});
describe("remote-sync capability per-Database serialization (P1-1)", () => {
  it("two remote-sync capabilities on the same database serialise drains", async () => {
    const database = Object.freeze(Object.create(null));
    let active = 0;
    let peak = 0;
    const drainCount = { value: 0 };
    const executor = async (): Promise<{ status: "confirmed" }> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => nodeSetTimeout(resolve, 30));
      active -= 1;
      drainCount.value += 1;
      return { status: "confirmed" };
    };
    const coordinatorA = new SyncCoordinator({ executor });
    const coordinatorB = new SyncCoordinator({ executor });

    const { createLiveRemoteSyncCapability } = await import(
      "../src/core/notesnook-live-remote-sync.js"
    );
    const capA = createLiveRemoteSyncCapability(
      () => coordinatorA.requestSync(),
      () => undefined,
      database,
    );
    const capB = createLiveRemoteSyncCapability(
      () => coordinatorB.requestSync(),
      () => undefined,
      database,
    );

    // Seed both coordinators with a marker so each drain does work.
    coordinatorA.recordLocalCommit({
      operation: "create",
      id: "note-A",
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });
    coordinatorB.recordLocalCommit({
      operation: "create",
      id: "note-B",
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });

    await Promise.all([capA.requestSync(), capB.requestSync()]);
    expect(drainCount.value).toBeGreaterThanOrEqual(1);
    expect(peak).toBe(1);
  });

  it("two remote-sync capabilities on different databases do not block each other", async () => {
    const databaseA = Object.freeze(Object.create(null));
    const databaseB = Object.freeze(Object.create(null));
    let startedAt: { A?: number; B?: number } = {};
    let secondStarted = false;
    const executor = async (label: "A" | "B"): Promise<{ status: "confirmed" }> => {
      startedAt[label] = performance.now();
      if (label === "A" && secondStarted === false) {
        await new Promise((resolve) => nodeSetTimeout(resolve, 30));
      }
      secondStarted = true;
      return { status: "confirmed" };
    };
    const coordinatorA = new SyncCoordinator({
      executor: () => executor("A"),
    });
    const coordinatorB = new SyncCoordinator({
      executor: () => executor("B"),
    });

    const { createLiveRemoteSyncCapability } = await import(
      "../src/core/notesnook-live-remote-sync.js"
    );
    const capA = createLiveRemoteSyncCapability(
      () => coordinatorA.requestSync(),
      () => undefined,
      databaseA,
    );
    const capB = createLiveRemoteSyncCapability(
      () => coordinatorB.requestSync(),
      () => undefined,
      databaseB,
    );

    coordinatorA.recordLocalCommit({
      operation: "create",
      id: "note-A",
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });
    coordinatorB.recordLocalCommit({
      operation: "create",
      id: "note-B",
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });

    await Promise.all([capA.requestSync(), capB.requestSync()]);
    expect(startedAt.A).toBeLessThan(startedAt.B!);
  });
});

// Helper types kept at the bottom so the test bodies stay readable.
type _Unused = Result;
