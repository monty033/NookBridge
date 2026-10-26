/**
 * Stage 3 preparation — deterministic tests for the closed read-only seam.
 *
 * These tests never import the live Notesnook runtime and never use account
 * state or network access. They prove the adapter's allowlist before a
 * future live runner is allowed to exercise native sync.
 */

import { TextDecoder } from "node:util";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createNotesnookReadOnlyAdapter,
  isNotesnookReadOnlyAdapterError,
  type NotesnookReadOnlyDatabase,
} from "../src/core/notesnook-readonly-adapter.js";
import {
  flattenLiveDatabaseToReadOnly,
  isNotesnookReadOnlyProjectionError,
} from "../src/core/notesnook-readonly-projection.js";
import {
  formatSyncCommandResult,
  LIVE_SYNC_ENABLE_ENV,
  runSyncCommand,
} from "../src/core/notesnook-sync-admin.js";
import type { NotesnookLiveDatabase } from "../src/core/notesnook-core-adapter.js";
import {
  formatOfflineSyncProofReport,
  runOfflineSyncProof,
} from "../src/core/notesnook-sync-proof.js";
import { isExactFetchRequest } from "../src/core/readonly-sync-shape.js";
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import { createOperatorAuthorizer } from "../src/service/operator-authorizer.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import {
  serializeRpcResponse,
  type RpcNotesGetRequest,
  type RpcRequest,
} from "../src/service/rpc-protocol.js";
import { createRevisionToken } from "../src/core/notesnook-write-contract.js";

function createFakeDatabase(): NotesnookReadOnlyDatabase & {
  syncCalls: Array<{ type: "fetch"; force?: boolean }>;
} {
  const syncCalls: Array<{ type: "fetch"; force?: boolean }> = [];
  return {
    syncCalls,
    lastSynced: async () => 1234,
    hasUnsyncedChanges: async () => false,
    sync: async (options) => {
      syncCalls.push(options);
      return true;
    },
    listNotebooks: async () => [
      {
        id: "notebook-1",
        title: "Work",
        dateCreated: 100,
        ignored: "not exposed",
      } as unknown as { id: string; title: string; dateCreated: number },
    ],
    listNotes: async () =>
      [
        {
          id: "note-1",
          title: "A note",
          dateCreated: 200,
          locked: false,
          body: "not exposed",
          internalSecret: "not exposed",
        },
        {
          id: "locked-note",
          title: "Locked note",
          locked: true,
          body: "not exposed",
          internalSecret: "not exposed",
        },
      ] as unknown as Array<{ id: string; title: string }>,
    noteMetadata: async (id) =>
      ({
        id,
        title: "A note",
        dateCreated: 200,
        ...(id === "conflict-note" ? { conflicted: true } : {}),
        ...(id === "locked-note" ? { locked: true } : {}),
        body: "not exposed",
        internalSecret: "not exposed",
      }) as unknown as { id: string; title: string; dateCreated: number },
    search: async () =>
      [{ id: "note-1", title: "A note", source: "note", body: "not exposed" }] as unknown as Array<{
        id: string;
        title: string;
        source: "note";
      }>,
  };
}

function expectCategoricalFailure(action: () => unknown, message: string): void {
  try {
    action();
    throw new Error("expected action to fail");
  } catch (error) {
    expect(isNotesnookReadOnlyAdapterError(error)).toBe(true);
    expect(error).toMatchObject({ message });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((error as Error & { __context__?: unknown }).__context__).toBeUndefined();
  }
}

describe("NotesnookReadOnlyAdapter", () => {
  it("exposes only the allowlisted read methods and strips extra record fields", async () => {
    const database = createFakeDatabase();
    const adapter = createNotesnookReadOnlyAdapter({ source: database });

    expect(Object.getOwnPropertyNames(adapter)).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(adapter))).toEqual([
      "constructor",
      "status",
      "sync",
      "listNotebooks",
      "listNotes",
      "noteMetadata",
      "readNoteBody",
      "readOperatorNoteContent",
      "search",
    ]);
    expect((adapter as unknown as { database?: unknown }).database).toBeUndefined();
    expect((adapter as unknown as { add?: unknown }).add).toBeUndefined();
    expect((adapter as unknown as { delete?: unknown }).delete).toBeUndefined();

    await expect(adapter.status()).resolves.toEqual({
      lastSynced: 1234,
      hasUnsyncedChanges: false,
    });
    await expect(adapter.listNotebooks()).resolves.toEqual([
      { id: "notebook-1", title: "Work", dateCreated: 100 },
    ]);
    await expect(adapter.listNotes()).resolves.toEqual([
      { id: "note-1", title: "A note", dateCreated: 200, locked: false },
      { id: "locked-note", title: "Locked note", locked: true },
    ]);
    await expect(adapter.noteMetadata("note-1")).resolves.toEqual({
      id: "note-1",
      title: "A note",
      dateCreated: 200,
    });
    await expect(adapter.noteMetadata("conflict-note")).resolves.toMatchObject({
      conflicted: true,
    });
    await expect(adapter.noteMetadata("locked-note")).resolves.toMatchObject({ locked: true });
    await expect(adapter.search("note")).resolves.toEqual([
      { id: "note-1", title: "A note", source: "note" },
    ]);
  });

  it("preserves supplied opaque revisions and rejects malformed revisions", async () => {
    const validSource = createFakeDatabase();
    (validSource as { noteMetadata: NotesnookReadOnlyDatabase["noteMetadata"] }).noteMetadata =
      async (id) =>
        ({
          id,
          title: "A note",
          revision: "rev_00000000000000000000000000000001",
        }) as never;
    const validAdapter = createNotesnookReadOnlyAdapter({ source: validSource });
    await expect(validAdapter.noteMetadata("note-1")).resolves.toMatchObject({
      revision: "rev_00000000000000000000000000000001",
    });

    const displayOnlySource = createFakeDatabase();
    (
      displayOnlySource as { noteMetadata: NotesnookReadOnlyDatabase["noteMetadata"] }
    ).noteMetadata = async (id) => ({ id, title: "A note", dateModified: 220 }) as never;
    const displayOnlyAdapter = createNotesnookReadOnlyAdapter({ source: displayOnlySource });
    await expect(displayOnlyAdapter.noteMetadata("note-1")).resolves.not.toHaveProperty("revision");

    const malformedSource = createFakeDatabase();
    (malformedSource as { noteMetadata: NotesnookReadOnlyDatabase["noteMetadata"] }).noteMetadata =
      async (id) => ({ id, title: "A note", revision: "not-a-revision" }) as never;
    const malformedAdapter = createNotesnookReadOnlyAdapter({ source: malformedSource });
    await expect(malformedAdapter.noteMetadata("note-1")).rejects.toMatchObject({
      message: "Notesnook read-only adapter: note revision token is invalid",
    });
  });

  it("returns stable categorical body-access errors without exposing content", async () => {
    const adapter = createNotesnookReadOnlyAdapter({ source: createFakeDatabase() });

    const locked = await adapter.readNoteBody("locked-note").catch((error: unknown) => error);
    expect(isNotesnookReadOnlyAdapterError(locked)).toBe(true);
    expect(locked).toMatchObject({ message: "vault_locked" });
    expect((locked as Error & { cause?: unknown }).cause).toBeUndefined();

    const unsupported = await adapter.readNoteBody("note-1").catch((error: unknown) => error);
    expect(isNotesnookReadOnlyAdapterError(unsupported)).toBe(true);
    expect(unsupported).toMatchObject({ message: "unsupported_content" });
    expect(String(locked) + String(unsupported)).not.toContain("not exposed");

    const malformedSource = createFakeDatabase();
    (malformedSource as { noteMetadata: NotesnookReadOnlyDatabase["noteMetadata"] }).noteMetadata =
      async (id) => ({ id, title: "private title", locked: "yes", body: "private body" }) as never;
    const malformed = createNotesnookReadOnlyAdapter({ source: malformedSource });
    await expect(malformed.readNoteBody("malformed-note")).rejects.toMatchObject({
      message: "Notesnook read-only adapter: note lock marker is invalid",
    });
  });

  it("reads bounded native content and rejects ciphertext", async () => {
    const source = Object.assign(createFakeDatabase(), {
      readOperatorNoteContent: async (id: string) =>
        id === "note-1"
          ? { type: "html", data: "<p>Hello</p>" }
          : { locked: true, cipher: "secret", iv: "iv", salt: "salt" },
    });
    const adapter = createNotesnookReadOnlyAdapter({ source });
    await expect(adapter.readOperatorNoteContent("note-1")).resolves.toEqual({
      type: "html",
      data: "<p>Hello</p>",
    });
    await expect(adapter.readOperatorNoteContent("locked-note")).rejects.toMatchObject({
      message: "Notesnook read-only adapter: note content is invalid",
    });
  });

  it("allows fetch-only sync and rejects full, send, force, and invalid inputs", async () => {
    const database = createFakeDatabase();
    const adapter = createNotesnookReadOnlyAdapter({ source: database });

    await expect(adapter.sync({ type: "fetch" })).resolves.toBe(true);
    expect(database.syncCalls).toEqual([{ type: "fetch" }]);

    await expect(adapter.sync({ type: "full" as "fetch" })).rejects.toMatchObject({
      message: 'Notesnook read-only adapter: sync type must be "fetch"',
    });
    await expect(adapter.sync({ type: "send" as "fetch" })).rejects.toMatchObject({
      message: 'Notesnook read-only adapter: sync type must be "fetch"',
    });
    await expect(adapter.sync({ type: "fetch", force: true })).rejects.toMatchObject({
      message: "Notesnook read-only adapter: sync force is out of scope",
    });
    await expect(adapter.noteMetadata("")).rejects.toMatchObject({
      message: "Notesnook read-only adapter: note id must be a non-empty string",
    });
    await expect(adapter.search("")).rejects.toMatchObject({
      message: "Notesnook read-only adapter: search query must be a non-empty string",
    });
    expect(database.syncCalls).toEqual([{ type: "fetch" }]);
  });

  it("rejects a fetch request that carries any additional field", async () => {
    // The read-only boundary is structurally exact: `{ type: "fetch" }` and
    // nothing else.  Silently discarding an extra field would let a caller
    // believe it asked for something the adapter never honoured.
    const database = createFakeDatabase();
    const adapter = createNotesnookReadOnlyAdapter({ source: database });

    await expect(
      adapter.sync({ type: "fetch", extra: "ignored" } as unknown as { type: "fetch" }),
    ).rejects.toMatchObject({
      message: 'Notesnook read-only adapter: sync request must carry only "type"',
    });
    expect(database.syncCalls).toEqual([]);
  });

  it("rejects extra fields that are not plain own enumerable properties", async () => {
    // Guard: an own-keys check alone is evadable.  A symbol key, a
    // non-enumerable property, or a property inherited from a prototype all
    // carry a request field the naive check never sees.
    const database = createFakeDatabase();
    const adapter = createNotesnookReadOnlyAdapter({ source: database });
    const rejection = {
      message: 'Notesnook read-only adapter: sync request must carry only "type"',
    };

    const withSymbol = { type: "fetch" as const, [Symbol("extra")]: 1 };
    await expect(adapter.sync(withSymbol)).rejects.toMatchObject(rejection);

    const withHidden = { type: "fetch" as const };
    Object.defineProperty(withHidden, "extra", { value: 1, enumerable: false });
    await expect(adapter.sync(withHidden)).rejects.toMatchObject(rejection);

    const withPrototype = Object.create({ type: "fetch", extra: 1 }) as {
      type: "fetch";
    };
    await expect(adapter.sync(withPrototype)).rejects.toMatchObject(rejection);

    expect(database.syncCalls).toEqual([]);
  });

  describe("shared sync shape rule", () => {
    // The adapter and the projection both expose the read-only sync boundary, so
    // they share one implementation.  The projection cannot be unit-tested in
    // isolation without a live-database fixture, so the rule itself is pinned
    // here and both call sites use it.
    it('accepts exactly { type: "fetch" } and rejects every other shape', () => {
      expect(isExactFetchRequest({ type: "fetch" })).toBe(true);

      expect(isExactFetchRequest({ type: "fetch", extra: 1 })).toBe(false);
      expect(isExactFetchRequest({ type: "fetch", force: true })).toBe(false);
      expect(isExactFetchRequest({ type: "full" })).toBe(false);
      expect(isExactFetchRequest({})).toBe(false);
      expect(isExactFetchRequest(null)).toBe(false);
      expect(isExactFetchRequest("fetch")).toBe(false);

      const withSymbol = { type: "fetch", [Symbol("extra")]: 1 };
      expect(isExactFetchRequest(withSymbol)).toBe(false);

      const withHidden = { type: "fetch" };
      Object.defineProperty(withHidden, "extra", { value: 1, enumerable: false });
      expect(isExactFetchRequest(withHidden)).toBe(false);

      expect(isExactFetchRequest(Object.create({ type: "fetch" }))).toBe(false);
    });
  });

  it("coalesces concurrent sync calls to one upstream attempt", async () => {
    let release!: (value: boolean) => void;
    const database = createFakeDatabase();
    const mutableDatabase = database as unknown as {
      sync: NotesnookReadOnlyDatabase["sync"];
    };
    mutableDatabase.sync = async (options) => {
      database.syncCalls.push(options);
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    };
    const adapter = createNotesnookReadOnlyAdapter({ source: database });

    const first = adapter.sync({ type: "fetch" });
    const second = adapter.sync({ type: "fetch" });
    await Promise.resolve();
    expect(database.syncCalls).toEqual([{ type: "fetch" }]);

    release(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(database.syncCalls).toHaveLength(1);
  });

  it("normalizes upstream failures without leaking the upstream error", async () => {
    const secret = "upstream-secret-note-body";
    const database = createFakeDatabase();
    const mutableDatabase = database as unknown as {
      lastSynced: NotesnookReadOnlyDatabase["lastSynced"];
    };
    mutableDatabase.lastSynced = async () => {
      throw new Error(secret);
    };
    const adapter = createNotesnookReadOnlyAdapter({ source: database });

    await expect(adapter.status()).rejects.toMatchObject({
      message: "Notesnook read-only adapter: lastSynced call rejected upstream",
    });
    await expect(adapter.status()).rejects.not.toThrow(secret);
  });

  it("rejects a source that exposes mutation or generic passthrough methods", () => {
    const database = {
      ...createFakeDatabase(),
      delete: () => undefined,
    };
    expectCategoricalFailure(
      () => createNotesnookReadOnlyAdapter({ source: database }),
      "Notesnook read-only adapter: injected source exposes forbidden mutation delete",
    );
  });

  it("rejects an asynchronous source instead of silently using an unresolved handle", () => {
    expectCategoricalFailure(
      () =>
        createNotesnookReadOnlyAdapter({
          source: async () => createFakeDatabase(),
        } as never),
      "Notesnook read-only adapter: injected source must resolve before construction",
    );
  });
});

describe("R12 — skipped steps are not passes", () => {
  const ASSERTION_STEPS = ["note-metadata", "conflict", "vault-locked", "search"] as const;

  function createNotebookFakeDatabase(count: number) {
    const source = createFakeDatabase();
    const mutable = source as unknown as {
      listNotebooks: NotesnookReadOnlyDatabase["listNotebooks"];
    };
    mutable.listNotebooks = async () =>
      Array.from({ length: count }, (_, index) => ({
        id: `notebook-${index + 1}`,
        title: `Notebook ${index + 1}`,
        dateCreated: index,
      }));
    return source;
  }

  function statusOf(
    report: Awaited<ReturnType<typeof runOfflineSyncProof>>,
    name: (typeof ASSERTION_STEPS)[number] | "sync",
  ) {
    return report.steps.find((step) => step.name === name)?.status;
  }

  it("returns inconclusive for an empty store with no assertions", async () => {
    const source = createNotebookFakeDatabase(0);
    const report = await runOfflineSyncProof({ source });

    expect(report.kind).toBe("inconclusive");
    for (const name of ASSERTION_STEPS) {
      expect(report.steps.find((step) => step.name === name)).toMatchObject({
        name,
        status: "skipped",
      });
    }
    expect(formatOfflineSyncProofReport(report).split("\n")[0]).toBe(
      "read-only sync proof: inconclusive",
    );
    expect(report.message).toBe("read-only sync proof inconclusive: empty store and no assertions");
  });

  it("passes a non-empty store while recording the unrun assertions as skipped", async () => {
    const source = createNotebookFakeDatabase(3);
    const report = await runOfflineSyncProof({ source });

    expect(report.kind).toBe("pass");
    for (const name of ASSERTION_STEPS) {
      expect(report.steps.find((step) => step.name === name)).toMatchObject({
        name,
        status: "skipped",
      });
    }
  });

  it("passes an empty store when the search assertion actually ran", async () => {
    const source = createNotebookFakeDatabase(0);
    const report = await runOfflineSyncProof({ source, query: "note" });

    expect(statusOf(report, "search")).toBe("pass");
    expect(report.kind).toBe("pass");
  });

  it("passes status mode on an empty store with sync skipped", async () => {
    const source = createNotebookFakeDatabase(0);
    const report = await runOfflineSyncProof({ source, performSync: false });

    expect(report.kind).toBe("pass");
    expect(statusOf(report, "sync")).toBe("skipped");
  });

  it("always issues exactly the fetch-only sync request", async () => {
    const source = createNotebookFakeDatabase(0);
    await runOfflineSyncProof({ source });

    expect(source.syncCalls).toEqual([{ type: "fetch" }]);
  });

  it("still fails when the status read fails", async () => {
    const source = createFakeDatabase();
    (source as unknown as { lastSynced: NotesnookReadOnlyDatabase["lastSynced"] }).lastSynced =
      async () => {
        throw new Error("status read failed");
      };
    const report = await runOfflineSyncProof({ source });

    expect(report.kind).toBe("fail");
    expect(report.steps[report.steps.length - 1]).toMatchObject({
      name: "close",
      status: "fail",
    });
  });
});

function createFakeLiveDatabase(
  options: {
    noteSearchIds?: string[];
    noteListIds?: string[];
    notebookSearchIds?: string[];
    extraNotes?: Array<Readonly<Record<string, unknown>> & { id: string; title: string }>;
    conflictMarker?: "present" | "absent";
    breadcrumbs?: (id: string) => Promise<Array<{ id: string; title: string }>>;
    breadcrumbsThrows?: boolean;
    contentRecord?: Readonly<Record<string, unknown>>;
    omitNotebookReference?: boolean;
  } = {},
): NotesnookLiveDatabase & {
  syncCalls: Array<{ type: "fetch"; force?: boolean }>;
} {
  const syncCalls: Array<{ type: "fetch"; force?: boolean }> = [];
  const notebooks = new Map([
    ["nb-1", { id: "nb-1", title: "Work", dateEdited: 11, body: "hidden" }],
  ]);
  const notes = new Map([
    [
      "note-1",
      {
        id: "note-1",
        title: "A note",
        dateEdited: 22,
        ...(options.omitNotebookReference ? {} : { notebooks: [{ id: "nb-1" }] }),
        body: "secret body",
      },
    ],
    ...(options.extraNotes ?? []).map((note) => [note.id, note] as const),
    [
      "conflict-note",
      {
        id: "conflict-note",
        title: "Conflict title must stay internal",
        dateEdited: 23,
        ...(options.conflictMarker === "absent" ? {} : { conflicted: true }),
        body: "conflict body must stay internal",
        upstreamRevision: "upstream revision must stay internal",
      },
    ],
    [
      "locked-note",
      {
        id: "locked-note",
        title: "Locked title must stay internal",
        dateEdited: 24,
        conflicted: false,
        body: "locked note body must stay internal",
      },
    ],
  ]);
  const contents = new Map([
    [
      "note-1",
      options.contentRecord ?? { locked: false, data: "ordinary body must stay internal" },
    ],
    ["conflict-note", { locked: false, data: "conflict body must stay internal" }],
    ["locked-note", { locked: true, data: "locked note body must stay internal" }],
  ]);
  const searchResults = (ids: string[]) => ({ ids: async () => ids });
  const database = {
    syncCalls,
    setup: vi.fn(),
    host: vi.fn(),
    init: vi.fn(async () => undefined),
    user: {},
    tokenManager: {},
    kv: vi.fn(() => ({})),
    syncer: {
      start: vi.fn(async (options: { type: "fetch"; force?: boolean }) => {
        syncCalls.push(options);
        return true;
      }),
    },
    notebooks: {
      all: { ids: async () => ["nb-1"] },
      notebook: async (id: string) => notebooks.get(id),
      notes: async (id: string) => (id === "nb-1" ? ["note-1"] : []),
      ...(options.breadcrumbsThrows
        ? {
            breadcrumbs: async () => {
              throw new Error("breadcrumbs unavailable");
            },
          }
        : options.breadcrumbs !== undefined
          ? { breadcrumbs: options.breadcrumbs }
          : {}),
    },
    notes: {
      all: { ids: async () => options.noteListIds ?? ["note-1"] },
      note: async (id: string) => notes.get(id),
    },
    content: { findByNoteId: async (id: string) => contents.get(id) },
    relations: {
      from: vi.fn((reference: { id: string; type: string }, type: string) => ({
        marker: "relation-array",
        has(this: { marker: string }, id: string) {
          if (this.marker !== "relation-array") throw new Error("relations.has lost binding");
          return Promise.resolve(
            reference.id === "nb-1" &&
              reference.type === "notebook" &&
              type === "note" &&
              id === "note-1",
          );
        },
      })),
    },
    lookup: {
      notes: async () => searchResults(options.noteSearchIds ?? ["note-1"]),
      notebooks: async () => searchResults(options.notebookSearchIds ?? ["nb-1"]),
    },
    lastSynced: async () => 99,
    hasUnsyncedChanges: async () => false,
  };
  return database as unknown as NotesnookLiveDatabase & {
    syncCalls: Array<{ type: "fetch"; force?: boolean }>;
  };
}

describe("Stage 3 production projection and sync gate", () => {
  it("derives notebook membership when a live note omits deprecated notebook references", async () => {
    const source = flattenLiveDatabaseToReadOnly(
      createFakeLiveDatabase({ omitNotebookReference: true }),
    );

    await expect(source.noteMetadata("note-1")).resolves.toMatchObject({
      id: "note-1",
      title: "A note",
      notebookId: "nb-1",
      revision: createRevisionToken({ id: "note-1", dateEdited: 22 }),
    });
  });

  it("derives notebook membership from relations when notebooks.notes is unavailable", async () => {
    const database = createFakeLiveDatabase({ omitNotebookReference: true });
    delete (database.notebooks as { notes?: unknown }).notes;
    const source = flattenLiveDatabaseToReadOnly(database);

    await expect(source.noteMetadata("note-1")).resolves.toMatchObject({
      id: "note-1",
      notebookId: "nb-1",
    });
  });

  it("feeds relation-derived notebook membership into operator edit policy", async () => {
    const database = createFakeLiveDatabase({ omitNotebookReference: true });
    const readOnly = flattenLiveDatabaseToReadOnly(database);
    const seenPolicies: string[] = [];
    const request: RpcRequest = {
      id: "edit",
      method: "notes.apply-edit",
      params: { id: "h_target", expectedRevision: "rev", markdown: "<p>changed</p>" },
    };
    const peer = { uid: 1, gid: 2, groups: ["nookbridge-operators"] };
    const makeAuthorizer = (allow: boolean) =>
      createOperatorAuthorizer({
        resolveHandle: (handle) => (handle === "h_target" ? "note-1" : undefined),
        readNoteLockState: async () => "unlocked",
        readNoteNotebookPath: async (noteId) => {
          const metadata = await readOnly.noteMetadata(noteId);
          return metadata?.notebookId === "nb-1" ? "Work" : undefined;
        },
        evaluateNotebookPolicy: (operation, notebookPath) => {
          seenPolicies.push(`${operation}:${notebookPath}`);
          return allow;
        },
      });

    await expect(makeAuthorizer(true)("notes.apply-edit", peer, request)).resolves.toEqual({
      allowed: true,
      method: "notes.apply-edit",
    });
    await expect(makeAuthorizer(false)("notes.apply-edit", peer, request)).resolves.toEqual({
      allowed: false,
      reason: "permission_denied",
    });
    expect(seenPolicies).toEqual(["edit:Work", "edit:Work"]);
  });

  it("prefers relation membership when notebooks.notes rejects", async () => {
    const database = createFakeLiveDatabase({ omitNotebookReference: true });
    (
      database as unknown as {
        notebooks: { notes: (id: string) => Promise<never> };
      }
    ).notebooks.notes = async () => {
      throw new Error("notebooks.notes unavailable");
    };
    const source = flattenLiveDatabaseToReadOnly(database);

    await expect(source.noteMetadata("note-1")).resolves.toMatchObject({
      id: "note-1",
      notebookId: "nb-1",
    });
  });

  it("does not enumerate notebooks when both membership sources are unavailable", async () => {
    const database = createFakeLiveDatabase({ omitNotebookReference: true });
    delete (database.notebooks as { notes?: unknown }).notes;
    delete (database as { relations?: unknown }).relations;
    const notebooks = (database as unknown as { notebooks: { all: { ids: unknown } } }).notebooks;
    (notebooks.all as { ids: () => Promise<never> }).ids = async () => {
      throw new Error("notebooks enumeration unavailable");
    };
    const source = flattenLiveDatabaseToReadOnly(database);

    await expect(source.noteMetadata("note-1")).resolves.toMatchObject({
      id: "note-1",
    });
    await expect(source.noteMetadata("note-1")).resolves.not.toHaveProperty("notebookId");
  });

  it("normalizes notebook id resolution failures from throwing then getters", async () => {
    const database = createFakeLiveDatabase({ omitNotebookReference: true });
    const notebooks = (database as unknown as { notebooks: { all: { ids: unknown } } }).notebooks;
    (notebooks.all as { ids: () => object }).ids = () =>
      Object.defineProperty({}, "then", {
        get: () => {
          throw new Error("private notebook ids then getter failure");
        },
      });
    const source = flattenLiveDatabaseToReadOnly(database);

    const failure = await source.noteMetadata("note-1").catch((error: unknown) => error);
    expect(isNotesnookReadOnlyProjectionError(failure)).toBe(true);
    expect(String(failure)).not.toContain("private notebook ids then getter failure");
  });

  describe("notebook absence confirmation (reserved <root> context)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rootDb = (mutate?: (db: any) => void) => {
      const db = createFakeLiveDatabase({
        noteSearchIds: ["conflict-note"],
        notebookSearchIds: [],
      });
      mutate?.(db);
      return flattenLiveDatabaseToReadOnly(db as NotesnookLiveDatabase);
    };

    it("confirms absence when every probe positively says no", async () => {
      await expect(rootDb().noteMetadata("conflict-note")).resolves.toMatchObject({
        notebookAbsenceConfirmed: true,
      });
    });

    it("never marks a note that belongs to a notebook", async () => {
      const meta = await rootDb().noteMetadata("note-1");
      expect(meta).toMatchObject({ notebookId: "nb-1" });
      expect(meta).not.toHaveProperty("notebookAbsenceConfirmed");
    });

    it("does not confirm when relations are unavailable", async () => {
      const meta = await rootDb((db) => delete db.relations).noteMetadata("conflict-note");
      expect(meta).not.toHaveProperty("notebookAbsenceConfirmed");
    });

    it("does not confirm when the notebook list may be truncated at the cap", async () => {
      const ids = Array.from({ length: 256 }, (_, i) => `nb-cap-${i}`);
      const meta = await rootDb((db) => {
        db.notebooks.all = { ids: async () => ids };
        db.relations.from = () => ({ has: async () => false });
        db.notebooks.notes = async () => [];
      }).noteMetadata("conflict-note");
      expect(meta).not.toHaveProperty("notebookAbsenceConfirmed");
    });

    it("propagates a failing relations probe instead of confirming", async () => {
      await expect(
        rootDb((db) => {
          db.relations.from = () => ({
            has: async () => {
              throw new Error("probe failed");
            },
          });
        }).noteMetadata("conflict-note"),
      ).rejects.toThrow();
    });

    it("propagates a failing notebooks.notes probe instead of confirming", async () => {
      await expect(
        rootDb((db) => {
          db.notebooks.notes = async () => {
            throw new Error("notes probe failed");
          };
        }).noteMetadata("conflict-note"),
      ).rejects.toThrow();
    });

    describe("notebook id enumeration is strict for root confirmation", () => {
      it("still confirms root for a genuinely empty, valid notebook list", async () => {
        const meta = await rootDb((db) => {
          db.notebooks.all = { ids: async () => [] };
        }).noteMetadata("conflict-note");
        expect(meta).toMatchObject({ notebookAbsenceConfirmed: true });
      });

      it.each<[string, unknown]>([
        ["resolves to undefined", { ids: async () => undefined }],
        ["resolves to null", { ids: async () => null }],
        ["returns null synchronously", { ids: () => null }],
        ["is missing", {}],
        ["resolves to a non-array", { ids: async () => "nb-1" }],
        ["contains an empty string", { ids: async () => ["nb-1", ""] }],
        ["contains a non-string", { ids: async () => ["nb-1", 3] }],
        ["contains a duplicate", { ids: async () => ["nb-1", "nb-1"] }],
        [
          "rejects",
          {
            ids: async () => {
              throw new Error("ids secret");
            },
          },
        ],
      ])("never confirms root (and fails categorically) when ids %s", async (_label, all) => {
        // Only the root-confirming path (no notebook claim) is reachable here.
        const failure = await rootDb((db) => {
          db.notebooks.all = all;
        })
          .noteMetadata("conflict-note")
          .then(
            (meta) => meta,
            (error: unknown) => error,
          );
        expect(failure).not.toHaveProperty("notebookAbsenceConfirmed");
        expect(isNotesnookReadOnlyProjectionError(failure)).toBe(true);
        expect(String(failure)).not.toMatch(/secret|nb-1/);
      });

      it("does not confirm root when ids become unavailable after a valid hierarchy snapshot", async () => {
        const db = createFakeLiveDatabase({
          noteSearchIds: ["conflict-note"],
          notebookSearchIds: [],
          breadcrumbs: async (id: string) => [{ id, title: "Work" }],
        });
        const readOnly = flattenLiveDatabaseToReadOnly(db as NotesnookLiveDatabase);
        await expect(readOnly.listNotebooksWithParentsStrict!()).resolves.toHaveLength(1);
        await expect(readOnly.noteMetadata("conflict-note")).resolves.toMatchObject({
          notebookAbsenceConfirmed: true,
        });
        // The notebook index becomes unavailable AFTER the valid snapshot.
        // Synchronous null is the shape the tolerant reader mapped to "empty vault".
        (db.notebooks as unknown as { all: { ids: () => unknown } }).all.ids = () => null;
        const afterwards = await readOnly.noteMetadata("conflict-note").then(
          (meta) => meta,
          (error: unknown) => error,
        );
        expect(afterwards).not.toHaveProperty("notebookAbsenceConfirmed");
        expect(isNotesnookReadOnlyProjectionError(afterwards)).toBe(true);
      });
    });

    it("does not confirm when no membership source exists", async () => {
      const meta = await rootDb((db) => {
        delete db.relations;
        delete db.notebooks.notes;
      }).noteMetadata("conflict-note");
      expect(meta).not.toHaveProperty("notebookAbsenceConfirmed");
    });
  });

  it("classifies stored HTML versus literal Markdown without returning content", async () => {
    const htmlSource = flattenLiveDatabaseToReadOnly(
      createFakeLiveDatabase({
        contentRecord: {
          type: "tiptap",
          data: '<div data-type="document"><h2>Title</h2><ul class="simple-checklist"><li class="simple-checklist--item"><p>task</p></li></ul></div>',
        },
      }),
    );
    await expect(htmlSource.noteContentDiagnostic?.("note-1")).resolves.toEqual({
      contentType: "tiptap",
      htmlPrefix: "present",
      simpleChecklist: "present",
      taskList: "absent",
      literalMarkdown: "absent",
    });

    const taskListSource = flattenLiveDatabaseToReadOnly(
      createFakeLiveDatabase({
        contentRecord: {
          type: "tiptap",
          data: '<div data-type="document"><ul class="checklist"><li class="checklist--item"><p>task</p></li></ul></div>',
        },
      }),
    );
    await expect(taskListSource.noteContentDiagnostic?.("note-1")).resolves.toEqual({
      contentType: "tiptap",
      htmlPrefix: "present",
      simpleChecklist: "absent",
      taskList: "present",
      literalMarkdown: "absent",
    });

    const markdownSource = flattenLiveDatabaseToReadOnly(
      createFakeLiveDatabase({
        contentRecord: {
          type: "tiptap",
          data: "## Title\\n- [ ] task",
        },
      }),
    );
    await expect(markdownSource.noteContentDiagnostic?.("note-1")).resolves.toEqual({
      contentType: "tiptap",
      htmlPrefix: "absent",
      simpleChecklist: "absent",
      taskList: "absent",
      literalMarkdown: "present",
    });
  });

  it("distinguishes a detecting device's local conflict marker from a fresh fetch-only projection", async () => {
    const privateTitle = "Conflict title must stay internal";
    const detectingDatabase = createFakeLiveDatabase({
      noteSearchIds: ["conflict-note"],
      notebookSearchIds: [],
      conflictMarker: "present",
    });
    const freshDatabase = createFakeLiveDatabase({
      noteSearchIds: ["conflict-note"],
      notebookSearchIds: [],
      conflictMarker: "absent",
    });
    const detectingSource = flattenLiveDatabaseToReadOnly(detectingDatabase);
    const freshSource = flattenLiveDatabaseToReadOnly(freshDatabase);

    await expect(detectingSource.noteMetadata("conflict-note")).resolves.toMatchObject({
      conflicted: true,
    });
    await expect(freshSource.noteMetadata("conflict-note")).resolves.toEqual({
      id: "conflict-note",
      title: privateTitle,
      dateModified: 23,
      revision: createRevisionToken({ id: "conflict-note", dateEdited: 23 }),
      // The fake note is in no notebook and every probe said so.
      notebookAbsenceConfirmed: true,
    });

    const detectingCleanup = vi.fn(async () => undefined);
    const detectingResult = await runSyncCommand({
      argv: ["read-only", "--expect-conflict-title", privateTitle],
      env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
      createProofRuntime: async () => ({ source: detectingSource, cleanup: detectingCleanup }),
    });
    const freshCleanup = vi.fn(async () => undefined);
    const freshResult = await runSyncCommand({
      argv: ["read-only", "--expect-conflict-title", privateTitle],
      env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
      createProofRuntime: async () => ({ source: freshSource, cleanup: freshCleanup }),
    });

    expect(detectingResult).toMatchObject({
      kind: "report",
      report: {
        kind: "pass",
        steps: expect.arrayContaining([
          { name: "conflict", status: "pass", detail: "conflict marker observed" },
        ]),
      },
    });
    expect(freshResult).toMatchObject({
      kind: "report",
      report: {
        kind: "fail",
        steps: expect.arrayContaining([
          { name: "conflict", status: "fail", detail: "conflict failed: categorical error" },
        ]),
      },
    });
    expect(detectingDatabase.syncCalls).toEqual([{ type: "fetch" }]);
    expect(freshDatabase.syncCalls).toEqual([{ type: "fetch" }]);
    expect(detectingCleanup).toHaveBeenCalledOnce();
    expect(freshCleanup).toHaveBeenCalledOnce();

    const categoricalOutput =
      formatSyncCommandResult(detectingResult) + formatSyncCommandResult(freshResult);
    for (const forbidden of [
      privateTitle,
      "conflict-note",
      "conflict body must stay internal",
      "upstream revision must stay internal",
    ]) {
      expect(categoricalOutput).not.toContain(forbidden);
    }
  });

  it("proves title-based conflict and vault_locked canaries through the full CLI path", async () => {
    const conflictTitle = "Conflict title must stay internal";
    const lockedTitle = "Locked title must stay internal";
    const database = createFakeLiveDatabase({
      noteSearchIds: ["conflict-note", "locked-note"],
      notebookSearchIds: [],
    });
    const source = flattenLiveDatabaseToReadOnly(database);
    const cleanup = vi.fn(async () => undefined);
    const result = await runSyncCommand({
      argv: [
        "read-only",
        "--expect-conflict-title",
        conflictTitle,
        `--expect-vault-locked-title=${lockedTitle}`,
      ],
      env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
      createProofRuntime: async () => ({ source, cleanup }),
    });

    expect(result).toMatchObject({
      kind: "report",
      report: {
        kind: "pass",
        steps: expect.arrayContaining([
          { name: "conflict", status: "pass", detail: "conflict marker observed" },
          {
            name: "vault-locked",
            status: "pass",
            detail: "vault_locked body refusal observed",
          },
          { name: "search", status: "skipped", detail: "no query supplied" },
        ]),
      },
    });
    expect(database.syncCalls).toEqual([{ type: "fetch" }]);
    expect(cleanup).toHaveBeenCalledOnce();
    const formatted = formatSyncCommandResult(result);
    for (const forbidden of [
      conflictTitle,
      lockedTitle,
      "conflict-note",
      "locked-note",
      "conflict body",
      "locked note body",
    ]) {
      expect(formatted).not.toContain(forbidden);
    }
  });

  it.each([
    {
      name: "missing",
      title: "Missing private title",
      database: createFakeLiveDatabase({ noteSearchIds: ["note-1"], notebookSearchIds: [] }),
    },
    {
      name: "ambiguous",
      title: "Duplicate private title",
      database: createFakeLiveDatabase({
        noteSearchIds: ["duplicate-1", "duplicate-2"],
        notebookSearchIds: [],
        extraNotes: [
          { id: "duplicate-1", title: "Duplicate private title", conflicted: true },
          { id: "duplicate-2", title: "Duplicate private title", conflicted: true },
        ],
      }),
    },
    {
      name: "notebook-only",
      title: "Work",
      database: createFakeLiveDatabase({ noteSearchIds: [], notebookSearchIds: ["nb-1"] }),
    },
  ])("fails categorically for a $name title resolution", async ({ title, database }) => {
    const cleanup = vi.fn(async () => undefined);
    const result = await runSyncCommand({
      argv: ["read-only", "--expect-conflict-title", title],
      env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
      createProofRuntime: async () => ({
        source: flattenLiveDatabaseToReadOnly(database),
        cleanup,
      }),
    });

    expect(result).toMatchObject({
      kind: "report",
      report: {
        kind: "fail",
        steps: expect.arrayContaining([
          { name: "conflict", status: "fail", detail: "conflict failed: categorical error" },
        ]),
      },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    const formatted = formatSyncCommandResult(result);
    expect(formatted).not.toContain(title);
    expect(formatted).not.toContain("duplicate-1");
    expect(formatted).not.toContain("duplicate-2");
  });

  it("rejects empty, duplicate, and malformed title flags before runtime construction", async () => {
    const createProofRuntime = vi.fn();
    for (const argv of [
      ["read-only", "--expect-conflict-title"],
      ["read-only", "--expect-conflict-title="],
      ["read-only", "--expect-conflict-title=   "],
      ["read-only", "--expect-conflict-title", "--expect-vault-locked-title=x"],
      ["read-only", "--expect-vault-locked-title", ""],
      ["read-only", "--expect-conflict-title", "first", "--expect-conflict-title=second"],
      ["read-only", "--expect-vault-locked-title=first", "--expect-vault-locked-title", "second"],
      ["read-only", "--expect-conflict-title-malformed=value"],
    ]) {
      await expect(
        runSyncCommand({
          argv,
          env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
          createProofRuntime,
        }),
      ).resolves.toEqual({
        kind: "error",
        exitCode: 2,
        message: "nookctl sync: invalid command input",
      });
    }
    expect(createProofRuntime).not.toHaveBeenCalled();
  });

  it("redacts title-resolution upstream failures and still cleans up", async () => {
    const title = "Private locked title canary";
    const upstreamText = "upstream search failure with private corpus text";
    const database = createFakeLiveDatabase();
    (database.lookup as { notes: () => Promise<never> }).notes = async () => {
      throw new Error(upstreamText);
    };
    const cleanup = vi.fn(async () => undefined);
    const result = await runSyncCommand({
      argv: ["read-only", "--expect-vault-locked-title", title],
      env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
      createProofRuntime: async () => ({
        source: flattenLiveDatabaseToReadOnly(database),
        cleanup,
      }),
    });

    expect(result).toMatchObject({
      kind: "report",
      report: {
        kind: "fail",
        steps: expect.arrayContaining([
          {
            name: "vault-locked",
            status: "fail",
            detail: "vault-locked failed: read-only adapter rejected the request",
          },
        ]),
      },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    const formatted = formatSyncCommandResult(result);
    expect(formatted).not.toContain(title);
    expect(formatted).not.toContain(upstreamText);
  });

  it("proves conflict visibility and vault_locked refusal through the CLI path", async () => {
    const source = flattenLiveDatabaseToReadOnly(createFakeLiveDatabase());
    const cleanup = vi.fn(async () => undefined);
    const result = await runSyncCommand({
      argv: [
        "read-only",
        "--expect-conflict-id",
        "conflict-note",
        "--expect-vault-locked-id=locked-note",
      ],
      env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
      createProofRuntime: async () => ({ source, cleanup }),
    });

    expect(result).toMatchObject({
      kind: "report",
      report: {
        kind: "pass",
        steps: expect.arrayContaining([
          { name: "conflict", status: "pass", detail: "conflict marker observed" },
          {
            name: "vault-locked",
            status: "pass",
            detail: "vault_locked body refusal observed",
          },
        ]),
      },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    const formatted = formatSyncCommandResult(result);
    for (const forbidden of [
      "conflict-note",
      "locked-note",
      "Conflict title",
      "Locked title",
      "conflict body",
      "locked note body",
    ]) {
      expect(formatted).not.toContain(forbidden);
    }
  });

  it("fails categorically and cleans up when a conflict marker is absent", async () => {
    const source = flattenLiveDatabaseToReadOnly(createFakeLiveDatabase());
    const cleanup = vi.fn(async () => undefined);
    const result = await runSyncCommand({
      argv: ["read-only", "--expect-conflict-id", "note-1"],
      env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
      createProofRuntime: async () => ({ source, cleanup }),
    });

    expect(result).toMatchObject({
      kind: "report",
      report: {
        kind: "fail",
        steps: expect.arrayContaining([
          { name: "conflict", status: "fail", detail: "conflict failed: categorical error" },
        ]),
      },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(formatSyncCommandResult(result)).not.toContain("note-1");
  });

  it("fails categorically and cleans up when Vault locking is unsupported for a note", async () => {
    const source = flattenLiveDatabaseToReadOnly(createFakeLiveDatabase());
    const cleanup = vi.fn(async () => undefined);
    const result = await runSyncCommand({
      argv: ["read-only", "--expect-vault-locked-id", "note-1"],
      env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
      createProofRuntime: async () => ({ source, cleanup }),
    });

    expect(result).toMatchObject({
      kind: "report",
      report: {
        kind: "fail",
        steps: expect.arrayContaining([
          {
            name: "vault-locked",
            status: "fail",
            detail: "vault-locked failed: categorical error",
          },
        ]),
      },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(formatSyncCommandResult(result)).not.toContain("note-1");
  });

  it("treats an upstream vault_locked content refusal as a locked metadata marker", async () => {
    const database = createFakeLiveDatabase();
    (
      database as unknown as {
        content: { findByNoteId: (id: string) => Promise<unknown> };
      }
    ).content.findByNoteId = async () => {
      const error = new Error("upstream detail must stay internal");
      Object.defineProperty(error, "code", { value: "ERR_VAULT_LOCKED" });
      throw error;
    };

    const projection = flattenLiveDatabaseToReadOnly(database);
    await expect(projection.noteMetadata("locked-note")).resolves.toMatchObject({
      id: "locked-note",
      locked: true,
    });
  });

  it("treats the pinned upstream vault-locked message as a locked marker", async () => {
    const database = createFakeLiveDatabase();
    (
      database as unknown as {
        content: { findByNoteId: (id: string) => Promise<unknown> };
      }
    ).content.findByNoteId = async () => {
      throw new Error("ERR_VAULT_LOCKED");
    };

    const projection = flattenLiveDatabaseToReadOnly(database);
    await expect(projection.noteMetadata("locked-note")).resolves.toMatchObject({
      id: "locked-note",
      locked: true,
    });
  });

  it("treats the pinned cipher-shaped content as locked without exposing it", async () => {
    const database = createFakeLiveDatabase();
    (
      database as unknown as {
        content: { findByNoteId: (id: string) => Promise<unknown> };
      }
    ).content.findByNoteId = async () => ({
      data: { cipher: "hidden", iv: "hidden", salt: "hidden" },
    });

    const projection = flattenLiveDatabaseToReadOnly(database);
    await expect(projection.noteMetadata("locked-note")).resolves.toMatchObject({
      id: "locked-note",
      locked: true,
    });
  });

  it("does not trust an unverified vault_locked error code", async () => {
    const database = createFakeLiveDatabase();
    (
      database as unknown as {
        content: { findByNoteId: (id: string) => Promise<unknown> };
      }
    ).content.findByNoteId = async () => {
      const error = new Error("untrusted upstream detail");
      Object.defineProperty(error, "code", { value: "vault_locked" });
      throw error;
    };

    const projection = flattenLiveDatabaseToReadOnly(database);
    await expect(projection.noteMetadata("locked-note")).rejects.toMatchObject({
      message: "Notesnook read-only projection: content.findByNoteId rejected",
    });
  });

  it("treats a trusted read-only vault_locked refusal as a locked metadata marker", async () => {
    const adapter = createNotesnookReadOnlyAdapter({ source: createFakeDatabase() });
    const lockedError = await adapter.readNoteBody("locked-note").catch((error) => error);
    expect(isNotesnookReadOnlyAdapterError(lockedError)).toBe(true);

    const database = createFakeLiveDatabase();
    (
      database as unknown as {
        content: { findByNoteId: (id: string) => Promise<unknown> };
      }
    ).content.findByNoteId = async () => {
      throw lockedError;
    };

    const projection = flattenLiveDatabaseToReadOnly(database);
    await expect(projection.noteMetadata("locked-note")).resolves.toMatchObject({
      id: "locked-note",
      locked: true,
    });
  });

  it("rejects malformed conflict and lock markers categorically", async () => {
    const conflictDatabase = createFakeLiveDatabase();
    (conflictDatabase.notes as { note: (id: string) => Promise<unknown> }).note = async (id) => ({
      id,
      title: "private title",
      conflicted: "yes",
      body: "private body",
    });
    const conflictProjection = flattenLiveDatabaseToReadOnly(conflictDatabase);
    await expect(conflictProjection.noteMetadata("malformed-conflict")).rejects.toSatisfy(
      isNotesnookReadOnlyProjectionError,
    );

    const lockedDatabase = createFakeLiveDatabase();
    (
      lockedDatabase as unknown as {
        content: { findByNoteId: (id: string) => Promise<unknown> };
      }
    ).content.findByNoteId = async () => ({ locked: "yes", data: "private body" });
    const lockedProjection = flattenLiveDatabaseToReadOnly(lockedDatabase);
    const failure = await lockedProjection
      .noteMetadata("locked-note")
      .catch((error: unknown) => error);
    expect(isNotesnookReadOnlyProjectionError(failure)).toBe(true);
    expect(String(failure)).not.toContain("private body");
  });

  it("rejects malformed conflict and Vault flags before runtime construction", async () => {
    const createProofRuntime = vi.fn();
    for (const argv of [
      ["read-only", "--expect-conflict-id"],
      ["read-only", "--expect-vault-locked-id="],
    ]) {
      await expect(
        runSyncCommand({
          argv,
          env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
          createProofRuntime,
        }),
      ).resolves.toMatchObject({ kind: "error", exitCode: 2 });
    }
    expect(createProofRuntime).not.toHaveBeenCalled();
  });

  it("fails categorically and cleans up when the expected search result is absent", async () => {
    const source = createFakeDatabase();
    const cleanup = vi.fn(async () => undefined);
    const query = "private-query-canary";
    const expectedId = "private-expected-note-id";
    const result = await runSyncCommand({
      argv: ["read-only", "--query", query, "--expect-search-id", expectedId],
      env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
      createProofRuntime: async () => ({ source, cleanup }),
    });

    expect(result).toMatchObject({
      kind: "report",
      report: {
        kind: "fail",
        steps: expect.arrayContaining([
          { name: "search", status: "fail", detail: "search failed: categorical error" },
        ]),
      },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    const formatted = formatSyncCommandResult(result);
    expect(formatted).not.toContain(query);
    expect(formatted).not.toContain(expectedId);
    expect(formatted).not.toContain("A note");
    expect(formatted).not.toContain("not exposed");
  });

  it("passes categorically when the expected search result is present", async () => {
    const source = createFakeDatabase();
    const cleanup = vi.fn(async () => undefined);
    const result = await runSyncCommand({
      argv: ["read-only", "--query=title-canary", "--expect-search-id=note-1"],
      env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
      createProofRuntime: async () => ({ source, cleanup }),
    });

    expect(result).toMatchObject({
      kind: "report",
      report: {
        kind: "pass",
        steps: expect.arrayContaining([
          { name: "search", status: "pass", detail: "expected search hit observed" },
        ]),
      },
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(formatSyncCommandResult(result)).not.toContain("note-1");
  });

  it("rejects an expected search result without a query before runtime construction", async () => {
    const createProofRuntime = vi.fn();
    await expect(
      runSyncCommand({
        argv: ["read-only", "--expect-search-id", "note-1"],
        env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
        createProofRuntime,
      }),
    ).resolves.toEqual({
      kind: "error",
      exitCode: 2,
      message: "nookctl sync: invalid command input",
    });
    expect(createProofRuntime).not.toHaveBeenCalled();
  });

  it("flattens pinned-core-shaped APIs without exposing raw managers or bodies", async () => {
    const database = createFakeLiveDatabase({ noteListIds: ["note-1", "locked-note"] });
    const readOnly = flattenLiveDatabaseToReadOnly(database);

    expect(Object.keys(readOnly).sort()).toEqual([
      "findNoteIdsByNotebook",
      "findNotesByTitle",
      "hasNoteInNotebook",
      "hasUnsyncedChanges",
      "lastSynced",
      "listNotebooks",
      "listNotebooksWithParents",
      "listNotebooksWithParentsStrict",
      "listNotes",
      "noteContentDiagnostic",
      "noteMetadata",
      "readNoteLockState",
      "readOperatorNoteContent",
      "search",
      "sync",
    ]);
    await expect(readOnly.sync({ type: "fetch" })).resolves.toBe(true);
    await expect(readOnly.listNotebooks()).resolves.toEqual([
      { id: "nb-1", title: "Work", dateModified: 11 },
    ]);
    await expect(readOnly.listNotes()).resolves.toEqual([
      { id: "note-1", title: "A note", dateModified: 22, notebookId: "nb-1" },
      {
        id: "locked-note",
        title: "Locked title must stay internal",
        dateModified: 24,
        conflicted: false,
        locked: true,
      },
    ]);
    expect(readOnly.findNotesByTitle).toBeTypeOf("function");
    await expect(readOnly.findNotesByTitle!("A note")).resolves.toEqual([
      {
        id: "note-1",
        title: "A note",
        dateModified: 22,
        notebookId: "nb-1",
        revision: createRevisionToken({ id: "note-1", dateEdited: 22 }),
      },
    ]);
    expect(readOnly.findNoteIdsByNotebook).toBeTypeOf("function");
    await expect(readOnly.findNoteIdsByNotebook!("nb-1")).resolves.toEqual(["note-1"]);
    expect(readOnly.hasNoteInNotebook).toBeTypeOf("function");
    await expect(readOnly.hasNoteInNotebook!("nb-1", "note-1")).resolves.toBe(true);
    await expect(readOnly.hasNoteInNotebook!("nb-1", "locked-note")).resolves.toBe(false);
    const relations = (
      database as unknown as {
        relations: { from: ReturnType<typeof vi.fn> };
      }
    ).relations;
    expect(relations.from).toHaveBeenCalledWith({ id: "nb-1", type: "notebook" }, "note");
    await expect(readOnly.noteMetadata("note-1")).resolves.toEqual({
      id: "note-1",
      title: "A note",
      dateModified: 22,
      notebookId: "nb-1",
      revision: createRevisionToken({ id: "note-1", dateEdited: 22 }),
    });
    await expect(readOnly.search("note")).resolves.toEqual([
      { id: "note-1", title: "A note", source: "note" },
      { id: "nb-1", title: "Work", source: "notebook" },
    ]);
    await expect(readOnly.sync({ type: "full" as "fetch" })).rejects.toSatisfy(
      isNotesnookReadOnlyProjectionError,
    );
    await expect(readOnly.sync({ type: "send" as "fetch" })).rejects.toSatisfy(
      isNotesnookReadOnlyProjectionError,
    );
    await expect(readOnly.sync({ type: "fetch", force: true })).rejects.toSatisfy(
      isNotesnookReadOnlyProjectionError,
    );
    expect(database.syncCalls).toEqual([{ type: "fetch" }]);
  });

  it("normalizes direct relation membership failures without leaking upstream detail", async () => {
    const database = createFakeLiveDatabase();
    const privateDetail = "private relation database failure";
    (
      database as unknown as {
        relations: { from: (reference: unknown, type: string) => unknown };
      }
    ).relations.from = () => ({
      has: async () => {
        throw new Error(privateDetail);
      },
    });
    const readOnly = flattenLiveDatabaseToReadOnly(database);

    const failure = await readOnly.hasNoteInNotebook!("nb-1", "note-1").catch(
      (error: unknown) => error,
    );
    expect(isNotesnookReadOnlyProjectionError(failure)).toBe(true);
    expect(String(failure)).not.toContain(privateDetail);
  });

  it("normalizes relation membership failures from throwing has getters", async () => {
    const database = createFakeLiveDatabase();
    Object.defineProperty(
      (database as unknown as { relations: { from: () => object } }).relations,
      "from",
      {
        configurable: true,
        value: () =>
          Object.defineProperty({}, "has", {
            get: () => {
              throw new Error("private has getter failure");
            },
          }),
      },
    );
    const readOnly = flattenLiveDatabaseToReadOnly(database);

    const failure = await readOnly.hasNoteInNotebook!("nb-1", "note-1").catch(
      (error: unknown) => error,
    );
    expect(isNotesnookReadOnlyProjectionError(failure)).toBe(true);
    expect(String(failure)).not.toContain("private has getter failure");
  });

  it("normalizes relation membership failures from throwing then getters", async () => {
    const database = createFakeLiveDatabase();
    (
      database as unknown as {
        relations: { from: (reference: unknown, type: string) => unknown };
      }
    ).relations.from = () =>
      Object.defineProperty({}, "then", {
        get: () => {
          throw new Error("private then getter failure");
        },
      });
    const readOnly = flattenLiveDatabaseToReadOnly(database);

    const failure = await readOnly.hasNoteInNotebook!("nb-1", "note-1").catch(
      (error: unknown) => error,
    );
    expect(isNotesnookReadOnlyProjectionError(failure)).toBe(true);
    expect(String(failure)).not.toContain("private then getter failure");
  });

  it("falls back to root-only summaries when notebooks.breadcrumbs is absent", async () => {
    // The fake DB without breadcrumbs should now succeed and produce a
    // root-only summary, not a categorical projection error.
    const database = createFakeLiveDatabase();
    const readOnly = flattenLiveDatabaseToReadOnly(database);
    await expect(readOnly.listNotebooksWithParents!()).resolves.toEqual([
      { id: "nb-1", title: "Work", dateModified: 11 },
    ]);
  });

  it("uses breadcrumbs when present and surfaces parentId for nested notebooks", async () => {
    // Synthetic nested hierarchy: parent -> child.  Both ids map to a
    // notebook record returned by `notebooks.notebook(id)`.
    const database = createFakeLiveDatabase({
      breadcrumbs: async (id: string) => {
        if (id === "nb-root") return [{ id: "nb-root", title: "Root" }];
        if (id === "nb-child") {
          return [
            { id: "nb-root", title: "Root" },
            { id: "nb-child", title: "Child" },
          ];
        }
        return [];
      },
    });
    // Replace the single notebook with a root+child pair.
    const notebooks = new Map<string, { id: string; title: string; dateEdited: number }>([
      ["nb-root", { id: "nb-root", title: "Root", dateEdited: 11 }],
      ["nb-child", { id: "nb-child", title: "Child", dateEdited: 22 }],
    ]);
    const notebooksManager = database.notebooks as unknown as {
      all: { ids: () => Promise<string[]> };
      notebook: (
        id: string,
      ) => Promise<{ id: string; title: string; dateEdited: number } | undefined>;
    };
    notebooksManager.all = { ids: async () => ["nb-root", "nb-child"] };
    notebooksManager.notebook = async (id: string) => notebooks.get(id);

    const readOnly = flattenLiveDatabaseToReadOnly(database);
    await expect(readOnly.listNotebooksWithParents!()).resolves.toEqual([
      { id: "nb-root", title: "Root", dateModified: 11 },
      { id: "nb-child", title: "Child", dateModified: 22, parentId: "nb-root" },
    ]);
  });

  it("falls back to root-only summaries when notebooks.breadcrumbs throws", async () => {
    // Some live cores expose the slot but reject the call.  The
    // destructive-delete seam must stay available rather than surface
    // a generic `service_unavailable`.
    const database = createFakeLiveDatabase({ breadcrumbsThrows: true });
    const readOnly = flattenLiveDatabaseToReadOnly(database);
    await expect(readOnly.listNotebooksWithParents!()).resolves.toEqual([
      { id: "nb-1", title: "Work", dateModified: 11 },
    ]);
  });

  it("skips an unavailable unrelated notebook while preserving valid hierarchy entries", async () => {
    const database = createFakeLiveDatabase();
    const notebooks = database.notebooks as unknown as {
      all: { ids: () => Promise<string[]> };
      notebook: (id: string) => Promise<unknown>;
    };
    const originalNotebook = notebooks.notebook;
    notebooks.all = { ids: async () => ["nb-1", "broken-notebook"] };
    notebooks.notebook = async (id: string) => {
      if (id === "broken-notebook") throw new Error("unavailable unrelated notebook");
      return originalNotebook(id);
    };

    const readOnly = flattenLiveDatabaseToReadOnly(database);
    await expect(readOnly.listNotebooksWithParents!()).resolves.toEqual([
      { id: "nb-1", title: "Work", dateModified: 11 },
    ]);
  });

  describe("listNotebooksWithParentsStrict", () => {
    type NotebookStub = { id: string; title: string; dateEdited: number };
    const ROOT: NotebookStub = { id: "nb-root", title: "Root", dateEdited: 11 };
    const CHILD: NotebookStub = { id: "nb-child", title: "Child", dateEdited: 22 };
    const nestedBreadcrumbs = async (id: string) => {
      if (id === "nb-root") return [{ id: "nb-root", title: "Root" }];
      if (id === "nb-child") {
        return [
          { id: "nb-root", title: "Root" },
          { id: "nb-child", title: "Child" },
        ];
      }
      return [];
    };
    /** A fake core whose notebook set and per-id lookup are fully controlled. */
    const hierarchyDatabase = (
      lookup: (id: string) => Promise<unknown>,
      ids: string[] = ["nb-root", "nb-child"],
      options: Parameters<typeof createFakeLiveDatabase>[0] = { breadcrumbs: nestedBreadcrumbs },
    ) => {
      const database = createFakeLiveDatabase(options);
      const notebooks = database.notebooks as unknown as {
        all: { ids: () => Promise<string[]> };
        notebook: (id: string) => Promise<unknown>;
      };
      notebooks.all = { ids: async () => ids };
      notebooks.notebook = lookup;
      return flattenLiveDatabaseToReadOnly(database);
    };
    const knownNotebooks = async (id: string): Promise<unknown> =>
      id === "nb-root" ? ROOT : id === "nb-child" ? CHILD : undefined;
    const expectCategorical = async (promise: Promise<unknown>, leak: string) => {
      const failure = await promise.catch((error: unknown) => error);
      expect(isNotesnookReadOnlyProjectionError(failure)).toBe(true);
      expect(String(failure)).not.toContain(leak);
    };

    it("is exposed by the flattened read-only projection", () => {
      const readOnly = flattenLiveDatabaseToReadOnly(createFakeLiveDatabase());
      expect(typeof readOnly.listNotebooksWithParentsStrict).toBe("function");
    });

    it("returns a valid nested hierarchy with proven parent ids", async () => {
      const readOnly = hierarchyDatabase(knownNotebooks);
      await expect(readOnly.listNotebooksWithParentsStrict!()).resolves.toEqual([
        { id: "nb-root", title: "Root", dateModified: 11 },
        { id: "nb-child", title: "Child", dateModified: 22, parentId: "nb-root" },
      ]);
    });

    it("rejects when notebooks.breadcrumbs is absent (legacy falls back to root-only)", async () => {
      const readOnly = hierarchyDatabase(knownNotebooks, ["nb-root", "nb-child"], {});
      await expectCategorical(readOnly.listNotebooksWithParentsStrict!(), "nb-");
      // The tolerant legacy method keeps its fallback on the very same database.
      await expect(readOnly.listNotebooksWithParents!()).resolves.toEqual([
        { id: "nb-root", title: "Root", dateModified: 11 },
        { id: "nb-child", title: "Child", dateModified: 22 },
      ]);
    });

    it("rejects when notebooks.breadcrumbs rejects (legacy falls back to root-only)", async () => {
      const readOnly = hierarchyDatabase(knownNotebooks, ["nb-root", "nb-child"], {
        breadcrumbsThrows: true,
      });
      await expectCategorical(readOnly.listNotebooksWithParentsStrict!(), "breadcrumb failure");
      await expect(readOnly.listNotebooksWithParents!()).resolves.toEqual([
        { id: "nb-root", title: "Root", dateModified: 11 },
        { id: "nb-child", title: "Child", dateModified: 22 },
      ]);
    });

    it("rejects when breadcrumbs fail only for a later notebook (no mid-enumeration fallback)", async () => {
      const readOnly = hierarchyDatabase(knownNotebooks, ["nb-root", "nb-child"], {
        breadcrumbs: async (id: string) => {
          if (id === "nb-child") throw new Error("later breadcrumb failure");
          return [{ id: "nb-root", title: "Root" }];
        },
      });
      await expectCategorical(readOnly.listNotebooksWithParentsStrict!(), "later breadcrumb");
      await expect(readOnly.listNotebooksWithParents!()).resolves.toEqual([
        { id: "nb-root", title: "Root", dateModified: 11 },
        { id: "nb-child", title: "Child", dateModified: 22 },
      ]);
    });

    it("rejects when an enumerated notebook is unavailable (legacy skips it)", async () => {
      const lookup = async (id: string): Promise<unknown> => {
        if (id === "nb-child") throw new Error("unavailable notebook secret");
        return knownNotebooks(id);
      };
      const readOnly = hierarchyDatabase(lookup);
      await expectCategorical(readOnly.listNotebooksWithParentsStrict!(), "unavailable notebook");
      await expect(readOnly.listNotebooksWithParents!()).resolves.toEqual([
        { id: "nb-root", title: "Root", dateModified: 11 },
      ]);
    });

    it("rejects when an enumerated notebook is missing (legacy skips it)", async () => {
      const lookup = async (id: string): Promise<unknown> =>
        id === "nb-child" ? undefined : knownNotebooks(id);
      const readOnly = hierarchyDatabase(lookup);
      await expectCategorical(readOnly.listNotebooksWithParentsStrict!(), "nb-child");
      await expect(readOnly.listNotebooksWithParents!()).resolves.toEqual([
        { id: "nb-root", title: "Root", dateModified: 11 },
      ]);
    });

    it.each<[string, unknown]>([
      ["a non-object record", "not-an-object"],
      ["a record without a title", { id: "nb-child", dateEdited: 22 }],
      ["a record with an empty id", { id: "", title: "Child", dateEdited: 22 }],
      ["a record with a different id", { id: "nb-other", title: "Child", dateEdited: 22 }],
    ])("rejects a malformed entry: %s (legacy skips it)", async (_label, malformed) => {
      const lookup = async (id: string): Promise<unknown> =>
        id === "nb-child" ? malformed : knownNotebooks(id);
      const readOnly = hierarchyDatabase(lookup);
      await expectCategorical(readOnly.listNotebooksWithParentsStrict!(), "nb-other");
      await expect(readOnly.listNotebooksWithParents!()).resolves.toEqual(
        expect.arrayContaining([{ id: "nb-root", title: "Root", dateModified: 11 }]),
      );
    });

    it.each<[string, (id: string) => Promise<unknown>]>([
      ["an empty breadcrumb list", async () => []],
      ["a non-array breadcrumb result", async () => "nope"],
      [
        "breadcrumbs that do not end at the notebook",
        async () => [{ id: "nb-someone-else", title: "Else" }],
      ],
    ])("rejects invalid breadcrumbs: %s", async (_label, breadcrumbs) => {
      const readOnly = hierarchyDatabase(knownNotebooks, ["nb-root", "nb-child"], {
        breadcrumbs: breadcrumbs as never,
      });
      await expectCategorical(readOnly.listNotebooksWithParentsStrict!(), "nb-someone-else");
    });

    it("rejects a parent that is not itself an enumerated notebook", async () => {
      const readOnly = hierarchyDatabase(knownNotebooks, ["nb-child"], {
        breadcrumbs: nestedBreadcrumbs,
      });
      await expectCategorical(readOnly.listNotebooksWithParentsStrict!(), "nb-root");
    });

    describe("notebook id enumeration is validated strictly", () => {
      const withIds = (all: unknown) => {
        const database = createFakeLiveDatabase({ breadcrumbs: nestedBreadcrumbs });
        const notebooks = database.notebooks as unknown as {
          all: unknown;
          notebook: (id: string) => Promise<unknown>;
        };
        notebooks.all = all;
        notebooks.notebook = knownNotebooks;
        return flattenLiveDatabaseToReadOnly(database);
      };

      it.each<[string, unknown]>([
        ["ids resolves to undefined", { ids: async () => undefined }],
        ["ids resolves to null", { ids: async () => null }],
        ["ids returns undefined synchronously", { ids: () => undefined }],
        ["ids returns null synchronously", { ids: () => null }],
        ["ids is missing", {}],
        ["ids is not a function", { ids: "nb-root" }],
        ["ids returns a non-thenable array", { ids: () => ["nb-root", "nb-child"] }],
        ["ids resolves to a non-array", { ids: async () => "nb-root" }],
        ["ids resolves to an object", { ids: async () => ({ length: 1, 0: "nb-root" }) }],
        [
          "ids throws synchronously",
          {
            ids: () => {
              throw new Error("sync-secret");
            },
          },
        ],
        [
          "ids rejects",
          {
            ids: async () => {
              throw new Error("reject-secret");
            },
          },
        ],
      ])("rejects with a categorical error when %s", async (_label, all) => {
        const failure = await withIds(all).listNotebooksWithParentsStrict!().catch(
          (error: unknown) => error,
        );
        expect(isNotesnookReadOnlyProjectionError(failure)).toBe(true);
        expect(String(failure)).not.toMatch(/secret|nb-root/);
      });

      it.each<[string, unknown[]]>([
        ["an empty string", ["nb-root", ""]],
        ["a number", ["nb-root", 7]],
        ["null", ["nb-root", null]],
        ["undefined", ["nb-root", undefined]],
        ["an object", ["nb-root", { id: "nb-child" }]],
        ["a duplicate id", ["nb-root", "nb-child", "nb-root"]],
      ])("rejects instead of skipping a malformed element: %s", async (_label, ids) => {
        const failure = await withIds({ ids: async () => ids })
          .listNotebooksWithParentsStrict!().catch((error: unknown) => error);
        expect(isNotesnookReadOnlyProjectionError(failure)).toBe(true);
        expect(String(failure)).not.toMatch(/nb-root|nb-child|\[object/);
      });

      it("accepts a genuinely empty, valid notebook list", async () => {
        await expect(
          withIds({ ids: async () => [] }).listNotebooksWithParentsStrict!(),
        ).resolves.toEqual([]);
      });

      it("keeps the tolerant listNotebooks behavior on the same malformed data", async () => {
        await expect(withIds({ ids: () => null }).listNotebooks()).resolves.toEqual([]);
        await expect(
          withIds({ ids: async () => ["nb-root", "", 7, null] }).listNotebooks(),
        ).resolves.toEqual([expect.objectContaining({ id: "nb-root" })]);
      });
    });

    it("rejects when the notebook id enumeration itself fails", async () => {
      const database = createFakeLiveDatabase({ breadcrumbs: nestedBreadcrumbs });
      (database.notebooks as unknown as { all: unknown }).all = {
        ids: async () => {
          throw new Error("enumeration secret");
        },
      };
      const readOnly = flattenLiveDatabaseToReadOnly(database);
      await expectCategorical(readOnly.listNotebooksWithParentsStrict!(), "enumeration secret");
    });

    it("rejects an oversized notebook id array before any per-id enrichment", async () => {
      // Availability bound for the strict hierarchy path.  257 valid-looking
      // ids exceed the published cap, so the enumeration must be rejected
      // categorically BEFORE any `notebooks.notebook(id)` or
      // `notebooks.breadcrumbs(id)` call runs, and the failure must never
      // become a silently truncated (partial, policy-unsafe) hierarchy.
      const oversizedIds = Array.from({ length: 257 }, (_, index) => `nb-oversized-${index}`);
      const notebookLookups: string[] = [];
      const breadcrumbLookups: string[] = [];
      const database = createFakeLiveDatabase({
        breadcrumbs: async (id: string) => {
          breadcrumbLookups.push(id);
          return [{ id, title: "Oversized" }];
        },
      });
      const notebooks = database.notebooks as unknown as {
        all: { ids: () => Promise<string[]> };
        notebook: (id: string) => Promise<unknown>;
      };
      notebooks.all = { ids: async () => oversizedIds };
      notebooks.notebook = async (id: string) => {
        notebookLookups.push(id);
        return { id, title: "Oversized", dateEdited: 5 };
      };
      const readOnly = flattenLiveDatabaseToReadOnly(database);

      const failure = await readOnly.listNotebooksWithParentsStrict!().catch(
        (error: unknown) => error,
      );
      expect(isNotesnookReadOnlyProjectionError(failure)).toBe(true);
      // The rejection carries no id bytes from the rejected enumeration.
      expect(String(failure)).not.toContain("nb-oversized-");
      // Neither the notebook detail lookup nor the breadcrumb lookup may run:
      // the cap is enforced before the enrichment loop is entered.
      expect(notebookLookups).toEqual([]);
      expect(breadcrumbLookups).toEqual([]);
    });

    it("still enumerates a notebook id array exactly at the published cap", async () => {
      // The cap is a rejection boundary, not a truncation boundary: 256 ids
      // remain a complete, fully enriched hierarchy.
      const cappedIds = Array.from({ length: 256 }, (_, index) => `nb-cap-${index}`);
      const readOnly = hierarchyDatabase(
        async (id: string) => ({ id, title: "Capped", dateEdited: 5 }),
        cappedIds,
        { breadcrumbs: async (id: string) => [{ id, title: "Capped" }] },
      );
      await expect(readOnly.listNotebooksWithParentsStrict!()).resolves.toHaveLength(256);
    });
  });

  it("redacts hostile upstream metadata failures", async () => {
    const database = createFakeLiveDatabase();
    const secret = "upstream-secret-note-body";
    (database.notes as { note: (id: string) => Promise<unknown> }).note = async () => {
      throw new Error(secret);
    };
    const readOnly = flattenLiveDatabaseToReadOnly(database);

    const failure = await readOnly.noteMetadata("note-1").catch((error: unknown) => error);
    expect(isNotesnookReadOnlyProjectionError(failure)).toBe(true);
    expect(failure).toMatchObject({
      message: "Notesnook read-only projection: notes.note rejected",
    });
    expect(String(failure)).not.toContain(secret);
  });

  it("requires the separate live-sync gate and always tears down a production runtime", async () => {
    const source = createFakeDatabase();
    const createProofSource = vi.fn(() => source);
    await expect(
      runSyncCommand({ argv: ["read-only"], env: {}, createProofSource }),
    ).resolves.toMatchObject({ kind: "error", exitCode: 2 });
    expect(createProofSource).not.toHaveBeenCalled();

    const cleanup = vi.fn(async () => undefined);
    await expect(
      runSyncCommand({
        argv: ["read-only"],
        env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
        createProofRuntime: async () => ({ source, cleanup }),
      }),
    ).resolves.toMatchObject({ kind: "report", report: { kind: "pass" } });
    expect(cleanup).toHaveBeenCalledOnce();

    const statusSource = createFakeDatabase();
    await expect(
      runSyncCommand({
        argv: ["status"],
        env: { [LIVE_SYNC_ENABLE_ENV]: "1" },
        createProofSource: () => statusSource,
      }),
    ).resolves.toMatchObject({ kind: "report", subcommand: "status" });
    expect(statusSource.syncCalls).toEqual([]);
  });
});

describe("read-only revision RPC chain", () => {
  it("carries the live projection revision through adapter, handler, and wire serialization", async () => {
    const live = createFakeLiveDatabase({
      extraNotes: [
        { id: "revision-note", title: "Revision note", dateEdited: 22, dateModified: 220 },
      ],
    });
    const projected = flattenLiveDatabaseToReadOnly(live);
    const adapter = createNotesnookReadOnlyAdapter({ source: projected });
    const runtime = {
      search: adapter.search.bind(adapter),
      noteMetadata: adapter.noteMetadata.bind(adapter),
    };
    const request: RpcNotesGetRequest = {
      id: "rpc-get-1",
      method: "notes.get",
      params: { id: "revision-note" },
    };

    const response = await handleRpcRequest(
      request,
      runtime,
      createReadWriteNoDeleteServicePolicy(),
    );
    expect(response.ok).toBe(true);
    if (!response.ok || response.result.kind !== "note") throw new Error("expected note response");
    expect(response.result.note.revision).toBe(
      createRevisionToken({ id: "revision-note", dateEdited: 22 }),
    );

    const frame = serializeRpcResponse(response);
    const wire = JSON.parse(new TextDecoder().decode(frame.subarray(4))) as {
      result?: { note?: Record<string, unknown> };
    };
    expect(wire.result?.note?.revision).toBe(
      createRevisionToken({ id: "revision-note", dateEdited: 22 }),
    );
    expect(JSON.stringify(wire)).not.toContain("secret body");
  });

  it("does not mint a revision from live display-only dateModified", async () => {
    const live = createFakeLiveDatabase({
      extraNotes: [{ id: "display-only-note", title: "Display only", dateModified: 220 }],
    });
    const projected = flattenLiveDatabaseToReadOnly(live);
    const adapter = createNotesnookReadOnlyAdapter({ source: projected });

    await expect(adapter.noteMetadata("display-only-note")).resolves.not.toHaveProperty("revision");
  });

  it("rejects non-string revisions at the RPC boundary", async () => {
    const request: RpcNotesGetRequest = {
      id: "rpc-get-invalid-revision",
      method: "notes.get",
      params: { id: "note-1" },
    };
    const runtime = {
      search: async () => [],
      noteMetadata: async () => ({ id: "note-1", title: "A note", revision: null }) as never,
    };

    await expect(
      handleRpcRequest(request, runtime, createReadWriteNoDeleteServicePolicy()),
    ).resolves.toMatchObject({ ok: false, error: { code: "service_unavailable" } });
  });

  it("converts revision derivation failures into a categorical projection error", async () => {
    const id = "x".repeat(129);
    const readOnly = flattenLiveDatabaseToReadOnly(
      createFakeLiveDatabase({ extraNotes: [{ id, title: "Too long", dateEdited: 22 }] }),
    );

    await expect(readOnly.noteMetadata(id)).rejects.toMatchObject({
      message: "Notesnook read-only projection: note revision token rejected",
    });
  });
});

describe("notes.get bounded content read", () => {
  it("returns bounded markdown when the note is unlocked and content decodes", async () => {
    const live = createFakeLiveDatabase({
      contentRecord: { type: "html", data: "<p>Hello world</p>" },
    });
    const projected = flattenLiveDatabaseToReadOnly(live);
    const adapter = createNotesnookReadOnlyAdapter({ source: projected });
    const runtime = {
      search: adapter.search.bind(adapter),
      noteMetadata: adapter.noteMetadata.bind(adapter),
      readOnly: { readOperatorNoteContent: adapter.readOperatorNoteContent.bind(adapter) },
    };
    const request: RpcNotesGetRequest = {
      id: "rpc-get-content",
      method: "notes.get",
      params: { id: "note-1" },
    };

    const response = await handleRpcRequest(
      request,
      runtime,
      createReadWriteNoDeleteServicePolicy(),
    );
    expect(response.ok).toBe(true);
    if (!response.ok || response.result.kind !== "note") throw new Error("expected note response");
    expect(response.result.contentStatus).toBe("ok");
    expect(response.result.markdown).toContain("Hello world");
    expect(response.result.markdownBytes).toBe(
      Buffer.byteLength(response.result.markdown as string, "utf8"),
    );

    const frame = serializeRpcResponse(response);
    const wire = JSON.parse(new TextDecoder().decode(frame.subarray(4))) as {
      result?: { contentStatus?: string; markdown?: string; markdownBytes?: number };
    };
    expect(wire.result?.contentStatus).toBe("ok");
    expect(wire.result?.markdown).toContain("Hello world");
    expect(wire.result?.markdownBytes).toBe(response.result.markdownBytes);
  });

  it("binds notes.get opaque sentinels to the note id and revision", async () => {
    const rawImage =
      '<img src="https://example.com/image.png" alt="image" data-path="/private/notes/image.bin">';
    const live = createFakeLiveDatabase({
      contentRecord: { type: "html", data: rawImage },
    });
    const projected = flattenLiveDatabaseToReadOnly(live);
    const adapter = createNotesnookReadOnlyAdapter({ source: projected });
    const runtime = {
      search: adapter.search.bind(adapter),
      noteMetadata: adapter.noteMetadata.bind(adapter),
      readOnly: { readOperatorNoteContent: adapter.readOperatorNoteContent.bind(adapter) },
    };
    const metadata = await adapter.noteMetadata("note-1");
    if (metadata === undefined || metadata.revision === undefined)
      throw new Error("missing test revision");
    const response = await handleRpcRequest(
      { id: "rpc-get-opaque", method: "notes.get", params: { id: "note-1" } },
      runtime,
      createReadWriteNoDeleteServicePolicy(),
    );
    if (!response.ok || response.result.kind !== "note") throw new Error("expected note response");
    const expected = createHash("sha256")
      .update(`${JSON.stringify(["note-1", metadata.revision])}\u0000${0}\u0000${rawImage}`)
      .digest("hex")
      .slice(0, 36);
    expect(response.result.contentStatus).toBe("ok");
    expect(response.result.markdown).toBe(
      `---\nnookbridge-format: 1\n---\n\n:::nookbridge opaque img\nref:1:native-html:${expected}\n:::\n`,
    );
    expect(response.result.markdown).not.toContain("/private/notes/");
  });

  it("withholds content for a locked note without ever calling the content reader", async () => {
    const live = createFakeLiveDatabase();
    const projected = flattenLiveDatabaseToReadOnly(live);
    const adapter = createNotesnookReadOnlyAdapter({ source: projected });
    const readSpy = vi.fn(adapter.readOperatorNoteContent.bind(adapter));
    const runtime = {
      search: adapter.search.bind(adapter),
      noteMetadata: adapter.noteMetadata.bind(adapter),
      readOnly: { readOperatorNoteContent: readSpy },
    };
    const request: RpcNotesGetRequest = {
      id: "rpc-get-locked",
      method: "notes.get",
      params: { id: "locked-note" },
    };

    const response = await handleRpcRequest(
      request,
      runtime,
      createReadWriteNoDeleteServicePolicy(),
    );
    expect(response.ok).toBe(true);
    if (!response.ok || response.result.kind !== "note") throw new Error("expected note response");
    expect(response.result.contentStatus).toBe("locked");
    expect(response.result).not.toHaveProperty("markdown");
    expect(response.result).not.toHaveProperty("markdownBytes");
    expect(response.result.note.locked).toBe(true);
    expect(readSpy).not.toHaveBeenCalled();

    const frame = serializeRpcResponse(response);
    const wire = JSON.parse(new TextDecoder().decode(frame.subarray(4))) as {
      result?: Record<string, unknown>;
    };
    expect(JSON.stringify(wire)).not.toContain("locked note body");
    expect(wire.result?.markdown).toBeUndefined();
  });

  it("degrades to oversize (and still serializes) when content is under the byte cap but the whole response would not fit", async () => {
    // Eight 5k-char paragraphs of double quotes: 8 x 5,000 = 40,000 quotes
    // (~40 KB as Markdown, plus a few separator bytes), under
    // maxResponseBytes (65,536), so a markdown-only bound would call this
    // "ok". But JSON escapes each `"` as `\"` (2 bytes), so the encoded
    // body costs ~80,000 bytes > 65,536 - 1,024 and the response cannot fit.
    // (Paragraphs, not one block: the native decoder rejects very long
    // single text blocks, which would yield "unavailable" instead.)
    const paragraph = `<p>${'"'.repeat(5_000)}</p>`;
    const live = createFakeLiveDatabase({
      contentRecord: { type: "html", data: paragraph.repeat(8) },
    });
    const projected = flattenLiveDatabaseToReadOnly(live);
    const adapter = createNotesnookReadOnlyAdapter({ source: projected });
    const runtime = {
      search: adapter.search.bind(adapter),
      noteMetadata: adapter.noteMetadata.bind(adapter),
      readOnly: { readOperatorNoteContent: adapter.readOperatorNoteContent.bind(adapter) },
    };
    const response = await handleRpcRequest(
      { id: "rpc-get-near-limit", method: "notes.get", params: { id: "note-1" } },
      runtime,
      createReadWriteNoDeleteServicePolicy(),
    );
    if (!response.ok || response.result.kind !== "note") throw new Error("expected note response");
    expect(response.result.contentStatus).toBe("oversize");
    expect(response.result).not.toHaveProperty("markdown");
    expect(() => serializeRpcResponse(response)).not.toThrow();
  });

  it("wire serializer rejects a markdownBytes that disagrees with the markdown", () => {
    const envelope = (markdownBytes: number) =>
      ({
        id: "rpc-get-bytes",
        ok: true,
        result: {
          kind: "note",
          note: { id: "note-1", title: "A note" },
          contentStatus: "ok",
          markdown: "héllo",
          markdownBytes,
        },
      }) as unknown as Parameters<typeof serializeRpcResponse>[0];
    // "héllo" is 6 UTF-8 bytes; the correct value serializes, wrong ones do not.
    expect(() => serializeRpcResponse(envelope(6))).not.toThrow();
    expect(() => serializeRpcResponse(envelope(5))).toThrow();
    expect(() => serializeRpcResponse(envelope(6.5))).toThrow();
  });

  it("falls back to unavailable when content cannot be decoded, and omits content with no reader", async () => {
    const live = createFakeLiveDatabase();
    const projected = flattenLiveDatabaseToReadOnly(live);
    const adapter = createNotesnookReadOnlyAdapter({ source: projected });
    const withReader = {
      search: adapter.search.bind(adapter),
      noteMetadata: adapter.noteMetadata.bind(adapter),
      readOnly: { readOperatorNoteContent: adapter.readOperatorNoteContent.bind(adapter) },
    };
    const request: RpcNotesGetRequest = {
      id: "rpc-get-unsupported",
      method: "notes.get",
      params: { id: "note-1" },
    };
    const withReaderResponse = await handleRpcRequest(
      request,
      withReader,
      createReadWriteNoDeleteServicePolicy(),
    );
    if (!withReaderResponse.ok || withReaderResponse.result.kind !== "note")
      throw new Error("expected note response");
    expect(withReaderResponse.result.contentStatus).toBe("unavailable");

    const noReader = {
      search: adapter.search.bind(adapter),
      noteMetadata: adapter.noteMetadata.bind(adapter),
    };
    const noReaderResponse = await handleRpcRequest(
      { ...request, id: "rpc-get-no-reader" },
      noReader,
      createReadWriteNoDeleteServicePolicy(),
    );
    if (!noReaderResponse.ok || noReaderResponse.result.kind !== "note")
      throw new Error("expected note response");
    expect(noReaderResponse.result.contentStatus).toBe("unavailable");
  });
});
