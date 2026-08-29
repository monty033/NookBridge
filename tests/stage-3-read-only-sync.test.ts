/**
 * Stage 3 preparation — deterministic tests for the closed read-only seam.
 *
 * These tests never import the live Notesnook runtime and never use account
 * state or network access. They prove the adapter's allowlist before a
 * future live runner is allowed to exercise native sync.
 */

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

function createFakeLiveDatabase(): NotesnookLiveDatabase & {
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
    [
      "conflict-note",
      {
        id: "conflict-note",
        title: "Conflict title must stay internal",
        dateEdited: 23,
        conflicted: true,
        body: "conflict body must stay internal",
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
    notes: { note: async (id: string) => notes.get(id) },
    content: { findByNoteId: async (id: string) => contents.get(id) },
    lookup: {
      notes: async () => searchResults(["note-1"]),
      notebooks: async () => searchResults(["nb-1"]),
    },
    lastSynced: async () => 99,
    hasUnsyncedChanges: async () => false,
  };
  return database as unknown as NotesnookLiveDatabase & {
    syncCalls: Array<{ type: "fetch"; force?: boolean }>;
  };
}

describe("Stage 3 production projection and sync gate", () => {
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
    const database = createFakeLiveDatabase();
    const readOnly = flattenLiveDatabaseToReadOnly(database);

    expect(Object.keys(readOnly).sort()).toEqual([
      "hasUnsyncedChanges",
      "lastSynced",
      "listNotebooks",
      "noteMetadata",
      "search",
      "sync",
    ]);
    await expect(readOnly.sync({ type: "fetch" })).resolves.toBe(true);
    await expect(readOnly.listNotebooks()).resolves.toEqual([
      { id: "nb-1", title: "Work", dateModified: 11 },
    ]);
    await expect(readOnly.noteMetadata("note-1")).resolves.toEqual({
      id: "note-1",
      title: "A note",
      dateModified: 22,
      notebookId: "nb-1",
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
