/**
 * Stage 3 preparation — deterministic tests for the closed read-only seam.
 *
 * These tests never import the live Notesnook runtime and never use account
 * state or network access. They prove the adapter's allowlist before a
 * future live runner is allowed to exercise native sync.
 */

import { describe, expect, it } from "vitest";

import {
  createNotesnookReadOnlyAdapter,
  isNotesnookReadOnlyAdapterError,
  type NotesnookReadOnlyDatabase,
} from "../src/core/notesnook-readonly-adapter.js";

function createFakeDatabase(): NotesnookReadOnlyDatabase & {
  syncCalls: Array<{ type: "full" | "fetch"; force?: boolean }>;
} {
  const syncCalls: Array<{ type: "full" | "fetch"; force?: boolean }> = [];
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
    await expect(adapter.search("note")).resolves.toEqual([
      { id: "note-1", title: "A note", source: "note" },
    ]);
  });

  it("allows full/fetch sync but rejects send and invalid inputs", async () => {
    const database = createFakeDatabase();
    const adapter = createNotesnookReadOnlyAdapter({ source: database });

    await expect(adapter.sync({ type: "full", force: true })).resolves.toBe(true);
    expect(database.syncCalls).toEqual([{ type: "full", force: true }]);

    await expect(adapter.sync({ type: "send" as "full" })).rejects.toMatchObject({
      message: 'Notesnook read-only adapter: sync type must be "full" or "fetch"',
    });
    await expect(adapter.noteMetadata("")).rejects.toMatchObject({
      message: "Notesnook read-only adapter: note id must be a non-empty string",
    });
    await expect(adapter.search("")).rejects.toMatchObject({
      message: "Notesnook read-only adapter: search query must be a non-empty string",
    });
    expect(database.syncCalls).toEqual([{ type: "full", force: true }]);
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

    const first = adapter.sync({ type: "full" });
    const second = adapter.sync({ type: "fetch" });
    await Promise.resolve();
    expect(database.syncCalls).toEqual([{ type: "full" }]);

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
