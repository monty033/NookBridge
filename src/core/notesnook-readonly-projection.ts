/**
 * Production live→read-only projection.
 *
 * Stage 3 first proof wiring (§13.7 of `docs/implementation-plan-v1.5.md`):
 * the production runtime flattens the live `@notesnook/core@8.1.3`
 * `Database` instance behind the closed
 * {@link NotesnookReadOnlyDatabase} structural interface that the
 * read-only adapter consumes.  No raw `Database`, no `user`, no
 * `tokenManager`, no `kv`, no `transport`, no file storage, and no
 * mutator is exposed through the projection.
 *
 * Source of truth
 * ---------------
 *
 * The flatten surface is rooted in the verified pinned d.ts at
 * `node_modules/@notesnook/core/dist/index.d.ts`:
 *
 *   - `Database.syncer: SyncManager` → `syncer.start({type, force?,
 *     offlineMode?}): Promise<boolean>`.  We forward ONLY
 *     `type: "fetch"`.  Any other discriminator (including `"full"`,
 *     which includes a send phase, and `"send"` itself) is
 *     rejected by the projection before it reaches upstream.
 *   - `Database.notebooks: Notebooks` → `notebooks.all.ids()` +
 *     `notebooks.all.items()` (both per the d.ts).  We list notebook
 *     ids and then fetch each one through `notebooks.notebook(id)`
 *     so the projection can coerce each result through the narrow
 *     {@link NotesnookReadOnlyNotebookSummary} shape.
 *   - `Database.notes: Notes` → `notes.all.ids()` for the bounded note
 *     list, followed by `notes.note(id): Promise<Note | undefined>` for
 *     per-id metadata reads.  Note bodies / encrypted content /
 *     attachments are intentionally not part of the seam.
 *   - `Database.lookup: Lookup` → `lookup.notes(query)` /
 *     `lookup.notebooks(query)` returning `SearchResults<Note>` /
 *     `SearchResults<Notebook>`.  We use `.ids()` to obtain the
 *     closed hit list and project each id back through
 *     `notes.note(id)` / `notebooks.notebook(id)` so the metadata is
 *     validated through the same coerced path.
 *   - `Database.lastSynced(): Promise<number>` and
 *     `Database.hasUnsyncedChanges(): Promise<boolean>` are forwarded
 *     verbatim.
 *
 * The projection is structural, not nominal: it accepts any object
 * shaped like `NotesnookLiveDatabase` (see
 * `src/core/notesnook-core-adapter.ts`) so the offline tests can drive
 * the same code path with an injected fake module.  No `instanceof`
 * check; every required slot is read through the same hostile-proxy
 * safe getter pattern that `createNotesnookLiveCoreFactory` uses
 * for its user / token / kv slots.
 *
 * Non-goals
 * ---------
 *
 *   - This module does NOT authenticate.  Authentication is owned by
 *     the Stage 2B-live factory and runner; the projection assumes
 *     the supplied `Database` is already open and synced.
 *   - This module does NOT call `db.syncer.stop()`, `db.syncer.start`
 *     with `"send"`, `db.reset()`, `db.changePassword()`,
 *     `db.disconnectSSE()`, `db.connectSSE()`, or any other write or
 *     transport-tier method.  `db.syncer.start` is the only sync
 *     surface used and only the `"fetch"` discriminator flows through.
 *   - This module does NOT expose a raw `Database`, a raw `SyncManager`,
 *     a raw `Notebooks` / `Notes` / `Lookup`, or any per-slot escape
 *     hatch.  The structural projection is the entire surface.
 *   - This module does NOT cache or pre-read note bodies, encrypted
 *     content, or attachment metadata.  The Stage 3 first proof is
 *     metadata-only.
 *
 * Categorical errors
 * ------------------
 *
 * Every projection failure (missing slot, hostile getter, hostile
 * return value, discriminator mismatch) maps to a categorical,
 * chain-free {@link NotesnookReadOnlyProjectionError}.  The predicate
 * {@link isNotesnookReadOnlyProjectionError} recognises them by
 * identity (a `WeakSet<object>` keyed on object identity), exactly as
 * the live factory and the read-only adapter do.  No `cause`,
 * no `__context__`, no upstream message bytes are forwarded.
 */

import {
  createReadOnlyRevisionToken,
  isNotesnookReadOnlyAdapterError,
  type NotesnookReadOnlyDatabase,
  type NotesnookReadOnlyNoteMetadata,
} from "./notesnook-readonly-adapter.js";
import type { NotesnookLiveDatabase } from "./notesnook-core-adapter.js";

type ReadOnlyRevisionToken = NonNullable<NotesnookReadOnlyNoteMetadata["revision"]>;

// ---------------------------------------------------------------------------
// Allowlisted sync types.
//
// We mirror the structural `SyncOptions` literal set
// `{ type: "full" | "fetch" | "send", force?: boolean, offlineMode?: boolean }`
// from `@notesnook/core@8.1.3` and NARROW it to the truly read-only
// `"fetch"` operation. Upstream `Sync.start({type: "full"})` performs
// a fetch followed by a send, so `"full"` is not safe here.
// ---------------------------------------------------------------------------

export type NotesnookReadOnlyProjectionSyncType = "fetch";

const VALID_PROJECTION_SYNC_TYPES: ReadonlySet<NotesnookReadOnlyProjectionSyncType> = new Set([
  "fetch",
]);

// ---------------------------------------------------------------------------
// Categorical error.
//
// Adapter-style categorical, chain-free error.  Identified by object
// identity through a module-private `WeakSet`.  `cause` and
// `__context__` are explicitly cleared so a hostile getter cannot
// smuggle upstream payloads (which may carry token bytes, paths, or
// note corpus data) out of the projection boundary.
// ---------------------------------------------------------------------------

const PROJECTION_ERRORS = new WeakSet<object>();

/**
 * Categorical, chain-free projection error.
 */
export class NotesnookReadOnlyProjectionError extends Error {
  constructor(message: string) {
    super(message);
    Object.defineProperty(this, "cause", { configurable: true, value: undefined });
    Object.defineProperty(this, "__context__", { configurable: true, value: undefined });
    Object.defineProperty(this, "name", {
      configurable: true,
      value: "NotesnookReadOnlyProjectionError",
    });
    PROJECTION_ERRORS.add(this);
  }
}

/**
 * Public predicate: is `value` a projection-owned error emitted by
 * this module?  Identified by object identity, not by message text.
 */
export function isNotesnookReadOnlyProjectionError(
  value: unknown,
): value is NotesnookReadOnlyProjectionError {
  return typeof value === "object" && value !== null && PROJECTION_ERRORS.has(value as object);
}

function projectionError(message: string): NotesnookReadOnlyProjectionError {
  return new NotesnookReadOnlyProjectionError(message);
}

// ---------------------------------------------------------------------------
// Public projection.
// ---------------------------------------------------------------------------

/**
 * Structural shape the projection accepts.  Same as
 * {@link NotesnookLiveDatabase} (the constructable instance the
 * pinned real-core factory produces) so a future Stage 3 wiring can
 * hand the live handle straight through without a translation step.
 */
export type NotesnookReadOnlyProjectionSource = NotesnookLiveDatabase;

/**
 * Flatten an already-opened live (or fake) Notesnook `Database`
 * instance behind the closed {@link NotesnookReadOnlyDatabase}
 * interface.  Every slot is read through a hostile-getter-safe
 * accessor; every public method normalises its upstream throw /
 * rejection to a categorical
 * {@link NotesnookReadOnlyProjectionError}.
 *
 * The returned object IS the {@link NotesnookReadOnlyDatabase} the
 * read-only adapter consumes.  No raw `Database`, no slot from the
 * upstream `user` / `tokenManager` / `kv` / `attachments` / `vault` /
 * `content` / `backup` / `monographs` / `reminders` / `tags` /
 * `colors` / `shortcuts` / `relations` / `trash` / `sanitizer` /
 * `noteHistory` / `legacyTags` / `legacyColors` / `legacyNotes` /
 * `legacySettings` / `subscriptions` / `offers` / `debug` / `pricing`
 * collections is reachable through the projection. The projection
 * internally reads only `content.findByNoteId(id).locked` to enforce
 * Vault refusal; it never returns the content record or its data.
 */
export function flattenLiveDatabaseToReadOnly(
  source: NotesnookReadOnlyProjectionSource,
): NotesnookReadOnlyDatabase {
  // Every slot read is hostile-getter-safe: a getter that throws, a
  // proxy that returns a primitive, or a missing slot maps to a
  // categorical projection error before any value leaves this
  // boundary.  We validate ALL required slots up-front so a forged
  // handle is rejected at construction time.
  const syncer = readSyncer(source);
  const notebooks = readManager(
    source,
    "notebooks",
    "Notesnook read-only projection: notebooks slot is unavailable",
  );
  const notes = readManager(
    source,
    "notes",
    "Notesnook read-only projection: notes slot is unavailable",
  );
  const lookup = readManager(
    source,
    "lookup",
    "Notesnook read-only projection: lookup slot is unavailable",
  );
  const lastSyncedFn = readMethod(
    source,
    "lastSynced",
    "Notesnook read-only projection: lastSynced is unavailable",
  );
  const hasUnsyncedFn = readMethod(
    source,
    "hasUnsyncedChanges",
    "Notesnook read-only projection: hasUnsyncedChanges is unavailable",
  );

  // Capture the sync manager's start function once so a hostile proxy
  // cannot flip it out from under us.
  const startFn = readManagerMethod(
    syncer,
    "start",
    "Notesnook read-only projection: syncer.start is unavailable",
  );

  // Capture the notebooks.all getter once so a hostile proxy cannot
  // flip the `all` selector out from under us.  Per the pinned
  // `@notesnook/core@8.1.3` d.ts, `Notebooks.all` is a getter that
  // returns a `FilteredSelector<Notebook>` (with `ids()` and `items()`).
  const notebooksAll = readFilteredSelector(notebooks, "notebooks.all", "Notebooks");
  // Capture the lookup methods once.  Per the d.ts, `Lookup.notes`
  // and `Lookup.notebooks` return `SearchResults<Note>` /
  // `SearchResults<Notebook>` whose `.ids()` yields `string[]`.
  const lookupNotesFn = readManagerMethod(
    lookup,
    "notes",
    "Notesnook read-only projection: lookup.notes is unavailable",
  );
  const lookupNotebooksFn = readManagerMethod(
    lookup,
    "notebooks",
    "Notesnook read-only projection: lookup.notebooks is unavailable",
  );

  // Capture the notebook/notes lookup methods once.
  const notebookFn = readManagerMethod(
    notebooks,
    "notebook",
    "Notesnook read-only projection: notebooks.notebook is unavailable",
  );
  const notebookNotesFn = readOptionalManagerMethod(notebooks, "notes");
  // Notebook records do not carry parentId in the pinned core. The
  // read-only breadcrumbs API is therefore required to prove ancestry.
  const breadcrumbsFn = readOptionalManagerMethod(notebooks, "breadcrumbs");
  const noteFn = readManagerMethod(
    notes,
    "note",
    "Notesnook read-only projection: notes.note is unavailable",
  );
  const contentFindByNoteIdFn = readOptionalContentFindByNoteId(source);

  // Build the closed seam.  Every method is async; every throw /
  // reject maps to a categorical projection error.  Upstream
  // categorical notesnook-adapter errors propagate unchanged so
  // their chain-free invariants are preserved end-to-end.
  return Object.freeze({
    lastSynced: async (): Promise<number> => {
      const raw = await callThrough(
        lastSyncedFn,
        [],
        "Notesnook read-only projection: lastSynced rejected",
      );
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
        throw projectionError(
          "Notesnook read-only projection: lastSynced returned an invalid timestamp",
        );
      }
      return raw;
    },

    hasUnsyncedChanges: async (): Promise<boolean> => {
      const raw = await callThrough(
        hasUnsyncedFn,
        [],
        "Notesnook read-only projection: hasUnsyncedChanges rejected",
      );
      if (typeof raw !== "boolean") {
        throw projectionError(
          "Notesnook read-only projection: hasUnsyncedChanges did not return a boolean",
        );
      }
      return raw;
    },

    sync: async (options: {
      type: NotesnookReadOnlyProjectionSyncType;
      force?: boolean;
    }): Promise<boolean> => {
      const syncType = options?.type;
      if (!VALID_PROJECTION_SYNC_TYPES.has(syncType as NotesnookReadOnlyProjectionSyncType)) {
        // Categorical rejection.  No upstream call is made.
        throw projectionError('Notesnook read-only projection: sync type must be "fetch"');
      }
      if (options?.force !== undefined) {
        throw projectionError("Notesnook read-only projection: sync force is out of scope");
      }
      const syncArgs: { type: NotesnookReadOnlyProjectionSyncType } = {
        type: syncType,
      };
      const result = await callThrough(
        startFn,
        [syncArgs],
        "Notesnook read-only projection: syncer.start rejected",
      );
      if (typeof result !== "boolean") {
        throw projectionError(
          "Notesnook read-only projection: syncer.start did not return a boolean",
        );
      }
      return result;
    },

    listNotebooks: async (): Promise<
      NotesnookReadOnlyDatabase["listNotebooks"] extends () => Promise<infer R> ? R : never
    > => {
      const ids = await readFilteredSelectorIds(notebooksAll, "notebooks.all.ids");
      // PR-65 P1-5a — read-side corpus bound.  Truncate the source
      // id array at the published cap so a large notebook list cannot
      // drive an unbounded number of follow-up `notebooks.notebook(id)`
      // calls.
      const boundedNotebookIds = truncateIds(ids, MAX_LIST_NOTEBOOKS);
      const summaries: Array<{
        readonly id: string;
        readonly title: string;
        readonly dateCreated?: number;
        readonly dateModified?: number;
      }> = [];
      for (const id of boundedNotebookIds) {
        const notebook = await callThrough(
          notebookFn,
          [id],
          "Notesnook read-only projection: notebooks.notebook rejected",
        );
        if (notebook === undefined || notebook === null) continue;
        const summary = coerceUpstreamNotebookToSummary(notebook);
        if (summary !== undefined) summaries.push(summary);
      }
      return summaries as never;
    },

    // Boot-time settings indexing uses a separate, full enumeration. It
    // proves every parent through the pinned read-only breadcrumbs API and
    // intentionally does not inherit the RPC corpus cap.
    //
    // When the live core does not expose `notebooks.breadcrumbs` (e.g.
    // older DB instances or partial mocks) the projection falls back to
    // root-only summaries.  The resolver's hierarchy-proof then accepts
    // single-segment paths only; nested paths surface as `not_found`
    // rather than a generic `service_unavailable`.  This keeps the
    // destructive-delete seam available on every supported DB shape.
    listNotebooksWithParents: async (): Promise<
      NotesnookReadOnlyDatabase["listNotebooks"] extends () => Promise<infer R> ? R : never
    > => {
      const ids = await readFilteredSelectorIds(notebooksAll, "notebooks.all.ids");
      const summaries: Array<{
        readonly id: string;
        readonly title: string;
        readonly parentId?: string;
        readonly dateCreated?: number;
        readonly dateModified?: number;
      }> = [];
      if (breadcrumbsFn === undefined) {
        // Fallback: enumerate without parent proof.  Every notebook is
        // treated as a root; the resolver still produces a stable id↔title
        // index so single-segment paths resolve correctly.
        for (const id of ids) {
          const notebook = await callThrough(
            notebookFn,
            [id],
            "Notesnook read-only projection: notebooks.notebook rejected",
          );
          if (notebook === undefined || notebook === null) {
            throw projectionError(
              "Notesnook read-only projection: notebook enumeration is incomplete",
            );
          }
          const summary = coerceUpstreamNotebookToSummary(notebook);
          if (summary === undefined) {
            throw projectionError(
              "Notesnook read-only projection: notebook enumeration is invalid",
            );
          }
          summaries.push(summary);
        }
        return summaries as never;
      }
      // Breadcrumbs path.  If the live core throws (e.g. an older DB
      // exposes the slot but the call rejects), fall back to root-only
      // enumeration so the destructive-delete seam stays available.
      let breadcrumbsUsable = true;
      for (const id of ids) {
        const notebook = await callThrough(
          notebookFn,
          [id],
          "Notesnook read-only projection: notebooks.notebook rejected",
        );
        if (notebook === undefined || notebook === null) {
          throw projectionError(
            "Notesnook read-only projection: notebook enumeration is incomplete",
          );
        }
        const summary = coerceUpstreamNotebookToSummary(notebook);
        if (summary === undefined) {
          throw projectionError("Notesnook read-only projection: notebook enumeration is invalid");
        }
        let parentId: string | undefined;
        if (breadcrumbsUsable) {
          try {
            parentId = await readNotebookParentId(breadcrumbsFn, id, summary);
          } catch {
            // Breadcrumbs rejected mid-enumeration: drop to root-only
            // summaries so a partial failure does not break the seam.
            breadcrumbsUsable = false;
            parentId = undefined;
          }
        }
        summaries.push(parentId === undefined ? summary : { ...summary, parentId });
      }
      return summaries as never;
    },

    listNotes: async (): Promise<
      NotesnookReadOnlyDatabase["listNotes"] extends () => Promise<infer R> ? R : never
    > => {
      const notesAll = readFilteredSelector(notes, "notes.all", "Notes");
      const ids = await readFilteredSelectorIds(notesAll, "notes.all.ids");
      // PR-65 P1-5a — read-side corpus bound.  The source query did
      // not accept a limit so we stop iterating after the published
      // cap so a large corpus cannot drive an unbounded number of
      // follow-up `notes.note(id)` calls.
      const boundedIds = truncateIds(ids, MAX_LIST_NOTES);
      const metadata: Array<{
        readonly id: string;
        readonly title: string;
        readonly dateCreated?: number;
        readonly dateModified?: number;
        readonly notebookId?: string;
        readonly pinned?: boolean;
        readonly favorite?: boolean;
        readonly localOnly?: boolean;
        readonly conflicted?: boolean;
        readonly locked?: boolean;
      }> = [];
      for (const id of boundedIds) {
        const note = await callThrough(
          noteFn,
          [id],
          "Notesnook read-only projection: notes.note rejected",
        );
        if (note === undefined || note === null) continue;
        const noteMetadata = coerceUpstreamNoteToMetadata(note);
        if (noteMetadata === undefined) continue;
        const locked = await readLockedState(contentFindByNoteIdFn, id);
        metadata.push(locked === true ? { ...noteMetadata, locked: true } : noteMetadata);
      }
      return metadata as never;
    },

    findNotesByTitle: async (title: string): Promise<NotesnookReadOnlyNoteMetadata[]> => {
      if (typeof title !== "string" || title.length === 0) {
        throw projectionError(
          "Notesnook read-only projection: note title must be a non-empty string",
        );
      }
      const noteResults = await callThrough(
        lookupNotesFn,
        [title],
        "Notesnook read-only projection: lookup.notes rejected",
      );
      const noteIds = await readSearchResultIds(noteResults, "lookup.notes.ids");
      if (noteIds.length > MAX_SEARCH_HITS) {
        throw projectionError("Notesnook read-only projection: title candidate set is too large");
      }
      const metadata: NotesnookReadOnlyNoteMetadata[] = [];
      for (const id of truncateIds(noteIds, MAX_SEARCH_HITS)) {
        const note = await callThrough(
          noteFn,
          [id],
          "Notesnook read-only projection: notes.note rejected",
        );
        if (note === undefined || note === null) continue;
        const noteMetadata = coerceUpstreamNoteToMetadata(note, true);
        if (noteMetadata !== undefined) metadata.push(noteMetadata);
      }
      return metadata;
    },

    findNoteIdsByNotebook: async (notebookId: string): Promise<string[]> => {
      if (typeof notebookId !== "string" || notebookId.length === 0) {
        throw projectionError(
          "Notesnook read-only projection: notebook id must be a non-empty string",
        );
      }
      if (notebookNotesFn === undefined) {
        throw projectionError("Notesnook read-only projection: notebooks.notes is unavailable");
      }
      const rawIds = await callThrough(
        notebookNotesFn,
        [notebookId],
        "Notesnook read-only projection: notebooks.notes rejected",
      );
      if (
        !Array.isArray(rawIds) ||
        rawIds.some((id): id is unknown => typeof id !== "string" || id.length === 0)
      ) {
        throw projectionError(
          "Notesnook read-only projection: notebooks.notes returned invalid ids",
        );
      }
      return rawIds;
    },

    noteMetadata: async (
      id: string,
    ): Promise<
      NotesnookReadOnlyDatabase["noteMetadata"] extends (i: string) => Promise<infer R> ? R : never
    > => {
      if (typeof id !== "string" || id.length === 0) {
        throw projectionError("Notesnook read-only projection: note id must be a non-empty string");
      }
      const note = await callThrough(
        noteFn,
        [id],
        "Notesnook read-only projection: notes.note rejected",
      );
      if (note === undefined || note === null) return undefined as never;
      const metadata = coerceUpstreamNoteToMetadata(note, true);
      if (metadata === undefined) return undefined as never;
      const locked = await readLockedState(contentFindByNoteIdFn, id);
      return (locked === true ? { ...metadata, locked: true } : metadata) as never;
    },

    search: async (
      query: string,
    ): Promise<
      NotesnookReadOnlyDatabase["search"] extends (q: string) => Promise<infer R> ? R : never
    > => {
      if (typeof query !== "string" || query.length === 0) {
        throw projectionError(
          "Notesnook read-only projection: search query must be a non-empty string",
        );
      }
      // Search both note titles and notebook titles.  The seam is
      // title-only; body matches are out of scope for this slice.
      const hits: Array<{
        readonly id: string;
        readonly title: string;
        readonly source: "note" | "notebook";
      }> = [];

      const noteResults = await callThrough(
        lookupNotesFn,
        [query],
        "Notesnook read-only projection: lookup.notes rejected",
      );
      const noteIds = await readSearchResultIds(noteResults, "lookup.notes.ids");
      // PR-65 P1-5a — read-side corpus bound.  The seam does not
      // expose a query with a limit, so the source still returns every
      // match.  We stop iterating after the published cap so a large
      // corpus cannot drive an unbounded number of follow-up
      // `notes.note(id)` calls.  Tests assert the cap is honored.
      const boundedNoteIds = truncateIds(noteIds, MAX_SEARCH_HITS);
      for (const noteId of boundedNoteIds) {
        const note = await callThrough(
          noteFn,
          [noteId],
          "Notesnook read-only projection: notes.note rejected",
        );
        if (note === undefined || note === null) continue;
        const meta = coerceUpstreamNoteToMetadata(note);
        if (meta !== undefined) {
          hits.push({ id: meta.id, title: meta.title, source: "note" });
        }
      }

      const notebookResults = await callThrough(
        lookupNotebooksFn,
        [query],
        "Notesnook read-only projection: lookup.notebooks rejected",
      );
      const notebookIds = await readSearchResultIds(notebookResults, "lookup.notebooks.ids");
      const boundedNotebookIds = truncateIds(notebookIds, MAX_SEARCH_HITS);
      for (const notebookId of boundedNotebookIds) {
        const notebook = await callThrough(
          notebookFn,
          [notebookId],
          "Notesnook read-only projection: notebooks.notebook rejected",
        );
        if (notebook === undefined || notebook === null) continue;
        const summary = coerceUpstreamNotebookToSummary(notebook);
        if (summary !== undefined) {
          hits.push({ id: summary.id, title: summary.title, source: "notebook" });
        }
      }

      return hits as never;
    },
  });
}

/**
 * Maximum number of search hits processed per source query
 * (PR-65 P1-5a).  Tests assert the cap is honored and an oversized
 * source result is silently truncated at the boundary.
 */
const MAX_SEARCH_HITS = 256;

/** Maximum number of notes enumerated by `listNotes`. */
const MAX_LIST_NOTES = 256;

/** Maximum number of notebooks enumerated by `listNotebooks`. */
const MAX_LIST_NOTEBOOKS = 256;

/**
 * Slice an oversized source id array to the published cap.
 * Defensive: the source query did not honour a limit so we stop
 * iterating at the boundary.
 */
function truncateIds<T>(ids: readonly T[], cap: number): readonly T[] {
  if (ids.length <= cap) return ids;
  return ids.slice(0, cap);
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/**
 * Read a hostile-getter-safe property off the supplied Database.  The
 * pinned `@notesnook/core@8.1.3` d.ts declares the database as a
 * plain instance with public fields, so a hostile property getter
 * (one that throws or returns a proxy) must NOT escape the
 * projection boundary.
 */
function readSlot(database: unknown, slot: string): unknown {
  let value: unknown;
  try {
    value = (database as Record<string, unknown>)[slot];
  } catch {
    throw projectionError(`Notesnook read-only projection: ${slot} slot threw`);
  }
  if (value === undefined || value === null) {
    throw projectionError(`Notesnook read-only projection: ${slot} slot is missing`);
  }
  if (typeof value !== "object" && typeof value !== "function") {
    throw projectionError(`Notesnook read-only projection: ${slot} slot is not an object`);
  }
  return value;
}

/**
 * Read the `syncer` slot and validate it carries `start`.
 */
function readSyncer(database: unknown): unknown {
  const syncer = readSlot(database, "syncer");
  // No further validation — `startFn` capture does the hostile-getter
  // check on the method itself.
  return syncer;
}

/**
 * Read a manager slot (notebooks / notes / lookup).
 */
function readManager(database: unknown, slot: string, message: string): unknown {
  try {
    return readSlot(database, slot);
  } catch (error) {
    if (isNotesnookReadOnlyProjectionError(error)) throw error;
    throw projectionError(message);
  }
}

/**
 * Read a method off the supplied manager slot through a hostile-
 * getter-safe accessor.
 */
function readManagerMethod(
  manager: unknown,
  slot: string,
  message: string,
): (...args: unknown[]) => unknown {
  let fn: unknown;
  try {
    fn = (manager as Record<string, unknown>)[slot];
  } catch {
    throw projectionError(message);
  }
  if (typeof fn !== "function") {
    throw projectionError(message);
  }
  return (...args: unknown[]) => {
    try {
      return (fn as (...args: unknown[]) => unknown).apply(manager, args);
    } catch {
      throw projectionError(`Notesnook read-only projection: ${slot} threw synchronously`);
    }
  };
}

/** Optional capture used by hierarchy proof; listNotebooks() rejects absence. */
function readOptionalManagerMethod(
  manager: unknown,
  slot: string,
): ((...args: unknown[]) => unknown) | undefined {
  let fn: unknown;
  try {
    fn = (manager as Record<string, unknown>)[slot];
  } catch {
    return undefined;
  }
  if (typeof fn !== "function") return undefined;
  return (...args: unknown[]) => {
    try {
      return (fn as (...args: unknown[]) => unknown).apply(manager, args);
    } catch {
      throw projectionError(`Notesnook read-only projection: ${slot} threw synchronously`);
    }
  };
}

/**
 * Read a database-level method (lastSynced / hasUnsyncedChanges) and
 * wrap it so the call binds to the database instance.
 */
function readMethod(
  database: unknown,
  slot: string,
  message: string,
): (...args: unknown[]) => unknown {
  let fn: unknown;
  try {
    fn = (database as Record<string, unknown>)[slot];
  } catch {
    throw projectionError(message);
  }
  if (typeof fn !== "function") {
    throw projectionError(message);
  }
  return (...args: unknown[]) => {
    try {
      return (fn as (...args: unknown[]) => unknown).apply(database, args);
    } catch {
      throw projectionError(`Notesnook read-only projection: ${slot} threw synchronously`);
    }
  };
}

/**
 * Read the `.all` getter off a `Notebooks` / `Notes` collection.  Per
 * the pinned `@notesnook/core@8.1.3` d.ts, this is a getter (not a
 * plain property); we therefore wrap the property access through a
 * `try` boundary so a hostile getter that throws does not leak.
 */
function readFilteredSelector(manager: unknown, label: string, managerLabel: string): unknown {
  let value: unknown;
  try {
    value = (manager as Record<string, unknown>).all;
  } catch {
    throw projectionError(`Notesnook read-only projection: ${label} getter threw`);
  }
  if (value === undefined || value === null) {
    throw projectionError(`Notesnook read-only projection: ${managerLabel}.all is unavailable`);
  }
  if (typeof value !== "object" && typeof value !== "function") {
    throw projectionError(`Notesnook read-only projection: ${managerLabel}.all is not an object`);
  }
  return value;
}

/**
 * Call `.ids()` on a `FilteredSelector<T>` and return the array of ids.
 */
async function readFilteredSelectorIds(selector: unknown, label: string): Promise<string[]> {
  let fn: unknown;
  try {
    fn = (selector as Record<string, unknown>).ids;
  } catch {
    throw projectionError(`Notesnook read-only projection: ${label} getter threw`);
  }
  if (typeof fn !== "function") {
    throw projectionError(`Notesnook read-only projection: ${label} is unavailable`);
  }
  let raw: unknown;
  try {
    raw = (fn as () => unknown).call(selector);
  } catch {
    throw projectionError(`Notesnook read-only projection: ${label} threw synchronously`);
  }
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || typeof (raw as { then?: unknown }).then !== "function") {
    throw projectionError(`Notesnook read-only projection: ${label} did not return a thenable`);
  }
  return callThenable(raw as PromiseLike<unknown>, label, (resolved) => {
    if (!Array.isArray(resolved)) {
      throw projectionError(`Notesnook read-only projection: ${label} did not resolve to an array`);
    }
    const ids: string[] = [];
    for (const value of resolved) {
      if (typeof value !== "string" || value.length === 0) continue;
      ids.push(value);
    }
    return ids;
  });
}

/**
 * Read the `.ids()` of a `SearchResults<T>`.  Per the d.ts,
 * `SearchResults<T>` exposes `sorted(limit?)`, `items(limit?)`, and
 * `ids()`.  We only need ids for the title-only search seam.
 */
async function readSearchResultIds(results: unknown, label: string): Promise<string[]> {
  if (results === undefined || results === null) return [];
  if (typeof results !== "object") {
    throw projectionError(`Notesnook read-only projection: ${label} returned a non-object`);
  }
  let fn: unknown;
  try {
    fn = (results as Record<string, unknown>).ids;
  } catch {
    throw projectionError(`Notesnook read-only projection: ${label}.ids getter threw`);
  }
  if (typeof fn !== "function") {
    throw projectionError(`Notesnook read-only projection: ${label}.ids is unavailable`);
  }
  let raw: unknown;
  try {
    raw = (fn as () => unknown).call(results);
  } catch {
    throw projectionError(`Notesnook read-only projection: ${label}.ids threw synchronously`);
  }
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || typeof (raw as { then?: unknown }).then !== "function") {
    throw projectionError(`Notesnook read-only projection: ${label}.ids did not return a thenable`);
  }
  return callThenable(raw as PromiseLike<unknown>, `${label}.ids`, (resolved) => {
    if (!Array.isArray(resolved)) {
      throw projectionError(
        `Notesnook read-only projection: ${label}.ids did not resolve to an array`,
      );
    }
    const ids: string[] = [];
    for (const value of resolved) {
      if (typeof value !== "string" || value.length === 0) continue;
      ids.push(value);
    }
    return ids;
  });
}

/**
 * Await a thenable and dispatch the result to a typed consumer.
 * The consumer is responsible for throwing the categorical projection
 * error when the resolved value is the wrong shape.  This helper
 * exists so the same shape-validate-then-coerce sequence runs for
 * every async slot read on the projection boundary; using `await`
 * directly would scatter the validation logic across the call sites.
 */
async function callThenable<T>(
  thenable: PromiseLike<unknown>,
  label: string,
  consumer: (resolved: unknown) => T,
): Promise<T> {
  let resolved: unknown;
  try {
    resolved = await thenable;
  } catch (error) {
    if (isNotesnookReadOnlyProjectionError(error) || isNotesnookReadOnlyAdapterError(error)) {
      throw error;
    }
    throw projectionError(`Notesnook read-only projection: ${label} rejected`);
  }
  return consumer(resolved);
}

/**
 * Call a function through the hostile-getter-safe wrapper and
 * normalise the resolved value.  Mirrors the live-factory wrapper
 * pattern: upstream throws / rejections map to a categorical
 * projection error; adapter-style errors propagate unchanged.
 */
async function callThrough<T>(
  fn: (...args: unknown[]) => unknown,
  args: readonly unknown[],
  message: string,
): Promise<T> {
  let result: unknown;
  try {
    result = fn(...args);
  } catch {
    throw projectionError(message);
  }
  if (result === undefined || result === null) return result as T;
  if (typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
    try {
      return (await (result as PromiseLike<T>)) as T;
    } catch (error) {
      if (isNotesnookReadOnlyProjectionError(error) || isNotesnookReadOnlyAdapterError(error)) {
        throw error;
      }
      throw projectionError(message);
    }
  }
  return result as T;
}

/**
 * Coerce an upstream `Notebook` record into the closed
 * {@link NotesnookReadOnlyNotebookSummary} shape.  Per the pinned
 * `@notesnook/core@8.1.3` d.ts, `Notebook extends BaseItem<"notebook">`
 * with `title: string` and `dateEdited: number`.  We surface a
 * structurally-validated narrow summary; an upstream record with
 * non-string id or non-string title is rejected categorically.
 */
function coerceUpstreamNotebookToSummary(value: unknown):
  | {
      readonly id: string;
      readonly title: string;
      readonly parentId?: string;
      readonly dateCreated?: number;
      readonly dateModified?: number;
    }
  | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  let id: unknown;
  let title: unknown;
  let dateCreated: unknown;
  let dateModified: unknown;
  try {
    id = record.id;
    title = record.title;
    // Notebooks expose `dateEdited` per the d.ts; the seam uses the
    // neutral `dateCreated` / `dateModified` aliases.  Treat
    // `dateCreated` as the upstream `dateCreated` when present and
    // fall back to `dateEdited` for the `dateModified` slot.
    dateCreated = record.dateCreated;
    dateModified = record.dateModified ?? record.dateEdited;
  } catch {
    throw projectionError(
      "Notesnook read-only projection: notebook record rejected property access",
    );
  }
  if (typeof id !== "string" || id.length === 0) {
    throw projectionError("Notesnook read-only projection: notebook record is missing id");
  }
  if (typeof title !== "string") {
    throw projectionError("Notesnook read-only projection: notebook record is missing title");
  }
  const out: {
    readonly id: string;
    readonly title: string;
    readonly dateCreated?: number;
    readonly dateModified?: number;
  } = { id, title };
  if (typeof dateCreated === "number" && Number.isFinite(dateCreated) && dateCreated >= 0) {
    (out as { dateCreated?: number }).dateCreated = dateCreated;
  }
  if (typeof dateModified === "number" && Number.isFinite(dateModified) && dateModified >= 0) {
    (out as { dateModified?: number }).dateModified = dateModified;
  }
  return out;
}

/** Convert root-to-leaf pinned-core breadcrumbs into a proven parent id. */
async function readNotebookParentId(
  breadcrumbsFn: (...args: unknown[]) => unknown,
  notebookId: string,
  summary: { readonly id: string; readonly title: string },
): Promise<string | undefined> {
  const raw = await callThrough<unknown>(
    breadcrumbsFn,
    [notebookId],
    "Notesnook read-only projection: notebooks.breadcrumbs rejected",
  );
  if (!Array.isArray(raw) || raw.length === 0) {
    throw projectionError("Notesnook read-only projection: notebook breadcrumbs are invalid");
  }
  const records: Array<{ readonly id: string; readonly title: string }> = [];
  for (const value of raw) {
    if (value === null || typeof value !== "object") {
      throw projectionError("Notesnook read-only projection: notebook breadcrumbs are invalid");
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      typeof record.title !== "string"
    ) {
      throw projectionError("Notesnook read-only projection: notebook breadcrumbs are invalid");
    }
    records.push({ id: record.id, title: record.title });
  }
  const last = records[records.length - 1];
  if (last === undefined || last.id !== summary.id || last.title !== summary.title) {
    throw projectionError("Notesnook read-only projection: notebook breadcrumbs are incomplete");
  }
  return records.length > 1 ? records[records.length - 2]?.id : undefined;
}

/**
 * Coerce an upstream `Note` record into the closed
 * {@link NotesnookReadOnlyNoteMetadata} shape.  Per the pinned
 * `@notesnook/core@8.1.3` d.ts, `Note extends BaseItem<"note">` with
 * `title: string`, `dateEdited: number`, `pinned: boolean`,
 * `favorite: boolean`, `localOnly: boolean`.  Bodies / encrypted
 * content / attachment metadata are intentionally absent from the
 * narrow seam.
 */
function coerceUpstreamNoteToMetadata(
  value: unknown,
  includeRevision = false,
):
  | {
      readonly id: string;
      readonly title: string;
      readonly revision?: ReadOnlyRevisionToken;
      readonly dateCreated?: number;
      readonly dateModified?: number;
      readonly notebookId?: string;
      readonly pinned?: boolean;
      readonly favorite?: boolean;
      readonly localOnly?: boolean;
      readonly conflicted?: boolean;
      readonly locked?: boolean;
    }
  | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  let id: unknown;
  let title: unknown;
  let dateCreated: unknown;
  let dateModified: unknown;
  let dateEdited: unknown;
  let notebookId: unknown;
  let pinned: unknown;
  let favorite: unknown;
  let localOnly: unknown;
  let conflicted: unknown;
  try {
    id = record.id;
    title = record.title;
    dateCreated = record.dateCreated;
    dateModified = record.dateModified ?? record.dateEdited;
    dateEdited = record.dateEdited;
    // `notebooks` is a deprecated `NotebookReference[]` on the
    // upstream `Note`.  We surface the FIRST id as `notebookId`
    // (a single notebook metadata) so the closed shape remains
    // scalar.  Notes with no `notebooks` simply omit the field.
    const notebooks = record.notebooks;
    if (Array.isArray(notebooks) && notebooks.length > 0) {
      const first = notebooks[0] as Record<string, unknown>;
      if (first && typeof first.id === "string") notebookId = first.id;
    } else if (typeof record.notebookId === "string") {
      notebookId = record.notebookId;
    }
    pinned = record.pinned;
    favorite = record.favorite;
    localOnly = record.localOnly;
    conflicted = record.conflicted;
  } catch {
    throw projectionError("Notesnook read-only projection: note metadata rejected property access");
  }
  if (typeof id !== "string" || id.length === 0) {
    throw projectionError("Notesnook read-only projection: note metadata is missing id");
  }
  if (typeof title !== "string") {
    throw projectionError("Notesnook read-only projection: note metadata is missing title");
  }
  if (conflicted !== undefined && typeof conflicted !== "boolean") {
    throw projectionError("Notesnook read-only projection: note conflict marker is invalid");
  }
  const out: {
    readonly id: string;
    readonly title: string;
    readonly revision?: ReadOnlyRevisionToken;
    readonly dateCreated?: number;
    readonly dateModified?: number;
    readonly notebookId?: string;
    readonly pinned?: boolean;
    readonly favorite?: boolean;
    readonly localOnly?: boolean;
    readonly conflicted?: boolean;
    readonly locked?: boolean;
  } = { id, title };
  if (typeof dateCreated === "number" && Number.isFinite(dateCreated) && dateCreated >= 0) {
    (out as { dateCreated?: number }).dateCreated = dateCreated;
  }
  if (typeof dateModified === "number" && Number.isFinite(dateModified) && dateModified >= 0) {
    (out as { dateModified?: number }).dateModified = dateModified;
  }
  if (
    includeRevision &&
    typeof dateEdited === "number" &&
    Number.isFinite(dateEdited) &&
    dateEdited >= 0
  ) {
    try {
      (out as { revision?: ReadOnlyRevisionToken }).revision = createReadOnlyRevisionToken(
        id,
        dateEdited,
      );
    } catch {
      throw projectionError("Notesnook read-only projection: note revision token rejected");
    }
  }
  if (typeof notebookId === "string" && notebookId.length > 0) {
    (out as { notebookId?: string }).notebookId = notebookId;
  }
  if (typeof pinned === "boolean") (out as { pinned?: boolean }).pinned = pinned;
  if (typeof favorite === "boolean") (out as { favorite?: boolean }).favorite = favorite;
  if (typeof localOnly === "boolean") (out as { localOnly?: boolean }).localOnly = localOnly;
  if (typeof conflicted === "boolean") (out as { conflicted?: boolean }).conflicted = conflicted;
  return out;
}

function readOptionalContentFindByNoteId(
  source: NotesnookReadOnlyProjectionSource,
): ((...args: unknown[]) => unknown) | undefined {
  let content: unknown;
  try {
    content = (source as unknown as Record<string, unknown>).content;
  } catch {
    throw projectionError("Notesnook read-only projection: content slot getter threw");
  }
  if (content === undefined || content === null) return undefined;
  if (typeof content !== "object") {
    throw projectionError("Notesnook read-only projection: content slot is not an object");
  }
  return readManagerMethod(
    content as Record<string, unknown>,
    "findByNoteId",
    "Notesnook read-only projection: content.findByNoteId is unavailable",
  );
}

async function readLockedState(
  findByNoteId: ((...args: unknown[]) => unknown) | undefined,
  id: string,
): Promise<boolean | undefined> {
  if (findByNoteId === undefined) return undefined;
  let content: unknown;
  try {
    content = await findByNoteId(id);
  } catch (error) {
    // Notesnook can refuse the content lookup for a locked note before it
    // returns the metadata marker.  That refusal is still useful metadata:
    // preserve the closed lock state without exposing the upstream error.
    if (isVaultLockedRefusal(error)) return true;
    throw projectionError("Notesnook read-only projection: content.findByNoteId rejected");
  }
  if (content === undefined || content === null) return undefined;
  if (typeof content !== "object") {
    throw projectionError("Notesnook read-only projection: content record is not an object");
  }
  let locked: unknown;
  try {
    locked = (content as Record<string, unknown>).locked;
  } catch {
    throw projectionError("Notesnook read-only projection: content lock marker getter threw");
  }
  if (locked === undefined) return undefined;
  if (typeof locked !== "boolean") {
    throw projectionError("Notesnook read-only projection: content lock marker is invalid");
  }
  return locked;
}

function isVaultLockedRefusal(error: unknown): boolean {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return false;
  }
  if (isNotesnookReadOnlyAdapterError(error)) {
    try {
      return error.message === "vault_locked";
    } catch {
      return false;
    }
  }
  try {
    // The raw upstream vocabulary is pinned to @notesnook/core@8.1.3.
    // The internal `vault_locked` form is accepted only above through the
    // identity-verified adapter predicate.
    const code = (error as { code?: unknown }).code;
    return code === "ERR_VAULT_LOCKED";
  } catch {
    return false;
  }
}
