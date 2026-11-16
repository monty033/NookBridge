/**
 * Minimal in-memory stand-in for the pinned `@notesnook/core` surface that the
 * read-only projection consumes, shaped so each of the three "bodyless note"
 * signals can be varied independently:
 *
 *   1. a content record (`content.findByNoteId`),
 *   2. the note record's `contentId`,
 *   3. vault links (`relations.to({ id, type: "note" }, "vault").count()`).
 *
 * Nothing here touches disk, the network, or any live state.
 */

export interface FakeNote {
  readonly id: string;
  readonly title: string;
  /** Notebook the note is attached to; absent means root level. */
  readonly notebookId?: string;
  /** `contentId` on the note record. Omitted means the property is missing. */
  readonly contentId?: unknown;
  /** The content record, or `undefined`/`null` for "no content record". */
  readonly content?: unknown;
  /**
   * Vault links on the note.  A removed link cannot be represented here: core
   * nulls its `fromId`/`toId` columns, so it simply stops matching the count
   * query.  A plain counter therefore only ever holds live links.
   */
  readonly vaultLinks?: number;
  /** Record-level `locked` marker on the note itself (metadata fallback). */
  readonly locked?: boolean;
}

export interface FakeNotebook {
  readonly id: string;
  readonly title: string;
}

export interface FakeCoreOptions {
  readonly notes: readonly FakeNote[];
  readonly notebooks?: readonly FakeNotebook[];
  /** Replace `relations.to` (e.g. to make it throw or return a bad value). */
  readonly relationsTo?: (reference: unknown, type: unknown) => unknown;
  /** Drop `content.findByNoteId`, modelling a projection that cannot probe. */
  readonly omitContentFind?: boolean;
  /** Drop the whole `relations` slot, or only its `to` method. */
  readonly omitRelations?: boolean;
  readonly omitRelationsTo?: boolean;
}

export function makeFakeCore(options: FakeCoreOptions): object {
  const notebooks = options.notebooks ?? [];
  const byId = new Map(options.notes.map((note) => [note.id, note]));
  const noteIdsIn = (notebookId: string): string[] =>
    options.notes.filter((note) => note.notebookId === notebookId).map((note) => note.id);

  const relationsTo =
    options.relationsTo ??
    ((reference: unknown, type: unknown) => {
      const id = (reference as { id: string }).id;
      if (type !== "vault") throw new Error("unexpected relation type");
      return {
        // Mirrors core: `unlink()` REPLACEs the row with only id, dateModified,
        // deleted and synced, so the link columns are NULL and the lookup
        // query cannot match it.  Unlinked rows are not counted.
        count: async () => byId.get(id)?.vaultLinks ?? 0,
      };
    });

  const relations = options.omitRelations
    ? undefined
    : {
        from: (reference: { id: string }, type: string) => {
          if (type !== "note") throw new Error("unexpected relation type");
          return { has: async (noteId: string) => noteIdsIn(reference.id).includes(noteId) };
        },
        ...(options.omitRelationsTo ? {} : { to: relationsTo }),
      };

  const searchResults = (ids: readonly string[]) => ({
    ids: async () => [...ids],
    items: async (limit?: number) =>
      ids.slice(0, limit).map((id) => ({ id, title: byId.get(id)?.title ?? "" })),
  });

  return {
    syncer: { start: async () => true },
    lastSynced: async () => 0,
    hasUnsyncedChanges: async () => false,
    notes: {
      all: { ids: async () => options.notes.map((note) => note.id) },
      note: async (id: string) => {
        const note = byId.get(id);
        if (note === undefined) return undefined;
        const record: Record<string, unknown> = { id: note.id, title: note.title };
        if ("contentId" in note) record.contentId = note.contentId;
        if (note.locked !== undefined) record.locked = note.locked;
        return record;
      },
    },
    notebooks: {
      all: { ids: async () => notebooks.map((notebook) => notebook.id) },
      notebook: async (id: string) => notebooks.find((notebook) => notebook.id === id),
      notes: async (id: string) => noteIdsIn(id),
      breadcrumbs: async (id: string) => {
        const notebook = notebooks.find((candidate) => candidate.id === id);
        return notebook === undefined ? [] : [{ id: notebook.id, title: notebook.title }];
      },
    },
    lookup: {
      notes: () => searchResults(options.notes.map((note) => note.id)),
      notebooks: () => searchResults([]),
    },
    ...(options.omitContentFind
      ? {}
      : {
          content: {
            findByNoteId: async (id: string) => byId.get(id)?.content ?? undefined,
          },
        }),
    ...(relations === undefined ? {} : { relations }),
  };
}

export const LIVE_CONTENT = Object.freeze({ type: "tiptap", data: "<p>Body</p>", locked: false });
