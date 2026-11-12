/**
 * Stage 5 slice A — offline tests for the keep-both conflict resolver.
 *
 * The injected seam is an in-memory store that records every slot call in
 * order. Refusal paths assert that the content-write and flag-clear slots were
 * never called, and that the original rows are unchanged, so a result alone
 * cannot pass a test.
 */

import { describe, expect, it } from "vitest";

import { createNotesnookLocalConflictInspector } from "../src/core/notesnook-local-conflict-projection.js";
import {
  copyTitleFor,
  createNotesnookConflictResolver,
  NotesnookConflictResolveError,
  type NotesnookConflictResolveResult,
  type NotesnookConflictResolveSeam,
} from "../src/core/notesnook-conflict-resolve-wiring.js";
import { STAGE4_WRITE_LIMITS } from "../src/core/notesnook-write-contract.js";

const LOCAL_BODY = '<p data-block-id="l1">local edit</p>';
const REMOTE_BODY = '<p data-block-id="r1">remote edit</p>';
const REMOTE_WITH_ATTACHMENT =
  '<p data-block-id="r1">remote <img data-hash="att-1" data-mime="image/png"></p>';
const CIPHER = { cipher: "ciphertext", iv: "initialisation", salt: "salt", length: 10 };
const OVER_CAP = "x".repeat(STAGE4_WRITE_LIMITS.maxContentBytes + 1);
const REMOTE_DATE = 2_000;
const NOTEBOOK = "nb-work";
const TAGS = ["tag-a", "tag-b"];
const MEMBERSHIPS: ReadonlyArray<Readonly<{ type: "notebook" | "tag"; id: string }>> = [
  { type: "notebook", id: NOTEBOOK },
  ...TAGS.map((id) => ({ type: "tag" as const, id })),
];
const ZERO_BINDING = "0".repeat(64);
const SECRET = "PRIVATE-RESOLVE-SECRET-5d2a";
const SLOT_NAMES = [
  "noteMeta",
  "contentWithConflicted",
  "notesAddVerbatim",
  "contentResolve",
  "noteClearConflict",
  "noteRelate",
  "noteRelations",
] as const;
const COPY_SUFFIX = " (bridge copy)";
/** A title that is already at the write limit and ends in the suffix, so its copy title equals it. */
const COLLIDING_TITLE = `${"t".repeat(STAGE4_WRITE_LIMITS.maxTitleLength - COPY_SUFFIX.length)}${COPY_SUFFIX}`;

type SlotName = keyof NotesnookConflictResolveSeam;
type Row = Record<string, unknown>;
type Outcome = NotesnookConflictResolveResult["outcome"];

const WRITE_SLOTS: ReadonlyArray<SlotName> = [
  "notesAddVerbatim",
  "noteRelate",
  "contentResolve",
  "noteClearConflict",
];

/** The writes once the copy exists and all three memberships are related to it. */
const COPY_WRITES: ReadonlyArray<SlotName> = [
  "notesAddVerbatim",
  "noteRelate",
  "noteRelate",
  "noteRelate",
];

/** What the content row's `conflicted` marker reads as after the resolve writes it. */
type ResolvedMarker = "null" | "absent" | "false" | "true" | "text";

type StoreOptions = Readonly<{
  note?: Row;
  content?: Row;
  noteAbsent?: boolean;
  trashed?: boolean;
  throwOn?: ReadonlyArray<SlotName>;
  copyTransform?: (data: string) => string;
  afterCopy?: (contents: Map<string, Row>) => void;
  dateShift?: number;
  resolvedMarker?: ResolvedMarker;
  /** The id `notesAddVerbatim` reports for the copy. Defaults to `note-copy-1`. */
  copyReturnsId?: string;
  /** Seed an unrelated, valid note whose content holds the local side. */
  foreignNote?: boolean;
  /** Fields merged into the original's content row once the resolve writes it. */
  resolvedRow?: Row;
  /** A membership `noteRelate` reports as written but does not record. */
  dropMembership?: string;
  /** The id the copy's own note row carries, when it is not the copy id. */
  copyNoteIdOverride?: string;
  /** The id the copy's content row carries, when it is not its content id. */
  copyContentIdOverride?: string;
  /** The id the original's note row carries, when it is not the original id. */
  originalNoteIdOverride?: string;
  /** Runs after the conflicted flag is cleared, just before the final read-back. */
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

function applyResolvedMarker(row: Row, marker: ResolvedMarker): void {
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

/**
 * An in-memory seam that behaves like the pinned core for the slots it covers.
 * Trashed notes read as absent, as `notes.note(id)` does. Each slot call is
 * logged before it runs, so an injected failure still shows up in the log.
 */
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
    if (failing.has(slot)) throw new Error(SECRET);
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
        dateResolved: null,
        conflicted: null,
      });
      notes.set(copyId, {
        id: copyId,
        title: input.title,
        contentId: copyContentId,
        conflicted: false,
        memberships: [],
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

function slotsOf(store: Store): SlotName[] {
  return store.calls.map((call) => call.slot);
}

function writesOf(store: Store): SlotName[] {
  return slotsOf(store).filter((slot) => WRITE_SLOTS.includes(slot));
}

/** Plain snapshot of the whole fake state, copy included. */
function stateOf(store: Store): unknown {
  return copyRows({ notes: [...store.notes.entries()], contents: [...store.contents.entries()] });
}

/** Snapshot of only the original note and content rows. */
function originalOf(store: Store): unknown {
  return copyRows({
    note: store.notes.get("note-1"),
    content: store.contents.get("content-1"),
  });
}

/**
 * The binding the Stage 0 inspector reports for the current state. Returns a
 * placeholder when the state is not `inspected`, which the resolver refuses
 * before it reads the binding.
 */
async function bindingOf(store: Store): Promise<string> {
  const inspector = createNotesnookLocalConflictInspector({
    notes: { note: (id: string) => store.seam.noteMeta(id) },
    contentWithConflicted: { get: (id: string) => store.seam.contentWithConflicted(id) },
  });
  const result = await inspector.inspectConflict("note-1");
  return result.outcome === "inspected" ? result.binding : ZERO_BINDING;
}

async function resolveOriginal(store: Store, expectedBinding: string) {
  const resolver = createNotesnookConflictResolver(store.seam);
  return resolver.resolveKeepBoth("note-1", expectedBinding);
}

describe("Stage 5 conflict resolve seam", () => {
  it("describes exactly the seven injected slots", () => {
    const expected: Record<keyof NotesnookConflictResolveSeam, true> = {
      noteMeta: true,
      contentWithConflicted: true,
      notesAddVerbatim: true,
      contentResolve: true,
      noteClearConflict: true,
      noteRelate: true,
      noteRelations: true,
    };

    expect(Object.keys(expected).sort()).toEqual([...SLOT_NAMES].sort());
    expect(Object.keys(createStore().seam).sort()).toEqual([...SLOT_NAMES].sort());
  });

  it("exposes only capture and resolveKeepBoth on a frozen resolver", () => {
    const resolver = createNotesnookConflictResolver(createStore().seam);

    expect(Object.getOwnPropertyNames(resolver).sort()).toEqual(["capture", "resolveKeepBoth"]);
    expect(Object.isFrozen(resolver)).toBe(true);
  });

  it("captures a ready plan with no write, and refuses a stale binding the same way", async () => {
    const store = createStore();
    const binding = await bindingOf(store);
    store.calls.splice(0);
    const resolver = createNotesnookConflictResolver(store.seam);

    const plan = await resolver.capture("note-1", binding);

    expect(plan).toMatchObject({
      outcome: "ready",
      noteId: "note-1",
      contentId: "content-1",
      originalTitle: "Field notes",
      copyTitle: "Field notes (bridge copy)",
      remoteDate: REMOTE_DATE,
      remoteText: REMOTE_BODY,
    });
    await expect(resolver.capture("note-1", ZERO_BINDING)).resolves.toEqual({
      outcome: "stale_revision",
      copyCreated: false,
    });
    expect(writesOf(store)).toEqual([]);
  });

  it.each(["moveToTrash", "delete", "sync", "write", "database"])(
    "refuses a seam with an extra %s slot",
    (name) => {
      const store = createStore();
      const widened = { ...store.seam, [name]: async () => undefined };

      expect(() => createNotesnookConflictResolver(widened)).toThrow(NotesnookConflictResolveError);
    },
  );

  it.each(SLOT_NAMES)("refuses a seam missing the %s slot", (name) => {
    const store = createStore();
    const partial: Partial<NotesnookConflictResolveSeam> = { ...store.seam };
    delete partial[name];

    expect(() => createNotesnookConflictResolver(partial as NotesnookConflictResolveSeam)).toThrow(
      NotesnookConflictResolveError,
    );
  });

  it("rejects an invalid note id or binding before any upstream call", async () => {
    const store = createStore();
    const resolver = createNotesnookConflictResolver(store.seam);

    await expect(resolver.resolveKeepBoth("bad id", ZERO_BINDING)).rejects.toThrow(
      NotesnookConflictResolveError,
    );
    await expect(resolver.resolveKeepBoth("note-1", "not-a-binding")).rejects.toThrow(
      NotesnookConflictResolveError,
    );
    expect(store.calls).toEqual([]);
  });
});

describe("Stage 5 keep-both resolve", () => {
  it("keeps both sides: the copy holds the local side, the original adopts the remote side", async () => {
    const store = createStore();
    const binding = await bindingOf(store);
    store.calls.splice(0);

    const result = await resolveOriginal(store, binding);

    expect(result).toEqual({
      outcome: "resolved",
      originalTitle: "Field notes",
      copyTitle: "Field notes (bridge copy)",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(slotsOf(store)).toEqual([
      "noteMeta",
      "contentWithConflicted",
      "notesAddVerbatim",
      "noteMeta",
      "contentWithConflicted",
      "noteRelate",
      "noteRelate",
      "noteRelate",
      "noteRelations",
      "noteMeta",
      "contentWithConflicted",
      "contentResolve",
      "noteClearConflict",
      "noteMeta",
      "contentWithConflicted",
    ]);
    expect(store.calls.find((call) => call.slot === "notesAddVerbatim")?.arg).toEqual({
      title: "Field notes (bridge copy)",
      content: { type: "tiptap", data: LOCAL_BODY },
    });
    expect(
      store.calls.filter((call) => call.slot === "noteRelate").map((call) => call.arg),
    ).toEqual(MEMBERSHIPS.map((to) => ({ noteId: "note-copy-1", to })));
    expect(store.calls.find((call) => call.slot === "contentResolve")?.arg).toEqual({
      id: "content-1",
      noteId: "note-1",
      data: REMOTE_BODY,
      dateResolved: REMOTE_DATE,
    });
    expect(store.notes.get("note-copy-1")).toEqual({
      id: "note-copy-1",
      title: "Field notes (bridge copy)",
      contentId: "content-copy-1",
      conflicted: false,
      memberships: MEMBERSHIPS,
    });
    expect(store.contents.get("content-copy-1")).toMatchObject({
      data: LOCAL_BODY,
      conflicted: null,
    });
    expect(store.notes.get("note-1")).toMatchObject({ conflicted: false });
    expect(store.contents.get("content-1")).toMatchObject({
      data: REMOTE_BODY,
      conflicted: null,
      dateResolved: REMOTE_DATE,
    });
    expect(store.notes.size).toBe(2);
  });

  it("names the notes by title only, so the result carries no ids or bodies", async () => {
    const store = createStore();
    const binding = await bindingOf(store);
    const serialized = JSON.stringify(await resolveOriginal(store, binding));

    expect(serialized).not.toMatch(/note-1|note-copy-1|content-1|edit/);
  });

  it.each([
    ["an empty title", "", "Untitled (bridge copy)"],
    ["a whitespace-only title", "   ", "Untitled (bridge copy)"],
  ])("derives the copy title from %s", async (_name, title, copyTitle) => {
    const store = createStore({ note: { title } });
    const binding = await bindingOf(store);

    await expect(resolveOriginal(store, binding)).resolves.toMatchObject({ copyTitle });
  });

  it("bounds a long copy title to the write limit and keeps the suffix", async () => {
    const store = createStore({ note: { title: "t".repeat(300) } });
    const binding = await bindingOf(store);
    const result = await resolveOriginal(store, binding);

    expect(result).toMatchObject({ outcome: "resolved" });
    const copyTitle = (result as Extract<typeof result, { outcome: "resolved" }>).copyTitle;
    expect(copyTitle.length).toBeLessThanOrEqual(STAGE4_WRITE_LIMITS.maxTitleLength);
    expect(copyTitle.endsWith(" (bridge copy)")).toBe(true);
    expect(copyTitle).not.toBe("t".repeat(300));
  });
});

describe("Stage 5 keep-both refusals leave the original untouched", () => {
  const refusals: Array<[string, StoreOptions, Outcome]> = [
    ["a note that is no longer conflicted", { note: { conflicted: false } }, "not-conflicted"],
    ["a malformed membership list", { note: { memberships: "bad" } }, "read_failed"],
    [
      "a membership of an unsupported type",
      { note: { memberships: [{ type: "folder", id: "f-1" }] } },
      "read_failed",
    ],
    ["a missing note", { noteAbsent: true }, "not-found"],
    ["a trashed note", { trashed: true }, "not-found"],
    ["a locked local side", { content: { locked: true, data: CIPHER } }, "vault_locked"],
    [
      "a locked remote side",
      { content: { conflicted: remoteSide({ locked: true, data: CIPHER }) } },
      "vault_locked",
    ],
    ["a non-tiptap local side", { content: { type: "html" } }, "unsupported_content"],
    [
      "a non-tiptap remote side",
      { content: { conflicted: remoteSide({ type: "html" }) } },
      "unsupported_content",
    ],
    ["an absent remote side", { content: { conflicted: null } }, "unsupported_content"],
    ["a local side without data", { content: { data: undefined } }, "unsupported_content"],
    ["a local side over the size cap", { content: { data: OVER_CAP } }, "unsupported_content"],
    [
      "a remote side over the size cap",
      { content: { conflicted: remoteSide({ data: OVER_CAP }) } },
      "unsupported_content",
    ],
    [
      "remote attachments",
      { content: { conflicted: remoteSide({ data: REMOTE_WITH_ATTACHMENT }) } },
      "unsupported_content",
    ],
    ["local attachments", { content: { data: REMOTE_WITH_ATTACHMENT } }, "unsupported_content"],
  ];

  it.each(refusals)("refuses %s with no write to the original", async (_name, options, outcome) => {
    const store = createStore(options);
    const before = stateOf(store);
    const binding = await bindingOf(store);

    await expect(resolveOriginal(store, binding)).resolves.toEqual({ outcome });
    expect(writesOf(store)).toEqual([]);
    expect(stateOf(store)).toEqual(before);
  });

  it("refuses a stale binding before any write", async () => {
    const store = createStore();
    const before = stateOf(store);

    await expect(resolveOriginal(store, ZERO_BINDING)).resolves.toEqual({
      outcome: "stale_revision",
      copyCreated: false,
    });
    expect(writesOf(store)).toEqual([]);
    expect(stateOf(store)).toEqual(before);
  });

  it("reports a read failure before any write", async () => {
    const store = createStore();
    const binding = await bindingOf(store);
    store.failing.add("noteMeta");

    const result = await resolveOriginal(store, binding);

    expect(result).toEqual({ outcome: "read_failed" });
    expect(writesOf(store)).toEqual([]);
  });
});

describe("Stage 5 keep-both failure modes", () => {
  it("stops with copy_failed when the copy cannot be created, and never reaches the original", async () => {
    const store = createStore({ throwOn: ["notesAddVerbatim"] });
    const binding = await bindingOf(store);
    const before = originalOf(store);

    const result = await resolveOriginal(store, binding);

    expect(result).toEqual({ outcome: "copy_failed" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(writesOf(store)).toEqual(["notesAddVerbatim"]);
    expect(originalOf(store)).toEqual(before);
  });

  it("stops before touching the original when the copy read-back is not byte-exact", async () => {
    const store = createStore({ copyTransform: (data) => `${data}<!-- drift -->` });
    const binding = await bindingOf(store);
    const before = originalOf(store);

    await expect(resolveOriginal(store, binding)).resolves.toEqual({
      outcome: "copy_unverified",
    });
    expect(writesOf(store)).toEqual(["notesAddVerbatim"]);
    expect(originalOf(store)).toEqual(before);
  });

  it("refuses with stale_revision when the binding moves between the copy and the re-check", async () => {
    const store = createStore({
      afterCopy: (contents) => {
        const row = contents.get("content-1");
        if (row === undefined) throw new Error("fixture");
        contents.set("content-1", {
          ...row,
          conflicted: remoteSide({ data: '<p data-block-id="r2">moved on</p>' }),
        });
      },
    });
    const binding = await bindingOf(store);

    await expect(resolveOriginal(store, binding)).resolves.toEqual({
      outcome: "stale_revision",
      copyCreated: true,
    });
    expect(writesOf(store)).toEqual([...COPY_WRITES]);
    expect(store.notes.get("note-1")).toMatchObject({ conflicted: true });
    expect(store.contents.get("content-1")).toMatchObject({
      data: LOCAL_BODY,
      conflicted: { data: '<p data-block-id="r2">moved on</p>' },
    });
  });

  it("reports relation_failed before the content write when a membership relation fails", async () => {
    const store = createStore({ throwOn: ["noteRelate"] });
    const binding = await bindingOf(store);
    const before = originalOf(store);

    const result = await resolveOriginal(store, binding);

    expect(result).toEqual({ outcome: "relation_failed" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(writesOf(store)).toEqual(["notesAddVerbatim", "noteRelate"]);
    expect(slotsOf(store)).not.toContain("contentResolve");
    expect(slotsOf(store)).not.toContain("noteClearConflict");
    expect(originalOf(store)).toEqual(before);
  });

  it.each<[string, StoreOptions]>([
    ["a membership relation that reports success but never lands", { dropMembership: "tag-b" }],
    ["a membership read-back that fails", { throwOn: ["noteRelations"] }],
  ])("reports relation_failed before the content write when %s", async (_label, options) => {
    const store = createStore(options);
    const binding = await bindingOf(store);
    const before = originalOf(store);

    const result = await resolveOriginal(store, binding);

    expect(result).toEqual({ outcome: "relation_failed" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(writesOf(store)).toEqual([...COPY_WRITES]);
    expect(slotsOf(store)).not.toContain("contentResolve");
    expect(slotsOf(store)).not.toContain("noteClearConflict");
    expect(originalOf(store)).toEqual(before);
  });

  it("reports content_write_failed and leaves the note flag set when the content write fails", async () => {
    const store = createStore({ throwOn: ["contentResolve"] });
    const binding = await bindingOf(store);
    const before = originalOf(store);

    const result = await resolveOriginal(store, binding);

    expect(result).toEqual({ outcome: "content_write_failed" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(writesOf(store)).toEqual([...COPY_WRITES, "contentResolve"]);
    expect(originalOf(store)).toEqual(before);
  });

  it("names the half-done state when the content is resolved but the flag clear fails", async () => {
    const store = createStore({ throwOn: ["noteClearConflict"] });
    const binding = await bindingOf(store);

    const result = await resolveOriginal(store, binding);

    expect(result).toEqual({ outcome: "resolved_flag_pending" });
    expect(writesOf(store)).toEqual([...COPY_WRITES, "contentResolve", "noteClearConflict"]);
    expect(store.contents.get("content-1")).toMatchObject({
      data: REMOTE_BODY,
      conflicted: null,
      dateResolved: REMOTE_DATE,
    });
    expect(store.notes.get("note-1")).toMatchObject({ conflicted: true });
  });

  it("reports post_write_unverified when the original does not read back as resolved", async () => {
    const store = createStore({ dateShift: 1 });
    const binding = await bindingOf(store);

    const result = await resolveOriginal(store, binding);

    expect(result).toEqual({ outcome: "post_write_unverified" });
    expect(writesOf(store)).toEqual([...COPY_WRITES, "contentResolve", "noteClearConflict"]);
    expect(store.contents.get("content-1")).toMatchObject({ dateResolved: REMOTE_DATE + 1 });
  });
});

describe("Stage 5 keep-both copy identity", () => {
  it("refuses a copy id equal to the original's id, even when the copy title equals the original title", async () => {
    expect(copyTitleFor(COLLIDING_TITLE)).toBe(COLLIDING_TITLE);
    const store = createStore({ note: { title: COLLIDING_TITLE }, copyReturnsId: "note-1" });
    const binding = await bindingOf(store);
    const before = originalOf(store);

    await expect(resolveOriginal(store, binding)).resolves.toEqual({
      outcome: "copy_unverified",
    });
    expect(writesOf(store)).toEqual(["notesAddVerbatim"]);
    expect(originalOf(store)).toEqual(before);
  });

  it("refuses a copy id that names a different note whose title is not the copy title", async () => {
    const store = createStore({ foreignNote: true, copyReturnsId: "note-other" });
    const binding = await bindingOf(store);
    const before = originalOf(store);
    const foreignBefore = copyRows(store.notes.get("note-other"));

    await expect(resolveOriginal(store, binding)).resolves.toEqual({
      outcome: "copy_unverified",
    });
    expect(writesOf(store)).toEqual(["notesAddVerbatim"]);
    expect(originalOf(store)).toEqual(before);
    expect(store.notes.get("note-other")).toEqual(foreignBefore);
  });

  it("refuses when the copy's own note row carries a different id", async () => {
    const store = createStore({ copyNoteIdOverride: "note-copy-other" });
    const binding = await bindingOf(store);
    const before = originalOf(store);

    await expect(resolveOriginal(store, binding)).resolves.toEqual({
      outcome: "copy_unverified",
    });
    expect(writesOf(store)).toEqual(["notesAddVerbatim"]);
    expect(originalOf(store)).toEqual(before);
  });

  it("refuses when the copy's content row carries a different id", async () => {
    const store = createStore({ copyContentIdOverride: "content-copy-other" });
    const binding = await bindingOf(store);
    const before = originalOf(store);

    await expect(resolveOriginal(store, binding)).resolves.toEqual({
      outcome: "copy_unverified",
    });
    expect(writesOf(store)).toEqual(["notesAddVerbatim"]);
    expect(originalOf(store)).toEqual(before);
  });
});

describe("Stage 5 keep-both original read-back identity", () => {
  it("refuses to count the resolve when the original's own note row carries a different id", async () => {
    const store = createStore({
      afterClear: (notes) => {
        const note = notes.get("note-1");
        if (note !== undefined) notes.set("note-1", { ...note, id: "note-9" });
      },
    });
    const binding = await bindingOf(store);

    await expect(resolveOriginal(store, binding)).resolves.toEqual({
      outcome: "post_write_unverified",
    });
    expect(writesOf(store)).toEqual([...COPY_WRITES, "contentResolve", "noteClearConflict"]);
  });

  it.each<[string, Row]>([
    ["id", { id: "content-9" }],
    ["noteId", { noteId: "note-9" }],
  ])(
    "refuses to count the resolve when the content row's %s is not the expected one",
    async (_label, resolvedRow) => {
      const store = createStore({ resolvedRow });
      const binding = await bindingOf(store);

      await expect(resolveOriginal(store, binding)).resolves.toEqual({
        outcome: "post_write_unverified",
      });
      expect(writesOf(store)).toEqual([...COPY_WRITES, "contentResolve", "noteClearConflict"]);
    },
  );
});

describe("Stage 5 keep-both — the content marker after the resolve", () => {
  it("accepts an absent content marker as cleared", async () => {
    const store = createStore({ resolvedMarker: "absent" });
    const binding = await bindingOf(store);

    const result = await resolveOriginal(store, binding);

    expect(result).toEqual({
      outcome: "resolved",
      originalTitle: "Field notes",
      copyTitle: "Field notes (bridge copy)",
    });
    expect(writesOf(store)).toEqual([...COPY_WRITES, "contentResolve", "noteClearConflict"]);
    const original = store.contents.get("content-1");
    expect(original).toMatchObject({ data: REMOTE_BODY, dateResolved: REMOTE_DATE });
    expect(original).not.toHaveProperty("conflicted");
    expect(store.notes.get("note-1")).toMatchObject({ conflicted: false });
  });

  it("accepts a false content marker as cleared, since false also means not conflicted", async () => {
    const store = createStore({ resolvedMarker: "false" });
    const binding = await bindingOf(store);

    const result = await resolveOriginal(store, binding);

    expect(result).toEqual({
      outcome: "resolved",
      originalTitle: "Field notes",
      copyTitle: "Field notes (bridge copy)",
    });
    expect(store.contents.get("content-1")).toMatchObject({ conflicted: false });
    expect(store.notes.get("note-1")).toMatchObject({ conflicted: false });
  });

  it.each([
    ["true", "true"],
    ["a text value", "text"],
  ] as const)(
    "refuses to count the resolve when the content marker still reads %s",
    async (_label, marker) => {
      const store = createStore({ resolvedMarker: marker });
      const binding = await bindingOf(store);

      const result = await resolveOriginal(store, binding);

      expect(result).toEqual({ outcome: "post_write_unverified" });
      expect(writesOf(store)).toEqual([...COPY_WRITES, "contentResolve", "noteClearConflict"]);
    },
  );
});
