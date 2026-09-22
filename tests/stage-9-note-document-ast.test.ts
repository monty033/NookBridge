/**
 * T01 — native-preserving `NoteDocumentV1` AST and strict validation.
 *
 * The plan spec (`docs/implementation-plan-v1.5.md` §13.18/§13.19 + T00
 * in `.hermes/plans/2026-09-18-notes-features-complete-v3.md`) names the
 * canonical, versioned, daemon-owned editor document.  This file is the
 * failing-test-first coverage for the schema + structural validation
 * slice that T01 owns; serialization (T02/T03) is intentionally NOT
 * covered here.
 *
 * Covered surfaces:
 *   - versioned document shape with a closed `version: 1` discriminator;
 *   - headings, paragraphs, bullet/ordered lists, task lists, blockquotes,
 *     code blocks, tables, callouts, opaque nodes;
 *   - per-list intent (T00 D6): a single document carries both
 *     `simple-checklist` and `task-list` blocks; legacy `listKind`
 *     remains the default at the boundary;
 *   - block-capable list items with nested task children;
 *   - inline marks (bold, italic, underline, strike, code, link);
 *   - daemon-side opaque-reference sentinel TYPES (T00 D7): short,
 *     versioned, opaque to body/title/id/token bytes; NO opaque payload
 *     fields in T01 (T02/T03 own payload handling);
 *   - strict depth / item-count / byte budgets;
 *   - hostile-object rejection (prototype pollution, cyclic objects,
 *     mismatched discriminators, non-finite numbers, etc.);
 *   - closed categorical error vocabulary surfaced by `validate*`
 *     predicates via identity-tagged error instances.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTE_DOCUMENT_LIST_KIND,
  MAX_NOTE_DOCUMENT_BLOCK_BYTES,
  MAX_NOTE_DOCUMENT_BLOCKS,
  MAX_NOTE_DOCUMENT_DEPTH,
  MAX_NOTE_DOCUMENT_INLINE_BYTES,
  MAX_NOTE_DOCUMENT_INLINES_PER_BLOCK,
  MAX_NOTE_DOCUMENT_LIST_ITEMS_PER_LIST,
  MAX_NOTE_DOCUMENT_OPAQUE_SENTINEL_BYTES,
  MAX_NOTE_DOCUMENT_TASK_CHILDREN,
  NOTE_DOCUMENT_LIST_KINDS,
  NOTE_DOCUMENT_VERSION,
  NoteDocumentError,
  isNoteDocumentError,
  normaliseNoteDocumentListKind,
  validateNoteDocument,
} from "../src/core/note-document.js";
import type {
  NoteBlock,
  NoteCalloutBlock,
  NoteCodeBlock,
  NoteDocumentErrorCode,
  NoteDocumentV1,
  NoteHeadingBlock,
  NoteInline,
  NoteListItem,
  NoteListKind,
  NoteOpaqueBlock,
  NoteOpaqueSentinel,
  NoteOpaqueSentinelSource,
  NoteParagraphBlock,
  NoteTableBlock,
  NoteTaskItem,
  NoteTaskListBlock,
} from "../src/core/note-document.js";

// ---------------------------------------------------------------------------
// Small fixture builders used across multiple `describe` blocks.
// ---------------------------------------------------------------------------

const PARA = (text: string): NoteParagraphBlock => ({
  type: "paragraph",
  inlines: [{ text }],
});

const HEADING = (level: 1 | 2 | 3, text: string): NoteHeadingBlock => ({
  type: "heading",
  level,
  inlines: [{ text }],
});

function emptyDocument(): NoteDocumentV1 {
  return { version: NOTE_DOCUMENT_VERSION, blocks: [] };
}

function paragraphDocument(text: string): NoteDocumentV1 {
  return { version: NOTE_DOCUMENT_VERSION, blocks: [PARA(text)] };
}

// ---------------------------------------------------------------------------
// Version + closed surface.
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — version + closed surface", () => {
  it("publishes the frozen version literal as a numeric constant", () => {
    expect(NOTE_DOCUMENT_VERSION).toBe(1);
  });

  it("accepts an empty document with no blocks", () => {
    expect(() => validateNoteDocument(emptyDocument())).not.toThrow();
  });

  it("accepts a minimal paragraph document", () => {
    expect(() => validateNoteDocument(paragraphDocument("hello"))).not.toThrow();
  });

  it("rejects a document whose version is not the frozen literal", () => {
    // The literal `1` is the only legal version in v1; any other integer
    // is a structural refusal so a future migration can be explicit.
    expect(() =>
      validateNoteDocument({ version: 2, blocks: [] } as unknown as NoteDocumentV1),
    ).toThrow(NoteDocumentError);
    expect(() =>
      validateNoteDocument({ version: 0, blocks: [] } as unknown as NoteDocumentV1),
    ).toThrow(NoteDocumentError);
  });

  it("rejects documents with non-array `blocks` field", () => {
    expect(() =>
      validateNoteDocument({ version: 1, blocks: "nope" } as unknown as NoteDocumentV1),
    ).toThrow(NoteDocumentError);
    expect(() => validateNoteDocument({ version: 1 } as unknown as NoteDocumentV1)).toThrow(
      NoteDocumentError,
    );
  });
});

// ---------------------------------------------------------------------------
// Block-type surface.
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — block-type surface", () => {
  it("accepts headings at levels 1, 2, and 3", () => {
    expect(() =>
      validateNoteDocument({
        version: NOTE_DOCUMENT_VERSION,
        blocks: [HEADING(1, "Alpha"), HEADING(2, "Beta"), HEADING(3, "Gamma")],
      }),
    ).not.toThrow();
  });

  it("rejects headings outside the 1..3 closed range", () => {
    expect(() =>
      validateNoteDocument({
        version: NOTE_DOCUMENT_VERSION,
        blocks: [HEADING(4 as unknown as 1, "Too deep")],
      }),
    ).toThrow(NoteDocumentError);
    expect(() =>
      validateNoteDocument({
        version: NOTE_DOCUMENT_VERSION,
        blocks: [HEADING(0 as unknown as 1, "Negative")],
      }),
    ).toThrow(NoteDocumentError);
  });

  it("accepts paragraph + heading + lists + blockquote + code-block in one doc", () => {
    const doc: NoteDocumentV1 = {
      version: NOTE_DOCUMENT_VERSION,
      blocks: [
        HEADING(1, "Title"),
        PARA("intro"),
        { type: "bullet-list", items: [{ inlines: [{ text: "a" }] }] },
        { type: "ordered-list", items: [{ inlines: [{ text: "b" }] }] },
        { type: "blockquote", blocks: [PARA("quoted")] },
        { type: "code-block", language: "ts", text: "const x = 1;" },
      ],
    };
    expect(() => validateNoteDocument(doc)).not.toThrow();
  });

  it("rejects a bullet-list item with an unknown shape", () => {
    expect(() =>
      validateNoteDocument({
        version: NOTE_DOCUMENT_VERSION,
        blocks: [
          {
            type: "bullet-list",
            items: [{ notInlines: "boom" } as unknown as NoteListItem],
          },
        ],
      }),
    ).toThrow(NoteDocumentError);
  });

  it("accepts tables with closed shape (string[] columns, string[][] rows)", () => {
    const table: NoteTableBlock = {
      type: "table",
      columns: ["A", "B"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    };
    expect(() =>
      validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [table] }),
    ).not.toThrow();
  });

  it("rejects a table whose row has a different column count", () => {
    const table = {
      type: "table",
      columns: ["A", "B"],
      rows: [["1", "2"], ["only-one"]],
    } as unknown as NoteBlock;
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [table] })).toThrow(
      NoteDocumentError,
    );
  });

  it("accepts callouts in the four closed variants", () => {
    for (const variant of ["info", "warning", "success", "danger"] as const) {
      const callout: NoteCalloutBlock = {
        type: "callout",
        variant,
        blocks: [PARA("body")],
      };
      expect(() =>
        validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [callout] }),
      ).not.toThrow();
    }
  });

  it("rejects callouts with variants outside the closed set", () => {
    const bad = {
      type: "callout",
      variant: "neon",
      blocks: [PARA("body")],
    } as unknown as NoteBlock;
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [bad] })).toThrow(
      NoteDocumentError,
    );
  });

  it("accepts a code block without a language", () => {
    const cb: NoteCodeBlock = { type: "code-block", text: "raw" };
    expect(() =>
      validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [cb] }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Inline marks.
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — inline marks", () => {
  it("accepts text inlines with the closed mark set", () => {
    const doc: NoteDocumentV1 = {
      version: NOTE_DOCUMENT_VERSION,
      blocks: [
        {
          type: "paragraph",
          inlines: [
            { text: "plain " },
            { text: "bold", marks: ["bold"] },
            { text: " code ", marks: ["code"] },
            { text: "linked", marks: [{ type: "link", href: "https://example.com" }] },
          ],
        },
      ],
    };
    expect(() => validateNoteDocument(doc)).not.toThrow();
  });

  it("rejects an inline mark outside the closed set", () => {
    const doc = {
      version: NOTE_DOCUMENT_VERSION,
      blocks: [
        {
          type: "paragraph",
          inlines: [{ text: "x", marks: ["highlight"] }],
        },
      ],
    } as unknown as NoteDocumentV1;
    expect(() => validateNoteDocument(doc)).toThrow(NoteDocumentError);
  });

  it("rejects a link mark whose href is not a string", () => {
    const doc = {
      version: NOTE_DOCUMENT_VERSION,
      blocks: [
        {
          type: "paragraph",
          inlines: [{ text: "x", marks: [{ type: "link", href: 7 }] }],
        },
      ],
    } as unknown as NoteDocumentV1;
    expect(() => validateNoteDocument(doc)).toThrow(NoteDocumentError);
  });

  it("rejects an inline whose `text` is not a string", () => {
    const doc = {
      version: NOTE_DOCUMENT_VERSION,
      blocks: [
        {
          type: "paragraph",
          inlines: [{ text: 42 }],
        },
      ],
    } as unknown as NoteDocumentV1;
    expect(() => validateNoteDocument(doc)).toThrow(NoteDocumentError);
  });
});

// ---------------------------------------------------------------------------
// Per-list intent (T00 D6).
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — per-list intent (D6)", () => {
  it("exposes the closed list-kind set with a frozen default", () => {
    expect(new Set(NOTE_DOCUMENT_LIST_KINDS)).toEqual(
      new Set<NoteListKind>(["simple-checklist", "task-list"]),
    );
    expect(DEFAULT_NOTE_DOCUMENT_LIST_KIND).toBe("simple-checklist");
  });

  it("normalises an undefined list-kind to the legacy default", () => {
    expect(normaliseNoteDocumentListKind(undefined)).toBe("simple-checklist");
  });

  it("normalises a recognised list-kind to itself", () => {
    expect(normaliseNoteDocumentListKind("task-list")).toBe("task-list");
    expect(normaliseNoteDocumentListKind("simple-checklist")).toBe("simple-checklist");
  });

  it("refuses a list-kind outside the closed set", () => {
    expect(() => normaliseNoteDocumentListKind("bullet")).toThrow(NoteDocumentError);
    expect(() => normaliseNoteDocumentListKind("")).toThrow(NoteDocumentError);
  });

  it("accepts a single document that mixes `simple-checklist` and `task-list` blocks", () => {
    const taskItems: NoteTaskItem[] = [
      {
        checked: false,
        inlines: [{ text: "task parent" }],
        children: [{ checked: true, inlines: [{ text: "task child" }], children: [] }],
      },
    ];
    const doc: NoteDocumentV1 = {
      version: NOTE_DOCUMENT_VERSION,
      blocks: [
        {
          type: "task-list",
          kind: "simple-checklist",
          items: [{ checked: false, inlines: [{ text: "simple item" }], children: [] }],
        } satisfies NoteTaskListBlock,
        {
          type: "task-list",
          kind: "task-list",
          items: taskItems,
        } satisfies NoteTaskListBlock,
      ],
    };
    expect(() => validateNoteDocument(doc)).not.toThrow();
  });

  it("defaults a task-list block's kind to the legacy default when omitted", () => {
    const doc: NoteDocumentV1 = {
      version: NOTE_DOCUMENT_VERSION,
      blocks: [
        {
          type: "task-list",
          items: [{ checked: false, inlines: [{ text: "x" }], children: [] }],
        },
      ],
    };
    expect(() => validateNoteDocument(doc)).not.toThrow();
  });

  it("rejects a task-list block whose kind is outside the closed set", () => {
    const doc = {
      version: NOTE_DOCUMENT_VERSION,
      blocks: [
        {
          type: "task-list",
          kind: "fancy-list",
          items: [],
        },
      ],
    } as unknown as NoteDocumentV1;
    expect(() => validateNoteDocument(doc)).toThrow(NoteDocumentError);
  });
});

// ---------------------------------------------------------------------------
// Block-capable list items with nested task children (T01 brief).
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — block-capable list items", () => {
  it("accepts list items that carry nested task children inside the same item", () => {
    const item: NoteListItem = {
      inlines: [{ text: "parent" }],
      blocks: [
        PARA("continuation paragraph"),
        {
          type: "task-list",
          items: [{ checked: true, inlines: [{ text: "child" }], children: [] }],
        },
      ],
    };
    expect(() =>
      validateNoteDocument({
        version: NOTE_DOCUMENT_VERSION,
        blocks: [{ type: "bullet-list", items: [item] }],
      }),
    ).not.toThrow();
  });

  it("accepts nested task-list items three levels deep", () => {
    const deep: NoteTaskItem = {
      checked: false,
      inlines: [{ text: "deep" }],
      children: [],
    };
    const mid: NoteTaskItem = {
      checked: false,
      inlines: [{ text: "mid" }],
      children: [deep],
    };
    const top: NoteTaskItem = {
      checked: false,
      inlines: [{ text: "top" }],
      children: [mid],
    };
    expect(() =>
      validateNoteDocument({
        version: NOTE_DOCUMENT_VERSION,
        blocks: [{ type: "task-list", items: [top] }],
      }),
    ).not.toThrow();
  });

  it("rejects a task-list item whose `checked` field is missing", () => {
    const bad = {
      type: "task-list",
      items: [{ inlines: [{ text: "x" }], children: [] }],
    } as unknown as NoteBlock;
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [bad] })).toThrow(
      NoteDocumentError,
    );
  });
});

// ---------------------------------------------------------------------------
// Opaque-reference sentinel TYPES (T00 D7) — no opaque payload bytes in T01.
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — opaque-reference sentinel types", () => {
  it("accepts a sentinel that matches the closed shape", () => {
    const sentinel: NoteOpaqueSentinel = {
      version: 1,
      token: "a1b2c3d4",
      source: "native-html" as NoteOpaqueSentinelSource,
    };
    expect(sentinel.version).toBe(1);
    expect(typeof sentinel.token).toBe("string");
  });

  it("accepts an `opaque` block carrying a sentinel of the closed shape", () => {
    const block: NoteOpaqueBlock = {
      type: "opaque",
      nodeType: "native:tiptap:unknown",
      sentinel: {
        version: 1,
        token: "deadbeef",
        source: "native-tiptap",
      },
    };
    expect(() =>
      validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [block] }),
    ).not.toThrow();
  });

  it("rejects an `opaque` block that smuggles an opaque payload field", () => {
    // Per T00 D7, T01 defines the SENTINEL TYPE only — no opaque payload
    // bytes are admitted on the editor document.  A future T02/T03 may
    // admit bounded payloads under a different surface; T01 forbids it.
    const bad = {
      type: "opaque",
      nodeType: "native:tiptap:unknown",
      sentinel: {
        version: 1,
        token: "ok",
        source: "native-tiptap",
        payload: { hostile: true },
      },
    } as unknown as NoteBlock;
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [bad] })).toThrow(
      NoteDocumentError,
    );
  });

  it("rejects an opaque block whose sentinel token is too long", () => {
    const oversized = "x".repeat(MAX_NOTE_DOCUMENT_OPAQUE_SENTINEL_BYTES + 1);
    const bad = {
      type: "opaque",
      nodeType: "native:tiptap:unknown",
      sentinel: { version: 1, token: oversized, source: "native-tiptap" },
    } as unknown as NoteBlock;
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [bad] })).toThrow(
      NoteDocumentError,
    );
  });
});

// ---------------------------------------------------------------------------
// Strict resource bounds.
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — resource bounds", () => {
  it("rejects a document with more blocks than the cap", () => {
    const blocks: NoteParagraphBlock[] = Array.from({ length: MAX_NOTE_DOCUMENT_BLOCKS + 1 }, () =>
      PARA("x"),
    );
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks })).toThrow(
      NoteDocumentError,
    );
  });

  it("rejects a block whose serialised byte size exceeds the cap", () => {
    const longText = "a".repeat(MAX_NOTE_DOCUMENT_BLOCK_BYTES + 1);
    expect(() =>
      validateNoteDocument({
        version: NOTE_DOCUMENT_VERSION,
        blocks: [PARA(longText)],
      }),
    ).toThrow(NoteDocumentError);
  });

  it("rejects nested lists deeper than the depth cap", () => {
    // Build a bullet-list nested MAX_NOTE_DOCUMENT_DEPTH levels deep.
    let inner: NoteBlock = PARA("leaf");
    for (let i = 0; i < MAX_NOTE_DOCUMENT_DEPTH + 1; i += 1) {
      inner = {
        type: "bullet-list",
        items: [{ inlines: [{ text: `lvl-${i}` }], blocks: [inner] }],
      };
    }
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [inner] })).toThrow(
      NoteDocumentError,
    );
  });

  it("rejects a paragraph with too many inlines", () => {
    const inlines: NoteInline[] = Array.from(
      { length: MAX_NOTE_DOCUMENT_INLINES_PER_BLOCK + 1 },
      (_, i) => ({ text: `t-${i}` }),
    );
    const bad = {
      type: "paragraph",
      inlines,
    } as unknown as NoteBlock;
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [bad] })).toThrow(
      NoteDocumentError,
    );
  });

  it("rejects a list with too many items", () => {
    const items = Array.from({ length: MAX_NOTE_DOCUMENT_LIST_ITEMS_PER_LIST + 1 }, (_, i) => ({
      inlines: [{ text: `i-${i}` }],
    }));
    const bad = {
      type: "bullet-list",
      items,
    } as unknown as NoteBlock;
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [bad] })).toThrow(
      NoteDocumentError,
    );
  });

  it("rejects a task-list item with too many children", () => {
    const children = Array.from({ length: MAX_NOTE_DOCUMENT_TASK_CHILDREN + 1 }, (_, i) => ({
      checked: false,
      inlines: [{ text: `c-${i}` }],
      children: [],
    }));
    const bad = {
      type: "task-list",
      items: [{ checked: false, inlines: [{ text: "p" }], children }],
    } as unknown as NoteBlock;
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [bad] })).toThrow(
      NoteDocumentError,
    );
  });

  it("rejects an inline whose text exceeds the inline byte cap", () => {
    const huge = "x".repeat(MAX_NOTE_DOCUMENT_INLINE_BYTES + 1);
    const bad = {
      type: "paragraph",
      inlines: [{ text: huge }],
    } as unknown as NoteBlock;
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [bad] })).toThrow(
      NoteDocumentError,
    );
  });
});

// ---------------------------------------------------------------------------
// Hostile-object rejection.
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — hostile-object rejection", () => {
  it("rejects a document carrying prototype-polluting keys", () => {
    const hostile = JSON.parse(
      '{"version":1,"blocks":[],"__proto__":{"polluted":true}}',
    ) as unknown as NoteDocumentV1;
    expect(() => validateNoteDocument(hostile)).toThrow(NoteDocumentError);
  });

  it("rejects a block with a mismatched discriminator", () => {
    const bad = {
      type: "fancy-paragraph",
      inlines: [],
    } as unknown as NoteBlock;
    expect(() => validateNoteDocument({ version: NOTE_DOCUMENT_VERSION, blocks: [bad] })).toThrow(
      NoteDocumentError,
    );
  });

  it("rejects null and primitive inputs as document", () => {
    expect(() => validateNoteDocument(null as unknown as NoteDocumentV1)).toThrow(
      NoteDocumentError,
    );
    expect(() => validateNoteDocument("hello" as unknown as NoteDocumentV1)).toThrow(
      NoteDocumentError,
    );
    expect(() => validateNoteDocument(42 as unknown as NoteDocumentV1)).toThrow(NoteDocumentError);
  });

  it("rejects a non-finite number in numeric fields (heading level)", () => {
    const bad = {
      version: NOTE_DOCUMENT_VERSION,
      blocks: [{ type: "heading", level: Number.POSITIVE_INFINITY, inlines: [] }],
    } as unknown as NoteDocumentV1;
    expect(() => validateNoteDocument(bad)).toThrow(NoteDocumentError);
  });
});

// ---------------------------------------------------------------------------
// Closed categorical error vocabulary.
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — closed categorical errors", () => {
  it("publishes a closed categorical error code vocabulary", () => {
    const codes: ReadonlyArray<NoteDocumentErrorCode> = [
      "invalid_shape",
      "oversize_document",
      "oversize_block",
      "oversize_inline",
      "oversize_sentinel",
      "depth_exceeded",
      "unsupported_node",
      "unsupported_list_kind",
      "unsupported_mark",
      "unsupported_callout_variant",
      "opaque_payload_forbidden",
      "malformed_link",
      "table_column_mismatch",
    ];
    for (const code of codes) {
      // Smoke-check that every published code is a non-empty string.
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
    }
  });

  it("attaches a stable categorical code and refuses to leak input bytes", () => {
    const canary = "TOPSECRET-canary-string-that-must-not-leak-zzzz";
    let captured: unknown;
    try {
      validateNoteDocument({
        version: NOTE_DOCUMENT_VERSION,
        blocks: [
          {
            type: "paragraph",
            inlines: [{ text: canary }],
          },
        ],
      });
      // Force a failure case
      validateNoteDocument({
        version: NOTE_DOCUMENT_VERSION,
        blocks: [{ type: "paragraph", inlines: [{ text: 9 }] } as unknown as NoteBlock],
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(NoteDocumentError);
    const err = captured as NoteDocumentError;
    expect(isNoteDocumentError(err)).toBe(true);
    expect(err.code).toBe("invalid_shape");
    // The canary bytes must not appear in the error message.
    expect(err.message.includes(canary)).toBe(false);
    // The error must not chain a `cause` carrying caller-controlled data.
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Determinism — equivalent ASTs validate equivalently.
// ---------------------------------------------------------------------------

describe("NoteDocumentV1 — determinism", () => {
  it("validates the same way for two structurally identical ASTs", () => {
    const build = () => ({
      version: NOTE_DOCUMENT_VERSION,
      blocks: [
        HEADING(1, "Title"),
        PARA("intro"),
        {
          type: "bullet-list",
          items: [{ inlines: [{ text: "a" }] }],
        },
      ],
    });
    expect(() => validateNoteDocument(build())).not.toThrow();
    expect(() => validateNoteDocument(build())).not.toThrow();
  });
});
