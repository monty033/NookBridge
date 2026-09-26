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

    it("refuses an attachment reference", () => {
      expect(() => assertSupportedConstructs("![[photo.png]]", MAX_BYTES)).toThrow();
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
      rendersTo("above\n---\nbelow", "<p>above</p><hr /><p>below</p>");
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

    it("renders a horizontal rule as <hr>", () => {
      const encoded = DETERMINISTIC_MARKDOWN_CODEC.encodeMarkdown("above\n\n---\n\nbelow");
      expect(encoded.data).toBe(wrap("<p>above</p><hr /><p>below</p>"));
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
});
