/**
 * S7a-6a — operator upload approval: coordinator, upload gate and persistence.
 *
 * Offline and synthetic only. The upstream syncer is a spy; no test performs a
 * live sync. Acceptance rows 1, 2, 3, 4, 6 and 7 are carried here; the method,
 * CLI and docs rows (8-14) belong to 6b. One positive gate case (row 5, the
 * approved half) is included so the refusal tests cannot pass against a gate
 * that refuses everything.
 */

import { describe, expect, it, vi } from "vitest";

import { createLiveRemoteSyncExecutor } from "../src/core/notesnook-live-remote-sync.js";
import {
  SyncCoordinator,
  type SyncLocalCommit,
  type SyncOperation,
  type SyncOrigin,
} from "../src/core/notesnook-sync-coordinator.js";
import { isNotesnookWriteContractError } from "../src/core/notesnook-write-contract.js";

/** A store that round-trips through JSON, as the persistent store does. */
function jsonStore(initial?: unknown) {
  let saved: string | undefined = initial === undefined ? undefined : JSON.stringify(initial);
  return {
    load: (): unknown => (saved === undefined ? undefined : (JSON.parse(saved) as unknown)),
    save: (state: unknown): void => {
      saved = JSON.stringify(state);
    },
  };
}

function commit(operation: SyncOperation, id: string, origin?: SyncOrigin): SyncLocalCommit {
  return {
    operation,
    id,
    localCommitted: true,
    remoteSynced: false,
    pendingSync: true,
    ...(origin === undefined ? {} : { origin }),
  };
}

/** Coordinator wired to the real live executor over a spy `syncer.start`. */
function harness(store: ReturnType<typeof jsonStore> = jsonStore()) {
  const start = vi.fn(async (_options: unknown) => true);
  const executor = createLiveRemoteSyncExecutor({ syncer: { start } }, () => undefined);
  const build = () =>
    new SyncCoordinator({
      executor,
      stateStore: store,
      sleep: async () => undefined,
      now: () => 0,
      minIntervalMs: 0,
    });
  return { start, store, build, coordinator: build() };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isNotesnookWriteContractError(error)) return error.code;
  }
  throw new Error("expected categorical failure");
}

const UNAPPROVED = { status: "failed", errorCode: "unapproved_pending" };

describe("S7a-6a upload approval", () => {
  describe("row 1: approvePending marks operator and unknown markers through N", () => {
    it("1: approves every operator and unknown marker with sequence <= N and survives a reload", () => {
      const { coordinator, build } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator")); // 1
      coordinator.recordLocalCommit(commit("append", "note-b")); // 2 (unknown)
      coordinator.recordLocalCommit(commit("update", "note-c", "mcp")); // 3

      const result = coordinator.approvePending({ throughSequence: 3 });
      expect(result).toEqual({ approved: 2, throughSequence: 3 });

      const view = (c: SyncCoordinator) =>
        c.snapshot().pending.map((m) => [m.sequence, m.origin, m.approved] as const);
      const expected = [
        [1, "operator", true],
        [2, "unknown", true],
        [3, "mcp", undefined],
      ];
      expect(view(coordinator)).toEqual(expected);
      expect(view(build())).toEqual(expected);
      expect(build().blockingSummary().total).toBe(0);
    });

    it("1: the bound is inclusive and a repeat call approves nothing new", () => {
      const { coordinator } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator")); // 1
      coordinator.recordLocalCommit(commit("update", "note-b", "operator")); // 2

      expect(coordinator.approvePending({ throughSequence: 1 }).approved).toBe(1);
      expect(coordinator.snapshot().pending.map((m) => m.approved)).toEqual([true, undefined]);
      expect(coordinator.approvePending({ throughSequence: 1 }).approved).toBe(0);
    });

    it("1: rejects a bound that is not a positive safe integer", () => {
      const { coordinator } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator"));
      const invalid = [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "1", null];
      for (const throughSequence of invalid) {
        const request = { throughSequence } as unknown as { throughSequence: number };
        expect(codeOf(() => coordinator.approvePending(request))).toBe("invalid_input");
      }
      expect(codeOf(() => coordinator.approvePending(undefined as never))).toBe("invalid_input");
      expect(coordinator.snapshot().pending[0]?.approved).toBeUndefined();
    });

    it("1: a failed save leaves the queue unapproved", () => {
      let failing = false;
      const inner = jsonStore();
      const store = {
        load: inner.load,
        save: (state: unknown) => {
          if (failing) throw new Error("disk");
          inner.save(state);
        },
      };
      const { coordinator } = harness(store as ReturnType<typeof jsonStore>);
      coordinator.recordLocalCommit(commit("update", "note-a", "operator"));

      failing = true;
      expect(codeOf(() => coordinator.approvePending({ throughSequence: 1 }))).toBe("sync_failed");
      expect(coordinator.snapshot().pending[0]?.approved).toBeUndefined();
      expect(coordinator.blockingSummary().total).toBe(1);
    });

    it("1: blockingSummary counts only unapproved non-mcp markers, by operation and origin", () => {
      const { coordinator } = harness();
      expect(coordinator.blockingSummary()).toEqual({
        total: 0,
        byOperation: { create: 0, append: 0, update: 0, delete: 0 },
        byOrigin: { operator: 0, unknown: 0 },
        highestSequence: null,
      });

      coordinator.recordLocalCommit(commit("create", "note-a", "operator")); // 1
      coordinator.recordLocalCommit(commit("update", "note-b", "mcp")); // 2, never blocks
      coordinator.recordLocalCommit(commit("update", "note-c")); // 3 unknown
      coordinator.recordLocalCommit(commit("delete", "note-d", "operator")); // 4
      coordinator.approvePending({ throughSequence: 1 });

      expect(coordinator.blockingSummary()).toEqual({
        total: 2,
        byOperation: { create: 0, append: 0, update: 1, delete: 1 },
        byOrigin: { operator: 1, unknown: 1 },
        highestSequence: 4,
      });
    });

    it("1: blockingSummary carries no note id", () => {
      const { coordinator } = harness();
      coordinator.recordLocalCommit(commit("update", "sentinel-note-id", "operator"));
      expect(JSON.stringify(coordinator.blockingSummary())).not.toContain("sentinel-note-id");
    });
  });

  describe("row 2: markers above N stay unapproved", () => {
    it("2: the gate still refuses and upstream is never called", async () => {
      const { coordinator, start } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator")); // 1
      coordinator.recordLocalCommit(commit("update", "note-b", "operator")); // 2
      coordinator.recordLocalCommit(commit("append", "note-c")); // 3 written after the listing

      coordinator.approvePending({ throughSequence: 2 });

      expect(coordinator.snapshot().pending.map((m) => m.approved)).toEqual([
        true,
        true,
        undefined,
      ]);
      expect(coordinator.blockingSummary().highestSequence).toBe(3);
      expect(await coordinator.requestSync()).toMatchObject(UNAPPROVED);
      expect(start).not.toHaveBeenCalled();
      expect(coordinator.snapshot().pending).toHaveLength(3);
    });
  });

  describe("row 3: a new write to an approved note is unapproved again", () => {
    it("3: a replacing marker is unapproved, keeps its origin rank, and the gate refuses", async () => {
      const { coordinator, start } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator")); // 1
      coordinator.approvePending({ throughSequence: 1 });

      // Same operation and note replaces marker 1; an mcp request cannot lower it.
      coordinator.recordLocalCommit(commit("update", "note-a", "mcp"));

      const [marker, ...rest] = coordinator.snapshot().pending;
      expect(rest).toEqual([]);
      expect(marker).toMatchObject({ noteId: "note-a", sequence: 2, origin: "operator" });
      expect(marker?.approved).toBeUndefined();
      expect(await coordinator.requestSync()).toMatchObject(UNAPPROVED);
      expect(start).not.toHaveBeenCalled();
    });

    it("3: a new intent is unapproved, keeps its origin rank, and the gate refuses", async () => {
      const { coordinator, start } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator")); // 1
      coordinator.recordLocalCommit(commit("update", "note-b")); // 2 unknown
      coordinator.approvePending({ throughSequence: 2 });

      const intentA = coordinator.recordIntent({
        operation: "append",
        noteId: "note-a",
        origin: "mcp",
      });
      const intentB = coordinator.recordIntent({
        operation: "delete",
        noteId: "note-b",
        origin: "mcp",
      });

      expect(intentA).toMatchObject({ origin: "operator" });
      expect(intentB).toMatchObject({ origin: "unknown" });
      expect(intentA.approved).toBeUndefined();
      expect(intentB.approved).toBeUndefined();
      expect(coordinator.blockingSummary().total).toBe(2);
      expect(await coordinator.requestSync()).toMatchObject(UNAPPROVED);
      expect(start).not.toHaveBeenCalled();
    });

    it("3: the older approved marker stays approved; only the new write blocks", () => {
      const { coordinator } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator")); // 1
      coordinator.approvePending({ throughSequence: 1 });
      coordinator.recordIntent({ operation: "append", noteId: "note-a", origin: "operator" }); // 2

      expect(coordinator.snapshot().pending.map((m) => [m.sequence, m.approved])).toEqual([
        [1, true],
        [2, undefined],
      ]);
      expect(coordinator.blockingSummary()).toMatchObject({ total: 1, highestSequence: 2 });
    });

    it("3: resolving a create intent writes a fresh, unapproved marker", async () => {
      const { coordinator, start } = harness();
      const token = coordinator.recordCreateIntent({ origin: "operator" }); // 1
      coordinator.approvePending({ throughSequence: 1 });
      expect(coordinator.snapshot().pending[0]?.approved).toBe(true);

      coordinator.resolveCreateIntent(token, "note-new");

      const [marker, ...rest] = coordinator.snapshot().pending;
      expect(rest).toEqual([]);
      expect(marker).toMatchObject({ noteId: "note-new", origin: "operator" });
      expect(marker?.approved).toBeUndefined();
      expect(await coordinator.requestSync()).toMatchObject(UNAPPROVED);
      expect(start).not.toHaveBeenCalled();
    });
  });

  describe("row 4: loading is strict", () => {
    const base = { operation: "update", noteId: "note-a", sequence: 1, origin: "operator" };
    const stored = (marker: Record<string, unknown>) => ({ pending: [{ ...base, ...marker }] });

    it("4: a marker with no approved field loads as unapproved and the gate refuses", async () => {
      const { coordinator, start } = harness(jsonStore(stored({})));
      expect(coordinator.snapshot().pending[0]?.approved).toBeUndefined();
      expect(coordinator.blockingSummary().total).toBe(1);
      expect(await coordinator.requestSync()).toMatchObject(UNAPPROVED);
      expect(start).not.toHaveBeenCalled();
    });

    it("4: a marker with no origin and no approved field loads as unknown, unapproved", () => {
      const { coordinator } = harness(
        jsonStore({ pending: [{ operation: "update", noteId: "note-a", sequence: 1 }] }),
      );
      expect(coordinator.snapshot().pending[0]).toMatchObject({ origin: "unknown" });
      expect(coordinator.blockingSummary().byOrigin).toEqual({ operator: 0, unknown: 1 });
    });

    it("4: approved:false loads as unapproved; approved:true loads as approved", () => {
      expect(
        harness(jsonStore(stored({ approved: false }))).coordinator.blockingSummary().total,
      ).toBe(1);
      expect(
        harness(jsonStore(stored({ approved: true }))).coordinator.blockingSummary().total,
      ).toBe(0);
    });

    it("4: a non-boolean approved is invalid_input", () => {
      for (const approved of ["true", "yes", 1, 0, null, {}, []]) {
        // `harness` builds the coordinator, so the strict load throws here.
        expect(codeOf(() => harness(jsonStore(stored({ approved }))))).toBe("invalid_input");
      }
    });
  });

  describe("row 6: all-mcp and empty queues still run full", () => {
    it("6: an all-mcp queue runs full exactly once and is cleared", async () => {
      const { coordinator, start } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "mcp"));
      coordinator.recordLocalCommit(commit("append", "note-b", "mcp"));

      expect(await coordinator.requestSync()).toMatchObject({ status: "synced" });
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({ type: "full" });
      expect(coordinator.snapshot().pending).toEqual([]);
    });

    it("6: an empty queue runs full exactly once", async () => {
      const { coordinator, start } = harness();

      expect(await coordinator.requestSync()).toMatchObject({ status: "synced" });
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({ type: "full" });
    });

    it("5 (approved half): approved operator and unknown markers run full once", async () => {
      const { coordinator, start } = harness();
      coordinator.recordLocalCommit(commit("update", "note-a", "operator"));
      coordinator.recordLocalCommit(commit("append", "note-b"));
      coordinator.recordLocalCommit(commit("update", "note-c", "mcp"));
      coordinator.approvePending({ throughSequence: 3 });

      expect(await coordinator.requestSync()).toMatchObject({ status: "synced" });
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({ type: "full" });
      expect(coordinator.snapshot().pending).toEqual([]);
    });
  });

  describe("row 7: approval removes nothing and calls nothing upstream", () => {
    it("7: every marker is still queued and start was never called", () => {
      const { coordinator, start, build } = harness();
      coordinator.recordLocalCommit(commit("create", "note-a", "operator"));
      coordinator.recordLocalCommit(commit("update", "note-b"));
      coordinator.recordLocalCommit(commit("delete", "note-c", "mcp"));
      const before = coordinator
        .snapshot()
        .pending.map((m) => [m.operation, m.noteId, m.sequence, m.origin]);

      coordinator.approvePending({ throughSequence: 3 });

      const after = (c: SyncCoordinator) =>
        c.snapshot().pending.map((m) => [m.operation, m.noteId, m.sequence, m.origin]);
      expect(after(coordinator)).toEqual(before);
      expect(after(build())).toEqual(before);
      expect(start).not.toHaveBeenCalled();
    });
  });
});
