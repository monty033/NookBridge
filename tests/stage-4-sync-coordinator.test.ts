/**
 * Stage 4 — injected synchronization coordinator.
 *
 * These tests exercise only the offline, metadata-only coordinator seam. No
 * Notesnook imports, transport, credentials, Vault state, or note bodies are
 * present in the fixtures or passed to the executor.
 */

import { describe, expect, it, vi } from "vitest";

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
      pending: [{ operation: "create", noteId: NOTE_ID, sequence: 1, origin: "unknown" }],
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
        pending: [{ operation: "create", noteId: NOTE_ID, sequence: 1, origin: "unknown" }],
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
      pending: [{ operation: "update", noteId: NOTE_ID, sequence: 1, origin: "unknown" }],
    });

    let calls = 0;
    const restarted = new SyncCoordinator({
      executor: async (request) => {
        calls++;
        expect(request.pending).toEqual([
          { operation: "update", noteId: NOTE_ID, sequence: 1, origin: "unknown" },
        ]);
        return { status: "confirmed" };
      },
      stateStore: store,
    });
    expect(restarted.snapshot()).toEqual({
      pending: [{ operation: "update", noteId: NOTE_ID, sequence: 1, origin: "unknown" }],
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
      { operation: "append", noteId: NOTE_ID, sequence: 2, origin: "unknown" },
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

describe("R2a — durable write-ahead sync intent", () => {
  function fixture() {
    const saves: SyncCoordinatorState[] = [];
    let saved: SyncCoordinatorState | undefined;
    const store = {
      load: () => saved,
      save: (state: SyncCoordinatorState) => {
        saves.push(state);
        saved = state;
      },
    };
    const executor = vi.fn<SyncExecutor>(async () => ({ status: "confirmed" as const }));
    const coordinator = new SyncCoordinator({ executor, stateStore: store });
    return { saves, store, executor, coordinator };
  }

  it("persists a frozen intent token that survives restart", () => {
    const { saves, store, executor, coordinator } = fixture();
    const token = coordinator.recordIntent({ operation: "update", noteId: "n1" });
    expect(Object.isFrozen(token)).toBe(true);
    expect(token.sequence).toBeGreaterThanOrEqual(1);
    expect(saves.length).toBe(1);
    const restarted = new SyncCoordinator({ executor, stateStore: store });
    expect(restarted.snapshot().pending).toEqual([
      { operation: "update", noteId: "n1", sequence: token.sequence, origin: "unknown" },
    ]);
  });

  it("rejects create and invalid ids without persisting", () => {
    const { saves, coordinator } = fixture();
    const call = (input: unknown) => () =>
      (coordinator as unknown as { recordIntent: (i: unknown) => unknown }).recordIntent(input);
    expect(codeOf(call({ operation: "create", noteId: "n1" }))).toBe("invalid_input");
    expect(codeOf(call({ operation: "update", noteId: "" }))).toBe("invalid_input");
    expect(codeOf(call({ operation: "update", noteId: "x".repeat(129) }))).toBe("invalid_input");
    expect(codeOf(call({ operation: "update", noteId: 42 }))).toBe("invalid_input");
    expect(saves.length).toBe(0);
  });

  it("refuses the 65th intent and persists nothing for it", () => {
    const { saves, coordinator } = fixture();
    for (let i = 0; i < 64; i++) {
      coordinator.recordIntent({ operation: "update", noteId: `n${i}` });
    }
    expect(codeOf(() => coordinator.recordIntent({ operation: "update", noteId: "n64" }))).toBe(
      "sync_failed",
    );
    expect(saves.length).toBe(64);
    expect(coordinator.snapshot().pending.length).toBe(64);
  });

  it("fails closed and leaves memory unchanged when save throws", () => {
    const executor = vi.fn<SyncExecutor>();
    const coordinator = new SyncCoordinator({
      executor,
      stateStore: {
        load: () => undefined,
        save: () => {
          throw new Error("disk");
        },
      },
    });
    expect(codeOf(() => coordinator.recordIntent({ operation: "update", noteId: "n1" }))).toBe(
      "sync_failed",
    );
    expect(coordinator.snapshot().pending).toEqual([]);
  });

  it("does not consume a sequence when the save throws", () => {
    const executor = vi.fn<SyncExecutor>();
    const saves: SyncCoordinatorState[] = [];
    let failNext = true;
    const coordinator = new SyncCoordinator({
      executor,
      stateStore: {
        load: () => undefined,
        save: (state) => {
          if (failNext) {
            failNext = false;
            throw new Error("disk");
          }
          saves.push(state);
        },
      },
    });
    expect(codeOf(() => coordinator.recordIntent({ operation: "update", noteId: "n1" }))).toBe(
      "sync_failed",
    );
    expect(coordinator.snapshot().pending).toEqual([]);
    const token = coordinator.recordIntent({ operation: "update", noteId: "n1" });
    expect(token.sequence).toBe(1);
    expect(saves.length).toBe(1);
  });

  it("releases its own intent idempotently", () => {
    const { saves, coordinator } = fixture();
    const token = coordinator.recordIntent({ operation: "update", noteId: "n1" });
    coordinator.releaseIntent(token);
    expect(coordinator.snapshot().pending).toEqual([]);
    expect(saves.at(-1)).toEqual({ pending: [] });
    expect(() => coordinator.releaseIntent(token)).not.toThrow();
    expect(coordinator.snapshot().pending).toEqual([]);
  });

  it("keeps an earlier commit marker for the same note when releasing", () => {
    const { coordinator } = fixture();
    coordinator.recordLocalCommit(commit("update", "n1"));
    const original = coordinator.snapshot().pending[0];
    const token = coordinator.recordIntent({ operation: "update", noteId: "n1" });
    expect(coordinator.snapshot().pending.length).toBe(2);
    coordinator.releaseIntent(token);
    expect(coordinator.snapshot().pending).toEqual([original]);
  });

  it("does not release a marker whose noteId does not match", () => {
    const { saves, coordinator } = fixture();
    coordinator.recordLocalCommit(commit("update", "n1"));
    const marker = coordinator.snapshot().pending[0]!;
    const savesBefore = saves.length;
    coordinator.releaseIntent({ ...marker, noteId: "other" });
    expect(coordinator.snapshot().pending).toEqual([marker]);
    // An unmatched token is a persistence no-op too, not just a state no-op.
    expect(saves.length).toBe(savesBefore);
  });

  it("collapses to one marker when the commit follows the intent", () => {
    const { coordinator } = fixture();
    const token = coordinator.recordIntent({ operation: "update", noteId: "n1" });
    coordinator.recordLocalCommit(commit("update", "n1"));
    const pending = coordinator.snapshot().pending;
    expect(pending.filter((m) => m.operation === "update" && m.noteId === "n1").length).toBe(1);
    expect(pending.length).toBe(1);
    // The commit mints a fresh sequence, so releasing the intent token must not
    // remove the surviving marker: that marker is the only durable record of a
    // mutation that actually happened.
    expect(pending[0]!.sequence).toBeGreaterThan(token.sequence);
    coordinator.releaseIntent(token);
    expect(coordinator.snapshot().pending).toEqual(pending);
  });

  it("keeps an intent recorded during an in-flight sync after confirmation", async () => {
    const gate = deferred<{ status: "confirmed" }>();
    const saves: SyncCoordinatorState[] = [];
    let saved: SyncCoordinatorState | undefined;
    const coordinator = new SyncCoordinator({
      executor: () => gate.promise,
      stateStore: {
        load: () => saved,
        save: (s) => {
          saves.push(s);
          saved = s;
        },
      },
    });
    coordinator.recordLocalCommit(commit("append", "n1"));
    const flight = coordinator.requestSync();
    const token = coordinator.recordIntent({ operation: "update", noteId: "n2" });
    gate.resolve({ status: "confirmed" });
    await flight;
    expect(coordinator.snapshot().pending).toEqual([
      { operation: "update", noteId: "n2", sequence: token.sequence, origin: "unknown" },
    ]);
  });

  it("persists only the encrypted-store-compatible shape", () => {
    const { saves, coordinator } = fixture();
    coordinator.recordIntent({ operation: "delete", noteId: "n1" });
    const last = saves.at(-1)!;
    expect(Reflect.ownKeys(last)).toEqual(["pending"]);
    for (const marker of last.pending) {
      expect(Reflect.ownKeys(marker)).toEqual(["operation", "noteId", "sequence", "origin"]);
    }
  });
});

describe("S7a-3 — durable origin on every pending marker", () => {
  function fixture(initial?: unknown) {
    let saved: unknown = initial;
    const saves: unknown[] = [];
    const store = {
      load: () => saved,
      save: (state: SyncCoordinatorState) => {
        saves.push(state);
        saved = state;
      },
    };
    const executor = vi.fn<SyncExecutor>(async () => ({ status: "confirmed" as const }));
    const coordinator = new SyncCoordinator({ executor, stateStore: store, minIntervalMs: 0 });
    return { saves, store, executor, coordinator, saved: () => saved };
  }
  const withOrigin = (
    operation: SyncLocalCommit["operation"],
    id: string,
    origin: unknown,
  ): SyncLocalCommit => ({ ...commit(operation, id), origin }) as unknown as SyncLocalCommit;

  it("1: records an explicit mcp origin", () => {
    const { coordinator } = fixture();
    coordinator.recordLocalCommit(withOrigin("update", "n1", "mcp"));
    expect(coordinator.snapshot().pending.map((m) => m.origin)).toEqual(["mcp"]);
  });

  it("2: defaults a missing origin to unknown, never mcp", () => {
    const { coordinator } = fixture();
    coordinator.recordLocalCommit(commit("update", "n1"));
    coordinator.recordIntent({ operation: "append", noteId: "n2" });
    expect(coordinator.snapshot().pending.map((m) => m.origin)).toEqual(["unknown", "unknown"]);
  });

  it("2b: rejects an origin outside the closed set", () => {
    const { coordinator } = fixture();
    for (const bad of ["admin", 1, null, ""]) {
      expect(codeOf(() => coordinator.recordLocalCommit(withOrigin("update", "n1", bad)))).toBe(
        "invalid_input",
      );
      expect(
        codeOf(() =>
          coordinator.recordIntent({
            operation: "update",
            noteId: "n1",
            origin: bad,
          } as never),
        ),
      ).toBe("invalid_input");
    }
    expect(coordinator.snapshot().pending).toEqual([]);
  });

  it("3: an operator intent token carries its origin and releases exactly itself", () => {
    const { coordinator } = fixture();
    coordinator.recordLocalCommit(commit("update", "n9"));
    const token = coordinator.recordIntent({
      operation: "update",
      noteId: "n1",
      origin: "operator",
    });
    expect(token.origin).toBe("operator");
    coordinator.releaseIntent(token);
    expect(coordinator.snapshot().pending.map((m) => m.noteId)).toEqual(["n9"]);
  });

  it("4: an MCP commit after an operator intent leaves every marker for the note operator", () => {
    const { coordinator } = fixture();
    coordinator.recordIntent({ operation: "update", noteId: "n1", origin: "operator" });
    coordinator.recordLocalCommit(withOrigin("update", "n1", "mcp"));
    const forN1 = coordinator.snapshot().pending.filter((m) => m.noteId === "n1");
    expect(forN1.length).toBeGreaterThan(0);
    expect(forN1.every((m) => m.origin === "operator")).toBe(true);
  });

  it("5: an MCP update commit after an operator append marker is operator", () => {
    const { coordinator } = fixture();
    coordinator.recordIntent({ operation: "append", noteId: "n1", origin: "operator" });
    coordinator.recordLocalCommit(withOrigin("update", "n1", "mcp"));
    const update = coordinator.snapshot().pending.find((m) => m.operation === "update");
    expect(update?.origin).toBe("operator");
  });

  it("6: an MCP commit never lowers an unknown marker", () => {
    const { coordinator } = fixture();
    coordinator.recordIntent({ operation: "append", noteId: "n1" });
    coordinator.recordLocalCommit(withOrigin("update", "n1", "mcp"));
    expect(coordinator.snapshot().pending.map((m) => m.origin)).toEqual(["unknown", "unknown"]);
  });

  it("6b: the highest rank wins regardless of which operation holds it", () => {
    const { coordinator } = fixture();
    coordinator.recordLocalCommit(withOrigin("update", "n1", "mcp"));
    coordinator.recordIntent({ operation: "append", noteId: "n1", origin: "operator" });
    coordinator.recordLocalCommit(withOrigin("update", "n1", "mcp"));
    expect(coordinator.snapshot().pending.at(-1)?.origin).toBe("operator");
    coordinator.recordLocalCommit(withOrigin("update", "n2", "mcp"));
    expect(coordinator.snapshot().pending.at(-1)?.origin).toBe("mcp");
  });

  it("7: a create intent placeholder resolves to the real note id and survives reload", () => {
    const { coordinator, store } = fixture();
    const token = coordinator.recordCreateIntent({ origin: "operator" });
    expect(token.operation).toBe("create");
    expect(token.noteId).toMatch(/^nb-pending-create-\d+$/);
    expect(token.origin).toBe("operator");
    expect(coordinator.snapshot().pending).toEqual([token]);

    coordinator.resolveCreateIntent(token, "abc123");
    const pending = coordinator.snapshot().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ operation: "create", noteId: "abc123", origin: "operator" });
    expect(pending[0]!.sequence).toBeGreaterThan(token.sequence);

    const reloaded = new SyncCoordinator({ executor: vi.fn<SyncExecutor>(), stateStore: store });
    expect(reloaded.snapshot()).toEqual(coordinator.snapshot());
  });

  it("7b: resolving takes the sticky origin of existing markers and ignores unmatched tokens", () => {
    const { coordinator } = fixture();
    coordinator.recordIntent({ operation: "update", noteId: "abc123", origin: "operator" });
    const token = coordinator.recordCreateIntent({ origin: "mcp" });
    coordinator.resolveCreateIntent(token, "abc123");
    const created = coordinator.snapshot().pending.find((m) => m.operation === "create");
    expect(created?.origin).toBe("operator");

    const before = coordinator.snapshot();
    coordinator.resolveCreateIntent(token, "zzz");
    expect(coordinator.snapshot()).toEqual(before);
  });

  it("8: releaseIntent removes a create placeholder", () => {
    const { coordinator } = fixture();
    const token = coordinator.recordCreateIntent({ origin: "operator" });
    coordinator.releaseIntent(token);
    expect(coordinator.snapshot().pending).toEqual([]);
  });

  it("9: the placeholder prefix is reserved for real note ids", () => {
    const { coordinator } = fixture();
    const reserved = "nb-pending-create-7";
    expect(codeOf(() => coordinator.recordLocalCommit(commit("update", reserved)))).toBe(
      "invalid_input",
    );
    expect(codeOf(() => coordinator.recordIntent({ operation: "update", noteId: reserved }))).toBe(
      "invalid_input",
    );
    const token = coordinator.recordCreateIntent({ origin: "mcp" });
    expect(codeOf(() => coordinator.resolveCreateIntent(token, reserved))).toBe("invalid_input");
  });

  it("10: a full queue refuses a create intent and persists nothing", () => {
    const { coordinator, saves } = fixture();
    for (let i = 0; i < 64; i++) coordinator.recordIntent({ operation: "update", noteId: `n${i}` });
    const count = saves.length;
    expect(codeOf(() => coordinator.recordCreateIntent({ origin: "operator" }))).toBe(
      "sync_failed",
    );
    expect(saves.length).toBe(count);
    expect(coordinator.snapshot().pending).toHaveLength(64);
  });

  it("10b: a create intent requires a valid origin when one is given", () => {
    const { coordinator } = fixture();
    expect(codeOf(() => coordinator.recordCreateIntent({ origin: "admin" } as never))).toBe(
      "invalid_input",
    );
    expect(coordinator.recordCreateIntent({}).origin).toBe("unknown");
  });

  it("11: the executor batch includes origin", async () => {
    const { coordinator, executor } = fixture();
    coordinator.recordLocalCommit(withOrigin("update", "n1", "mcp"));
    coordinator.recordIntent({ operation: "append", noteId: "n2", origin: "operator" });
    await coordinator.requestSync();
    const request = executor.mock.calls[0]![0];
    expect(request.pending.map((m) => m.origin)).toEqual(["mcp", "operator"]);
  });

  it("12: operator and unknown markers do not block a confirmed sync", async () => {
    const { coordinator } = fixture();
    coordinator.recordIntent({ operation: "update", noteId: "n1", origin: "operator" });
    coordinator.recordIntent({ operation: "update", noteId: "n2" });
    const result = await coordinator.requestSync();
    expect(result.status).toBe("synced");
    expect(coordinator.snapshot().pending).toEqual([]);
  });

  it("loads stored markers with a valid origin and rejects an invalid one", () => {
    const good = {
      pending: [{ operation: "update", noteId: "n1", sequence: 1, origin: "operator" }],
    };
    expect(fixture(good).coordinator.snapshot().pending[0]!.origin).toBe("operator");
    const legacy = { pending: [{ operation: "update", noteId: "n1", sequence: 1 }] };
    expect(fixture(legacy).coordinator.snapshot().pending[0]!.origin).toBe("unknown");
    const bad = { pending: [{ operation: "update", noteId: "n1", sequence: 1, origin: "admin" }] };
    expect(() => fixture(bad)).toThrow();
  });
});
