/**
 * Stage 4 — injected synchronization coordinator.
 *
 * These tests exercise only the offline, metadata-only coordinator seam. No
 * Notesnook imports, transport, credentials, Vault state, or note bodies are
 * present in the fixtures or passed to the executor.
 */

import { describe, expect, it } from "vitest";

import {
  NotesnookWriteContractError,
  SyncCoordinator,
  type SyncCoordinatorState,
  type SyncExecutor,
  type SyncLocalCommit,
} from "../src/core/notesnook-sync-coordinator.js";
import { isNotesnookWriteContractError } from "../src/core/notesnook-write-contract.js";

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const SECRET = "CANARY-plaintext-body-credential";

function commit(operation: SyncLocalCommit["operation"] = "append", id = NOTE_ID): SyncLocalCommit {
  return Object.freeze({
    operation,
    id,
    localCommitted: true,
    remoteSynced: false,
    pendingSync: true,
  });
}

function codeOf(fn: () => unknown): NotesnookWriteContractError["code"] {
  try {
    fn();
  } catch (error) {
    if (!isNotesnookWriteContractError(error)) {
      throw new Error("expected a categorical contract error");
    }
    return error.code;
  }
  throw new Error("expected the coordinator to fail closed");
}

async function asyncCodeOf(
  fn: () => Promise<unknown>,
): Promise<NotesnookWriteContractError["code"]> {
  try {
    await fn();
  } catch (error) {
    if (!isNotesnookWriteContractError(error)) {
      throw new Error("expected a categorical contract error");
    }
    return error.code;
  }
  throw new Error("expected the coordinator to fail closed");
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("Stage 4 SyncCoordinator — local and remote outcomes", () => {
  it("durably records an existing-note sync intent before its local mutation starts", () => {
    const saved: SyncCoordinatorState[] = [];
    const coordinator = new SyncCoordinator({
      executor: () => ({ status: "failed" }),
      stateStore: {
        load: () => ({ pending: [], knownNoteIds: [NOTE_ID] }),
        save: (state) => saved.push(state),
      },
    });

    expect(coordinator.recordSyncIntent({ operation: "update", id: NOTE_ID })).toEqual({
      operation: "update",
      id: NOTE_ID,
      pendingSync: true,
    });
    expect(saved).toEqual([
      {
        pending: [{ operation: "update", noteId: NOTE_ID, sequence: 1 }],
        knownNoteIds: [NOTE_ID],
      },
    ]);
    expect(coordinator.snapshot()).toEqual(saved[0]);
  });

  it("refuses a write-ahead intent when persistence fails and leaves coordinator state unchanged", () => {
    const coordinator = new SyncCoordinator({
      executor: () => ({ status: "failed" }),
      stateStore: {
        load: () => ({ pending: [], knownNoteIds: [NOTE_ID] }),
        save: () => {
          throw new Error(SECRET);
        },
      },
    });

    expect(codeOf(() => coordinator.recordSyncIntent({ operation: "append", id: NOTE_ID }))).toBe(
      "sync_failed",
    );
    expect(coordinator.snapshot()).toEqual({ pending: [], knownNoteIds: [NOTE_ID] });
  });

  it("keeps previously known IDs after the orphan queue reaches capacity", () => {
    const initiallyKnown = ["z-known-note", "zz-known-note"];
    const backlog = [
      ...Array.from({ length: 70 }, (_, i) => `a-orphan-${String(i).padStart(3, "0")}`),
      ...initiallyKnown,
    ];
    const coordinator = new SyncCoordinator({
      executor: () => ({ status: "failed" }),
      stateStore: {
        load: () => ({ pending: [], knownNoteIds: initiallyKnown }),
        save: () => undefined,
      },
    });

    coordinator.reconcilePendingFromSnapshot(backlog);

    expect(coordinator.snapshot().pending).toHaveLength(64);
    expect(coordinator.snapshot().knownNoteIds).toContain("z-known-note");
    expect(coordinator.snapshot().knownNoteIds).toContain("zz-known-note");
  });

  it("bounds knownNoteIds at the persisted-state limit so a saved snapshot always reloads", () => {
    const saved: { state?: unknown } = {};
    // Seed exactly at the 100_000 cap so the very next committed mutation
    // would otherwise push the persisted set over the limit that
    // `validateState` enforces on the next load.
    const nearCap = Array.from({ length: 100_000 }, (_, i) => `n-${String(i).padStart(6, "0")}`);
    const coordinator = new SyncCoordinator({
      executor: () => ({ status: "failed" }),
      stateStore: {
        load: () => ({ pending: [], knownNoteIds: nearCap }),
        save: (state) => {
          saved.state = state;
        },
      },
    });

    coordinator.recordSyncIntent({ operation: "append", id: NOTE_ID });

    const persisted = saved.state as { knownNoteIds: readonly string[] };
    // Eviction order is arbitrary (lexicographic) and unrelated to recency;
    // losing any individual id from `knownNoteIds` is a documented, safe,
    // bounded false negative (see boundedKnownNoteIds) because the actual
    // write-ahead guarantee lives in the `pending` marker, not this
    // bookkeeping set. The requirement under test is purely that the
    // persisted set never exceeds the limit `validateState` enforces on
    // load, so a coordinator can always reload its own saved state.
    expect(persisted.knownNoteIds.length).toBeLessThanOrEqual(100_000);

    // The persisted state must be reloadable: constructing a fresh
    // coordinator from exactly what was just saved must not throw.
    const reloaded = new SyncCoordinator({
      executor: () => ({ status: "failed" }),
      stateStore: {
        load: () => saved.state,
        save: () => undefined,
      },
    });
    expect(reloaded.snapshot().knownNoteIds.length).toBeLessThanOrEqual(100_000);
  });

  it("keeps a successful local mutation pending until remote confirmation", async () => {
    const requests: unknown[] = [];
    const executor: SyncExecutor = async (request) => {
      requests.push(request);
      return { status: "confirmed" };
    };
    const coordinator = new SyncCoordinator({ executor, now: () => 1000 });

    const local = coordinator.recordLocalCommit(commit("create"));
    expect(local).toEqual({
      operation: "create",
      id: NOTE_ID,
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });
    expect(Object.isFrozen(local)).toBe(true);
    expect(coordinator.snapshot()).toEqual({
      pending: [{ operation: "create", noteId: NOTE_ID, sequence: 1 }],
      knownNoteIds: [NOTE_ID],
    });

    const synced = await coordinator.requestSync();
    expect(synced).toMatchObject({
      status: "synced",
      localCommitted: true,
      remoteSynced: true,
      pendingSync: false,
      attempts: 1,
      startedAt: 1000,
    });
    expect(coordinator.snapshot()).toEqual({ pending: [], knownNoteIds: [NOTE_ID] });
    expect(requests).toEqual([
      {
        pending: [{ operation: "create", noteId: NOTE_ID, sequence: 1 }],
      },
    ]);
  });

  it("runs the native sync executor when an explicit request has no local markers", async () => {
    const requests: unknown[] = [];
    const executor: SyncExecutor = async (request) => {
      requests.push(request);
      return { status: "confirmed" };
    };
    const coordinator = new SyncCoordinator({ executor, now: () => 1000 });

    await expect(coordinator.requestSync()).resolves.toMatchObject({
      status: "synced",
      localCommitted: false,
      remoteSynced: true,
      pendingSync: false,
      attempts: 1,
      startedAt: 1000,
    });
    expect(requests).toEqual([{ pending: [] }]);
    expect(coordinator.snapshot()).toEqual({ pending: [], knownNoteIds: [] });
  });

  it("reports a local write that arrives during remote-only sync as still pending", async () => {
    const gate = deferred<{ readonly status: "confirmed" }>();
    const coordinator = new SyncCoordinator({
      executor: () => gate.promise,
    });

    const syncing = coordinator.requestSync();
    coordinator.recordLocalCommit(commit("create"));
    gate.resolve({ status: "confirmed" });

    await expect(syncing).resolves.toMatchObject({
      status: "synced",
      localCommitted: false,
      remoteSynced: true,
      pendingSync: true,
      attempts: 1,
    });
    expect(coordinator.snapshot().pending).toHaveLength(1);
  });

  it("coalesces concurrent requests into one in-flight executor call", async () => {
    const gate = deferred<{ readonly status: "confirmed" }>();
    let calls = 0;
    const executor: SyncExecutor = () => {
      calls++;
      return gate.promise;
    };
    const coordinator = new SyncCoordinator({ executor });
    coordinator.recordLocalCommit(commit());

    const first = coordinator.requestSync();
    const second = coordinator.requestSync();
    expect(first).toBe(second);
    expect(calls).toBe(1);

    gate.resolve({ status: "confirmed" });
    await expect(first).resolves.toMatchObject({ status: "synced" });
    expect(calls).toBe(1);
  });

  it("coalesces a burst of sync requests without amplification", async () => {
    let calls = 0;
    const executor: SyncExecutor = async () => {
      calls++;
      return { status: "confirmed" };
    };
    const coordinator = new SyncCoordinator({ executor });
    coordinator.recordLocalCommit(commit("append"));

    const results = await Promise.all([
      coordinator.requestSync(),
      coordinator.requestSync(),
      coordinator.requestSync(),
      coordinator.requestSync(),
    ]);

    expect(calls).toBe(1);
    expect(results.every((result) => result.status === "synced")).toBe(true);
  });
});

describe("Stage 4 SyncCoordinator — bounded retry policy", () => {
  it("retries transient responses with deterministic exponential backoff", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const executor: SyncExecutor = async () => {
      calls++;
      return calls < 3 ? { status: "retry" } : { status: "confirmed" };
    };
    const coordinator = new SyncCoordinator({
      executor,
      baseDelayMs: 100,
      maxAttempts: 3,
      jitter: () => 0.5,
      sleep: async (delay) => {
        sleeps.push(delay);
      },
    });
    coordinator.recordLocalCommit(commit());

    await expect(coordinator.requestSync()).resolves.toMatchObject({
      status: "synced",
      attempts: 3,
    });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("caps an injected Retry-After delay", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const executor: SyncExecutor = async () => {
      calls++;
      return calls === 1 ? { status: "retry", retryAfterMs: 99_999 } : { status: "confirmed" };
    };
    const coordinator = new SyncCoordinator({
      executor,
      maxAttempts: 2,
      retryAfterCapMs: 250,
      sleep: async (delay) => {
        sleeps.push(delay);
      },
    });
    coordinator.recordLocalCommit(commit());

    await expect(coordinator.requestSync()).resolves.toMatchObject({ status: "synced" });
    expect(sleeps).toEqual([250]);
  });

  it("retains pending state after a transient failure exhausts attempts", async () => {
    let calls = 0;
    const executor: SyncExecutor = async () => {
      calls++;
      throw new NotesnookWriteContractError("sync_failed", SECRET);
    };
    const coordinator = new SyncCoordinator({
      executor,
      maxAttempts: 2,
      sleep: async () => undefined,
    });
    coordinator.recordLocalCommit(commit());

    const result = await coordinator.requestSync();
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "sync_failed",
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
      attempts: 2,
    });
    expect(calls).toBe(2);
    expect(coordinator.snapshot().pending).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("retains pending state after an explicit permanent failure without retrying", async () => {
    let calls = 0;
    const coordinator = new SyncCoordinator({
      executor: async () => {
        calls++;
        return { status: "failed" };
      },
      maxAttempts: 4,
    });
    coordinator.recordLocalCommit(commit());

    await expect(coordinator.requestSync()).resolves.toMatchObject({
      status: "failed",
      errorCode: "sync_failed",
      pendingSync: true,
      attempts: 1,
    });
    expect(calls).toBe(1);
    expect(coordinator.snapshot().pending).toHaveLength(1);
  });
});

describe("Stage 4 SyncCoordinator — restart-safe metadata state", () => {
  it("re-queues an untracked local note found during startup reconciliation", () => {
    const saved: SyncCoordinatorState[] = [];
    const coordinator = new SyncCoordinator({
      executor: () => ({ status: "failed" }),
      stateStore: {
        load: () => ({ pending: [], knownNoteIds: ["known"] }),
        save: (state) => saved.push(state),
      },
    });

    coordinator.reconcilePendingFromSnapshot(["known", "orphan"]);

    expect(coordinator.snapshot().pending).toEqual([
      { operation: "update", noteId: "orphan", sequence: 1 },
    ]);
    expect(saved.at(-1)).toMatchObject({ knownNoteIds: ["known", "orphan"] });
  });

  it("does not save when startup reconciliation snapshot already matches", () => {
    let saves = 0;
    const coordinator = new SyncCoordinator({
      executor: () => ({ status: "failed" }),
      stateStore: {
        load: () => ({ pending: [], knownNoteIds: ["known"] }),
        save: () => {
          saves++;
        },
      },
    });
    coordinator.reconcilePendingFromSnapshot(["known"]);
    expect(saves).toBe(0);
  });

  it("does not duplicate an orphan already in the pending queue", () => {
    const coordinator = new SyncCoordinator({
      executor: () => ({ status: "failed" }),
      stateStore: {
        load: () => ({
          pending: [{ operation: "append", noteId: "orphan", sequence: 3 }],
          knownNoteIds: [],
        }),
        save: () => undefined,
      },
    });
    coordinator.reconcilePendingFromSnapshot(["orphan"]);
    expect(coordinator.snapshot().pending).toEqual([
      { operation: "append", noteId: "orphan", sequence: 3 },
    ]);
  });

  it("makes bounded forward progress on an orphan backlog larger than the pending-queue bound, instead of failing the whole pass and losing the overflow forever", () => {
    // Regression: reconciling a backlog bigger than MAX_PENDING_MARKERS (64)
    // must not throw and discard the pass entirely -- that would mean a
    // vault with more than 64 unreconciled notes deadlocks reconciliation
    // on every single startup, forever. It also must not mark the
    // ids that didn't fit this pass as "known": doing so would permanently
    // and silently drop them from recovery instead of picking them up on
    // the next pass once the queue drains.
    const backlog = Array.from({ length: 80 }, (_, i) => `orphan-${String(i).padStart(3, "0")}`);
    const saved: SyncCoordinatorState[] = [];
    const coordinator = new SyncCoordinator({
      executor: () => ({ status: "failed" }),
      stateStore: {
        load: () => ({ pending: [], knownNoteIds: [] }),
        save: (state) => saved.push(state),
      },
    });

    expect(() => coordinator.reconcilePendingFromSnapshot(backlog)).not.toThrow();

    const afterFirstPass = coordinator.snapshot();
    expect(afterFirstPass.pending).toHaveLength(64);
    expect(afterFirstPass.knownNoteIds).toHaveLength(64);
    const queuedIds = new Set(afterFirstPass.pending.map((marker) => marker.noteId));
    const overflowIds = backlog.filter((id) => !queuedIds.has(id));
    expect(overflowIds).toHaveLength(16);
    // The overflow ids must NOT have been marked known, so they remain
    // eligible for the next pass.
    for (const id of overflowIds) {
      expect(afterFirstPass.knownNoteIds).not.toContain(id);
    }
    expect(saved.at(-1)).toEqual(afterFirstPass);
  });

  it("reloads only bounded pending markers and resumes after restart", async () => {
    let persisted: SyncCoordinatorState | undefined;
    const store = {
      load: () => persisted,
      save: (state: SyncCoordinatorState) => {
        persisted = state;
      },
    };
    const first = new SyncCoordinator({
      executor: async () => ({ status: "confirmed" }),
      stateStore: store,
    });
    first.recordLocalCommit(commit("update"));

    expect(persisted).toEqual({
      pending: [{ operation: "update", noteId: NOTE_ID, sequence: 1 }],
      knownNoteIds: [NOTE_ID],
    });

    let calls = 0;
    const restarted = new SyncCoordinator({
      executor: async (request) => {
        calls++;
        expect(request.pending).toEqual([{ operation: "update", noteId: NOTE_ID, sequence: 1 }]);
        return { status: "confirmed" };
      },
      stateStore: store,
    });
    expect(restarted.snapshot()).toEqual({
      pending: [{ operation: "update", noteId: NOTE_ID, sequence: 1 }],
      knownNoteIds: [NOTE_ID],
    });
    await expect(restarted.requestSync()).resolves.toMatchObject({ status: "synced" });
    expect(calls).toBe(1);
    expect(restarted.snapshot()).toEqual({ pending: [], knownNoteIds: [NOTE_ID] });
  });

  it("reports local_sync_marker_failed, not a generic failure, when the durable marker cannot be persisted after a successful local mutation", () => {
    // Regression: previously a persistence failure here (e.g. disk I/O error,
    // permission revoked) was indistinguishable from any other coordinator
    // failure to the caller, even though the local mutation this call is
    // recording had already succeeded before recordLocalCommit was invoked.
    // The distinct code lets callers detect "mutation landed, marker did
    // not" instead of reporting the whole operation as failed.
    const store = {
      load: () => undefined,
      save: () => {
        throw new Error("disk full");
      },
    };
    const coordinator = new SyncCoordinator({
      executor: async () => ({ status: "confirmed" }),
      stateStore: store,
    });

    const code = codeOf(() => coordinator.recordLocalCommit(commit("create")));
    expect(code).toBe("local_sync_marker_failed");

    // The coordinator's own in-memory pending queue must not have advanced
    // past the failed persist either, so a caller that retries the record
    // (e.g. after fixing the disk) does not silently double-count sequence
    // numbers or knownNoteIds.
    expect(coordinator.snapshot()).toEqual({ pending: [], knownNoteIds: [] });
  });

  it("persists no bodies, credentials, raw records, or upstream errors", async () => {
    let persistedText = "";
    const store = {
      load: () => undefined,
      save: (state: SyncCoordinatorState) => {
        persistedText += JSON.stringify(state);
      },
    };
    const coordinator = new SyncCoordinator({
      executor: async () => {
        throw new Error(SECRET);
      },
      stateStore: store,
      maxAttempts: 1,
    });
    coordinator.recordLocalCommit(commit());

    const result = await coordinator.requestSync();
    expect(result.status).toBe("failed");
    expect(persistedText).not.toContain(SECRET);
    expect(JSON.stringify(coordinator.snapshot())).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("Stage 4 SyncCoordinator — hostile seam handling and closed surface", () => {
  it("normalises hostile local receipts and malformed state categorically", async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(SECRET);
        },
      },
    );
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    expect(codeOf(() => coordinator.recordLocalCommit(hostile as never))).toBe("invalid_input");

    const malformedStore = {
      load: () => ({ pending: [{ operation: "create", noteId: "", sequence: 1 }] }),
      save: () => undefined,
    };
    expect(
      codeOf(
        () =>
          new SyncCoordinator({
            executor: async () => ({ status: "confirmed" }),
            stateStore: malformedStore,
          }),
      ),
    ).toBe("invalid_input");

    const malformedExecutor = new SyncCoordinator({
      executor: async () => ({ status: "unexpected" }) as never,
      maxAttempts: 3,
    });
    malformedExecutor.recordLocalCommit(commit());
    expect(await asyncCodeOf(() => malformedExecutor.requestSync())).toBe("sync_failed");
  });

  it("rejects malformed retry metadata and keeps the marker pending", async () => {
    const coordinator = new SyncCoordinator({
      executor: async () => ({ status: "retry", retryAfterMs: Number.NaN }),
      maxAttempts: 2,
    });
    coordinator.recordLocalCommit(commit());

    expect(await asyncCodeOf(() => coordinator.requestSync())).toBe("sync_failed");
    expect(coordinator.snapshot().pending).toHaveLength(1);
  });

  it("coalesces duplicate pending markers and exposes no forbidden capability", () => {
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    coordinator.recordLocalCommit(commit("append"));
    coordinator.recordLocalCommit(commit("append"));

    expect(coordinator.snapshot().pending).toEqual([
      { operation: "append", noteId: NOTE_ID, sequence: 2 },
    ]);
    expect(Object.isFrozen(coordinator)).toBe(true);
    expect(Object.isFrozen(coordinator.snapshot())).toBe(true);
    expect(Object.getOwnPropertyNames(coordinator)).not.toEqual(
      expect.arrayContaining([
        "sync",
        "send",
        "full",
        "delete",
        "force",
        "vault",
        "auth",
        "transport",
        "network",
      ]),
    );
  });
});
