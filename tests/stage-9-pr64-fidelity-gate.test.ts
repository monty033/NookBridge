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
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("paragraph")).toBe(true);
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("inline-bold")).toBe(true);
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("inline-italic")).toBe(true);
      expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has("inline-code")).toBe(true);
    });

    it("does not include any construct the codec cannot round-trip", () => {
      for (const name of UNSUPPORTED_MARKDOWN_CONSTRUCTS) {
        expect(SUPPORTED_MARKDOWN_CONSTRUCTS.has(name as never)).toBe(false);
      }
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

    it("refuses a task list", () => {
      expect(() => assertSupportedConstructs("- [ ] todo", MAX_BYTES)).toThrow();
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
      expect(() =>
        assertSupportedConstructs("# Title\n\n- [ ] mixed-in task list", MAX_BYTES),
      ).toThrow();
    });
  });
});
