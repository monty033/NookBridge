/**
 * R5 — limits pushed into the source query (P1-5a follow-up).
 *
 * Upstream owners, per the pinned `@notesnook/core@8.1.3` `dist/index.d.ts`:
 *
 *   - `items(limit?)` and `sorted(limit?)` → `SearchResults<T>` (type alias,
 *     `index.d.ts:1443-1447`).  `ids()` on the same type takes no limit.
 *   - `limit(n): this` → `FilteredSelector<T>` (`index.d.ts:1083`).
 *     Runtime note: `FilteredSelector.ids()` does not read the stored limit;
 *     only `items()` applies it.  The notes.all / notebooks.all paths therefore
 *     keep `ids()` plus truncation.
 *   - `resolve(limit?)` → `RelationsArray` (`index.d.ts:1898`), not used by the
 *     projection.
 *
 * The search seam asks `SearchResults.items(cap + 1)`.  Receiving `cap + 1`
 * records is how an overflow is detected, so the same semantics hold.
 */

import { describe, expect, it } from "vitest";

import {
  flattenLiveDatabaseToReadOnly,
  isNotesnookReadOnlyProjectionError,
} from "../src/core/notesnook-readonly-projection.js";

const CAP = 256;

interface ResultSpy {
  idsCalls: number;
  itemsLimits: Array<number | undefined>;
}

function newResultSpy(): ResultSpy {
  return { idsCalls: 0, itemsLimits: [] };
}

/** A `SearchResults` fake exposing spied `ids()` and `items(limit)`. */
function spiedResults(matchIds: readonly string[], spy: ResultSpy): object {
  return {
    ids: async () => {
      spy.idsCalls += 1;
      return [...matchIds];
    },
    items: async (limit?: number) => {
      spy.itemsLimits.push(limit);
      return matchIds.slice(0, limit).map((id) => ({ id, title: `title-${id}` }));
    },
  };
}

/** Older-fake `SearchResults` with `ids()` only (no `items`). */
function idsOnlyResults(matchIds: readonly string[]): object {
  return { ids: async () => [...matchIds] };
}

interface FetchSpy {
  noteFetches: number;
  notebookFetches: number;
}

function makeSearchDatabase(options: {
  readonly noteResults: object;
  readonly notebookResults: object;
  readonly fetches: FetchSpy;
}): object {
  return {
    notes: {
      all: { ids: async () => [] },
      note: async (id: string) => {
        options.fetches.noteFetches += 1;
        return { id, title: `title-${id}` };
      },
    },
    notebooks: {
      all: { ids: async () => [] },
      notebook: async (id: string) => {
        options.fetches.notebookFetches += 1;
        return { id, title: `title-${id}` };
      },
    },
    lookup: {
      notes: () => options.noteResults,
      notebooks: () => options.notebookResults,
    },
    content: { findByNoteId: async () => null },
    syncer: { start: async () => true },
    lastSynced: async () => 0,
    hasUnsyncedChanges: async () => false,
  };
}

function makeIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}

describe("R5 — limits pushed into the source query", () => {
  it("search: 100k note matches asks items(257) once, never ids(), and caps hits", async () => {
    const noteSpy = newResultSpy();
    const notebookSpy = newResultSpy();
    const fetches: FetchSpy = { noteFetches: 0, notebookFetches: 0 };
    const database = makeSearchDatabase({
      noteResults: spiedResults(makeIds("note", 100_000), noteSpy),
      notebookResults: spiedResults([], notebookSpy),
      fetches,
    });
    const projection = flattenLiveDatabaseToReadOnly(database as never);

    const hits = (await projection.search!("x")) as ReadonlyArray<{ readonly source: string }>;

    expect(noteSpy.itemsLimits).toEqual([CAP + 1]);
    expect(noteSpy.idsCalls).toBe(0);
    expect(fetches.noteFetches).toBeLessThanOrEqual(CAP);
    expect(hits.length).toBeLessThanOrEqual(CAP);
    expect(hits.length).toBe(CAP);
  });

  it("search: 100k notebook matches asks items(257) once, never ids(), and caps hits", async () => {
    const noteSpy = newResultSpy();
    const notebookSpy = newResultSpy();
    const fetches: FetchSpy = { noteFetches: 0, notebookFetches: 0 };
    const database = makeSearchDatabase({
      noteResults: spiedResults([], noteSpy),
      notebookResults: spiedResults(makeIds("nb", 100_000), notebookSpy),
      fetches,
    });
    const projection = flattenLiveDatabaseToReadOnly(database as never);

    const hits = (await projection.search!("x")) as ReadonlyArray<{ readonly source: string }>;

    expect(notebookSpy.itemsLimits).toEqual([CAP + 1]);
    expect(notebookSpy.idsCalls).toBe(0);
    expect(fetches.notebookFetches).toBeLessThanOrEqual(CAP);
    expect(hits.length).toBe(CAP);
    for (const hit of hits) {
      expect(hit.source).toBe("notebook");
    }
  });

  it("findNotesByTitle: more than 256 matches still throws, using items(257)", async () => {
    const noteSpy = newResultSpy();
    const fetches: FetchSpy = { noteFetches: 0, notebookFetches: 0 };
    const database = makeSearchDatabase({
      noteResults: spiedResults(makeIds("note", 300), noteSpy),
      notebookResults: spiedResults([], newResultSpy()),
      fetches,
    });
    const projection = flattenLiveDatabaseToReadOnly(database as never);

    await expect(projection.findNotesByTitle!("x")).rejects.toThrow(
      "title candidate set is too large",
    );
    expect(noteSpy.itemsLimits).toEqual([CAP + 1]);
    expect(noteSpy.idsCalls).toBe(0);
    expect(fetches.noteFetches).toBe(0);
  });

  it("findNotesByTitle: exactly 256 matches is still accepted", async () => {
    const noteSpy = newResultSpy();
    const fetches: FetchSpy = { noteFetches: 0, notebookFetches: 0 };
    const database = makeSearchDatabase({
      noteResults: spiedResults(makeIds("note", CAP), noteSpy),
      notebookResults: spiedResults([], newResultSpy()),
      fetches,
    });
    const projection = flattenLiveDatabaseToReadOnly(database as never);

    const notes = await projection.findNotesByTitle!("x");

    expect(notes).toHaveLength(CAP);
    expect(noteSpy.itemsLimits).toEqual([CAP + 1]);
  });

  // Skipped: `FilteredSelector.limit(n)` is declared in the d.ts, but in
  // `@notesnook/core@8.1.3` `ids()` never reads the stored `_limit` (only
  // `items()` does).  So the step-3 condition ("a selector whose ids() respects
  // the limit") does not hold and `notes.all` keeps `ids()` plus truncation.
  // The body states the intended contract for if upstream fixes `ids()`.
  it.skip("listNotes: notes.all.limit(257) is used and unlimited ids() is not called (no upstream limit for notes.all: ids() ignores limit in @notesnook/core@8.1.3)", async () => {
    const limits: number[] = [];
    let unlimitedIdsCalls = 0;
    const notesAll = {
      ids: async () => {
        unlimitedIdsCalls += 1;
        return makeIds("note", 1_000);
      },
      limit(n: number) {
        limits.push(n);
        return {
          ids: async () => makeIds("note", n),
        };
      },
    };
    const database = {
      notes: {
        all: notesAll,
        note: async (id: string) => ({ id, title: `title-${id}` }),
      },
      notebooks: { all: { ids: async () => [] }, notebook: async () => null },
      lookup: { notes: () => idsOnlyResults([]), notebooks: () => idsOnlyResults([]) },
      content: { findByNoteId: async () => null },
      syncer: { start: async () => true },
      lastSynced: async () => 0,
      hasUnsyncedChanges: async () => false,
    };
    const projection = flattenLiveDatabaseToReadOnly(database as never);

    const notes = (await projection.listNotes()) as ReadonlyArray<unknown>;

    expect(limits).toEqual([CAP + 1]);
    expect(unlimitedIdsCalls).toBe(0);
    expect(notes.length).toBe(CAP);
  });

  it("strict hierarchy: 300 notebooks still fail closed before any per-id read", async () => {
    const fetches = { notebookFetches: 0 };
    const database = makeHierarchyDatabase(makeIds("nb", 300), fetches);
    const projection = flattenLiveDatabaseToReadOnly(database as never);

    await expect(projection.listNotebooksWithParentsStrict!()).rejects.toThrow(
      "notebook hierarchy is too large",
    );
    expect(fetches.notebookFetches).toBe(0);
  });

  it("strict hierarchy: 10 notebooks are all returned", async () => {
    const fetches = { notebookFetches: 0 };
    const database = makeHierarchyDatabase(makeIds("nb", 10), fetches);
    const projection = flattenLiveDatabaseToReadOnly(database as never);

    const notebooks = (await projection.listNotebooksWithParentsStrict!()) as ReadonlyArray<{
      readonly id: string;
    }>;

    expect(notebooks.map((nb) => nb.id)).toEqual(makeIds("nb", 10));
  });

  it("fallback: lookup results without items() keep ids() plus truncation", async () => {
    const database = makeSearchDatabase({
      noteResults: idsOnlyResults(makeIds("note", 300)),
      notebookResults: idsOnlyResults([]),
      fetches: { noteFetches: 0, notebookFetches: 0 },
    });
    const projection = flattenLiveDatabaseToReadOnly(database as never);

    const hits = (await projection.search!("x")) as ReadonlyArray<unknown>;

    expect(hits.length).toBe(CAP);
  });

  it("fallback: findNotesByTitle without items() still throws above the cap", async () => {
    const database = makeSearchDatabase({
      noteResults: idsOnlyResults(makeIds("note", 300)),
      notebookResults: idsOnlyResults([]),
      fetches: { noteFetches: 0, notebookFetches: 0 },
    });
    const projection = flattenLiveDatabaseToReadOnly(database as never);

    await expect(projection.findNotesByTitle!("x")).rejects.toThrow(
      "title candidate set is too large",
    );
  });

  describe("hostile items() results", () => {
    const hostileCases: Array<[string, () => object]> = [
      ["a non-array result", () => ({ ids: async () => [], items: async () => ({ length: 1 }) })],
      [
        "an id-less record",
        () => ({ ids: async () => [], items: async () => [{ title: "no id here" }] }),
      ],
      [
        "a rejection",
        () => ({
          ids: async () => [],
          items: () => Promise.reject(new Error("upstream detail /secret/path")),
        }),
      ],
    ];
    const seams: Array<[string, (p: ReturnType<typeof flattenLiveDatabaseToReadOnly>) => unknown]> =
      [
        ["search", (p) => p.search!("x")],
        ["findNotesByTitle", (p) => p.findNotesByTitle!("x")],
      ];

    for (const [seamLabel, run] of seams) {
      for (const [caseLabel, makeResults] of hostileCases) {
        it(`${seamLabel} rejects with a categorical projectionError on ${caseLabel}`, async () => {
          const database = makeSearchDatabase({
            noteResults: makeResults(),
            notebookResults: idsOnlyResults([]),
            fetches: { noteFetches: 0, notebookFetches: 0 },
          });
          const projection = flattenLiveDatabaseToReadOnly(database as never);

          const error = await Promise.resolve()
            .then(() => run(projection))
            .then(
              () => undefined,
              (caught: unknown) => caught,
            );

          expect(isNotesnookReadOnlyProjectionError(error)).toBe(true);
          expect(String(error)).not.toContain("secret");
        });
      }
    }
  });
});

function makeHierarchyDatabase(
  notebookIds: readonly string[],
  fetches: { notebookFetches: number },
) {
  return {
    notes: { all: { ids: async () => [] }, note: async () => null },
    notebooks: {
      all: { ids: async () => [...notebookIds] },
      notebook: async (id: string) => {
        fetches.notebookFetches += 1;
        return { id, title: `title-${id}` };
      },
      breadcrumbs: async (id: string) => [{ id, title: `title-${id}` }],
    },
    lookup: { notes: () => idsOnlyResults([]), notebooks: () => idsOnlyResults([]) },
    content: { findByNoteId: async () => null },
    syncer: { start: async () => true },
    lastSynced: async () => 0,
    hasUnsyncedChanges: async () => false,
  };
}
