/**
 * Stage 5 slice B — the live keep-both seam, built from the raw database.
 *
 * Each of the six slots of `NotesnookConflictResolveSeam` is a thin call on
 * one pinned core method, read through `Reflect` the way the other optional
 * capabilities read theirs. The builder returns `undefined` when any required
 * method is missing, so a database without the full surface never exposes the
 * capability and never throws during login.
 *
 * Deliberately absent:
 *   - `content.get` and `content.findByNoteId` (both run `preProcess` and
 *     persist the rewritten row) and `content.update` / `collection.update`;
 *   - `addToNotebook` and the deprecated `Note.tags` / `Note.notebooks`
 *     fields: membership is read and written only as relations;
 *   - any delete, trash, sync, or generic-write slot.
 *
 * The caller holds the database mutex for the whole resolve (see
 * {@link buildOptionalLiveConflictResolveCapability}).
 */

import { withMutex } from "./notesnook-database-mutex.js";
import type {
  NotesnookConflictContentResolveInput,
  NotesnookConflictCopyInput,
  NotesnookConflictMembership,
  NotesnookConflictRelateInput,
  NotesnookConflictResolveSeam,
} from "./notesnook-conflict-resolve-wiring.js";
import type {
  NotesnookRecoveryJournal,
  NotesnookRecoveryStage,
} from "./notesnook-recovery-journal.js";
import type { SyncCoordinator } from "./notesnook-sync-coordinator.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** Upper bound on the relations one note read may return, mirroring the write wiring. */
const MAX_RELATION_ROWS = 4096;

/** Everything the daemon needs to run one keep-both resolve under the database mutex. */
export type LiveConflictResolveCapability = Readonly<{
  readonly seam: NotesnookConflictResolveSeam;
  readonly journal: NotesnookRecoveryJournal & {
    readonly discard: (noteId: string, stages: ReadonlyArray<NotesnookRecoveryStage>) => number;
  };
  /** Run `fn` under the database's exclusive mutex. */
  readonly runExclusive: <T>(label: string, fn: () => T | PromiseLike<T>) => Promise<T>;
  /** Record an operator-origin pending marker. Throws when it cannot be recorded. */
  readonly markPending: (noteId: string) => void;
}>;

type Owner = object;
type Fn = (...args: unknown[]) => unknown;

function slotOf(owner: unknown, key: string): unknown {
  if (owner === null || (typeof owner !== "object" && typeof owner !== "function")) {
    return undefined;
  }
  try {
    return Reflect.get(owner, key);
  } catch {
    return undefined;
  }
}

function methodOf(owner: unknown, key: string): Fn | undefined {
  const value = slotOf(owner, key);
  return typeof value === "function" ? (value as Fn) : undefined;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error("conflict resolve identifier is invalid");
  }
  return value;
}

/** Relation rows of one note, keeping only notebook and tag memberships. */
function membershipsOf(rows: unknown, noteId: string): NotesnookConflictMembership[] {
  if (!Array.isArray(rows) || rows.length > MAX_RELATION_ROWS) {
    throw new Error("conflict resolve relations are malformed");
  }
  const memberships: NotesnookConflictMembership[] = [];
  for (const row of rows as unknown[]) {
    const fromId = slotOf(row, "fromId");
    const fromType = slotOf(row, "fromType");
    const toId = slotOf(row, "toId");
    const toType = slotOf(row, "toType");
    if (fromId !== noteId || fromType !== "note") {
      throw new Error("conflict resolve relations are malformed");
    }
    if (toType === "notebook" || toType === "tag") {
      memberships.push(Object.freeze({ type: toType, id: identifier(toId) }));
    }
  }
  return memberships;
}

/**
 * Build the six-slot seam from the raw database, or `undefined` when any of the
 * methods it needs is missing. Nothing is called during construction.
 */
export function buildLiveConflictResolveSeam(
  database: Owner,
  ensureOpen: () => void,
): NotesnookConflictResolveSeam | undefined {
  const notes = slotOf(database, "notes");
  const content = slotOf(database, "content");
  const relations = slotOf(database, "relations");
  const collection = slotOf(content, "collection");
  const noteRead = methodOf(notes, "note");
  const noteAdd = methodOf(notes, "add");
  const collectionGet = methodOf(collection, "get");
  const contentAdd = methodOf(content, "add");
  const relationsAdd = methodOf(relations, "add");
  const relationsFrom = methodOf(relations, "from");
  if (
    noteRead === undefined ||
    noteAdd === undefined ||
    collectionGet === undefined ||
    contentAdd === undefined ||
    relationsAdd === undefined ||
    relationsFrom === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    noteMeta: async (id: string) => {
      ensureOpen();
      const note = await Reflect.apply(noteRead, notes, [id]);
      if (note === null || typeof note !== "object") return undefined;
      const handle = Reflect.apply(relationsFrom, relations, [{ id, type: "note" }]);
      const get = methodOf(handle, "get");
      if (get === undefined) throw new Error("conflict resolve relation reader is unavailable");
      const rows = await Reflect.apply(get, handle, []);
      const memberships = membershipsOf(rows, id);
      // Prototype-linked, so a class-backed row keeps its getters; the
      // memberships array is the one own field this seam adds.
      return Object.create(note, {
        memberships: { value: Object.freeze(memberships), enumerable: true },
      });
    },
    contentWithConflicted: async (contentId: string) => {
      ensureOpen();
      return await Reflect.apply(collectionGet, collection, [contentId]);
    },
    notesAddVerbatim: async (input: NotesnookConflictCopyInput) => {
      ensureOpen();
      if (input.content.type !== "tiptap" || typeof input.content.data !== "string") {
        throw new Error("conflict resolve copy content is invalid");
      }
      // Mirrors the create path's `notes.add` shape. The local side is written
      // as given; read-back in the resolver is the check that nothing altered it.
      return await Reflect.apply(noteAdd, notes, [
        {
          title: input.title,
          content: { id: "", noteId: "", type: "tiptap", data: input.content.data },
        },
      ]);
    },
    contentResolve: async (input: NotesnookConflictContentResolveInput) => {
      ensureOpen();
      // The exact allowlist. `content.add` with no `type` skips `postProcess`.
      const record = {
        id: input.id,
        noteId: input.noteId,
        data: input.data,
        dateResolved: input.dateResolved,
      };
      return await Reflect.apply(contentAdd, content, [record]);
    },
    noteClearConflict: async (id: string) => {
      ensureOpen();
      return await Reflect.apply(noteAdd, notes, [{ id, conflicted: false }]);
    },
    noteRelate: async (input: NotesnookConflictRelateInput) => {
      ensureOpen();
      const type: unknown = input.to.type;
      if (type !== "notebook" && type !== "tag") {
        throw new Error("conflict resolve relation type is refused");
      }
      await Reflect.apply(relationsAdd, relations, [
        { id: identifier(input.noteId), type: "note" },
        { id: identifier(input.to.id), type },
      ]);
    },
  }) as NotesnookConflictResolveSeam;
}

/**
 * The optional capability. Returns `undefined`, never throws, when the seam,
 * the journal's `discard`, or the shared coordinator is unavailable.
 */
export function buildOptionalLiveConflictResolveCapability(input: {
  database: Owner;
  ensureOpen: () => void;
  journal: NotesnookRecoveryJournal | undefined;
  coordinator: Pick<SyncCoordinator, "recordLocalCommit"> | undefined;
}): LiveConflictResolveCapability | undefined {
  try {
    const { database, ensureOpen, journal, coordinator } = input;
    if (journal === undefined || typeof journal.discard !== "function") return undefined;
    if (coordinator === undefined) return undefined;
    const seam = buildLiveConflictResolveSeam(database, ensureOpen);
    if (seam === undefined) return undefined;
    return Object.freeze({
      seam,
      journal: journal as LiveConflictResolveCapability["journal"],
      runExclusive: <T>(label: string, fn: () => T | PromiseLike<T>) =>
        withMutex(database, label, fn),
      markPending: (noteId: string) => {
        coordinator.recordLocalCommit({
          operation: "update",
          id: noteId,
          localCommitted: true,
          remoteSynced: false,
          pendingSync: true,
          origin: "operator",
        });
      },
    });
  } catch {
    return undefined;
  }
}
