/**
 * Write implies readable — issue #331's invariant, tested at the boundary that
 * carries the risk.
 *
 * The bridge accepts a note if the sync server would take it, and the read path
 * refuses a stored row above `STORED_CONTENT_READ_BYTES`. Those two have to
 * agree: a row the write path produces but the read path refuses is a note the
 * owner can see in the app and cannot open here.
 *
 * The reachable case is not one huge body. `notes.append` composes a fragment
 * onto the stored content, and while each fragment is bounded on its own, the
 * composed row was bounded only by the codec's allocation guard — four times
 * the read threshold. Repeated appends therefore crossed the read threshold
 * with every individual step passing. These tests drive that path.
 */

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  createNotesnookWriteAdapter,
  type NotesnookStoredContent,
  type NotesnookWriteDatabase,
  type NotesnookWriteMarkdownCodec,
  type NotesnookWriteNoteMetadata,
} from "../src/core/notesnook-write-adapter.js";
import { DETERMINISTIC_MARKDOWN_CODEC } from "../src/core/notesnook-write-codec.js";
import { MARKDOWN_CODEC_STORED_BYTES, STORED_CONTENT_READ_BYTES } from "../src/core/size-limits.js";
import { createRevisionToken } from "../src/core/notesnook-write-contract.js";

const NOTE_ID = "0123456789abcdef01234567";
const CONTENT_ID = "content-1";
const EDITED_AT = 1_700_000_000_000;

interface FakeNote {
  id: string;
  title: string;
  contentId: string;
  pinned: boolean;
  favorite: boolean;
  conflicted: boolean;
  locked: boolean;
  dateEdited: number;
}

interface FakeContent {
  id: string;
  noteId: string;
  type: "html" | "tiptap";
  data: string;
}

interface FakeCalls {
  notesAdd: Array<{ title: string; content: NotesnookStoredContent }>;
  notesUpdate: Array<Record<string, unknown>>;
  contentUpdate: Array<Record<string, unknown>>;
  notesTouch: number;
}

function createFakeDatabase(seed: { note?: FakeNote; content?: FakeContent } = {}): {
  database: NotesnookWriteDatabase;
  calls: FakeCalls;
  stored: () => FakeContent | undefined;
} {
  const note: FakeNote = seed.note ?? {
    id: NOTE_ID,
    title: "Seeded",
    contentId: CONTENT_ID,
    pinned: false,
    favorite: false,
    conflicted: false,
    locked: false,
    dateEdited: EDITED_AT,
  };
  let content: FakeContent | undefined = seed.content ?? {
    id: CONTENT_ID,
    noteId: NOTE_ID,
    type: "html",
    data: "<p>body</p>",
  };

  const calls: FakeCalls = { notesAdd: [], notesUpdate: [], contentUpdate: [], notesTouch: 0 };

  const metadata = (): NotesnookWriteNoteMetadata => ({
    id: note.id,
    title: note.title,
    contentId: note.contentId,
    pinned: note.pinned,
    favorite: note.favorite,
    conflicted: note.conflicted,
    locked: note.locked,
    dateEdited: note.dateEdited,
  });

  const database: NotesnookWriteDatabase = {
    note: async (id) => (id === note.id ? metadata() : undefined),
    contentFindByNoteId: async (noteId) =>
      content && content.noteId === noteId
        ? { id: content.id, noteId: content.noteId, type: content.type, data: content.data }
        : undefined,
    notesAdd: async (input) => {
      calls.notesAdd.push(input);
      return NOTE_ID;
    },
    notesUpdate: async (_ids, partial) => {
      calls.notesUpdate.push(partial);
    },
    notesTouch: async () => {
      calls.notesTouch += 1;
    },
    contentAdd: async () => CONTENT_ID,
    contentUpdateByNoteId: async (partial) => {
      calls.contentUpdate.push(partial);
      if (content && typeof partial.data === "string") {
        content = { ...content, data: partial.data };
      }
    },
    notebookExists: async () => false,
    notebookNotes: async () => [],
    notebookAddNote: async () => undefined,
    notebookRemoveNote: async () => undefined,
    tagExists: async () => false,
    tagAdd: async () => "tag-1",
    relationAdd: async () => undefined,
    relationRemove: async () => undefined,
    relationListForNote: async () => [],
  };

  return { database, calls, stored: () => content };
}

/** The categorical code a promise rejects with, or `"resolved"`. */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "resolved";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "uncategorised";
  }
}

/**
 * Stored HTML with a body of exactly `bytes` bytes, built the way the codec
 * builds one so the composition path accepts it.
 */
function seededDocumentOf(bytes: number): string {
  const wrapper = "<div data-type=\"document\"><p></p></div>";
  const body = "a".repeat(Math.max(0, bytes - Buffer.byteLength(wrapper, "utf8")));
  return `<div data-type="document"><p>${body}</p></div>`;
}

describe("write implies readable", () => {
  it("lets the codec's bound stay looser than the read threshold, and says so", () => {
    // The codec bound is an allocation guard. If this ever inverts, the adapter
    // check below becomes dead code and this test says so.
    expect(MARKDOWN_CODEC_STORED_BYTES).toBeGreaterThan(STORED_CONTENT_READ_BYTES);
  });

  it("refuses an append that would compose a row past the read threshold, before any mutation", async () => {
    const seeded = seededDocumentOf(STORED_CONTENT_READ_BYTES - 512);
    const { database, calls, stored } = createFakeDatabase({
      content: { id: CONTENT_ID, noteId: NOTE_ID, type: "html", data: seeded },
    });
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec: DETERMINISTIC_MARKDOWN_CODEC,
    });

    // Comfortably inside every per-call limit; only the composed row is over.
    const fragment = "b".repeat(4_096);
    expect(Buffer.byteLength(fragment, "utf8")).toBeLessThan(32_768);

    await expect(
      adapter.appendNote({
        id: NOTE_ID,
        markdownFragment: fragment,
        expectedRevision: createRevisionToken({ id: NOTE_ID, dateEdited: EDITED_AT, revisionCounter: 0 }),
      }),
    ).rejects.toMatchObject({ code: "too_large" });

    // Nothing was written: no content row, no note update, no timestamp touch.
    expect(calls.contentUpdate).toHaveLength(0);
    expect(calls.notesUpdate).toHaveLength(0);
    expect(calls.notesTouch).toBe(0);
    expect(stored()?.data).toBe(seeded);
  });

  it("accepts an append whose composed row still fits, and the row stays inside the threshold", async () => {
    const seeded = seededDocumentOf(STORED_CONTENT_READ_BYTES - 8_192);
    const { database, calls, stored } = createFakeDatabase({
      content: { id: CONTENT_ID, noteId: NOTE_ID, type: "html", data: seeded },
    });
    const adapter = createNotesnookWriteAdapter({
      source: database,
      codec: DETERMINISTIC_MARKDOWN_CODEC,
    });

    await expect(
      adapter.appendNote({
        id: NOTE_ID,
        markdownFragment: "small paragraph",
        expectedRevision: createRevisionToken({ id: NOTE_ID, dateEdited: EDITED_AT, revisionCounter: 0 }),
      }),
    ).resolves.toBeDefined();

    expect(calls.contentUpdate).toHaveLength(1);
    const composed = stored()?.data ?? "";
    expect(Buffer.byteLength(composed, "utf8")).toBeLessThanOrEqual(STORED_CONTENT_READ_BYTES);
  });

  it("refuses a codec that ignores its own bound, because the adapter measures the row", async () => {
    // An injected codec is a supported seam. One that emits a row above the read
    // threshold must not be able to write it, whatever its own limits say.
    const oversized = seededDocumentOf(STORED_CONTENT_READ_BYTES + 1);
    const leakyCodec: NotesnookWriteMarkdownCodec = {
      ...DETERMINISTIC_MARKDOWN_CODEC,
      encodeMarkdown: () => ({ type: "html", data: oversized }),
      appendMarkdownToStoredContent: (input) => ({ type: input.storedType, data: oversized }),
    } as NotesnookWriteMarkdownCodec;

    const { database, calls } = createFakeDatabase();
    const adapter = createNotesnookWriteAdapter({ source: database, codec: leakyCodec });

    expect(
      await refusalOf(() => adapter.createNote({ title: "Leaky codec", content: "fine" })),
    ).toBe("too_large");
    expect(calls.notesAdd).toHaveLength(0);
  });

  it("accepts one byte under the threshold and refuses one byte over", async () => {
    const under = seededDocumentOf(STORED_CONTENT_READ_BYTES - 1);
    const over = seededDocumentOf(STORED_CONTENT_READ_BYTES + 1);

    const accepted = createNotesnookWriteAdapter({
      source: createFakeDatabase().database,
      codec: {
        ...DETERMINISTIC_MARKDOWN_CODEC,
        encodeMarkdown: () => ({ type: "html", data: under }),
      } as NotesnookWriteMarkdownCodec,
    });
    const refused = createNotesnookWriteAdapter({
      source: createFakeDatabase().database,
      codec: {
        ...DETERMINISTIC_MARKDOWN_CODEC,
        encodeMarkdown: () => ({ type: "html", data: over }),
      } as NotesnookWriteMarkdownCodec,
    });

    expect(await refusalOf(() => accepted.createNote({ title: "Under", content: "x" }))).toBe(
      "resolved",
    );
    expect(await refusalOf(() => refused.createNote({ title: "Over", content: "x" }))).toBe(
      "too_large",
    );
  });
});
