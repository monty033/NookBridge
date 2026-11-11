/**
 * EA-6b — the census names the stage that refused a note.
 *
 * Before this change a note that decoded and then failed strict Markdown
 * serialization was reported as a generic `serializer_fallback`, with no reason
 * and with its preserved-block count zeroed — so an operator could not tell a
 * note that has no preserved content from one whose preserved content the
 * serializer refused. The serializer already produces a closed error code; the
 * classifier was discarding it.
 *
 * These cases pin the new field: it is present exactly for a serialization
 * refusal, it never appears beside the decode reason, it carries a code from
 * the closed vocabulary, and nothing about the note's content crosses with it.
 */
import { describe, expect, it, vi } from "vitest";

import { createNotesEditCensus } from "../src/service/notes-edit-census.js";
import { handleRpcRequest, type RpcHandlerRuntimeLike } from "../src/service/rpc-handler.js";
import type { RpcRequest } from "../src/service/rpc-protocol.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";
import { snapshotFrom } from "./helpers/note-snapshot.js";
import { classifyNoteContentProjection } from "../src/service/note-content-projection.js";
import { NOTE_DOCUMENT_ERROR_CODES } from "../src/core/note-document.js";
import type { NoteDocumentErrorCode } from "../src/core/note-document.js";
import type * as NoteDocumentMarkdownModule from "../src/core/note-document-markdown.js";
import type * as NoteContentProjectionModule from "../src/service/note-content-projection.js";
import type * as NotesEditCensusModule from "../src/service/notes-edit-census.js";
import { normalizeNotesEditCensusCounts } from "../src/operator/notes-cli.js";

const serializationStages = (total: number) => ({
  validation: 0,
  reference_check: 0,
  markdown_emission: 0,
  round_trip: 0,
  unclassified: total,
});

const note = {
  id: "n_ea6b",
  title: "Synthetic",
  revision: `rev_${"a".repeat(32)}`,
  notebookId: "nb_ea6b",
};

const envelope = (data: string) =>
  ({ type: "tiptap", data: `<div data-type="document">${data}</div>` }) as const;

const classify = (data: string) =>
  classifyNoteContentProjection({
    contentRefusal: undefined,
    envelope: envelope(data),
    noteId: note.id,
    note,
    requestId: "req_ea6b",
  });

/**
 * Classify a note while the Markdown codec refuses the *complete* document.
 *
 * Since EA-5, a block the codec cannot spell is preserved instead of failing
 * the note, so a note-level serializer refusal can no longer be produced by a
 * real fixture: it is a defence-in-depth path for shapes the decoder cannot
 * emit today. Injecting it is the only honest way to keep the reporting
 * contract pinned, and it keeps the assertion about *reporting* rather than
 * about which content happens to be unrepresentable this week.
 */
async function classifyWithRefusal(data: string, code: NoteDocumentErrorCode = "malformed_link") {
  const MARKDOWN = "../src/core/note-document-markdown.js";
  vi.resetModules();
  // `NoteDocumentError` is recognised by prototype identity, so the error must
  // be built from the same module instance the projection will import.
  const document = await import("../src/core/note-document.js");
  vi.doMock(MARKDOWN, async (importOriginal) => {
    const actual = await importOriginal<typeof NoteDocumentMarkdownModule>();
    return {
      ...actual,
      serializeNoteDocumentMarkdown: ((
        input: Parameters<typeof actual.serializeNoteDocumentMarkdown>[0],
      ) => {
        // Single blocks are the decoder's own representability probe.
        if (input.blocks.length > 1)
          throw new document.NoteDocumentError(code, "markdown_emission");
        return actual.serializeNoteDocumentMarkdown(input);
      }) as typeof actual.serializeNoteDocumentMarkdown,
    };
  });
  try {
    const { classifyNoteContentProjection: fresh } = (await import(
      "../src/service/note-content-projection.js"
    )) as typeof NoteContentProjectionModule;
    return fresh({
      contentRefusal: undefined,
      envelope: envelope(data),
      noteId: note.id,
      note,
      requestId: "req_ea6b",
    });
  } finally {
    vi.doUnmock(MARKDOWN);
    vi.resetModules();
  }
}

/** Two ordinary paragraphs: each is representable, the pair is refused. */
const TWO_PARAGRAPHS = "<p>alpha</p><p>beta</p>";
/** One preserved heading beside an ordinary paragraph. */
const PRESERVED_HEADING_AND_PARAGRAPH =
  '<h4><span style="color:red">Heading</span></h4><p>beta</p>';

/** A link the serializer refuses: its URL grammar rejects parentheses. */
const REFUSED_LINK = '<p><a href="https://example.com/a(b)">x</a></p>';
/** A preserved heading beside that link. */
const REFUSED_LINK_WITH_PRESERVED =
  '<h4><span style="color:red">Heading</span></h4>' + REFUSED_LINK;

describe("EA-6b — a serialization refusal is named, a decode refusal is not confused with it", () => {
  it("records the serializer's closed code for a note that decoded and then failed", async () => {
    const result = await classifyWithRefusal(TWO_PARAGRAPHS);
    expect(result.outcome).toBe("serializer_fallback");
    expect(result.serializationReason).toBe("malformed_link");
    expect(result.serializationStage).toBe("markdown_emission");
    // The two reasons are exclusive: a decode refusal is a different field.
    expect(result.reason).toBeUndefined();
  });

  it("keeps the decode reason and no serialization reason when the decoder refused", () => {
    const result = classify("<p>a\u0000b</p>");
    expect(result.outcome).toBe("serializer_fallback");
    expect(result.reason).toBe("control_character");
    expect(result.serializationReason).toBeUndefined();
  });

  it("still counts the preserved blocks of a note that decoded and then failed", async () => {
    const result = await classifyWithRefusal(PRESERVED_HEADING_AND_PARAGRAPH);
    expect(result.outcome).toBe("serializer_fallback");
    expect(result.serializationReason).toBe("malformed_link");
    // The preserved heading is real: zeroing it is what hid the shape.
    expect(result.preservedBlocks).toBe(1);
  });

  it("preserves a block the codec cannot spell instead of failing the whole note", () => {
    // EA-5: this note used to be a serializer fallback. The link's URL grammar
    // is outside the Markdown subset, but that is the block's problem, not the
    // note's — so it is preserved and everything beside it stays editable.
    const result = classify(REFUSED_LINK_WITH_PRESERVED);
    expect(result.outcome).toBe("strict_with_preserved_blocks");
    expect(result.serializationReason).toBeUndefined();
    expect(result.preservedBlocks).toBe(2);
  });

  it("reports no preserved blocks for a note that never decoded", () => {
    const result = classify("<p>a\u0000b</p>");
    expect(result.preservedBlocks).toBe(0);
    expect(result.preservedTaskLists).toBe(0);
  });

  it("keeps the reason off the notes.get response", async () => {
    // The read surface must not carry the refusal code, the note's title, or
    // anything else about why the strict serializer gave up.
    const reader = vi.fn(async () => ({
      type: "tiptap" as const,
      data: `<div data-type="document">${REFUSED_LINK}</div>`,
    }));
    const runtime = {
      search: async () => [],
      noteMetadata: async (id: string) =>
        ({ id, title: "Memo", revision: `rev_${"0".repeat(32)}` }) as never,
      readOnly: {
        readNoteSnapshot: snapshotFrom(
          async (id: string) => ({
            id,
            title: "Memo",
            revision: `rev_${"0".repeat(32)}`,
          }),
          reader,
        ),
      },
    } as unknown as RpcHandlerRuntimeLike;
    const response = await handleRpcRequest(
      { id: "r-1", method: "notes.get", params: { id: "n1" } } as unknown as RpcRequest,
      runtime,
      createReadWriteNoDeleteServicePolicy(),
    );
    expect(response).toMatchObject({
      ok: true,
      result: { kind: "note", contentStatus: "ok" },
    });
    const serialised = JSON.stringify(response);
    expect(serialised).not.toContain("serializationReason");
    expect(serialised).not.toContain("malformed_link");
  });

  it("keeps the note's content out of the census result", async () => {
    const census = await createNotesEditCensus({
      listVisibleNotes: async () => [{ id: "n_content" }],
      readNoteSnapshot: async (id) => ({
        metadata: { id, title: "SECRET_TITLE", revision: `rev_${"0".repeat(32)}` },
        content: { type: "tiptap", data: `<div data-type="document">${REFUSED_LINK}</div>` },
      }),
    }).corpus();
    const serialised = JSON.stringify(census);
    expect(serialised).not.toContain("SECRET_TITLE");
    expect(serialised).not.toContain("example.com");
    expect(serialised).not.toContain("a(b)");
  });
});

describe("EA-6b — the census wire shape stays closed", () => {
  it("counts a serializer refusal and keeps it a subset of the serializer fallbacks", () => {
    const census = normalizeNotesEditCensusCounts({
      scope: "corpus",
      total: 2,
      classes: { hostile: 0, uninterpretable: 0, limit: 0, unclassified: 0 },
      editRefusals: 0,
      serializationRefusals: { malformed_link: 1 },
      serializationStages: serializationStages(1),
      serializationFallbackWithPreserved: 1,
      projection: {
        strict: 0,
        strictWithPreservedBlocks: 0,
        opaqueHeadingFallback: 0,
        serializerFallback: 2,
        locked: 0,
        oversize: 0,
        unavailable: 0,
      },
      preservedBlocks: 1,
      preservedTaskLists: 0,
      cap: 500,
      skipped: 0,
      truncated: false,
    });
    expect(census).toBeDefined();
    expect(census?.serializationRefusals).toEqual({ malformed_link: 1 });
    expect(census?.serializationStages).toEqual({
      validation: 0,
      reference_check: 0,
      markdown_emission: 0,
      round_trip: 0,
      unclassified: 1,
    });
    expect(census?.serializationFallbackWithPreserved).toBe(1);
  });

  it("refuses a census carrying a code outside the closed vocabulary", () => {
    const census = normalizeNotesEditCensusCounts({
      scope: "corpus",
      total: 1,
      classes: { hostile: 0, uninterpretable: 0, limit: 0, unclassified: 0 },
      editRefusals: 0,
      // A code the validator never produces, and a canary string.
      serializationRefusals: { not_a_real_code: 1 },
      serializationFallbackWithPreserved: 0,
      projection: {
        strict: 0,
        strictWithPreservedBlocks: 0,
        opaqueHeadingFallback: 0,
        serializerFallback: 1,
        locked: 0,
        oversize: 0,
        unavailable: 0,
      },
      preservedBlocks: 0,
      preservedTaskLists: 0,
      cap: 500,
      skipped: 0,
      truncated: false,
    });
    expect(census).toBeUndefined();
  });

  it("refuses a census whose serialization refusals outnumber its fallbacks", () => {
    const census = normalizeNotesEditCensusCounts({
      scope: "corpus",
      total: 1,
      classes: { hostile: 0, uninterpretable: 0, limit: 0, unclassified: 0 },
      editRefusals: 0,
      serializationRefusals: { malformed_link: 5 },
      serializationStages: serializationStages(5),
      serializationFallbackWithPreserved: 0,
      projection: {
        strict: 0,
        strictWithPreservedBlocks: 0,
        opaqueHeadingFallback: 0,
        serializerFallback: 1,
        locked: 0,
        oversize: 0,
        unavailable: 0,
      },
      preservedBlocks: 0,
      preservedTaskLists: 0,
      cap: 500,
      skipped: 0,
      truncated: false,
    });
    expect(census).toBeUndefined();
  });

  it("refuses a census with fewer preserved blocks than preserving notes", () => {
    // Every note counted as preserving holds at least one preserved block, so a
    // census claiming one refusal with a preserved note behind it and no
    // preserved blocks is inconsistent.
    const census = normalizeNotesEditCensusCounts({
      scope: "corpus",
      total: 1,
      classes: { hostile: 0, uninterpretable: 0, limit: 0, unclassified: 0 },
      editRefusals: 0,
      serializationRefusals: { malformed_link: 1 },
      serializationStages: serializationStages(1),
      serializationFallbackWithPreserved: 1,
      projection: {
        strict: 0,
        strictWithPreservedBlocks: 0,
        opaqueHeadingFallback: 0,
        serializerFallback: 1,
        locked: 0,
        oversize: 0,
        unavailable: 0,
      },
      preservedBlocks: 0,
      preservedTaskLists: 0,
      cap: 500,
      skipped: 0,
      truncated: false,
    });
    expect(census).toBeUndefined();
  });

  it("refuses a census whose preserved fallbacks outnumber its refusals", () => {
    const census = normalizeNotesEditCensusCounts({
      scope: "corpus",
      total: 1,
      classes: { hostile: 0, uninterpretable: 0, limit: 0, unclassified: 0 },
      editRefusals: 0,
      serializationRefusals: { malformed_link: 1 },
      serializationStages: serializationStages(1),
      serializationFallbackWithPreserved: 2,
      projection: {
        strict: 0,
        strictWithPreservedBlocks: 0,
        opaqueHeadingFallback: 0,
        serializerFallback: 1,
        locked: 0,
        oversize: 0,
        unavailable: 0,
      },
      preservedBlocks: 2,
      preservedTaskLists: 0,
      cap: 500,
      skipped: 0,
      truncated: false,
    });
    expect(census).toBeUndefined();
  });

  it("covers every error code the validator can produce", () => {
    // The printed vocabulary and the validator's codes must not drift apart: a
    // code the validator can raise but the census cannot name would be counted
    // as unclassified, which is exactly the blindness this change removes.
    // A fixed list, not the exported one: a test that builds its expectation
    // from the thing it is checking cannot catch the thing drifting.
    const codes = [
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
      "invalid_reference_url",
    ];
    expect([...NOTE_DOCUMENT_ERROR_CODES].sort()).toEqual([...codes].sort());
    const printed = normalizeNotesEditCensusCounts({
      scope: "corpus",
      total: codes.length,
      classes: { hostile: 0, uninterpretable: 0, limit: 0, unclassified: 0 },
      editRefusals: 0,
      serializationRefusals: Object.fromEntries(codes.map((code) => [code, 1])),
      serializationStages: serializationStages(codes.length),
      serializationFallbackWithPreserved: 0,
      projection: {
        strict: 0,
        strictWithPreservedBlocks: 0,
        opaqueHeadingFallback: 0,
        serializerFallback: codes.length,
        locked: 0,
        oversize: 0,
        unavailable: 0,
      },
      preservedBlocks: 0,
      preservedTaskLists: 0,
      cap: 500,
      skipped: 0,
      truncated: false,
    });
    // Every code is accepted: none is rejected as outside the vocabulary.
    expect(printed).toBeDefined();
    expect(Object.keys(printed?.serializationRefusals ?? {}).sort()).toEqual(
      [...NOTE_DOCUMENT_ERROR_CODES].sort(),
    );
  });
});

describe("EA-6b — the census counts the refusals it names", () => {
  const noteId = "n_ea6b_census";
  const metadata = {
    id: noteId,
    title: "Synthetic",
    revision: `rev_${"b".repeat(32)}`,
    notebookId: "nb_ea6b",
  };

  const censusOver = (bodies: readonly string[]) =>
    createNotesEditCensus({
      listVisibleNotes: async () => bodies.map((_, index) => ({ id: `${noteId}_${index}` })),
      readNoteSnapshot: async (id) => {
        const index = Number(id.slice(`${noteId}_`.length));
        const body = bodies[index];
        if (body === undefined) return undefined;
        return {
          metadata,
          content: { type: "tiptap", data: `<div data-type="document">${body}</div>` },
        };
      },
    });

  /** The same census, with the Markdown codec refusing every multi-block note. */
  async function censusWithRefusal(bodies: readonly string[]) {
    const MARKDOWN = "../src/core/note-document-markdown.js";
    vi.resetModules();
    const document = await import("../src/core/note-document.js");
    vi.doMock(MARKDOWN, async (importOriginal) => {
      const actual = await importOriginal<typeof NoteDocumentMarkdownModule>();
      return {
        ...actual,
        serializeNoteDocumentMarkdown: ((
          input: Parameters<typeof actual.serializeNoteDocumentMarkdown>[0],
        ) => {
          if (input.blocks.length > 1)
            throw new document.NoteDocumentError("malformed_link", "markdown_emission");
          return actual.serializeNoteDocumentMarkdown(input);
        }) as typeof actual.serializeNoteDocumentMarkdown,
      };
    });
    try {
      const { createNotesEditCensus: fresh } = (await import(
        "../src/service/notes-edit-census.js"
      )) as typeof NotesEditCensusModule;
      return await fresh({
        listVisibleNotes: async () => bodies.map((_, index) => ({ id: `${noteId}_${index}` })),
        readNoteSnapshot: async (id) => {
          const index = Number(id.slice(`${noteId}_`.length));
          const body = bodies[index];
          if (body === undefined) return undefined;
          return {
            metadata,
            content: { type: "tiptap", data: `<div data-type="document">${body}</div>` },
          };
        },
      }).corpus();
    } finally {
      vi.doUnmock(MARKDOWN);
      vi.resetModules();
    }
  }

  it("partitions serializer refusals by code and counts the preserved ones", async () => {
    const census = await censusWithRefusal([
      TWO_PARAGRAPHS,
      PRESERVED_HEADING_AND_PARAGRAPH,
      "<p>plain</p>",
    ]);
    expect(census.total).toBe(3);
    expect(census.projection.serializerFallback).toBe(2);
    expect(census.serializationRefusals).toEqual({ malformed_link: 2 });
    expect(census.serializationStages).toEqual({
      validation: 0,
      reference_check: 0,
      markdown_emission: 2,
      round_trip: 0,
      unclassified: 0,
    });
    // One of the two refused notes carried a preserved block: the count that
    // used to be zeroed, and that separates "preservation broke this" from
    // "ordinary content cannot be written".
    expect(census.serializationFallbackWithPreserved).toBe(1);
    // The decode classes stay empty: nothing here failed to decode.
    expect(census.reasons).toEqual({
      hostile: 0,
      uninterpretable: 0,
      limit: 0,
      unclassified: 0,
    });
  });

  it("counts a note the codec can now spell as preserved, not refused", async () => {
    // The same two bodies without the injected refusal: EA-5 preserves the
    // unspellable block and keeps the rest of the note writable, so neither
    // note is a serializer fallback any more.
    const census = await censusOver([REFUSED_LINK, REFUSED_LINK_WITH_PRESERVED]).corpus();
    expect(census.total).toBe(2);
    expect(census.projection.serializerFallback).toBe(0);
    expect(census.projection.strictWithPreservedBlocks).toBe(2);
    expect(census.serializationRefusals).toEqual({});
    expect(census.preservedBlocks).toBe(3);
  });

  it("does not count a decode refusal as a serializer refusal", async () => {
    const census = await censusOver(["<p>a\u0000b</p>"]).corpus();
    expect(census.serializationRefusals).toEqual({});
    expect(census.serializationFallbackWithPreserved).toBe(0);
    expect(census.reasons.hostile).toBe(1);
  });
});

describe("EA-6b — a refusal that turns out to be over budget is not a serializer refusal", () => {
  it("counts an over-budget refusal under oversize, and leaves the census valid", async () => {
    // The reviewer's failure case: the strict serializer refuses the note, and
    // the response then turns out to be over budget. The note is an oversize
    // note, not a serializer fallback, so counting it in
    // `serializationRefusals` would make the client's own invariant (refusals
    // are a subset of the fallbacks) reject the census.
    //
    // The fixture has to reach the serializer: a body large enough to blow the
    // budget on its own would be refused by the decoder instead, and the
    // refusal would be a decode refusal. Here the body is small, the link is
    // what the serializer refuses, and the title is what makes the response
    // over budget.
    const noteId = "n_oversize";
    const hugeTitle = "t".repeat(70_000);
    const metadata = { id: noteId, title: hugeTitle, revision: `rev_${"0".repeat(32)}` };
    const content = {
      type: "tiptap" as const,
      data: `<div data-type="document">${REFUSED_LINK}</div>`,
    };

    // The note reaches the serializer, and the response is what goes over
    // budget. Since EA-5 the link is preserved rather than refused, so the note
    // is over budget with no serializer refusal behind it — the invariant the
    // client checks must still accept that.
    const classification = classifyNoteContentProjection({
      contentRefusal: undefined,
      envelope: content,
      noteId,
      note: metadata,
      requestId: "req_ea6b",
    });
    expect(classification.outcome).toBe("oversize");
    expect(classification.serializationReason).toBeUndefined();

    const census = await createNotesEditCensus({
      listVisibleNotes: async () => [{ id: noteId }],
      readNoteSnapshot: async () => ({ metadata, content }),
    }).corpus();
    expect(census.total).toBe(1);
    expect(census.projection.oversize).toBe(1);
    expect(census.projection.serializerFallback).toBe(0);
    // The decode classes stay empty: the decoder was happy with this note.
    expect(census.reasons).toEqual({
      hostile: 0,
      uninterpretable: 0,
      limit: 0,
      unclassified: 0,
    });
    expect(census.serializationRefusals).toEqual({});
    expect(census.serializationFallbackWithPreserved).toBe(0);
    // The census the operator client validates must accept it.
    expect(
      normalizeNotesEditCensusCounts({
        scope: "corpus",
        total: census.total,
        classes: census.reasons,
        editRefusals: census.editRefusals,
        serializationRefusals: census.serializationRefusals,
        serializationStages: census.serializationStages,
        serializationFallbackWithPreserved: census.serializationFallbackWithPreserved,
        projection: {
          strict: census.projection.strict,
          strictWithPreservedBlocks: census.projection.strictWithPreservedBlocks,
          opaqueHeadingFallback: census.projection.opaqueHeadingFallback,
          serializerFallback: census.projection.serializerFallback,
          locked: census.projection.locked,
          oversize: census.projection.oversize,
          unavailable: census.projection.unavailable,
        },
        preservedBlocks: census.preservedBlocks,
        preservedTaskLists: census.preservedTaskLists,
        cap: census.cap,
        skipped: census.skipped,
        truncated: census.truncated,
      }),
    ).toBeDefined();
  });
});
