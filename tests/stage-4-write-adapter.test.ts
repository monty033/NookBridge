/**
 * Stage 4 — bounded local Notesnook mutation adapter.
 *
 * Scope of this file (`docs/stage-4-write-plan.md` §2/§3/§5):
 *
 *   - create / append / controlled update backed by an explicit,
 *     separately named `NotesnookWriteDatabase` structural seam;
 *   - revision guards (read current state immediately before mutation,
 *     fail closed on stale revision, never choose a side);
 *   - categorical redaction (never leak upstream messages, note ids,
 *     bodies, canaries, causes, or context);
 *   - locked / unsupported / conflict mappings;
 *   - hostile-getter / Proxy-safety;
 *   - explicit rejection of sync / delete / force / Vault escape hatches.
 *
 * These tests are offline: the adapter never imports `@notesnook/*`,
 * every operation is driven through an injected structural seam that
 * the test owns end-to-end.  Nothing here can write to a real vault.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createNotesnookWriteAdapter,
  isNotesnookWriteAdapterError,
  type NotesnookStoredContent,
  type NotesnookWriteAdapter,
  type NotesnookWriteDatabase,
  type NotesnookWriteMarkdownCodec,
  type NotesnookWriteNoteMetadata,
  type NotesnookWriteStoredContent,
} from "../src/core/notesnook-write-adapter.js";
import type { NotesnookListKind } from "../src/core/notesnook-write-codec.js";
import {
  isNotesnookWriteContractError,
  type AppendNoteCommand,
  type CreateNoteCommand,
  type NotesnookRevisionToken,
  type NotesnookWriteErrorCode,
  type UpdateNoteCommand,
} from "../src/core/notesnook-write-contract.js";

// ---------------------------------------------------------------------------
// Test fixtures.
//
// `NotesnookWriteDatabase` is a structural seam that the adapter consumes;
// every member is an optional spy the test can install per scenario.
// `NotesnookWriteMarkdownCodec` is an explicit Markdown → stored-content
// translation seam; tests inject a deterministic stand-in so we can assert
// exactly one fragment, exactly one codec call, and that no raw Markdown
// is ever written into the stored HTML/Tiptap slot.
// ---------------------------------------------------------------------------

const CANARY = "CANARY-stage-4-write-adapter-9f3b";

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";
const NOTEBOOK_ID = "cafebabecafebabecafebabecafebabe";
const TAG_ID = "deadbeefdeadbeefdeadbeefdeadbeef";
const SECOND_TAG_ID = "beadbeadbeadbeadbeadbeadbeadbead";

interface FakeWriteDatabaseOptions {
  notes?: Map<string, FakeNote>;
  notebooks?: Map<string, FakeNotebook>;
  tags?: Map<string, FakeTag>;
  relations?: FakeRelation[];
  content?: Map<string, FakeContent>;
  deleteFails?: boolean;
  relationAddFailsAt?: number;
  relationAddOverride?: (count: number, input: FakeRelation) => Promise<void>;
}

interface FakeNote {
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

interface FakeNotebook {
  id: string;
  title: string;
  notes: string[];
}

interface FakeTag {
  id: string;
  title: string;
}

interface FakeRelation {
  fromId: string;
  toId: string;
  type: string;
}

interface FakeContent {
  id: string;
  noteId: string;
  type: "tiptap" | "html";
  data: string;
}

// `createFakeDatabase` returns a test-owned mutable object.  Each
// member is declared without the `readonly` modifier so individual
// tests can swap the implementation (race / hostile-getter scenarios)
// while still satisfying the readonly `NotesnookWriteDatabase` seam
// the adapter expects — mutable function-typed members are assignable
// to readonly slots under TypeScript's standard covariance rules.
interface FakeDatabaseCalls {
  add: Array<{ title: string; contentType: "tiptap" | "html"; contentData: string }>;
  update: Array<{ ids: string[]; partial: Record<string, unknown> }>;
  touch: Array<{ ids: string[]; dateEdited: number }>;
  contentUpdate: Array<{ partial: Record<string, unknown>; ids: string[] }>;
  contentAdd: Array<{ partial: Record<string, unknown> }>;
  notebookAdd: Array<{ noteId: string; notebookId: string }>;
  notebookRemove: Array<{ noteId: string; notebookId: string }>;
  notebookExists: string[];
  notebookNotes: string[];
  note: string[];
  contentFind: string[];
  tagAdd: Array<{ title: string }>;
  relationAdd: Array<{ fromId: string; toId: string; type: string }>;
  relationRemove: Array<{ fromId: string; toId: string; type: string }>;
  delete: string[];
}
interface FakeDatabase extends NotesnookWriteDatabase {
  calls: FakeDatabaseCalls;
  note: (id: string) => Promise<NotesnookWriteNoteMetadata | undefined>;
  contentFindByNoteId: (noteId: string) => Promise<NotesnookWriteStoredContent | undefined>;
  notesAdd: (input: {
    readonly title: string;
    readonly content: NotesnookStoredContent;
  }) => Promise<string>;
  notesUpdate: (ids: readonly string[], partial: Record<string, unknown>) => Promise<void>;
  notesTouch: (ids: readonly string[], dateEdited: number) => Promise<void>;
  contentAdd: (partial: Record<string, unknown>) => Promise<string>;
  contentUpdateByNoteId: (partial: Record<string, unknown>, ...ids: string[]) => Promise<void>;
  notebookExists: (id: string) => Promise<boolean>;
  notebookNotes: (id: string) => Promise<readonly string[]>;
  notebookAddNote: (notebookId: string, noteId: string) => Promise<void>;
  notebookRemoveNote: (notebookId: string, noteId: string) => Promise<void>;
  tagExists: (id: string) => Promise<boolean>;
  tagAdd: (input: { readonly title: string }) => Promise<string>;
  relationAdd: (input: {
    readonly fromId: string;
    readonly toId: string;
    readonly type: string;
  }) => Promise<void>;
  relationRemove: (input: {
    readonly fromId: string;
    readonly toId: string;
    readonly type: string;
  }) => Promise<void>;
  relationListForNote: (
    noteId: string,
  ) => Promise<ReadonlyArray<{ readonly toId: string; readonly type: string }>>;
}

function createFakeDatabase(options: FakeWriteDatabaseOptions = {}): FakeDatabase {
  const notes = options.notes ?? new Map<string, FakeNote>();
  const notebooks = options.notebooks ?? new Map<string, FakeNotebook>();
  const tags = options.tags ?? new Map<string, FakeTag>();
  const relations = options.relations ?? [];
  const content = options.content ?? new Map<string, FakeContent>();

  const calls: FakeDatabaseCalls = {
    add: [],
    update: [],
    touch: [],
    contentUpdate: [],
    contentAdd: [],
    notebookAdd: [],
    notebookRemove: [],
    notebookExists: [],
    notebookNotes: [],
    note: [],
    contentFind: [],
    tagAdd: [],
    relationAdd: [],
    relationRemove: [],
    delete: [],
  };

  return {
    calls,
    note: async (id: string) => {
      calls.note.push(id);
      const note = notes.get(id);
      if (!note) return undefined;
      // `exactOptionalPropertyTypes` rejects an explicit
      // `contentId: string | undefined` against the seam's optional
      // `contentId?: string`; omit the key when the fixture leaves it
      // absent so the returned shape matches production metadata.
      return {
        id: note.id,
        title: note.title,
        ...(note.contentId !== undefined ? { contentId: note.contentId } : {}),
        ...(note.notebookId !== undefined ? { notebookId: note.notebookId } : {}),
        pinned: note.pinned,
        favorite: note.favorite,
        conflicted: note.conflicted,
        locked: note.locked,
        dateEdited: note.dateEdited,
        ...(note.tags ? { tags: note.tags } : {}),
      };
    },
    contentFindByNoteId: async (id: string) => {
      calls.contentFind.push(id);
      for (const item of content.values()) {
        if (item.noteId === id) {
          return {
            id: item.id,
            noteId: item.noteId,
            type: item.type,
            data: item.data,
          };
        }
      }
      return undefined;
    },
    notesAdd: async ({
      title,
      content,
    }: {
      title: string;
      content: { type: "tiptap" | "html"; data: string };
    }) => {
      calls.add.push({ title, contentType: content.type, contentData: content.data });
      const id = `note-${notes.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
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
    notesDelete: async (id: string) => {
      calls.delete.push(id);
      if (options.deleteFails) throw new Error("delete failed");
      notes.delete(id);
      content.forEach((item, contentId) => {
        if (item.noteId === id) content.delete(contentId);
      });
      for (const notebook of notebooks.values()) {
        notebook.notes = notebook.notes.filter((noteId) => noteId !== id);
      }
      for (let index = relations.length - 1; index >= 0; index -= 1) {
        const relation = relations[index]!;
        if (relation.fromId === id || relation.toId === id) relations.splice(index, 1);
      }
    },
    notesUpdate: async (ids: readonly string[], partial: Record<string, unknown>) => {
      calls.update.push({ ids: [...ids], partial: { ...partial } });
      for (const id of ids) {
        const note = notes.get(id);
        if (!note) continue;
        if (typeof partial.title === "string") note.title = partial.title;
        if (typeof partial.pinned === "boolean") note.pinned = partial.pinned;
        if (typeof partial.favorite === "boolean") note.favorite = partial.favorite;
        if (Object.prototype.hasOwnProperty.call(partial, "notebookId")) {
          if (typeof partial.notebookId === "string") note.notebookId = partial.notebookId;
          else if (partial.notebookId === undefined) delete note.notebookId;
        }
        if (Array.isArray(partial.tags)) note.tags = [...(partial.tags as string[])];
        note.dateEdited += 1;
      }
    },
    notesTouch: async (ids: readonly string[], dateEdited: number) => {
      calls.touch.push({ ids: [...ids], dateEdited });
      for (const id of ids) {
        const note = notes.get(id);
        if (!note) continue;
        note.dateEdited = dateEdited;
      }
    },
    contentAdd: async (partial: Record<string, unknown>) => {
      calls.contentAdd.push({ partial: { ...partial } });
      const id = `content-${content.size + 1}`;
      content.set(id, {
        id,
        noteId: typeof partial.noteId === "string" ? partial.noteId : "",
        type: partial.type === "html" ? "html" : "tiptap",
        data: typeof partial.data === "string" ? partial.data : "",
      });
      return id;
    },
    contentUpdateByNoteId: async (partial: Record<string, unknown>, ...ids: string[]) => {
      calls.contentUpdate.push({ partial: { ...partial }, ids: [...ids] });
      for (const id of ids) {
        for (const item of content.values()) {
          if (item.noteId === id) {
            if (typeof partial.type === "string") {
              (item as { type: string }).type = partial.type === "html" ? "html" : "tiptap";
            }
            if (typeof partial.data === "string") {
              (item as { data: string }).data = partial.data;
            }
          }
        }
      }
    },
    notebookExists: async (id: string) => {
      calls.notebookExists.push(id);
      return notebooks.has(id);
    },
    notebookNotes: async (id: string) => {
      calls.notebookNotes.push(id);
      return notebooks.get(id)?.notes.slice() ?? [];
    },
    notebookAddNote: async (notebookId: string, noteId: string) => {
      calls.notebookAdd.push({ notebookId, noteId });
      const notebook = notebooks.get(notebookId);
      if (!notebook) throw new Error(`fake: notebook ${notebookId} missing`);
      if (!notebook.notes.includes(noteId)) notebook.notes.push(noteId);
    },
    notebookRemoveNote: async (notebookId: string, noteId: string) => {
      calls.notebookRemove.push({ notebookId, noteId });
      const notebook = notebooks.get(notebookId);
      if (!notebook) throw new Error(`fake: notebook ${notebookId} missing`);
      const idx = notebook.notes.indexOf(noteId);
      if (idx !== -1) notebook.notes.splice(idx, 1);
    },
    tagExists: async (id: string) => tags.has(id),
    tagAdd: async ({ title }: { title: string }) => {
      calls.tagAdd.push({ title });
      const id = `tag-${tags.size + 1}`;
      tags.set(id, { id, title });
      return id;
    },
    relationAdd: async ({ fromId, toId, type }: { fromId: string; toId: string; type: string }) => {
      calls.relationAdd.push({ fromId, toId, type });
      const count = calls.relationAdd.length;
      if (options.relationAddOverride !== undefined) {
        await options.relationAddOverride(count, { fromId, toId, type });
        // The override is the authoritative decision; if it didn't throw,
        // record the relation.  If the override also wrote to the live
        // relations array, honour that.
        relations.push({ fromId, toId, type });
        return;
      }
      if (options.relationAddFailsAt === calls.relationAdd.length) {
        throw new Error("relation add failed");
      }
      relations.push({ fromId, toId, type });
    },
    relationRemove: async ({
      fromId,
      toId,
      type,
    }: {
      fromId: string;
      toId: string;
      type: string;
    }) => {
      calls.relationRemove.push({ fromId, toId, type });
      for (let i = relations.length - 1; i >= 0; i -= 1) {
        const rel = relations[i]!;
        if (rel.fromId === fromId && rel.toId === toId && rel.type === type) {
          relations.splice(i, 1);
        }
      }
    },
    relationListForNote: async (noteId: string) =>
      relations.filter((r) => r.fromId === noteId).map((r) => ({ toId: r.toId, type: r.type })),
  };
}

interface FakeCodec extends NotesnookWriteMarkdownCodec {
  encodeCalls: string[];
  listKindCalls: Array<NotesnookListKind | undefined>;
  appendCalls: number;
  encodeMarkdown: (markdown: string, listKind?: NotesnookListKind) => NotesnookStoredContent;
  appendMarkdownToStoredContent: (input: {
    readonly storedType: "tiptap" | "html";
    readonly storedData: string;
    readonly markdownFragment: string;
    readonly listKind?: NotesnookListKind;
  }) => NotesnookStoredContent;
}

function htmlCodec(): FakeCodec {
  const encodeCalls: string[] = [];
  const listKindCalls: Array<NotesnookListKind | undefined> = [];
  let appendCalls = 0;
  return {
    encodeCalls,
    listKindCalls,
    get appendCalls() {
      return appendCalls;
    },
    encodeMarkdown: (markdown: string, listKind?: NotesnookListKind) => {
      encodeCalls.push(markdown);
      listKindCalls.push(listKind);
      // Deterministic, hostile-free HTML: every newline is a paragraph
      // boundary.  Tests assert exact equality so the contract is
      // auditable; no library is involved.
      const escaped = markdown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const paragraphs = escaped.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`);
      return { type: "html" as const, data: paragraphs.join("") };
    },
    appendMarkdownToStoredContent: ({
      storedType,
      storedData,
      markdownFragment,
    }: {
      storedType: "tiptap" | "html";
      storedData: string;
      markdownFragment: string;
    }) => {
      appendCalls += 1;
      // Pretend storedData is plain HTML and append a single paragraph.
      // The stored representation is preserved verbatim except for a
      // trailing appended paragraph that contains only the codec-rendered
      // Markdown fragment — never the raw Markdown.
      const encoded = markdownFragment
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const fragmentParagraph = `<p>${encoded.replace(/\n/g, "<br/>")}</p>`;
      return { type: storedType, data: `${storedData}${fragmentParagraph}` };
    },
  };
}

/**
 * Fake codec that mirrors the production deterministic codec's interactive
 * Notesnook simple-checklist shape: a block made entirely of `- [ ]` / `- [x]`
 * task-list lines becomes `<ul class="simple-checklist"><li
 * class="checked simple-checklist--item"><p>…</p></li></ul>` for completed
 * items and `class="simple-checklist--item"` otherwise.
 */
function nativeChecklistCodec(): FakeCodec {
  const encodeCalls: string[] = [];
  const listKindCalls: Array<NotesnookListKind | undefined> = [];
  let appendCalls = 0;
  const encode = (markdown: string, listKind?: NotesnookListKind): NotesnookStoredContent => {
    encodeCalls.push(markdown);
    listKindCalls.push(listKind);
    // simple-checklist with one item.
    const match = /^[-*] +\[( |x|X)\] +([^\n]*)$/.exec(markdown);
    if (match !== null) {
      const checked = match[1] !== " ";
      const text = match[2] ?? "";
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const openTag = `<li class="${checked ? "checked " : ""}simple-checklist--item"><p>`;
      return {
        type: "tiptap" as const,
        data: `<div data-type="document"><ul class="simple-checklist">${openTag}${escaped}</p></li></ul></div>`,
      };
    }
    // Fall through to a simple paragraph shape for anything else so the
    // fake remains total over accepted input.
    const escaped = markdown.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return {
      type: "tiptap" as const,
      data: `<div data-type="document"><p>${escaped.replace(/\n/g, "<br/>")}</p></div>`,
    };
  };
  return {
    encodeCalls,
    get appendCalls() {
      return appendCalls;
    },
    listKindCalls,
    encodeMarkdown: encode,
    appendMarkdownToStoredContent: ({
      storedType,
      storedData,
      markdownFragment,
    }: {
      storedType: "tiptap" | "html";
      storedData: string;
      markdownFragment: string;
    }) => {
      appendCalls += 1;
      // For tiptap stored content, splice the freshly encoded block
      // inside the existing `<div data-type="document">…</div>` root so
      // the resulting tree stays well-formed.
      const encoded = encode(markdownFragment);
      if (storedType === "tiptap") {
        const trailingMatch = /<\/div>\s*$/.exec(storedData);
        if (trailingMatch !== null) {
          const head = storedData.slice(0, storedData.length - trailingMatch[0].length);
          const inner = encoded.data
            .replace(/^<div data-type="document">/, "")
            .replace(/<\/div>$/, "");
          return { type: storedType, data: `${head}${inner}</div>` };
        }
        return { type: storedType, data: `${storedData}${encoded.data}` };
      }
      return { type: storedType, data: `${storedData}${encoded.data}` };
    },
  };
}

// Mirrors the contract's `createRevisionToken`: counter defaults to 0
// when the observed state does not surface a `revisionCounter`.  The
// adapter's revision guard must derive its token from whatever the
// seam returns, and the fake seam does not surface a counter.
function revisionToken(id: string, dateEdited: number, counter = 0): NotesnookRevisionToken {
  const hex = createHash("sha256")
    .update(`${id}\u0000${dateEdited}\u0000${counter}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `rev_${hex}` as NotesnookRevisionToken;
}

function codeOf(fn: () => unknown): NotesnookWriteErrorCode {
  try {
    fn();
  } catch (error) {
    if (!isNotesnookWriteContractError(error) && !isNotesnookWriteAdapterError(error)) {
      throw new Error("expected a categorical Stage 4 write error");
    }
    // The narrowing above proves the error is one of the contract
    // types, both of which carry a `code`; route through `unknown`
    // because TypeScript can't follow the runtime guards as type
    // predicates.
    return (error as unknown as { code: NotesnookWriteErrorCode }).code;
  }
  throw new Error("expected the Stage 4 write adapter to fail closed");
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<NotesnookWriteErrorCode> {
  try {
    await fn();
  } catch (error) {
    if (!isNotesnookWriteContractError(error) && !isNotesnookWriteAdapterError(error)) {
      throw new Error("expected a categorical Stage 4 write error");
    }
    return (error as unknown as { code: NotesnookWriteErrorCode }).code;
  }
  throw new Error("expected the Stage 4 write adapter to fail closed");
}

// ---------------------------------------------------------------------------
// createNote
// ---------------------------------------------------------------------------

describe("Stage 4 write adapter — createNote", () => {
  it("creates a note from a CreateNoteCommand and returns a bounded local outcome", async () => {
    const database = createFakeDatabase();
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec,
    });

    const result = await adapter.createNote({
      title: "Groceries",
      content: "- milk\n- oats\n",
    });

    // The result shape must reflect "local commit only, never remote-synced".
    expect(result.operation).toBe("create");
    expect(result.localCommitted).toBe(true);
    expect(result.remoteSynced).toBe(false);
    expect(result.pendingSync).toBe(true);
    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.titleBytes).toBe(Buffer.byteLength("Groceries", "utf8"));
    expect(result.contentBytes).toBe(Buffer.byteLength("- milk\n- oats\n", "utf8"));
    expect(Object.isFrozen(result)).toBe(true);

    // The adapter must have driven exactly one notes.add call and the
    // codec must have been invoked exactly once.  No raw Markdown is
    // written into the stored content slot.
    expect(database.calls.add).toHaveLength(1);
    expect(database.calls.add[0]?.title).toBe("Groceries");
    expect(database.calls.add[0]?.contentType).toBe("html");
    expect(database.calls.add[0]?.contentData).not.toContain("- milk\n- oats\n");
    expect(database.calls.add[0]?.contentData).toContain("milk");
    expect(codec.encodeCalls).toEqual(["- milk\n- oats\n"]);

    // No sync/delete/force escape hatch may have fired.
    expect(database.calls.update).toHaveLength(0);
    expect(database.calls.notebookAdd).toHaveLength(0);
  });

  it("preserves explicit listKind through the defensive command snapshot", async () => {
    const database = createFakeDatabase();
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });

    await adapter.createNote({
      title: "Task intent",
      content: "- [ ] task",
      listKind: "task-list",
    });

    expect(codec.listKindCalls).toEqual(["task-list"]);
  });

  it("snapshots stateful create command getters before codec and database calls", async () => {
    const database = createFakeDatabase();
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });
    let titleReads = 0;
    let contentReads = 0;
    const command = {
      get title(): string {
        titleReads += 1;
        return titleReads === 1 ? "first title" : CANARY;
      },
      get content(): string {
        contentReads += 1;
        return contentReads === 1 ? "first body" : CANARY;
      },
    } as unknown as CreateNoteCommand;

    await adapter.createNote(command);

    expect(titleReads).toBe(1);
    expect(contentReads).toBe(1);
    expect(codec.encodeCalls).toEqual(["first body"]);
    expect(database.calls.add[0]?.title).toBe("first title");
  });

  it("rejects creation when a notebookId is supplied but the notebook does not exist", async () => {
    const database = createFakeDatabase();
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec,
    });

    const code = await codeOfAsync(() =>
      adapter.createNote({
        title: "t",
        content: "body",
        notebookId: NOTEBOOK_ID,
      }),
    );
    expect(code).toBe("invalid_input");
    expect(database.calls.add).toHaveLength(0);
    expect(database.calls.notebookAdd).toHaveLength(0);
  });

  it("attaches the note to the allowlisted notebook on create when it exists", async () => {
    const notebooks = new Map<string, FakeNotebook>([
      [NOTEBOOK_ID, { id: NOTEBOOK_ID, title: "Work", notes: [] }],
    ]);
    const database = createFakeDatabase({ notebooks });
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec,
    });

    const result = await adapter.createNote({
      title: "Meeting",
      content: "agenda",
      notebookId: NOTEBOOK_ID,
    });

    expect(result.localCommitted).toBe(true);
    expect(database.calls.notebookExists).toEqual([NOTEBOOK_ID]);
    expect(database.calls.notebookAdd).toHaveLength(1);
    expect(database.calls.notebookAdd[0]).toEqual({
      notebookId: NOTEBOOK_ID,
      noteId: result.id,
    });
  });

  it("compensates a created note when notebook attachment fails", async () => {
    const notebooks = new Map<string, FakeNotebook>([
      [NOTEBOOK_ID, { id: NOTEBOOK_ID, title: "Work", notes: [] }],
    ]);
    const database = createFakeDatabase({ notebooks });
    database.notebookAddNote = async () => {
      throw new Error("attachment failed");
    };
    const adapter = createNotesnookWriteAdapter({ source: database, codec: htmlCodec() });

    const code = await codeOfAsync(() =>
      adapter.createNote({ title: "Rollback me", content: "body", notebookId: NOTEBOOK_ID }),
    );

    expect(code).toBe("sync_failed");
    expect(database.calls.add).toHaveLength(1);
    expect(database.calls.delete).toHaveLength(1);
    expect(database.calls.delete[0]).toMatch(/^note-/);
  });

  it("removes earlier tag relations when a later create relation fails", async () => {
    const relations: FakeRelation[] = [];
    const database = createFakeDatabase({
      relations,
      tags: new Map<string, FakeTag>([
        [TAG_ID, { id: TAG_ID, title: "home" }],
        [SECOND_TAG_ID, { id: SECOND_TAG_ID, title: "urgent" }],
      ]),
      relationAddFailsAt: 2,
    });
    const adapter = createNotesnookWriteAdapter({ source: database, codec: htmlCodec() });

    const code = await codeOfAsync(() =>
      adapter.createNote({
        title: "Rollback relations",
        content: "body",
        tags: [TAG_ID, SECOND_TAG_ID],
      }),
    );

    expect(code).toBe("sync_failed");
    expect(database.calls.relationAdd).toHaveLength(2);
    expect(database.calls.delete).toHaveLength(1);
    expect(relations).toEqual([]);
  });

  it("records a bounded recovery marker when create compensation fails", async () => {
    const notebooks = new Map<string, FakeNotebook>([
      [NOTEBOOK_ID, { id: NOTEBOOK_ID, title: "Work", notes: [] }],
    ]);
    const database = createFakeDatabase({ notebooks, deleteFails: true });
    database.notebookAddNote = async () => {
      throw new Error("attachment failed");
    };
    const markers: unknown[] = [];
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec: htmlCodec(),
      recoveryJournal: {
        record: (marker: unknown) => markers.push(marker),
        snapshot: () => [],
      },
    });

    const code = await codeOfAsync(() =>
      adapter.createNote({ title: "Recovery marker", content: "body", notebookId: NOTEBOOK_ID }),
    );

    expect(code).toBe("sync_failed");
    expect(markers).toEqual([
      {
        operation: "create",
        noteId: expect.stringMatching(/^note-/),
        stage: "create-notebook-attach",
      },
    ]);
  });

  it("creates notes and tag relations only via the allowlisted relation seam", async () => {
    const database = createFakeDatabase({
      tags: new Map<string, FakeTag>([[TAG_ID, { id: TAG_ID, title: "home" }]]),
    });
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec,
    });

    const result = await adapter.createNote({
      title: "Tagged",
      content: "body",
      tags: [TAG_ID],
    });

    expect(result.localCommitted).toBe(true);
    expect(database.calls.tagAdd).toHaveLength(0);
    expect(database.calls.relationAdd).toHaveLength(1);
    expect(database.calls.relationAdd[0]).toEqual({
      fromId: result.id,
      toId: TAG_ID,
      type: "tag",
    });
  });

  it("rejects every unknown create tag before creating the note", async () => {
    const database = createFakeDatabase();
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });

    const code = await codeOfAsync(() =>
      adapter.createNote({
        title: "Tagged",
        content: "body",
        tags: [TAG_ID],
      }),
    );

    expect(code).toBe("invalid_input");
    expect(database.calls.add).toHaveLength(0);
    expect(database.calls.relationAdd).toHaveLength(0);
    expect(codec.encodeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// appendNote
// ---------------------------------------------------------------------------

describe("Stage 4 write adapter — appendNote", () => {
  it("snapshots a stateful append fragment before the codec call", async () => {
    const { adapter, database, codec } = (() => {
      const note: FakeNote = {
        id: NOTE_ID,
        title: "Journal",
        contentId: "content-1",
        pinned: false,
        favorite: false,
        conflicted: false,
        locked: false,
        dateEdited: 1_700_000_000_000,
      };
      const stored: FakeContent = {
        id: "content-1",
        noteId: NOTE_ID,
        type: "html",
        data: "<p>existing</p>",
      };
      const database = createFakeDatabase({
        notes: new Map([[NOTE_ID, note]]),
        content: new Map([[stored.id, stored]]),
      });
      const codec = htmlCodec();
      return {
        adapter: createNotesnookWriteAdapter({ source: database, codec }),
        database,
        codec,
      };
    })();
    let fragmentReads = 0;
    const command = {
      id: NOTE_ID,
      get markdownFragment(): string {
        fragmentReads += 1;
        return fragmentReads === 1 ? "first fragment" : CANARY;
      },
      expectedRevision: revisionToken(NOTE_ID, 1_700_000_000_000),
    } as unknown as AppendNoteCommand;

    await adapter.appendNote(command);

    expect(fragmentReads).toBe(1);
    expect(codec.appendCalls).toBe(1);
    expect(database.calls.contentUpdate[0]?.partial.data).toContain("first fragment");
    expect(database.calls.contentUpdate[0]?.partial.data).not.toContain(CANARY);
  });

  function setupAppendable(): {
    adapter: NotesnookWriteAdapter;
    database: ReturnType<typeof createFakeDatabase>;
    codec: ReturnType<typeof htmlCodec>;
    note: FakeNote;
    content: FakeContent;
  } {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "Journal",
      contentId: "content-1",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1_700_000_000_000,
    };
    const stored: FakeContent = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "html",
      data: "<p>existing paragraph</p>",
    };
    const database = createFakeDatabase({
      notes: new Map([[NOTE_ID, note]]),
      content: new Map([[stored.id, stored]]),
    });
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec,
    });
    return { adapter, database, codec, note, content: stored };
  }

  it("appends exactly one Markdown fragment while preserving the stored representation", async () => {
    const { adapter, database, codec, content } = setupAppendable();
    const expectedRevision = revisionToken(NOTE_ID, content.noteId ? 1_700_000_000_000 : 0);

    const before = content.data;
    const result = await adapter.appendNote({
      id: NOTE_ID,
      markdownFragment: "second line",
      expectedRevision,
    });

    expect(result.operation).toBe("append");
    expect(result.localCommitted).toBe(true);
    expect(result.remoteSynced).toBe(false);
    expect(result.pendingSync).toBe(true);
    expect(result.id).toBe(NOTE_ID);

    // Exactly one content update; the stored representation's prefix
    // (the original HTML paragraph) survives untouched.
    expect(database.calls.contentUpdate).toHaveLength(1);
    expect(database.calls.contentUpdate[0]?.ids).toEqual([NOTE_ID]);
    expect(codec.appendCalls).toBe(1);

    const nextData = database.calls.contentUpdate[0]?.partial.data as string;
    expect(nextData.startsWith(before)).toBe(true);
    expect(nextData).not.toContain("second line\n");
    expect(nextData).toContain("second line");
    expect(nextData).not.toContain("<script");
  });

  it("reads the current state immediately before the mutation to compute the guard token", async () => {
    const { adapter, database, codec } = setupAppendable();
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    // Mutate the note's dateEdited AFTER the test sets the expected
    // revision; the adapter must re-read the note and reject with
    // `stale_revision` because its derived current token no longer
    // matches `expectedRevision`.
    const targetNote = database as unknown as { calls: { note: string[] } };
    void targetNote;
    const originalNoteImpl = database.note;
    database.note = (async (id: string) => {
      const base = await originalNoteImpl(id);
      if (!base) return base;
      return { ...base, dateEdited: 1_700_000_000_999 };
    }) as typeof database.note;

    const code = await codeOfAsync(() =>
      adapter.appendNote({
        id: NOTE_ID,
        markdownFragment: "x",
        expectedRevision,
      }),
    );
    expect(code).toBe("stale_revision");

    // Zero mutator calls — the guard must short-circuit before any
    // notes.update / content.update fires.
    expect(database.calls.update).toHaveLength(0);
    expect(database.calls.contentUpdate).toHaveLength(0);
    expect(codec.appendCalls).toBe(0);
  });

  it("rejects locked notes as vault_locked without leaking body or ids", async () => {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "Locked",
      contentId: "content-1",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: true,
      dateEdited: 1_700_000_000_000,
    };
    const stored: FakeContent = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "html",
      data: "<p>secret body</p>",
    };
    const database = createFakeDatabase({
      notes: new Map([[NOTE_ID, note]]),
      content: new Map([[stored.id, stored]]),
    });
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec,
    });

    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    const code = await codeOfAsync(() =>
      adapter.appendNote({
        id: NOTE_ID,
        markdownFragment: "x",
        expectedRevision,
      }),
    );
    expect(code).toBe("vault_locked");
    expect(database.calls.contentUpdate).toHaveLength(0);
    expect(database.calls.update).toHaveLength(0);

    // The error message must NOT contain the locked-note id, the
    // body string, or the canary the test planted in the body.
    let error: unknown;
    try {
      await adapter.appendNote({
        id: NOTE_ID,
        markdownFragment: "x",
        expectedRevision,
      });
    } catch (e) {
      error = e;
    }
    if (!error) throw new Error("expected throw");
    expect(String((error as Error).message)).not.toContain(NOTE_ID);
    expect(String((error as Error).message)).not.toContain("secret body");
    expect(String((error as Error).message)).not.toContain(CANARY);
  });

  it("rejects unsupported content types as unsupported_content", async () => {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "Journal",
      contentId: "content-1",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1_700_000_000_000,
    };
    const stored: FakeContent = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "tiptap",
      data: '{"type":"doc","content":[]}',
    };
    const database = createFakeDatabase({
      notes: new Map([[NOTE_ID, note]]),
      content: new Map([[stored.id, stored]]),
    });
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec,
    });

    // The test codec refuses tiptap because the pinned runtime has
    // no safe direct append primitive for that representation; the
    // adapter must surface this as `unsupported_content`.
    codec.appendMarkdownToStoredContent = ({ storedType }) => {
      if (storedType === "tiptap") {
        const e = new Error("tiptap unsupported") as Error & { code?: string };
        e.code = "UNSUPPORTED_TIPTAP";
        throw e;
      }
      return { type: storedType, data: `${storedType}-appended` };
    };

    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    const code = await codeOfAsync(() =>
      adapter.appendNote({
        id: NOTE_ID,
        markdownFragment: "x",
        expectedRevision,
      }),
    );
    expect(code).toBe("unsupported_content");
    expect(database.calls.contentUpdate).toHaveLength(0);
  });

  it("rejects conflicting notes as conflict and never reaches the mutator", async () => {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "Journal",
      contentId: "content-1",
      pinned: false,
      favorite: false,
      conflicted: true,
      locked: false,
      dateEdited: 1_700_000_000_000,
    };
    const stored: FakeContent = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "html",
      data: "<p>existing</p>",
    };
    const database = createFakeDatabase({
      notes: new Map([[NOTE_ID, note]]),
      content: new Map([[stored.id, stored]]),
    });
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec,
    });

    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    const code = await codeOfAsync(() =>
      adapter.appendNote({
        id: NOTE_ID,
        markdownFragment: "x",
        expectedRevision,
      }),
    );
    expect(code).toBe("conflict");
    expect(database.calls.contentUpdate).toHaveLength(0);
  });

  it("rejects a repeated revision race with zero mutator calls on the second attempt", async () => {
    const { adapter, database, codec } = setupAppendable();
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    // First attempt succeeds and bumps the note's dateEdited.
    await adapter.appendNote({
      id: NOTE_ID,
      markdownFragment: "first fragment",
      expectedRevision,
    });

    // Reset call records (the first attempt's calls remain but a clean
    // assertion is easier against the post-first-attempt delta).
    const baselineUpdateCalls = database.calls.contentUpdate.length;
    const baselineCodecCalls = codec.appendCalls;

    // The second attempt reuses the OLD expectedRevision; the adapter
    // must re-read and find a different current revision.
    const code = await codeOfAsync(() =>
      adapter.appendNote({
        id: NOTE_ID,
        markdownFragment: "second fragment",
        expectedRevision,
      }),
    );
    expect(code).toBe("stale_revision");
    expect(database.calls.contentUpdate.length).toBe(baselineUpdateCalls);
    expect(codec.appendCalls).toBe(baselineCodecCalls);
  });

  it("never claims remote synchronization for any successful local append", async () => {
    const { adapter } = setupAppendable();
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    const result = await adapter.appendNote({
      id: NOTE_ID,
      markdownFragment: "tail",
      expectedRevision,
    });

    expect(result.localCommitted).toBe(true);
    expect(result.remoteSynced).toBe(false);
    expect(result.pendingSync).toBe(true);
  });

  // PR-71 regression: pinned `@notesnook/core@8.1.3` `Content.updateByNoteId`
  // does not bump the parent note's `dateEdited`.  Without an explicit
  // touch after the content update, two appends against the same revision
  // both succeed and the second can never surface `stale_revision`.
  // This test pins the contract that the append adapter invokes
  // `notesTouch` after every successful content update and that the
  // touch alone is what bumps `dateEdited` for the append path.
  it("bumps the note's dateEdited via notesTouch after every successful append", async () => {
    const { adapter, database } = setupAppendable();
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    await adapter.appendNote({
      id: NOTE_ID,
      markdownFragment: "PR-71 regression body",
      expectedRevision,
    });

    // contentUpdateByNoteId happened, then notesTouch([id], dateEdited)
    // bumped dateEdited to Date.now() at the moment of the append.
    expect(database.calls.contentUpdate.length).toBeGreaterThan(0);
    expect(database.calls.touch.length).toBe(1);
    const touch = database.calls.touch[0]!;
    expect(touch.ids).toEqual([NOTE_ID]);
    expect(typeof touch.dateEdited).toBe("number");
    expect(Number.isInteger(touch.dateEdited)).toBe(true);
    expect(touch.dateEdited).toBeGreaterThan(1_700_000_000_000);
  });
});

// ---------------------------------------------------------------------------
// updateNote
// ---------------------------------------------------------------------------

describe("Stage 4 write adapter — updateNote", () => {
  it("snapshots stateful update patch values before database mutation", async () => {
    const { adapter, database } = (() => {
      const note: FakeNote = {
        id: NOTE_ID,
        title: "Original",
        contentId: "content-1",
        pinned: false,
        favorite: false,
        conflicted: false,
        locked: false,
        dateEdited: 1_700_000_000_000,
      };
      const stored: FakeContent = {
        id: "content-1",
        noteId: NOTE_ID,
        type: "html",
        data: "<p>original</p>",
      };
      const database = createFakeDatabase({
        notes: new Map([[NOTE_ID, note]]),
        content: new Map([[stored.id, stored]]),
      });
      return {
        adapter: createNotesnookWriteAdapter({ source: database, codec: htmlCodec() }),
        database,
      };
    })();
    let titleReads = 0;
    const patch = {
      get title(): string {
        titleReads += 1;
        return titleReads === 1 ? "first title" : CANARY;
      },
    };
    const command = {
      id: NOTE_ID,
      patch,
      expectedRevision: revisionToken(NOTE_ID, 1_700_000_000_000),
    } as unknown as UpdateNoteCommand;

    await adapter.updateNote(command);

    expect(titleReads).toBe(1);
    expect(database.calls.update[0]?.partial.title).toBe("first title");
    expect(database.calls.update[0]?.partial.title).not.toBe(CANARY);
  });

  function setupUpdatable(seed?: Partial<FakeNote>): {
    adapter: NotesnookWriteAdapter;
    database: ReturnType<typeof createFakeDatabase>;
    codec: ReturnType<typeof htmlCodec>;
    note: FakeNote;
  } {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "Original",
      contentId: "content-1",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1_700_000_000_000,
      ...seed,
    };
    const stored: FakeContent = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "html",
      data: "<p>original body</p>",
    };
    const database = createFakeDatabase({
      notes: new Map([[NOTE_ID, note]]),
      content: new Map([[stored.id, stored]]),
    });
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec,
    });
    return { adapter, database, codec, note };
  }

  it("rejects an unknown replacement tag before changing note metadata", async () => {
    const { adapter, database } = setupUpdatable();
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { tags: [TAG_ID] },
        expectedRevision,
      }),
    );

    expect(code).toBe("invalid_input");
    expect(database.calls.update).toHaveLength(0);
    expect(database.calls.relationAdd).toHaveLength(0);
  });

  it("applies only the allowed patch fields and preserves fields outside the patch", async () => {
    const { adapter, database, codec } = setupUpdatable({
      favorite: true,
      pinned: true,
    });

    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    const result = await adapter.updateNote({
      id: NOTE_ID,
      patch: { title: "Renamed" },
      expectedRevision,
    });

    expect(result.operation).toBe("update");
    expect(result.localCommitted).toBe(true);
    expect(result.remoteSynced).toBe(false);
    expect(result.pendingSync).toBe(true);
    expect(result.appliedFields).toEqual(["title"]);

    // Exactly one notes.update call, only the allowlisted `title` field.
    expect(database.calls.update).toHaveLength(1);
    expect(Object.keys(database.calls.update[0]?.partial ?? {})).toEqual(["title"]);
    expect(database.calls.update[0]?.partial.title).toBe("Renamed");

    // favorite / pinned / content must NOT have been touched.
    expect(database.calls.update[0]?.partial).not.toHaveProperty("favorite");
    expect(database.calls.update[0]?.partial).not.toHaveProperty("pinned");
    expect(database.calls.contentUpdate).toHaveLength(0);
    expect(codec.appendCalls).toBe(0);
  });

  it("refreshes the note content when the patch replaces content", async () => {
    const { adapter, database, codec } = setupUpdatable();
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    const result = await adapter.updateNote({
      id: NOTE_ID,
      patch: { content: "rewritten body" },
      expectedRevision,
    });

    expect(result.appliedFields).toEqual(["content"]);
    // Exactly one content update, exactly one codec encode call.
    expect(database.calls.contentUpdate).toHaveLength(1);
    expect(codec.encodeCalls).toEqual(["rewritten body"]);
    // Stored content must NOT contain the raw Markdown.
    const stored = database.calls.contentUpdate[0]?.partial.data as string;
    expect(stored).not.toContain("rewritten body\n");
    expect(stored).toContain("rewritten body");
  });

  it("writes exact stored native content without invoking the Markdown codec", async () => {
    const { adapter, database, codec } = setupUpdatable();
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    const native =
      '<div data-type="document"><p>native body</p><!-- unsupported: customBlock --></div>';

    const result = await adapter.updateNote({
      id: NOTE_ID,
      patch: { storedContent: { type: "tiptap", data: native } },
      expectedRevision,
    });

    expect(result.appliedFields).toEqual(["content"]);
    // The Markdown codec must never run for a native-content write.
    expect(codec.encodeCalls).toEqual([]);
    expect(database.calls.contentUpdate).toHaveLength(1);
    // The exact bytes are written, re-pinned to the note's existing slot type.
    expect(database.calls.contentUpdate[0]?.partial.data).toBe(native);
    expect(database.calls.contentUpdate[0]?.ids).toEqual([NOTE_ID]);
  });

  it("advances the revision timestamp after a content-only update", async () => {
    const { adapter, database, note } = setupUpdatable();
    const previousDateEdited = note.dateEdited;
    const expectedRevision = revisionToken(NOTE_ID, previousDateEdited);

    await adapter.updateNote({
      id: NOTE_ID,
      patch: { content: "revision-bearing body" },
      expectedRevision,
    });

    expect(database.calls.contentUpdate).toHaveLength(1);
    expect(database.calls.touch).toHaveLength(1);
    expect(database.calls.touch[0]?.ids).toEqual([NOTE_ID]);
    expect(database.calls.touch[0]?.dateEdited).toBeGreaterThan(previousDateEdited);
    expect(note.dateEdited).toBe(database.calls.touch[0]?.dateEdited);
  });

  it("advances the revision timestamp when the wall clock equals the observed revision", async () => {
    const { adapter, database, note } = setupUpdatable();
    const previousDateEdited = note.dateEdited;
    const expectedRevision = revisionToken(NOTE_ID, previousDateEdited);
    const clock = vi.spyOn(Date, "now").mockReturnValue(previousDateEdited);

    try {
      await adapter.updateNote({
        id: NOTE_ID,
        patch: { content: "equal-clock body" },
        expectedRevision,
      });

      expect(database.calls.contentUpdate).toHaveLength(1);
      expect(database.calls.touch).toHaveLength(1);
      expect(database.calls.touch[0]?.dateEdited).toBe(previousDateEdited + 1);
      expect(note.dateEdited).toBe(previousDateEdited + 1);

      const staleCode = await codeOfAsync(() =>
        adapter.updateNote({
          id: NOTE_ID,
          patch: { content: "must not apply" },
          expectedRevision,
        }),
      );
      expect(staleCode).toBe("stale_revision");
      expect(database.calls.contentUpdate).toHaveLength(1);
      expect(database.calls.touch).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("advances the revision timestamp when the wall clock is behind the observed revision", async () => {
    const { adapter, database, note } = setupUpdatable();
    const previousDateEdited = note.dateEdited;
    const clock = vi.spyOn(Date, "now").mockReturnValue(previousDateEdited - 1);

    try {
      await adapter.updateNote({
        id: NOTE_ID,
        patch: { content: "backward-clock body" },
        expectedRevision: revisionToken(NOTE_ID, previousDateEdited),
      });

      expect(database.calls.touch).toHaveLength(1);
      expect(database.calls.touch[0]?.dateEdited).toBe(previousDateEdited + 1);
      expect(note.dateEdited).toBe(previousDateEdited + 1);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not touch the revision when the content update fails", async () => {
    const { adapter, database } = setupUpdatable();
    database.contentUpdateByNoteId = async () => {
      throw new Error(`upstream content failure ${NOTE_ID}`);
    };

    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { content: "failed body" },
        expectedRevision: revisionToken(NOTE_ID, 1_700_000_000_000),
      }),
    );

    expect(code).toBe("sync_failed");
    expect(database.calls.touch).toHaveLength(0);
  });

  it("returns a redacted chain-free sync_failed when revision touch fails", async () => {
    const { adapter, database } = setupUpdatable();
    const upstreamMessage = `upstream touch failure ${NOTE_ID} ${CANARY}`;
    database.notesTouch = async (ids, dateEdited) => {
      database.calls.touch.push({ ids: [...ids], dateEdited });
      throw new Error(upstreamMessage);
    };

    let result: unknown;
    let error: unknown;
    try {
      result = await adapter.updateNote({
        id: NOTE_ID,
        patch: { content: "touch-failure body" },
        expectedRevision: revisionToken(NOTE_ID, 1_700_000_000_000),
      });
    } catch (caught) {
      error = caught;
    }

    expect(result).toBeUndefined();
    expect(error).toBeDefined();
    expect(isNotesnookWriteAdapterError(error)).toBe(true);
    expect((error as { code: NotesnookWriteErrorCode }).code).toBe("sync_failed");
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect((error as { __context__?: unknown }).__context__).toBeUndefined();
    expect(String((error as Error).message)).not.toContain(upstreamMessage);
    // The forward content update and the compensation re-apply both
    // ran; the second call restores the original stored data so the
    // bounded saga leaves no phantom partial state.
    expect(database.calls.contentUpdate.length).toBe(2);
    expect(database.calls.touch).toHaveLength(1);
  });

  it("rejects a stale revision with zero mutator calls", async () => {
    const { adapter, database, codec } = setupUpdatable();

    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    // Simulate a remote-side edit advancing dateEdited.
    const originalNoteImpl = database.note;
    database.note = (async (id: string) => {
      const base = await originalNoteImpl(id);
      if (!base) return base;
      return { ...base, dateEdited: 1_700_000_999_000 };
    }) as typeof database.note;

    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { title: "X" },
        expectedRevision,
      }),
    );
    expect(code).toBe("stale_revision");
    expect(database.calls.update).toHaveLength(0);
    expect(database.calls.contentUpdate).toHaveLength(0);
    expect(codec.encodeCalls).toHaveLength(0);
  });

  it("rejects a locked note as vault_locked without any mutator call", async () => {
    const { adapter, database, codec } = setupUpdatable({ locked: true });
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { title: "X" },
        expectedRevision,
      }),
    );
    expect(code).toBe("vault_locked");
    expect(database.calls.update).toHaveLength(0);
    expect(database.calls.contentUpdate).toHaveLength(0);
    expect(codec.encodeCalls).toHaveLength(0);
  });

  it("rejects an unsupported content update as unsupported_content", async () => {
    const { adapter, database } = setupUpdatable();
    database.contentFindByNoteId = (async () => undefined) as typeof database.contentFindByNoteId;

    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { content: "new body" },
        expectedRevision,
      }),
    );
    expect(code).toBe("unsupported_content");
  });

  it("preserves a conflicted note as conflict failure without mutating", async () => {
    const { adapter, database } = setupUpdatable({ conflicted: true });
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { title: "Will Not Apply" },
        expectedRevision,
      }),
    );
    expect(code).toBe("conflict");
    expect(database.calls.update).toHaveLength(0);
  });

  it("attaches a notebook only when the allowlisted notebook exists", async () => {
    const notebooks = new Map<string, FakeNotebook>([
      [NOTEBOOK_ID, { id: NOTEBOOK_ID, title: "Inbox", notes: [] }],
    ]);
    const { adapter, database } = setupUpdatable();
    (database as unknown as { notebooks: Map<string, FakeNotebook> }).notebooks = notebooks;
    // Replace the fake's notebookExists/Add with one that consults the
    // patched map.
    database.notebookExists = (async (id: string) =>
      notebooks.has(id)) as typeof database.notebookExists;
    database.notebookAddNote = (async (nid: string, noteId: string) => {
      const notebook = notebooks.get(nid);
      if (!notebook) throw new Error(`fake: notebook ${nid} missing`);
      if (!notebook.notes.includes(noteId)) notebook.notes.push(noteId);
      database.calls.notebookAdd.push({ notebookId: nid, noteId });
    }) as typeof database.notebookAddNote;

    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    const result = await adapter.updateNote({
      id: NOTE_ID,
      patch: { notebookId: NOTEBOOK_ID },
      expectedRevision,
    });

    expect(result.appliedFields).toEqual(["notebookId"]);
    expect(database.calls.notebookAdd).toEqual([{ notebookId: NOTEBOOK_ID, noteId: NOTE_ID }]);
  });

  it("rejects an update when notebookId references a missing notebook", async () => {
    const { adapter, database } = setupUpdatable();
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { notebookId: NOTEBOOK_ID },
        expectedRevision,
      }),
    );
    expect(code).toBe("invalid_input");
    expect(database.calls.notebookAdd).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateNote — bounded compensation slice
//
// These tests prove that an update mutator which fails *after* one or more
// forward mutators have already applied leaves no phantom partial state.
// The saga must either fully reverse the forward mutators or, when a
// reverse op itself fails, record a bounded recovery marker so the
// operator/runtime can reconcile.
//
// Existing tests above prove the *happy* and *fail-fast* update paths; the
// tests below are deliberately scoped to the partial-progress slice that
// the prior PR intentionally deferred.
// ---------------------------------------------------------------------------

describe("Stage 4 write adapter — updateNote compensation", () => {
  function setupCompensationFixture(seed?: {
    readonly initialTags?: readonly string[];
    readonly initialNotebookId?: string;
    readonly availableTags?: ReadonlyMap<string, FakeTag>;
    readonly availableNotebooks?: ReadonlyMap<string, FakeNotebook>;
    readonly existingRelations?: readonly FakeRelation[];
    readonly relationAddOverride?: (count: number, input: FakeRelation) => Promise<void>;
  }): {
    adapter: NotesnookWriteAdapter;
    database: ReturnType<typeof createFakeDatabase>;
    note: FakeNote;
  } {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "Original",
      contentId: "content-1",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1_700_000_000_000,
      ...(seed?.initialTags !== undefined ? { tags: [...seed.initialTags] } : {}),
      ...(seed?.initialNotebookId !== undefined ? { notebookId: seed.initialNotebookId } : {}),
    };
    const stored: FakeContent = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "html",
      data: "<p>original body</p>",
    };
    const tags =
      seed?.availableTags ??
      new Map<string, FakeTag>([
        [TAG_ID, { id: TAG_ID, title: "home" }],
        [SECOND_TAG_ID, { id: SECOND_TAG_ID, title: "urgent" }],
      ]);
    const notebooks =
      seed?.availableNotebooks ??
      new Map<string, FakeNotebook>([
        [NOTEBOOK_ID, { id: NOTEBOOK_ID, title: "Inbox", notes: [] }],
      ]);
    const relations: FakeRelation[] = seed?.existingRelations
      ? [...seed.existingRelations]
      : seed?.initialTags
        ? seed.initialTags.map((tagId) => ({ fromId: NOTE_ID, toId: tagId, type: "tag" }))
        : [];
    const database = createFakeDatabase({
      notes: new Map([[NOTE_ID, note]]),
      content: new Map([[stored.id, stored]]),
      tags: tags as Map<string, FakeTag>,
      notebooks: notebooks as Map<string, FakeNotebook>,
      relations,
      ...(seed?.relationAddOverride !== undefined
        ? { relationAddOverride: seed.relationAddOverride }
        : {}),
    });
    const adapter = createNotesnookWriteAdapter({ source: database, codec: htmlCodec() });
    return { adapter, database, note };
  }

  it("compensates a metadata-only update when a follow-up mutator rejects", async () => {
    // Patch renames the title AND attaches the note to a notebook.  The
    // first metadata mutator (`notesUpdate`) must be rolled back when
    // `notebookAddNote` rejects.
    const { adapter, database, note } = setupCompensationFixture();
    database.notebookAddNote = async () => {
      throw new Error("upstream: notebook attach refused");
    };
    const expectedRevision = revisionToken(NOTE_ID, note.dateEdited);

    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { title: "Renamed", notebookId: NOTEBOOK_ID },
        expectedRevision,
      }),
    );

    expect(code).toBe("sync_failed");
    // The forward `notesUpdate` call ran.
    expect(database.calls.update.length).toBeGreaterThanOrEqual(1);
    // Compensation must have re-applied the prior title via `notesUpdate`.
    expect(database.calls.update.length).toBe(2);
    expect(database.calls.update[1]?.partial.title).toBe("Original");
    expect(database.calls.notebookRemove).toEqual([]);
    // The note's observable title is back to the pre-mutation value.
    expect(note.title).toBe("Original");
    expect(note.notebookId).toBeUndefined();
  });

  it("compensates metadata when tag relation inspection rejects", async () => {
    const { adapter, database, note } = setupCompensationFixture();
    database.relationListForNote = async () => {
      throw new Error("upstream: relation inspection refused");
    };
    const expectedRevision = revisionToken(NOTE_ID, note.dateEdited);

    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { title: "Renamed", notebookId: NOTEBOOK_ID, tags: [TAG_ID] },
        expectedRevision,
      }),
    );

    expect(code).toBe("sync_failed");
    expect(database.calls.notebookRemove).toEqual([{ notebookId: NOTEBOOK_ID, noteId: NOTE_ID }]);
    expect(database.calls.update).toHaveLength(2);
    expect(note.title).toBe("Original");
    expect(note.notebookId).toBeUndefined();
    await expect(database.notebookNotes(NOTEBOOK_ID)).resolves.toEqual([]);
  });

  it("compensates a successful notebook attach when a later tag add rejects", async () => {
    const tags = new Map<string, FakeTag>([
      [TAG_ID, { id: TAG_ID, title: "home" }],
      [SECOND_TAG_ID, { id: SECOND_TAG_ID, title: "urgent" }],
    ]);
    const { adapter, database, note } = setupCompensationFixture({
      availableTags: tags,
      relationAddOverride: async (count) => {
        if (count === 2) throw new Error("upstream: later tag relation add refused");
      },
    });
    const expectedRevision = revisionToken(NOTE_ID, note.dateEdited);

    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { notebookId: NOTEBOOK_ID, tags: [TAG_ID, SECOND_TAG_ID] },
        expectedRevision,
      }),
    );

    expect(code).toBe("sync_failed");
    expect(database.calls.notebookRemove).toEqual([{ notebookId: NOTEBOOK_ID, noteId: NOTE_ID }]);
    expect(database.calls.relationRemove).toEqual([{ fromId: NOTE_ID, toId: TAG_ID, type: "tag" }]);
    expect(note.notebookId).toBeUndefined();
    await expect(database.notebookNotes(NOTEBOOK_ID)).resolves.toEqual([]);
  });

  it("rolls back earlier tag adds when a later tag add rejects during an update", async () => {
    // First tag add succeeds; the second must reject.  The first must be
    // compensated via `relationRemove`.
    const tags = new Map<string, FakeTag>([
      [TAG_ID, { id: TAG_ID, title: "home" }],
      [SECOND_TAG_ID, { id: SECOND_TAG_ID, title: "urgent" }],
    ]);
    const { adapter, database, note } = setupCompensationFixture({ availableTags: tags });
    // Override relationAdd so that the second call rejects.
    let addCalls = 0;
    database.relationAdd = async ({ fromId, toId, type }) => {
      addCalls += 1;
      database.calls.relationAdd.push({ fromId, toId, type });
      if (addCalls === 2) throw new Error("upstream: tag relation add refused");
    };
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { tags: [TAG_ID, SECOND_TAG_ID] },
        expectedRevision,
      }),
    );

    expect(code).toBe("sync_failed");
    // The forward call to `relationAdd` for the first tag must have run.
    expect(addCalls).toBeGreaterThanOrEqual(1);
    // Compensation must have invoked `relationRemove` to undo it.
    expect(database.calls.relationRemove).toEqual([{ fromId: NOTE_ID, toId: TAG_ID, type: "tag" }]);
    // The metadata tags field must be restored along with the relations.
    expect(note.tags).toEqual([]);
  });

  it("rolls back an earlier tag remove when a later tag add rejects during an update", async () => {
    // Existing tag relation must be removed before a new one is added.
    // The remove succeeds; the add rejects; the remove must be
    // compensated by re-adding the original relation.
    const existing: FakeRelation[] = [{ fromId: NOTE_ID, toId: TAG_ID, type: "tag" }];
    const tags = new Map<string, FakeTag>([
      [TAG_ID, { id: TAG_ID, title: "home" }],
      [SECOND_TAG_ID, { id: SECOND_TAG_ID, title: "urgent" }],
    ]);
    const { adapter, database } = setupCompensationFixture({
      initialTags: [TAG_ID],
      availableTags: tags,
      existingRelations: existing,
      // Fail only the FIRST relationAdd (the forward add for
      // SECOND_TAG_ID).  Any later call (the compensation re-adding
      // TAG_ID) must succeed so the saga can complete cleanly and we
      // can assert that the original relation was restored.
      relationAddOverride: async (count) => {
        if (count === 1) throw new Error("upstream: tag relation add refused");
      },
    });
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { tags: [SECOND_TAG_ID] },
        expectedRevision,
      }),
    );

    expect(code).toBe("sync_failed");
    // The forward `relationRemove` ran (the existing tag was removed).
    expect(database.calls.relationRemove).toEqual([{ fromId: NOTE_ID, toId: TAG_ID, type: "tag" }]);
    // The forward `relationAdd` was attempted (and failed); the
    // compensation then succeeded and re-added the original relation.
    expect(database.calls.relationAdd).toEqual([
      { fromId: NOTE_ID, toId: SECOND_TAG_ID, type: "tag" },
      { fromId: NOTE_ID, toId: TAG_ID, type: "tag" },
    ]);
  });

  it("rolls back a stored content write when the follow-up notesTouch rejects", async () => {
    const { adapter, database } = setupCompensationFixture();
    const originalData = "<p>original body</p>";
    database.notesTouch = async () => {
      throw new Error("upstream: touch refused");
    };
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { content: "new body" },
        expectedRevision,
      }),
    );

    expect(code).toBe("sync_failed");
    // The forward content write ran once.
    expect(database.calls.contentUpdate.length).toBe(2);
    // Compensation must have re-applied the original stored content.
    const compensation = database.calls.contentUpdate[1];
    expect(compensation?.partial.data).toBe(originalData);
    expect(database.calls.update).toHaveLength(0);
  });

  it("records an update-metadata recovery marker when the metadata compensation itself fails", async () => {
    // First notesUpdate (forward) must succeed, then notebookAddNote
    // rejects, then the compensation notesUpdate re-apply must also
    // fail so the saga records an `update-metadata` marker.
    const { database, note } = setupCompensationFixture();
    const originalUpdate = database.notesUpdate;
    let updateCalls = 0;
    database.notesUpdate = async (ids, partial) => {
      updateCalls += 1;
      // The forward update call must succeed (and bump the note).
      if (updateCalls === 1) {
        await originalUpdate(ids, partial);
        return;
      }
      // Any later call (the compensation re-apply) must fail.
      throw new Error("upstream: notesUpdate refused");
    };
    database.notebookAddNote = async () => {
      throw new Error("upstream: notebook attach refused");
    };
    const markers: unknown[] = [];
    const adapterWithJournal = createNotesnookWriteAdapter({
      source: database,
      codec: htmlCodec(),
      recoveryJournal: {
        record: (marker: unknown) => markers.push(marker),
        snapshot: () => [],
      },
    });
    const expectedRevision = revisionToken(NOTE_ID, note.dateEdited);

    const code = await codeOfAsync(() =>
      adapterWithJournal.updateNote({
        id: NOTE_ID,
        patch: { title: "Renamed", notebookId: NOTEBOOK_ID },
        expectedRevision,
      }),
    );

    expect(code).toBe("sync_failed");
    expect(markers).toEqual([
      {
        operation: "update",
        noteId: NOTE_ID,
        stage: "update-metadata",
      },
    ]);
  });

  it("records an update-tags recovery marker when relationRemove compensation fails", async () => {
    const tags = new Map<string, FakeTag>([
      [TAG_ID, { id: TAG_ID, title: "home" }],
      [SECOND_TAG_ID, { id: SECOND_TAG_ID, title: "urgent" }],
    ]);
    const { database } = setupCompensationFixture({ availableTags: tags });
    let addCalls = 0;
    database.relationAdd = async ({ fromId, toId, type }) => {
      addCalls += 1;
      database.calls.relationAdd.push({ fromId, toId, type });
      if (addCalls === 2) throw new Error("upstream: tag relation add refused");
    };
    // Force the inverse `relationRemove` to also throw so compensation
    // cannot complete cleanly.
    database.relationRemove = async () => {
      throw new Error("upstream: relation remove refused");
    };
    const markers: unknown[] = [];
    const adapterWithJournal = createNotesnookWriteAdapter({
      source: database,
      codec: htmlCodec(),
      recoveryJournal: {
        record: (marker: unknown) => markers.push(marker),
        snapshot: () => [],
      },
    });
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    const code = await codeOfAsync(() =>
      adapterWithJournal.updateNote({
        id: NOTE_ID,
        patch: { tags: [TAG_ID, SECOND_TAG_ID] },
        expectedRevision,
      }),
    );

    expect(code).toBe("sync_failed");
    expect(markers).toEqual([
      {
        operation: "update",
        noteId: NOTE_ID,
        stage: "update-tags",
      },
    ]);
  });

  it("records an update-content recovery marker when content compensation itself fails", async () => {
    const { database } = setupCompensationFixture();
    const originalContentUpdate = database.contentUpdateByNoteId;
    let contentUpdateCalls = 0;
    database.contentUpdateByNoteId = async (partial, ...ids) => {
      contentUpdateCalls += 1;
      // First call is the forward content write — let it succeed.
      if (contentUpdateCalls === 1) {
        return originalContentUpdate(partial, ...ids);
      }
      // Second call is the compensation — force it to reject.
      throw new Error("upstream: content update refused");
    };
    database.notesTouch = async () => {
      throw new Error("upstream: touch refused");
    };
    const markers: unknown[] = [];
    const adapterWithJournal = createNotesnookWriteAdapter({
      source: database,
      codec: htmlCodec(),
      recoveryJournal: {
        record: (marker: unknown) => markers.push(marker),
        snapshot: () => [],
      },
    });
    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);

    const code = await codeOfAsync(() =>
      adapterWithJournal.updateNote({
        id: NOTE_ID,
        patch: { content: "rewritten body" },
        expectedRevision,
      }),
    );

    expect(code).toBe("sync_failed");
    expect(markers).toEqual([
      {
        operation: "update",
        noteId: NOTE_ID,
        stage: "update-content",
      },
    ]);
  });

  it("does not record a recovery marker on a preflight rejection", async () => {
    // Stale revision must fail closed with zero mutator calls and zero
    // recovery markers.
    const { database } = setupCompensationFixture();
    const markers: unknown[] = [];
    const adapterWithJournal = createNotesnookWriteAdapter({
      source: database,
      codec: htmlCodec(),
      recoveryJournal: {
        record: (marker: unknown) => markers.push(marker),
        snapshot: () => [],
      },
    });

    const code = await codeOfAsync(() =>
      adapterWithJournal.updateNote({
        id: NOTE_ID,
        patch: { title: "X" },
        expectedRevision: revisionToken(NOTE_ID, 9_999_999_999),
      }),
    );

    expect(code).toBe("stale_revision");
    expect(database.calls.update).toHaveLength(0);
    expect(markers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deleteNote
// ---------------------------------------------------------------------------

describe("Stage 4 write adapter — deleteNote", () => {
  it("rejects a locked note before invoking the delete mutator", async () => {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "Bernie Test Locked",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: true,
      dateEdited: 1_700_000_000_000,
    };
    const database = createFakeDatabase({ notes: new Map([[NOTE_ID, note]]) });
    let deleteCalls = 0;
    (
      database as unknown as {
        notesDelete?: (id: string) => Promise<void>;
      }
    ).notesDelete = async () => {
      deleteCalls += 1;
    };
    const adapter = createNotesnookWriteAdapter({ source: database, codec: htmlCodec() });

    const code = await codeOfAsync(() =>
      adapter.deleteNote({
        id: NOTE_ID,
        expectedRevision: revisionToken(NOTE_ID, 1_700_000_000_000),
      }),
    );

    expect(code).toBe("vault_locked");
    expect(deleteCalls).toBe(0);
  });

  it("maps an upstream ERR_VAULT_LOCKED delete refusal to vault_locked", async () => {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "Bernie Test Locked",
      pinned: false,
      favorite: false,
      conflicted: false,
      // The live metadata projection can omit this marker; the mutator is
      // still authoritative and refuses the delete at the vault boundary.
      locked: false,
      dateEdited: 1_700_000_000_000,
    };
    const database = createFakeDatabase({ notes: new Map([[NOTE_ID, note]]) });
    (
      database as unknown as {
        notesDelete?: (id: string) => Promise<void>;
      }
    ).notesDelete = async () => {
      throw new Error("ERR_VAULT_LOCKED");
    };
    const adapter = createNotesnookWriteAdapter({ source: database, codec: htmlCodec() });

    const code = await codeOfAsync(() =>
      adapter.deleteNote({
        id: NOTE_ID,
        expectedRevision: revisionToken(NOTE_ID, 1_700_000_000_000),
      }),
    );

    expect(code).toBe("vault_locked");
  });

  it("does not trust an unverified lowercase vault_locked code", async () => {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "Bernie Test Locked",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1_700_000_000_000,
    };
    const database = createFakeDatabase({ notes: new Map([[NOTE_ID, note]]) });
    (
      database as unknown as {
        notesDelete?: (id: string) => Promise<void>;
      }
    ).notesDelete = async () => {
      const error = new Error("unverified locked detail");
      Object.defineProperty(error, "code", { value: "vault_locked" });
      throw error;
    };
    const adapter = createNotesnookWriteAdapter({ source: database, codec: htmlCodec() });

    const code = await codeOfAsync(() =>
      adapter.deleteNote({
        id: NOTE_ID,
        expectedRevision: revisionToken(NOTE_ID, 1_700_000_000_000),
      }),
    );

    expect(code).toBe("sync_failed");
  });
});

// ---------------------------------------------------------------------------
// Structural seam and escape-hatch rejection.
// ---------------------------------------------------------------------------

describe("Stage 4 write adapter — structural seam hardening", () => {
  it("rejects sync / delete / force / Vault escape hatches on the injected seam", () => {
    const code = codeOf(() =>
      createNotesnookWriteAdapter({
        source: {
          // forbidden: every one of these is a known upstream mutation
          // surface that the adapter must NOT see through.
          sync: () => Promise.resolve(true),
          delete: () => Promise.resolve(),
          force: true,
          vaultUnlock: () => Promise.resolve(true),
          // required slot left out so the seam is invalid anyway
        } as unknown as NotesnookWriteDatabase,
        codec: htmlCodec(),
      }),
    );
    expect(code).toBe("invalid_input");
  });

  it("rejects a seam that exposes a raw Database handle as invalid_input", () => {
    const rawDatabase = {
      notes: { add: () => "x", delete: () => undefined },
      content: { updateByNoteId: () => undefined },
      collection: () => undefined,
    };
    const code = codeOf(() =>
      createNotesnookWriteAdapter({
        source: rawDatabase as unknown as NotesnookWriteDatabase,
        codec: htmlCodec(),
      }),
    );
    expect(code).toBe("invalid_input");
  });

  it("rejects a seam missing the required slots", () => {
    const code = codeOf(() =>
      createNotesnookWriteAdapter({
        source: {
          note: () => Promise.resolve(undefined),
          // missing contentFindByNoteId, notesAdd, notesUpdate, ...
        } as unknown as NotesnookWriteDatabase,
        codec: htmlCodec(),
      }),
    );
    expect(code).toBe("invalid_input");
  });

  it("rejects a missing or throwing markdown codec as invalid_input", () => {
    const database = createFakeDatabase();
    expect(
      codeOf(() =>
        createNotesnookWriteAdapter({
          source: database,
          // no codec
          codec: undefined as unknown as NotesnookWriteMarkdownCodec,
        }),
      ),
    ).toBe("invalid_input");
  });

  it("exposes only the three write methods and a constructor on its prototype", () => {
    const database = createFakeDatabase();
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });
    const protoNames = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).sort();
    expect(protoNames).toEqual(
      (["constructor", "createNote", "appendNote", "updateNote", "deleteNote"] as string[])
        .slice()
        .sort(),
    );
    expect((adapter as unknown as { database?: unknown }).database).toBeUndefined();
    expect((adapter as unknown as { delete?: unknown }).delete).toBeUndefined();
    expect((adapter as unknown as { force?: unknown }).force).toBeUndefined();
    expect((adapter as unknown as { sync?: unknown }).sync).toBeUndefined();
    expect(Object.isFrozen(adapter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hostile getters and Proxy safety.
// ---------------------------------------------------------------------------

describe("Stage 4 write adapter — hostile getters and proxies", () => {
  function hostileAccessor(reason: string): never {
    const err = new Error(`${reason} ${CANARY}`) as Error & { code?: string };
    err.code = "STAGE_4_HOSTILE_GETTER_CANARY";
    throw err;
  }

  it("normalises a throwing note() to sync_failed without leaking the canary", async () => {
    const database = createFakeDatabase();
    database.note = (async () => {
      hostileAccessor("note fetch leaked");
    }) as typeof database.note;
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });

    const expectedRevision = revisionToken(OTHER_ID, 1);
    const code = await codeOfAsync(() =>
      adapter.appendNote({
        id: OTHER_ID,
        markdownFragment: "x",
        expectedRevision,
      }),
    );
    expect(code).toBe("sync_failed");
  });

  it("normalises a throwing contentFindByNoteId to sync_failed without leaking the canary", async () => {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "J",
      contentId: "content-1",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1_700_000_000_000,
    };
    const database = createFakeDatabase({
      notes: new Map([[NOTE_ID, note]]),
    });
    database.contentFindByNoteId = (async () => {
      hostileAccessor("content lookup leaked");
    }) as typeof database.contentFindByNoteId;
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });

    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    const code = await codeOfAsync(() =>
      adapter.appendNote({
        id: NOTE_ID,
        markdownFragment: "x",
        expectedRevision,
      }),
    );
    expect(code).toBe("sync_failed");
  });

  it("normalises a throwing notesAdd to sync_failed without leaking the canary", async () => {
    const database = createFakeDatabase();
    database.notesAdd = (async () => {
      hostileAccessor("notes.add leaked");
    }) as typeof database.notesAdd;
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });

    const code = await codeOfAsync(() => adapter.createNote({ title: "t", content: "x" }));
    expect(code).toBe("sync_failed");
  });
});

// ---------------------------------------------------------------------------
// Categorical redaction.
// ---------------------------------------------------------------------------

describe("Stage 4 write adapter — categorical redaction", () => {
  it("never leaks note ids, bodies, canaries, upstream messages, causes, or context", async () => {
    const note: FakeNote = {
      id: NOTE_ID,
      title: `Title ${CANARY}`,
      contentId: "content-1",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1_700_000_000_000,
    };
    const stored: FakeContent = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "html",
      data: `<p>secret body ${CANARY}</p>`,
    };
    const database = createFakeDatabase({
      notes: new Map([[NOTE_ID, note]]),
      content: new Map([[stored.id, stored]]),
    });

    // Inject an upstream-flavored throw that carries a canary in its
    // message, a `cause`, and a `__context__` payload.  Every leak
    // vector must be normalised away.
    database.notesUpdate = (async () => {
      const e = new Error(`upstream leaked ${CANARY}`) as Error & {
        cause?: unknown;
        __context__?: unknown;
      };
      e.cause = new Error(`cause leaked ${CANARY}`);
      e.__context__ = { secret: CANARY };
      throw e;
    }) as typeof database.notesUpdate;

    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });

    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    let caught: unknown;
    try {
      await adapter.updateNote({
        id: NOTE_ID,
        patch: { title: "Whatever" },
        expectedRevision,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(isNotesnookWriteAdapterError(caught)).toBe(true);
    const error = caught as Error & {
      cause?: unknown;
      __context__?: unknown;
      stack?: string;
    };
    expect(error.message).not.toContain(CANARY);
    expect(error.message).not.toContain(NOTE_ID);
    expect(error.message).not.toContain("Title");
    expect(error.message).not.toContain("upstream");
    expect(error.stack ?? "").not.toContain(CANARY);
    expect(error.cause).toBeUndefined();
    expect(error.__context__).toBeUndefined();
    // The error code must come from the closed categorical set.
    expect((error as unknown as { code: string }).code).toBe("sync_failed");
  });
});

// ---------------------------------------------------------------------------
// Supported-construct fidelity gate (Astra finding P1-7).
//
// The deterministic codec silently downgrades unsupported Markdown
// constructs to paragraph text.  The adapter's gate refuses the
// request before any mutator fires so the construct shape the operator
// asked for is never lost.
// ---------------------------------------------------------------------------

describe("Stage 4 write adapter — fidelity gate (P1-7)", () => {
  it("refuses a create note whose content uses a Markdown table", async () => {
    const database = createFakeDatabase();
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });

    const code = await codeOfAsync(() =>
      adapter.createNote({
        title: "Tables not supported",
        content: "| a | b |\n| - | - |\n| 1 | 2 |",
      }),
    );
    expect(code).toBe("unsupported_content");
    expect(database.calls.add).toHaveLength(0);
  });

  it("accepts an append whose fragment contains a task list", async () => {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "Has task list",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1_700_000_000_000,
    };
    const stored: FakeContent = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "tiptap",
      data: '<div data-type="document"><p>old</p></div>',
    };
    const database = createFakeDatabase({
      notes: new Map([[NOTE_ID, note]]),
      content: new Map([[stored.id, stored]]),
    });
    // Use the interactive simple-checklist fake codec so the assertion exercises
    // the encoded task-list structure rather than the literal Markdown source.
    const codec = nativeChecklistCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });

    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    const result = await adapter.appendNote({
      id: NOTE_ID,
      markdownFragment: "- [ ] task",
      expectedRevision,
    });
    expect(result.operation).toBe("append");
    expect(result.localCommitted).toBe(true);
    // The codec is invoked once for the new fragment; the stored prefix
    // (the original paragraph) is preserved byte-for-byte, and the
    // appended fragment ends up as encoded interactive task-list markup —
    // not as the literal Markdown source.
    expect(database.calls.contentUpdate).toHaveLength(1);
    const nextData = database.calls.contentUpdate[0]?.partial.data as string;
    expect(nextData.startsWith('<div data-type="document"><p>old</p>')).toBe(true);
    expect(nextData).toContain('<ul class="simple-checklist">');
    expect(nextData).toContain('<li class="simple-checklist--item"><p>task</p></li>');
    expect(nextData).not.toContain("- [ ] task");
  });

  it("refuses an update whose replacement content contains inline HTML", async () => {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "Title",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1_700_000_000_000,
    };
    const stored: FakeContent = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "tiptap",
      data: "<p>old</p>",
    };
    const database = createFakeDatabase({
      notes: new Map([[NOTE_ID, note]]),
      content: new Map([[stored.id, stored]]),
    });
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });

    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    const code = await codeOfAsync(() =>
      adapter.updateNote({
        id: NOTE_ID,
        patch: { content: "<table><tr><td>cell</td></tr></table>" },
        expectedRevision,
      }),
    );
    expect(code).toBe("unsupported_content");
    expect(database.calls.update).toHaveLength(0);
    expect(database.calls.contentUpdate).toHaveLength(0);
  });

  it("accepts a create note whose content uses only supported constructs", async () => {
    const database = createFakeDatabase();
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });

    const result = await adapter.createNote({
      title: "Headings and lists",
      content:
        "# Heading\n\n- item one\n- item two\n\nA paragraph with **bold** and *italic* and `code`.",
    });
    expect(result.operation).toBe("create");
    expect(database.calls.add).toHaveLength(1);
  });

  it("accepts an update whose content uses only supported constructs", async () => {
    const note: FakeNote = {
      id: NOTE_ID,
      title: "Title",
      pinned: false,
      favorite: false,
      conflicted: false,
      locked: false,
      dateEdited: 1_700_000_000_000,
    };
    const stored: FakeContent = {
      id: "content-1",
      noteId: NOTE_ID,
      type: "tiptap",
      data: "<p>old</p>",
    };
    const database = createFakeDatabase({
      notes: new Map([[NOTE_ID, note]]),
      content: new Map([[stored.id, stored]]),
    });
    const codec = htmlCodec();
    const adapter = createNotesnookWriteAdapter({ source: database, codec });

    const expectedRevision = revisionToken(NOTE_ID, 1_700_000_000_000);
    const result = await adapter.updateNote({
      id: NOTE_ID,
      patch: { content: "# New heading\n\nA paragraph." },
      expectedRevision,
    });
    expect(result.operation).toBe("update");
    expect(database.calls.contentUpdate).toHaveLength(1);
  });
});
