/**
 * Stage 5 — issue #305: copy/original re-check (bounded re-read).
 *
 * Offline tests for the keep-both resolver's three new copy re-checks. The
 * injected seam is the same in-memory store used by
 * `tests/stage-5-conflict-resolve.test.ts`, replicated here so the new file
 * stands on its own.
 */

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";

import {
  createNotesnookConflictResolver,
  type NotesnookConflictResolveSeam,
} from "../src/core/notesnook-conflict-resolve-wiring.js";
import { serializeRpcResponse } from "../src/service/rpc-protocol.js";

const LOCAL_BODY = '<p data-block-id="l1">local edit</p>';
const REMOTE_BODY = '<p data-block-id="r1">remote edit</p>';
const REMOTE_DATE = 2_000;
const NOTEBOOK = "nb-work";
const TAGS = ["tag-a", "tag-b"];
const MEMBERSHIPS: ReadonlyArray<Readonly<{ type: "notebook" | "tag"; id: string }>> = [
  { type: "notebook", id: NOTEBOOK },
  ...TAGS.map((id) => ({ type: "tag" as const, id })),
];
const ZERO_BINDING = "0".repeat(64);

type SlotName = keyof NotesnookConflictResolveSeam;
type Row = Record<string, unknown>;

type StoreOptions = Readonly<{
  note?: Row;
  content?: Row;
  noteAbsent?: boolean;
  trashed?: boolean;
  throwOn?: ReadonlyArray<SlotName>;
  copyTransform?: (data: string) => string;
  afterCopy?: (contents: Map<string, Row>) => void;
  dateShift?: number;
  resolvedMarker?: "null" | "absent" | "false" | "true" | "text";
  copyReturnsId?: string;
  foreignNote?: boolean;
  resolvedRow?: Row;
  dropMembership?: string;
  copyNoteIdOverride?: string;
  copyContentIdOverride?: string;
  originalNoteIdOverride?: string;
  afterClear?: (notes: Map<string, Row>) => void;
}>;

type Store = Readonly<{
  seam: NotesnookConflictResolveSeam;
  calls: Array<Readonly<{ slot: SlotName; arg: unknown }>>;
  failing: Set<SlotName>;
  notes: Map<string, Row>;
  contents: Map<string, Row>;
}>;

function remoteSide(overrides: Row = {}): Row {
  return {
    id: "content-1",
    noteId: "note-1",
    type: "tiptap",
    locked: false,
    data: REMOTE_BODY,
    dateModified: REMOTE_DATE,
    ...overrides,
  };
}

function originalNote(overrides: Row = {}): Row {
  return {
    id: "note-1",
    title: "Field notes",
    contentId: "content-1",
    conflicted: true,
    memberships: MEMBERSHIPS.map((membership) => ({ ...membership })),
    ...overrides,
  };
}

function originalContent(overrides: Row = {}): Row {
  return {
    id: "content-1",
    noteId: "note-1",
    type: "tiptap",
    locked: false,
    data: LOCAL_BODY,
    dateModified: 1_000,
    dateResolved: null,
    conflicted: remoteSide(),
    ...overrides,
  };
}

function copyRows(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function applyResolvedMarker(
  row: Row,
  marker: "null" | "absent" | "false" | "true" | "text",
): void {
  switch (marker) {
    case "absent":
      delete row.conflicted;
      return;
    case "null":
      row.conflicted = null;
      return;
    case "false":
      row.conflicted = false;
      return;
    case "true":
      row.conflicted = true;
      return;
    case "text":
      row.conflicted = "x";
      return;
  }
}

function createStore(options: StoreOptions = {}): Store {
  const notes = new Map<string, Row>();
  const contents = new Map<string, Row>();
  const trashed = new Set<string>();
  const calls: Array<Readonly<{ slot: SlotName; arg: unknown }>> = [];
  const failing = new Set<SlotName>(options.throwOn ?? []);

  if (options.noteAbsent !== true) {
    const note = originalNote(options.note);
    notes.set("note-1", {
      ...note,
      ...(options.originalNoteIdOverride === undefined
        ? {}
        : { id: options.originalNoteIdOverride }),
    });
  }
  if (options.trashed === true) trashed.add("note-1");
  contents.set("content-1", originalContent(options.content));
  if (options.foreignNote === true) {
    notes.set("note-other", {
      id: "note-other",
      title: "Unrelated",
      contentId: "content-other",
      conflicted: false,
      memberships: [],
    });
    contents.set("content-other", {
      id: "content-other",
      noteId: "note-other",
      type: "tiptap",
      locked: false,
      data: LOCAL_BODY,
      dateModified: 1_000,
      dateResolved: null,
      conflicted: null,
    });
  }

  const record = (slot: SlotName, arg: unknown): void => {
    calls.push(Object.freeze({ slot, arg: copyRows(arg) }));
  };
  const fail = (slot: SlotName): void => {
    if (failing.has(slot)) throw new Error("SECRET");
  };

  const seam: NotesnookConflictResolveSeam = {
    noteMeta: async (id) => {
      record("noteMeta", id);
      fail("noteMeta");
      const note = notes.get(id);
      if (note === undefined || trashed.has(id)) return undefined;
      return copyRows(note);
    },
    contentWithConflicted: async (contentId) => {
      record("contentWithConflicted", contentId);
      fail("contentWithConflicted");
      const row = contents.get(contentId);
      return row === undefined ? undefined : copyRows(row);
    },
    notesAddVerbatim: async (input) => {
      record("notesAddVerbatim", input);
      fail("notesAddVerbatim");
      const copyId = "note-copy-1";
      const copyContentId = "content-copy-1";
      const copyData = options.copyTransform?.(input.content.data) ?? input.content.data;
      contents.set(copyContentId, {
        id: copyContentId,
        noteId: copyId,
        type: input.content.type,
        locked: false,
        data: copyData,
        dateModified: 3_000,
        dateEdited: 3_000,
        dateResolved: null,
        conflicted: null,
      });
      notes.set(copyId, {
        id: copyId,
        title: input.title,
        contentId: copyContentId,
        conflicted: false,
        memberships: [],
        dateEdited: 3_000,
        dateModified: 3_000,
      });
      if (options.copyNoteIdOverride !== undefined) {
        const created = notes.get(copyId);
        if (created !== undefined) {
          notes.set(copyId, { ...created, id: options.copyNoteIdOverride });
        }
      }
      if (options.copyContentIdOverride !== undefined) {
        const created = contents.get(copyContentId);
        if (created !== undefined) {
          contents.set(copyContentId, { ...created, id: options.copyContentIdOverride });
        }
      }
      options.afterCopy?.(contents);
      return options.copyReturnsId ?? copyId;
    },
    contentResolve: async (input) => {
      record("contentResolve", input);
      fail("contentResolve");
      const row = contents.get(input.id);
      if (row === undefined) throw new Error("missing content");
      row.data = input.data;
      applyResolvedMarker(row, options.resolvedMarker ?? "null");
      row.dateResolved = input.dateResolved + (options.dateShift ?? 0);
      Object.assign(row, options.resolvedRow ?? {});
    },
    noteClearConflict: async (id) => {
      record("noteClearConflict", id);
      fail("noteClearConflict");
      const note = notes.get(id);
      if (note === undefined) throw new Error("missing note");
      note.conflicted = false;
      options.afterClear?.(notes);
    },
    noteRelate: async (input) => {
      record("noteRelate", input);
      fail("noteRelate");
      const note = notes.get(input.noteId);
      if (note === undefined) throw new Error("missing note");
      if (input.to.id === options.dropMembership) return;
      const current = Array.isArray(note.memberships) ? note.memberships : [];
      note.memberships = [...current, { ...input.to }];
    },
    noteRelations: async (noteId) => {
      record("noteRelations", noteId);
      fail("noteRelations");
      const note = notes.get(noteId);
      if (note === undefined) return undefined;
      return copyRows(Array.isArray(note.memberships) ? note.memberships : []);
    },
  };

  return { seam, calls, failing, notes, contents };
}

import { createNotesnookLocalConflictInspector } from "../src/core/notesnook-local-conflict-projection.js";

async function bindingOf(store: Store): Promise<string> {
  const inspector = createNotesnookLocalConflictInspector({
    notes: { note: (id: string) => store.seam.noteMeta(id) },
    contentWithConflicted: { get: (id: string) => store.seam.contentWithConflicted(id) },
  });
  const result = await inspector.inspectConflict("note-1");
  return result.outcome === "inspected" ? result.binding : ZERO_BINDING;
}

async function resolveOriginal(
  store: Store,
  expectedBinding: string,
  seamOverride?: NotesnookConflictResolveSeam,
) {
  const resolver = createNotesnookConflictResolver(seamOverride ?? store.seam);
  return resolver.resolveKeepBoth("note-1", expectedBinding);
}

function wrapSeam(
  store: Store,
  overrides: Partial<NotesnookConflictResolveSeam>,
): NotesnookConflictResolveSeam {
  return { ...store.seam, ...overrides } as NotesnookConflictResolveSeam;
}

describe("Stage 5 issue 305 — copy re-check", () => {
  it("happy path: unchanged copy returns resolved", async () => {
    const store = createStore();
    const binding = await bindingOf(store);
    store.calls.splice(0);

    const result = await resolveOriginal(store, binding);

    expect(result).toEqual({
      outcome: "resolved",
      originalTitle: "Field notes",
      copyTitle: "Field notes (bridge copy)",
    });
    expect(store.notes.get("note-1")).toMatchObject({ conflicted: false });
    expect(store.contents.get("content-1")).toMatchObject({
      data: REMOTE_BODY,
      dateResolved: REMOTE_DATE,
    });
    expect(store.notes.get("note-copy-1")).toBeDefined();
    expect(store.notes.get("note-copy-1")?.memberships).toEqual(MEMBERSHIPS);
    const flag = store.notes.get("note-1")?.conflicted;
    expect(flag).toBe(false);
  });

  it("mutating the copy before step 6 returns copy_changed and leaves the flag set", async () => {
    const store = createStore();
    const binding = await bindingOf(store);
    store.calls.splice(0);

    let related = false;
    const seam = wrapSeam(store, {
      noteRelations: async (id) => {
        const r = await store.seam.noteRelations(id);
        if (!related && id === "note-copy-1") {
          related = true;
          const note = store.notes.get("note-copy-1");
          if (note !== undefined) note.title = "changed";
        }
        return r;
      },
    });

    const result = await resolveOriginal(store, binding, seam);

    expect(result).toEqual({ outcome: "copy_changed" });
    expect(store.notes.get("note-1")).toMatchObject({ conflicted: true });
    expect(store.calls.map((c) => c.slot)).not.toContain("contentResolve");
    // neither side trashed: both notes still present
    expect(store.notes.has("note-1")).toBe(true);
    expect(store.notes.has("note-copy-1")).toBe(true);
  });

  it("mutating the copy after step 6 returns copy_changed and does not clear the flag", async () => {
    const store = createStore();
    const binding = await bindingOf(store);
    store.calls.splice(0);

    const seam = wrapSeam(store, {
      contentResolve: async (input) => {
        const r = await store.seam.contentResolve(input);
        const row = store.contents.get("content-copy-1");
        if (row !== undefined) row.data = "changed";
        return r;
      },
    });

    const result = await resolveOriginal(store, binding, seam);

    expect(result).toEqual({ outcome: "copy_changed" });
    expect(store.notes.get("note-1")).toMatchObject({ conflicted: true });
    expect(store.calls.map((c) => c.slot)).toContain("contentResolve");
    expect(store.calls.map((c) => c.slot)).not.toContain("noteClearConflict");
    expect(store.notes.has("note-copy-1")).toBe(true);
  });

  it("mutating the copy after step 7 returns copy_changed", async () => {
    const store = createStore();
    const binding = await bindingOf(store);
    store.calls.splice(0);

    const seam = wrapSeam(store, {
      noteClearConflict: async (id) => {
        const r = await store.seam.noteClearConflict(id);
        const row = store.contents.get("content-copy-1");
        if (row !== undefined) row.data = "changed";
        return r;
      },
    });

    const result = await resolveOriginal(store, binding, seam);

    expect(result).toEqual({ outcome: "copy_changed" });
    expect(store.calls.map((c) => c.slot)).toContain("noteClearConflict");
    expect(store.notes.has("note-copy-1")).toBe(true);
  });

  it("a reverted text change (only the timestamp moves) still counts as copy_changed", async () => {
    const store = createStore();
    const binding = await bindingOf(store);
    store.calls.splice(0);

    let related = false;
    const seam = wrapSeam(store, {
      noteRelations: async (id) => {
        const r = await store.seam.noteRelations(id);
        if (!related && id === "note-copy-1") {
          related = true;
          const row = store.contents.get("content-copy-1");
          if (row !== undefined) {
            row.data = LOCAL_BODY; // restored
            row.dateEdited = 9_999; // only dateEdited moves
          }
          const note = store.notes.get("note-copy-1");
          if (note !== undefined) {
            note.dateEdited = 9_999; // only dateEdited moves
          }
        }
        return r;
      },
    });

    const result = await resolveOriginal(store, binding, seam);

    expect(result).toEqual({ outcome: "copy_changed" });
  });

  it("a reverted text change (only dateModified moves) still counts as copy_changed", async () => {
    const store = createStore();
    const binding = await bindingOf(store);
    store.calls.splice(0);

    let related = false;
    const seam = wrapSeam(store, {
      noteRelations: async (id) => {
        const r = await store.seam.noteRelations(id);
        if (!related && id === "note-copy-1") {
          related = true;
          const row = store.contents.get("content-copy-1");
          if (row !== undefined) {
            row.data = LOCAL_BODY; // restored
            row.dateModified = 9_999; // only dateModified moves
          }
        }
        return r;
      },
    });

    const result = await resolveOriginal(store, binding, seam);

    expect(result).toEqual({ outcome: "copy_changed" });
  });

  it("a membership removed after step 4b counts as copy_changed", async () => {
    const store = createStore();
    const binding = await bindingOf(store);
    store.calls.splice(0);

    let calls = 0;
    const seam = wrapSeam(store, {
      noteRelations: async (id) => {
        const r = await store.seam.noteRelations(id);
        if (id === "note-copy-1") {
          calls += 1;
          if (calls === 2) {
            const note = store.notes.get("note-copy-1");
            if (note !== undefined && Array.isArray(note.memberships)) {
              note.memberships = (note.memberships as Row[]).filter((m) => m.id !== "tag-b");
            }
          }
        }
        return r;
      },
    });

    const result = await resolveOriginal(store, binding, seam);

    expect(result).toEqual({ outcome: "copy_changed" });
  });

  it("a read failure at the second re-check is a closed outcome, not a thrown error", async () => {
    const store = createStore();
    const binding = await bindingOf(store);
    store.calls.splice(0);

    let noteMetaCalls = 0;
    const seam = wrapSeam(store, {
      noteMeta: async (id) => {
        noteMetaCalls += 1;
        if (noteMetaCalls === 5) {
          throw new Error("SECRET");
        }
        return store.seam.noteMeta(id);
      },
    });

    const result = await resolveOriginal(store, binding, seam);

    expect(result).toEqual({ outcome: "read_failed" });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(store.notes.get("note-1")).toMatchObject({ conflicted: true });
    expect(store.calls.map((c) => c.slot)).toContain("contentResolve");
    expect(store.calls.map((c) => c.slot)).not.toContain("noteClearConflict");
    expect(store.notes.has("note-1")).toBe(true);
    expect(store.notes.has("note-copy-1")).toBe(true);
  });

  it("copy_changed is a closed outcome: serializer accepts it and rejects unknown, no body", () => {
    const ok = () =>
      serializeRpcResponse({
        id: "r-1",
        ok: true,
        result: { kind: "conflict-resolve", outcome: "copy_changed" },
      });
    expect(() => ok()).not.toThrow();

    const bytes = ok();
    const text = Buffer.from(bytes).slice(4).toString("utf8");
    const parsed = JSON.parse(text);
    const env = parsed as { ok: boolean; result: { kind: string; outcome: string } };
    // serializer accepts copy_changed and carries no body
    expect(env.ok).toBe(true);
    expect(env.result).toEqual({ kind: "conflict-resolve", outcome: "copy_changed" });

    expect(() =>
      serializeRpcResponse({
        id: "r-2",
        ok: true,
        result: { kind: "conflict-resolve", outcome: "not-a-real-outcome" },
      }),
    ).toThrow();
  });
});
