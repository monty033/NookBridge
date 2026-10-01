/**
 * T01 Task 1.1 — new `NoteDocumentV1` block types (native block parity).
 *
 * Plan: `.hermes/plans/2026-09-26_130730-notesnook-native-block-parity.md`
 * Phase 1, Task 1.1.  This file is scoped ONLY to the newly-added block
 * discriminators and their validators:
 *   - `horizontal-rule` — no attributes, a plain structural divider;
 *   - `image` / `attachment` / `embed` — structured reference nodes
 *     with a closed attribute set, bounded byte caps, and a strict
 *     http(s)-only URL policy (no `file:`, `javascript:`, `data:`,
 *     credentials, or control bytes).
 *
 * `math` is intentionally NOT added: per the plan, Task 0.2 (native
 * runtime schema discovery against the pinned Notesnook/Tiptap runtime)
 * is an unmet prerequisite, and the plan explicitly forbids guessing a
 * shape from the mobile screenshot alone. See the end-of-file `describe`
 * block documenting that omission.
 *
 * The already-existing `table`, `callout`, `blockquote`, and
 * `code-block` node types are untouched by this file — they are
 * covered by `tests/stage-9-note-document-ast.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { serializeNoteDocumentNative } from "../src/core/note-document-native.js";

import {
  MAX_NOTE_DOCUMENT_REFERENCE_LABEL_BYTES,
  MAX_NOTE_DOCUMENT_REFERENCE_URL_BYTES,
  NOTE_DOCUMENT_VERSION,
  NoteDocumentError,
  validateNoteDocument,
} from "../src/core/note-document.js";
import type {
  NoteAttachmentBlock,
  NoteBlock,
  NoteDocumentV1,
  NoteEmbedBlock,
  NoteHorizontalRuleBlock,
  NoteImageBlock,
} from "../src/core/note-document.js";

function doc(blocks: readonly NoteBlock[]): NoteDocumentV1 {
  return { version: NOTE_DOCUMENT_VERSION, blocks };
}

function expectRejected(block: unknown): void {
  expect(() => validateNoteDocument(doc([block as NoteBlock]))).toThrow(NoteDocumentError);
}

function expectAccepted(block: NoteBlock): void {
  expect(() => validateNoteDocument(doc([block]))).not.toThrow();
}

// ---------------------------------------------------------------------------
// horizontal-rule
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — horizontal-rule block", () => {
  it("accepts the minimal shape", () => {
    const block: NoteHorizontalRuleBlock = { type: "horizontal-rule" };
    expectAccepted(block);
  });

  it("serializes the standard horizontal-rule node as native HTML", () => {
    expect(serializeNoteDocumentNative(doc([{ type: "horizontal-rule" }])).data).toContain("<hr ");
  });

  it("rejects an extra/unknown key", () => {
    expectRejected({ type: "horizontal-rule", style: "dashed" });
  });

  it("rejects non-enumerable and symbol keys", () => {
    expectRejected(
      Object.defineProperty({ type: "horizontal-rule" }, "hidden", { value: "payload" }),
    );
    expectRejected({ type: "horizontal-rule", [Symbol("hidden")]: "payload" });
  });

  it("rejects accessor fields without calling them", () => {
    let called = false;
    const block = Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        called = true;
        throw new Error("hostile getter");
      },
    });
    expectRejected(block);
    expect(called).toBe(false);
  });

  it("rejects a hostile object shape (array instead of object)", () => {
    expectRejected(["horizontal-rule"]);
  });

  it("rejects an oversized payload smuggled through an unknown key", () => {
    expectRejected({ type: "horizontal-rule", junk: "x".repeat(200_000) });
  });
});

// ---------------------------------------------------------------------------
// image
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — image block", () => {
  it("accepts a minimal https reference", () => {
    const block: NoteImageBlock = { type: "image", url: "https://example.com/a.png" };
    expectAccepted(block);
  });

  it("accepts an optional bounded alt", () => {
    const block: NoteImageBlock = {
      type: "image",
      url: "https://example.com/a.png",
      alt: "a diagram",
    };
    expectAccepted(block);
  });

  it("accepts http as well as https", () => {
    const block: NoteImageBlock = { type: "image", url: "http://example.com/a.png" };
    expectAccepted(block);
  });

  it("rejects a missing required url field", () => {
    expectRejected({ type: "image" });
  });

  it("rejects a non-string url", () => {
    expectRejected({ type: "image", url: 12345 });
  });

  it("rejects an array where a string url is expected", () => {
    expectRejected({ type: "image", url: ["https://example.com/a.png"] });
  });

  it("rejects an extra/unknown attribute key", () => {
    expectRejected({ type: "image", url: "https://example.com/a.png", srcset: "2x" });
  });

  it("rejects a file:// local-path URL", () => {
    expectRejected({ type: "image", url: "file:///etc/passwd" });
  });

  it("rejects a javascript: URL", () => {
    expectRejected({ type: "image", url: "javascript:alert(1)" });
  });

  it("rejects a data: URL", () => {
    expectRejected({
      type: "image",
      url: "data:image/png;base64,aGVsbG8=",
    });
  });

  it("rejects a bare filesystem path (no scheme, path traversal)", () => {
    expectRejected({ type: "image", url: "../../etc/passwd" });
  });

  it("rejects a URL carrying embedded credentials", () => {
    expectRejected({ type: "image", url: "https://user:pass@example.com/a.png" });
  });

  it("rejects a URL containing a control byte", () => {
    expectRejected({ type: "image", url: "https://example.com/a\u0000.png" });
  });

  it("rejects a URL containing a lone surrogate before URL normalisation", () => {
    expectRejected({ type: "image", url: "https://example.com/\ud800.png" });
  });

  it.each([
    { type: "image", url: "https://example.com/a.png", alt: "bad\u0000label" },
    {
      type: "attachment",
      url: "https://example.com/report.pdf",
      name: "bad\u007flabel",
    },
    {
      type: "attachment",
      url: "https://example.com/report.pdf",
      mime: "bad\ud800label",
    },
  ])("rejects control bytes and lone surrogates in reference labels: %o", (block) => {
    expectRejected(block);
  });

  it("rejects an oversized url beyond the reference URL byte cap", () => {
    const url = "https://example.com/" + "a".repeat(MAX_NOTE_DOCUMENT_REFERENCE_URL_BYTES);
    expectRejected({ type: "image", url });
  });

  it("rejects an oversized alt beyond the reference label byte cap", () => {
    expectRejected({
      type: "image",
      url: "https://example.com/a.png",
      alt: "a".repeat(MAX_NOTE_DOCUMENT_REFERENCE_LABEL_BYTES + 1),
    });
  });

  it("rejects a non-string alt", () => {
    expectRejected({ type: "image", url: "https://example.com/a.png", alt: 42 });
  });

  it("rejects a prototype-pollution-shaped payload", () => {
    expectRejected(
      JSON.parse('{"type":"image","url":"https://example.com/a.png","__proto__":{"x":1}}'),
    );
  });

  it("rejects a proxy before invoking its property traps", () => {
    let called = false;
    const block = new Proxy(
      { type: "image", url: "https://example.com/a.png" },
      {
        get(target, key, receiver) {
          called = true;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    expectRejected(block);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// attachment
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — attachment block", () => {
  it("accepts a minimal https reference", () => {
    const block: NoteAttachmentBlock = {
      type: "attachment",
      url: "https://example.com/report.pdf",
    };
    expectAccepted(block);
  });

  it("accepts optional bounded name and mime", () => {
    const block: NoteAttachmentBlock = {
      type: "attachment",
      url: "https://example.com/report.pdf",
      name: "report.pdf",
      mime: "application/pdf",
    };
    expectAccepted(block);
  });

  it("rejects a missing required url field", () => {
    expectRejected({ type: "attachment" });
  });

  it("rejects an extra/unknown attribute key", () => {
    expectRejected({
      type: "attachment",
      url: "https://example.com/report.pdf",
      sizeBytes: 12,
    });
  });

  it("rejects a file:// local-path URL", () => {
    expectRejected({ type: "attachment", url: "file:///home/user/secret.pdf" });
  });

  it("rejects a bare local filesystem path", () => {
    expectRejected({ type: "attachment", url: "/var/lib/hermes/secret.pdf" });
  });

  it("rejects a non-object hostile shape (string instead of object)", () => {
    expectRejected("attachment");
  });

  it("rejects an oversized name label", () => {
    expectRejected({
      type: "attachment",
      url: "https://example.com/report.pdf",
      name: "n".repeat(MAX_NOTE_DOCUMENT_REFERENCE_LABEL_BYTES + 1),
    });
  });

  it("rejects a non-string mime", () => {
    expectRejected({
      type: "attachment",
      url: "https://example.com/report.pdf",
      mime: { value: "application/pdf" },
    });
  });
});

// ---------------------------------------------------------------------------
// embed
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — embed block", () => {
  it("accepts a minimal https reference", () => {
    const block: NoteEmbedBlock = {
      type: "embed",
      url: "https://www.youtube.com/watch?v=abc123",
    };
    expectAccepted(block);
  });

  it("rejects an unverified provider variant", () => {
    expectRejected({
      type: "embed",
      url: "https://www.youtube.com/watch?v=abc123",
      provider: "youtube",
    });
  });

  it("rejects a missing required url field", () => {
    expectRejected({ type: "embed" });
  });

  it("rejects an extra/unknown attribute key (raw iframe smuggling attempt)", () => {
    expectRejected({
      type: "embed",
      url: "https://www.youtube.com/watch?v=abc123",
      html: "<iframe src='https://evil.example/'></iframe>",
    });
  });

  it("rejects a javascript: URL", () => {
    expectRejected({ type: "embed", url: "javascript:alert(document.cookie)" });
  });

  it("rejects an oversized provider label", () => {
    expectRejected({
      type: "embed",
      url: "https://www.youtube.com/watch?v=abc123",
      provider: "p".repeat(MAX_NOTE_DOCUMENT_REFERENCE_LABEL_BYTES + 1),
    });
  });

  it("rejects a non-string provider", () => {
    expectRejected({
      type: "embed",
      url: "https://www.youtube.com/watch?v=abc123",
      provider: ["youtube"],
    });
  });

  it("rejects a hostile null-prototype-evading shape via nested arrays", () => {
    expectRejected([{ type: "embed", url: "https://www.youtube.com/watch?v=abc123" }]);
  });
});

// ---------------------------------------------------------------------------
// math — explicitly NOT implemented (documented refusal, not a guess).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// math — explicitly NOT implemented (documented refusal, not a guess).
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — math block (unimplemented by design)", () => {
  it("has no native `math` discriminator: an attempted math block is unsupported_node", () => {
    // This asserts the current, honest state: Task 0.2 (pinned-runtime
    // schema discovery) has not happened, so no math shape has been
    // added. A `math` block is refused the same way any other unknown
    // discriminator is refused — it does NOT silently downgrade to a
    // paragraph, and it is NOT accepted with a guessed shape.
    expectRejected({ type: "math", tex: "E = mc^2", displayMode: true });
  });
});

describe("NoteDocumentV1 — hostile direct validator inputs", () => {
  it("does not invoke an inherited prototype accessor when a required field is absent", () => {
    let called = false;
    Object.defineProperty(Object.prototype, "version", {
      configurable: true,
      get() {
        called = true;
        throw new Error("CANARY");
      },
    });
    try {
      expect(() => validateNoteDocument({ blocks: [] })).toThrow(NoteDocumentError);
    } finally {
      Reflect.deleteProperty(Object.prototype, "version");
    }
    expect(called).toBe(false);
  });

  it("rejects prototype-named discriminators without leaking raw lookup errors", () => {
    expectRejected({ type: "constructor", inlines: [] });
    expectRejected(JSON.parse('{"type":"__proto__","inlines":[]}'));
  });

  it("rejects unknown fields at both block and inline levels", () => {
    expectRejected({ type: "paragraph", inlines: [], extra: "CANARY" });
    expectRejected({ type: "paragraph", inlines: [{ text: "hello", extra: "CANARY" }] });
  });

  it("refuses accessor properties without invoking them", () => {
    let called = false;
    const paragraph = { type: "paragraph" };
    Object.defineProperty(paragraph, "inlines", {
      enumerable: true,
      get() {
        called = true;
        throw new Error("CANARY");
      },
    });
    expectRejected(paragraph);
    expect(called).toBe(false);
  });

  it("refuses a proxied blocks array with a categorical error before reading it", () => {
    const blocks = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("CANARY");
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks })).toThrow(
      NoteDocumentError,
    );
  });

  it("refuses a cyclic unknown block field with a categorical error", () => {
    const paragraph: Record<string, unknown> = {
      type: "paragraph",
      inlines: [{ text: "hello" }],
    };
    paragraph.selfRef = paragraph;
    expectRejected(paragraph);
  });
});
