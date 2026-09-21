/**
 * T13 / D14 — rendered acceptance for a note created through the write path.
 *
 * D14 requires a release promotion to show the **rendered tree** a client sees
 * (`<ul class="checklist">` vs `<ul class="simple-checklist">`, headings, opaque
 * directives preserved as opaque) and explicitly refuses a "proof" that rests
 * on a title search or an HTML marker.  No real Notesnook client is reachable
 * from this environment, so this fixture drives the SAME code the daemon runs —
 * the production deterministic Markdown codec behind the real write adapter —
 * and asserts the stored tree the pinned runtime renders from.
 *
 * Inline `**bold**` / `*italic*` / `` `code` `` are asserted here in their
 * rendered form, and one test carries them through the edit projection to
 * prove a created note stays editable rather than degrading to opaque content.
 *
 * What this fixture deliberately does NOT assert:
 *
 *   - Markdown tables and fenced code blocks.  The codec refuses both
 *     categorically, so a table or callout reaches a note only as an opaque
 *     directive; this fixture asserts the refusal instead of a rendered table.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createNotesnookWriteAdapter,
  type NotesnookStoredContent,
  type NotesnookWriteDatabase,
} from "../src/core/notesnook-write-adapter.js";
import { isNotesnookWriteContractError } from "../src/core/notesnook-write-contract.js";
import { createDeterministicMarkdownCodec } from "../src/core/notesnook-write-codec.js";
import {
  decodeNoteDocumentNative,
  serializeNoteDocumentNative,
} from "../src/core/note-document-native.js";
import {
  parseNoteDocumentMarkdown,
  serializeNoteDocumentMarkdown,
} from "../src/core/note-document-markdown.js";

const NOTE_ID = "0123456789abcdef0123456789abcdef";

interface CapturedCreate {
  readonly title: string;
  readonly content: NotesnookStoredContent;
}

/** A write seam that records exactly what the codec handed to `notesAdd`. */
function capturingDatabase(captured: CapturedCreate[]): NotesnookWriteDatabase {
  return {
    notesAdd: vi.fn(async (input: CapturedCreate) => {
      captured.push(input);
      return NOTE_ID;
    }),
    notebookExists: vi.fn(async () => true),
    notebookAddNote: vi.fn(async () => undefined),
    notebookRemoveNote: vi.fn(async () => undefined),
    notebookNotes: vi.fn(async () => [] as readonly string[]),
    note: vi.fn(async () => undefined),
    contentFindByNoteId: vi.fn(async () => undefined),
    notesUpdate: vi.fn(async () => undefined),
    notesTouch: vi.fn(async () => undefined),
    contentAdd: vi.fn(async () => NOTE_ID),
    contentUpdateByNoteId: vi.fn(async () => undefined),
    tagExists: vi.fn(async () => true),
    tagAdd: vi.fn(async () => undefined),
    relationAdd: vi.fn(async () => undefined),
    relationRemove: vi.fn(async () => undefined),
    relationListForNote: vi.fn(async () => [] as readonly unknown[]),
  } as unknown as NotesnookWriteDatabase;
}

function adapterOver(captured: CapturedCreate[]) {
  return createNotesnookWriteAdapter({
    source: capturingDatabase(captured),
    codec: createDeterministicMarkdownCodec(),
  });
}

/**
 * Every construct the codec round-trips today, in one document: the heading
 * spine, a paragraph, a nested checklist, and a plain unordered list.
 */
const ACCEPTANCE_DOCUMENT = [
  "# Delivery checklist",
  "",
  "Short intro paragraph & an ampersand.",
  "",
  "Inline **bold**, *slanted* and `code()` marks.",
  "",
  "- [ ] unpack the crates",
  "    - [ ] check the seals",
  "- [x] sign the manifest",
  "",
  "## Second section",
  "",
  "### Third section",
  "",
  "- plain item",
  "- another item",
  "",
].join("\n");

async function createDocument(listKind?: "simple-checklist" | "task-list") {
  const captured: CapturedCreate[] = [];
  const adapter = adapterOver(captured);
  const result = await adapter.createNote({
    title: "Delivery checklist",
    content: ACCEPTANCE_DOCUMENT,
    ...(listKind === undefined ? {} : { listKind }),
  });
  return { captured, result };
}

describe("T13 rendered acceptance — the tree a created note renders from", () => {
  it("stores exactly one document for the created note", async () => {
    const { captured, result } = await createDocument();
    expect(result.id).toBe(NOTE_ID);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.title).toBe("Delivery checklist");
    expect(captured[0]?.content.type).toBe("tiptap");
    expect(captured[0]?.content.data.startsWith('<div data-type="document">')).toBe(true);
  });

  it("renders the heading spine as h1 / h2 / h3", async () => {
    const { captured } = await createDocument();
    const data = captured[0]?.content.data ?? "";
    expect(data).toContain("<h1>Delivery checklist</h1>");
    expect(data).toContain("<h2>Second section</h2>");
    expect(data).toContain("<h3>Third section</h3>");
  });

  it("renders the paragraph and escapes operator text", async () => {
    const { captured } = await createDocument();
    const data = captured[0]?.content.data ?? "";
    expect(data).toContain("<p>Short intro paragraph &amp; an ampersand.</p>");
  });

  it("renders the inline mark set as the tags the projection reads back", async () => {
    const { captured } = await createDocument();
    const data = captured[0]?.content.data ?? "";
    expect(data).toContain(
      "<p>Inline <strong>bold</strong>, <em>slanted</em> and <code>code()</code> marks.</p>",
    );
    // The delimiters themselves must not survive as literal text.
    expect(data).not.toContain("**bold**");
    expect(data).not.toContain("*slanted*");
  });

  it("round-trips a created note's marks through the edit projection", async () => {
    const captured: CapturedCreate[] = [];
    const adapter = adapterOver(captured);
    await adapter.createNote({
      title: "Marks",
      content: "Inline **bold**, *slanted* and `code()` marks.\n",
    });
    const stored = captured[0]?.content;
    if (stored === undefined) throw new Error("the adapter captured no stored content");

    // The operator editing the note must see the marks, not an opaque block.
    const binding = { noteId: NOTE_ID, revision: "fixture-revision" };
    const decoded = decodeNoteDocumentNative(stored, binding);
    const markdown = serializeNoteDocumentMarkdown(decoded.document);
    expect(markdown).toContain("**bold**");
    expect(markdown).toContain("*slanted*");
    expect(markdown).toContain("`code()`");

    // A no-op edit restores the stored tree byte for byte, so undo stays exact.
    const reparsed = parseNoteDocumentMarkdown(markdown, { preimage: decoded.document });
    expect(serializeNoteDocumentNative(reparsed, { context: decoded.context, binding })).toEqual(
      stored,
    );
  });

  it("renders a plain unordered list without any checklist markup", async () => {
    const { captured } = await createDocument();
    const data = captured[0]?.content.data ?? "";
    expect(data).toContain("<ul><li>plain item</li><li>another item</li></ul>");
  });

  it("renders the lightweight read-only checklist by default", async () => {
    const { captured } = await createDocument();
    const data = captured[0]?.content.data ?? "";
    expect(data).toContain('<ul class="simple-checklist">');
    expect(data).toContain('class="simple-checklist--item"');
    expect(data).toContain('class="checked simple-checklist--item"');
    // The checked item is the one marked [x].
    expect(data).toContain(
      '<li class="checked simple-checklist--item"><p>sign the manifest</p></li>',
    );
  });

  it("renders a nested checklist inside the owning item, at the same kind", async () => {
    const { captured } = await createDocument();
    const data = captured[0]?.content.data ?? "";
    // Two opens: the outer list and the child list owned by "unpack the crates".
    expect((data.match(/<ul class="simple-checklist">/g) ?? []).length).toBe(2);
    expect(data).toContain(
      '<li class="simple-checklist--item"><p>unpack the crates</p><ul class="simple-checklist">',
    );
  });

  it("renders the rich interactive checklist when task-list is selected", async () => {
    const { captured } = await createDocument("task-list");
    const data = captured[0]?.content.data ?? "";
    expect(data).toContain('<ul class="checklist">');
    expect(data).toContain('class="checklist--item"');
    expect(data).toContain('class="checked checklist--item"');
    // The two kinds are distinct: neither class leaks into the other.
    expect(data).not.toContain("simple-checklist");
  });

  it("never stores the Markdown source itself", async () => {
    const { captured } = await createDocument();
    const data = captured[0]?.content.data ?? "";
    expect(data).not.toContain("# Delivery checklist");
    expect(data).not.toContain("- [ ]");
    expect(data).not.toContain("- [x]");
    expect(data).not.toContain("- plain item");
  });
});

describe("T13 rendered acceptance — constructs the surface refuses", () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ["a Markdown table", "| a | b |\n| --- | --- |\n| 1 | 2 |\n"],
    ["a fenced code block", "```\nconst x = 1;\n```\n"],
    ["a link", "see [the docs](https://example.com/docs)\n"],
    ["an image", "![alt text](https://example.com/x.png)\n"],
    ["inline HTML", "<div>raw</div>\n"],
  ];

  for (const [name, content] of refused) {
    it(`refuses ${name} categorically and stores nothing`, async () => {
      const captured: CapturedCreate[] = [];
      const adapter = adapterOver(captured);
      let code: string | undefined;
      try {
        await adapter.createNote({ title: "Refused construct", content });
      } catch (error) {
        code = isNotesnookWriteContractError(error) ? error.code : "not-a-contract-error";
      }
      expect(code).toBe("unsupported_content");
      expect(captured).toHaveLength(0);
    });
  }

  it("refuses a document that mixes supported and unsupported constructs", async () => {
    const captured: CapturedCreate[] = [];
    const adapter = adapterOver(captured);
    await expect(
      adapter.createNote({
        title: "Mixed",
        content: "# Heading\n\n- [ ] item\n\n| a | b |\n| --- | --- |\n",
      }),
    ).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });
});
