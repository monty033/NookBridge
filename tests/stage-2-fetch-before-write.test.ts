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
import { createLivePreWriteRead } from "../src/core/notesnook-live-pre-write-read.js";
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
  function fakeDatabase(result: () => unknown) {
    const seen: unknown[] = [];
    return {
      seen,
      database: {
        syncer: {
          start: (request: unknown) => {
            seen.push(request);
            return result();
          },
        },
      },
    };
  }

  it("issues a fetch-only sync, never a full sync", async () => {
    const fake = fakeDatabase(() => true);
    const read = createLivePreWriteRead(fake.database, () => undefined);

    await expect(read()).resolves.toBe(true);
    expect(fake.seen).toEqual([{ type: "fetch" }]);
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
    const read = createLivePreWriteRead(
      fakeDatabase(() => {
        throw new Error("network");
      }).database,
      () => undefined,
    );

    await expect(read()).resolves.toBe(false);
  });

  it("refuses a database with no syncer", () => {
    expect(() => createLivePreWriteRead({}, () => undefined)).toThrow();
  });
});
