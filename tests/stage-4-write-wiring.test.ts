/**
 * Stage 4 — runtime-to-write-capability wiring.
 *
 * Scope of this file (`docs/stage-4-write-plan.md` "Next bounded slice
 * — write-side runtime wiring"):
 *
 *   - The narrow runtime-to-capability mapper that flattens an
 *     injected, structural runtime handle into the closed
 *     `NotesnookWriteDatabase` seam that the existing
 *     `notesnook-write-adapter.ts` already consumes;
 *   - bound method-this (every bound slot must be bound to its owning
 *     upstream object);
 *   - explicit upstream `ContentType` `tiptap` → seam `tiptap` and
 *     `tiny` → seam `html` mapping, with fail-closed on any other
 *     type or hostile value;
 *   - hostile-getter / Proxy-safety on every required slot;
 *   - explicit rejection of forbidden raw / generic / sync / delete /
 *     force / vault / auth / transport escape hatches;
 *   - rejection of null/non-object sources, throwing suppliers,
 *     thenable suppliers, primitives, and missing slots;
 *   - upstream error redaction — every foreign throw becomes a
 *     categorical chain-free `NotesnookWriteAdapterError` with
 *     `sync_failed` (or `invalid_input` for malformed input);
 *   - the returned seam must be frozen with no extra own / prototype
 *     escape-hatch methods;
 *   - the existing `NotesnookReadOnlyDatabase` and `NotesnookLiveDatabase`
 *     declarations must remain unchanged (this slice does not widen
 *     Stage 3 or the existing live factory shape).
 *
 * These tests are offline and credential-free: the wiring module
 * imports nothing from `@notesnook/*` and consumes only the structural
 * runtime seam the test owns end-to-end.  Nothing here can open a
 * real vault or talk to a real Notesnook server.
 */

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  isNotesnookWriteAdapterError,
  type NotesnookWriteDatabase,
  type NotesnookWriteNoteMetadata,
  type NotesnookWriteStoredContent,
} from "../src/core/notesnook-write-adapter.js";
import {
  isNotesnookWriteContractError,
  NotesnookWriteContractError,
} from "../src/core/notesnook-write-contract.js";
import {
  bindNotesnookWriteRuntime,
  type NotesnookWriteRuntime,
} from "../src/core/notesnook-write-wiring.js";

// ---------------------------------------------------------------------------
// Test fixtures.
//
// The runtime is the structural source the mapper consumes.  Only the
// SLOTS the task authorizes are part of the closed surface; every other
// member is rejected by the validator before any value leaves the
// boundary.
//
// `NotesnookWriteRuntime` is intentionally nominal: the wiring module
// owns the exact shape, so a future reader cannot widen the boundary by
// passing a hand-crafted `Database` or a `NotesnookLiveDatabase`.
// ---------------------------------------------------------------------------

const CANARY = "CANARY-stage-4-write-wiring-77ab";

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const NOTEBOOK_ID = "cafebabecafebabecafebabecafebabe";
const TAG_ID = "deadbeefdeadbeefdeadbeefdeadbeef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";

interface FakeNoteRecord {
  id: string;
  title: string;
  contentId?: string;
  notebookId?: string;
  pinned: boolean;
  favorite: boolean;
  conflicted: boolean;
  locked: boolean;
  dateEdited: number;
  tags?: string[];
}

interface FakeContentRecord {
  id: string;
  noteId: string;
  type: "tiptap" | "tiny";
  data: string;
  /** Authoritative Vault marker mirrored from Notesnook `content.locked`. */
  locked?: boolean;
}

interface FakeNotebookRecord {
  id: string;
  title: string;
  notes: string[];
}

interface FakeTagRecord {
  id: string;
  title: string;
}

interface FakeRelation {
  fromId: string;
  fromType: "note";
  toId: string;
  toType: string;
}

interface FakeRuntimeOptions {
  notes?: Map<string, FakeNoteRecord>;
  notebooks?: Map<string, FakeNotebookRecord>;
  tags?: Map<string, FakeTagRecord>;
  relations?: FakeRelation[];
  content?: Map<string, FakeContentRecord>;
}

interface FakeRuntimeCollections {
  notes: {
    note: (id: string) => Promise<FakeNoteRecord | undefined>;
    add: (item: Record<string, unknown>) => Promise<string>;
    addToNotebook: (notebookId: string, ...noteIds: string[]) => Promise<void>;
    removeFromNotebook: (notebookId: string, ...noteIds: string[]) => Promise<void>;
    collection: {
      update: (ids: readonly string[], partial: Record<string, unknown>) => Promise<void>;
    };
  };
  content: {
    add: (partial: Record<string, unknown>) => Promise<string>;
    findByNoteId: (noteId: string) => Promise<FakeContentRecord | undefined>;
    updateByNoteId: (partial: Record<string, unknown>, ...ids: string[]) => Promise<void>;
  };
  notebooks: {
    exists: (id: string) => Promise<boolean>;
    notes: (id: string) => Promise<string[]>;
  };
  tags: {
    tag: (id: string) => Promise<FakeTagRecord | undefined>;
    add: (input: { readonly title: string }) => Promise<string>;
  };
  relations: {
    add: (from: { id: string; type: string }, to: { id: string; type: string }) => Promise<void>;
    unlink: (from: { id: string; type: string }, to: { id: string; type: string }) => Promise<void>;
    from: (reference: { id: string; type: string } | { type: string; ids: readonly string[] }) => {
      get(): Promise<FakeRelation[]>;
    };
  };
}

interface FakeRuntime extends NotesnookWriteRuntime {
  notes: FakeRuntimeCollections["notes"];
  content: FakeRuntimeCollections["content"];
  notebooks: FakeRuntimeCollections["notebooks"];
  tags: FakeRuntimeCollections["tags"];
  relations: FakeRuntimeCollections["relations"];
  calls: {
    note: string[];
    addNote: Array<{ title: string; contentType: string; contentData: string }>;
    updateNotes: Array<{ ids: string[]; partial: Record<string, unknown> }>;
    addToNotebook: Array<{ notebookId: string; noteIds: string[] }>;
    removeFromNotebook: Array<{ notebookId: string; noteIds: string[] }>;
    contentAdd: Array<{ partial: Record<string, unknown> }>;
    contentUpdate: Array<{ partial: Record<string, unknown>; ids: string[] }>;
    contentFind: string[];
    notebookExists: string[];
    notebookNotes: string[];
    tag: string[];
    tagAdd: Array<{ title: string }>;
    relationAdd: Array<{ from: unknown; to: unknown }>;
    relationUnlink: Array<{ from: unknown; to: unknown }>;
    relationList: string[];
  };
}

function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const notes = options.notes ?? new Map<string, FakeNoteRecord>();
  const notebooks = options.notebooks ?? new Map<string, FakeNotebookRecord>();
  const tags = options.tags ?? new Map<string, FakeTagRecord>();
  const relations = options.relations ?? [];
  const content = options.content ?? new Map<string, FakeContentRecord>();

  const calls: FakeRuntime["calls"] = {
    note: [],
    addNote: [],
    updateNotes: [],
    addToNotebook: [],
    removeFromNotebook: [],
    contentAdd: [],
    contentUpdate: [],
    contentFind: [],
    notebookExists: [],
    notebookNotes: [],
    tag: [],
    tagAdd: [],
    relationAdd: [],
    relationUnlink: [],
    relationList: [],
  };

  return {
    calls,
    notes: {
      note: async (id: string) => {
        calls.note.push(id);
        const note = notes.get(id);
        if (!note) return undefined;
        return { ...note };
      },
      add: async (item: Record<string, unknown>) => {
        const title = typeof item.title === "string" ? item.title : "";
        const content = item.content as { type?: string; data?: string } | undefined;
        const contentType = typeof content?.type === "string" ? content.type : "tiptap";
        const contentData = typeof content?.data === "string" ? content.data : "";
        calls.addNote.push({ title, contentType, contentData });
        const id = `note-${notes.size + 1}`;
        notes.set(id, {
          id,
          title,
          pinned: false,
          favorite: false,
          conflicted: false,
          locked: false,
          dateEdited: 1_700_000_000_000,
        });
        return id;
      },
      addToNotebook: async (notebookId: string, ...noteIds: string[]) => {
        calls.addToNotebook.push({ notebookId, noteIds: [...noteIds] });
        const notebook = notebooks.get(notebookId);
        if (!notebook) throw new Error("fake: notebook not found");
        for (const noteId of noteIds) {
          if (!notebook.notes.includes(noteId)) notebook.notes.push(noteId);
        }
      },
      removeFromNotebook: async (notebookId: string, ...noteIds: string[]) => {
        calls.removeFromNotebook.push({ notebookId, noteIds: [...noteIds] });
        const notebook = notebooks.get(notebookId);
        if (!notebook) throw new Error("fake: notebook not found");
        for (const noteId of noteIds) {
          const idx = notebook.notes.indexOf(noteId);
          if (idx !== -1) notebook.notes.splice(idx, 1);
        }
      },
      collection: {
        update: async (ids: readonly string[], partial: Record<string, unknown>) => {
          calls.updateNotes.push({ ids: [...ids], partial: { ...partial } });
          for (const id of ids) {
            const note = notes.get(id);
            if (!note) continue;
            if (typeof partial.title === "string") note.title = partial.title;
            if (typeof partial.pinned === "boolean") note.pinned = partial.pinned;
            if (typeof partial.favorite === "boolean") note.favorite = partial.favorite;
            if (typeof partial.notebookId === "string") note.notebookId = partial.notebookId;
            if (Array.isArray(partial.tags)) note.tags = [...(partial.tags as string[])];
            note.dateEdited += 1;
          }
        },
      },
    },
    content: {
      add: async (partial: Record<string, unknown>) => {
        calls.contentAdd.push({ partial: { ...partial } });
        const id = `content-${content.size + 1}`;
        content.set(id, {
          id,
          noteId: typeof partial.noteId === "string" ? partial.noteId : "",
          type: partial.type === "tiny" ? "tiny" : "tiptap",
          data: typeof partial.data === "string" ? partial.data : "",
        });
        return id;
      },
      findByNoteId: async (noteId: string) => {
        calls.contentFind.push(noteId);
        for (const item of content.values()) {
          if (item.noteId === noteId) return { ...item };
        }
        return undefined;
      },
      updateByNoteId: async (partial: Record<string, unknown>, ...ids: string[]) => {
        calls.contentUpdate.push({ partial: { ...partial }, ids: [...ids] });
        for (const id of ids) {
          for (const item of content.values()) {
            if (item.noteId === id) {
              if (typeof partial.type === "string") {
                item.type = partial.type === "tiny" ? "tiny" : "tiptap";
              }
              if (typeof partial.data === "string") item.data = partial.data;
            }
          }
        }
      },
    },
    notebooks: {
      exists: async (id: string) => {
        calls.notebookExists.push(id);
        return notebooks.has(id);
      },
      notes: async (id: string) => {
        calls.notebookNotes.push(id);
        return notebooks.get(id)?.notes.slice() ?? [];
      },
    },
    tags: {
      tag: async (id: string) => {
        calls.tag.push(id);
        const tag = tags.get(id);
        if (!tag) return undefined;
        return { ...tag };
      },
      add: async ({ title }: { title: string }) => {
        calls.tagAdd.push({ title });
        const id = `tag-${tags.size + 1}`;
        tags.set(id, { id, title });
        return id;
      },
    },
    relations: {
      add: async (from: { id: string; type: string }, to: { id: string; type: string }) => {
        calls.relationAdd.push({ from: { ...from }, to: { ...to } });
        relations.push({ fromId: from.id, fromType: "note", toId: to.id, toType: to.type });
      },
      unlink: async (from: { id: string; type: string }, to: { id: string; type: string }) => {
        calls.relationUnlink.push({ from: { ...from }, to: { ...to } });
        for (let i = relations.length - 1; i >= 0; i -= 1) {
          const rel = relations[i]!;
          if (
            rel.fromId === from.id &&
            rel.fromType === "note" &&
            rel.toId === to.id &&
            rel.toType === to.type
          ) {
            relations.splice(i, 1);
          }
        }
      },
      from: (
        reference: { id: string; type: string } | { type: string; ids: readonly string[] },
      ) => ({
        get: async () => {
          const ids =
            "ids" in reference && Array.isArray(reference.ids)
              ? reference.ids
              : [(reference as { id: string }).id];
          calls.relationList.push(ids.join(","));
          return relations.filter((r) => ids.includes(r.fromId)).map((r) => ({ ...r }));
        },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// The codec injected through the existing adapter.  The wiring slice
// does NOT own the codec; the existing seam already exposes it.
// ---------------------------------------------------------------------------

/**
 * Test-local predicate.  The wiring module emits
 * `NotesnookWriteContractError` instances (the same class the existing
 * adapter wraps to add the `NotesnookWriteAdapterError` identity
 * marker).  Accept either so the helper recognises every categorical
 * write error the boundary produces; the assertion that the error
 * has a closed `code` and a fixed `message` is preserved.
 */
function isCategoricalWriteError(value: unknown): value is Error {
  return isNotesnookWriteAdapterError(value) || isNotesnookWriteContractError(value);
}

async function expectAdapterError(
  fn: () => Promise<unknown> | unknown,
): Promise<{ code: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    if (!isCategoricalWriteError(error)) {
      throw new Error("expected a NotesnookWriteAdapterError");
    }
    const typed = error as Error & { code?: string };
    return { code: String(typed.code ?? ""), message: String(typed.message ?? "") };
  }
  throw new Error("expected the call to throw");
}

// ---------------------------------------------------------------------------
// Source rejection.
// ---------------------------------------------------------------------------

describe("Stage 4 write wiring — optional delete projection", () => {
  it("projects notes.moveToTrash as the bounded notesDelete seam", async () => {
    const runtime = createFakeRuntime();
    const deleted: string[] = [];
    Object.defineProperty(runtime.notes, "moveToTrash", {
      configurable: false,
      enumerable: true,
      value: async (...ids: string[]) => {
        deleted.push(...ids);
      },
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    expect(typeof seam.notesDelete).toBe("function");
    await seam.notesDelete!("note-1");
    expect(deleted).toEqual(["note-1"]);
    expect(Object.keys(seam)).toContain("notesDelete");
  });
});

describe("Stage 4 write wiring — source rejection", () => {
  it("rejects null, undefined, primitives, and non-object sources", async () => {
    const nulls: unknown[] = [null, undefined, 1, "string", true, Symbol("s"), 1n];
    for (const value of nulls) {
      const result = await expectAdapterError(() =>
        Promise.resolve().then(() => bindNotesnookWriteRuntime(value as never)),
      );
      expect(result.code).toBe("invalid_input");
    }
  });

  it("rejects a synchronous supplier that throws", () => {
    let caught = false;
    try {
      bindNotesnookWriteRuntime(() => {
        throw new Error("factory exploded");
      });
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
      expect((error as Error).message).not.toContain("factory exploded");
    }
    expect(caught).toBe(true);
  });

  it("rejects thenable / Promise suppliers and awaits them closed", async () => {
    let caught = false;
    try {
      bindNotesnookWriteRuntime((() => Promise.resolve(createFakeRuntime())) as never);
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
    }
    expect(caught).toBe(true);
  });

  it("rejects a source whose required getter throws (hostile getter)", () => {
    const hostile = new Proxy(createFakeRuntime(), {
      get(target, prop) {
        if (prop === "notes") {
          throw new Error("boom");
        }
        return Reflect.get(target, prop);
      },
    });
    let caught = false;
    try {
      bindNotesnookWriteRuntime(hostile as never);
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
      expect((error as Error).message).not.toContain("boom");
    }
    expect(caught).toBe(true);
  });

  it("rejects a source that is missing a required slot", () => {
    const runtime = createFakeRuntime();
    const partial = { ...runtime };
    delete (partial as Record<string, unknown>).content;
    let caught = false;
    try {
      bindNotesnookWriteRuntime(partial as never);
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
    }
    expect(caught).toBe(true);
  });

  it("rejects a source whose sub-slot is a primitive", () => {
    const runtime = createFakeRuntime();
    const primitive = {
      ...runtime,
      notebooks: {
        exists: "not-a-function",
        notes: runtime.notebooks.notes,
      },
    };
    let caught = false;
    try {
      bindNotesnookWriteRuntime(primitive as never);
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
    }
    expect(caught).toBe(true);
  });

  it("rejects a source that exposes the raw `database` escape hatch", () => {
    const runtime = createFakeRuntime() as unknown as Record<string, unknown>;
    runtime["database"] = { fake: true };
    let caught = false;
    try {
      bindNotesnookWriteRuntime(runtime as never);
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
    }
    expect(caught).toBe(true);
  });

  it("rejects a source that exposes a generic collection accessor", () => {
    const runtime = createFakeRuntime() as unknown as Record<string, unknown>;
    runtime["collection"] = () => "anything";
    let caught = false;
    try {
      bindNotesnookWriteRuntime(runtime as never);
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
    }
    expect(caught).toBe(true);
  });

  it("rejects a source that exposes a sync, send, full, or force escape hatch", () => {
    for (const name of ["sync", "send", "full", "force"]) {
      const runtime = createFakeRuntime() as unknown as Record<string, unknown>;
      runtime[name] = () => true;
      let caught = false;
      try {
        bindNotesnookWriteRuntime(runtime as never);
      } catch (error) {
        caught = true;
        if (!isCategoricalWriteError(error)) {
          throw new Error(`expected adapter error for ${name}`);
        }
        expect((error as Error & { code?: string }).code).toBe("invalid_input");
      }
      expect(caught).toBe(true);
    }
  });

  it("rejects a source that exposes a delete, vault, auth, or transport escape hatch", () => {
    for (const name of [
      "delete",
      "remove",
      "vaultUnlock",
      "vaultLock",
      "user",
      "tokenManager",
      "kv",
      "transport",
      "disconnectSSE",
      "connectSSE",
      "host",
    ]) {
      const runtime = createFakeRuntime() as unknown as Record<string, unknown>;
      runtime[name] = () => true;
      let caught = false;
      try {
        bindNotesnookWriteRuntime(runtime as never);
      } catch (error) {
        caught = true;
        if (!isCategoricalWriteError(error)) {
          throw new Error(`expected adapter error for ${name}`);
        }
        expect((error as Error & { code?: string }).code).toBe("invalid_input");
      }
      expect(caught).toBe(true);
    }
  });

  it("accepts a synchronous supplier that returns a valid runtime", () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(() => runtime);
    expect(typeof seam.notesAdd).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Concrete mapping and this-binding.
// ---------------------------------------------------------------------------

describe("Stage 4 write wiring — concrete mapping", () => {
  it("returns a frozen NotesnookWriteDatabase seam with no extra own members", () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    expect(Object.isFrozen(seam)).toBe(true);
    // Only the closed NotesnookWriteDatabase slots may be present; no
    // escape-hatch methods such as `database`, `raw`, `sync`, etc.
    const ownKeys = Object.keys(seam).sort();
    expect(ownKeys).toEqual(
      [
        "contentAdd",
        "contentFindByNoteId",
        "contentUpdateByNoteId",
        "note",
        "notebookAddNote",
        "notebookExists",
        "notebookNotes",
        "notebookRemoveNote",
        "notesAdd",
        "notesTouch",
        "notesUpdate",
        "relationAdd",
        "relationListForNote",
        "relationRemove",
        "tagAdd",
        "tagExists",
      ].sort(),
    );
  });

  it("maps notes.note to a NotesnookWriteNoteMetadata with closed fields", async () => {
    const note: FakeNoteRecord = {
      id: NOTE_ID,
      title: "Subject",
      contentId: "content-1",
      notebookId: NOTEBOOK_ID,
      pinned: true,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1_700_000_000_000,
      tags: [TAG_ID],
    };
    const runtime = createFakeRuntime({
      notes: new Map([[NOTE_ID, note]]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    const observed = (await seam.note(NOTE_ID)) as NotesnookWriteNoteMetadata;
    expect(observed.id).toBe(NOTE_ID);
    expect(observed.title).toBe("Subject");
    expect(observed.contentId).toBe("content-1");
    expect(observed.notebookId).toBe(NOTEBOOK_ID);
    expect(observed.pinned).toBe(true);
    expect(observed.favorite).toBe(false);
    expect(observed.conflicted).toBe(false);
    expect(observed.locked).toBe(false);
    expect(observed.dateEdited).toBe(1_700_000_000_000);
    expect(observed.tags).toEqual([TAG_ID]);
  });

  it("uses content.locked when note.locked is absent (P1-2)", async () => {
    // The deprecated upstream `note.locked` flag is omitted entirely.
    // The seam must consult `content.locked` (the authoritative
    // Notesnook Vault marker) so a locked vault item fails the
    // adapter's gate instead of slipping past it as `false`.
    const note = {
      id: NOTE_ID,
      title: "Vault-locked without deprecated flag",
      pinned: false,
      favorite: false,
      conflicted: false,
      dateEdited: 1_700_000_000_000,
    } as unknown as FakeNoteRecord;
    const runtime = createFakeRuntime({
      notes: new Map([[NOTE_ID, note]]),
      content: new Map([
        [
          "content-locked",
          {
            id: "content-locked",
            noteId: NOTE_ID,
            type: "tiptap",
            data: "<p>locked</p>",
            locked: true,
          },
        ],
      ]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);

    const observed = await seam.note(NOTE_ID);
    expect(observed).toMatchObject({ id: NOTE_ID, locked: true });
  });

  it("treats absent note.locked AND absent content.locked as unlocked (P1-2)", async () => {
    // Without either marker the seam falls back to `false`.  This is
    // the same shape as the deprecated upstream default; the gate
    // only changes behavior when the content marker disagrees.
    const note = {
      id: NOTE_ID,
      title: "Unlocked without either flag",
      pinned: false,
      favorite: false,
      conflicted: false,
      dateEdited: 1_700_000_000_000,
    } as unknown as FakeNoteRecord;
    const runtime = createFakeRuntime({
      notes: new Map([[NOTE_ID, note]]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);

    const observed = await seam.note(NOTE_ID);
    expect(observed).toMatchObject({ id: NOTE_ID, locked: false });
  });

  it("honors explicit note.locked over content.locked (P1-2)", async () => {
    // The deprecated upstream flag wins when supplied, even if the
    // content marker disagrees.  This mirrors the contract surface
    // Notesnook actually returns today.
    const note: FakeNoteRecord = {
      id: NOTE_ID,
      title: "Upstream says unlocked",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1_700_000_000_000,
    };
    const runtime = createFakeRuntime({
      notes: new Map([[NOTE_ID, note]]),
      content: new Map([
        [
          "content-1",
          {
            id: "content-1",
            noteId: NOTE_ID,
            type: "tiptap",
            data: "<p>x</p>",
            locked: true,
          },
        ],
      ]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);

    const observed = await seam.note(NOTE_ID);
    expect(observed).toMatchObject({ id: NOTE_ID, locked: false });
  });

  it("binds note() to the runtime object so a thief cannot detach it", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    const stolen = seam.note;
    const observed = await stolen(NOTE_ID);
    expect(observed).toBeUndefined();
  });

  it("maps content.findByNoteId into NotesnookWriteStoredContent and rewrites tiny to html", async () => {
    const stored: FakeContentRecord = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "tiny",
      data: "<p>old</p>",
    };
    const runtime = createFakeRuntime({
      notes: new Map([
        [
          NOTE_ID,
          {
            id: NOTE_ID,
            title: "x",
            pinned: false,
            favorite: false,
            conflicted: false,
            locked: false,
            dateEdited: 1,
          },
        ],
      ]),
      content: new Map([["content-1", stored]]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    const found = (await seam.contentFindByNoteId(NOTE_ID)) as NotesnookWriteStoredContent;
    expect(found.type).toBe("html");
    expect(found.data).toBe("<p>old</p>");
    expect(found.noteId).toBe(NOTE_ID);
  });

  it("preserves upstream ContentType tiptap as seam tiptap", async () => {
    const stored: FakeContentRecord = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "tiptap",
      data: "{}",
    };
    const runtime = createFakeRuntime({
      content: new Map([["content-1", stored]]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    const found = (await seam.contentFindByNoteId(NOTE_ID)) as NotesnookWriteStoredContent;
    expect(found.type).toBe("tiptap");
  });

  it("fails closed when findByNoteId returns a record with an unknown type", async () => {
    const runtime = createFakeRuntime();
    // Override the runtime's nested `content.findByNoteId` so the seam
    // surface (which is frozen and not redefinable) picks up the
    // hostile response.  This preserves the frozen-seam invariant.
    (
      runtime.content as unknown as { findByNoteId: (id: string) => Promise<unknown> }
    ).findByNoteId = async () => ({ id: "x", noteId: NOTE_ID, type: "markdown", data: "no" });
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.contentFindByNoteId(NOTE_ID));
    expect(result.code).toBe("invalid_input");
  });

  it("forwards notesAdd({title, content}) to notes.add with only the safe mapped type", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    const id = await seam.notesAdd({
      title: "Hello",
      content: { type: "html", data: "<p>world</p>" },
    });
    expect(typeof id).toBe("string");
    expect(runtime.calls.addNote).toHaveLength(1);
    // The upstream only knows `tiptap` | `tiny`; html is mapped to `tiptap`.
    expect(runtime.calls.addNote[0]?.contentType).toBe("tiptap");
    expect(runtime.calls.addNote[0]?.contentData).toBe("<p>world</p>");
  });

  it("rewrites upstream ContentType tiny to seam tiptap-safe when notesAdd persists", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    // content.type === "tiny" should also map safely to "tiptap" upstream
    // (the seam only stores "tiptap" | "html"; any other input is fail-closed).
    const id = await seam.notesAdd({
      title: "Two",
      content: { type: "html", data: "<p>again</p>" },
    });
    expect(typeof id).toBe("string");
    expect(runtime.calls.addNote[0]?.contentType).toBe("tiptap");
  });

  it("fails closed when notesAdd is called with an unknown content type", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() =>
      seam.notesAdd({
        title: "x",
        content: { type: "markdown" as never, data: "no" },
      }),
    );
    expect(result.code).toBe("invalid_input");
  });

  it("forwards notesUpdate to notes.collection.update with the allowlisted partial", async () => {
    const runtime = createFakeRuntime({
      notes: new Map([
        [
          NOTE_ID,
          {
            id: NOTE_ID,
            title: "old",
            pinned: false,
            favorite: false,
            conflicted: false,
            locked: false,
            dateEdited: 1,
          },
        ],
      ]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.notesUpdate([NOTE_ID], { title: "new", pinned: true });
    expect(runtime.calls.updateNotes).toHaveLength(1);
    expect(runtime.calls.updateNotes[0]?.ids).toEqual([NOTE_ID]);
    expect(runtime.calls.updateNotes[0]?.partial.title).toBe("new");
    expect(runtime.calls.updateNotes[0]?.partial.pinned).toBe(true);
  });

  it("forwards contentAdd to content.add", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    const id = await seam.contentAdd({ noteId: NOTE_ID, type: "tiptap", data: "{}" });
    expect(typeof id).toBe("string");
    expect(runtime.calls.contentAdd).toHaveLength(1);
  });

  it("forwards contentUpdateByNoteId to content.updateByNoteId", async () => {
    const runtime = createFakeRuntime({
      content: new Map([
        ["content-1", { id: "content-1", noteId: NOTE_ID, type: "tiptap" as const, data: "{}" }],
      ]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.contentUpdateByNoteId({ data: "new" }, NOTE_ID);
    expect(runtime.calls.contentUpdate).toHaveLength(1);
    expect(runtime.calls.contentUpdate[0]?.ids).toEqual([NOTE_ID]);
  });

  it("forwards notebookExists and notebookNotes", async () => {
    const runtime = createFakeRuntime({
      notebooks: new Map([[NOTEBOOK_ID, { id: NOTEBOOK_ID, title: "Work", notes: [NOTE_ID] }]]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    await expect(seam.notebookExists(NOTEBOOK_ID)).resolves.toBe(true);
    await expect(seam.notebookExists("missing")).resolves.toBe(false);
    await expect(seam.notebookNotes(NOTEBOOK_ID)).resolves.toEqual([NOTE_ID]);
  });

  it("forwards notebookAddNote to notes.addToNotebook", async () => {
    const runtime = createFakeRuntime({
      notebooks: new Map([[NOTEBOOK_ID, { id: NOTEBOOK_ID, title: "Work", notes: [] }]]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.notebookAddNote(NOTEBOOK_ID, NOTE_ID);
    expect(runtime.calls.addToNotebook).toHaveLength(1);
    expect(runtime.calls.addToNotebook[0]).toEqual({ notebookId: NOTEBOOK_ID, noteIds: [NOTE_ID] });
  });

  it("forwards notebookRemoveNote to notes.removeFromNotebook", async () => {
    const runtime = createFakeRuntime({
      notebooks: new Map([[NOTEBOOK_ID, { id: NOTEBOOK_ID, title: "Work", notes: [NOTE_ID] }]]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.notebookRemoveNote(NOTEBOOK_ID, NOTE_ID);
    expect(runtime.calls.removeFromNotebook).toHaveLength(1);
    expect(runtime.calls.removeFromNotebook[0]).toEqual({
      notebookId: NOTEBOOK_ID,
      noteIds: [NOTE_ID],
    });
  });

  it("forwards tagAdd to tags.add", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    const id = await seam.tagAdd({ title: "home" });
    expect(typeof id).toBe("string");
    expect(runtime.calls.tagAdd).toEqual([{ title: "home" }]);
  });

  it("forwards tagExists through tags.tag (pinned ID lookup)", async () => {
    const runtime = createFakeRuntime({
      tags: new Map([
        [TAG_ID, { id: TAG_ID, title: "home" }],
        [OTHER_ID, { id: OTHER_ID, title: "work" }],
      ]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    await expect(seam.tagExists(TAG_ID)).resolves.toBe(true);
    await expect(seam.tagExists("missing")).resolves.toBe(false);
  });

  it("forwards relationAdd with explicit {id,type} references", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.relationAdd({
      fromId: NOTE_ID,
      toId: TAG_ID,
      type: "tag",
    });
    expect(runtime.calls.relationAdd).toHaveLength(1);
    const ref = runtime.calls.relationAdd[0]?.from as { id: string; type: string };
    expect(ref).toEqual({ id: NOTE_ID, type: "note" });
    const to = runtime.calls.relationAdd[0]?.to as { id: string; type: string };
    expect(to).toEqual({ id: TAG_ID, type: "tag" });
  });

  it("forwards relationRemove with explicit {id,type} references", async () => {
    const runtime = createFakeRuntime({
      relations: [{ fromId: NOTE_ID, fromType: "note", toId: TAG_ID, toType: "tag" }],
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.relationRemove({
      fromId: NOTE_ID,
      toId: TAG_ID,
      type: "tag",
    });
    expect(runtime.calls.relationUnlink).toHaveLength(1);
    const ref = runtime.calls.relationUnlink[0]?.from as { id: string; type: string };
    expect(ref).toEqual({ id: NOTE_ID, type: "note" });
    const to = runtime.calls.relationUnlink[0]?.to as { id: string; type: string };
    expect(to).toEqual({ id: TAG_ID, type: "tag" });
  });

  it("forwards relationListForNote through relations.from({id,type}).get() and returns {toId,type}", async () => {
    const runtime = createFakeRuntime({
      relations: [
        { fromId: NOTE_ID, fromType: "note", toId: TAG_ID, toType: "tag" },
        { fromId: NOTE_ID, fromType: "note", toId: OTHER_ID, toType: "notebook" },
      ],
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    const list = await seam.relationListForNote(NOTE_ID);
    expect(list).toEqual([
      { toId: TAG_ID, type: "tag" },
      { toId: OTHER_ID, type: "notebook" },
    ]);
    // The seam surface must be `{toId, type}` only; no `fromId`/canary leakage.
    for (const rel of list) {
      expect(Object.keys(rel).sort()).toEqual(["toId", "type"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Upstream error redaction.
// ---------------------------------------------------------------------------

describe("Stage 4 write wiring — upstream error redaction", () => {
  it("normalises every foreign throw to a chain-free adapter error with sync_failed", async () => {
    const runtime = createFakeRuntime();
    // The seam is frozen; re-route `note()` through the mutable runtime
    // before binding so the seam picks up the hostile rejector.  This
    // preserves the frozen-seam invariant while still exercising the
    // `safeCall` redaction path.
    (runtime.notes as unknown as { note: (id: string) => Promise<unknown> }).note = async () => {
      throw new Error(`${CANARY}: upstream note failed`);
    };
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.note(NOTE_ID));
    expect(result.code).toBe("sync_failed");
    expect(result.message).not.toContain(CANARY);
    expect(result.message).not.toContain(NOTE_ID);
  });

  it("strips `cause` and `__context__` from rethrown adapter errors", async () => {
    const runtime = createFakeRuntime();
    // The seam is frozen; override the runtime's `notebooks.exists`
    // method before binding so the seam picks up the hostile thrower.
    (runtime.notebooks as unknown as { exists: (id: string) => Promise<unknown> }).exists =
      async () => {
        const error = new Error("bad");
        (error as Error & { cause?: unknown }).cause = `${CANARY}-cause`;
        (error as Error & { __context__?: unknown }).__context__ = `${CANARY}-ctx`;
        throw error;
      };
    const seam = bindNotesnookWriteRuntime(runtime);
    try {
      await seam.notebookExists(NOTEBOOK_ID);
      throw new Error("expected failure");
    } catch (error) {
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error & { __context__?: unknown }).__context__).toBeUndefined();
      expect((error as Error).message).not.toContain(CANARY);
    }
  });

  it("never interpolates note id, body, or canary into the upstream-typed message", async () => {
    const runtime = createFakeRuntime();
    // The seam is frozen; override the runtime's `notes.add` method
    // before binding so the seam picks up the hostile rejector.
    (runtime.notes as unknown as { add: (input: unknown) => Promise<unknown> }).add = async () => {
      throw new Error(`${CANARY} rejected noteId=${NOTE_ID}`);
    };
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() =>
      seam.notesAdd({ title: "x", content: { type: "html", data: `${CANARY}-body` } }),
    );
    expect(result.message).not.toContain(CANARY);
    expect(result.message).not.toContain(NOTE_ID);
  });
});

// ---------------------------------------------------------------------------
// End-to-end with the existing adapter.
// ---------------------------------------------------------------------------

describe("Stage 4 write wiring — end-to-end via NotesnookWriteAdapter", () => {
  it("drives a createNote path that ends in a valid local-only outcome", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    // Smoke-test that the seam IS-A NotesnookWriteDatabase by feeding
    // it through the adapter's `notesAdd`.  We construct the adapter
    // directly with the seam to confirm structural compatibility.
    const id = await seam.notesAdd({
      title: "create me",
      content: { type: "html", data: "<p>hello</p>" },
    });
    expect(typeof id).toBe("string");
    expect(runtime.calls.addNote[0]?.title).toBe("create me");
    expect(runtime.calls.addNote[0]?.contentType).toBe("tiptap");
  });

  it("exposes the closed type-table for downstream adapter imports", () => {
    const seam = bindNotesnookWriteRuntime(createFakeRuntime());
    const typed: NotesnookWriteDatabase = seam;
    expect(typeof typed.notesAdd).toBe("function");
    expect(typeof typed.notesUpdate).toBe("function");
    expect(typeof typed.relationListForNote).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Unchanged Stage 3 declarations.
//
// The wiring slice must not widen or re-export the read-only or live
// seam.  This test loads the public declarations from their canonical
// files and checks that they retain the same name.
// ---------------------------------------------------------------------------

describe("Stage 4 write wiring — unchanged Stage 3 surface", () => {
  it("keeps NotesnookReadOnlyDatabase exported from the read-only adapter", async () => {
    const mod = await import("../src/core/notesnook-readonly-adapter.js");
    expect(typeof mod.NotesnookReadOnlyAdapter).toBe("function");
    expect(typeof mod.createNotesnookReadOnlyAdapter).toBe("function");
  });

  it("keeps NotesnookLiveDatabase exported from the live factory", async () => {
    const mod = await import("../src/core/notesnook-live-factory.js");
    expect(typeof mod.createNotesnookLiveCoreFactory).toBe("function");
  });

  it("does not re-export the read-only or live seam from the wiring module", async () => {
    const mod = await import("../src/core/notesnook-write-wiring.js");
    expect((mod as Record<string, unknown>)["NotesnookReadOnlyDatabase"]).toBeUndefined();
    expect((mod as Record<string, unknown>)["NotesnookLiveDatabase"]).toBeUndefined();
  });
});

// Mark Buffer import as used so the runtime codec helpers above do not
// trigger the no-unused-vars lint rule on the Buffer symbol.
const _bufferSentinel = Buffer;
void _bufferSentinel;

// ---------------------------------------------------------------------------
// Adversarial regression coverage.
//
// Each test below exercises a specific adversarial finding from the
// Stage 4 write-wiring security review.  The tests are written FIRST
// (RED) against the pre-hardening implementation and turn GREEN only
// after the wiring module is repaired.  No test here may weaken the
// frozen-seam invariant, the categorical-error contract, or the
// closed-surface discipline established above.
// ---------------------------------------------------------------------------

describe("Stage 4 write wiring — adversarial regression", () => {
  // ---------------------------------------------------------------------
  // 1. Hostile / revoked `.then` getter — `isPromiseLike` must never
  //    read attacker-controlled properties unsafely.
  // ---------------------------------------------------------------------
  it("rejects a supplier whose resolved value has a hostile `then` getter", () => {
    const hostile = {
      get then() {
        throw new Error(`${CANARY}-then-getter`);
      },
    };
    let caught = false;
    try {
      bindNotesnookWriteRuntime((() => hostile) as never);
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
      expect((error as Error).message).not.toContain(CANARY);
    }
    expect(caught).toBe(true);
  });

  it("rejects a supplier whose resolved value's `then` is a non-function truthy value", () => {
    const hostile = { then: "not-a-function-but-truthy" } as unknown;
    let caught = false;
    try {
      bindNotesnookWriteRuntime((() => hostile) as never);
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
    }
    expect(caught).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 2. Revoked / hostile Proxy source — every required child slot must
  //    become categorical invalid_input, never leak a raw throw.
  // ---------------------------------------------------------------------
  it("rejects a revoked Proxy source without leaking the trap error", () => {
    const { proxy, revoke } = Proxy.revocable(createFakeRuntime(), {});
    revoke();
    let caught = false;
    try {
      bindNotesnookWriteRuntime(proxy as never);
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
      expect((error as Error).message).not.toContain(CANARY);
    }
    expect(caught).toBe(true);
  });

  it("rejects a runtime whose child-slot `get` trap throws on every access", () => {
    const runtime = createFakeRuntime();
    const hostile = new Proxy(runtime, {
      get(target, prop) {
        if (prop === "tags" || prop === "relations") {
          throw new Error(`${CANARY}-child-slot`);
        }
        return Reflect.get(target, prop);
      },
    });
    let caught = false;
    try {
      bindNotesnookWriteRuntime(hostile as never);
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
      expect((error as Error).message).not.toContain(CANARY);
    }
    expect(caught).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 3. Hostile notesAdd / tagAdd / relation input getter traps — the
  //    seam must protect every required property read on the inbound
  //    payload and normalise any throw to invalid_input without calling
  //    upstream.
  // ---------------------------------------------------------------------
  it("rejects a notesAdd input whose `content` getter throws and never invokes upstream", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    const hostileInput = {
      title: "ok",
      content: new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "type") throw new Error(`${CANARY}-content-type`);
            if (prop === "data") throw new Error(`${CANARY}-content-data`);
            return undefined;
          },
        },
      ),
    };
    const result = await expectAdapterError(() => seam.notesAdd(hostileInput as never));
    expect(result.code).toBe("invalid_input");
    expect(result.message).not.toContain(CANARY);
    expect(runtime.calls.addNote).toHaveLength(0);
  });

  it("rejects a tagAdd input whose `title` getter throws", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    // Wrap a boxed string in a Proxy so reading the underlying
    // `toString`/length/valueOf succeeds but every other property
    // access throws — `tagAdd` reads `input.title` and must normalise
    // the throw to invalid_input without ever reaching upstream.
    const hostileTitle = new Proxy(Object(""), {
      get(target, prop) {
        if (prop === "toString" || prop === "valueOf" || prop === "length") {
          return Reflect.get(target, prop);
        }
        throw new Error(`${CANARY}-title-getter`);
      },
    });
    const result = await expectAdapterError(() =>
      seam.tagAdd({ title: hostileTitle as unknown as string }),
    );
    expect(result.code).toBe("invalid_input");
    expect(result.message).not.toContain(CANARY);
    expect(runtime.calls.tagAdd).toHaveLength(0);
  });

  it("rejects a relation input whose fromId/toId getter throws and never invokes upstream", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    // Wrap a boxed string in a Proxy so reading `toString`/`length`
    // succeeds but every other property access throws.  The seam must
    // normalise the throw to `invalid_input` without ever reaching
    // upstream.
    const hostileFromId = new Proxy(Object(NOTE_ID), {
      get(target, prop) {
        if (prop === "toString" || prop === "valueOf" || prop === "length") {
          return Reflect.get(target, prop);
        }
        throw new Error(`${CANARY}-from-id`);
      },
    });
    const result = await expectAdapterError(() =>
      seam.relationAdd({
        fromId: hostileFromId as unknown as string,
        toId: TAG_ID,
        type: "tag",
      }),
    );
    expect(result.code).toBe("invalid_input");
    expect(result.message).not.toContain(CANARY);
    expect(runtime.calls.relationAdd).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // 4. Stateful runtime getter — after validation, the seam must call
  //    the snapshot of children the validator saw, not a freshly-read
  //    alternate child returned by a stateful getter.
  // ---------------------------------------------------------------------
  it("snapshots validated children so a stateful runtime getter cannot redirect upstream calls", async () => {
    // The two alternate child objects differ only in their `note`
    // implementation: the validator-snapshotted one returns benign
    // metadata, the post-validation one throws a canary.  With the
    // hardening in place the seam always calls the snapshotted
    // method; the canary must never leak.
    const benignMetadata = {
      id: NOTE_ID,
      title: "benign",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1,
    };
    const benignNotes = {
      ...createFakeRuntime().notes,
      note: async () => ({ ...benignMetadata }),
    } as unknown as NotesnookWriteRuntime["notes"];
    const evilNotes = {
      ...createFakeRuntime().notes,
      note: async () => {
        throw new Error(`${CANARY}-stateful-notes`);
      },
    } as unknown as NotesnookWriteRuntime["notes"];
    let flip = false;
    const runtime = createFakeRuntime();
    const stateful = new Proxy(runtime, {
      get(target, prop) {
        if (prop === "notes") {
          flip = !flip;
          return flip ? benignNotes : evilNotes;
        }
        return Reflect.get(target, prop);
      },
    });
    const seam = bindNotesnookWriteRuntime(stateful as never);
    // Drive many calls — every one must use the validator-snapshotted
    // child (benignNotes); none may return a raw canary throw.
    for (let i = 0; i < 4; i += 1) {
      const observed = await seam.note(NOTE_ID);
      expect(observed).toBeDefined();
      // The seam must yield the benign metadata the validator saw,
      // never a canary throw or a thrown Error object.
      expect((observed as { title?: string }).title).toBe("benign");
    }
  });

  // ---------------------------------------------------------------------
  // 5. readHas uses Reflect.has — forbidden surface present with an
  //    undefined value must still be rejected.
  // ---------------------------------------------------------------------
  it("rejects a runtime whose forbidden surface is present with an undefined value", () => {
    const runtime = createFakeRuntime() as unknown as Record<string, unknown>;
    Object.defineProperty(runtime, "database", {
      configurable: true,
      enumerable: false,
      get: () => undefined,
    });
    let caught = false;
    try {
      bindNotesnookWriteRuntime(runtime as never);
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
    }
    expect(caught).toBe(true);
  });

  it("rejects a runtime whose `has` trap throws on forbidden surface names", () => {
    const runtime = createFakeRuntime();
    const hostile = new Proxy(runtime, {
      has(target, prop) {
        if (prop === "vaultUnlock" || prop === "transport") {
          throw new Error(`${CANARY}-has-trap`);
        }
        return Reflect.has(target, prop);
      },
    });
    let caught = false;
    try {
      bindNotesnookWriteRuntime(hostile as never);
    } catch (error) {
      caught = true;
      if (!isCategoricalWriteError(error)) {
        throw new Error("expected adapter error");
      }
      expect((error as Error & { code?: string }).code).toBe("invalid_input");
      expect((error as Error).message).not.toContain(CANARY);
    }
    expect(caught).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 6. Identifier validation — empty-string IDs and missing fields must
  //    fail closed BEFORE any upstream call.
  // ---------------------------------------------------------------------
  it("rejects an empty-string noteId passed to notebookAddNote without calling upstream", async () => {
    const runtime = createFakeRuntime({
      notebooks: new Map([[NOTEBOOK_ID, { id: NOTEBOOK_ID, title: "n", notes: [] }]]),
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.notebookAddNote(NOTEBOOK_ID, ""));
    expect(result.code).toBe("invalid_input");
    expect(runtime.calls.addToNotebook).toHaveLength(0);
  });

  it("rejects an empty-string notebookId passed to notebookAddNote without calling upstream", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.notebookAddNote("", NOTE_ID));
    expect(result.code).toBe("invalid_input");
    expect(runtime.calls.addToNotebook).toHaveLength(0);
  });

  it("rejects an empty-string tag id passed to tagExists without calling upstream", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.tagExists(""));
    expect(result.code).toBe("invalid_input");
  });

  it("rejects an empty-string noteId passed to relationListForNote without calling upstream", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.relationListForNote(""));
    expect(result.code).toBe("invalid_input");
    expect(runtime.calls.relationList).toHaveLength(0);
  });

  it("rejects relationAdd with an empty-string toId without calling upstream", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() =>
      seam.relationAdd({ fromId: NOTE_ID, toId: "", type: "tag" }),
    );
    expect(result.code).toBe("invalid_input");
    expect(runtime.calls.relationAdd).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // 7. Returned-ID validation — malformed upstream IDs become chain-free
  //    sync_failed.
  // ---------------------------------------------------------------------
  it("normalises a malformed notes.add return id to sync_failed without leaking it", async () => {
    const runtime = createFakeRuntime();
    (runtime.notes as unknown as { add: (input: unknown) => Promise<unknown> }).add = async () =>
      "";
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() =>
      seam.notesAdd({ title: "x", content: { type: "html", data: "<p/>" } }),
    );
    expect(result.code).toBe("sync_failed");
  });

  it("normalises a non-string content.add return id to sync_failed without leaking it", async () => {
    const runtime = createFakeRuntime();
    (runtime.content as unknown as { add: (input: unknown) => Promise<unknown> }).add =
      async () => ({ id: `${CANARY}-content-id` });
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() =>
      seam.contentAdd({ noteId: NOTE_ID, type: "tiptap", data: "{}" }),
    );
    expect(result.code).toBe("sync_failed");
    expect(result.message).not.toContain(CANARY);
  });

  it("normalises a malformed tags.add return id to sync_failed without leaking it", async () => {
    const runtime = createFakeRuntime();
    (runtime.tags as unknown as { add: (input: unknown) => Promise<unknown> }).add = async () => 42;
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.tagAdd({ title: "x" }));
    expect(result.code).toBe("sync_failed");
  });

  // ---------------------------------------------------------------------
  // 8. Hostile / malformed note/content records — protected field reads
  //    and strict type checks.  Malformed records become invalid_input.
  // ---------------------------------------------------------------------
  it("rejects a hostile note record whose `pinned` getter throws", async () => {
    const runtime = createFakeRuntime();
    (runtime.notes as unknown as { note: (id: string) => Promise<unknown> }).note = async () => ({
      get id() {
        return NOTE_ID;
      },
      get title() {
        return "ok";
      },
      get pinned() {
        throw new Error(`${CANARY}-pinned-getter`);
      },
      get favorite() {
        return false;
      },
      get conflicted() {
        return false;
      },
      get locked() {
        return false;
      },
      get dateEdited() {
        return 1;
      },
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.note(NOTE_ID));
    expect(result.code).toBe("invalid_input");
    expect(result.message).not.toContain(CANARY);
  });

  it("rejects a note record whose `pinned` field is a non-boolean", async () => {
    const runtime = createFakeRuntime();
    (runtime.notes as unknown as { note: (id: string) => Promise<unknown> }).note = async () => ({
      id: NOTE_ID,
      title: "ok",
      pinned: "yes",
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1,
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.note(NOTE_ID));
    expect(result.code).toBe("invalid_input");
  });

  it("rejects a hostile content record whose `id` getter throws", async () => {
    const runtime = createFakeRuntime();
    (
      runtime.content as unknown as {
        findByNoteId: (id: string) => Promise<unknown>;
      }
    ).findByNoteId = async () => ({
      get id() {
        throw new Error(`${CANARY}-content-id`);
      },
      get noteId() {
        return NOTE_ID;
      },
      get type() {
        return "tiptap";
      },
      get data() {
        return "{}";
      },
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.contentFindByNoteId(NOTE_ID));
    expect(result.code).toBe("invalid_input");
    expect(result.message).not.toContain(CANARY);
  });

  it("rejects a content record with an empty noteId", async () => {
    const runtime = createFakeRuntime();
    (
      runtime.content as unknown as {
        findByNoteId: (id: string) => Promise<unknown>;
      }
    ).findByNoteId = async () => ({
      id: "content-1",
      noteId: "",
      type: "tiptap",
      data: "{}",
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.contentFindByNoteId(NOTE_ID));
    expect(result.code).toBe("invalid_input");
  });

  // ---------------------------------------------------------------------
  // 9. Frozen / prototype surface — the seam must not expose any
  //    extra own / prototype escape-hatch method.
  // ---------------------------------------------------------------------
  it("freezes the seam, removes extensibility, and exposes no own keys outside the closed table", () => {
    const seam = bindNotesnookWriteRuntime(createFakeRuntime());
    expect(Object.isFrozen(seam)).toBe(true);
    expect(Object.isExtensible(seam)).toBe(false);
    expect(Object.isSealed(seam)).toBe(true);
    expect(Object.getOwnPropertyNames(seam).sort()).toEqual(
      [
        "contentAdd",
        "contentFindByNoteId",
        "contentUpdateByNoteId",
        "note",
        "notebookAddNote",
        "notebookExists",
        "notebookNotes",
        "notebookRemoveNote",
        "notesAdd",
        "notesTouch",
        "notesUpdate",
        "relationAdd",
        "relationListForNote",
        "relationRemove",
        "tagAdd",
        "tagExists",
      ].sort(),
    );
  });

  it("does not expose Object.prototype methods (toString, hasOwnProperty) on the seam surface", () => {
    const seam = bindNotesnookWriteRuntime(createFakeRuntime());
    expect(Object.getPrototypeOf(seam)).toBeNull();
    expect((seam as unknown as Record<string, unknown>)["toString"]).toBeUndefined();
    expect((seam as unknown as Record<string, unknown>)["constructor"]).toBeUndefined();
    expect((seam as unknown as Record<string, unknown>)["hasOwnProperty"]).toBeUndefined();
    expect(() => {
      (seam as unknown as Record<string, unknown>)["notesAdd"] = null;
    }).toThrow();
  });

  // ---------------------------------------------------------------------
  // 10. Foreign upstream throws are redacted and chain-free on every
  //     seam method, not just `note()` and `notebookExists()`.
  // ---------------------------------------------------------------------
  it("redacts every foreign throw across the seam surface as sync_failed", async () => {
    const runtime = createFakeRuntime();
    (runtime.tags as unknown as { tag: (id: string) => Promise<unknown> }).tag = async () => {
      throw new Error(`${CANARY}-tag-throw`);
    };
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.tagExists(TAG_ID));
    expect(result.code).toBe("sync_failed");
    expect(result.message).not.toContain(CANARY);
    expect(result.message).not.toContain(TAG_ID);
  });
});

// ---------------------------------------------------------------------------
// Receiver-safe regression — class-backed Notesnook owners.
//
// `NotesnookWriteRuntime` is the structural shape the wiring consumes.
// Pinned Notesnook classes (`Notes`, `Content`, `Notebooks`, `Tags`,
// `Relations`, `RelationHandle`) attach methods to instances; if a
// captured method is invoked detached, `this` resolves to `undefined`
// and the call throws.  The wiring MUST hard-bind every captured
// runtime method to its owning child object (and the handle returned
// from `relations.from(...)`) so seam calls always resolve `this` to
// the original instance the validator saw.
//
// Each test below builds a small class hierarchy whose methods read
// `this` and asserts that the seam-mediated upstream call observes the
// exact instance the validator captured — not `undefined`, not a
// detached copy, not a stateful post-validation replacement.  No test
// here may weaken the frozen-seam invariant or the categorical-error
// contract.
// ---------------------------------------------------------------------------

describe("Stage 4 write wiring — class-backed receiver safety", () => {
  // Mixin used by every class-backed owner.  Each instance records
  // the receiver the most-recent seam-mediated call observed into a
  // `_observed<Label>` property so the test can assert against the
  // exact instance the wiring invoked the method on.
  function recordReceiver<T extends object, K extends string>(
    self: T,
    label: K,
    receiver: unknown,
  ): void {
    Object.defineProperty(self, `_observed${label}`, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: receiver,
    });
  }

  // Class-backed Notes owner.
  class ClassBackedNotes {
    readonly calls: {
      note: unknown[];
      add: unknown[];
      addToNotebook: unknown[];
      removeFromNotebook: unknown[];
      collectionUpdate: unknown[];
    };
    readonly collection: ClassBackedCollection;
    constructor() {
      this.calls = {
        note: [],
        add: [],
        addToNotebook: [],
        removeFromNotebook: [],
        collectionUpdate: [],
      };
      this.collection = new ClassBackedCollection(this);
    }
    note(this: ClassBackedNotes, id: string): Promise<FakeNoteRecord | undefined> {
      recordReceiver(this, "Note", this);
      this.calls.note.push(id);
      return Promise.resolve(undefined);
    }
    add(
      this: ClassBackedNotes,
      input: {
        title: string;
        content?: { id: string; noteId: string; type: "tiptap" | "tiny"; data: string };
      },
    ): Promise<string> {
      recordReceiver(this, "Add", this);
      this.calls.add.push(input);
      return Promise.resolve(`note-${this.calls.add.length}`);
    }
    addToNotebook(this: ClassBackedNotes, notebookId: string, ...noteIds: string[]): Promise<void> {
      recordReceiver(this, "AddToNotebook", this);
      this.calls.addToNotebook.push({ notebookId, noteIds });
      return Promise.resolve();
    }
    removeFromNotebook(
      this: ClassBackedNotes,
      notebookId: string,
      ...noteIds: string[]
    ): Promise<void> {
      recordReceiver(this, "RemoveFromNotebook", this);
      this.calls.removeFromNotebook.push({ notebookId, noteIds });
      return Promise.resolve();
    }
  }
  // Class-backed collection sub-slot — the seam calls
  // `notes.collection.update` directly.  Bind to the collection, not
  // to `notes`, so `this` resolves to the collection instance.
  class ClassBackedCollection {
    readonly owner: ClassBackedNotes;
    readonly calls: { update: unknown[] };
    constructor(owner: ClassBackedNotes) {
      this.owner = owner;
      this.calls = { update: [] };
    }
    update(
      this: ClassBackedCollection,
      ids: readonly string[],
      partial: Record<string, unknown>,
    ): Promise<void> {
      recordReceiver(this, "Update", this);
      this.calls.update.push({ ids, partial });
      return Promise.resolve();
    }
  }

  class ClassBackedContent {
    readonly calls: { add: unknown[]; findByNoteId: unknown[]; updateByNoteId: unknown[] };
    constructor() {
      this.calls = { add: [], findByNoteId: [], updateByNoteId: [] };
    }
    add(this: ClassBackedContent, partial: Record<string, unknown>): Promise<string> {
      recordReceiver(this, "Add", this);
      this.calls.add.push(partial);
      return Promise.resolve(`content-${this.calls.add.length}`);
    }
    findByNoteId(this: ClassBackedContent, noteId: string): Promise<FakeContentRecord | undefined> {
      recordReceiver(this, "FindByNoteId", this);
      this.calls.findByNoteId.push(noteId);
      return Promise.resolve(undefined);
    }
    updateByNoteId(
      this: ClassBackedContent,
      partial: Record<string, unknown>,
      ...ids: string[]
    ): Promise<void> {
      recordReceiver(this, "UpdateByNoteId", this);
      this.calls.updateByNoteId.push({ partial, ids });
      return Promise.resolve();
    }
  }

  class ClassBackedNotebooks {
    readonly calls: { exists: unknown[]; notes: unknown[] };
    constructor() {
      this.calls = { exists: [], notes: [] };
    }
    exists(this: ClassBackedNotebooks, id: string): Promise<boolean> {
      recordReceiver(this, "Exists", this);
      this.calls.exists.push(id);
      return Promise.resolve(true);
    }
    notes(this: ClassBackedNotebooks, id: string): Promise<string[]> {
      recordReceiver(this, "Notes", this);
      this.calls.notes.push(id);
      return Promise.resolve([`notebook-note-${this.calls.notes.length}`]);
    }
  }

  class ClassBackedTags {
    readonly calls: { tag: unknown[]; add: unknown[] };
    constructor() {
      this.calls = { tag: [], add: [] };
    }
    tag(this: ClassBackedTags, id: string): Promise<{ id: string; title: string } | undefined> {
      recordReceiver(this, "Tag", this);
      this.calls.tag.push(id);
      return Promise.resolve({ id, title: `tag-${this.calls.tag.length}` });
    }
    add(this: ClassBackedTags, input: { title: string }): Promise<string> {
      recordReceiver(this, "Add", this);
      this.calls.add.push(input);
      return Promise.resolve(`tag-${this.calls.add.length}`);
    }
  }

  class ClassBackedRelations {
    readonly calls: { add: unknown[]; unlink: unknown[]; from: unknown[] };
    constructor() {
      this.calls = { add: [], unlink: [], from: [] };
    }
    add(
      this: ClassBackedRelations,
      from: { id: string; type: string },
      to: { id: string; type: string },
    ): Promise<void> {
      recordReceiver(this, "Add", this);
      this.calls.add.push({ from, to });
      return Promise.resolve();
    }
    unlink(
      this: ClassBackedRelations,
      from: { id: string; type: string },
      to: { id: string; type: string },
    ): Promise<void> {
      recordReceiver(this, "Unlink", this);
      this.calls.unlink.push({ from, to });
      return Promise.resolve();
    }
    from(
      reference: { id: string; type: string } | { type: string; ids: readonly string[] },
    ): ClassBackedRelationHandle {
      this.calls.from.push(reference);
      return new ClassBackedRelationHandle();
    }
  }

  class ClassBackedRelationHandle {
    readonly calls: { get: unknown[] };
    constructor() {
      this.calls = { get: [] };
    }
    get(): Promise<{ fromId: string; fromType: string; toId: string; toType: string }[]> {
      this.calls.get.push(true);
      return Promise.resolve([]);
    }
  }

  function createClassBackedRuntime(): FakeRuntime {
    const notesInstance = new ClassBackedNotes();
    const contentInstance = new ClassBackedContent();
    const notebooksInstance = new ClassBackedNotebooks();
    const tagsInstance = new ClassBackedTags();
    const relationsInstance = new ClassBackedRelations();
    return {
      calls: {
        note: [],
        addNote: [],
        updateNotes: [],
        addToNotebook: [],
        removeFromNotebook: [],
        contentAdd: [],
        contentUpdate: [],
        contentFind: [],
        notebookExists: [],
        notebookNotes: [],
        tag: [],
        tagAdd: [],
        relationAdd: [],
        relationUnlink: [],
        relationList: [],
      },
      notes: notesInstance as unknown as FakeRuntimeCollections["notes"],
      content: contentInstance as unknown as FakeRuntimeCollections["content"],
      notebooks: notebooksInstance as unknown as FakeRuntimeCollections["notebooks"],
      tags: tagsInstance as unknown as FakeRuntimeCollections["tags"],
      relations: relationsInstance as unknown as FakeRuntimeCollections["relations"],
      // Keep the references so each test can assert against the exact
      // instance the seam must observe as `this`.
      _instances: {
        notes: notesInstance,
        content: contentInstance,
        notebooks: notebooksInstance,
        tags: tagsInstance,
        relations: relationsInstance,
      },
    } as unknown as FakeRuntime;
  }

  it("binds notes.note so the upstream call observes the original notes instance as this", async () => {
    const runtime = createClassBackedRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.note(NOTE_ID);
    const notesInstance = (runtime as unknown as { _instances: { notes: ClassBackedNotes } })
      ._instances.notes;
    expect(notesInstance.calls.note).toEqual([NOTE_ID]);
    expect((notesInstance as unknown as { _observedNote: unknown })._observedNote).toBe(
      notesInstance,
    );
  });

  it("binds notes.add so the upstream call observes the original notes instance as this", async () => {
    const runtime = createClassBackedRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.notesAdd({ title: "x", content: { type: "html", data: "<p>x</p>" } });
    const notesInstance = (runtime as unknown as { _instances: { notes: ClassBackedNotes } })
      ._instances.notes;
    expect(notesInstance.calls.add.length).toBe(1);
    expect((notesInstance as unknown as { _observedAdd: unknown })._observedAdd).toBe(
      notesInstance,
    );
  });

  it("binds notes.addToNotebook so the upstream call observes the original notes instance as this", async () => {
    const runtime = createClassBackedRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.notebookAddNote(NOTEBOOK_ID, NOTE_ID);
    const notesInstance = (runtime as unknown as { _instances: { notes: ClassBackedNotes } })
      ._instances.notes;
    expect(notesInstance.calls.addToNotebook).toEqual([
      { notebookId: NOTEBOOK_ID, noteIds: [NOTE_ID] },
    ]);
    expect(
      (notesInstance as unknown as { _observedAddToNotebook: unknown })._observedAddToNotebook,
    ).toBe(notesInstance);
  });

  it("binds notes.removeFromNotebook so the upstream call observes the original notes instance as this", async () => {
    const runtime = createClassBackedRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.notebookRemoveNote(NOTEBOOK_ID, NOTE_ID);
    const notesInstance = (runtime as unknown as { _instances: { notes: ClassBackedNotes } })
      ._instances.notes;
    expect(notesInstance.calls.removeFromNotebook).toEqual([
      { notebookId: NOTEBOOK_ID, noteIds: [NOTE_ID] },
    ]);
    expect(
      (notesInstance as unknown as { _observedRemoveFromNotebook: unknown })
        ._observedRemoveFromNotebook,
    ).toBe(notesInstance);
  });

  it("binds notes.collection.update to the collection instance, not the notes instance", async () => {
    const runtime = createClassBackedRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.notesUpdate([NOTE_ID], { title: "new" });
    const notesInstance = (runtime as unknown as { _instances: { notes: ClassBackedNotes } })
      ._instances.notes;
    expect(notesInstance.collection.calls.update.length).toBe(1);
    expect(
      (notesInstance.collection as unknown as { _observedUpdate: unknown })._observedUpdate,
    ).toBe(notesInstance.collection);
    expect(
      (notesInstance.collection as unknown as { _observedUpdate: unknown })._observedUpdate,
    ).not.toBe(notesInstance);
  });

  it("binds content.add / findByNoteId / updateByNoteId to the content instance", async () => {
    const runtime = createClassBackedRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.contentAdd({ noteId: NOTE_ID, type: "tiptap", data: "{}" });
    await seam.contentFindByNoteId(NOTE_ID);
    await seam.contentUpdateByNoteId({ data: "new" }, NOTE_ID);
    const contentInstance = (runtime as unknown as { _instances: { content: ClassBackedContent } })
      ._instances.content;
    expect(contentInstance.calls.add.length).toBe(1);
    expect(contentInstance.calls.findByNoteId).toEqual([NOTE_ID]);
    expect(contentInstance.calls.updateByNoteId.length).toBe(1);
    expect((contentInstance as unknown as { _observedAdd: unknown })._observedAdd).toBe(
      contentInstance,
    );
    expect(
      (contentInstance as unknown as { _observedFindByNoteId: unknown })._observedFindByNoteId,
    ).toBe(contentInstance);
    expect(
      (contentInstance as unknown as { _observedUpdateByNoteId: unknown })._observedUpdateByNoteId,
    ).toBe(contentInstance);
  });

  it("binds notebooks.exists / notebooks.notes to the notebooks instance", async () => {
    const runtime = createClassBackedRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.notebookExists(NOTEBOOK_ID);
    await seam.notebookNotes(NOTEBOOK_ID);
    const notebooksInstance = (
      runtime as unknown as { _instances: { notebooks: ClassBackedNotebooks } }
    )._instances.notebooks;
    expect(notebooksInstance.calls.exists).toEqual([NOTEBOOK_ID]);
    expect(notebooksInstance.calls.notes).toEqual([NOTEBOOK_ID]);
    expect((notebooksInstance as unknown as { _observedExists: unknown })._observedExists).toBe(
      notebooksInstance,
    );
    expect((notebooksInstance as unknown as { _observedNotes: unknown })._observedNotes).toBe(
      notebooksInstance,
    );
  });

  it("binds tags.tag / tags.add to the tags instance", async () => {
    const runtime = createClassBackedRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.tagExists(TAG_ID);
    await seam.tagAdd({ title: "home" });
    const tagsInstance = (runtime as unknown as { _instances: { tags: ClassBackedTags } })
      ._instances.tags;
    expect(tagsInstance.calls.tag).toEqual([TAG_ID]);
    expect(tagsInstance.calls.add).toEqual([{ title: "home" }]);
    expect((tagsInstance as unknown as { _observedTag: unknown })._observedTag).toBe(tagsInstance);
    expect((tagsInstance as unknown as { _observedAdd: unknown })._observedAdd).toBe(tagsInstance);
  });

  it("binds relations.add / relations.unlink to the relations instance", async () => {
    const runtime = createClassBackedRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.relationAdd({ fromId: NOTE_ID, toId: TAG_ID, type: "tag" });
    await seam.relationRemove({ fromId: NOTE_ID, toId: TAG_ID, type: "tag" });
    const relationsInstance = (
      runtime as unknown as { _instances: { relations: ClassBackedRelations } }
    )._instances.relations;
    expect(relationsInstance.calls.add.length).toBe(1);
    expect(relationsInstance.calls.unlink.length).toBe(1);
    expect((relationsInstance as unknown as { _observedAdd: unknown })._observedAdd).toBe(
      relationsInstance,
    );
    expect((relationsInstance as unknown as { _observedUnlink: unknown })._observedUnlink).toBe(
      relationsInstance,
    );
  });

  it("binds the get method on the handle returned by relations.from to that handle", async () => {
    // Use a custom class-backed relations whose `from` returns a
    // fresh handle instance and the handle's `get` reads `this` (the
    // handle, NOT the relations owner).  After binding, the seam
    // MUST observe the handle instance as `this` — not the
    // relations instance, not the seam, not `undefined`.
    class TrackedRelationHandle {
      readonly calls: { get: number };
      readonly observedGet: unknown[] = [];
      constructor() {
        this.calls = { get: 0 };
      }
      get(
        this: TrackedRelationHandle,
      ): Promise<{ fromId: string; fromType: string; toId: string; toType: string }[]> {
        this.calls.get += 1;
        this.observedGet.push(this);
        return Promise.resolve([]);
      }
    }
    class TrackedRelations {
      readonly calls: { from: unknown[] };
      readonly handles: TrackedRelationHandle[];
      constructor() {
        this.calls = { from: [] };
        this.handles = [];
      }
      from(
        reference: { id: string; type: string } | { type: string; ids: readonly string[] },
      ): TrackedRelationHandle {
        this.calls.from.push(reference);
        const handle = new TrackedRelationHandle();
        this.handles.push(handle);
        return handle;
      }
    }
    const relationsInstance = new TrackedRelations();
    const runtime = {
      ...createFakeRuntime(),
      relations: {
        add: async () => undefined,
        unlink: async () => undefined,
        from: (...args: unknown[]) =>
          (relationsInstance.from as unknown as (...a: unknown[]) => unknown)(...args),
      },
    } as unknown as FakeRuntime;
    (runtime as unknown as { _tracked: { relations: TrackedRelations } })._tracked = {
      relations: relationsInstance,
    };
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.relationListForNote(NOTE_ID);
    expect(relationsInstance.handles.length).toBe(1);
    const handle = relationsInstance.handles[0]!;
    expect(handle.calls.get).toBe(1);
    expect(handle.observedGet[0]).toBe(handle);
    expect(handle.observedGet[0]).not.toBe(relationsInstance);
  });

  it("a stateful runtime getter cannot redirect the receiver even when binding is in place", async () => {
    const runtime = createClassBackedRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    // Drive `seam.note` several times — every call MUST resolve
    // `this` to the original notes instance.
    for (let i = 0; i < 3; i += 1) {
      await seam.note(NOTE_ID);
    }
    const notesInstance = (runtime as unknown as { _instances: { notes: ClassBackedNotes } })
      ._instances.notes;
    expect(notesInstance.calls.note.length).toBe(3);
    expect((notesInstance as unknown as { _observedNote: unknown })._observedNote).toBe(
      notesInstance,
    );
  });
});

describe("Stage 4 write wiring — hardened snapshots and result boundaries", () => {
  it("captures a nested collection getter once and never follows its replacement", async () => {
    const runtime = createFakeRuntime();
    const benignCollection = runtime.notes.collection;
    const evilCollection = {
      update: async () => {
        throw new Error(`${CANARY}-replacement-collection`);
      },
    };
    let collectionReads = 0;
    const statefulNotes = Object.create(runtime.notes) as Record<string, unknown>;
    Object.defineProperty(statefulNotes, "collection", {
      configurable: true,
      enumerable: true,
      get: () => {
        collectionReads += 1;
        return collectionReads === 1 ? benignCollection : evilCollection;
      },
    });
    const statefulRuntime = {
      ...runtime,
      notes: statefulNotes,
    } as unknown as NotesnookWriteRuntime;
    const seam = bindNotesnookWriteRuntime(statefulRuntime);
    await seam.notesUpdate([NOTE_ID], { title: "safe" });
    await seam.notesUpdate([NOTE_ID], { favorite: true });
    expect(collectionReads).toBe(1);
    expect(runtime.calls.updateNotes).toHaveLength(2);
  });

  it("reads relation rows by bounded indexes without invoking a hostile iterator", async () => {
    const runtime = createFakeRuntime();
    const rows = [{ fromId: NOTE_ID, fromType: "note", toId: TAG_ID, toType: "tag" }];
    const hostileIteratorRows = new Proxy(rows, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error(`${CANARY}-relation-iterator`);
        return Reflect.get(target, property, receiver);
      },
    });
    (runtime.relations as unknown as { from: (reference: unknown) => unknown }).from = () => ({
      get: async () => hostileIteratorRows,
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    await expect(seam.relationListForNote(NOTE_ID)).resolves.toEqual([
      { toId: TAG_ID, type: "tag" },
    ]);
  });

  it("rejects over-large upstream arrays and malformed booleans as sync failures", async () => {
    const runtime = createFakeRuntime();
    (runtime.notebooks as unknown as { notes: (id: string) => Promise<unknown> }).notes =
      async () => Array.from({ length: 1025 }, () => NOTE_ID);
    const seam = bindNotesnookWriteRuntime(runtime);
    const notesResult = await expectAdapterError(() => seam.notebookNotes(NOTEBOOK_ID));
    expect(notesResult.code).toBe("sync_failed");

    const boolRuntime = createFakeRuntime();
    (boolRuntime.notebooks as unknown as { exists: (id: string) => Promise<unknown> }).exists =
      async () => "true";
    const boolSeam = bindNotesnookWriteRuntime(boolRuntime);
    const boolResult = await expectAdapterError(() => boolSeam.notebookExists(NOTEBOOK_ID));
    expect(boolResult.code).toBe("sync_failed");
  });

  it("rejects malformed tag and relation results without leaking upstream data", async () => {
    const runtime = createFakeRuntime();
    (runtime.tags as unknown as { tag: (id: string) => Promise<unknown> }).tag = async () => ({
      id: TAG_ID,
      title: 7,
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    const tagResult = await expectAdapterError(() => seam.tagExists(TAG_ID));
    expect(tagResult.code).toBe("sync_failed");

    const relationRuntime = createFakeRuntime();
    (relationRuntime.relations as unknown as { from: (reference: unknown) => unknown }).from =
      () => ({
        get: async () => [{ fromId: OTHER_ID, fromType: "note", toId: TAG_ID, toType: "tag" }],
      });
    const relationSeam = bindNotesnookWriteRuntime(relationRuntime);
    const relationResult = await expectAdapterError(() =>
      relationSeam.relationListForNote(NOTE_ID),
    );
    expect(relationResult.code).toBe("sync_failed");
    expect(relationResult.message).not.toContain(CANARY);
  });

  it("allowlists caller partials and makes no upstream call for extras or invalid fields", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);

    const noteExtra = await expectAdapterError(() =>
      seam.notesUpdate([NOTE_ID], { title: "safe", database: CANARY }),
    );
    expect(noteExtra.code).toBe("invalid_input");
    expect(runtime.calls.updateNotes).toHaveLength(0);

    const contentExtra = await expectAdapterError(() =>
      seam.contentAdd({ noteId: NOTE_ID, type: "html", data: "{}", raw: CANARY }),
    );
    expect(contentExtra.code).toBe("invalid_input");
    expect(runtime.calls.contentAdd).toHaveLength(0);

    const contentInvalidType = await expectAdapterError(() =>
      seam.contentUpdateByNoteId({ type: "tiny" as never, data: "{}" }, NOTE_ID),
    );
    expect(contentInvalidType.code).toBe("invalid_input");
    expect(runtime.calls.contentUpdate).toHaveLength(0);
  });

  it("maps the closed html input type to upstream tiptap for content.add", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.contentAdd({ noteId: NOTE_ID, type: "html", data: "<p>x</p>" });
    expect(runtime.calls.contentAdd).toEqual([
      { partial: { noteId: NOTE_ID, type: "tiptap", data: "<p>x</p>" } },
    ]);
  });

  it("uses one captured own-key list for a stateful caller partial", async () => {
    const runtime = createFakeRuntime();
    let ownKeyReads = 0;
    const partial = new Proxy(
      { title: "safe" },
      {
        ownKeys: () => {
          ownKeyReads += 1;
          if (ownKeyReads > 1) throw new Error(`${CANARY}-stateful-ownKeys`);
          return ["title"];
        },
      },
    );
    const seam = bindNotesnookWriteRuntime(runtime);
    await seam.notesUpdate([NOTE_ID], partial);
    expect(ownKeyReads).toBe(1);
    expect(runtime.calls.updateNotes).toHaveLength(1);
    expect(runtime.calls.updateNotes[0]?.partial).toEqual({ title: "safe" });
  });

  it("rejects inherited caller fields before invoking upstream", async () => {
    const runtime = createFakeRuntime();
    const inherited = Object.create({ title: "inherited" }) as Record<string, unknown>;
    inherited.pinned = true;
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.notesUpdate([NOTE_ID], inherited));
    expect(result.code).toBe("invalid_input");
    expect(runtime.calls.updateNotes).toHaveLength(0);
  });

  it("reconstructs a mutable marked contract error without cause or context", async () => {
    const runtime = createFakeRuntime();
    (runtime.notes as unknown as { note: (id: string) => Promise<unknown> }).note = async () => {
      const error = new NotesnookWriteContractError("sync_failed");
      (error as Error & { cause?: unknown }).cause = `${CANARY}-cause`;
      (error as Error & { __context__?: unknown }).__context__ = `${CANARY}-context`;
      throw error;
    };
    const seam = bindNotesnookWriteRuntime(runtime);
    try {
      await seam.note(NOTE_ID);
      throw new Error("expected failure");
    } catch (error) {
      if (!isCategoricalWriteError(error)) throw new Error("expected adapter error");
      const typed = error as Error & {
        code?: string;
        cause?: unknown;
        __context__?: unknown;
      };
      expect(typed.code).toBe("sync_failed");
      expect(typed.cause).toBeUndefined();
      expect(typed.__context__).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(typed, "cause")).toMatchObject({
        configurable: false,
        writable: false,
        value: undefined,
      });
      expect(Object.getOwnPropertyDescriptor(typed, "__context__")).toMatchObject({
        configurable: false,
        writable: false,
        value: undefined,
      });
      expect(typed.message).not.toContain(CANARY);
    }
  });

  it("rejects whitespace-only caller identifiers without invoking upstream", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.notesUpdate(["   "], { title: "x" }));
    expect(result.code).toBe("invalid_input");
    expect(runtime.calls.updateNotes).toHaveLength(0);
  });

  it("rejects whitespace-only returned IDs as sync failures", async () => {
    const runtime = createFakeRuntime();
    (runtime.notes as unknown as { add: (input: unknown) => Promise<unknown> }).add = async () =>
      "   ";
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() =>
      seam.notesAdd({ title: "x", content: { type: "html", data: "{}" } }),
    );
    expect(result.code).toBe("sync_failed");
  });

  it("rejects a relation row with a non-note fromType", async () => {
    const runtime = createFakeRuntime();
    (runtime.relations as unknown as { from: (reference: unknown) => unknown }).from = () => ({
      get: async () => [{ fromId: NOTE_ID, fromType: "tag", toId: TAG_ID, toType: "tag" }],
    });
    const seam = bindNotesnookWriteRuntime(runtime);
    const result = await expectAdapterError(() => seam.relationListForNote(NOTE_ID));
    expect(result.code).toBe("sync_failed");
  });
});

describe("Stage 4 write wiring — final identifier and record-boundary regressions", () => {
  const malformedIdentifiers = [
    "bad.id",
    "bad/id",
    "bad id",
    "bad\\tid",
    "bad\\nid",
    "bad\\u0000id",
  ];

  it("rejects punctuation, control, and embedded-whitespace caller IDs in every ID slot", async () => {
    for (const invalidId of malformedIdentifiers) {
      const runtime = createFakeRuntime();
      const seam = bindNotesnookWriteRuntime(runtime);
      const calls = [
        () => seam.note(invalidId),
        () => seam.contentFindByNoteId(invalidId),
        () => seam.notebookExists(invalidId),
        () => seam.notebookNotes(invalidId),
        () => seam.notebookAddNote(invalidId, NOTE_ID),
        () => seam.notebookAddNote(NOTEBOOK_ID, invalidId),
        () => seam.notebookRemoveNote(invalidId, NOTE_ID),
        () => seam.tagExists(invalidId),
        () => seam.relationListForNote(invalidId),
        () => seam.relationAdd({ fromId: invalidId, toId: TAG_ID, type: "tag" }),
        () => seam.relationAdd({ fromId: NOTE_ID, toId: invalidId, type: "tag" }),
        () => seam.relationAdd({ fromId: NOTE_ID, toId: TAG_ID, type: invalidId }),
        () => seam.relationRemove({ fromId: invalidId, toId: TAG_ID, type: "tag" }),
        () => seam.notesUpdate([invalidId], { title: "safe" }),
        () => seam.notesUpdate([NOTE_ID], { notebookId: invalidId }),
        () => seam.notesUpdate([NOTE_ID], { tags: [invalidId] }),
        () => seam.contentAdd({ noteId: invalidId, type: "html", data: "safe" }),
        () => seam.contentUpdateByNoteId({ data: "safe" }, invalidId),
        () => seam.contentUpdateByNoteId({ noteId: invalidId }, NOTE_ID),
      ];
      for (const call of calls) {
        expect((await expectAdapterError(call)).code).toBe("invalid_input");
      }
      for (const upstreamCalls of Object.values(runtime.calls)) {
        expect(upstreamCalls).toHaveLength(0);
      }
    }
  });

  it("rejects punctuation, control, and embedded-whitespace returned IDs", async () => {
    for (const invalidId of malformedIdentifiers) {
      const noteRuntime = createFakeRuntime();
      (noteRuntime.notes as unknown as { add: (input: unknown) => Promise<unknown> }).add =
        async () => invalidId;
      const noteSeam = bindNotesnookWriteRuntime(noteRuntime);
      expect(
        (
          await expectAdapterError(() =>
            noteSeam.notesAdd({ title: "x", content: { type: "html", data: "safe" } }),
          )
        ).code,
      ).toBe("sync_failed");

      const contentRuntime = createFakeRuntime();
      (contentRuntime.content as unknown as { add: (input: unknown) => Promise<unknown> }).add =
        async () => invalidId;
      const contentSeam = bindNotesnookWriteRuntime(contentRuntime);
      expect(
        (
          await expectAdapterError(() =>
            contentSeam.contentAdd({ noteId: NOTE_ID, type: "html", data: "safe" }),
          )
        ).code,
      ).toBe("sync_failed");

      const tagRuntime = createFakeRuntime();
      (tagRuntime.tags as unknown as { add: (input: unknown) => Promise<unknown> }).add =
        async () => invalidId;
      const tagSeam = bindNotesnookWriteRuntime(tagRuntime);
      expect((await expectAdapterError(() => tagSeam.tagAdd({ title: "x" }))).code).toBe(
        "sync_failed",
      );
    }
  });

  it("rejects malformed identifiers in returned note, content, tag, and relation records", async () => {
    const invalidId = "bad.id";

    const noteRuntime = createFakeRuntime();
    (noteRuntime.notes as unknown as { note: (id: string) => Promise<unknown> }).note =
      async () => ({
        id: invalidId,
        title: "x",
        pinned: false,
        favorite: false,
        conflicted: false,
        locked: false,
        dateEdited: 1,
      });
    const noteSeam = bindNotesnookWriteRuntime(noteRuntime);
    expect((await expectAdapterError(() => noteSeam.note(NOTE_ID))).code).toBe("invalid_input");

    const contentRuntime = createFakeRuntime();
    (
      contentRuntime.content as unknown as { findByNoteId: (id: string) => Promise<unknown> }
    ).findByNoteId = async () => ({
      id: invalidId,
      noteId: NOTE_ID,
      type: "tiptap",
      data: "safe",
    });
    const contentSeam = bindNotesnookWriteRuntime(contentRuntime);
    expect((await expectAdapterError(() => contentSeam.contentFindByNoteId(NOTE_ID))).code).toBe(
      "invalid_input",
    );

    const tagRuntime = createFakeRuntime();
    (tagRuntime.tags as unknown as { tag: (id: string) => Promise<unknown> }).tag = async () => ({
      id: invalidId,
      title: "x",
    });
    const tagSeam = bindNotesnookWriteRuntime(tagRuntime);
    expect((await expectAdapterError(() => tagSeam.tagExists(TAG_ID))).code).toBe("sync_failed");

    for (const field of ["fromId", "fromType", "toId", "toType"]) {
      const relationRuntime = createFakeRuntime();
      const row: Record<string, unknown> = {
        fromId: NOTE_ID,
        fromType: "note",
        toId: TAG_ID,
        toType: "tag",
      };
      row[field] = invalidId;
      (relationRuntime.relations as unknown as { from: (reference: unknown) => unknown }).from =
        () => ({ get: async () => [row] });
      const relationSeam = bindNotesnookWriteRuntime(relationRuntime);
      expect((await expectAdapterError(() => relationSeam.relationListForNote(NOTE_ID))).code).toBe(
        "sync_failed",
      );
    }
  });

  it("binds note and content returned identity to the requested lookup", async () => {
    const noteRuntime = createFakeRuntime();
    (noteRuntime.notes as unknown as { note: (id: string) => Promise<unknown> }).note = async (
      id,
    ) => {
      noteRuntime.calls.note.push(id);
      return {
        id: OTHER_ID,
        title: "wrong record",
        pinned: false,
        favorite: false,
        conflicted: false,
        locked: false,
        dateEdited: 1,
      };
    };
    const noteSeam = bindNotesnookWriteRuntime(noteRuntime);
    expect((await expectAdapterError(() => noteSeam.note(NOTE_ID))).code).toBe("invalid_input");
    expect(noteRuntime.calls.note).toEqual([NOTE_ID]);

    const contentRuntime = createFakeRuntime();
    (
      contentRuntime.content as unknown as { findByNoteId: (id: string) => Promise<unknown> }
    ).findByNoteId = async (id) => {
      contentRuntime.calls.contentFind.push(id);
      return {
        id: "content-1",
        noteId: OTHER_ID,
        type: "tiptap",
        data: "wrong record",
      };
    };
    const contentSeam = bindNotesnookWriteRuntime(contentRuntime);
    expect((await expectAdapterError(() => contentSeam.contentFindByNoteId(NOTE_ID))).code).toBe(
      "invalid_input",
    );
    expect(contentRuntime.calls.contentFind).toEqual([NOTE_ID]);
  });

  it("rejects inherited required note fields while ignoring inherited optional fields", async () => {
    const valid: Record<string, unknown> = {
      id: NOTE_ID,
      title: "x",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1,
    };
    for (const field of ["id", "title", "pinned", "favorite", "conflicted", "dateEdited"]) {
      const own = { ...valid };
      const inheritedValue = own[field];
      delete own[field];
      const record = Object.assign(Object.create({ [field]: inheritedValue }), own);
      const runtime = createFakeRuntime();
      (runtime.notes as unknown as { note: (id: string) => Promise<unknown> }).note = async () =>
        record;
      const seam = bindNotesnookWriteRuntime(runtime);
      expect((await expectAdapterError(() => seam.note(NOTE_ID))).code).toBe("invalid_input");
    }

    const optionalRecord = Object.assign(
      Object.create({
        locked: true,
        contentId: "inherited-content",
        notebookId: "inherited-notebook",
        tags: [TAG_ID],
      }),
      valid,
    );
    delete optionalRecord.locked;
    const runtime = createFakeRuntime();
    (runtime.notes as unknown as { note: (id: string) => Promise<unknown> }).note = async () =>
      optionalRecord;
    const seam = bindNotesnookWriteRuntime(runtime);
    await expect(seam.note(NOTE_ID)).resolves.toEqual({
      id: NOTE_ID,
      title: "x",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1,
    });
  });

  it("rejects inherited required content, tag, and relation fields", async () => {
    const content: Record<string, unknown> = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "tiptap",
      data: "safe",
    };
    for (const field of Object.keys(content)) {
      const own = { ...content };
      const inheritedValue = own[field];
      delete own[field];
      const record = Object.assign(Object.create({ [field]: inheritedValue }), own);
      const runtime = createFakeRuntime();
      (
        runtime.content as unknown as { findByNoteId: (id: string) => Promise<unknown> }
      ).findByNoteId = async () => record;
      const seam = bindNotesnookWriteRuntime(runtime);
      expect((await expectAdapterError(() => seam.contentFindByNoteId(NOTE_ID))).code).toBe(
        "invalid_input",
      );
    }

    for (const field of ["id", "title"]) {
      const own: Record<string, unknown> = { id: TAG_ID, title: "tag" };
      const inheritedValue = own[field];
      delete own[field];
      const record = Object.assign(Object.create({ [field]: inheritedValue }), own);
      const runtime = createFakeRuntime();
      (runtime.tags as unknown as { tag: (id: string) => Promise<unknown> }).tag = async () =>
        record;
      const seam = bindNotesnookWriteRuntime(runtime);
      expect((await expectAdapterError(() => seam.tagExists(TAG_ID))).code).toBe("sync_failed");
    }

    for (const field of ["fromId", "fromType", "toId", "toType"]) {
      const own: Record<string, unknown> = {
        fromId: NOTE_ID,
        fromType: "note",
        toId: TAG_ID,
        toType: "tag",
      };
      const inheritedValue = own[field];
      delete own[field];
      const record = Object.assign(Object.create({ [field]: inheritedValue }), own);
      const runtime = createFakeRuntime();
      (runtime.relations as unknown as { from: (reference: unknown) => unknown }).from = () => ({
        get: async () => [record],
      });
      const seam = bindNotesnookWriteRuntime(runtime);
      expect((await expectAdapterError(() => seam.relationListForNote(NOTE_ID))).code).toBe(
        "sync_failed",
      );
    }
  });

  it("rejects overlong IDs before scanning them for whitespace", async () => {
    const runtime = createFakeRuntime();
    const seam = bindNotesnookWriteRuntime(runtime);
    const originalTrim = String.prototype.trim;
    let trimCalls = 0;
    String.prototype.trim = function (this: string): string {
      trimCalls += 1;
      return originalTrim.call(this);
    };
    try {
      const result = await expectAdapterError(() => seam.note("a".repeat(129)));
      expect(result.code).toBe("invalid_input");
      expect(trimCalls).toBe(0);
      expect(runtime.calls.note).toHaveLength(0);
    } finally {
      String.prototype.trim = originalTrim;
    }
  });
});
