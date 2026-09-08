/**
 * PR-65 P1-5a — read-side corpus bounds.
 *
 * The bounded structural seam does not expose a query with a limit, so
 * the source returns every match.  The projection slices the id list
 * to the published cap so a large corpus cannot drive an unbounded
 * number of follow-up `notes.note(id)` / `notebooks.notebook(id)`
 * calls.  These tests cover the cap behaviour for `search`,
 * `listNotes`, and `listNotebooks`.
 */

import { describe, expect, it } from "vitest";

import { flattenLiveDatabaseToReadOnly } from "../src/core/notesnook-readonly-projection.js";

interface FakeRecord {
  readonly id: string;
  readonly title: string;
}

function makeDatabase(opts: {
  readonly noteIds?: readonly string[];
  readonly notebookIds?: readonly string[];
  readonly noteTitle?: (id: string) => string;
  readonly notebookTitle?: (id: string) => string;
}): object {
  const noteIds = opts.noteIds ?? [];
  const notebookIds = opts.notebookIds ?? [];
  const notes = new Map<string, FakeRecord>();
  for (const id of noteIds) {
    notes.set(id, {
      id,
      title: opts.noteTitle?.(id) ?? `note-${id}`,
    });
  }
  const notebooks = new Map<string, FakeRecord>();
  for (const id of notebookIds) {
    notebooks.set(id, {
      id,
      title: opts.notebookTitle?.(id) ?? `notebook-${id}`,
    });
  }
  return {
    notes: {
      all: {
        ids: async () => [...noteIds],
      },
      note: async (id: string) => notes.get(id) ?? null,
    },
    notebooks: {
      all: {
        ids: async () => [...notebookIds],
      },
      notebook: async (id: string) => notebooks.get(id) ?? null,
    },
    lookup: {
      notes: async () => ({
        ids: async () => [...noteIds],
      }),
      notebooks: async () => ({
        ids: async () => [...notebookIds],
      }),
    },
    content: {
      findByNoteId: async () => null,
    },
    syncer: {
      start: async () => true,
    },
    lastSynced: async () => 0,
    hasUnsyncedChanges: async () => false,
  };
}

describe("PR-65 P1-5a — read-side corpus bound", () => {
  it("truncates search hits at the published cap (notes path)", async () => {
    const ids = Array.from({ length: 1_000 }, (_, i) => `note-${i}`);
    const database = makeDatabase({ noteIds: ids });
    const projection = flattenLiveDatabaseToReadOnly(database as never);
    const results = (await projection.search("x")) as ReadonlyArray<{
      readonly id: string;
    }>;
    expect(results.length).toBeLessThanOrEqual(256);
    // The cap is hard — exactly 256 hits even though the source had 1000.
    expect(results.length).toBe(256);
  });

  it("truncates search hits at the published cap (notebooks path)", async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `nb-${i}`);
    const database = makeDatabase({ notebookIds: ids });
    const projection = flattenLiveDatabaseToReadOnly(database as never);
    const results = (await projection.search("x")) as ReadonlyArray<{
      readonly source: "notebook";
    }>;
    expect(results.length).toBeLessThanOrEqual(256);
    for (const hit of results) {
      expect(hit.source).toBe("notebook");
    }
  });

  it("does not pad when the source returns fewer than the cap", async () => {
    const database = makeDatabase({ noteIds: ["note-1", "note-2", "note-3"] });
    const projection = flattenLiveDatabaseToReadOnly(database as never);
    const results = (await projection.search("x")) as ReadonlyArray<{
      readonly id: string;
    }>;
    expect(results.length).toBe(3);
  });

  it("truncates listNotes at the published cap", async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `note-${i}`);
    const database = makeDatabase({ noteIds: ids });
    const projection = flattenLiveDatabaseToReadOnly(database as never);
    const results = (await projection.listNotes()) as ReadonlyArray<unknown>;
    expect(results.length).toBe(256);
  });

  it("truncates listNotebooks at the published cap", async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `nb-${i}`);
    const database = makeDatabase({ notebookIds: ids });
    const projection = flattenLiveDatabaseToReadOnly(database as never);
    const results = (await projection.listNotebooks()) as ReadonlyArray<unknown>;
    expect(results.length).toBe(256);
  });

  it("does not call notes.note(id) for truncated IDs", async () => {
    let noteCallCount = 0;
    const ids = Array.from({ length: 1_000 }, (_, i) => `note-${i}`);
    const database = {
      notes: {
        all: { ids: async () => [...ids] },
        note: async () => {
          noteCallCount += 1;
          return null;
        },
      },
      notebooks: {
        all: { ids: async () => [] },
        notebook: async () => null,
      },
      lookup: {
        notes: async () => ({ ids: async () => [...ids] }),
        notebooks: async () => ({ ids: async () => [] }),
      },
      content: { findByNoteId: async () => null },
      syncer: { start: async () => true },
      lastSynced: async () => 0,
      hasUnsyncedChanges: async () => false,
    };
    const projection = flattenLiveDatabaseToReadOnly(database as never);
    await projection.search("x");
    // Bound: 256 hits, but many `note()` calls would have been made
    // without the cap.  Assert the cap is honored.
    expect(noteCallCount).toBeLessThanOrEqual(256);
  });
});
