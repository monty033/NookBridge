/**
 * Discovery visibility filter.
 *
 * `notes.search`, `notes.list_notebooks`, and operator `search`/`browse`
 * return note and notebook titles.  Every discovery result is decided
 * here before it leaves the daemon.  Nothing is returned unfiltered; any
 * per-item failure excludes that item.
 *
 *   note     visible iff unlocked (readNoteLockState === "unlocked") AND
 *            its governing notebook path resolves AND the settings
 *            evaluator allows `read` for { notebookPath, noteTitle }.
 *   notebook visible iff its path resolves AND the evaluator allows
 *            `read` for { notebookPath }.
 *
 * Every discovery request fetches ONE fresh, complete notebook hierarchy
 * snapshot from `listNotebooksForSettings` and derives from it, for that
 * request only, everything that needs notebooks: the id → titlePath index, the
 * parentId graph (ancestry), the notebook list that note membership is built
 * from, and the notebook visibility decision.  The snapshot is never kept
 * across requests, and the boot-time index is never consulted.  A snapshot is
 * valid only if the fetch succeeds, it is an array of records with unique
 * non-empty string ids, every parentId is absent or names a record in the
 * snapshot, and the titlePath index builds (no cycles, no colliding paths).
 * Any other snapshot, or no snapshot source, hides everything.
 *
 * Note→notebook membership is built ONCE per request from the snapshot's
 * notebooks (findNoteIdsByNotebook per notebook), not per hit.  The pinned
 * core's `notebooks.notes(id)` is RECURSIVE, so a note in `A/B` is claimed
 * by both `A` and `A/B`.  Claimants that lie on one parentId chain (every
 * other claimant is a proper ancestor, by id, of the deepest) resolve to the
 * deepest notebook's path.  Ancestry is never inferred from path strings: a
 * root titled `Parent/Child` is unrelated to a root titled `Parent`.
 * Unrelated claimants, or a claimant absent from the snapshot, are ambiguous
 * and the note is excluded, regardless of enumeration order.
 * Recursive claims alone cannot tell a note attached only to the descendant
 * from one attached to the ancestor as well, nor prove that a lone claimant
 * is the real holder: the hierarchy may omit a child notebook (root-only
 * summaries when breadcrumbs fail) while an ancestor's recursive listing still
 * claims the child's note.  So EVERY note with any notebook claim, including a
 * single claimant, needs the direct `hasNoteInNotebook` probe (by notebook
 * and note id, never by path) to find it in exactly one claimant, and that
 * claimant must be the deepest.  Both directly attached, none, a different
 * holder, a non-boolean answer, a throw, or no probe at all hide the note.
 * Confirmed root-level notes (no claim) are decided separately and need no
 * notebook probe.
 * A note claimed by no notebook is root-level only when the projection
 * confirms it (`notebookAbsenceConfirmed` via noteMetadata, called only
 * for such notes).  Anything unresolvable is excluded.
 */

import { buildNotebookIndex } from "../settings/notebook-index.js";
import type { NotebookRecord } from "../settings/notebook-index.js";
import type { createSettingsEvaluator } from "../settings/settings-evaluator.js";

type SettingsEvaluator = ReturnType<typeof createSettingsEvaluator>;

export type DiscoverySearchHit = Readonly<{
  id: string;
  title: string;
  source: "note" | "notebook";
}>;

/** Only the read-only projection methods this filter needs. */
export interface DiscoverySource {
  readonly search: (query: string) => Promise<ReadonlyArray<DiscoverySearchHit>>;
  readonly listNotes: () => Promise<ReadonlyArray<Readonly<{ id: string; title: string }>>>;
  /** Optional upstream; absent membership fails the whole request closed. */
  readonly findNoteIdsByNotebook?: (notebookId: string) => Promise<ReadonlyArray<string>>;
  /**
   * Optional direct (non-recursive) membership probe.  Required to confirm the
   * holder of EVERY note with a notebook claim; absent means such notes are
   * hidden.  Root-level notes do not use it.
   */
  readonly hasNoteInNotebook?: (notebookId: string, noteId: string) => Promise<boolean>;
  readonly noteMetadata: (id: string) => Promise<unknown>;
  /** Optional upstream; an absent lock probe hides every note. */
  readonly readNoteLockState?: (id: string) => Promise<"locked" | "unlocked">;
}

export interface DiscoveryVisibilityOptions {
  readonly source: DiscoverySource;
  /**
   * The complete live notebook hierarchy (id, title, parentId).  Called once
   * per discovery request.  Absent means no hierarchy (fail closed).
   */
  readonly listNotebooksForSettings?: () => Promise<ReadonlyArray<unknown>>;
  readonly settingsEvaluator: SettingsEvaluator;
}

export interface DiscoveryVisibility {
  readonly searchHits: (query: string) => Promise<ReadonlyArray<DiscoverySearchHit>>;
  readonly listNotes: () => Promise<ReadonlyArray<Readonly<{ id: string; title: string }>>>;
  readonly filterNotebooks: <T extends Readonly<{ id: string }>>(
    notebooks: ReadonlyArray<T>,
  ) => Promise<ReadonlyArray<T>>;
}

/** Per-request note id → every notebook id whose (recursive) listing contained it. */
type Membership = ReadonlyMap<string, ReadonlyArray<string>>;

/** One request's validated, immutable view of the live notebook hierarchy. */
interface HierarchySnapshot {
  readonly notebookIds: ReadonlyArray<string>;
  readonly pathOf: (notebookId: string) => string | undefined;
  /** True iff `ancestorId` is a proper ancestor of `notebookId` by parentId. */
  readonly isAncestor: (ancestorId: string, notebookId: string) => boolean;
  readonly depthOf: (notebookId: string) => number | undefined;
}

function ownField(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

/**
 * Used when a visibility input (read-only projection, settings evaluator) is
 * missing: every discovery request returns nothing rather than raw results.
 */
export const FAIL_CLOSED_DISCOVERY_VISIBILITY: DiscoveryVisibility = Object.freeze({
  searchHits: async () => Object.freeze([]),
  listNotes: async () => Object.freeze([]),
  filterNotebooks: async () => Object.freeze([]),
});

export const DISCOVERY_MAX_HIERARCHY_RECORDS = 1_000;
/** Maximum recursive notebook→note claims examined in one discovery request. */
export const DISCOVERY_MAX_MEMBERSHIP_ENTRIES = 100_000;

export function createDiscoveryVisibility(
  options: DiscoveryVisibilityOptions,
): DiscoveryVisibility {
  const { source, settingsEvaluator } = options;
  const listNotebooksForSettings = options.listNotebooksForSettings;

  /**
   * Fetch and validate ONE fresh hierarchy snapshot for the current request.
   * Returns undefined (caller fails closed) if the source is absent, throws,
   * or yields anything incomplete or malformed.
   */
  const loadSnapshot = async (): Promise<HierarchySnapshot | undefined> => {
    if (listNotebooksForSettings === undefined) return undefined;
    try {
      const records = await listNotebooksForSettings();
      if (!Array.isArray(records) || records.length > DISCOVERY_MAX_HIERARCHY_RECORDS)
        return undefined;
      const parents = new Map<string, string | undefined>();
      for (const record of records) {
        const id = ownField(record, "id");
        if (typeof id !== "string" || id.length === 0 || parents.has(id)) return undefined;
        const parentId = ownField(record, "parentId");
        if (parentId !== undefined && (typeof parentId !== "string" || parentId.length === 0)) {
          return undefined;
        }
        parents.set(id, parentId);
      }
      for (const parentId of parents.values()) {
        if (parentId !== undefined && !parents.has(parentId)) return undefined;
      }
      // Validates titles and rejects cycles and colliding paths (throws).
      const index = buildNotebookIndex(records as readonly NotebookRecord[]);
      const ancestry = new Map<string, ReadonlyArray<string>>();
      for (const id of parents.keys()) {
        const chain: string[] = [];
        let cursor = parents.get(id);
        while (cursor !== undefined) {
          if (chain.length >= parents.size) return undefined; // defensive: cycle
          chain.push(cursor);
          cursor = parents.get(cursor);
        }
        ancestry.set(id, chain);
      }
      const notebookIds = Object.freeze([...parents.keys()]);
      return Object.freeze({
        notebookIds,
        pathOf: (notebookId: string) => {
          const path = index.resolvePath(notebookId);
          return typeof path === "string" && path.length > 0 ? path : undefined;
        },
        isAncestor: (ancestorId: string, notebookId: string) =>
          ancestry.get(notebookId)?.includes(ancestorId) === true,
        depthOf: (notebookId: string) => ancestry.get(notebookId)?.length,
      });
    } catch {
      return undefined;
    }
  };

  const notebookVisible = (notebookId: string, snapshot: HierarchySnapshot): boolean => {
    try {
      const notebookPath = snapshot.pathOf(notebookId);
      if (notebookPath === undefined) return false;
      return settingsEvaluator("read", { notebookPath }).allowed === true;
    } catch {
      return false;
    }
  };

  /**
   * Build note id → claiming notebook ids once.  If the membership source
   * is unavailable or any notebook's listing fails or is malformed, return
   * undefined and the caller fails closed for the whole request.
   */
  const buildMembership = async (snapshot: HierarchySnapshot): Promise<Membership | undefined> => {
    if (source.findNoteIdsByNotebook === undefined) return undefined;
    const claims = new Map<string, string[]>();
    let membershipEntries = 0;
    for (const notebookId of snapshot.notebookIds) {
      let noteIds: ReadonlyArray<string>;
      try {
        noteIds = await source.findNoteIdsByNotebook(notebookId);
      } catch {
        return undefined;
      }
      if (!Array.isArray(noteIds)) return undefined;
      if (noteIds.length > DISCOVERY_MAX_MEMBERSHIP_ENTRIES - membershipEntries) return undefined;
      membershipEntries += noteIds.length;
      for (const noteId of noteIds) {
        if (typeof noteId !== "string" || noteId.length === 0) return undefined;
        const claimants = claims.get(noteId);
        if (claimants === undefined) claims.set(noteId, [notebookId]);
        else if (!claimants.includes(notebookId)) claimants.push(notebookId);
      }
    }
    return claims;
  };

  /**
   * The one notebook path that governs a note, from its claimants.  Every
   * claimant must be in the snapshot, and all of them must lie on a single
   * parentId chain: the deepest claimant has every other claimant as a proper
   * ancestor (by id).  The direct probe must also find the note in exactly one
   * claimant, the deepest, even when there is only one claimant (see the header).  The
   * deepest notebook's path then governs.  Otherwise the note's policy
   * context is unknowable and it is unresolved.  A probe throw propagates to
   * the caller, which excludes the note.
   */
  const governingPath = async (
    noteId: string,
    claimants: ReadonlyArray<string>,
    snapshot: HierarchySnapshot,
  ): Promise<string | undefined> => {
    let deepest: string | undefined;
    let deepestDepth = -1;
    for (const claimant of claimants) {
      const depth = snapshot.depthOf(claimant);
      if (depth === undefined) return undefined;
      if (depth > deepestDepth) {
        deepest = claimant;
        deepestDepth = depth;
      }
    }
    if (deepest === undefined) return undefined;
    for (const claimant of claimants) {
      if (claimant !== deepest && !snapshot.isAncestor(claimant, deepest)) return undefined;
    }
    if (source.hasNoteInNotebook === undefined) return undefined;
    const holders: string[] = [];
    for (const claimant of claimants) {
      const direct = await source.hasNoteInNotebook(claimant, noteId);
      if (typeof direct !== "boolean") return undefined;
      if (direct) holders.push(claimant);
    }
    if (holders.length !== 1 || holders[0] !== deepest) return undefined;
    return snapshot.pathOf(deepest);
  };

  /** Title + lock + path decision for one note, given its claiming notebook ids. */
  const decideNote = async (
    noteId: string,
    title: string,
    claimants: ReadonlyArray<string>,
    snapshot: HierarchySnapshot,
  ): Promise<boolean> => {
    try {
      // Fail closed: a missing probe, a throw, or any value other than
      // "unlocked" excludes the note.
      if (source.readNoteLockState === undefined) return false;
      if ((await source.readNoteLockState(noteId)) !== "unlocked") return false;
      const notebookPath = await governingPath(noteId, claimants, snapshot);
      if (notebookPath === undefined) return false;
      return settingsEvaluator("read", { notebookPath, noteTitle: title }).allowed === true;
    } catch {
      return false;
    }
  };

  /** Root-level decision: only for notes the projection confirms belong to no notebook. */
  const decideRootNote = async (noteId: string, title: string): Promise<boolean> => {
    try {
      const metadata = await source.noteMetadata(noteId);
      if (ownField(metadata, "notebookAbsenceConfirmed") !== true) return false;
      // A note that also names a notebook contradicts the confirmation.
      if (ownField(metadata, "notebookId") !== undefined) return false;
      if (source.readNoteLockState === undefined) return false;
      if ((await source.readNoteLockState(noteId)) !== "unlocked") return false;
      return settingsEvaluator("read", { noteTitle: title }).allowed === true;
    } catch {
      return false;
    }
  };

  const filterNoteList = async (
    notes: ReadonlyArray<Readonly<{ id: string; title: string }>>,
    membership: Membership,
    snapshot: HierarchySnapshot,
  ): Promise<Array<Readonly<{ id: string; title: string }>>> => {
    const visible: Array<Readonly<{ id: string; title: string }>> = [];
    for (const note of notes) {
      const claimants = membership.get(note.id);
      const ok =
        claimants === undefined
          ? await decideRootNote(note.id, note.title)
          : await decideNote(note.id, note.title, claimants, snapshot);
      if (ok) visible.push(Object.freeze({ id: note.id, title: note.title }));
    }
    return visible;
  };

  const searchHits = async (query: string): Promise<ReadonlyArray<DiscoverySearchHit>> => {
    if (typeof query !== "string" || query.length === 0) {
      throw new Error("discovery search query must be a non-empty string");
    }
    const raw = await source.search(query);
    const snapshot = await loadSnapshot();
    if (snapshot === undefined) return Object.freeze([]); // fail closed
    const membership = await buildMembership(snapshot);
    if (membership === undefined) return Object.freeze([]); // fail closed
    const noteHits = raw.filter((hit) => hit.source === "note");
    const visibleNotes = await filterNoteList(
      noteHits.map((hit) => ({ id: hit.id, title: hit.title })),
      membership,
      snapshot,
    );
    const visibleNoteIds = new Set(visibleNotes.map((note) => note.id));
    const out: DiscoverySearchHit[] = [];
    for (const hit of raw) {
      if (hit.source === "note") {
        if (visibleNoteIds.has(hit.id)) {
          out.push(Object.freeze({ id: hit.id, title: hit.title, source: "note" as const }));
        }
      } else if (notebookVisible(hit.id, snapshot)) {
        out.push(Object.freeze({ id: hit.id, title: hit.title, source: "notebook" as const }));
      }
    }
    return Object.freeze(out);
  };

  const listNotes = async (): Promise<ReadonlyArray<Readonly<{ id: string; title: string }>>> => {
    const notes = await source.listNotes();
    const snapshot = await loadSnapshot();
    if (snapshot === undefined) return Object.freeze([]); // fail closed
    const membership = await buildMembership(snapshot);
    if (membership === undefined) return Object.freeze([]); // fail closed
    return Object.freeze(await filterNoteList(notes, membership, snapshot));
  };

  const filterNotebooks = async <T extends Readonly<{ id: string }>>(
    notebooks: ReadonlyArray<T>,
  ): Promise<ReadonlyArray<T>> => {
    const snapshot = await loadSnapshot();
    if (snapshot === undefined) return Object.freeze([]); // fail closed
    return Object.freeze(notebooks.filter((notebook) => notebookVisible(notebook.id, snapshot)));
  };

  return Object.freeze({ searchHits, listNotes, filterNotebooks });
}
