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
        "link-or-image",
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

    it("refuses a Markdown table", () => {
      expect(() =>
        assertSupportedConstructs("| a | b |\n| - | - |\n| 1 | 2 |", MAX_BYTES),
      ).toThrow();
    });

    it("accepts a task list", () => {
      expect(() => assertSupportedConstructs("- [ ] todo", MAX_BYTES)).not.toThrow();
      expect(() => assertSupportedConstructs("- [x] done", MAX_BYTES)).not.toThrow();
    });

    it("refuses an attachment reference", () => {
      expect(() => assertSupportedConstructs("![[photo.png]]", MAX_BYTES)).toThrow();
    });

    it("refuses a fenced code block", () => {
      expect(() => assertSupportedConstructs("```\nsome code\n```", MAX_BYTES)).toThrow();
    });

    it("refuses a link", () => {
      expect(() => assertSupportedConstructs("[label](https://example.com)", MAX_BYTES)).toThrow();
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
});
