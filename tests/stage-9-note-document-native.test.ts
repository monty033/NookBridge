import { describe, expect, it } from "vitest";
import {
  decodeNoteDocumentNative,
  serializeNoteDocumentNative,
  NOTESNOOK_JSON_WRITER_ENABLED,
} from "../src/core/note-document-native.js";
import {
  parseNoteDocumentMarkdown,
  serializeNoteDocumentMarkdown,
} from "../src/core/note-document-markdown.js";
import type { NoteDocumentV1 } from "../src/core/note-document.js";

const binding = { noteId: "fixture-note", revision: "fixture-revision" };
const wrap = (s: string) => ({
  type: "tiptap" as const,
  data: `<div data-type="document">${s}</div>`,
});
const paragraph = { type: "paragraph" as const, inlines: [{ text: "changed" }] };
function roundTrip(html: string) {
  const decoded = decodeNoteDocumentNative(wrap(html), binding);
  const markdown = serializeNoteDocumentMarkdown(decoded.document);
  const document = parseNoteDocumentMarkdown(markdown, { preimage: decoded.document });
  return {
    ...decoded,
    markdown,
    stored: serializeNoteDocumentNative(document, { context: decoded.context, binding }),
  };
}

describe("T03 native HTML adapter", () => {
  it("reads tiptap as HTML, including literal leading JSON text; JSON writing stays off", () => {
    expect(NOTESNOOK_JSON_WRITER_ENABLED).toBe(false);
    expect(roundTrip('<p>{"type":"doc"}</p>').document.blocks[0]).toEqual({
      type: "paragraph",
      inlines: [{ text: '{"type":"doc"}' }],
    });
    expect(() =>
      decodeNoteDocumentNative({ type: "tiptap", data: '{"type":"doc"}' }, binding),
    ).toThrow();
    expect(() =>
      serializeNoteDocumentNative({ version: 1, blocks: [] }, { writer: "json" }),
    ).toThrow();
  });
  it("preserves headings, marks, code, ordinary lists, table and callout directives", () => {
    const html =
      '<h1>Title</h1><h2>Two</h2><h3>Three</h3><p><strong>bold</strong><em>italic</em><u>under</u><s>strike</s><code>code</code><a href="https://example.com">link</a><br>tail</p><ul><li><p>bullet</p></li></ul><ol><li><p>ordered</p></li></ol><pre><code class="language-ts">a &lt; b\n</code></pre><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>x</td><td>y</td></tr></tbody></table><div data-type="callout" data-variant="warning"><p>Careful</p></div>';
    const result = roundTrip(html);
    expect(result.document.blocks.map((b) => b.type)).toEqual([
      "heading",
      "heading",
      "heading",
      "paragraph",
      "bullet-list",
      "ordered-list",
      "code-block",
      "table",
      "callout",
    ]);
    expect(result.markdown).toContain(":::nookbridge table");
    expect(result.markdown).toContain(":::nookbridge callout warning");
    expect(result.stored).toEqual(wrap(html));
    const fresh = serializeNoteDocumentNative(result.document);
    expect(decodeNoteDocumentNative(fresh, binding).document).toEqual(result.document);
  });
  it("round-trips nested marks regardless of native nesting and coalesces equivalent runs", () => {
    for (const html of [
      "<p><em><strong>both</strong></em></p>",
      '<p><code><a href="https://example.com">linked code</a></code></p>',
    ])
      expect(roundTrip(html).stored).toEqual(wrap(html));
    const split: NoteDocumentV1 = {
      version: 1,
      blocks: [
        {
          type: "paragraph",
          inlines: [
            { text: "a", marks: ["bold"] },
            { text: "b", marks: ["bold"] },
          ],
        },
      ],
    };
    const merged: NoteDocumentV1 = {
      version: 1,
      blocks: [{ type: "paragraph", inlines: [{ text: "ab", marks: ["bold"] }] }],
    };
    expect(serializeNoteDocumentNative(split)).toEqual(serializeNoteDocumentNative(merged));
  });
  it("retains both list kinds and nested checked states, with legacy default override", () => {
    const html =
      '<ul class="simple-checklist"><li class="checked simple-checklist--item"><p>parent</p><ul class="simple-checklist"><li class="simple-checklist--item"><p>child</p></li></ul></li></ul><ul class="checklist"><li class="checked--item checklist--item"><p>interactive</p></li></ul>';
    const result = roundTrip(html);
    expect(result.document.blocks).toMatchObject([
      { kind: "simple-checklist", items: [{ checked: true, children: [{ checked: false }] }] },
      { kind: "task-list", items: [{ checked: true }] },
    ]);
    const doc: NoteDocumentV1 = {
      version: 1,
      blocks: [
        { type: "task-list", items: [{ checked: true, inlines: [{ text: "<&>" }], children: [] }] },
        result.document.blocks[0]!,
      ],
    };
    const output = serializeNoteDocumentNative(doc, { listKind: "task-list" });
    expect(output.data).toContain('<ul class="checklist">');
    expect(output.data).toContain('<ul class="simple-checklist">');
    expect(output.data).toContain("&lt;&amp;&gt;");
  });
  it("preserves unknown safe attributes and opaque native references byte for byte during edits", () => {
    const opaque =
      '<p data-custom="kept">unknown <span title="label">shape</span></p><div data-type="attachment" data-id="local-reference"><img src="https://example.com/image" alt="image"></div>';
    const decoded = decodeNoteDocumentNative(wrap("<p>before</p>" + opaque), binding);
    expect(decoded.document.blocks.slice(1).every((b) => b.type === "opaque")).toBe(true);
    expect(JSON.stringify(decoded.document)).not.toContain("local-reference");
    const edited = {
      version: 1 as const,
      blocks: [paragraph, ...decoded.document.blocks.slice(1)],
    };
    expect(
      serializeNoteDocumentNative(edited, { context: decoded.context, binding }).data,
    ).toContain(opaque);
    expect(() => serializeNoteDocumentNative(edited)).toThrow();
    for (const blocks of [
      edited.blocks.slice(0, 1),
      [...edited.blocks].reverse(),
      [...edited.blocks, edited.blocks[1]!],
    ]) {
      expect(() =>
        serializeNoteDocumentNative({ version: 1, blocks }, { context: decoded.context, binding }),
      ).toThrow();
    }
    expect(() =>
      serializeNoteDocumentNative(edited, {
        context: decoded.context,
        binding: { ...binding, revision: "stale" },
      }),
    ).toThrow();
    const forged = JSON.parse(JSON.stringify(edited)) as typeof edited;
    if (forged.blocks[1]?.type === "opaque")
      Object.assign(forged.blocks[1].sentinel, { token: "forged" });
    expect(() =>
      serializeNoteDocumentNative(forged, { context: decoded.context, binding }),
    ).toThrow();
  });
  it.each([
    '<p onclick="secret-canary">x</p>',
    '<a href="javascript:secret-canary">x</a>',
    '<p><a href="java&#x73;cript:secret-canary">x</a></p>',
    '<img src="data:text/html,secret-canary">',
    '<div data-type="attachment"><script>secret-canary</script></div>',
    '<p style="background:url(secret-canary)">x</p>',
    "<p><b>x</p></b>",
    '<p a="x" a="y">x</p>',
    '<iframe src="https://example.com"></iframe>',
  ])("categorically rejects hostile or malformed native HTML: %s", (html) => {
    try {
      decodeNoteDocumentNative(wrap(html), binding);
      throw new Error("accepted");
    } catch (error) {
      expect(error).toMatchObject({
        code: "unsupported_content",
        message: "Native note content is not supported",
      });
      expect(String(error)).not.toContain("secret-canary");
    }
  });
  it("preserves unsupported heading, table formatting, list start and inline attributes whole", () => {
    const html =
      '<h4>Four</h4><ol start="3"><li>third</li></ol><table><tr><th><b>marked</b></th></tr></table><p><strong title="keep">bold</strong></p><ul class="checklist"><li class="checklist--item"><p>parent</p><ul class="simple-checklist"><li class="simple-checklist--item"><p>child</p></li></ul></li></ul>';
    const result = roundTrip(html);
    expect(result.document.blocks.every((b) => b.type === "opaque")).toBe(true);
    expect(result.stored).toEqual(wrap(html));
  });
  it("decodes plain paragraph table cells and refuses browser-repaired nesting", () => {
    const decoded = decodeNoteDocumentNative(
      wrap("<table><tbody><tr><th><p>A</p></th></tr><tr><td><p>B</p></td></tr></tbody></table>"),
      binding,
    );
    expect(decoded.document.blocks[0]).toEqual({ type: "table", columns: ["A"], rows: [["B"]] });
    for (const html of [
      "<p><p>x</p></p>",
      "<ul><p>x</p></ul>",
      "<table><p>x</p></table>",
      '<a href="https://example.com"><a href="https://example.com">x</a></a>',
    ])
      expect(() => decodeNoteDocumentNative(wrap(html), binding)).toThrow();
  });
  it("rejects unknown AST fields and canonicalizes equivalent mark order", () => {
    const doc: NoteDocumentV1 = {
      version: 1,
      blocks: [{ type: "paragraph", inlines: [{ text: "x", marks: ["italic", "bold"] }] }],
    };
    const other: NoteDocumentV1 = {
      version: 1,
      blocks: [{ type: "paragraph", inlines: [{ text: "x", marks: ["bold", "italic"] }] }],
    };
    expect(serializeNoteDocumentNative(doc)).toEqual(serializeNoteDocumentNative(other));
    expect(() =>
      serializeNoteDocumentNative({ ...doc, extra: "lost" } as unknown as NoteDocumentV1),
    ).toThrow();
    expect(() =>
      serializeNoteDocumentNative({
        version: 1,
        blocks: [{ ...paragraph, attrs: { title: "lost" } }],
      } as unknown as NoteDocumentV1),
    ).toThrow();
  });
  it("keeps no-op native bytes despite object key ordering and binds contexts to note identity", () => {
    const original = wrap("<p data-extra='keep'>opaque</p><p>plain</p>");
    const decoded = decodeNoteDocumentNative(original, binding);
    const opaque = decoded.document.blocks[0]!;
    if (opaque.type !== "opaque") throw new Error("fixture");
    const document: NoteDocumentV1 = {
      blocks: [
        {
          sentinel: { token: opaque.sentinel.token, source: "native-html", version: 1 },
          nodeType: opaque.nodeType,
          type: "opaque",
        },
        { inlines: [{ text: "plain" }], type: "paragraph" },
      ],
      version: 1,
    };
    expect(serializeNoteDocumentNative(document, { context: decoded.context, binding })).toEqual(
      original,
    );
    expect(() =>
      serializeNoteDocumentNative(document, {
        context: decoded.context,
        binding: { ...binding, noteId: "other" },
      }),
    ).toThrow();
    expect(() =>
      serializeNoteDocumentNative(document, { context: { version: 1 }, binding }),
    ).toThrow();
  });
  it("bounds parser depth, encoded bytes and hostile object work", () => {
    expect(() =>
      decodeNoteDocumentNative(
        wrap("<blockquote>".repeat(80) + "<p>x</p>" + "</blockquote>".repeat(80)),
        binding,
      ),
    ).toThrow();
    const doc: NoteDocumentV1 = {
      version: 1,
      blocks: Array.from({ length: 40 }, () => ({
        type: "paragraph",
        inlines: [{ text: "<".repeat(8000) }],
      })),
    };
    expect(() => serializeNoteDocumentNative(doc)).toThrow();
    let called = false;
    const hostile = new Proxy(
      {},
      {
        get() {
          called = true;
          throw new Error("secret-canary");
        },
      },
    );
    expect(() => serializeNoteDocumentNative(hostile as NoteDocumentV1)).toThrow();
    expect(called).toBe(false);
  });
  it("rejects malformed envelopes, excessive input, accessors and unsafe AST URLs", () => {
    for (const envelope of [
      null,
      { type: "json", data: "{}" },
      { type: "tiptap", data: {} },
      { type: "html", data: "<p>x</p>", extra: true },
      wrap("x".repeat(256 * 1024)),
    ])
      expect(() => decodeNoteDocumentNative(envelope, binding)).toThrow();
    let called = false;
    expect(() =>
      decodeNoteDocumentNative(
        {
          get type() {
            called = true;
            return "tiptap";
          },
          data: "<p>x</p>",
        },
        binding,
      ),
    ).toThrow();
    expect(called).toBe(false);
    expect(() =>
      serializeNoteDocumentNative({
        version: 1,
        blocks: [
          {
            type: "paragraph",
            inlines: [{ text: "x", marks: [{ type: "link", href: "javascript:alert(1)" }] }],
          },
        ],
      }),
    ).toThrow();
  });
});
