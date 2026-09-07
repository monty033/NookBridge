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
    expect(coordinator.snapshot()).toEqual({ pending: [] });
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
    expect(coordinator.snapshot()).toEqual({ pending: [] });
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
    });
    await expect(restarted.requestSync()).resolves.toMatchObject({ status: "synced" });
    expect(calls).toBe(1);
    expect(restarted.snapshot()).toEqual({ pending: [] });
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
      load: () => ({ pending: [{ operation: "delete", noteId: NOTE_ID, sequence: 1 }] }),
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
