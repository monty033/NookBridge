/**
 * Stage 5 — offline tests for the local-only Notesnook conflict marker.
 *
 * These tests use the pinned FilteredSelector-shaped `ids()` seam and
 * `notes.note(id)` only. They do not import the live runtime or perform sync.
 */

import { describe, expect, it } from "vitest";

import {
  createNotesnookLocalConflictObserver,
  isNotesnookLocalConflictProjectionError,
  type NotesnookLocalConflictSource,
} from "../src/core/notesnook-local-conflict-projection.js";

function detectingSource(): NotesnookLocalConflictSource {
  return {
    notes: {
      conflicted: {
        ids: async () => ["conflict-note"],
      },
      note: async (id: string) => ({
        id,
        title: "Locally conflicted note",
        dateEdited: 1_700_000_000_000,
        conflicted: true,
        body: "must never cross the projection",
      }),
    },
  };
}

describe("Stage 5 local conflict observer", () => {
  it("projects a detecting device's local conflict marker as bounded metadata", async () => {
    const observer = createNotesnookLocalConflictObserver(detectingSource());

    await expect(observer.listLocalConflicts()).resolves.toEqual([
      {
        id: "conflict-note",
        title: "Locally conflicted note",
        dateModified: 1_700_000_000_000,
      },
    ]);
    const conflicts = await observer.listLocalConflicts();
    expect(Object.isFrozen(conflicts)).toBe(true);
    expect(Object.isFrozen(conflicts[0])).toBe(true);
    const observation = await observer.observeNoteConflict("conflict-note");
    expect(observation).toEqual({
      id: "conflict-note",
      title: "Locally conflicted note",
      dateModified: 1_700_000_000_000,
      conflicted: true,
    });
    expect(Object.isFrozen(observation)).toBe(true);
  });

  it("returns fresh frozen results and represents a fresh fetch-only database without a marker", async () => {
    let noteCalls = 0;
    const source: NotesnookLocalConflictSource = {
      notes: {
        conflicted: { ids: async () => [] },
        note: async () => {
          noteCalls += 1;
          return {
            id: "fresh-note",
            title: "Fresh note",
            conflicted: false,
          };
        },
      },
    };
    const observer = createNotesnookLocalConflictObserver(source);

    const first = await observer.listLocalConflicts();
    const second = await observer.listLocalConflicts();
    expect(first).toEqual([]);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    await expect(observer.observeNoteConflict("fresh-note")).resolves.toBe(false);
    expect(noteCalls).toBe(1);
  });

  it("exposes only the two read-only observer methods and never touches forbidden surfaces", async () => {
    const touched: string[] = [];
    const notes = {
      conflicted: { ids: async () => ["safe-note"] },
      note: async (id: string) => ({ id, title: "Safe note", conflicted: true }),
      get collection(): never {
        touched.push("collection");
        throw new Error("collection must not be read");
      },
      remove(): never {
        touched.push("remove");
        throw new Error("remove must not be called");
      },
    };
    const observer = createNotesnookLocalConflictObserver({ notes });

    expect(Object.getOwnPropertyNames(observer)).toEqual([
      "listLocalConflicts",
      "observeNoteConflict",
    ]);
    expect(Object.isFrozen(observer)).toBe(true);
    expect((observer as unknown as { database?: unknown }).database).toBeUndefined();
    await expect(observer.listLocalConflicts()).resolves.toEqual([
      { id: "safe-note", title: "Safe note" },
    ]);
    expect(touched).toEqual([]);
  });

  it("rejects invalid caller ids before any upstream lookup", async () => {
    let calls = 0;
    const source: NotesnookLocalConflictSource = {
      notes: {
        conflicted: { ids: async () => ["should-not-be-read"] },
        note: async () => {
          calls += 1;
          return undefined;
        },
      },
    };
    const observer = createNotesnookLocalConflictObserver(source);

    await expect(observer.observeNoteConflict("bad id")).rejects.toSatisfy((error: unknown) => {
      expect(isNotesnookLocalConflictProjectionError(error)).toBe(true);
      expect(error).toMatchObject({ message: "local conflict note id is invalid" });
      return true;
    });
    await expect(observer.observeNoteConflict("bad.id")).rejects.toSatisfy((error: unknown) => {
      expect(isNotesnookLocalConflictProjectionError(error)).toBe(true);
      expect(error).toMatchObject({ message: "local conflict note id is invalid" });
      return true;
    });
    expect(calls).toBe(0);
  });

  it("rejects duplicate or malformed selector ids categorically", async () => {
    const duplicate = createNotesnookLocalConflictObserver({
      notes: {
        conflicted: { ids: async () => ["same-note", "same-note"] },
        note: async () => ({ id: "same-note", title: "Same", conflicted: true }),
      },
    });
    await expect(duplicate.listLocalConflicts()).rejects.toMatchObject({
      message: "local conflict selector returned duplicate ids",
    });

    const malformed = createNotesnookLocalConflictObserver({
      notes: {
        conflicted: { ids: async () => ["bad id"] },
        note: async () => ({ id: "bad id", title: "Bad", conflicted: true }),
      },
    });
    await expect(malformed.listLocalConflicts()).rejects.toMatchObject({
      message: "local conflict selector returned an invalid id",
    });
  });

  it("binds request identity and rejects malformed, hostile, and upstream-failing records without redaction leaks", async () => {
    const secret = "PRIVATE-UPSTREAM-NOTE-BODY-9f3b";
    const wrongIdentity = createNotesnookLocalConflictObserver({
      notes: {
        conflicted: { ids: async () => ["requested-note"] },
        note: async () => ({ id: "different-note", title: "Wrong", conflicted: true }),
      },
    });
    await expect(wrongIdentity.listLocalConflicts()).rejects.toMatchObject({
      message: "local conflict note record identity does not match request",
    });

    const hostile = createNotesnookLocalConflictObserver({
      notes: {
        conflicted: { ids: async () => ["hostile-note"] },
        note: async () =>
          Object.defineProperty({ id: "hostile-note", conflicted: true, body: secret }, "title", {
            get() {
              throw new Error(secret);
            },
          }),
      },
    });
    const hostileError = await hostile.listLocalConflicts().catch((error: unknown) => error);
    expect(isNotesnookLocalConflictProjectionError(hostileError)).toBe(true);
    expect(String(hostileError)).not.toContain(secret);
    expect((hostileError as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((hostileError as Error & { __context__?: unknown }).__context__).toBeUndefined();

    const failing = createNotesnookLocalConflictObserver({
      notes: {
        conflicted: { ids: async () => ["failing-note"] },
        note: async () => {
          throw new Error(secret);
        },
      },
    });
    const failure = await failing.listLocalConflicts().catch((error: unknown) => error);
    expect(isNotesnookLocalConflictProjectionError(failure)).toBe(true);
    expect(String(failure)).not.toContain(secret);
  });

  it("rejects malformed marker and date fields without reading note bodies", async () => {
    const malformedMarker = createNotesnookLocalConflictObserver({
      notes: {
        conflicted: { ids: async () => ["marker-note"] },
        note: async () => ({ id: "marker-note", title: "Marker", conflicted: "yes" }),
      },
    });
    await expect(malformedMarker.listLocalConflicts()).rejects.toMatchObject({
      message: "local conflict note marker is malformed",
    });

    const malformedDate = createNotesnookLocalConflictObserver({
      notes: {
        conflicted: { ids: async () => ["date-note"] },
        note: async () => ({ id: "date-note", title: "Date", conflicted: true, dateEdited: NaN }),
      },
    });
    await expect(malformedDate.listLocalConflicts()).rejects.toMatchObject({
      message: "local conflict note date is malformed",
    });
  });

  it("rejects hostile source and selector access categorically", async () => {
    const hostileSource = {
      get notes(): never {
        throw new Error("PRIVATE-SOURCE-DETAIL");
      },
    } as unknown as NotesnookLocalConflictSource;
    expect(() => createNotesnookLocalConflictObserver(hostileSource)).toThrow(
      "local conflict notes slot is unavailable",
    );

    const hostileSelector = {
      notes: {
        conflicted: {
          get ids(): never {
            throw new Error("PRIVATE-SELECTOR-DETAIL");
          },
        },
        note: async () => undefined,
      },
    } as unknown as NotesnookLocalConflictSource;
    expect(() => createNotesnookLocalConflictObserver(hostileSelector)).toThrow(
      "local conflict selector ids is unavailable",
    );
  });

  it("rejects a selector that does not return the pinned asynchronous id result", async () => {
    const observer = createNotesnookLocalConflictObserver({
      notes: {
        conflicted: { ids: () => ["sync-id"] as unknown as PromiseLike<unknown> },
        note: async (id: string) => ({ id, title: id, conflicted: true }),
      },
    });

    await expect(observer.listLocalConflicts()).rejects.toMatchObject({
      message: "local conflict selector ids call rejected",
    });
  });

  it("rejects a selector result beyond the bounded list size", async () => {
    const observer = createNotesnookLocalConflictObserver({
      notes: {
        conflicted: {
          ids: async () => Array.from({ length: 257 }, (_, index) => `note-${index}`),
        },
        note: async (id: string) => ({ id, title: id, conflicted: true }),
      },
    });

    await expect(observer.listLocalConflicts()).rejects.toMatchObject({
      message: "local conflict selector ids result",
    });
  });
});
