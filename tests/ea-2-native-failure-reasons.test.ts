/**
 * EA-2 — the closed, internal whole-document failure vocabulary.
 *
 * Every `fail("reason")` site in `src/core/note-document-native.ts` gets one
 * reason from the closed union and one fixture that reaches it. The last two
 * tests read the source and compare the literal reasons it contains with this
 * table, so adding a site without classifying it fails the suite.
 *
 * Why some rows are declared unreachable: after `validateNoteDocument` and
 * `canonicalRuns`, the serializer's duplicate-mark and unknown-mark guards
 * cannot be reached through any public input. They stay as defence-in-depth;
 * this table names them explicitly rather than pretending to exercise them.
 *
 * The source scan is not the only guard on the unclassified class: a separate
 * test injects a plain `throw` into the decode path and requires it to land in
 * `unclassified`, never in a preservable class.
 */

import { readFileSync } from "node:fs";
import { URL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  decodeNoteDocumentNative,
  MAX_NOTE_DOCUMENT_NATIVE_BYTES,
  NATIVE_FAILURE_REASONS,
  nativeFailureClass,
  NoteDocumentNativeError,
  serializeNoteDocumentNative,
  type NativeFailureClass,
  type NativeFailureReason,
  type NativeNoteBinding,
} from "../src/core/note-document-native.js";
import type { NoteDocumentV1 } from "../src/core/note-document.js";
import type * as NoteDocumentModule from "../src/core/note-document.js";
import type * as NoteDocumentNativeModule from "../src/core/note-document-native.js";

const BINDING: NativeNoteBinding = { noteId: "synthetic", revision: "rev_synthetic" };
const envelope = (data: string): unknown => ({ type: "tiptap", data });
const decode =
  (data: string, binding: unknown = BINDING) =>
  () =>
    decodeNoteDocumentNative(envelope(data), binding as NativeNoteBinding);

const OPAQUE = (token: string) =>
  ({
    type: "opaque",
    nodeType: "p",
    sentinel: { version: 1, source: "native-html", token },
  }) as const;

type Entry = {
  readonly reason: NativeFailureReason;
  readonly failureClass: NativeFailureClass;
  /** `null` means the site is defensive and not reachable from public input. */
  readonly exercise: (() => unknown) | null;
};

const TABLE: ReadonlyArray<Entry> = [
  {
    reason: "internal_failure",
    failureClass: "unclassified",
    // `new URL` throws a TypeError inside the decoder; `guard` classifies it.
    exercise: decode('<a href="http://[">x</a>'),
  },
  {
    reason: "document_bounds_exceeded",
    failureClass: "limit",
    // Under the native byte bound, over the validator's inline byte bound.
    exercise: decode(`<p>${"x".repeat(200_000)}</p>`),
  },
  {
    reason: "control_character",
    failureClass: "hostile",
    exercise: decode("<p>a\u0000b</p>"),
  },
  {
    reason: "crlf_line_ending",
    failureClass: "uninterpretable",
    exercise: decode("<p>a\r\nb</p>"),
  },
  {
    reason: "envelope_too_complex",
    failureClass: "limit",
    exercise: () => {
      let deep: unknown = {};
      for (let depth = 0; depth < 82; depth += 1) deep = { deep };
      return decodeNoteDocumentNative(envelope("<p>x</p>"), {
        noteId: deep,
        revision: "r",
      } as unknown as NativeNoteBinding);
    },
  },
  {
    reason: "envelope_too_large",
    failureClass: "limit",
    exercise: () =>
      decodeNoteDocumentNative(envelope("<p>x</p>"), {
        noteId: "x".repeat(MAX_NOTE_DOCUMENT_NATIVE_BYTES * 8 + 1),
        revision: "r",
      }),
  },
  {
    reason: "envelope_proxy",
    failureClass: "hostile",
    exercise: () =>
      decodeNoteDocumentNative(new Proxy({ type: "tiptap", data: "<p>x</p>" }, {}), BINDING),
  },
  {
    reason: "envelope_not_plain",
    failureClass: "uninterpretable",
    exercise: () => {
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      return decodeNoteDocumentNative(envelope("<p>x</p>"), {
        noteId: cycle,
        revision: "r",
      } as unknown as NativeNoteBinding);
    },
  },
  {
    reason: "envelope_bad_prototype",
    failureClass: "uninterpretable",
    exercise: () =>
      decodeNoteDocumentNative(envelope("<p>x</p>"), {
        noteId: new Date(),
        revision: "r",
      } as unknown as NativeNoteBinding),
  },
  {
    reason: "envelope_forbidden_key",
    failureClass: "hostile",
    exercise: () =>
      decodeNoteDocumentNative(
        JSON.parse('{"type":"tiptap","data":"<p>x</p>","__proto__":{"polluted":true}}'),
        BINDING,
      ),
  },
  {
    reason: "envelope_accessor",
    failureClass: "hostile",
    exercise: () => {
      const hostile = {
        type: "tiptap",
        get data(): string {
          return "<p>x</p>";
        },
      };
      return decodeNoteDocumentNative(hostile, BINDING);
    },
  },
  {
    reason: "envelope_non_index_key",
    failureClass: "uninterpretable",
    exercise: () => {
      const array = ["note-id"] as unknown as string[] & { extra?: number };
      array.extra = 1;
      return decodeNoteDocumentNative(envelope("<p>x</p>"), {
        noteId: array,
        revision: "r",
      } as unknown as NativeNoteBinding);
    },
  },
  {
    reason: "envelope_sparse_array",
    failureClass: "uninterpretable",
    exercise: () =>
      decodeNoteDocumentNative(envelope("<p>x</p>"), {
        noteId: new Array(2),
        revision: "r",
      } as unknown as NativeNoteBinding),
  },
  {
    reason: "envelope_not_record",
    failureClass: "unclassified",
    exercise: () =>
      decodeNoteDocumentNative(envelope("<p>x</p>"), [] as unknown as NativeNoteBinding),
  },
  {
    reason: "envelope_unexpected_field",
    failureClass: "uninterpretable",
    exercise: () =>
      decodeNoteDocumentNative(envelope("<p>x</p>"), {
        noteId: "n",
        revision: "r",
        extra: true,
      } as unknown as NativeNoteBinding),
  },
  {
    reason: "binding_invalid",
    failureClass: "uninterpretable",
    exercise: () => decodeNoteDocumentNative(envelope("<p>x</p>"), { noteId: "", revision: "r" }),
  },
  {
    reason: "document_too_large",
    failureClass: "limit",
    exercise: decode("x".repeat(MAX_NOTE_DOCUMENT_NATIVE_BYTES + 1)),
  },
  {
    reason: "url_not_permitted",
    failureClass: "hostile",
    exercise: decode('<a href="javascript:alert(1)">x</a>'),
  },
  {
    reason: "url_inert",
    failureClass: "uninterpretable",
    exercise: decode('<a href="tel:+15550100">x</a>'),
  },
  {
    reason: "url_credentials",
    failureClass: "hostile",
    exercise: decode('<a href="https://user:password@example.com/">x</a>'),
  },
  {
    reason: "document_too_complex",
    failureClass: "limit",
    exercise: decode(`${"<div>".repeat(66)}${"</div>".repeat(66)}`),
  },
  {
    reason: "stray_text_in_table",
    failureClass: "hostile",
    exercise: decode("<table><tr>stray text<td>x</td></tr></table>"),
  },
  {
    reason: "stray_text_in_container",
    failureClass: "uninterpretable",
    exercise: decode("<ul>stray text<li>x</li></ul>"),
  },
  {
    reason: "mismatched_tag",
    failureClass: "hostile",
    exercise: decode("<p>x</div>"),
  },
  {
    reason: "malformed_markup",
    failureClass: "hostile",
    exercise: decode("<p>x</p><>"),
  },
  {
    reason: "forbidden_tag",
    failureClass: "hostile",
    exercise: decode("<script>alert(1)</script>"),
  },
  {
    reason: "misnested_block",
    failureClass: "hostile",
    exercise: decode("<p><div>x</div></p>"),
  },
  {
    reason: "nested_anchor",
    failureClass: "hostile",
    exercise: decode('<a href="https://example.com/"><a href="https://example.com/">x</a></a>'),
  },
  {
    reason: "nested_list",
    failureClass: "uninterpretable",
    exercise: decode("<ul><ul><li>x</li></ul></ul>"),
  },
  {
    reason: "invalid_child",
    failureClass: "hostile",
    exercise: decode("<ul><p>x</p></ul>"),
  },
  {
    reason: "orphan_list_item",
    failureClass: "uninterpretable",
    exercise: decode("<li>x</li>"),
  },
  {
    reason: "misplaced_element",
    failureClass: "hostile",
    exercise: decode("<td>x</td>"),
  },
  {
    reason: "malformed_attribute",
    failureClass: "hostile",
    exercise: decode("<p class=>x</p>"),
  },
  {
    reason: "duplicate_attribute",
    failureClass: "hostile",
    exercise: decode('<p class="a" class="b">x</p>'),
  },
  {
    reason: "active_attribute",
    failureClass: "hostile",
    exercise: decode('<p onclick="alert(1)">x</p>'),
  },
  {
    reason: "fetching_attribute",
    failureClass: "hostile",
    exercise: decode('<table><tr><td background="https://example.com/x.png">x</td></tr></table>'),
  },
  {
    reason: "attr_unrecognised",
    failureClass: "uninterpretable",
    exercise: decode('<p contenteditable="false">x</p>'),
  },
  {
    reason: "unsafe_style",
    failureClass: "hostile",
    exercise: decode('<p style="background-image:url(x)">x</p>'),
  },
  {
    reason: "dir_unrecognised",
    failureClass: "uninterpretable",
    exercise: decode('<p dir="sideways">x</p>'),
  },
  {
    reason: "entity_encoded_url",
    failureClass: "hostile",
    exercise: decode('<a href="https://example.com/?a&bogus">x</a>'),
  },
  {
    reason: "url_raw_ampersand",
    failureClass: "uninterpretable",
    exercise: decode('<a href="https://example.com/?a=1&b=2">x</a>'),
  },
  {
    reason: "self_closing_element",
    failureClass: "hostile",
    exercise: decode("<p/>"),
  },
  {
    reason: "unclosed_element",
    failureClass: "hostile",
    exercise: decode("<p>x"),
  },
  {
    reason: "duplicate_mark",
    failureClass: "uninterpretable",
    exercise: decode("<p><strong><b>x</b></strong></p>"),
  },
  {
    reason: "duplicate_opaque_token",
    failureClass: "hostile",
    exercise: () => {
      const token = "a".repeat(36);
      return serializeNoteDocumentNative({
        version: 1,
        blocks: [OPAQUE(token), OPAQUE(token)],
      } as NoteDocumentV1);
    },
  },
  {
    reason: "envelope_shape",
    failureClass: "uninterpretable",
    // A well-formed body, so the shape is the only fault the scan finds.
    exercise: () => decodeNoteDocumentNative({ type: "json", data: "<p>x</p>" }, BINDING),
  },
  {
    reason: "document_without_blocks",
    failureClass: "uninterpretable",
    // A whitespace-only character that `trim()` erases: no roots, non-blank source.
    exercise: decode("&nbsp;"),
  },
  {
    reason: "duplicate_mark_output",
    failureClass: "uninterpretable",
    exercise: null,
  },
  {
    reason: "unknown_mark",
    failureClass: "uninterpretable",
    exercise: null,
  },
  {
    reason: "code_language_invalid",
    failureClass: "uninterpretable",
    exercise: () =>
      serializeNoteDocumentNative({
        version: 1,
        blocks: [{ type: "code-block", text: "x", language: "not a language" }],
      } as NoteDocumentV1),
  },
  {
    reason: "table_without_columns",
    failureClass: "uninterpretable",
    exercise: () =>
      serializeNoteDocumentNative({
        version: 1,
        blocks: [{ type: "table", columns: [], rows: [] }],
      } as NoteDocumentV1),
  },
  {
    reason: "block_not_serializable",
    failureClass: "uninterpretable",
    exercise: () =>
      serializeNoteDocumentNative({
        version: 1,
        blocks: [{ type: "image", url: "https://example.com/x.png", alt: "x" }],
      } as NoteDocumentV1),
  },
  {
    reason: "opaque_payload_missing",
    failureClass: "uninterpretable",
    exercise: null,
  },
  {
    reason: "options_not_plain",
    failureClass: "uninterpretable",
    exercise: () =>
      serializeNoteDocumentNative({ version: 1, blocks: [] } as NoteDocumentV1, [] as never),
  },
  {
    reason: "options_unexpected_field",
    failureClass: "uninterpretable",
    exercise: () =>
      serializeNoteDocumentNative(
        { version: 1, blocks: [] } as NoteDocumentV1,
        {
          extra: true,
        } as never,
      ),
  },
  {
    reason: "json_writer_disabled",
    failureClass: "uninterpretable",
    exercise: () =>
      serializeNoteDocumentNative({ version: 1, blocks: [] } as NoteDocumentV1, {
        writer: "json",
      }),
  },
  {
    reason: "writer_unsupported",
    failureClass: "uninterpretable",
    exercise: () =>
      serializeNoteDocumentNative(
        { version: 1, blocks: [] } as NoteDocumentV1,
        {
          writer: "xml",
        } as never,
      ),
  },
  {
    reason: "context_unknown",
    failureClass: "uninterpretable",
    exercise: () =>
      serializeNoteDocumentNative({ version: 1, blocks: [] } as NoteDocumentV1, {
        context: { version: 1 } as never,
      }),
  },
  {
    reason: "context_binding_mismatch",
    failureClass: "hostile",
    exercise: () => {
      const decoded = decodeNoteDocumentNative(envelope("<p>x</p>"), BINDING);
      return serializeNoteDocumentNative(decoded.document, {
        context: decoded.context,
        binding: { noteId: "synthetic", revision: "rev_other" },
      });
    },
  },
  {
    reason: "context_references_mismatch",
    failureClass: "edit_refusal",
    exercise: () => {
      const decoded = decodeNoteDocumentNative(envelope("<p>x</p>"), BINDING);
      return serializeNoteDocumentNative(
        { version: 1, blocks: [OPAQUE("b".repeat(36))] } as NoteDocumentV1,
        { context: decoded.context, binding: BINDING },
      );
    },
  },
];

const UNREACHABLE = ["duplicate_mark_output", "unknown_mark", "opaque_payload_missing"] as const;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("EA-2 — every whole-document fail() site has a classified reason", () => {
  it("covers exactly the closed vocabulary, once each", () => {
    const reasons = TABLE.map((entry) => entry.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect([...reasons].sort()).toEqual([...NATIVE_FAILURE_REASONS].sort());
  });

  it("declares exactly the defensive sites that public input cannot reach", () => {
    expect(TABLE.filter((entry) => entry.exercise === null).map((entry) => entry.reason)).toEqual([
      ...UNREACHABLE,
    ]);
  });

  for (const entry of TABLE) {
    it(`${entry.reason} is ${entry.failureClass}`, () => {
      expect(nativeFailureClass(entry.reason)).toBe(entry.failureClass);
      if (entry.exercise === null) return;
      const error = thrown(entry.exercise);
      expect(error, `${entry.reason} did not refuse`).toBeInstanceOf(NoteDocumentNativeError);
      expect((error as NoteDocumentNativeError).reason).toBe(entry.reason);
      // The reason is internal: it is not enumerable on the error.
      expect(JSON.stringify(error)).not.toContain(entry.reason);
    });
  }
});

/**
 * The owner's classification ruling: anything that fetches, executes, or that
 * a browser would silently repair is hostile; anything merely outside the
 * grammar is preservable. Each row is one fixture and the reason and class it
 * must refuse with.
 */
type Split = readonly [label: string, run: () => unknown, reason: NativeFailureReason];

function refusal(run: () => unknown): { reason: NativeFailureReason; failureClass: string } {
  const error = thrown(run);
  expect(error).toBeInstanceOf(NoteDocumentNativeError);
  const reason = (error as NoteDocumentNativeError).reason;
  return { reason, failureClass: nativeFailureClass(reason) };
}

function proves(rows: readonly Split[], failureClass: NativeFailureClass): void {
  for (const [label, run, reason] of rows) {
    it(`${label} -> ${reason} (${failureClass})`, () => {
      expect(refusal(run)).toEqual({ reason, failureClass });
    });
  }
}

describe("EA-2 — reclassified: hostile to uninterpretable", () => {
  proves(
    [
      ["a CRLF newline in text", decode("<p>a\r\nb</p>"), "crlf_line_ending"],
      ["a CRLF newline between blocks", decode("<p>a</p>\r\n<p>b</p>"), "crlf_line_ending"],
      ["a tel: link", decode('<a href="tel:+15550100">x</a>'), "url_inert"],
      ["a #fragment link", decode('<a href="#section">x</a>'), "url_inert"],
      ["a relative link", decode('<a href="notes/other.html">x</a>'), "url_inert"],
      ["an nn:// note link", decode('<a href="nn://note/abc123">x</a>'), "url_inert"],
      ["a nested <ul><ul>", decode("<ul><ul><li>x</li></ul></ul>"), "nested_list"],
      ["a nested <ol><ul>", decode("<ol><ul><li>x</li></ul></ol>"), "nested_list"],
      ["a bare <li>", decode("<li>x</li>"), "orphan_list_item"],
      ["a bare <li> in a <div>", decode("<div><li>x</li></div>"), "orphan_list_item"],
      [
        "a raw & in a URL",
        decode('<a href="https://example.com/?a=1&b=2">x</a>'),
        "url_raw_ampersand",
      ],
      [
        "a raw & at the end of a URL",
        decode('<a href="https://example.com/?a=1&">x</a>'),
        "url_raw_ampersand",
      ],
    ],
    "uninterpretable",
  );
});

describe("EA-2 — reclassified: uninterpretable to hostile", () => {
  proves(
    [
      [
        "stray text in a <tr>",
        decode("<table><tr>x<td>y</td></tr></table>"),
        "stray_text_in_table",
      ],
      ["stray text in a <tbody>", decode("<table><tbody>x</tbody></table>"), "stray_text_in_table"],
      [
        "background on <td>",
        decode('<table><tr><td background="https://example.com/x.png">x</td></tr></table>'),
        "fetching_attribute",
      ],
      [
        "background on <table>",
        decode('<table background="https://example.com/x.png"><tr><td>x</td></tr></table>'),
        "fetching_attribute",
      ],
      ["src on <input>", decode('<input src="https://example.com/x.png">'), "fetching_attribute"],
      [
        "a Proxy envelope",
        () =>
          decodeNoteDocumentNative(new Proxy({ type: "tiptap", data: "<p>x</p>" }, {}), BINDING),
        "envelope_proxy",
      ],
      [
        "a Proxy nested in the binding",
        () =>
          decodeNoteDocumentNative(envelope("<p>x</p>"), {
            noteId: new Proxy({}, {}),
            revision: "r",
          } as unknown as NativeNoteBinding),
        "envelope_proxy",
      ],
    ],
    "hostile",
  );
});

describe("EA-2 — retained: the hostile case of each split reason did not move", () => {
  proves(
    [
      ["a NUL", decode("<p>a\u0000b</p>"), "control_character"],
      ["a lone CR", decode("<p>a\rb</p>"), "control_character"],
      ["a CR at the end", decode("<p>a</p>\r"), "control_character"],
      ["a lone surrogate", decode("<p>a\ud800b</p>"), "control_character"],
      ["a NUL beside a CRLF", decode("<p>a\r\nb\u0000</p>"), "control_character"],
      ["a javascript: link", decode('<a href="javascript:alert(1)">x</a>'), "url_not_permitted"],
      ["a data: link", decode('<a href="data:text/html,x">x</a>'), "url_not_permitted"],
      ["a vbscript: link", decode('<a href="vbscript:x">x</a>'), "url_not_permitted"],
      ["a file: link", decode('<a href="file:///etc/x">x</a>'), "url_not_permitted"],
      ["a network-path link", decode('<a href="//example.com/x">x</a>'), "url_not_permitted"],
      [
        "an nn:// link with credentials",
        decode('<a href="nn://u:p@note/x">x</a>'),
        "url_not_permitted",
      ],
      ["a tel: link a browser repairs", decode('<a href="tel:+1 555">x</a>'), "url_not_permitted"],
      ["a tab inside a scheme", decode('<a href="java\tscript:x">x</a>'), "url_not_permitted"],
      ["a relative image src (fetched)", decode('<img src="x.png">'), "url_not_permitted"],
      ["a fragment image src (fetched)", decode('<img src="#x">'), "url_not_permitted"],
      [
        "a javascript: link with a raw &",
        decode('<a href="javascript:alert(1)&x=1">x</a>'),
        "url_not_permitted",
      ],
      [
        "a credentialed http link",
        decode('<a href="https://u:p@example.com/">x</a>'),
        "url_credentials",
      ],
      ["a <p> in a <ul>", decode("<ul><p>x</p></ul>"), "invalid_child"],
      ["a <div> in a <table>", decode("<table><div>x</div></table>"), "invalid_child"],
      ["a <p> in a <tr>", decode("<table><tr><p>x</p></tr></table>"), "invalid_child"],
      ["a bare <td>", decode("<td>x</td>"), "misplaced_element"],
      ["a bare <tr>", decode("<tr><td>x</td></tr>"), "misplaced_element"],
      ["an <li> directly in an <li>", decode("<ul><li><li>x</li></li></ul>"), "misplaced_element"],
      [
        "an <li> in a <div> in an <li>",
        decode("<ul><li><div><li>x</li></div></li></ul>"),
        "misplaced_element",
      ],
      [
        "an entity a browser decodes without ;",
        decode('<a href="https://example.com/?a&lt">x</a>'),
        "entity_encoded_url",
      ],
      [
        "a numeric reference without ;",
        decode('<a href="https://example.com/?a&#38">x</a>'),
        "entity_encoded_url",
      ],
      [
        "an unknown named entity",
        decode('<a href="https://example.com/?a&bogus;">x</a>'),
        "entity_encoded_url",
      ],
    ],
    "hostile",
  );
});

describe("EA-2 — retained: the uninterpretable case of each split reason did not move", () => {
  proves(
    [
      ["stray text in a <ul>", decode("<ul>x<li>y</li></ul>"), "stray_text_in_container"],
      ["stray text in an <ol>", decode("<ol>x<li>y</li></ol>"), "stray_text_in_container"],
      [
        "an unrecognised attribute",
        decode('<p contenteditable="false">x</p>'),
        "attr_unrecognised",
      ],
      [
        "a second non-fetching attribute",
        decode('<p spellcheck="false">x</p>'),
        "attr_unrecognised",
      ],
      [
        "a cyclic, non-Proxy binding",
        () => {
          const cycle: Record<string, unknown> = {};
          cycle.self = cycle;
          return decodeNoteDocumentNative(envelope("<p>x</p>"), {
            noteId: cycle,
            revision: "r",
          } as unknown as NativeNoteBinding);
        },
        "envelope_not_plain",
      ],
      [
        "a function in the binding",
        () =>
          decodeNoteDocumentNative(envelope("<p>x</p>"), {
            noteId: () => "x",
            revision: "r",
          } as unknown as NativeNoteBinding),
        "envelope_not_plain",
      ],
    ],
    "uninterpretable",
  );
});

/**
 * The worst fault decides the class, wherever it sits: hostile, then
 * unclassified, then limit, then uninterpretable. An uninterpretable class is a
 * certificate that the whole document was scanned and nothing worse was found.
 */
describe("EA-2 — the worst fault decides the class", () => {
  proves(
    [
      [
        "a fetching attribute after an unrecognised one on one element",
        decode(
          '<table><tr><td contenteditable="false" background="https://example.com/x.png">x</td></tr></table>',
        ),
        "fetching_attribute",
      ],
      [
        "an event handler after an unrecognised attribute on one element",
        decode('<p spellcheck="false" onclick="alert(1)">x</p>'),
        "active_attribute",
      ],
      [
        "a CRLF before a hostile attribute",
        decode('<p>a\r\nb</p><p onclick="alert(1)">x</p>'),
        "active_attribute",
      ],
      [
        "a CRLF before a fetching attribute",
        decode(
          '<p>a\r\nb</p><table><tr><td background="https://example.com/x.png">x</td></tr></table>',
        ),
        "fetching_attribute",
      ],
      [
        "an inert link before a javascript: link",
        decode('<p><a href="tel:+15550100">t</a><a href="javascript:alert(1)">x</a></p>'),
        "url_not_permitted",
      ],
      [
        "an invalid binding before hostile content",
        () =>
          decodeNoteDocumentNative(envelope('<p onclick="alert(1)">x</p>'), {
            noteId: "",
            revision: "r",
          }),
        "active_attribute",
      ],
      [
        "a non-plain envelope field beside a hostile body",
        () =>
          decodeNoteDocumentNative(
            { type: "tiptap", data: '<p onclick="alert(1)">x</p>', extra: new Date() },
            BINDING,
          ),
        "active_attribute",
      ],
      [
        "an unknown envelope type with a hostile body",
        () => decodeNoteDocumentNative({ type: "json", data: "<script>x</script>" }, BINDING),
        "forbidden_tag",
      ],
    ],
    "hostile",
  );

  proves(
    [
      [
        "an unrecognised attribute before a parse bound",
        decode(`<p contenteditable="false">x</p>${"<div>".repeat(66)}${"</div>".repeat(66)}`),
        "document_too_complex",
      ],
      [
        "a CRLF before the validator's bound",
        decode(`<p>a\r\nb</p><p>${"x".repeat(200_000)}</p>`),
        "document_bounds_exceeded",
      ],
      [
        "a duplicate mark before the validator's bound",
        decode(`<p><strong><b>x</b></strong></p><p>${"x".repeat(200_000)}</p>`),
        "document_bounds_exceeded",
      ],
    ],
    "limit",
  );

  proves(
    [
      [
        "an invalid dir before a URL parser exception",
        decode('<p dir="sideways">x</p><a href="http://[">x</a>'),
        "internal_failure",
      ],
    ],
    "unclassified",
  );

  proves(
    [
      [
        "several uninterpretable faults and no worse one (first reached)",
        decode(
          '<p>a\r\nb</p><p contenteditable="false" dir="sideways">x</p>' +
            '<p><a href="tel:+15550100">t</a><a href="https://example.com/?a=1&b=2">u</a></p>' +
            "<ul>stray<li>y</li></ul><ul><ul><li>x</li></ul></ul><li>z</li>" +
            "<p><strong><b>w</b></strong></p>",
        ),
        "crlf_line_ending",
      ],
      [
        "several uninterpretable faults without a CRLF (first reached)",
        decode('<p contenteditable="false">x</p><p><a href="tel:+15550100">t</a></p><li>z</li>'),
        "attr_unrecognised",
      ],
    ],
    "uninterpretable",
  );
});

describe("EA-2 — the edit refusal is its own class", () => {
  it("is neither a decode class nor preservable", () => {
    expect(NATIVE_FAILURE_REASONS.filter((r) => nativeFailureClass(r) === "edit_refusal")).toEqual([
      "context_references_mismatch",
    ]);
    expect(nativeFailureClass("context_references_mismatch")).not.toBe("uninterpretable");
    expect(nativeFailureClass("context_references_mismatch")).not.toBe("hostile");
  });

  it("an edit that drops a preserved block refuses with it", () => {
    const decoded = decodeNoteDocumentNative(envelope("<p>a</p><h4>kept</h4>"), BINDING);
    expect(decoded.document.blocks.map((b) => b.type)).toEqual(["paragraph", "opaque"]);
    expect(
      refusal(() =>
        serializeNoteDocumentNative(
          { version: 1, blocks: [decoded.document.blocks[0]!] } as NoteDocumentV1,
          { context: decoded.context, binding: BINDING },
        ),
      ),
    ).toEqual({ reason: "context_references_mismatch", failureClass: "edit_refusal" });
  });
});

describe("EA-2 — exhaustiveness against the source", () => {
  const source = readFileSync(
    new URL("../src/core/note-document-native.ts", import.meta.url),
    "utf8",
  );
  const sites = [...source.matchAll(/\b(?:fail|defer)\("([a-z0-9_]+)"\)/g)].map(
    (match) => match[1]!,
  );

  it("has no unclassified bare fail() or defer() call", () => {
    expect(source).not.toMatch(/\b(?:fail|defer)\(\s*\)/);
  });

  it("defers only uninterpretable reasons", () => {
    const deferredSites = [...source.matchAll(/\bdefer\("([a-z0-9_]+)"\)/g)].map(
      (match) => match[1]! as NativeFailureReason,
    );
    expect(deferredSites.length).toBeGreaterThan(0);
    for (const reason of deferredSites)
      expect(nativeFailureClass(reason), reason).toBe("uninterpretable");
  });

  it("has exactly one source site per table reason", () => {
    expect(sites).toHaveLength(TABLE.length);
    expect(new Set(sites).size).toBe(sites.length);
    expect([...new Set(sites)].sort()).toEqual(TABLE.map((entry) => entry.reason).sort());
  });
});

describe("EA-2 — an unnamed failure is unclassified, never preservable", () => {
  const NATIVE = "../src/core/note-document-native.js";
  const DOCUMENT = "../src/core/note-document.js";

  /**
   * Decode `<p>x</p>` with `validateNoteDocument` replaced by `throwing`, in a
   * fresh module graph, and return the refusal's reason and class.
   */
  async function decodeWithValidator(
    throwing: (actual: typeof NoteDocumentModule) => never,
  ): Promise<{ reason: NativeFailureReason; failureClass: NativeFailureClass }> {
    vi.resetModules();
    vi.doMock(DOCUMENT, async (importOriginal) => {
      const actual = await importOriginal<typeof NoteDocumentModule>();
      return { ...actual, validateNoteDocument: () => throwing(actual) };
    });
    try {
      const native = (await import(NATIVE)) as typeof NoteDocumentNativeModule;
      const error = thrown(() =>
        native.decodeNoteDocumentNative(envelope("<p>x</p>"), BINDING),
      ) as NoteDocumentNativeError;
      expect(error).toBeInstanceOf(native.NoteDocumentNativeError);
      return { reason: error.reason, failureClass: native.nativeFailureClass(error.reason) };
    } finally {
      vi.doUnmock(DOCUMENT);
      vi.resetModules();
    }
  }

  it("a plain throw inside the decode path lands in unclassified", async () => {
    const refusal = await decodeWithValidator(() => {
      throw new Error("synthetic plain throw");
    });
    expect(refusal).toEqual({ reason: "internal_failure", failureClass: "unclassified" });
  });

  it("a validator failure outside the bounds stays unclassified", async () => {
    const refusal = await decodeWithValidator((actual) => {
      throw new actual.NoteDocumentError("invalid_shape");
    });
    expect(refusal).toEqual({ reason: "internal_failure", failureClass: "unclassified" });
  });

  it("every validator bound is a limit", async () => {
    for (const code of [
      "oversize_document",
      "oversize_block",
      "oversize_inline",
      "oversize_sentinel",
      "depth_exceeded",
    ] as const) {
      const refusal = await decodeWithValidator((actual) => {
        throw new actual.NoteDocumentError(code);
      });
      expect(refusal, code).toEqual({ reason: "document_bounds_exceeded", failureClass: "limit" });
    }
  });

  it("only a failure that cannot be classified is unclassified", () => {
    // Unclassified means "not classified", never "classified as harmless". A
    // failure that happens before the body is scanned cannot be shown free of
    // hostile content, so it belongs here and is never preservable.
    expect(NATIVE_FAILURE_REASONS.filter((r) => nativeFailureClass(r) === "unclassified")).toEqual([
      "internal_failure",
      "envelope_not_record",
    ]);
  });
});
