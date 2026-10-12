import { describe, expect, it } from "vitest";

import {
  createDiscoveryVisibility,
  DISCOVERY_MAX_MEMBERSHIP_ENTRIES,
} from "../src/service/discovery-visibility.js";
import type { DiscoverySource } from "../src/service/discovery-visibility.js";
import { buildNotebookIndex } from "../src/settings/notebook-index.js";
import { createSettingsEvaluator } from "../src/settings/settings-evaluator.js";
import type { SettingsFile } from "../src/settings/settings-types.js";

const NOTEBOOKS = [
  { id: "nb-pub", title: "Public" },
  { id: "nb-priv", title: "Private" },
];

// notebook membership: note id -> notebook id
const MEMBERSHIP: Record<string, string> = {
  "n-pub": "nb-pub",
  "n-priv": "nb-priv",
  "n-locked": "nb-pub",
  "n-secret-title": "nb-pub",
  "n-throws": "nb-pub",
};

const NOTE_TITLES: Record<string, string> = {
  "n-pub": "Shopping",
  "n-priv": "Diary",
  "n-locked": "Locked Plans",
  "n-secret-title": "Secret",
  "n-throws": "Throws",
  "n-root": "Loose",
};

const allowPublic: SettingsFile = {
  version: 1,
  defaults: { read: false, edit: false, create: false, delete: false },
  overrides: [{ notebooks: ["Public"], read: true }],
};

function source(overrides: Partial<DiscoverySource> = {}): DiscoverySource {
  const base: DiscoverySource = {
    search: async () => [
      { id: "n-pub", title: "Shopping", source: "note" },
      { id: "n-priv", title: "Diary", source: "note" },
      { id: "n-locked", title: "Locked Plans", source: "note" },
      { id: "nb-pub", title: "Public", source: "notebook" },
      { id: "nb-priv", title: "Private", source: "notebook" },
    ],
    listNotes: async () =>
      Object.keys(NOTE_TITLES).map((id) => ({ id, title: NOTE_TITLES[id] as string })),
    findNoteIdsByNotebook: async (notebookId) =>
      Object.keys(MEMBERSHIP).filter((noteId) => MEMBERSHIP[noteId] === notebookId),
    noteMetadata: async (id) => {
      if (id === "n-root") return { title: NOTE_TITLES[id], notebookAbsenceConfirmed: true };
      return { title: NOTE_TITLES[id], notebookId: MEMBERSHIP[id] };
    },
    readNoteLockState: async (id) => (id === "n-locked" ? "locked" : "unlocked"),
    ...overrides,
  };
  // Direct-holder proof for the normal positive fixtures: they are
  // non-recursive, so a note's direct holders are exactly the notebooks that
  // list it.  Recursive fixtures pass their own `hasNoteInNotebook`.
  const claims = base.findNoteIdsByNotebook;
  const fixtureProbe: DiscoverySource["hasNoteInNotebook"] = async (notebookId, noteId) =>
    (await claims?.(notebookId))?.includes(noteId) === true;
  return { hasNoteInNotebook: fixtureProbe, ...base };
}

type DirectProbe = NonNullable<DiscoverySource["hasNoteInNotebook"]>;
type HierarchyFetch = () => Promise<ReadonlyArray<unknown>>;
/** A fixed hierarchy, a custom fetch, or null for "no hierarchy source". */
type Hierarchy = ReadonlyArray<unknown> | HierarchyFetch | null;

/**
 * `listNotebooksForSettings` is the only notebook source: one fresh snapshot
 * per request supplies paths, ancestry and the membership notebook list.  By
 * default it mirrors the fixture hierarchy; pass `null` to model no source.
 */
function visibility(
  settings: SettingsFile,
  src: DiscoverySource = source(),
  hierarchy: Hierarchy = NOTEBOOKS,
) {
  const index = bootIndex();
  const fetchHierarchy: HierarchyFetch | undefined =
    hierarchy === null
      ? undefined
      : typeof hierarchy === "function"
        ? hierarchy
        : async () => hierarchy;
  return createDiscoveryVisibility({
    source: src,
    ...(fetchHierarchy === undefined ? {} : { listNotebooksForSettings: fetchHierarchy }),
    settingsEvaluator: createSettingsEvaluator(settings, index),
  });
}

function bootIndex() {
  return buildNotebookIndex(NOTEBOOKS);
}

describe("discovery visibility — notes.search / operator search", () => {
  it("keeps an unlocked note in an allowed notebook", async () => {
    const hits = await visibility(allowPublic).searchHits("a");
    expect(hits.map((h) => h.id)).toContain("n-pub");
  });

  it("drops a note in a denied notebook", async () => {
    const hits = await visibility(allowPublic).searchHits("a");
    expect(hits.map((h) => h.id)).not.toContain("n-priv");
  });

  it("drops a locked note, including its title", async () => {
    const hits = await visibility(allowPublic).searchHits("a");
    expect(hits.map((h) => h.id)).not.toContain("n-locked");
    expect(JSON.stringify(hits)).not.toContain("Locked Plans");
  });

  it("drops a note whose lock state read throws (fail closed)", async () => {
    const src = source({
      search: async () => [{ id: "n-throws", title: "Throws", source: "note" }],
      readNoteLockState: async () => {
        throw new Error("lock backend down");
      },
    });
    expect(await visibility(allowPublic, src).searchHits("t")).toEqual([]);
  });

  it("drops a note whose lock state is not exactly unlocked", async () => {
    const src = source({
      search: async () => [{ id: "n-pub", title: "Shopping", source: "note" }],
      readNoteLockState: async () => "unknown" as unknown as "unlocked",
    });
    expect(await visibility(allowPublic, src).searchHits("s")).toEqual([]);
  });

  it("drops a notebook hit for a denied notebook and keeps an allowed one", async () => {
    const hits = await visibility(allowPublic).searchHits("a");
    const ids = hits.map((h) => h.id);
    expect(ids).toContain("nb-pub");
    expect(ids).not.toContain("nb-priv");
  });

  it("applies a note-title override that denies a specific note in an allowed notebook", async () => {
    const settings: SettingsFile = {
      version: 1,
      defaults: { read: false, edit: false, create: false, delete: false },
      overrides: [
        { notebooks: ["Public"], read: true },
        { notes: ["Public/Secret"], read: false },
      ],
    };
    const hits = await visibility(settings).searchHits("s");
    const ids = hits.map((h) => h.id);
    expect(ids).not.toContain("n-secret-title");
  });

  it("drops a note with an unresolvable notebook and no absence confirmation", async () => {
    const src = source({
      search: async () => [{ id: "n-orphan", title: "Orphan", source: "note" }],
      listNotes: async () => [{ id: "n-orphan", title: "Orphan" }],
      findNoteIdsByNotebook: async () => [],
      noteMetadata: async () => ({ title: "Orphan" }),
    });
    expect(await visibility(allowPublic, src).searchHits("o")).toEqual([]);
  });

  it("hides the affected note when the settings evaluator throws", async () => {
    const realEvaluator = createSettingsEvaluator(allowPublic, bootIndex());
    const vis = createDiscoveryVisibility({
      source: source(),
      listNotebooksForSettings: async () => NOTEBOOKS,
      settingsEvaluator: ((action, context) => {
        if (context.noteTitle === "Shopping") throw new Error("policy evaluator unavailable");
        return realEvaluator(action, context);
      }) as ReturnType<typeof createSettingsEvaluator>,
    });
    const hits = await vis.searchHits("a");
    expect(hits.map((hit) => hit.id)).not.toContain("n-pub");
    expect(hits.map((hit) => hit.id)).toContain("nb-pub");
  });

  it("fails the whole request closed when validated hierarchy exceeds the work cap", async () => {
    let membershipCalls = 0;
    const manyNotebooks = Array.from({ length: 10_001 }, (_, i) => ({
      id: `nb-${i}`,
      title: `Notebook ${i}`,
    }));
    const src = source({
      findNoteIdsByNotebook: async () => {
        membershipCalls += 1;
        return [];
      },
    });
    expect(await visibility(allowPublic, src, manyNotebooks).searchHits("a")).toEqual([]);
    expect(membershipCalls).toBe(0);
  });

  it("fails the whole request closed when recursive membership exceeds the work cap", async () => {
    let directProbeCalls = 0;
    const oversizedMembership = Array.from(
      { length: DISCOVERY_MAX_MEMBERSHIP_ENTRIES + 1 },
      (_, i) => `note-${i}`,
    );
    const src = source({
      findNoteIdsByNotebook: async () => oversizedMembership,
      hasNoteInNotebook: async () => {
        directProbeCalls += 1;
        return true;
      },
    });
    expect(await visibility(allowPublic, src).searchHits("a")).toEqual([]);
    expect(directProbeCalls).toBe(0);
  });

  it("returns nothing when the membership source fails (fail closed, never unfiltered)", async () => {
    const src = source({
      findNoteIdsByNotebook: async () => {
        throw new Error("notebooks.notes refused");
      },
    });
    expect(await visibility(allowPublic, src).searchHits("a")).toEqual([]);
  });

  it("returns nothing when the membership source is absent", async () => {
    const { findNoteIdsByNotebook: _omitted, ...withoutMembership } = source();
    expect(await visibility(allowPublic, withoutMembership).searchHits("a")).toEqual([]);
  });

  it("requires a non-empty query", async () => {
    await expect(visibility(allowPublic).searchHits("")).rejects.toThrow();
  });

  it("returns a root note through searchHits only with own confirmation and allowing root policy", async () => {
    const withRoot: SettingsFile = {
      version: 1,
      defaults: { read: false, edit: false, create: false, delete: false },
      overrides: [{ notebooks: ["<root>"], read: true }],
    };
    const rootSource = (metadata: unknown) =>
      source({
        search: async () => [{ id: "n-root", title: "Loose", source: "note" }],
        listNotes: async () => [{ id: "n-root", title: "Loose" }],
        findNoteIdsByNotebook: async () => [],
        noteMetadata: async () => metadata,
      });
    expect(
      await visibility(withRoot, rootSource({ notebookAbsenceConfirmed: true })).searchHits("l"),
    ).toEqual([{ id: "n-root", title: "Loose", source: "note" }]);
    // Denied root policy.
    expect(
      (
        await visibility(allowPublic, rootSource({ notebookAbsenceConfirmed: true })).searchHits(
          "l",
        )
      ).map((h) => h.id),
    ).not.toContain("n-root");
    // Confirmation absent.
    expect(
      (await visibility(withRoot, rootSource({ title: "Loose" })).searchHits("l")).map((h) => h.id),
    ).not.toContain("n-root");
    // Confirmation present but false.
    expect(
      (
        await visibility(withRoot, rootSource({ notebookAbsenceConfirmed: false })).searchHits("l")
      ).map((h) => h.id),
    ).not.toContain("n-root");
  });

  it("looks up each notebook's notes at most once per request", async () => {
    let calls = 0;
    const src = source({
      findNoteIdsByNotebook: async (notebookId) => {
        calls += 1;
        return Object.keys(MEMBERSHIP).filter((n) => MEMBERSHIP[n] === notebookId);
      },
      // Independent of the counted listing, so only membership lookups are counted.
      hasNoteInNotebook: async (notebookId, noteId) => MEMBERSHIP[noteId] === notebookId,
    });
    await visibility(allowPublic, src).searchHits("a");
    expect(calls).toBe(NOTEBOOKS.length);
  });
});

describe("discovery visibility — notes.list_notebooks / operator browse", () => {
  it("lists only allowed, unlocked notes", async () => {
    const notes = await visibility(allowPublic).listNotes();
    const ids = notes.map((n) => n.id);
    expect(ids).toContain("n-pub");
    expect(ids).not.toContain("n-priv");
    expect(ids).not.toContain("n-locked");
    expect(JSON.stringify(notes)).not.toContain("Locked Plans");
  });

  it("keeps a confirmed root note only when root read is allowed", async () => {
    const withRoot: SettingsFile = {
      version: 1,
      defaults: { read: false, edit: false, create: false, delete: false },
      overrides: [{ notebooks: ["<root>"], read: true }],
    };
    expect((await visibility(withRoot).listNotes()).map((n) => n.id)).toEqual(["n-root"]);
    expect(await visibility(allowPublic).listNotes()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "n-pub" })]),
    );
    expect((await visibility(allowPublic).listNotes()).map((n) => n.id)).not.toContain("n-root");
  });

  it("filters notebook summaries to readable notebooks", async () => {
    const kept = await visibility(allowPublic).filterNotebooks(NOTEBOOKS.map((n) => ({ ...n })));
    expect(kept.map((n) => n.id)).toEqual(["nb-pub"]);
  });
});

describe("discovery visibility — read-only audit fixes", () => {
  it("excludes a note claimed by more than one notebook, independent of enumeration order", async () => {
    const run = async (settings: SettingsFile, notebookOrder: ReadonlyArray<unknown>) => {
      const src = source({
        search: async () => [{ id: "n-ambiguous", title: "Ambiguous", source: "note" }],
        listNotes: async () => [{ id: "n-ambiguous", title: "Ambiguous" }],
        findNoteIdsByNotebook: async (notebookId) =>
          notebookId === "nb-pub" || notebookId === "nb-priv" ? ["n-ambiguous"] : [],
        noteMetadata: async () => ({ title: "Ambiguous", notebookId: "nb-pub" }),
      });
      return (await visibility(settings, src, notebookOrder).searchHits("a")).map((h) => h.id);
    };
    const pub = { id: "nb-pub", title: "Public" };
    const priv = { id: "nb-priv", title: "Private" };

    // The allowed notebook is listed first, so silently keeping the first
    // match would leak the note; order independence must still hide it.
    expect(await run(allowPublic, [pub, priv])).not.toContain("n-ambiguous");
    // The denying notebook is listed first, flipping the arbitrary choice.
    const denyPublic: SettingsFile = {
      version: 1,
      defaults: { read: false, edit: false, create: false, delete: false },
      overrides: [{ notebooks: ["Private"], read: true }],
    };
    expect(await run(denyPublic, [priv, pub])).not.toContain("n-ambiguous");
    expect(await run(denyPublic, [pub, priv])).not.toContain("n-ambiguous");
  });

  it("re-fetches the hierarchy on each request instead of reusing a stale snapshot", async () => {
    const titles = ["Public", "Private"];
    let fetches = 0;
    const src = source({
      search: async () => [{ id: "n-dyn", title: "Dyn", source: "note" }],
      listNotes: async () => [{ id: "n-dyn", title: "Dyn" }],
      findNoteIdsByNotebook: async () => ["n-dyn"],
      noteMetadata: async () => ({ title: "Dyn", notebookId: "nb-dyn" }),
    });
    const vis = visibility(allowPublic, src, async () => {
      const title = titles[Math.min(fetches, titles.length - 1)] as string;
      fetches += 1;
      return [{ id: "nb-dyn", title }];
    });

    // First request sees the allowed title; the same visibility instance's
    // second request must re-fetch and honour "Private".
    expect((await vis.searchHits("x")).map((h) => h.id)).toContain("n-dyn");
    expect((await vis.searchHits("x")).map((h) => h.id)).not.toContain("n-dyn");
    expect(fetches).toBe(2);
  });
});

describe("discovery visibility — the live hierarchy snapshot is the only authority (S2 HIGH)", () => {
  // `nb-pub` IS in the boot-time index (path "Public").  The live hierarchy is
  // the only source of truth: a move/rename must change the decision on the
  // very next request, and a missing/failed/absent live answer must hide,
  // never fall back to the stale boot-time path.
  const movable = () => {
    let liveTitle: string | undefined = "Public";
    const fetchHierarchy: HierarchyFetch = async () =>
      liveTitle === undefined ? [] : [{ id: "nb-pub", title: liveTitle }];
    return {
      fetchHierarchy,
      moveTo: (title: string | undefined) => {
        liveTitle = title;
      },
    };
  };
  const noteSource = () =>
    source({
      search: async () => [
        { id: "n-pub", title: "Shopping", source: "note" },
        { id: "nb-pub", title: "Public", source: "notebook" },
      ],
      listNotes: async () => [{ id: "n-pub", title: "Shopping" }],
      findNoteIdsByNotebook: async (notebookId) => (notebookId === "nb-pub" ? ["n-pub"] : []),
    });

  it("hides a known notebook's note and notebook hit once its live path becomes denied", async () => {
    const live = movable();
    const vis = visibility(allowPublic, noteSource(), live.fetchHierarchy);
    expect((await vis.searchHits("x")).map((h) => h.id)).toEqual(["n-pub", "nb-pub"]);

    live.moveTo("Private");
    const after = await vis.searchHits("x");
    expect(after).toEqual([]);
    expect(JSON.stringify(after)).not.toContain("Shopping");
    expect(JSON.stringify(after)).not.toContain('"Public"');
  });

  it("hides a known notebook's notes from listNotes once its live path becomes denied", async () => {
    const live = movable();
    const vis = visibility(allowPublic, noteSource(), live.fetchHierarchy);
    expect((await vis.listNotes()).map((n) => n.id)).toEqual(["n-pub"]);
    live.moveTo("Private");
    expect(await vis.listNotes()).toEqual([]);
  });

  it("drops a known notebook from filterNotebooks once its live path becomes denied", async () => {
    const live = movable();
    const vis = visibility(allowPublic, noteSource(), live.fetchHierarchy);
    expect((await vis.filterNotebooks([{ id: "nb-pub", title: "Public" }])).length).toBe(1);
    live.moveTo("Private");
    expect(await vis.filterNotebooks([{ id: "nb-pub", title: "Public" }])).toEqual([]);
  });

  it("hides a notebook that left the live hierarchy even though the boot index still has it", async () => {
    const live = movable();
    live.moveTo(undefined);
    const vis = visibility(allowPublic, noteSource(), live.fetchHierarchy);
    expect(await vis.searchHits("x")).toEqual([]);
    expect(await vis.listNotes()).toEqual([]);
    expect(await vis.filterNotebooks([{ id: "nb-pub", title: "Public" }])).toEqual([]);
  });

  it("fails closed when no hierarchy source is provided, even for boot-indexed notebooks", async () => {
    const vis = visibility(allowPublic, noteSource(), null);
    expect(await vis.searchHits("x")).toEqual([]);
    expect(await vis.listNotes()).toEqual([]);
    expect(await vis.filterNotebooks([{ id: "nb-pub", title: "Public" }])).toEqual([]);
  });

  it("does not remember a failed hierarchy fetch into the next request", async () => {
    let healthy = false;
    const vis = visibility(allowPublic, noteSource(), async () => {
      if (!healthy) throw new Error("transient");
      return [{ id: "nb-pub", title: "Public" }];
    });
    expect(await vis.listNotes()).toEqual([]);
    healthy = true;
    expect((await vis.listNotes()).map((n) => n.id)).toEqual(["n-pub"]);
  });

  it("fetches exactly one hierarchy snapshot per request, however many notebooks and hits", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `nb-${i}`, title: `Book${i}` }));
    const manyAllowed: SettingsFile = {
      version: 1,
      defaults: { read: true, edit: false, create: false, delete: false },
      overrides: [],
    };
    let fetches = 0;
    const src = source({
      search: async () => [
        ...many.map((nb) => ({
          id: `n-${nb.id}`,
          title: `Note ${nb.id}`,
          source: "note" as const,
        })),
        ...many.map((nb) => ({ id: nb.id, title: nb.title, source: "notebook" as const })),
      ],
      listNotes: async () => many.map((nb) => ({ id: `n-${nb.id}`, title: `Note ${nb.id}` })),
      findNoteIdsByNotebook: async (notebookId) => [`n-${notebookId}`],
    });
    const vis = visibility(manyAllowed, src, async () => {
      fetches += 1;
      return many;
    });

    expect((await vis.searchHits("q")).length).toBe(50);
    expect(fetches).toBe(1);
    expect((await vis.listNotes()).length).toBe(25);
    expect(fetches).toBe(2);
    expect((await vis.filterNotebooks(many)).length).toBe(25);
    expect(fetches).toBe(3);
  });
});

describe("discovery visibility — malformed or incomplete hierarchy fails closed", () => {
  const good = { id: "nb-pub", title: "Public" };
  const priv = { id: "nb-priv", title: "Private" };
  const inherited = Object.create({ id: "nb-inherited", title: "Public" }) as unknown;
  const cases: ReadonlyArray<[string, Hierarchy]> = [
    ["is not an array", (async () => ({ not: "an array" })) as unknown as HierarchyFetch],
    ["throws", async () => Promise.reject(new Error("hierarchy listing failed"))],
    ["references a missing parent", [good, { id: "nb-priv", title: "Private", parentId: "x" }]],
    [
      "contains a cycle",
      [
        { id: "nb-pub", title: "Public", parentId: "nb-priv" },
        { id: "nb-priv", title: "Private", parentId: "nb-pub" },
      ],
    ],
    ["contains a self-parent", [{ id: "nb-pub", title: "Public", parentId: "nb-pub" }, priv]],
    ["contains a duplicate id", [good, { id: "nb-pub", title: "Again" }, priv]],
    ["contains colliding paths", [good, { id: "nb-other", title: "public" }, priv]],
    ["contains a null record", [good, null, priv]],
    ["contains an empty id", [good, { id: "", title: "Empty" }, priv]],
    ["contains a non-string parentId", [good, { id: "nb-priv", title: "Private", parentId: 7 }]],
    ["contains an empty parentId", [good, { id: "nb-priv", title: "Private", parentId: "" }]],
    ["contains an invalid title", [good, { id: "nb-priv", title: "" }]],
    ["relies on an inherited id", [good, inherited, priv]],
  ];

  it.each(cases)("hides everything when the hierarchy %s", async (_label, hierarchy) => {
    const vis = visibility(allowPublic, source(), hierarchy);
    expect(await vis.searchHits("a")).toEqual([]);
    expect(await vis.listNotes()).toEqual([]);
    expect(await vis.filterNotebooks([good, priv])).toEqual([]);
  });

  it("does not consult the membership source when the hierarchy is invalid", async () => {
    let calls = 0;
    const src = source({
      findNoteIdsByNotebook: async () => {
        calls += 1;
        return [];
      },
    });
    await visibility(allowPublic, src, [{ id: "a", title: "A", parentId: "gone" }]).listNotes();
    expect(calls).toBe(0);
  });
});

describe("discovery visibility — recursive membership by parentId (S2 LOW)", () => {
  // Pinned @notesnook/core `notebooks.notes(id)` is RECURSIVE: a note in a
  // child notebook is also enumerated for every ancestor.  The deepest
  // claimant on ONE parentId chain governs; anything else stays ambiguous.
  // Ancestry comes from ids and parentIds, never from path-string prefixes.
  const TREE = [
    { id: "nb-parent", title: "Parent" },
    { id: "nb-child", title: "Child", parentId: "nb-parent" },
    { id: "nb-grand", title: "Grand", parentId: "nb-child" },
    { id: "nb-priv", title: "Private" },
  ];
  const TITLES: Record<string, string> = {
    "n-parent": "At Parent",
    "n-child": "At Child",
    "n-grand": "At Grand",
    "n-split": "Split",
  };
  // Recursive enumeration, exactly as the pinned core returns it.
  const RECURSIVE: Record<string, string[]> = {
    "nb-parent": ["n-parent", "n-child", "n-grand", "n-split"],
    "nb-child": ["n-child", "n-grand", "n-split"],
    "nb-grand": ["n-grand"],
    "nb-priv": ["n-split"],
  };
  // Where each note is DIRECTLY attached (the recursive map above is derived from it).
  const DIRECT: Record<string, string[]> = {
    "n-parent": ["nb-parent"],
    "n-child": ["nb-child"],
    "n-grand": ["nb-grand"],
    "n-split": ["nb-child", "nb-priv"],
  };
  const treeSource = (overrides: Partial<DiscoverySource> = {}) =>
    source({
      search: async () =>
        Object.keys(TITLES).map((id) => ({ id, title: TITLES[id] as string, source: "note" })),
      listNotes: async () => Object.keys(TITLES).map((id) => ({ id, title: TITLES[id] as string })),
      findNoteIdsByNotebook: async (notebookId) => RECURSIVE[notebookId] ?? [],
      noteMetadata: async () => ({ title: "x" }),
      hasNoteInNotebook: async (notebookId, noteId) =>
        DIRECT[noteId]?.includes(notebookId) === true,
      ...overrides,
    });
  // Snapshot order must not matter: children listed before their parents too.
  const ORDERS: Array<[Hierarchy]> = [[TREE], [[...TREE].reverse()]];
  const idsOf = async (settings: SettingsFile, order: Hierarchy, search: boolean) => {
    const vis = visibility(settings, treeSource(), order);
    return (search ? await vis.searchHits("q") : await vis.listNotes()).map((n) => n.id);
  };
  const policy = (overrides: SettingsFile["overrides"], read = false): SettingsFile => ({
    version: 1,
    defaults: { read, edit: false, create: false, delete: false },
    overrides,
  });

  it.each(ORDERS)("shows nested notes when the ancestor chain is allowed (%#)", async (order) => {
    const settings = policy([{ notebooks: ["Parent"], read: true }]);
    for (const search of [true, false]) {
      const ids = await idsOf(settings, order, search);
      expect(ids).toEqual(expect.arrayContaining(["n-parent", "n-child", "n-grand"]));
      // Claimed by the unrelated "Private" notebook as well: still ambiguous.
      expect(ids).not.toContain("n-split");
    }
  });

  it.each(ORDERS)("lets the deepest notebook's denial govern its note (%#)", async (order) => {
    const settings = policy([
      { notebooks: ["Parent"], read: true },
      { notebooks: ["Parent/Child"], read: false },
    ]);
    for (const search of [true, false]) {
      const ids = await idsOf(settings, order, search);
      expect(ids).toContain("n-parent");
      expect(ids).not.toContain("n-child");
      expect(ids).not.toContain("n-grand");
    }
  });

  it.each(ORDERS)("lets the deepest notebook's allowance govern its note (%#)", async (order) => {
    const settings = policy([{ notebooks: ["Parent/Child"], read: true }]);
    for (const search of [true, false]) {
      const ids = await idsOf(settings, order, search);
      expect(ids).not.toContain("n-parent");
      expect(ids).toEqual(expect.arrayContaining(["n-child", "n-grand"]));
    }
  });

  it("keeps a note claimed by unrelated notebooks hidden even when every claimant is allowed", async () => {
    const ids = await idsOf(policy([], true), TREE, true);
    expect(ids).not.toContain("n-split");
    expect(ids).toContain("n-child");
  });

  it("keeps a note hidden when claimed by unrelated roots 'Parent' and slash-named 'Parent/Child'", async () => {
    // String prefix would read these as an ancestor chain; the parentId graph
    // (both roots) says they are unrelated, even though policy permits both.
    const roots = [
      { id: "nb-parent", title: "Parent" },
      { id: "nb-slash", title: "Parent/Child" },
    ];
    for (const order of [roots, [...roots].reverse()]) {
      const src = source({
        search: async () => [{ id: "n-both", title: "Both", source: "note" }],
        listNotes: async () => [{ id: "n-both", title: "Both" }],
        findNoteIdsByNotebook: async () => ["n-both"],
        noteMetadata: async () => ({ title: "Both" }),
      });
      const vis = visibility(policy([], true), src, order);
      expect(await vis.searchHits("q")).toEqual([]);
      expect(await vis.listNotes()).toEqual([]);
    }
  });

  it("keeps a slash-named root notebook's own note visible when only it claims the note", async () => {
    const src = source({
      listNotes: async () => [{ id: "n-slash", title: "Only Slash" }],
      findNoteIdsByNotebook: async (id) => (id === "nb-slash" ? ["n-slash"] : []),
    });
    const vis = visibility(policy([], true), src, [
      { id: "nb-parent", title: "Parent" },
      { id: "nb-slash", title: "Parent/Child" },
    ]);
    expect((await vis.listNotes()).map((n) => n.id)).toEqual(["n-slash"]);
  });

  it("does not treat a same-titled sibling subtree as an ancestor chain", async () => {
    // Two different "Child" notebooks under unrelated parents are not ancestors
    // of each other, whatever their path strings look like.
    const forest = [
      { id: "nb-a", title: "A" },
      { id: "nb-b", title: "B" },
      { id: "nb-a-child", title: "Child", parentId: "nb-a" },
      { id: "nb-b-child", title: "Child", parentId: "nb-b" },
    ];
    const src = source({
      listNotes: async () => [{ id: "n-x", title: "X" }],
      findNoteIdsByNotebook: async (id) => (id.endsWith("-child") ? ["n-x"] : []),
    });
    expect(await visibility(policy([], true), src, forest).listNotes()).toEqual([]);
  });

  it("does not treat the same note enumerated twice for one notebook as ambiguous", async () => {
    const src = treeSource({
      findNoteIdsByNotebook: async (id) => (id === "nb-child" ? ["n-child", "n-child"] : []),
    });
    const vis = visibility(policy([{ notebooks: ["Parent"], read: true }]), src, TREE);
    expect((await vis.listNotes()).map((n) => n.id)).toContain("n-child");
  });

  describe("direct membership disambiguates recursive claims (hasNoteInNotebook)", () => {
    const parentDeniedChildAllowed = policy(
      [
        { notebooks: ["Parent"], read: false },
        { notebooks: ["Parent/Child"], read: true },
      ],
      false,
    );
    const parentAllowedChildDenied = policy(
      [
        { notebooks: ["Parent"], read: true },
        { notebooks: ["Parent/Child"], read: false },
      ],
      false,
    );
    const allAllowed = policy([], true);

    /** n-child is recursively claimed by nb-parent and nb-child (pinned core behaviour). */
    const nestedSource = (overrides: Partial<DiscoverySource> = {}) =>
      source({
        search: async () => [{ id: "n-child", title: "At Child", source: "note" }],
        listNotes: async () => [{ id: "n-child", title: "At Child" }],
        findNoteIdsByNotebook: async (id) =>
          id === "nb-parent" || id === "nb-child" ? ["n-child"] : [],
        noteMetadata: async () => ({ title: "At Child" }),
        ...overrides,
      });
    const directIn = (direct: ReadonlyArray<string>): DirectProbe => {
      return async (notebookId, noteId) => noteId === "n-child" && direct.includes(notebookId);
    };
    const visibleIds = async (
      settings: SettingsFile,
      src: DiscoverySource,
      hierarchy: Hierarchy = TREE,
    ) => {
      const vis = visibility(settings, src, hierarchy);
      return {
        search: (await vis.searchHits("q")).map((h) => h.id),
        list: (await vis.listNotes()).map((n) => n.id),
      };
    };

    it("(a) governs a note directly in only the child by the child's policy", async () => {
      const src = nestedSource({ hasNoteInNotebook: directIn(["nb-child"]) });
      const allowed = await visibleIds(parentDeniedChildAllowed, src);
      expect(allowed.search).toEqual(["n-child"]);
      expect(allowed.list).toEqual(["n-child"]);
      const denied = await visibleIds(parentAllowedChildDenied, src);
      expect(denied.search).toEqual([]);
      expect(denied.list).toEqual([]);
    });

    it("(a) governs a deep chain by the one notebook the note is directly in", async () => {
      const src = treeSource({
        search: async () => [{ id: "n-grand", title: "At Grand", source: "note" }],
        listNotes: async () => [{ id: "n-grand", title: "At Grand" }],
        hasNoteInNotebook: async (notebookId, noteId) =>
          noteId === "n-grand" && notebookId === "nb-grand",
      });
      const settings = policy([{ notebooks: ["Parent/Child/Grand"], read: true }]);
      expect((await visibility(settings, src, TREE).listNotes()).map((n) => n.id)).toEqual([
        "n-grand",
      ]);
    });

    it.each([
      ["child allowed, parent denied", parentDeniedChildAllowed],
      ["child allowed, parent allowed", allAllowed],
      ["child denied, parent allowed", parentAllowedChildDenied],
    ])("(b) hides a note directly in both parent and child (%s)", async (_label, settings) => {
      const src = nestedSource({ hasNoteInNotebook: directIn(["nb-parent", "nb-child"]) });
      const ids = await visibleIds(settings, src);
      expect(ids.search).toEqual([]);
      expect(ids.list).toEqual([]);
    });

    it("(b) hides a note whose direct holder is not the deepest claimant", async () => {
      // Recursive claims name the child, yet the probe only finds it in the parent.
      const src = nestedSource({ hasNoteInNotebook: directIn(["nb-parent"]) });
      const ids = await visibleIds(allAllowed, src);
      expect(ids.search).toEqual([]);
      expect(ids.list).toEqual([]);
    });

    it("(b) hides a note the probe finds in no claimant", async () => {
      const src = nestedSource({ hasNoteInNotebook: directIn([]) });
      const ids = await visibleIds(allAllowed, src);
      expect(ids.search).toEqual([]);
      expect(ids.list).toEqual([]);
    });

    it.each<[string, Partial<DiscoverySource> | "absent"]>([
      ["is unavailable", "absent"],
      [
        "throws",
        {
          hasNoteInNotebook: async () => {
            throw new Error("relations unavailable");
          },
        },
      ],
      [
        "throws for one claimant only",
        {
          hasNoteInNotebook: async (notebookId) => {
            if (notebookId === "nb-parent") throw new Error("relations unavailable");
            return notebookId === "nb-child";
          },
        },
      ],
      [
        "returns a non-boolean",
        {
          hasNoteInNotebook: (async () => "yes") as unknown as DirectProbe,
        },
      ],
    ])("(c) fails closed for a multi-claimant note when the direct probe %s", async (_l, mode) => {
      const base = nestedSource(mode === "absent" ? {} : mode);
      const { hasNoteInNotebook: _omitted, ...withoutProbe } = base;
      const src = mode === "absent" ? withoutProbe : base;
      const ids = await visibleIds(allAllowed, src);
      expect(ids.search).toEqual([]);
      expect(ids.list).toEqual([]);
    });

    describe("a single recursive claimant still needs direct-holder proof", () => {
      // Production `listNotebooksWithParents` can return root-only summaries when
      // breadcrumbs fail, so the hierarchy may omit a child notebook while the
      // known ancestor's recursive listing still claims the child's note.
      const ancestorOnly = [{ id: "nb-parent", title: "Parent" }];
      const leafSource = (overrides: Partial<DiscoverySource> = {}) =>
        source({
          search: async () => [{ id: "n-child", title: "At Child", source: "note" }],
          listNotes: async () => [{ id: "n-child", title: "At Child" }],
          findNoteIdsByNotebook: async (id) => (id === "nb-parent" ? ["n-child"] : []),
          noteMetadata: async () => ({ title: "At Child" }),
          ...overrides,
        });
      const parentAllowed = policy([{ notebooks: ["Parent"], read: true }]);
      const run = async (src: DiscoverySource) => {
        const vis = visibility(parentAllowed, src, ancestorOnly);
        return {
          search: (await vis.searchHits("q")).map((h) => h.id),
          list: (await vis.listNotes()).map((n) => n.id),
        };
      };

      it("shows the note when the probe confirms the sole claimant is the direct holder", async () => {
        const out = await run(leafSource({ hasNoteInNotebook: directIn(["nb-parent"]) }));
        expect(out).toEqual({ search: ["n-child"], list: ["n-child"] });
      });

      it("hides the note when the ancestor claimant is not the direct holder (child omitted)", async () => {
        // Direct holder is the omitted child notebook, so the probe says no.
        const out = await run(leafSource({ hasNoteInNotebook: directIn(["nb-omitted-child"]) }));
        expect(out).toEqual({ search: [], list: [] });
      });

      it.each<[string, Partial<DiscoverySource> | "absent"]>([
        ["is unavailable", "absent"],
        [
          "throws",
          {
            hasNoteInNotebook: async () => {
              throw new Error("relations unavailable");
            },
          },
        ],
        ["returns a non-boolean", { hasNoteInNotebook: (async () => 1) as unknown as DirectProbe }],
        [
          "returns undefined",
          { hasNoteInNotebook: (async () => undefined) as unknown as DirectProbe },
        ],
      ])("hides the note when the direct probe %s", async (_label, mode) => {
        const base = leafSource(mode === "absent" ? {} : mode);
        const { hasNoteInNotebook: _omitted, ...withoutProbe } = base;
        const out = await run(mode === "absent" ? withoutProbe : base);
        expect(out).toEqual({ search: [], list: [] });
      });

      it("probes the sole claimant by ids, never by path, once per request", async () => {
        const calls: Array<[string, string]> = [];
        const src = leafSource({
          hasNoteInNotebook: async (notebookId, noteId) => {
            calls.push([notebookId, noteId]);
            return true;
          },
        });
        const vis = visibility(parentAllowed, src, ancestorOnly);
        await vis.listNotes();
        expect(calls).toEqual([["nb-parent", "n-child"]]);
      });
    });

    it("probes single-claimant notes by id too, not only multi-claimant ones", async () => {
      const calls: Array<[string, string]> = [];
      const src = treeSource({
        listNotes: async () => [
          { id: "n-parent", title: "At Parent" },
          { id: "n-child", title: "At Child" },
        ],
        hasNoteInNotebook: async (notebookId, noteId) => {
          calls.push([notebookId, noteId]);
          return DIRECT[noteId]?.includes(notebookId) === true;
        },
      });
      const settings = policy([{ notebooks: ["Parent"], read: true }]);
      const ids = (await visibility(settings, src, TREE).listNotes()).map((n) => n.id);
      expect(ids).toEqual(["n-parent", "n-child"]);
      // n-parent has one claimant (nb-parent); n-child has two.
      expect(calls.sort()).toEqual(
        [
          ["nb-child", "n-child"],
          ["nb-parent", "n-child"],
          ["nb-parent", "n-parent"],
        ].sort(),
      );
      for (const [notebookId] of calls) expect(notebookId.startsWith("nb-")).toBe(true);
    });

    it("probes once per claimant per request, not per hit", async () => {
      let probes = 0;
      const src = nestedSource({
        hasNoteInNotebook: async (notebookId) => {
          probes += 1;
          return notebookId === "nb-child";
        },
      });
      const vis = visibility(allAllowed, src, TREE);
      await vis.listNotes();
      expect(probes).toBe(2);
      await vis.searchHits("q");
      expect(probes).toBe(4);
    });
  });
});

describe("discovery visibility — optional dependencies and root confirmation (S2 LOW)", () => {
  const rootPolicy: SettingsFile = {
    version: 1,
    defaults: { read: false, edit: false, create: false, delete: false },
    overrides: [{ notebooks: ["<root>"], read: true }],
  };
  const rootSource = (overrides: Partial<DiscoverySource>) =>
    source({
      search: async () => [{ id: "n-root", title: "Loose", source: "note" }],
      listNotes: async () => [{ id: "n-root", title: "Loose" }],
      findNoteIdsByNotebook: async () => [],
      noteMetadata: async () => ({ title: "Loose", notebookAbsenceConfirmed: true }),
      ...overrides,
    });

  it("shows a root note only on positive confirmation (control)", async () => {
    const vis = visibility(rootPolicy, rootSource({}));
    expect((await vis.listNotes()).map((n) => n.id)).toEqual(["n-root"]);
  });

  it("shows a confirmed root note without ever calling the notebook direct probe", async () => {
    let probes = 0;
    const counting: DirectProbe = async () => {
      probes += 1;
      throw new Error("a root note must not need a notebook probe");
    };
    const withProbe = rootSource({ hasNoteInNotebook: counting });
    const { hasNoteInNotebook: _omitted, ...withoutProbe } = rootSource({});
    for (const src of [withProbe, withoutProbe]) {
      const vis = visibility(rootPolicy, src);
      expect((await vis.listNotes()).map((n) => n.id)).toEqual(["n-root"]);
      expect((await vis.searchHits("l")).map((h) => h.id)).toEqual(["n-root"]);
    }
    expect(probes).toBe(0);
  });

  it("hides a root note whose metadata contradicts the absence confirmation", async () => {
    const vis = visibility(
      rootPolicy,
      rootSource({
        noteMetadata: async () => ({
          title: "Loose",
          notebookId: "nb-priv",
          notebookAbsenceConfirmed: true,
        }),
      }),
    );
    expect(await vis.listNotes()).toEqual([]);
    expect(await vis.searchHits("l")).toEqual([]);
  });

  it.each<[string, DiscoverySource["noteMetadata"]]>([
    ["metadata is absent", async () => undefined],
    [
      "metadata lookup fails",
      async () => {
        throw new Error("lookup failed");
      },
    ],
    ["confirmation is a string", async () => ({ notebookAbsenceConfirmed: "true" })],
  ])("hides a root note when %s", async (_label, noteMetadata) => {
    const vis = visibility(rootPolicy, rootSource({ noteMetadata }));
    expect(await vis.listNotes()).toEqual([]);
    expect(await vis.searchHits("l")).toEqual([]);
  });

  it("hides a confirmed root note when its lock state is locked, unavailable, or fails", async () => {
    for (const readNoteLockState of [
      async () => "locked" as const,
      async () => {
        throw new Error("lock backend down");
      },
    ]) {
      const vis = visibility(rootPolicy, rootSource({ readNoteLockState }));
      expect(await vis.listNotes()).toEqual([]);
    }
    const { readNoteLockState: _omitted, ...withoutLock } = rootSource({});
    expect(await visibility(rootPolicy, withoutLock).listNotes()).toEqual([]);
  });

  it("hides every note when the lock probe is not provided", async () => {
    const { readNoteLockState: _omitted, ...withoutLock } = source();
    const vis = visibility(allowPublic, withoutLock);
    expect(await vis.searchHits("a")).toEqual(
      // Only the notebook hit for an allowed notebook may survive.
      [{ id: "nb-pub", title: "Public", source: "notebook" }],
    );
    expect(await vis.listNotes()).toEqual([]);
  });
});
