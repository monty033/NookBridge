/**
 * Stage 4 — narrow local-write composition seam.
 *
 * These tests exercise only the offline composition of the local write
 * adapter and the metadata-only synchronization coordinator.  No
 * Notesnook package, transport, network, credential, Vault state, or
 * plaintext note body is imported or reachable from any fixture; the
 * adapter fixtures are deterministic in-memory objects.
 *
 * The suite is deliberately adversarial.  It asserts:
 *
 *   - all three local operations record pending metadata and preserve
 *     `localCommitted` / `remoteSynced` / `pendingSync`;
 *   - remote execution stays an explicit separate call and no executor
 *     runs as a side effect of a local write;
 *   - relayed results are fresh, frozen copies that omit every injected
 *     extra/body field;
 *   - queue-recording failure is categorical and never claims remote
 *     synchronization;
 *   - adapter and coordinator methods are invoked with the correct
 *     receiver;
 *   - hostile options, hostile results, and foreign throws are
 *     normalised categorically without message/cause leakage;
 *   - the public surface is exactly the explicit method set and exposes
 *     no forbidden capability.
 */

import { readFileSync } from "node:fs";
import { dirname as dirnameOf, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NotesnookLocalWriteComposition,
  createNotesnookLocalWriteComposition,
  isNotesnookWriteCompositionError,
  type NotesnookLocalWriteHandle,
  type NotesnookPendingSyncHandle,
} from "../src/core/notesnook-write-composition.js";
import {
  SyncCoordinator,
  type SyncCoordinatorState,
  type SyncExecutor,
} from "../src/core/notesnook-sync-coordinator.js";
import {
  createNotesnookWriteAdapter,
  isNotesnookWriteAdapterError,
  type AppendNoteResult,
  type CreateNoteResult,
  type NotesnookStoredContent,
  type NotesnookWriteAdapter,
  type NotesnookWriteDatabase,
  type NotesnookWriteMarkdownCodec,
  type NotesnookWriteNoteMetadata,
  type NotesnookWriteStoredContent,
  type UpdateNoteResult,
} from "../src/core/notesnook-write-adapter.js";
import {
  NotesnookWriteContractError,
  createRevisionToken,
  isNotesnookWriteContractError,
  type NotesnookRevisionToken,
} from "../src/core/notesnook-write-contract.js";

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const OTHER_NOTE_ID = "fedcba9876543210fedcba9876543210";
const NOTEBOOK_ID = "notebook-1";
const TAG_ID = "tag-1";
const DATE_EDITED = 1_724_000_000_000;

/** Canary strings. None may ever appear in a relayed value or error. */
const SECRET = "CANARY-plaintext-body-and-credential";
const SECRET_CAUSE = "CANARY-upstream-cause-payload";

function revision(id = NOTE_ID, dateEdited = DATE_EDITED): NotesnookRevisionToken {
  return createRevisionToken({ id, dateEdited });
}

// ---------------------------------------------------------------------------
// Deterministic adapter/coordinator fixtures.
// ---------------------------------------------------------------------------

const codec: NotesnookWriteMarkdownCodec = Object.freeze({
  encodeMarkdown: (markdown: string): NotesnookStoredContent =>
    Object.freeze({ type: "html" as const, data: `<p>${markdown.length}</p>` }),
  appendMarkdownToStoredContent: (input: {
    readonly storedType: "tiptap" | "html";
    readonly storedData: string;
    readonly markdownFragment: string;
  }): NotesnookStoredContent =>
    Object.freeze({
      type: input.storedType,
      data: `${input.storedData}<p>${input.markdownFragment.length}</p>`,
    }),
});

interface FakeSeam {
  readonly database: NotesnookWriteDatabase;
  readonly calls: string[];
}

/** A minimal in-memory write seam. It holds byte counts, never bodies. */
function fakeSeam(): FakeSeam {
  const calls: string[] = [];
  const note: NotesnookWriteNoteMetadata = Object.freeze({
    id: NOTE_ID,
    title: "fixture",
    notebookId: NOTEBOOK_ID,
    pinned: false,
    favorite: false,
    conflicted: false,
    locked: false,
    dateEdited: DATE_EDITED,
  });
  const stored: NotesnookWriteStoredContent = Object.freeze({
    id: "content-1",
    noteId: NOTE_ID,
    type: "html" as const,
    data: "<p>0</p>",
  });
  const database: NotesnookWriteDatabase = Object.freeze({
    note: async (id: string) => {
      calls.push("note");
      return id === NOTE_ID ? note : undefined;
    },
    contentFindByNoteId: async () => {
      calls.push("contentFindByNoteId");
      return stored;
    },
    notesAdd: async () => {
      calls.push("notesAdd");
      return OTHER_NOTE_ID;
    },
    notesUpdate: async () => {
      calls.push("notesUpdate");
    },
    notesTouch: async () => {
      calls.push("notesTouch");
    },
    contentAdd: async () => {
      calls.push("contentAdd");
      return "content-2";
    },
    contentUpdateByNoteId: async () => {
      calls.push("contentUpdateByNoteId");
    },
    notebookExists: async () => {
      calls.push("notebookExists");
      return true;
    },
    notebookNotes: async () => {
      calls.push("notebookNotes");
      return Object.freeze([NOTE_ID]);
    },
    notebookAddNote: async () => {
      calls.push("notebookAddNote");
    },
    notebookRemoveNote: async () => {
      calls.push("notebookRemoveNote");
    },
    tagExists: async () => {
      calls.push("tagExists");
      return true;
    },
    tagAdd: async () => {
      calls.push("tagAdd");
      return TAG_ID;
    },
    relationAdd: async () => {
      calls.push("relationAdd");
    },
    relationRemove: async () => {
      calls.push("relationRemove");
    },
    relationListForNote: async () => {
      calls.push("relationListForNote");
      return Object.freeze([]);
    },
  });
  return { database, calls };
}

function realAdapter(): { adapter: NotesnookWriteAdapter; calls: string[] } {
  const seam = fakeSeam();
  return {
    adapter: createNotesnookWriteAdapter({ source: seam.database, codec }),
    calls: seam.calls,
  };
}

/** A recording coordinator stand-in that satisfies the pending-sync handle. */
interface StubCoordinator extends NotesnookPendingSyncHandle {
  readonly receipts: unknown[];
  readonly syncCalls: number[];
  readonly snapshotCalls: number[];
}

function stubCoordinator(
  overrides: {
    readonly onRecord?: (receipt: unknown) => unknown;
    readonly onSync?: () => unknown;
    readonly onSnapshot?: () => unknown;
  } = {},
): StubCoordinator {
  const receipts: unknown[] = [];
  const syncCalls: number[] = [];
  const snapshotCalls: number[] = [];
  const handle = {
    receipts,
    syncCalls,
    snapshotCalls,
    recordLocalCommit(receipt: unknown) {
      receipts.push(receipt);
      if (overrides.onRecord !== undefined) return overrides.onRecord(receipt) as never;
      const record = receipt as { readonly operation: string; readonly id: string };
      return Object.freeze({
        operation: record.operation,
        id: record.id,
        localCommitted: true,
        remoteSynced: false,
        pendingSync: true,
      }) as never;
    },
    requestSync() {
      syncCalls.push(1);
      if (overrides.onSync !== undefined) return overrides.onSync() as never;
      return Promise.resolve(
        Object.freeze({
          status: "idle",
          localCommitted: false,
          remoteSynced: false,
          pendingSync: false,
          attempts: 0,
          startedAt: 5,
        }),
      ) as never;
    },
    snapshot() {
      snapshotCalls.push(1);
      if (overrides.onSnapshot !== undefined) return overrides.onSnapshot() as never;
      return Object.freeze({ pending: Object.freeze([]) }) as never;
    },
  };
  return handle as unknown as StubCoordinator;
}

/** Minimal adapter stand-in returning caller-chosen raw results. */
function stubAdapter(results: {
  readonly create?: () => unknown;
  readonly append?: () => unknown;
  readonly update?: () => unknown;
}): NotesnookLocalWriteHandle & { readonly commands: unknown[] } {
  const commands: unknown[] = [];
  const handle = {
    commands,
    createNote(command: unknown) {
      commands.push(command);
      return Promise.resolve(results.create?.()) as never;
    },
    appendNote(command: unknown) {
      commands.push(command);
      return Promise.resolve(results.append?.()) as never;
    },
    updateNote(command: unknown) {
      commands.push(command);
      return Promise.resolve(results.update?.()) as never;
    },
  };
  return handle as unknown as NotesnookLocalWriteHandle & { readonly commands: unknown[] };
}

function goodCreateResult(extra: Record<string, unknown> = {}): unknown {
  return {
    operation: "create",
    id: NOTE_ID,
    titleBytes: 7,
    contentBytes: 11,
    localCommitted: true,
    remoteSynced: false,
    pendingSync: true,
    ...extra,
  };
}

async function codeOf(fn: () => unknown): Promise<NotesnookWriteContractError["code"]> {
  try {
    await fn();
  } catch (error) {
    if (!isNotesnookWriteCompositionError(error)) {
      throw new Error("expected a categorical composition error");
    }
    // Composition errors remain contract errors so existing callers keep working.
    expect(isNotesnookWriteContractError(error)).toBe(true);
    expect(error.cause).toBeUndefined();
    expect(String(error.message)).not.toContain(SECRET);
    expect(String(error.message)).not.toContain(SECRET_CAUSE);
    expect(String(error.stack ?? "")).not.toContain(SECRET);
    return error.code;
  }
  throw new Error("expected the composition to fail closed");
}

/**
 * Materialise the bounded pending-snapshot shape so the structural
 * `toEqual` deep-equality matcher can compare it against a regular
 * `{ pending: [...] }` literal.
 *
 * The composition's published `pendingSnapshot()` returns a frozen
 * null-prototype object whose `pending` field is a frozen null-prototype
 * array; iterating with `Array.from` walks the own enumerable index
 * descriptors (which is exactly how consumers index the array in
 * production), and the inner markers are themselves frozen
 * null-prototype objects whose own enumerable string keys match a
 * plain-object literal at the toEqual level.  No inherited `Array.prototype`
 * / `Object.prototype` method is invoked, so the closed surface
 * guarantee is preserved.
 */
function pendingSnapshotAsPlain(snapshot: { readonly pending: ReadonlyArray<unknown> }): {
  readonly pending: unknown[];
} {
  return {
    pending: Array.from(snapshot.pending as unknown as Iterable<unknown>),
  };
}

// ---------------------------------------------------------------------------
// 1. All three operations record bounded pending metadata.
// ---------------------------------------------------------------------------

describe("Stage 4 write composition — local commits become pending metadata", () => {
  it("records a pending marker for a real create and keeps remote sync separate", async () => {
    const { adapter } = realAdapter();
    const executors: unknown[] = [];
    const executor: SyncExecutor = async (request) => {
      executors.push(request);
      return { status: "confirmed" };
    };
    const coordinator = new SyncCoordinator({ executor, now: () => 1000 });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    const result: CreateNoteResult = await composition.createNote({
      title: "fixture title",
      content: "body text",
    });

    expect(result).toEqual({
      operation: "create",
      id: OTHER_NOTE_ID,
      titleBytes: 13,
      contentBytes: 9,
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });
    expect(pendingSnapshotAsPlain(composition.pendingSnapshot())).toEqual({
      pending: [{ operation: "create", noteId: OTHER_NOTE_ID, sequence: 1 }],
    });
    // No executor ran as a side effect of the local write.
    expect(executors).toEqual([]);
  });

  it("records a pending marker for a real append", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    const result: AppendNoteResult = await composition.appendNote({
      id: NOTE_ID,
      markdownFragment: "one line",
      expectedRevision: revision(),
    });

    expect(result).toEqual({
      operation: "append",
      id: NOTE_ID,
      contentBytes: 8,
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });
    expect(pendingSnapshotAsPlain(composition.pendingSnapshot())).toEqual({
      pending: [{ operation: "append", noteId: NOTE_ID, sequence: 1 }],
    });
  });

  it("records a pending marker for a real controlled update", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    const result: UpdateNoteResult = await composition.updateNote({
      id: NOTE_ID,
      patch: { title: "renamed", pinned: true },
      expectedRevision: revision(),
    });

    expect({ ...result, appliedFields: Array.from(result.appliedFields) }).toEqual({
      operation: "update",
      id: NOTE_ID,
      appliedFields: ["pinned", "title"],
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });
    expect(Array.isArray(result.appliedFields)).toBe(true);
    expect(Object.getPrototypeOf(result.appliedFields)).toBeNull();
    expect(pendingSnapshotAsPlain(composition.pendingSnapshot())).toEqual({
      pending: [{ operation: "update", noteId: NOTE_ID, sequence: 1 }],
    });
  });

  it("relays an update content byte count when the patch touched content", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    const result = await composition.updateNote({
      id: NOTE_ID,
      patch: { content: "new body" },
      expectedRevision: revision(),
    });

    expect({ ...result, appliedFields: Array.from(result.appliedFields) }).toEqual({
      operation: "update",
      id: NOTE_ID,
      appliedFields: ["content"],
      contentBytes: 8,
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });
  });

  it("accumulates one bounded marker per distinct local operation", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    await composition.appendNote({
      id: NOTE_ID,
      markdownFragment: "a",
      expectedRevision: revision(),
    });
    await composition.updateNote({
      id: NOTE_ID,
      patch: { pinned: true },
      expectedRevision: revision(),
    });
    await composition.createNote({ title: "t", content: "c" });

    expect(Array.from(composition.pendingSnapshot().pending)).toEqual([
      { operation: "append", noteId: NOTE_ID, sequence: 1 },
      { operation: "update", noteId: NOTE_ID, sequence: 2 },
      { operation: "create", noteId: OTHER_NOTE_ID, sequence: 3 },
    ]);
  });

  it("hands the coordinator only the bounded metadata receipt", async () => {
    const coordinator = stubCoordinator();
    const adapter = stubAdapter({
      create: () => goodCreateResult({ body: SECRET, appliedFields: ["title"] }),
    });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    await composition.createNote({ title: "t", content: "c" });

    expect(coordinator.receipts).toHaveLength(1);
    expect(coordinator.receipts[0]).toEqual({
      operation: "create",
      id: NOTE_ID,
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });
    expect(Object.keys(coordinator.receipts[0] as object).sort()).toEqual([
      "id",
      "localCommitted",
      "operation",
      "pendingSync",
      "remoteSynced",
    ]);
    expect(Object.isFrozen(coordinator.receipts[0])).toBe(true);
    expect(JSON.stringify(coordinator.receipts)).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// 2. The remote boundary stays explicit and separate.
// ---------------------------------------------------------------------------

describe("Stage 4 write composition — the remote boundary stays separate", () => {
  it("never runs the executor during any local mutation", async () => {
    const { adapter } = realAdapter();
    let executorCalls = 0;
    const coordinator = new SyncCoordinator({
      executor: async () => {
        executorCalls++;
        return { status: "confirmed" };
      },
    });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    await composition.createNote({ title: "t", content: "c" });
    await composition.appendNote({
      id: NOTE_ID,
      markdownFragment: "f",
      expectedRevision: revision(),
    });
    await composition.updateNote({
      id: NOTE_ID,
      patch: { favorite: true },
      expectedRevision: revision(),
    });

    expect(executorCalls).toBe(0);
    expect(composition.pendingSnapshot().pending).toHaveLength(3);

    // Only the explicit call reaches the remote policy.
    await expect(composition.requestSync()).resolves.toMatchObject({
      status: "synced",
      localCommitted: true,
      remoteSynced: true,
      pendingSync: false,
    });
    expect(executorCalls).toBe(1);
    expect(pendingSnapshotAsPlain(composition.pendingSnapshot())).toEqual({ pending: [] });
  });

  it("never invokes the coordinator's requestSync as part of a local write", async () => {
    const coordinator = stubCoordinator();
    const adapter = stubAdapter({ create: () => goodCreateResult() });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    await composition.createNote({ title: "t", content: "c" });
    expect(coordinator.syncCalls).toHaveLength(0);

    await composition.requestSync();
    expect(coordinator.syncCalls).toHaveLength(1);
  });

  it("relays a failed remote outcome as still pending, never as synced", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({
      executor: async () => ({ status: "failed" }),
      maxAttempts: 1,
    });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });
    await composition.createNote({ title: "t", content: "c" });

    const outcome = await composition.requestSync();
    expect(outcome).toMatchObject({
      status: "failed",
      errorCode: "sync_failed",
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });
    expect(composition.pendingSnapshot().pending).toHaveLength(1);
  });

  it("runs native sync for an empty queue and reports remote reconciliation", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({
      executor: async () => ({ status: "confirmed" }),
      now: () => 42,
    });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    await expect(composition.requestSync()).resolves.toEqual({
      status: "synced",
      localCommitted: false,
      remoteSynced: true,
      pendingSync: false,
      attempts: 1,
      startedAt: 42,
    });
  });

  it("refuses to relay a remote-success claim with no completed attempt", async () => {
    const adapter = stubAdapter({ create: () => goodCreateResult() });
    const coordinator = stubCoordinator({
      onSync: () =>
        Promise.resolve({
          status: "synced",
          localCommitted: true,
          // A coordinator stand-in that claims "synced" without an actual
          // completed attempt must not be relayed as a remote success.
          remoteSynced: true,
          pendingSync: true,
          attempts: 0,
          startedAt: 1,
        }),
    });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    expect(await codeOf(() => composition.requestSync())).toBe("sync_failed");
  });

  it("refuses an unknown remote status and a malformed attempt count", async () => {
    const adapter = stubAdapter({ create: () => goodCreateResult() });
    const unknownStatus = createNotesnookLocalWriteComposition({
      adapter,
      coordinator: stubCoordinator({
        onSync: () => Promise.resolve({ status: "confirmed", attempts: 1, startedAt: 1 }),
      }),
    });
    expect(await codeOf(() => unknownStatus.requestSync())).toBe("invalid_input");

    const badAttempts = createNotesnookLocalWriteComposition({
      adapter,
      coordinator: stubCoordinator({
        onSync: () =>
          Promise.resolve({
            status: "synced",
            localCommitted: true,
            remoteSynced: true,
            pendingSync: false,
            attempts: -1,
            startedAt: 1,
          }),
      }),
    });
    expect(await codeOf(() => badAttempts.requestSync())).toBe("sync_failed");
  });
});

// ---------------------------------------------------------------------------
// 3. Relayed results are fresh, bounded, immutable copies.
// ---------------------------------------------------------------------------

describe("Stage 4 write composition — bounded immutable result copies", () => {
  it("omits injected extra and body fields from every relayed result", async () => {
    const coordinator = stubCoordinator();
    const adapter = stubAdapter({
      create: () =>
        goodCreateResult({
          body: SECRET,
          content: SECRET,
          data: SECRET,
          password: SECRET,
          notebookId: NOTEBOOK_ID,
          database: {},
          sync: () => undefined,
        }),
      append: () => ({
        operation: "append",
        id: NOTE_ID,
        contentBytes: 4,
        localCommitted: true,
        remoteSynced: false,
        pendingSync: true,
        rawRecord: SECRET,
      }),
      update: () => ({
        operation: "update",
        id: NOTE_ID,
        appliedFields: ["title"],
        localCommitted: true,
        remoteSynced: false,
        pendingSync: true,
        token: SECRET,
      }),
    });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    const created = await composition.createNote({ title: "t", content: "c" });
    const appended = await composition.appendNote({
      id: NOTE_ID,
      markdownFragment: "f",
      expectedRevision: revision(),
    });
    const updated = await composition.updateNote({
      id: NOTE_ID,
      patch: { title: "t" },
      expectedRevision: revision(),
    });

    expect(Object.keys(created).sort()).toEqual([
      "contentBytes",
      "id",
      "localCommitted",
      "operation",
      "pendingSync",
      "remoteSynced",
      "titleBytes",
    ]);
    expect(Object.keys(appended).sort()).toEqual([
      "contentBytes",
      "id",
      "localCommitted",
      "operation",
      "pendingSync",
      "remoteSynced",
    ]);
    expect(Object.keys(updated).sort()).toEqual([
      "appliedFields",
      "id",
      "localCommitted",
      "operation",
      "pendingSync",
      "remoteSynced",
    ]);
    for (const relayed of [created, appended, updated]) {
      expect(JSON.stringify(relayed)).not.toContain(SECRET);
      expect(Object.isFrozen(relayed)).toBe(true);
    }
  });

  it("returns a fresh object rather than the adapter's own result", async () => {
    const source = goodCreateResult() as Record<string, unknown>;
    const coordinator = stubCoordinator();
    const adapter = stubAdapter({ create: () => source });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    const relayed = await composition.createNote({ title: "t", content: "c" });
    expect(relayed).not.toBe(source);

    // Mutating the adapter's own (unfrozen) result cannot retroactively
    // change what the composition already returned.
    source.id = OTHER_NOTE_ID;
    source.contentBytes = 999;
    expect(relayed.id).toBe(NOTE_ID);
    expect(relayed.contentBytes).toBe(11);
  });

  it("re-asserts the outcome flags from literals and freezes nested arrays", async () => {
    const coordinator = stubCoordinator();
    const adapter = stubAdapter({
      update: () => ({
        operation: "update",
        id: NOTE_ID,
        appliedFields: ["title", "pinned"],
        localCommitted: true,
        remoteSynced: false,
        pendingSync: true,
      }),
    });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    const relayed = await composition.updateNote({
      id: NOTE_ID,
      patch: { title: "t" },
      expectedRevision: revision(),
    });

    expect(relayed.localCommitted).toBe(true);
    expect(relayed.remoteSynced).toBe(false);
    expect(relayed.pendingSync).toBe(true);
    expect(Object.isFrozen(relayed.appliedFields)).toBe(true);
    expect(() => {
      (relayed as { remoteSynced: boolean }).remoteSynced = true;
    }).toThrow(TypeError);
    expect(() => {
      (relayed.appliedFields as NotesnookUpdatePatchFieldMutable[]).push("content");
    }).toThrow(TypeError);
  });

  it("returns frozen defensive snapshots that do not alias the coordinator state", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });
    await composition.createNote({ title: "t", content: "c" });

    const first = composition.pendingSnapshot();
    const second = composition.pendingSnapshot();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.pending)).toBe(true);
    expect(Object.isFrozen(first.pending[0])).toBe(true);
    expect(pendingSnapshotAsPlain(coordinator.snapshot())).toEqual(pendingSnapshotAsPlain(first));
  });
});

type NotesnookUpdatePatchFieldMutable = "title" | "content" | "pinned";

// ---------------------------------------------------------------------------
// 4. Queue-recording failure is categorical.
// ---------------------------------------------------------------------------

describe("Stage 4 write composition — queue recording failure is explicit", () => {
  it("surfaces a coordinator persistence failure categorically", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({
      executor: async () => ({ status: "confirmed" }),
      stateStore: {
        load: () => undefined,
        save: () => {
          throw new Error(SECRET);
        },
      },
    });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    expect(await codeOf(() => composition.createNote({ title: "t", content: "c" }))).toBe(
      "sync_failed",
    );
    expect(pendingSnapshotAsPlain(composition.pendingSnapshot())).toEqual({ pending: [] });
  });

  it("never reports remote synchronization when recording throws", async () => {
    const adapter = stubAdapter({ create: () => goodCreateResult() });
    const coordinator = stubCoordinator({
      onRecord: () => {
        const error = new Error(SECRET);
        Object.defineProperty(error, "cause", { value: SECRET_CAUSE });
        throw error;
      },
    });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    let observed: unknown;
    try {
      await composition.createNote({ title: "t", content: "c" });
    } catch (error) {
      observed = error;
    }
    expect(isNotesnookWriteCompositionError(observed)).toBe(true);
    expect((observed as NotesnookWriteContractError).code).toBe("sync_failed");
    expect(JSON.stringify(String((observed as Error).message))).not.toContain(SECRET);
    expect((observed as Error).cause).toBeUndefined();
  });

  it("preserves the coordinator's own categorical code for a bounded-queue refusal", async () => {
    const adapter = stubAdapter({ create: () => goodCreateResult() });
    const coordinator = stubCoordinator({
      onRecord: () => {
        throw new NotesnookWriteContractError("invalid_input", SECRET);
      },
    });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    expect(await codeOf(() => composition.createNote({ title: "t", content: "c" }))).toBe(
      "invalid_input",
    );
  });

  it("fails closed when the coordinator acknowledges anything but a pending marker", async () => {
    const adapter = stubAdapter({
      create: () => goodCreateResult(),
      append: () => ({
        operation: "append",
        id: NOTE_ID,
        contentBytes: 1,
        localCommitted: true,
        remoteSynced: false,
        pendingSync: true,
      }),
      update: () => ({
        operation: "update",
        id: NOTE_ID,
        appliedFields: ["title"],
        localCommitted: true,
        remoteSynced: false,
        pendingSync: true,
      }),
    });

    // A "remotely synced" acknowledgement must not be accepted.
    const syncedAck = createNotesnookLocalWriteComposition({
      adapter,
      coordinator: stubCoordinator({
        onRecord: () => ({
          operation: "create",
          id: NOTE_ID,
          localCommitted: true,
          remoteSynced: true,
          pendingSync: false,
        }),
      }),
    });
    expect(await codeOf(() => syncedAck.createNote({ title: "t", content: "c" }))).toBe(
      "sync_failed",
    );

    // An acknowledgement for a different note id must not be accepted.
    const wrongId = createNotesnookLocalWriteComposition({
      adapter,
      coordinator: stubCoordinator({
        onRecord: () => ({
          operation: "append",
          id: OTHER_NOTE_ID,
          localCommitted: true,
          remoteSynced: false,
          pendingSync: true,
        }),
      }),
    });
    expect(
      await codeOf(() =>
        wrongId.appendNote({
          id: NOTE_ID,
          markdownFragment: "f",
          expectedRevision: revision(),
        }),
      ),
    ).toBe("sync_failed");

    // An asynchronous acknowledgement is not durable yet.
    const asyncAck = createNotesnookLocalWriteComposition({
      adapter,
      coordinator: stubCoordinator({
        onRecord: () =>
          Promise.resolve({
            operation: "update",
            id: NOTE_ID,
            localCommitted: true,
            remoteSynced: false,
            pendingSync: true,
          }),
      }),
    });
    expect(
      await codeOf(() =>
        asyncAck.updateNote({
          id: NOTE_ID,
          patch: { title: "t" },
          expectedRevision: revision(),
        }),
      ),
    ).toBe("sync_failed");

    // A non-object acknowledgement is refused.
    const primitiveAck = createNotesnookLocalWriteComposition({
      adapter,
      coordinator: stubCoordinator({ onRecord: () => "queued" }),
    });
    expect(await codeOf(() => primitiveAck.createNote({ title: "t", content: "c" }))).toBe(
      "sync_failed",
    );
  });

  it("absorbs a hostile acknowledgement accessor as a recording failure", async () => {
    const adapter = stubAdapter({ create: () => goodCreateResult() });
    const coordinator = stubCoordinator({
      onRecord: () =>
        new Proxy(
          {},
          {
            get() {
              throw new Error(SECRET);
            },
          },
        ),
    });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    expect(await codeOf(() => composition.createNote({ title: "t", content: "c" }))).toBe(
      "sync_failed",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Receiver binding.
// ---------------------------------------------------------------------------

describe("Stage 4 write composition — receiver-safe seam invocation", () => {
  it("invokes adapter and coordinator methods with their own receivers", async () => {
    const seen: string[] = [];
    class RecordingAdapter {
      readonly #marker = "adapter";
      async createNote(): Promise<unknown> {
        seen.push(this.#marker);
        return goodCreateResult();
      }
      async appendNote(): Promise<unknown> {
        seen.push(this.#marker);
        return {
          operation: "append",
          id: NOTE_ID,
          contentBytes: 1,
          localCommitted: true,
          remoteSynced: false,
          pendingSync: true,
        };
      }
      async updateNote(): Promise<unknown> {
        seen.push(this.#marker);
        return {
          operation: "update",
          id: NOTE_ID,
          appliedFields: ["title"],
          localCommitted: true,
          remoteSynced: false,
          pendingSync: true,
        };
      }
    }
    class RecordingCoordinator {
      readonly #marker = "coordinator";
      recordLocalCommit(receipt: { readonly operation: string; readonly id: string }): unknown {
        seen.push(this.#marker);
        return {
          operation: receipt.operation,
          id: receipt.id,
          localCommitted: true,
          remoteSynced: false,
          pendingSync: true,
        };
      }
      async requestSync(): Promise<unknown> {
        seen.push(this.#marker);
        return {
          status: "idle",
          localCommitted: false,
          remoteSynced: false,
          pendingSync: false,
          attempts: 0,
          startedAt: 0,
        };
      }
      snapshot(): unknown {
        seen.push(this.#marker);
        return { pending: [] };
      }
    }

    const composition = createNotesnookLocalWriteComposition({
      adapter: new RecordingAdapter() as unknown as NotesnookLocalWriteHandle,
      coordinator: new RecordingCoordinator() as unknown as NotesnookPendingSyncHandle,
    });

    // Private-field access inside each method throws a raw TypeError when
    // the receiver is wrong, so a green run proves correct binding.
    await composition.createNote({ title: "t", content: "c" });
    await composition.appendNote({
      id: NOTE_ID,
      markdownFragment: "f",
      expectedRevision: revision(),
    });
    await composition.updateNote({
      id: NOTE_ID,
      patch: { title: "t" },
      expectedRevision: revision(),
    });
    await composition.requestSync();
    composition.pendingSnapshot();

    expect(seen).toEqual([
      "adapter",
      "coordinator",
      "adapter",
      "coordinator",
      "adapter",
      "coordinator",
      "coordinator",
      "coordinator",
    ]);
  });

  it("works with the real adapter and coordinator classes whose state is private", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    // Both real classes are frozen and use `#private` fields; a wrong
    // receiver would throw a raw TypeError instead of resolving.
    await expect(composition.createNote({ title: "t", content: "c" })).resolves.toMatchObject({
      operation: "create",
    });
  });

  it("fails closed categorically for a detached or foreign receiver", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    const detached = composition.createNote;
    expect(await codeOf(() => detached.call({} as never, { title: "t", content: "c" }))).toBe(
      "invalid_input",
    );
    const detachedSnapshot = composition.pendingSnapshot;
    expect(await codeOf(() => detachedSnapshot.call({} as never))).toBe("invalid_input");
    const detachedSync = composition.requestSync;
    expect(await codeOf(() => detachedSync.call({} as never))).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// 6. Hostile construction options, results, and throws.
// ---------------------------------------------------------------------------

describe("Stage 4 write composition — hostile input normalisation", () => {
  it("rejects malformed and hostile construction options categorically", async () => {
    const goodCoordinator = stubCoordinator();
    const goodAdapter = stubAdapter({ create: () => goodCreateResult() });

    for (const options of [
      undefined,
      null,
      "adapter",
      42,
      [],
      {},
      { adapter: goodAdapter },
      { coordinator: goodCoordinator },
      { adapter: null, coordinator: goodCoordinator },
      { adapter: goodAdapter, coordinator: null },
      { adapter: {}, coordinator: goodCoordinator },
      { adapter: goodAdapter, coordinator: {} },
      // A missing individual slot fails closed.
      {
        adapter: { createNote: () => undefined, appendNote: () => undefined },
        coordinator: goodCoordinator,
      },
      {
        adapter: goodAdapter,
        coordinator: { recordLocalCommit: () => undefined, requestSync: () => undefined },
      },
      // Non-callable slots fail closed.
      {
        adapter: { createNote: "x", appendNote: "y", updateNote: "z" },
        coordinator: goodCoordinator,
      },
    ]) {
      expect(await codeOf(() => createNotesnookLocalWriteComposition(options as never))).toBe(
        "invalid_input",
      );
    }
  });

  it("rejects a hostile options bag whose accessors throw", async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(SECRET);
        },
      },
    );
    expect(await codeOf(() => createNotesnookLocalWriteComposition(hostile as never))).toBe(
      "invalid_input",
    );

    const hostileAdapter = new Proxy(
      {},
      {
        get() {
          throw new Error(SECRET);
        },
        has() {
          throw new Error(SECRET);
        },
      },
    );
    expect(
      await codeOf(() =>
        createNotesnookLocalWriteComposition({
          adapter: hostileAdapter as never,
          coordinator: stubCoordinator(),
        }),
      ),
    ).toBe("invalid_input");
  });

  it("rejects handles that expose a forbidden capability", async () => {
    const forbidden = [
      "sync",
      "send",
      "full",
      "fetch",
      "delete",
      "force",
      "database",
      "db",
      "raw",
      "collection",
      "invoke",
      "call",
      "exec",
      "transport",
      "network",
      "credentials",
      "token",
      "password",
      "keystore",
      "vault",
      "vaultUnlock",
      "unlock",
      "login",
      "listNotebooks",
      "noteMetadata",
      "search",
      "status",
      "lastSynced",
      "hasUnsyncedChanges",
    ];
    for (const name of forbidden) {
      const widenedAdapter = {
        createNote: () => undefined,
        appendNote: () => undefined,
        updateNote: () => undefined,
        [name]: () => undefined,
      };
      expect(
        await codeOf(() =>
          createNotesnookLocalWriteComposition({
            adapter: widenedAdapter as never,
            coordinator: stubCoordinator(),
          }),
        ),
      ).toBe("invalid_input");

      const widenedCoordinator = {
        recordLocalCommit: () => undefined,
        requestSync: () => undefined,
        snapshot: () => undefined,
        [name]: () => undefined,
      };
      expect(
        await codeOf(() =>
          createNotesnookLocalWriteComposition({
            adapter: stubAdapter({}) as never,
            coordinator: widenedCoordinator as never,
          }),
        ),
      ).toBe("invalid_input");
    }
  });

  it("refuses a single fused object acting as both adapter and coordinator", async () => {
    const fused = {
      createNote: () => Promise.resolve(goodCreateResult()),
      appendNote: () => Promise.resolve(undefined),
      updateNote: () => Promise.resolve(undefined),
      recordLocalCommit: () => undefined,
      requestSync: () => Promise.resolve(undefined),
      snapshot: () => ({ pending: [] }),
    };
    expect(
      await codeOf(() =>
        createNotesnookLocalWriteComposition({
          adapter: fused as never,
          coordinator: fused as never,
        }),
      ),
    ).toBe("invalid_input");
  });

  it("rejects malformed and hostile adapter results without recording a marker", async () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [undefined, "invalid_input"],
      [null, "invalid_input"],
      ["done", "invalid_input"],
      [[], "invalid_input"],
      [{}, "invalid_input"],
      // Wrong operation label.
      [goodCreateResultWith({ operation: "append" }), "invalid_input"],
      // A relabelled remote-success claim must never be relayed.
      [goodCreateResultWith({ remoteSynced: true }), "invalid_input"],
      [goodCreateResultWith({ localCommitted: false }), "invalid_input"],
      [goodCreateResultWith({ pendingSync: false }), "invalid_input"],
      // Malformed ids.
      [goodCreateResultWith({ id: "" }), "invalid_input"],
      [goodCreateResultWith({ id: 7 }), "invalid_input"],
      [goodCreateResultWith({ id: `${NOTE_ID}\u0000${SECRET}` }), "invalid_input"],
      [goodCreateResultWith({ id: "x".repeat(129) }), "invalid_input"],
      // Malformed byte counts.
      [goodCreateResultWith({ contentBytes: -1 }), "invalid_input"],
      [goodCreateResultWith({ contentBytes: 1.5 }), "invalid_input"],
      [goodCreateResultWith({ contentBytes: Number.NaN }), "invalid_input"],
      [goodCreateResultWith({ contentBytes: 262_145 }), "invalid_input"],
      [goodCreateResultWith({ titleBytes: 1_025 }), "invalid_input"],
      [goodCreateResultWith({ titleBytes: "7" }), "invalid_input"],
    ];

    for (const [result, expected] of cases) {
      const coordinator = stubCoordinator();
      const composition = createNotesnookLocalWriteComposition({
        adapter: stubAdapter({ create: () => result }),
        coordinator,
      });
      expect(await codeOf(() => composition.createNote({ title: "t", content: "c" }))).toBe(
        expected,
      );
      expect(coordinator.receipts).toHaveLength(0);
    }
  });

  it("rejects malformed update applied-field lists", async () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [updateResultWith({ appliedFields: undefined }), "invalid_input"],
      [updateResultWith({ appliedFields: [] }), "invalid_input"],
      [updateResultWith({ appliedFields: "title" }), "invalid_input"],
      [updateResultWith({ appliedFields: [7] }), "invalid_input"],
      [updateResultWith({ appliedFields: ["title", "title"] }), "invalid_input"],
      // Fields outside the published allowlist are refused, not relayed.
      [updateResultWith({ appliedFields: ["deleted"] }), "unsupported_patch_field"],
      [updateResultWith({ appliedFields: ["locked"] }), "unsupported_patch_field"],
      [updateResultWith({ appliedFields: ["password"] }), "unsupported_patch_field"],
      [updateResultWith({ appliedFields: ["force"] }), "unsupported_patch_field"],
      [
        updateResultWith({
          appliedFields: ["title", "content", "notebookId", "tags", "pinned", "favorite", "title"],
        }),
        "invalid_input",
      ],
    ];
    for (const [result, expected] of cases) {
      const coordinator = stubCoordinator();
      const composition = createNotesnookLocalWriteComposition({
        adapter: stubAdapter({ update: () => result }),
        coordinator,
      });
      expect(
        await codeOf(() =>
          composition.updateNote({
            id: NOTE_ID,
            patch: { title: "t" },
            expectedRevision: revision(),
          }),
        ),
      ).toBe(expected);
      expect(coordinator.receipts).toHaveLength(0);
    }
  });

  it("normalises a hostile result proxy without leaking the canary", async () => {
    // `then` must resolve benignly, otherwise the throw happens while the
    // promise is being adopted and is (correctly) a seam failure instead
    // of a result-shape failure. This proxy therefore probes the
    // result-copying path itself.
    const hostileResult = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "then") return undefined;
          throw new Error(SECRET);
        },
        has() {
          throw new Error(SECRET);
        },
      },
    );
    const resultCoordinator = stubCoordinator();
    const resultComposition = createNotesnookLocalWriteComposition({
      adapter: stubAdapter({ create: () => hostileResult }),
      coordinator: resultCoordinator,
    });
    expect(await codeOf(() => resultComposition.createNote({ title: "t", content: "c" }))).toBe(
      "invalid_input",
    );
    expect(resultCoordinator.receipts).toHaveLength(0);

    // A proxy whose `then` accessor throws fails during promise adoption;
    // that is a seam failure, so `sync_failed` is the honest code.
    const hostileThenable = new Proxy(
      {},
      {
        get() {
          throw new Error(SECRET);
        },
      },
    );
    const thenableCoordinator = stubCoordinator();
    const thenableComposition = createNotesnookLocalWriteComposition({
      adapter: stubAdapter({ create: () => hostileThenable }),
      coordinator: thenableCoordinator,
    });
    expect(await codeOf(() => thenableComposition.createNote({ title: "t", content: "c" }))).toBe(
      "sync_failed",
    );
    expect(thenableCoordinator.receipts).toHaveLength(0);
  });

  it("normalises foreign throws from every seam method to sync_failed", async () => {
    const foreign = (): never => {
      const error = new Error(SECRET);
      Object.defineProperty(error, "cause", { value: SECRET_CAUSE });
      throw error;
    };

    const throwingAdapter = {
      createNote: foreign,
      appendNote: foreign,
      updateNote: foreign,
    } as unknown as NotesnookLocalWriteHandle;
    const composition = createNotesnookLocalWriteComposition({
      adapter: throwingAdapter,
      coordinator: stubCoordinator(),
    });
    expect(await codeOf(() => composition.createNote({ title: "t", content: "c" }))).toBe(
      "sync_failed",
    );
    expect(
      await codeOf(() =>
        composition.appendNote({
          id: NOTE_ID,
          markdownFragment: "f",
          expectedRevision: revision(),
        }),
      ),
    ).toBe("sync_failed");
    expect(
      await codeOf(() =>
        composition.updateNote({
          id: NOTE_ID,
          patch: { title: "t" },
          expectedRevision: revision(),
        }),
      ),
    ).toBe("sync_failed");

    const throwingRemote = createNotesnookLocalWriteComposition({
      adapter: stubAdapter({ create: () => goodCreateResult() }),
      coordinator: stubCoordinator({ onSync: foreign, onSnapshot: foreign }),
    });
    expect(await codeOf(() => throwingRemote.requestSync())).toBe("sync_failed");
    expect(await codeOf(() => throwingRemote.pendingSnapshot())).toBe("sync_failed");
  });

  it("normalises non-Error throws, including a thrown string and a null throw", async () => {
    for (const thrown of [SECRET, 42, null, undefined, Symbol("s")]) {
      const composition = createNotesnookLocalWriteComposition({
        adapter: {
          createNote: () => {
            throw thrown;
          },
          appendNote: () => undefined,
          updateNote: () => undefined,
        } as unknown as NotesnookLocalWriteHandle,
        coordinator: stubCoordinator(),
      });
      expect(await codeOf(() => composition.createNote({ title: "t", content: "c" }))).toBe(
        "sync_failed",
      );
    }
  });

  it("rejects a look-alike categorical error and refuses its forged code", async () => {
    const forged = new Error(SECRET);
    Object.defineProperty(forged, "name", { value: "NotesnookWriteAdapterError" });
    Object.defineProperty(forged, "code", { value: "conflict" });
    const composition = createNotesnookLocalWriteComposition({
      adapter: {
        createNote: () => {
          throw forged;
        },
        appendNote: () => undefined,
        updateNote: () => undefined,
      } as unknown as NotesnookLocalWriteHandle,
      coordinator: stubCoordinator(),
    });
    // Identity, not name/code, decides: a forged categorical error becomes
    // `sync_failed` rather than borrowing the adapter's vocabulary.
    expect(await codeOf(() => composition.createNote({ title: "t", content: "c" }))).toBe(
      "sync_failed",
    );
  });

  it("rejects a malformed or hostile coordinator snapshot", async () => {
    const cases: ReadonlyArray<unknown> = [
      undefined,
      null,
      "pending",
      {},
      { pending: "none" },
      { pending: {} },
      { pending: [null] },
      { pending: [{ operation: "delete", noteId: NOTE_ID, sequence: 1 }] },
      { pending: [{ operation: "create", noteId: "", sequence: 1 }] },
      { pending: [{ operation: "create", noteId: NOTE_ID, sequence: 0 }] },
      { pending: [{ operation: "create", noteId: NOTE_ID, sequence: 1.5 }] },
      { pending: [{ operation: "create", noteId: `a\u0000${SECRET}`, sequence: 1 }] },
      { pending: new Array(65).fill({ operation: "create", noteId: NOTE_ID, sequence: 1 }) },
    ];
    for (const snapshot of cases) {
      const composition = createNotesnookLocalWriteComposition({
        adapter: stubAdapter({ create: () => goodCreateResult() }),
        coordinator: stubCoordinator({ onSnapshot: () => snapshot }),
      });
      expect(await codeOf(() => composition.pendingSnapshot())).toBe("invalid_input");
    }
  });
});

function goodCreateResultWith(overrides: Record<string, unknown>): unknown {
  return { ...(goodCreateResult() as Record<string, unknown>), ...overrides };
}

function updateResultWith(overrides: Record<string, unknown>): unknown {
  return {
    operation: "update",
    id: NOTE_ID,
    appliedFields: ["title"],
    localCommitted: true,
    remoteSynced: false,
    pendingSync: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 7. Existing adapter errors are preserved categorically.
// ---------------------------------------------------------------------------

describe("Stage 4 write composition — adapter error codes survive without leakage", () => {
  it("preserves stale_revision from the real adapter without mutating the queue", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    expect(
      await codeOf(() =>
        composition.appendNote({
          id: NOTE_ID,
          markdownFragment: "f",
          expectedRevision: revision(NOTE_ID, DATE_EDITED + 1),
        }),
      ),
    ).toBe("stale_revision");
    expect(pendingSnapshotAsPlain(composition.pendingSnapshot())).toEqual({ pending: [] });
  });

  it("preserves invalid_input, unsupported_content, and unsupported_patch_field", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    // Unknown note id -> invalid_input from the adapter's fresh read.
    expect(
      await codeOf(() =>
        composition.appendNote({
          id: OTHER_NOTE_ID,
          markdownFragment: "f",
          expectedRevision: revision(OTHER_NOTE_ID),
        }),
      ),
    ).toBe("invalid_input");

    // Embedded markup is refused by the contract as unsupported content.
    expect(
      await codeOf(() =>
        composition.createNote({ title: "t", content: `<script>${SECRET}</script>` }),
      ),
    ).toBe("unsupported_content");

    // A patch field outside the allowlist is refused categorically.
    expect(
      await codeOf(() =>
        composition.updateNote({
          id: NOTE_ID,
          patch: { deleted: true } as never,
          expectedRevision: revision(),
        }),
      ),
    ).toBe("unsupported_patch_field");

    expect(pendingSnapshotAsPlain(composition.pendingSnapshot())).toEqual({ pending: [] });
  });

  it("preserves conflict and vault_locked from the real adapter", async () => {
    for (const [flag, expected] of [
      ["conflicted", "conflict"],
      ["locked", "vault_locked"],
    ] as const) {
      const base = fakeSeam();
      const flagged: NotesnookWriteDatabase = Object.freeze({
        ...base.database,
        note: async () =>
          Object.freeze({
            id: NOTE_ID,
            title: "fixture",
            pinned: false,
            favorite: false,
            conflicted: flag === "conflicted",
            locked: flag === "locked",
            dateEdited: DATE_EDITED,
          }) as NotesnookWriteNoteMetadata,
      });
      const composition = createNotesnookLocalWriteComposition({
        adapter: createNotesnookWriteAdapter({ source: flagged, codec }),
        coordinator: new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) }),
      });
      expect(
        await codeOf(() =>
          composition.appendNote({
            id: NOTE_ID,
            markdownFragment: "f",
            expectedRevision: revision(),
          }),
        ),
      ).toBe(expected);
    }
  });

  it("rebuilds the relayed error so a mutated adapter message cannot leak", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    // Confirm the underlying adapter error is genuinely adapter-owned...
    let adapterError: unknown;
    try {
      await adapter.appendNote({
        id: NOTE_ID,
        markdownFragment: "f",
        expectedRevision: revision(NOTE_ID, DATE_EDITED + 1),
      });
    } catch (error) {
      adapterError = error;
    }
    expect(isNotesnookWriteAdapterError(adapterError)).toBe(true);

    // ...and that the composition emits its OWN identity, not the adapter's.
    let relayed: unknown;
    try {
      await composition.appendNote({
        id: NOTE_ID,
        markdownFragment: "f",
        expectedRevision: revision(NOTE_ID, DATE_EDITED + 1),
      });
    } catch (error) {
      relayed = error;
    }
    expect(relayed).not.toBe(adapterError);
    expect(isNotesnookWriteCompositionError(relayed)).toBe(true);
    expect(isNotesnookWriteAdapterError(relayed)).toBe(false);
    expect((relayed as NotesnookWriteContractError).code).toBe("stale_revision");
    expect((relayed as Error).name).toBe("NotesnookWriteCompositionError");
    expect((relayed as Error).message).toBe("Notesnook write contract: stale revision");
  });

  it("discards a canary planted on a genuine categorical error's message and cause", async () => {
    const planted = new NotesnookWriteContractError("conflict");
    Object.defineProperty(planted, "message", { configurable: true, value: SECRET });
    Object.defineProperty(planted, "cause", { configurable: true, value: SECRET_CAUSE });
    Object.defineProperty(planted, "stack", { configurable: true, value: SECRET });

    const composition = createNotesnookLocalWriteComposition({
      adapter: {
        createNote: () => {
          throw planted;
        },
        appendNote: () => undefined,
        updateNote: () => undefined,
      } as unknown as NotesnookLocalWriteHandle,
      coordinator: stubCoordinator(),
    });

    let relayed: unknown;
    try {
      await composition.createNote({ title: "t", content: "c" });
    } catch (error) {
      relayed = error;
    }
    expect((relayed as NotesnookWriteContractError).code).toBe("conflict");
    expect((relayed as Error).message).toBe("Notesnook write contract: conflict");
    expect((relayed as Error).message).not.toContain(SECRET);
    expect((relayed as Error).cause).toBeUndefined();
    expect(String((relayed as Error).stack ?? "")).not.toContain(SECRET);
  });

  it("locks categorical codes at runtime for contract and adapter errors", async () => {
    const contractError = new NotesnookWriteContractError("conflict");
    const contractDescriptor = Object.getOwnPropertyDescriptor(contractError, "code");
    expect(contractDescriptor).toMatchObject({
      configurable: false,
      enumerable: true,
      writable: false,
      value: "conflict",
    });
    expect(() => {
      (contractError as unknown as { code: string }).code = "sync_failed";
    }).toThrow(TypeError);
    expect(() =>
      Object.defineProperty(contractError, "code", {
        configurable: true,
        value: "delete_everything",
      }),
    ).toThrow(TypeError);
    expect(contractError.code).toBe("conflict");

    const { adapter } = realAdapter();
    let adapterError: unknown;
    try {
      await adapter.appendNote({
        id: NOTE_ID,
        markdownFragment: "f",
        expectedRevision: revision(NOTE_ID, DATE_EDITED + 1),
      });
    } catch (error) {
      adapterError = error;
    }
    expect(isNotesnookWriteAdapterError(adapterError)).toBe(true);
    const adapterDescriptor = Object.getOwnPropertyDescriptor(adapterError as object, "code");
    expect(adapterDescriptor).toMatchObject({
      configurable: false,
      enumerable: true,
      writable: false,
      value: "stale_revision",
    });
    expect(() => {
      (adapterError as { code: string }).code = "conflict";
    }).toThrow(TypeError);
    expect((adapterError as { code: string }).code).toBe("stale_revision");
  });
});

// ---------------------------------------------------------------------------
// 8. Hardening regressions from independent boundary review.
// ---------------------------------------------------------------------------

describe("Stage 4 write composition — hardened boundary regressions", () => {
  it("captures each injected handle method exactly once", async () => {
    let createReads = 0;
    const create = () => Promise.resolve(goodCreateResult());
    const adapter = {
      get createNote() {
        createReads += 1;
        return create;
      },
      appendNote: () =>
        Promise.resolve({
          operation: "append",
          id: NOTE_ID,
          contentBytes: 1,
          localCommitted: true,
          remoteSynced: false,
          pendingSync: true,
        }),
      updateNote: () =>
        Promise.resolve({
          operation: "update",
          id: NOTE_ID,
          appliedFields: ["title"],
          localCommitted: true,
          remoteSynced: false,
          pendingSync: true,
        }),
    };
    const composition = createNotesnookLocalWriteComposition({
      adapter: adapter as unknown as NotesnookLocalWriteHandle,
      coordinator: stubCoordinator(),
    });

    expect(createReads).toBe(1);
    await composition.createNote({ title: "t", content: "c" });
    expect(createReads).toBe(1);
  });

  it("rejects inherited required result, acknowledgement, and snapshot fields", async () => {
    const inheritedResult = Object.create(goodCreateResult() as object);
    const resultCoordinator = stubCoordinator();
    const resultComposition = createNotesnookLocalWriteComposition({
      adapter: stubAdapter({ create: () => inheritedResult }),
      coordinator: resultCoordinator,
    });
    expect(await codeOf(() => resultComposition.createNote({ title: "t", content: "c" }))).toBe(
      "invalid_input",
    );
    expect(resultCoordinator.receipts).toHaveLength(0);

    const accessorResult = Object.create(null) as Record<string, unknown>;
    const resultData = goodCreateResult() as unknown as Record<string, unknown>;
    for (const key of Object.keys(resultData)) {
      Object.defineProperty(accessorResult, key, {
        configurable: true,
        enumerable: true,
        get: () => resultData[key],
      });
    }
    const accessorComposition = createNotesnookLocalWriteComposition({
      adapter: stubAdapter({ create: () => accessorResult }),
      coordinator: stubCoordinator(),
    });
    await expect(
      accessorComposition.createNote({ title: "t", content: "c" }),
    ).resolves.toMatchObject({
      operation: "create",
      id: NOTE_ID,
    });

    const inheritedAcknowledgement = Object.create({
      operation: "create",
      id: NOTE_ID,
      localCommitted: true,
      remoteSynced: false,
      pendingSync: true,
    });
    const acknowledgementCoordinator = stubCoordinator({
      onRecord: () => inheritedAcknowledgement,
    });
    const acknowledgementComposition = createNotesnookLocalWriteComposition({
      adapter: stubAdapter({ create: () => goodCreateResult() }),
      coordinator: acknowledgementCoordinator,
    });
    expect(
      await codeOf(() => acknowledgementComposition.createNote({ title: "t", content: "c" })),
    ).toBe("sync_failed");

    const inheritedSnapshot = Object.create({
      pending: Object.freeze([]),
    });
    const snapshotComposition = createNotesnookLocalWriteComposition({
      adapter: stubAdapter({ create: () => goodCreateResult() }),
      coordinator: stubCoordinator({ onSnapshot: () => inheritedSnapshot }),
    });
    expect(await codeOf(() => snapshotComposition.pendingSnapshot())).toBe("invalid_input");
  });

  it("rejects every non-canonical note id before queue recording", async () => {
    const ids = [
      " leading",
      "trailing ",
      "in ternal",
      "\u00a0wrapped\u00a0",
      "\u200bwrapped\u200b",
      `${NOTE_ID}\u0000suffix`,
    ];
    for (const id of ids) {
      const coordinator = stubCoordinator();
      const composition = createNotesnookLocalWriteComposition({
        adapter: stubAdapter({ create: () => goodCreateResult({ id }) }),
        coordinator,
      });
      expect(await codeOf(() => composition.createNote({ title: "t", content: "c" }))).toBe(
        "invalid_input",
      );
      expect(coordinator.receipts).toHaveLength(0);
    }
  });

  it("blocks reentrant remote inspection and execution during a local write", async () => {
    let composition!: NotesnookLocalWriteComposition;
    let executorCalls = 0;
    const coordinator = new SyncCoordinator({
      executor: async () => {
        executorCalls += 1;
        return { status: "confirmed" };
      },
    });
    const adapter = stubAdapter({
      create: async () => {
        await expect(codeOf(() => composition.requestSync())).resolves.toBe("invalid_input");
        await expect(codeOf(() => composition.pendingSnapshot())).resolves.toBe("invalid_input");
        return goodCreateResult();
      },
    });
    composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    await composition.createNote({ title: "t", content: "c" });
    expect(executorCalls).toBe(0);
    expect(composition.pendingSnapshot().pending).toHaveLength(1);
  });

  it("keeps the remote boundary blocked across nested local writes", async () => {
    let composition!: NotesnookLocalWriteComposition;
    let executorCalls = 0;
    const coordinator = stubCoordinator({
      onSync: () => {
        executorCalls += 1;
        return {
          status: "synced",
          localCommitted: true,
          remoteSynced: true,
          pendingSync: false,
          attempts: 1,
          startedAt: 1,
        };
      },
    });
    const adapter = stubAdapter({
      create: async () => {
        await composition.appendNote({
          id: NOTE_ID,
          markdownFragment: "nested",
          expectedRevision: revision(),
        });
        await expect(codeOf(() => composition.requestSync())).resolves.toBe("invalid_input");
        return goodCreateResult({ id: OTHER_NOTE_ID });
      },
      append: () => ({
        operation: "append",
        id: NOTE_ID,
        contentBytes: 6,
        localCommitted: true,
        remoteSynced: false,
        pendingSync: true,
      }),
    });
    composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    await composition.createNote({ title: "outer", content: "body" });
    expect(executorCalls).toBe(0);
    expect(coordinator.syncCalls).toHaveLength(0);
    expect(coordinator.receipts).toHaveLength(2);
  });

  it("uses null-prototype frozen containers for every published nested output", async () => {
    const { adapter } = realAdapter();
    const coordinator = new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });
    const result = await composition.updateNote({
      id: NOTE_ID,
      patch: { title: "t", pinned: true },
      expectedRevision: revision(),
    });
    const snapshot = composition.pendingSnapshot();

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.getPrototypeOf(result.appliedFields)).toBeNull();
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.getPrototypeOf(snapshot.pending)).toBeNull();
    expect(Object.getPrototypeOf(snapshot.pending[0]!)).toBeNull();
    expect("constructor" in result).toBe(false);
    expect("constructor" in result.appliedFields).toBe(false);
    expect("constructor" in snapshot.pending[0]!).toBe(false);
  });

  it("rejects a coordinator result whose attempt count exceeds the published bound", async () => {
    const composition = createNotesnookLocalWriteComposition({
      adapter: stubAdapter({ create: () => goodCreateResult() }),
      coordinator: stubCoordinator({
        onSync: () => ({
          status: "synced",
          localCommitted: true,
          remoteSynced: true,
          pendingSync: false,
          attempts: 9,
          startedAt: 1,
        }),
      }),
    });
    expect(await codeOf(() => composition.requestSync())).toBe("sync_failed");
  });
});

// ---------------------------------------------------------------------------
// 9. Exact closed public surface.
// ---------------------------------------------------------------------------

describe("Stage 4 write composition — exact closed surface", () => {
  const EXPECTED_METHODS = [
    "appendNote",
    "createNote",
    "pendingSnapshot",
    "requestSync",
    "updateNote",
  ];

  function build(): NotesnookLocalWriteComposition {
    const { adapter } = realAdapter();
    return createNotesnookLocalWriteComposition({
      adapter,
      coordinator: new SyncCoordinator({ executor: async () => ({ status: "confirmed" }) }),
    });
  }

  it("publishes exactly the five explicit methods and no own data property", () => {
    const composition = build();
    const prototypeMethods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(composition) as object,
    )
      .filter((name) => name !== "constructor")
      .sort();
    expect(prototypeMethods).toEqual(EXPECTED_METHODS);
    // The injected handles are not own properties — they live in a
    // module-private WeakMap and cannot be read off the instance.
    expect(Object.getOwnPropertyNames(composition)).toEqual([]);
    expect(Reflect.ownKeys(composition)).toEqual([]);
  });

  it("freezes the instance, the class, and the prototype", () => {
    const composition = build();
    expect(Object.isFrozen(composition)).toBe(true);
    expect(Object.isFrozen(NotesnookLocalWriteComposition)).toBe(true);
    expect(Object.isFrozen(NotesnookLocalWriteComposition.prototype)).toBe(true);
    expect(() => {
      (composition as unknown as Record<string, unknown>).adapter = {};
    }).toThrow(TypeError);
  });

  it("exposes no forbidden capability on the instance or prototype", () => {
    const composition = build();
    const forbidden = [
      "sync",
      "send",
      "full",
      "fetch",
      "delete",
      "remove",
      "moveToTrash",
      "restore",
      "force",
      "clear",
      "reset",
      "database",
      "db",
      "raw",
      "collection",
      "notes",
      "content",
      "notebooks",
      "tags",
      "relations",
      "invoke",
      "execute",
      "exec",
      "passthrough",
      "transport",
      "network",
      "request",
      "http",
      "credentials",
      "token",
      "password",
      "keystore",
      "vault",
      "vaultUnlock",
      "vaultLock",
      "unlock",
      "login",
      "logout",
      "user",
      "listNotebooks",
      "noteMetadata",
      "search",
      "status",
      "lastSynced",
      "hasUnsyncedChanges",
      "adapter",
      "coordinator",
      "recordLocalCommit",
      "snapshot",
    ];
    for (const name of forbidden) {
      expect(name in composition).toBe(false);
      expect((composition as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
    expect(typeof composition.requestSync).toBe("function");
    expect(typeof composition.pendingSnapshot).toBe("function");
  });

  it("carries no Notesnook, transport, or credential import in the module source", () => {
    // `readFileSync` + `fileURLToPath` matches the existing repository
    // convention for source-hygiene assertions and avoids the `URL`
    // global that ESLint's `no-undef` flags in this config.
    const here = fileURLToPath(import.meta.url);
    const modulePath = joinPath(
      dirnameOf(here),
      "..",
      "src",
      "core",
      "notesnook-write-composition.ts",
    );
    const source = readFileSync(modulePath, "utf8");
    // No dependency of any kind on Notesnook packages, transport, the
    // filesystem, or the native database — checked on import/require
    // syntax so a prose mention in the module docs cannot mask a real one.
    expect(source).not.toMatch(/from\s+"@notesnook\//);
    expect(source).not.toMatch(/import\s*\(\s*"@notesnook\//);
    expect(source).not.toMatch(/require\s*\(/);
    expect(source).not.toMatch(/from\s+"node:(http|https|net|tls|dns|fs|child_process)"/);
    expect(source).not.toMatch(/from\s+"better-sqlite3/);
    // Every import is a local Stage 4 module.
    const importPaths = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(importPaths.sort()).toEqual([
      "./notesnook-database-mutex.js",
      "./notesnook-sync-coordinator.js",
      "./notesnook-write-adapter.js",
      "./notesnook-write-contract.js",
    ]);
  });

  it("keeps snapshots and results free of every canary after a full local cycle", async () => {
    const { adapter } = realAdapter();
    let persistedText = "";
    const coordinator = new SyncCoordinator({
      executor: async () => ({ status: "confirmed" }),
      stateStore: {
        load: () => undefined,
        save: (state: SyncCoordinatorState) => {
          persistedText += JSON.stringify(state);
        },
      },
    });
    const composition = createNotesnookLocalWriteComposition({ adapter, coordinator });

    const created = await composition.createNote({ title: "canary title", content: "canary body" });
    const snapshot = composition.pendingSnapshot();
    const synced = await composition.requestSync();

    for (const value of [created, snapshot, synced]) {
      const text = JSON.stringify(value);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("canary body");
      expect(text).not.toContain("canary title");
    }
    expect(persistedText).not.toContain("canary body");
    expect(persistedText).not.toContain("canary title");
  });
});
