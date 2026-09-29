/**
 * P1-7 fidelity gate — closed Markdown construct taxonomy.
 *
 * Astra finding P1-7: the Stage 4 deterministic codec silently
 * downgrades unsupported Markdown constructs to paragraph text.  The
 * fidelity gate refuses unsupported constructs BEFORE the adapter
 * mutates a note so a full replacement never loses the construct
 * shape the operator asked for.
 *
 * These tests cover the gate's detection surface and the adapter's
 * closed-vocabulary rejection.  Every test exercises a single
 * construct or rejection path so a regression points at the missing
 * detection rule immediately.
 */

import { describe, expect, it } from "vitest";

import {
  DETERMINISTIC_MARKDOWN_CODEC,
  SUPPORTED_MARKDOWN_CONSTRUCTS,
  UNSUPPORTED_MARKDOWN_CONSTRUCTS,
  assertSupportedConstructs,
  detectMarkdownConstructs,
} from "../src/core/notesnook-write-codec.js";
import { STAGE4_WRITE_LIMITS } from "../src/core/notesnook-write-contract.js";
import {
  NOTE_DOCUMENT_MARKDOWN_HEADER,
  parseNoteDocumentMarkdown,
  serializeNoteDocumentMarkdown,
} from "../src/core/note-document-markdown.js";
import { decodeNoteDocumentNative } from "../src/core/note-document-native.js";

const MAX_BYTES = STAGE4_WRITE_LIMITS.maxContentBytes;

describe("notesnook-write-codec — fidelity gate (P1-7)", () => {
  describe("SUPPORTED_MARKDOWN_CONSTRUCTS / UNSUPPORTED_MARKDOWN_CONSTRUCTS", () => {
    it("lists every supported construct", () => {
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("heading-1")).toBe(true);
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("heading-2")).toBe(true);
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("heading-3")).toBe(true);
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("unordered-list")).toBe(true);
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("task-list")).toBe(true);
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("paragraph")).toBe(true);
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("inline-bold")).toBe(true);
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("inline-italic")).toBe(true);
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("inline-code")).toBe(true);
    });

    it("does not include any construct the codec cannot round-trip", () => {
      for (const name of UNSUPPORTED_MARKDOWN_CONSTRUCTS) {
        expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has(name as never)).toBe(false);
      }
      // Task-list moved out of the unsupported list because the codec now
      // round-trips checked/unchecked task-list items as structural markup.
      expect(UNSUPPORTED_MARKDOWN_CONSTRUCTS).not.toContain("task-list");
      expect(UNSUPPORTED_MARKDOWN_CONSTRUCTS).not.toContain("link-or-image");
    });
  });

  describe("detectMarkdownConstructs", () => {
    it("detects headings 1..3", () => {
      expect(detectMarkdownConstructs("# Heading", MAX_BYTES)).toContain("heading-1");
      expect(detectMarkdownConstructs("## Heading", MAX_BYTES)).toContain("heading-2");
      expect(detectMarkdownConstructs("### Heading", MAX_BYTES)).toContain("heading-3");
    });

    it("detects unordered lists and paragraphs", () => {
      expect(detectMarkdownConstructs("- item", MAX_BYTES)).toContain("unordered-list");
      expect(detectMarkdownConstructs("plain text", MAX_BYTES)).toContain("paragraph");
    });

    it("detects the inline mark set", () => {
      const observed = detectMarkdownConstructs("**bold** *italic* `code`", MAX_BYTES);
      expect(observed).toContain("inline-bold");
      expect(observed).toContain("inline-italic");
      expect(observed).toContain("inline-code");
    });

    it("detects task lists", () => {
      expect(detectMarkdownConstructs("- [ ] todo", MAX_BYTES)).toContain("task-list");
      expect(detectMarkdownConstructs("- [x] done", MAX_BYTES)).toContain("task-list");
    });

    it("detects Markdown tables", () => {
      const observed = detectMarkdownConstructs("| a | b |\n| - | - |\n| 1 | 2 |", MAX_BYTES);
      expect(observed).toContain("markdown-table");
    });

    it("detects a horizontal rule as its own construct, distinct from a table", () => {
      const observed = detectMarkdownConstructs("above\n\n---\n\nbelow", MAX_BYTES);
      expect(observed).toContain("horizontal-rule");
      expect(observed).not.toContain("markdown-table");
    });

    it("detects a fenced code block as its own construct", () => {
      const observed = detectMarkdownConstructs("```\ncode\n```", MAX_BYTES);
      expect(observed).toContain("fenced-code-block");
    });

    it("detects a blockquote", () => {
      expect(detectMarkdownConstructs("> quoted line", MAX_BYTES)).toContain("blockquote");
    });

    it("detects attachment references", () => {
      expect(detectMarkdownConstructs("![[file.png]]", MAX_BYTES)).toContain(
        "attachment-reference",
      );
      expect(detectMarkdownConstructs("![alt](file.png)", MAX_BYTES)).toContain(
        "attachment-reference",
      );
    });

    it("detects fenced code blocks", () => {
      expect(detectMarkdownConstructs("```\ncode\n```", MAX_BYTES)).toContain("fenced-code-block");
    });

    it("detects links and images", () => {
      expect(detectMarkdownConstructs("[label](https://example.com)", MAX_BYTES)).toContain(
        "inline-link",
      );
      expect(detectMarkdownConstructs("![alt](file.png)", MAX_BYTES)).toContain(
        "attachment-reference",
      );
    });

    it("detects inline HTML", () => {
      expect(
        detectMarkdownConstructs("<table><tr><td>cell</td></tr></table>", MAX_BYTES),
      ).toContain("inline-html");
    });
  });

  describe("assertSupportedConstructs", () => {
    it("accepts input made entirely of supported constructs", () => {
      expect(() =>
        assertSupportedConstructs(
          "# Title\n\n- item one\n- item two\n\nA paragraph with **bold** and *italic* and `code`.",
          MAX_BYTES,
        ),
      ).not.toThrow();
    });

    it("accepts a Markdown table", () => {
      expect(() =>
        assertSupportedConstructs("| a | b |\n| - | - |\n| 1 | 2 |", MAX_BYTES),
      ).not.toThrow();
    });

    it("accepts a horizontal rule", () => {
      expect(() => assertSupportedConstructs("above\n\n---\n\nbelow", MAX_BYTES)).not.toThrow();
    });

    it("accepts a fenced code block", () => {
      expect(() => assertSupportedConstructs("```\nsome code\n```", MAX_BYTES)).not.toThrow();
    });

    it("accepts a blockquote", () => {
      expect(() => assertSupportedConstructs("> quoted line", MAX_BYTES)).not.toThrow();
    });

    it("accepts a task list", () => {
      expect(() => assertSupportedConstructs("- [ ] todo", MAX_BYTES)).not.toThrow();
      expect(() => assertSupportedConstructs("- [x] done", MAX_BYTES)).not.toThrow();
    });

    it.each([
      ':::nookbridge image 1\n{"url":"https://example.test/a.png"}\n:::',
      ':::nookbridge attachment 1\n{"url":"https://example.test/a.pdf"}\n:::',
      ':::nookbridge embed 1\n{"url":"https://example.test/video"}\n:::',
      ":::nookbridge math 1\nE = mc^2\n:::",
    ])("refuses reserved NookBridge structured directives before they flatten: %s", (input) => {
      expect(() => assertSupportedConstructs(input, MAX_BYTES)).toThrow();
    });

    it("keeps a four-dash paragraph distinct from the canonical three-dash rule", () => {
      expect(detectMarkdownConstructs("----", MAX_BYTES)).toEqual(new Set(["paragraph"]));
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("----").data).toContain("<p>----</p>");
    });

    it("treats a four-dash line consistently with the canonical Markdown parser/writer", () => {
      // Finding 5: the legacy codec's exact-three-dash rule must not just be
      // internally self-consistent — it must agree with the canonical
      // interchange grammar (`note-document-markdown.ts`) that a Markdown
      // preimage/apply round trip also has to tolerate.  Both sides treat a
      // longer dash run as ordinary literal paragraph text.
      const doc = parseNoteDocumentMarkdown(`${NOTE_DOCUMENT_MARKDOWN_HEADER}\n----\n`);
      expect(doc.blocks).toEqual([{ type: "paragraph", inlines: [{ text: "----" }] }]);
      expect(serializeNoteDocumentMarkdown(doc)).toBe(`${NOTE_DOCUMENT_MARKDOWN_HEADER}\n----\n`);
      expect(detectMarkdownConstructs("----", MAX_BYTES)).toEqual(new Set(["paragraph"]));
      expect(() => assertSupportedConstructs("----", MAX_BYTES)).not.toThrow();
    });

    it("accepts a nested unordered list now that the codec has a nesting model", () => {
      // Finding 1 (superseded): the legacy write codec had no nesting model,
      // so `- parent\n  - child` was refused to stop it silently flattening
      // into a literal paragraph that kept the child's raw `  - child` text.
      // The codec now renders the nesting (renderNestedBulletListBlock), so
      // the construct is supported — and the downgrade the gate guarded
      // against is unreachable because renderBlock has a nested branch.
      expect(detectMarkdownConstructs("- parent\n  - child", MAX_BYTES)).toEqual(
        new Set(["nested-unordered-list"]),
      );
      expect(() => assertSupportedConstructs("- parent\n  - child", MAX_BYTES)).not.toThrow();
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("nested-unordered-list")).toBe(true);
      expect(UNSUPPORTED_MARKDOWN_CONSTRUCTS).not.toContain("nested-unordered-list");
    });

    it("splits a plain bullet from an adjacent task marker instead of merging them", () => {
      // splitBlocks breaks a block on a change of line shape, so a plain
      // bullet and a `- [ ]` item never share one block: each is classified
      // and rendered on its own terms.  That invariant is what keeps the
      // ordinary bullet tree from ever having to express checkbox
      // semantics — this test pins it, because the nested-branch routing
      // above relies on it.
      expect(detectMarkdownConstructs("- parent\n  - [ ] child", MAX_BYTES)).toEqual(
        new Set(["unordered-list", "task-list"]),
      );
    });

    it("still accepts a flat unordered list with no indentation", () => {
      expect(detectMarkdownConstructs("- one\n- two", MAX_BYTES)).toEqual(
        new Set(["unordered-list"]),
      );
      expect(() => assertSupportedConstructs("- one\n- two", MAX_BYTES)).not.toThrow();
    });

    it("refuses an attachment reference", () => {
      expect(() => assertSupportedConstructs("![[photo.png]]", MAX_BYTES)).toThrow();
    });

    it("round-trips a safe HTTPS inline link through the native projection", () => {
      const markdown = "Read [Notesnook](https://example.com) and **[docs](https://example.org)**.";
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).not.toThrow();
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      expect(encoded.data).toContain('<a href="https://example.com">Notesnook</a>');
      expect(encoded.data).toContain('<strong><a href="https://example.org">docs</a></strong>');
      expect(encoded.data).not.toContain("](https://");
      const decoded = decodeNoteDocumentNative(
        { type: encoded.type, data: encoded.data },
        {
          noteId: "fixture-note",
          revision: "fixture-revision",
        },
      );
      expect(serializeNoteDocumentMarkdown(decoded.document)).toBe(
        `${NOTE_DOCUMENT_MARKDOWN_HEADER}\n${markdown}\n`,
      );
    });

    it("keeps link-looking syntax inside code spans literal", () => {
      const markdown = "`[label](https://example.com)`";
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      expect(encoded.data).toContain("<code>[label](https://example.com)</code>");
      expect(encoded.data).not.toContain('<a href="https://example.com">');
    });

    it("does not treat literal link-token-shaped text as a generated link placeholder", () => {
      const tokenShapedText = "\uE001L0\uE001";
      const markdown = `${tokenShapedText} [docs](https://example.com)`;
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      expect(encoded.data).toContain(tokenShapedText);
      expect(encoded.data).toContain('<a href="https://example.com">docs</a>');
    });

    it("continues root numbering after a nested child", () => {
      const markdown = "1. first root\n  1. child\n2. second root";
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).not.toThrow();
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown).data).toBe(
        '<div data-type="document"><ol>' +
          "<li><p>first root</p><ol><li><p>child</p></li></ol></li>" +
          "<li><p>second root</p></li>" +
          "</ol></div>",
      );
    });

    it("composes emphasis around links", () => {
      const markdown = "*[italic docs](https://example.com/italic)*";
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      expect(encoded.data).toContain(
        '<em><a href="https://example.com/italic">italic docs</a></em>',
      );
    });

    it("renders supported inline marks inside link labels", () => {
      const markdown =
        "[**bold**](https://example.com/bold) [*italic*](https://example.com/italic) [`code`](https://example.com/code)";
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).not.toThrow();
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      expect(encoded.data).toContain(
        '<a href="https://example.com/bold"><strong>bold</strong></a>',
      );
      expect(encoded.data).toContain('<a href="https://example.com/italic"><em>italic</em></a>');
      expect(encoded.data).toContain('<a href="https://example.com/code"><code>code</code></a>');
    });

    it("refuses balanced parentheses inside an HTTPS destination", () => {
      const markdown = "[x](https://example.com/path(foo))";
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).toThrow();
      expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown)).toThrow();
    });

    it("keeps a safe link separate from JavaScript-looking trailing prose", () => {
      const markdown = "[x](https://example.com)javascript:alert(1))";
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      expect(encoded.data).toContain('<a href="https://example.com">x</a>javascript:alert(1))');
    });

    it("keeps a valid link followed by ordinary parenthetical prose", () => {
      const markdown = "Read [Notesnook](https://example.com) (see notes).";
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).not.toThrow();
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown).data).toContain(
        '<a href="https://example.com">Notesnook</a> (see notes).',
      );
    });

    it("keeps ordinary bracket prose with an unrelated parenthesis literal", () => {
      const markdown = "Use [square brackets] in prose (not a link).";
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).not.toThrow();
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown).data).toContain(
        "Use [square brackets] in prose (not a link).",
      );
    });

    it.each([
      "[broken](https://example.com",
      "unmatched [ prose https://example.com",
      "[label] trailing (https://example.com)",
      "[unsafe](javascript:alert(1))",
      "[relative](//example.com)",
      "[credentialed](https://user:pass@example.com)",
      "[safe](https://example.com) [unsafe](javascript:alert(1))",
      "[safe](https://example.com) [broken](https://example.org",
      "[parenthesized](https://example.com(foo))",
      "[outer [inner]](https://example.com)",
      "[outer [inner](https://example.com)](https://example.org)",
    ])("refuses malformed or unsafe inline links before mutation: %s", (markdown) => {
      // The production adapter invokes this fidelity gate before the codec;
      // direct codec encoding intentionally remains a lower-level primitive.
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).toThrow();
    });

    it("keeps link-like text inside a code span literal", () => {
      const markdown = "`[literal](https://example.com)`";
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).not.toThrow();
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown).data).toBe(
        '<div data-type="document"><p><code>[literal](https://example.com)</code></p></div>',
      );
    });

    it("refuses inline HTML", () => {
      expect(() =>
        assertSupportedConstructs("<table><tr><td>cell</td></tr></table>", MAX_BYTES),
      ).toThrow();
    });

    it("refuses input that mixes supported and unsupported constructs", () => {
      // Task-list is supported, so mixing it in does NOT cause refusal on
      // its own.  The refusal must come from the remaining unsupported
      // construct (inline HTML) that the input still contains.
      expect(() =>
        assertSupportedConstructs("- [ ] todo\n\n<table><tr><td>cell</td></tr></table>", MAX_BYTES),
      ).toThrow();
    });
  });

  describe("task-list codec fidelity (P1-7 follow-up)", () => {
    const wrap = (inner: string) => `<div data-type="document">${inner}</div>`;

    it("encodes interactive Notesnook simple-checklist nodes", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- [x] done\n    - [ ] child");
      expect(encoded.data).toBe(
        wrap(
          '<ul class="simple-checklist"><li class="checked simple-checklist--item"><p>done</p><ul class="simple-checklist"><li class="simple-checklist--item"><p>child</p></li></ul></li></ul>',
        ),
      );
    });

    it("encodes the current Notesnook simple-checklist HTML contract", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- [x] done\n    - [ ] child");
      expect(encoded.data).toBe(
        wrap(
          '<ul class="simple-checklist"><li class="checked simple-checklist--item"><p>done</p><ul class="simple-checklist"><li class="simple-checklist--item"><p>child</p></li></ul></li></ul>',
        ),
      );
    });

    it("keeps a heading separate from a following task list without a blank line", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(
        "## Simple checklist canary\n- [x] done\n    - [ ] child",
      );
      expect(encoded.data).toBe(
        wrap(
          '<h2>Simple checklist canary</h2><ul class="simple-checklist"><li class="checked simple-checklist--item"><p>done</p><ul class="simple-checklist"><li class="simple-checklist--item"><p>child</p></li></ul></li></ul>',
        ),
      );
    });

    it("encodes unchecked and checked items as interactive simple-checklist items", () => {
      const unchecked = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- [ ] todo");
      expect(unchecked.type).toBe("tiptap");
      expect(unchecked.data).toBe(
        wrap(
          '<ul class="simple-checklist"><li class="simple-checklist--item"><p>todo</p></li></ul>',
        ),
      );

      const checked = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- [x] done");
      expect(checked.data).toBe(
        wrap(
          '<ul class="simple-checklist"><li class="checked simple-checklist--item"><p>done</p></li></ul>',
        ),
      );
      expect(checked.data).not.toContain("&lt;ul");
      expect(checked.data).not.toContain("&lt;li");
    });

    it("HTML-escapes item text while keeping simple-checklist markup structural", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(
        '- [x] <script>alert("x")</script> & 1 < 2',
      );
      expect(encoded.data).toContain('<ul class="simple-checklist">');
      expect(encoded.data).toContain('<li class="checked simple-checklist--item"><p>');
      expect(encoded.data).toContain("&lt;script&gt;");
      expect(encoded.data).toContain("&amp;");
      expect(encoded.data).toContain("&quot;");
      expect(encoded.data).not.toContain("<script>");
    });

    it("renders nested task lists matching the input's tab indentation", () => {
      const markdown =
        "- [ ] parent\n" + "\t- [ ] child A\n" + "\t- [x] child B\n" + "\t\t- [ ] grandchild\n";
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      const inner = encoded.data.replace(/^<div data-type="document">/, "").replace(/<\/div>$/, "");
      const ulOpens = inner.match(/<ul class="simple-checklist">/g) ?? [];
      const ulCloses = inner.match(/<\/ul>/g) ?? [];
      expect(ulOpens.length).toBe(3);
      expect(ulCloses.length).toBe(3);
      expect(inner).toContain(
        '<li class="simple-checklist--item"><p>parent</p><ul class="simple-checklist">',
      );
      expect(inner).toContain('<li class="simple-checklist--item"><p>child A</p></li>');
      expect(inner).toContain(
        '<li class="checked simple-checklist--item"><p>child B</p><ul class="simple-checklist">',
      );
      expect(inner).toContain('<li class="simple-checklist--item"><p>grandchild</p></li>');
      const parentLiOpen = inner.indexOf('<li class="simple-checklist--item"><p>parent');
      const parentLiClose = inner.indexOf("</li>", parentLiOpen);
      const parentChildUlOpen = inner.indexOf('<ul class="simple-checklist">', parentLiOpen);
      expect(parentChildUlOpen).toBeGreaterThan(parentLiOpen);
      expect(parentChildUlOpen).toBeLessThan(parentLiClose);
      const childBOpen = inner.indexOf('<li class="checked simple-checklist--item"><p>child B');
      const childBClose = inner.indexOf("</li>", childBOpen);
      const grandchildUlOpen = inner.indexOf('<ul class="simple-checklist">', childBOpen);
      expect(grandchildUlOpen).toBeGreaterThan(childBOpen);
      expect(grandchildUlOpen).toBeLessThan(childBClose);
    });

    it("renders nested task lists matching the input's space indentation", () => {
      const markdown =
        "- [ ] parent\n" + "    - [ ] space-child\n" + "        - [ ] space-grandchild\n";
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      const inner = encoded.data.replace(/^<div data-type="document">/, "").replace(/<\/div>$/, "");
      const ulOpens = inner.match(/<ul class="simple-checklist">/g) ?? [];
      const ulCloses = inner.match(/<\/ul>/g) ?? [];
      expect(ulOpens.length).toBe(3);
      expect(ulCloses.length).toBe(3);
      expect(inner).toContain(
        '<li class="simple-checklist--item"><p>space-child</p><ul class="simple-checklist">',
      );
      expect(inner).toContain('<li class="simple-checklist--item"><p>space-grandchild</p></li>');
      const parentLiOpen = inner.indexOf('<li class="simple-checklist--item"><p>parent');
      const parentLiClose = inner.indexOf("</li>", parentLiOpen);
      const parentChildUlOpen = inner.indexOf('<ul class="simple-checklist">', parentLiOpen);
      expect(parentChildUlOpen).toBeGreaterThan(parentLiOpen);
      expect(parentChildUlOpen).toBeLessThan(parentLiClose);
    });

    it("renders nested task lists matching the input's two-space indentation", () => {
      const markdown = "- [ ] parent\n  - [x] space-child\n  - [ ] space-sibling\n";
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      const inner = encoded.data.replace(/^<div data-type="document">/, "").replace(/<\/div>$/, "");
      const ulOpens = inner.match(/<ul class="simple-checklist">/g) ?? [];
      const ulCloses = inner.match(/<\/ul>/g) ?? [];
      expect(ulOpens.length).toBe(2);
      expect(ulCloses.length).toBe(2);
      expect(inner).toContain(
        '<li class="simple-checklist--item"><p>parent</p><ul class="simple-checklist">',
      );
      expect(inner).toContain('<li class="checked simple-checklist--item"><p>space-child</p></li>');
      expect(inner).toContain('<li class="simple-checklist--item"><p>space-sibling</p></li>');

      const nativeTaskList = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown, "task-list");
      expect(nativeTaskList.data).toContain(
        '<li class="checklist--item"><p>parent</p><ul class="checklist">',
      );
      expect(nativeTaskList.data).toContain(
        '<li class="checked checklist--item"><p>space-child</p></li>',
      );
    });

    it("treats partial space indentation (fewer than four spaces) as a top-level sibling", () => {
      const markdown = "- [ ] parent\n   - [ ] ambiguous\n";
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      const inner = encoded.data.replace(/^<div data-type="document">/, "").replace(/<\/div>$/, "");
      const ulOpens = inner.match(/<ul class="simple-checklist">/g) ?? [];
      expect(ulOpens.length).toBe(1);
      expect(inner).toContain('<li class="simple-checklist--item"><p>parent</p></li>');
      expect(inner).toContain('<li class="simple-checklist--item"><p>ambiguous</p></li>');
      const parentLiOpen = inner.indexOf('<li class="simple-checklist--item"><p>parent');
      const parentLiClose = inner.indexOf("</li>", parentLiOpen);
      const siblingLiOpen = inner.indexOf('<li class="simple-checklist--item"><p>ambiguous');
      expect(siblingLiOpen).toBeGreaterThan(parentLiClose);
    });

    it("detects nested task lists without false positives on unsupported constructs", () => {
      const observed = detectMarkdownConstructs("- [ ] parent\n\t- [x] child", MAX_BYTES);
      expect(observed).toContain("task-list");
      expect(observed).not.toContain("markdown-table");
      expect(observed).not.toContain("fenced-code-block");
      expect(observed).not.toContain("link-or-image");
      expect(observed).not.toContain("inline-html");
    });
  });

  describe("Wave 1 detect/render parity regressions (found by independent review)", () => {
    const rendersTo = (markdown: string, expected: string) => {
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown).data).toBe(
        `<div data-type="document">${expected}</div>`,
      );
    };

    it("does not classify a lone pipe-containing line as a table", () => {
      const observed = detectMarkdownConstructs("a | b", MAX_BYTES);
      expect(observed).not.toContain("markdown-table");
      expect(observed).toContain("paragraph");
      rendersTo("a | b", "<p>a | b</p>");
    });

    it("refuses (does not silently downgrade) a header whose separator column count differs", () => {
      // Not classified as a table at all (mismatched separator width), so it
      // falls through to a plain paragraph instead of lying about support.
      const observed = detectMarkdownConstructs("| a | b |\n| - |\n| 1 | 2 |", MAX_BYTES);
      expect(observed).not.toContain("markdown-table");
    });

    it("splits two adjacent fenced code blocks with no blank line between them", () => {
      rendersTo(
        "```js\ncode1\n```\n```py\ncode2\n```",
        '<pre><code class="language-js">code1</code></pre><pre><code class="language-py">code2</code></pre>',
      );
    });

    it("isolates a fenced code block immediately followed by text with no blank line", () => {
      rendersTo("```\ncode\n```\nafter", "<pre><code>code</code></pre><p>after</p>");
    });

    it("refuses a fence-shaped opener with trailing text rather than guessing what it meant", () => {
      // "```js extra" does not match the bounded fence-open grammar, so it is
      // just prose — but the bare "```" on the last line then matches the
      // fence-OPEN grammar itself (an empty language token) and never finds a
      // matching close before EOF.  This is genuinely ambiguous, malformed
      // fenced-code-shaped input; per the "refuse rather than downgrade"
      // contract (see the unclosed-fence fix, round 5), it is refused instead
      // of silently rendering as a literal paragraph.
      const markdown = "```js extra\nplain text\n```";
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).toThrow();
    });

    it("does not refuse HTML-like text inside a fenced code block body", () => {
      expect(() =>
        assertSupportedConstructs("```html\n<b>not bold</b>\n```", MAX_BYTES),
      ).not.toThrow();
      rendersTo(
        "```html\n<b>not bold</b>\n```",
        '<pre><code class="language-html">&lt;b&gt;not bold&lt;/b&gt;</code></pre>',
      );
    });

    it("does not treat a horizontal rule with surrounding whitespace as one", () => {
      const observed = detectMarkdownConstructs("  ---  ", MAX_BYTES);
      expect(observed).not.toContain("horizontal-rule");
      rendersTo("  ---  ", "<p>  ---  </p>");
    });

    it("isolates a horizontal rule with no blank lines around it", () => {
      rendersTo(
        "above\n---\nbelow",
        '<p>above</p><hr style="display:block;border:0;border-top:1px solid currentColor;height:0;margin:1em 0" /><p>below</p>',
      );
    });

    it("does not treat a blockquote mixed with plain text as one block", () => {
      const observed = detectMarkdownConstructs("plain\n> quote", MAX_BYTES);
      expect(observed).toContain("paragraph");
      expect(observed).toContain("blockquote");
      rendersTo("plain\n> quote", "<p>plain</p><blockquote><p>quote</p></blockquote>");
    });

    it("keeps ordinary prose containing a pipe as one paragraph (round 2 finding)", () => {
      const observed = detectMarkdownConstructs("left\nx | y\nright", MAX_BYTES);
      expect(observed).not.toContain("markdown-table");
      expect(observed).toContain("paragraph");
      rendersTo("left\nx | y\nright", "<p>left<br />x | y<br />right</p>");
    });

    it("treats an escaped pipe in a table cell as literal content, not a delimiter (round 2 finding)", () => {
      const observed = detectMarkdownConstructs("| a\\|b | c |\n| - | - |\n| 1 | 2 |", MAX_BYTES);
      expect(observed).toContain("markdown-table");
      rendersTo(
        "| a\\|b | c |\n| - | - |\n| 1 | 2 |",
        "<table><thead><tr><th>a|b</th><th>c</th></tr></thead>" +
          "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
      );
    });

    it("uses backslash parity, not one-char lookback, for escaped pipes (round 3 finding)", () => {
      // Two backslashes before the pipe: the first escapes the second into a
      // literal backslash, so the pipe itself is a REAL, unescaped delimiter.
      rendersTo(
        "| a\\\\| b |\n| - | - |\n| 1 | 2 |",
        "<table><thead><tr><th>a\\</th><th>b</th></tr></thead>" +
          "<tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
      );
    });

    it("keeps a table body row intact even when the cell text also looks like a task item (round 3 finding)", () => {
      // Without table-continuation awareness this splits into a headerless
      // table plus a stray checklist item instead of one 3-row table.
      rendersTo(
        "a | b\n--- | ---\n- [ ] | c",
        "<table><thead><tr><th>a</th><th>b</th></tr></thead>" +
          "<tbody><tr><td>- [ ]</td><td>c</td></tr></tbody></table>",
      );
    });

    it("preserves a literal tab inside a fenced code block body (round 3 finding)", () => {
      rendersTo("```\na\tb\n```", "<pre><code>a\tb</code></pre>");
    });

    it("ends the table when a following line has no pipe at all, instead of swallowing it (round 4 finding)", () => {
      rendersTo(
        "a | b\n--- | ---\n- [ ] outside",
        "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody></tbody></table>" +
          '<ul class="simple-checklist"><li class="simple-checklist--item"><p>outside</p></li></ul>',
      );
    });

    it("confirms a table in bounded time regardless of row count (round 4 finding: avoid O(n^2))", () => {
      const rowCount = 20_000;
      const rows = Array.from({ length: rowCount }, (_, i) => `| ${i} | ${i * 2} |`);
      const markdown = ["| a | b |", "| - | - |", ...rows].join("\n");
      const started = Date.now();
      const observed = detectMarkdownConstructs(markdown, MAX_BYTES + rows.join("\n").length + 100);
      const elapsedMs = Date.now() - started;
      expect(observed).toContain("markdown-table");
      // A quadratic re-validation of the growing block on every row would
      // take seconds at this size; the incremental confirmation check
      // keeps this comfortably under a second even on a slow CI runner.
      expect(elapsedMs).toBeLessThan(5000);
    });

    it("refuses an unclosed fenced code block instead of downgrading it to a literal paragraph (round 5 finding)", () => {
      expect(() => assertSupportedConstructs("```js\ncode", MAX_BYTES)).toThrow();
      expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("```js\ncode")).toThrow();
    });

    it("does not let a literal sentinel character in operator text corrupt an unrelated code span (round 5 finding)", () => {
      // U+E000 is the private-use code point the codec uses internally as a
      // code-span placeholder marker.  If the operator's own text happens to
      // contain it, it must not be mistaken for that internal marker.
      const withSentinel = "before \uE000 after `code`";
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(withSentinel);
      expect(encoded.data).toContain("<code>code</code>");
      expect(encoded.data).toContain("&#xE000;");
      expect(encoded.data).not.toContain("\uE000");
    });

    it("does not recognise an aligned table separator, since alignment cannot round-trip (round 6 finding)", () => {
      // NoteTableBlock has no alignment field, so accepting `:-`/`-:`/`:-:`
      // here would silently drop the alignment at render time with no way
      // to recover it on a future read+edit.  The block simply is not a
      // table at all — falls through to a plain paragraph instead.
      const markdown = "| A | B |\n| :- | -: |\n| 1 | 2 |";
      const observed = detectMarkdownConstructs(markdown, MAX_BYTES);
      expect(observed).not.toContain("markdown-table");
      rendersTo(markdown, "<p>| A | B |<br />| :- | -: |<br />| 1 | 2 |</p>");
    });

    it("refuses input containing a lone (unpaired) UTF-16 surrogate (round 6 finding)", () => {
      // A lone high surrogate ("\uD800") with no following low surrogate is
      // not valid UTF-16 text.  The native decoder's clean() pass rejects it
      // on read, so accepting it here would let a write succeed and then
      // make the note unreadable on the very next read.
      const loneHighSurrogate = "before \uD800 after";
      const loneLowSurrogate = "before \uDC00 after";
      expect(() => detectMarkdownConstructs(loneHighSurrogate, MAX_BYTES)).toThrow();
      expect(() => detectMarkdownConstructs(loneLowSurrogate, MAX_BYTES)).toThrow();
      expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(loneHighSurrogate)).toThrow();
      // A genuine surrogate PAIR (an emoji) is unaffected.
      expect(() => detectMarkdownConstructs("before \u{1F600} after", MAX_BYTES)).not.toThrow();
    });

    it("keeps a table body row starting with '#' as a row, not an isolated heading (round 7 finding)", () => {
      const markdown = "a | b\n--- | ---\n# cell | d";
      const observed = detectMarkdownConstructs(markdown, MAX_BYTES);
      expect(observed).toContain("markdown-table");
      expect(observed).not.toContain("heading-1");
      rendersTo(
        markdown,
        "<table><thead><tr><th>a</th><th>b</th></tr></thead>" +
          "<tbody><tr><td># cell</td><td>d</td></tr></tbody></table>",
      );
    });

    it("does not report inline-bold as observed for a table cell that renders it literally (round 8 finding)", () => {
      // Table cells are always plain escaped text (see renderTableBlock's doc
      // comment) — "**bold**" inside one stays literal, never <strong>.
      // Detection must agree: it must NOT flag "inline-bold" (a supported
      // construct) for this block, or the gate would say something is
      // supported that the renderer then silently fails to honour.
      const markdown = "| a | b |\n| - | - |\n| **bold** | plain |";
      const observed = detectMarkdownConstructs(markdown, MAX_BYTES);
      expect(observed).toContain("markdown-table");
      expect(observed).not.toContain("inline-bold");
      rendersTo(
        markdown,
        "<table><thead><tr><th>a</th><th>b</th></tr></thead>" +
          "<tbody><tr><td>**bold**</td><td>plain</td></tr></tbody></table>",
      );
    });
  });

  describe("Wave 1 native block rendering (horizontal rule, code block, blockquote, table)", () => {
    const wrap = (inner: string) => `<div data-type="document">${inner}</div>`;

    it("renders a horizontal rule with an explicit visible rule style", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("above\n\n---\n\nbelow");
      expect(encoded.data).toBe(
        wrap(
          '<p>above</p><hr style="display:block;border:0;border-top:1px solid currentColor;height:0;margin:1em 0" /><p>below</p>',
        ),
      );
    });

    it("renders a fenced code block with an escaped, unmodified body and no inline marks", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(
        '```js\nconst x = "<b>*not bold*</b>";\n```',
      );
      expect(encoded.data).toBe(
        wrap(
          '<pre><code class="language-js">const x = &quot;&lt;b&gt;*not bold*&lt;/b&gt;&quot;;</code></pre>',
        ),
      );
    });

    it("renders a fenced code block without a language tag", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("```\nplain\n```");
      expect(encoded.data).toBe(wrap("<pre><code>plain</code></pre>"));
    });

    it("renders a blockquote with inline marks applied", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("> a **bold** quote");
      expect(encoded.data).toBe(
        wrap("<blockquote><p>a <strong>bold</strong> quote</p></blockquote>"),
      );
    });

    it("renders a multi-line blockquote as one blockquote with <br /> between lines", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("> line one\n> line two");
      expect(encoded.data).toBe(wrap("<blockquote><p>line one<br />line two</p></blockquote>"));
    });

    it("renders a Markdown table as a native table", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(
        "| A | B |\n| - | - |\n| 1 | 2 |",
      );
      expect(encoded.data).toBe(
        wrap(
          "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
        ),
      );
    });

    it("HTML-escapes table cell content but does NOT apply inline marks (round 5 finding)", () => {
      // Table cells are escaped text only, never renderInline's <strong>/<em>/
      // <code> — the native decoder requires a table cell to be text-only, so
      // an inline mark inside a cell would make the WHOLE table opaque on the
      // next read (see the doc comment on renderTableBlock).
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(
        "| Name | Note |\n| - | - |\n| <script> | **bold** |",
      );
      expect(encoded.data).toContain("&lt;script&gt;");
      expect(encoded.data).not.toContain("<script>");
      expect(encoded.data).not.toContain("<strong>");
      expect(encoded.data).toContain("**bold**");
    });

    it("refuses a table whose row column count does not match the header", () => {
      expect(() =>
        DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("| A | B |\n| - | - |\n| 1 |"),
      ).toThrow();
    });

    it("appends a wave-1 block to existing stored tiptap content", () => {
      const codec = DETERMINISTIC_MARKDOWN_CODEC;
      const base = codec.encodeMarkdown("# Title");
      const appended = codec.appendMarkdownToStoredContent({
        storedType: base.type,
        storedData: base.data,
        markdownFragment: "> a quote",
      });
      expect(appended.data).toBe(wrap("<h1>Title</h1><blockquote><p>a quote</p></blockquote>"));
    });
  });

  describe("listKind intent — explicit simple-checklist vs task-list", () => {
    const wrap = (inner: string) => `<div data-type="document">${inner}</div>`;

    it("defaults to simple-checklist HTML when listKind is omitted", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- [x] done");
      expect(encoded.data).toBe(
        wrap(
          '<ul class="simple-checklist"><li class="checked simple-checklist--item"><p>done</p></li></ul>',
        ),
      );
      // The simple-checklist output must not contain the rich
      // `class="checklist"` marker (with the closing quote) — the bare
      // token `checklist--item` is a substring of `simple-checklist--item`
      // so we anchor on the class attribute instead.
      expect(encoded.data).not.toContain('class="checklist"');
      expect(encoded.data).not.toContain('class="checklist--item"');
    });

    it("emits simple-checklist HTML when listKind is explicitly 'simple-checklist'", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- [x] done", "simple-checklist");
      expect(encoded.data).toBe(
        wrap(
          '<ul class="simple-checklist"><li class="checked simple-checklist--item"><p>done</p></li></ul>',
        ),
      );
    });

    it("emits rich Notesnook checklist HTML when listKind is 'task-list'", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- [x] done", "task-list");
      expect(encoded.data).toBe(
        wrap('<ul class="checklist"><li class="checked checklist--item"><p>done</p></li></ul>'),
      );
      expect(encoded.data).not.toContain("simple-checklist");
      expect(encoded.data).not.toContain("simple-checklist--item");
    });

    it("emits unchecked items without a 'checked' class for both listKinds", () => {
      const simple = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- [ ] todo", "simple-checklist");
      const task = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- [ ] todo", "task-list");
      expect(simple.data).toBe(
        wrap(
          '<ul class="simple-checklist"><li class="simple-checklist--item"><p>todo</p></li></ul>',
        ),
      );
      expect(task.data).toBe(
        wrap('<ul class="checklist"><li class="checklist--item"><p>todo</p></li></ul>'),
      );
    });

    it("honours listKind for nested task-list blocks", () => {
      const markdown = "- [ ] parent\n\t- [x] child";
      const simple = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown, "simple-checklist");
      const task = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown, "task-list");
      // Every <ul> in the simple variant uses simple-checklist; every <ul>
      // in the task-list variant uses checklist. Nested children inherit.
      const simpleUl = (simple.data.match(/<ul class="[^"]+">/g) ?? []).map((s) => s.trim());
      const taskUl = (task.data.match(/<ul class="[^"]+">/g) ?? []).map((s) => s.trim());
      expect(simpleUl.length).toBeGreaterThan(0);
      expect(simpleUl.every((tag) => tag === '<ul class="simple-checklist">')).toBe(true);
      expect(taskUl.length).toBeGreaterThan(0);
      expect(taskUl.every((tag) => tag === '<ul class="checklist">')).toBe(true);
      expect(simple.data).toContain('<li class="simple-checklist--item">');
      expect(task.data).toContain('<li class="checklist--item">');
      expect(simple.data).toContain('<li class="checked simple-checklist--item"><p>child</p>');
      expect(task.data).toContain('<li class="checked checklist--item"><p>child</p>');
    });

    it("appends a listKind-aware block without altering the stored bytes ahead of it", () => {
      const storedType = "tiptap" as const;
      const storedData = '<div data-type="document"><h1>title</h1></div>';
      const nextSimple = DETERMINISTIC_MARKDOWN_CODEC.appendMarkdownToStoredContent({
        storedType,
        storedData,
        markdownFragment: "- [x] done",
      });
      const nextTask = DETERMINISTIC_MARKDOWN_CODEC.appendMarkdownToStoredContent({
        storedType,
        storedData,
        markdownFragment: "- [x] done",
        listKind: "task-list",
      });
      expect(nextSimple.data).toContain(
        '<ul class="simple-checklist"><li class="checked simple-checklist--item"><p>done</p></li></ul>',
      );
      expect(nextTask.data).toContain(
        '<ul class="checklist"><li class="checked checklist--item"><p>done</p></li></ul>',
      );
      // The pre-existing title must be preserved byte-for-byte.
      expect(nextSimple.data).toContain("<h1>title</h1>");
      expect(nextTask.data).toContain("<h1>title</h1>");
    });

    it("refuses an unknown listKind value", () => {
      expect(() =>
        DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- [ ] todo", "ordered-list" as never),
      ).toThrow();
      expect(() =>
        DETERMINISTIC_MARKDOWN_CODEC.appendMarkdownToStoredContent({
          storedType: "tiptap",
          storedData: '<div data-type="document"></div>',
          markdownFragment: "- [ ] todo",
          listKind: "ordered" as never,
        }),
      ).toThrow();
    });
  });

  describe("inline mark rendering (P1-7 follow-up)", () => {
    const wrap = (inner: string) => `<div data-type="document">${inner}</div>`;

    // The gate treats `**bold**`, `*italic*` and `` `code` `` as supported
    // constructs, so the renderer has to emit the tags the projection maps
    // back (see the canonical mark→tag pair in note-document-native.ts).
    // Emitting the escaped delimiters instead would make the gate's promise
    // a lie: the note would be created carrying literal asterisks.
    it("renders bold as the tag the projection reads back", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("a **bold** word");
      expect(encoded.data).toBe(wrap("<p>a <strong>bold</strong> word</p>"));
    });

    it("renders italic as the tag the projection reads back", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("a *slanted* word");
      expect(encoded.data).toBe(wrap("<p>a <em>slanted</em> word</p>"));
    });

    it("renders code as the tag the projection reads back", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("call `now()` here");
      expect(encoded.data).toBe(wrap("<p>call <code>now()</code> here</p>"));
    });

    it("leaves emphasis markers inside a code span literal", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("`a *b* c`");
      expect(encoded.data).toBe(wrap("<p><code>a *b* c</code></p>"));
    });

    it("still escapes text that is not an inline mark", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("a & b");
      expect(encoded.data).toBe(wrap("<p>a &amp; b</p>"));
    });

    it("renders marks inside list items and checklist items", () => {
      const list = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- **bold** item");
      expect(list.data).toBe(wrap("<ul><li><strong>bold</strong> item</li></ul>"));

      const checklist = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- [x] **bold** done");
      expect(checklist.data).toContain("<strong>bold</strong> done");
    });

    // An asterisk that opens or closes onto whitespace is not emphasis:
    // `2 * 3 * 4` is arithmetic and `a ** b ** c` is prose.  Detection and
    // rendering share one pattern so the gate cannot accept a mark the
    // renderer would leave literal.
    it("leaves space-flanked asterisks literal", () => {
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("2 * 3 * 4").data).toBe(
        wrap("<p>2 * 3 * 4</p>"),
      );
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("a ** b ** c").data).toBe(
        wrap("<p>a ** b ** c</p>"),
      );
      expect(detectMarkdownConstructs("2 * 3 * 4", MAX_BYTES)).not.toContain("inline-italic");
      expect(detectMarkdownConstructs("a ** b ** c", MAX_BYTES)).not.toContain("inline-bold");
      expect(detectMarkdownConstructs("*slanted*", MAX_BYTES)).toContain("inline-italic");
    });

    it("lets emphasis wrap a code span", () => {
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("a *`code`* b").data).toBe(
        wrap("<p>a <em><code>code</code></em> b</p>"),
      );
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("a **`code`** b").data).toBe(
        wrap("<p>a <strong><code>code</code></strong> b</p>"),
      );
    });
  });

  describe("nested ordinary-list codec fidelity", () => {
    const wrap = (inner: string) => `<div data-type="document">${inner}</div>`;
    const binding = { noteId: "fixture-note", revision: "fixture-revision" };
    const NESTED = "- parent\n  - child";

    it("accepts a nested unordered list instead of refusing the block", () => {
      expect(detectMarkdownConstructs(NESTED, MAX_BYTES)).toEqual(
        new Set(["nested-unordered-list"]),
      );
      expect(() => assertSupportedConstructs(NESTED, MAX_BYTES)).not.toThrow();
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("nested-unordered-list")).toBe(true);
    });

    it("encodes a nested unordered list as a nested tree with <p> item payloads", () => {
      // The <p> payload is load-bearing: the native decoder only descends into
      // an item's nested blocks when the first child is a <p>.  A bare-label
      // nested item decodes through the legacy inline path, which cannot
      // represent the child list at all.
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(NESTED).data).toBe(
        wrap("<ul><li><p>parent</p><ul><li><p>child</p></li></ul></li></ul>"),
      );
    });

    it("keeps a flat ordered list as a native <ol> tree", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("1. one\n2. two");
      expect(encoded.data).toBe(
        '<div data-type="document"><ol><li><p>one</p></li><li><p>two</p></li></ol></div>',
      );
    });

    it("supports the common three-space indentation for nested ordered lists", () => {
      const markdown = "1. parent\n   1. child";
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown).data).toBe(
        '<div data-type="document"><ol><li><p>parent</p><ol><li><p>child</p></li></ol></li></ol></div>',
      );
    });

    it("renders nested ordered lists structurally and escapes item text", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(
        "1. parent\n  1. <child>\n  2. sibling\n2. final",
      );
      expect(encoded.data).toBe(
        '<div data-type="document"><ol><li><p>parent</p><ol><li><p>&lt;child&gt;</p></li><li><p>sibling</p></li></ol></li><li><p>final</p></li></ol></div>',
      );
    });

    it("refuses mixed ordered and unordered list blocks rather than downgrading", () => {
      expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("1. ordered\n- bullet")).toThrow();
      expect(() => assertSupportedConstructs("1. ordered\n- bullet", MAX_BYTES)).toThrow();
    });

    it.each(["- parent\n  1. child", "1. parent\n  - child"])(
      "refuses mixed nested list blocks before mutation: %s",
      (markdown) => {
        expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown)).toThrow();
        expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).toThrow();
      },
    );

    it("refuses an inconsistent nested marker without a deeper-list boundary", () => {
      const markdown = "1. parent\n  3. first child\n  7. second child";
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).toThrow();
      expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown)).toThrow();
    });

    it("refuses a repeated root marker without a nested-list boundary", () => {
      const markdown = "1. first\n2. second\n1. restarted";
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).toThrow();
      expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown)).toThrow();
    });

    it.each(["1. root\n  1. child\n   2. mixed", "1. root\n   1. child\n     2. mixed"])(
      "refuses mixed ordered-list indentation: %s",
      (markdown) => {
        expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).toThrow();
        expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown)).toThrow();
      },
    );

    it("preserves existing flat unordered-list and task-list rendering", () => {
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- one\n- two").data).toContain(
        "<ul><li>one</li><li>two</li></ul>",
      );
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- [x] done").data).toContain(
        '<ul class="simple-checklist"><li class="checked simple-checklist--item"><p>done</p></li></ul>',
      );
    });

    it("renders nested ordered lists through the native decoder", () => {
      const markdown = "1. parent\n  1. child";
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      const decoded = decodeNoteDocumentNative({ type: encoded.type, data: encoded.data }, binding);
      expect(decoded.document.blocks).toEqual([
        {
          type: "ordered-list",
          items: [
            {
              inlines: [{ text: "parent" }],
              blocks: [{ type: "ordered-list", items: [{ inlines: [{ text: "child" }] }] }],
            },
          ],
        },
      ]);
      expect(serializeNoteDocumentMarkdown(decoded.document)).toContain("1. parent\n  1. child");
    });

    it("encodes three unordered nesting levels", () => {
      expect(DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("- a\n  - b\n    - c").data).toBe(
        wrap("<ul><li><p>a</p><ul><li><p>b</p><ul><li><p>c</p></li></ul></li></ul></li></ul>"),
      );
    });

    it("round-trips a nested unordered list through the canonical document grammar", () => {
      const markdown = `${NOTE_DOCUMENT_MARKDOWN_HEADER}\n${NESTED}\n`;
      expect(serializeNoteDocumentMarkdown(parseNoteDocumentMarkdown(markdown))).toBe(markdown);
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(NESTED);
      const decoded = decodeNoteDocumentNative({ type: encoded.type, data: encoded.data }, binding);
      expect(serializeNoteDocumentMarkdown(decoded.document)).toBe(markdown);
    });

    it("detects flat and nested ordered lists as supported constructs", () => {
      expect(detectMarkdownConstructs("1. first\n2. second", MAX_BYTES)).toEqual(
        new Set(["ordered-list"]),
      );
      expect(detectMarkdownConstructs("1. parent\n  1. child", MAX_BYTES)).toEqual(
        new Set(["nested-ordered-list"]),
      );
      expect(() => assertSupportedConstructs("1. first\n2. second", MAX_BYTES)).not.toThrow();
      expect(() => assertSupportedConstructs("1. parent\n  1. child", MAX_BYTES)).not.toThrow();
    });

    it("refuses a root marker restart after a nested list", () => {
      const markdown = "1. first root\n  1. first child\n1. second root\n  1. second child";
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).toThrow();
      expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown)).toThrow();
    });

    it("preserves independent nested starts for separate parent items", () => {
      const markdown = "1. first root\n  1. first child\n2. second root\n  3. second child";
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      expect(encoded.data).toContain(
        "<li><p>first root</p><ol><li><p>first child</p></li></ol></li>",
      );
      expect(encoded.data).toContain(
        '<li><p>second root</p><ol start="3"><li><p>second child</p></li></ol></li>',
      );
    });

    it("preserves a separate nested ordered-list boundary after a deeper child", () => {
      const markdown = "1. parent\n  1. first child\n    1. grandchild\n  3. second nested list";
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      expect(encoded.data).toContain('<ol start="3"><li><p>second nested list</p></li></ol>');
    });

    it("preserves arbitrary ordered-list starts through native HTML and Markdown projection", () => {
      const markdown = "3. starts at three\n4. continues\n  7. nested starts at seven";
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).not.toThrow();
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown);
      expect(encoded.data).toContain('<ol start="3">');
      expect(encoded.data).toContain('<ol start="7">');
      const decoded = decodeNoteDocumentNative(encoded, binding);
      expect(decoded.document.blocks).toEqual([
        {
          type: "ordered-list",
          start: 3,
          items: [
            { inlines: [{ text: "starts at three" }] },
            {
              inlines: [{ text: "continues" }],
              blocks: [
                {
                  type: "ordered-list",
                  start: 7,
                  items: [{ inlines: [{ text: "nested starts at seven" }] }],
                },
              ],
            },
          ],
        },
      ]);
      expect(serializeNoteDocumentMarkdown(decoded.document)).toContain(
        "3. starts at three\n4. continues\n  7. nested starts at seven",
      );
    });

    it("refuses an ordered-list sequence that overflows safe integer markers", () => {
      expect(() =>
        serializeNoteDocumentMarkdown({
          version: 1,
          blocks: [
            {
              type: "ordered-list",
              start: Number.MAX_SAFE_INTEGER,
              items: [{ inlines: [{ text: "last safe" }] }, { inlines: [{ text: "overflow" }] }],
            },
          ],
        }),
      ).toThrow();
    });

    it.each([
      "1. parent\n   1. child\n  2. mixed indentation",
      "1. parent\n     1. partial indentation",
      "  1. indented root",
      "1. parent\n      1. skipped nesting level",
    ])("refuses malformed ordered-list indentation instead of guessing: %s", (markdown) => {
      expect(() => assertSupportedConstructs(markdown, MAX_BYTES)).toThrow();
      expect(() => DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown(markdown)).toThrow();
    });
  });
});
