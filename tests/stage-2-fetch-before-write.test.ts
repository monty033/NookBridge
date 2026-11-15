/**
 * Stage 2 prevention: pull remote changes before a local mutation.
 *
 * A bridge write that never fetched can overwrite a note the phone changed
 * since the bridge last saw it, and the conflict that produces is the one the
 * operator then has to resolve by hand. These tests pin the pre-write pull:
 * it runs inside the mutation mutex, before the adapter sees the command, and
 * a pull that is not confirmed refuses the write with `sync_required` instead
 * of writing blind.
 *
 * The positive control matters as much as the refusals: a seam that refuses
 * every write satisfies every negative assertion here.
 */

import { describe, expect, it } from "vitest";
import {
  createNotesnookLocalWriteComposition,
  type NotesnookLocalWriteHandle,
  type NotesnookPendingSyncHandle,
} from "../src/core/notesnook-write-composition.js";
import {
  assertLivePreWriteConfirmation,
  createLivePreWriteRead,
} from "../src/core/notesnook-live-pre-write-read.js";
import { SyncCoordinator } from "../src/core/notesnook-sync-coordinator.js";

import { createRevisionToken } from "../src/core/notesnook-write-contract.js";

const CREATE = { title: "Field notes", content: { type: "tiptap" as const, data: "[]" } };
const NOTE_ID = "note-1";
const revision = () => createRevisionToken({ id: NOTE_ID, dateEdited: 5 });

type Harness = Readonly<{
  composition: ReturnType<typeof createNotesnookLocalWriteComposition>;
  /** One entry per side effect, in the order they happened. */
  calls: string[];
}>;

function harness(options: { readonly pull?: () => Promise<unknown> } = {}): Harness {
  const calls: string[] = [];
  const adapter: NotesnookLocalWriteHandle = {
    createNote: async () => {
      calls.push("adapter");
      return {
        operation: "create",
        id: "note-1",
        titleBytes: 1,
        contentBytes: 0,
        localCommitted: true,
        remoteSynced: false,
        pendingSync: true,
      };
    },
    appendNote: async () => {
      calls.push("adapter");
      return {
        operation: "append",
        id: "note-1",
        titleBytes: 1,
        contentBytes: 1,
        localCommitted: true,
        remoteSynced: false,
        pendingSync: true,
      };
    },
    updateNote: async () => {
      calls.push("adapter");
      return {
        operation: "update",
        id: "note-1",
        appliedFields: ["title"],
        titleBytes: 1,
        contentBytes: 1,
        localCommitted: true,
        remoteSynced: false,
        pendingSync: true,
      };
    },
    deleteNote: async () => {
      calls.push("adapter");
      return {
        operation: "delete",
        id: "note-1",
        titleBytes: 1,
        contentBytes: 0,
        localCommitted: true,
        remoteSynced: false,
        pendingSync: true,
      };
    },
  };
  const coordinator = new SyncCoordinator({
    executor: () => ({ status: "confirmed" as const }),
  });
  const handle: NotesnookPendingSyncHandle = {
    recordLocalCommit: (receipt) => coordinator.recordLocalCommit(receipt),
    requestSync: () => coordinator.requestSync(),
    snapshot: () => coordinator.snapshot(),
  };
  const readBeforeWrite =
    options.pull === undefined
      ? undefined
      : async (): Promise<unknown> => {
          calls.push("pull");
          return await options.pull!();
        };
  const composition = createNotesnookLocalWriteComposition({
    adapter,
    coordinator: handle,
    ...(readBeforeWrite === undefined ? {} : { readBeforeWrite }),
  });
  return { composition, calls };
}

/** Every mutation, so a rule added to one entry point cannot skip the others. */
const WRITES = [
  ["create", (c: Harness["composition"]) => c.createNote(CREATE as never)],
  [
    "append",
    (c: Harness["composition"]) =>
      c.appendNote({ id: NOTE_ID, markdownFragment: "x", expectedRevision: revision() } as never),
  ],
  [
    "update",
    (c: Harness["composition"]) =>
      c.updateNote({
        id: NOTE_ID,
        patch: { title: "t" },
        expectedRevision: revision(),
      } as never),
  ],
  [
    "delete",
    (c: Harness["composition"]) =>
      c.deleteNote({ id: NOTE_ID, expectedRevision: revision() } as never),
  ],
] as const;

describe("Stage 2 fetch before write", () => {
  it.each(WRITES)("pulls before %s, and the adapter runs only after the pull", async (_, write) => {
    const { composition, calls } = harness({ pull: async () => true });

    await expect(write(composition)).resolves.toBeDefined();

    expect(calls).toEqual(["pull", "adapter"]);
  });

  it.each(WRITES)(
    "refuses %s with sync_required when the pull reports failure",
    async (_, write) => {
      const { composition, calls } = harness({ pull: async () => false });

      await expect(write(composition)).rejects.toMatchObject({ code: "sync_required" });
      // The refusal must land before the mutation: no adapter call, no marker.
      expect(calls).toEqual(["pull"]);
    },
  );

  it.each(WRITES)("refuses %s when the pull throws", async (_, write) => {
    const { composition, calls } = harness({
      pull: async () => {
        throw new Error("network");
      },
    });

    await expect(write(composition)).rejects.toMatchObject({ code: "sync_required" });
    expect(calls).toEqual(["pull"]);
  });

  it("refuses a pull that does not return a boolean", async () => {
    const { composition, calls } = harness({ pull: async () => "yes" });

    await expect(composition.createNote(CREATE as never)).rejects.toMatchObject({
      code: "sync_required",
    });
    expect(calls).toEqual(["pull"]);
  });

  it("still writes when no pull is configured (legacy seam)", async () => {
    const { composition, calls } = harness();

    await expect(composition.createNote(CREATE as never)).resolves.toMatchObject({
      localCommitted: true,
    });
    expect(calls).toEqual(["adapter"]);
  });
});

describe("live pre-write read", () => {
  /**
   * A database whose "last synced" stamp only moves when the test says the
   * sync actually completed. This is the distinction the live failure turned
   * on: `syncer.start` resolves `true` on paths that perform no fetch at all,
   * so the boolean alone cannot confirm a pull.
   */
  function fakeDatabase(result: () => unknown, initialLastSynced = 1_000) {
    const seen: unknown[] = [];
    let lastSynced = initialLastSynced;
    return {
      seen,
      advanceLastSynced: (value: number) => {
        lastSynced = value;
      },
      database: {
        syncer: {
          start: (request: unknown) => {
            seen.push(request);
            return result();
          },
        },
        lastSynced: async () => lastSynced,
      },
    };
  }

  it("issues a fetch-only sync, never a full sync", async () => {
    const fake = fakeDatabase(() => {
      fake.advanceLastSynced(2_000);
      return true;
    });
    const read = createLivePreWriteRead(fake.database, () => undefined);

    await expect(read()).resolves.toBe(true);
    expect(fake.seen).toEqual([{ type: "fetch" }]);
  });

  it("confirms only when the sync actually completed, not merely when it resolved", async () => {
    // The live shape: the call resolves `true`, nothing was fetched, and the
    // last-synced stamp never moves.
    const fake = fakeDatabase(() => true);
    const read = createLivePreWriteRead(fake.database, () => undefined);

    await expect(read()).resolves.toBe(false);
  });

  it("reports failure when the sync reports failure", async () => {
    const read = createLivePreWriteRead(fakeDatabase(() => false).database, () => undefined);

    await expect(read()).resolves.toBe(false);
  });

  it("reports failure when the sync does not return a boolean", async () => {
    const read = createLivePreWriteRead(fakeDatabase(() => undefined).database, () => undefined);

    await expect(read()).resolves.toBe(false);
  });

  it("reports failure when the sync throws", async () => {
    const fake = fakeDatabase(() => {
      throw new Error("network");
    });
    const read = createLivePreWriteRead(fake.database, () => undefined);

    await expect(read()).resolves.toBe(false);
  });

  it("allows a local-only write when no account is signed in", async () => {
    // Nothing remote can hold a competing version, so a pull would be
    // pointless and refusing would break every fresh database.
    const fake = fakeDatabase(() => true);
    const database = {
      ...fake.database,
      user: { getUser: async () => undefined },
    };
    const read = createLivePreWriteRead(database, () => undefined);

    await expect(read()).resolves.toBe(true);
    expect(fake.seen).toEqual([]);
  });

  it("requires a confirmed pull when an account is signed in", async () => {
    const fake = fakeDatabase(() => true);
    const database = {
      ...fake.database,
      user: { getUser: async () => ({ id: "account" }) },
    };
    const read = createLivePreWriteRead(database, () => undefined);

    await expect(read()).resolves.toBe(false);
    expect(fake.seen).toEqual([{ type: "fetch" }]);
  });

  it("requires the pull when a token exists but no user record is loaded", async () => {
    // Core stores the token and the user record separately, so an absent user
    // record is not proof of being signed out. Treating it as signed out would
    // let a token-holding database write without a pull.
    const fake = fakeDatabase(() => true);
    const database = {
      ...fake.database,
      user: { getUser: async () => undefined },
      // The real token API returns an opaque envelope, not a string.
      tokenManager: { getToken: async () => ({ accessToken: "envelope" }) },
    };
    const read = createLivePreWriteRead(database, () => undefined);

    await expect(read()).resolves.toBe(false);
    expect(fake.seen).toEqual([{ type: "fetch" }]);
  });

  it("trusts the completion event over a resolved call", async () => {
    const handlers: Array<() => void> = [];
    const fake = fakeDatabase(() => {
      // A sync that resolved without ever publishing completion.
      return true;
    });
    const database = {
      ...fake.database,
      eventManager: {
        subscribe: (_name: string, handler: () => void) => {
          handlers.push(handler);
          return { unsubscribe: () => true };
        },
      },
    };
    const read = createLivePreWriteRead(database, () => undefined);

    await expect(read()).resolves.toBe(false);
    expect(handlers).toHaveLength(1);
  });

  it("does not confirm on the event alone when the completion stamp stayed put", async () => {
    const handlers: Array<() => void> = [];
    const fake = fakeDatabase(() => {
      for (const handler of handlers) handler();
      return true;
    });
    const database = {
      ...fake.database,
      eventManager: {
        subscribe: (_name: string, handler: () => void) => {
          handlers.push(handler);
          return { unsubscribe: () => true };
        },
      },
    };
    const read = createLivePreWriteRead(database, () => undefined);

    await expect(read()).resolves.toBe(false);
  });

  it("does not confirm on an advanced stamp when no completion event arrived", async () => {
    // The inverse of the event-alone case: the stamp moving is not enough when
    // an event source exists, so dropping the event requirement must fail here.
    const handlers: Array<() => void> = [];
    const fake = fakeDatabase(() => {
      fake.advanceLastSynced(9_000);
      return true;
    });
    const database = {
      ...fake.database,
      eventManager: {
        subscribe: (_name: string, handler: () => void) => {
          handlers.push(handler);
          return { unsubscribe: () => true };
        },
      },
    };
    const read = createLivePreWriteRead(database, () => undefined);

    await expect(read()).resolves.toBe(false);
    expect(handlers).toHaveLength(1);
  });

  it("confirms when the event fires and the stamp advanced", async () => {
    const handlers: Array<() => void> = [];
    const fake = fakeDatabase(() => {
      fake.advanceLastSynced(4_000);
      for (const handler of handlers) handler();
      return true;
    });
    const database = {
      ...fake.database,
      eventManager: {
        subscribe: (_name: string, handler: () => void) => {
          handlers.push(handler);
          return { unsubscribe: () => true };
        },
      },
    };
    const read = createLivePreWriteRead(database, () => undefined);

    await expect(read()).resolves.toBe(true);
  });

  it("takes core's sync lock so an overlapping auto-sync cannot confirm this pull", async () => {
    // autoSync schedules a sync off database activity; stopping it for the
    // duration means completion cannot be published by a different sync while
    // this pull is the one that must be proven.
    const calls: string[] = [];
    let stamp = 1_000;
    const database = {
      syncer: {
        acquireLock: async (fn: () => Promise<void>) => {
          calls.push("lock");
          await fn();
          calls.push("unlock");
        },
        start: async () => {
          calls.push("start");
          stamp = 2_000;
          return true;
        },
      },
      lastSynced: async () => stamp,
    };
    const read = createLivePreWriteRead(database, () => undefined);

    await expect(read()).resolves.toBe(true);
    expect(calls).toEqual(["lock", "start", "unlock"]);
  });

  it("refuses a database with no syncer", () => {
    expect(() => createLivePreWriteRead({}, () => undefined)).toThrow();
  });

  it("refuses, in production, a database that cannot report whether a sync completed", () => {
    // The production path asserts the completion stamp while it is being
    // built, so a deployment that could not prove a pull never starts. The
    // message is pinned so a bare TypeError cannot pass as this refusal.
    expect(() => assertLivePreWriteConfirmation({ syncer: { start: () => true } })).toThrow(
      /cannot confirm a fetch/,
    );
  });

  it("accepts a database that can report both completion signals", () => {
    expect(() =>
      assertLivePreWriteConfirmation({
        lastSynced: async () => 1,
        eventManager: { subscribe: () => ({ unsubscribe: () => true }) },
      }),
    ).not.toThrow();
  });

  it("refuses a database that can only stamp completion", () => {
    // Stamp alone would silently weaken the documented guarantee to a
    // stamp-only check, so startup must refuse it rather than degrade.
    expect(() => assertLivePreWriteConfirmation({ lastSynced: async () => 1 })).toThrow(
      /cannot confirm a fetch/,
    );
  });

  it("refuses a database that can only observe completion", () => {
    expect(() =>
      assertLivePreWriteConfirmation({ eventManager: { subscribe: () => ({}) } }),
    ).toThrow(/cannot confirm a fetch/);
  });

  it("keeps the reported boolean when a fixture has no completion record", async () => {
    // The loose path is limited to databases that cannot report completion at
    // all; production asserts the stamp before it can get here.
    const fake = fakeDatabase(() => true);
    const database = { syncer: fake.database.syncer };
    const read = createLivePreWriteRead(database, () => undefined);

    await expect(read()).resolves.toBe(true);
  });

  it("reports failure when the stamp cannot be read", async () => {
    const fake = fakeDatabase(() => true);
    const database = {
      ...fake.database,
      lastSynced: async () => {
        throw new Error("kv closed");
      },
    };
    const read = createLivePreWriteRead(database, () => undefined);

    await expect(read()).resolves.toBe(false);
  });
});
