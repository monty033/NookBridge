/**
 * Stage 3 preparation — deterministic tests for the closed read-only seam.
 *
 * These tests never import the live Notesnook runtime and never use account
 * state or network access. They prove the adapter's allowlist before a
 * future live runner is allowed to exercise native sync.
 */

import { TextDecoder } from "node:util";
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
import { handleRpcRequest } from "../src/service/rpc-handler.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import { serializeRpcResponse, type RpcNotesGetRequest } from "../src/service/rpc-protocol.js";
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

function createFakeLiveDatabase(
  options: {
    noteSearchIds?: string[];
    noteListIds?: string[];
    notebookSearchIds?: string[];
    extraNotes?: Array<Readonly<Record<string, unknown>> & { id: string; title: string }>;
    conflictMarker?: "present" | "absent";
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
        notebooks: [{ id: "nb-1" }],
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
    ["note-1", { locked: false, data: "ordinary body must stay internal" }],
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
    },
    notes: {
      all: { ids: async () => options.noteListIds ?? ["note-1"] },
      note: async (id: string) => notes.get(id),
    },
    content: { findByNoteId: async (id: string) => contents.get(id) },
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
          { name: "search", status: "pass", detail: "no query supplied" },
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
      "hasUnsyncedChanges",
      "lastSynced",
      "listNotebooks",
      "listNotebooksWithParents",
      "listNotes",
      "noteMetadata",
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
