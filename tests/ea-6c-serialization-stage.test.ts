import { describe, expect, it } from "vitest";

import type { NoteDocumentV1 } from "../src/core/note-document.js";
import { serializeNoteDocumentMarkdown } from "../src/core/note-document-markdown.js";
import { classifyNoteContentProjection } from "../src/service/note-content-projection.js";

const note = {
  id: "n_ea6c",
  title: "Synthetic",
  revision: `rev_${"a".repeat(32)}`,
};

const envelope = (data: string) => ({
  type: "tiptap" as const,
  data: `<div data-type="document">${data}</div>`,
});

function thrownBySerialize(document: NoteDocumentV1): unknown {
  try {
    serializeNoteDocumentMarkdown(document);
  } catch (error) {
    return error;
  }
  throw new Error("expected serialization refusal");
}

describe("EA-6c — serializer refusal stage is content-free", () => {
  it("distinguishes document validation from the round-trip check", () => {
    const invalidDocument = {
      version: 1,
      blocks: [{ type: "horizontal-rule", unexpected: true }],
    } as unknown as NoteDocumentV1;
    const validationError = thrownBySerialize(invalidDocument) as {
      code?: string;
      serializationStage?: string;
    };

    const roundTripDocument: NoteDocumentV1 = {
      version: 1,
      blocks: [{ type: "bullet-list", items: [] }],
    };
    const roundTripError = thrownBySerialize(roundTripDocument) as {
      code?: string;
      serializationStage?: string;
    };

    expect(validationError).toMatchObject({
      code: "invalid_shape",
      serializationStage: "validation",
    });
    expect(roundTripError).toMatchObject({
      code: "invalid_shape",
      serializationStage: "round_trip",
    });
    expect(JSON.stringify([validationError, roundTripError])).not.toContain("unexpected");
    expect(JSON.stringify([validationError, roundTripError])).not.toContain("c#");
  });

  it("carries the stage through the projection without exposing it on normal reads", () => {
    const result = classifyNoteContentProjection({
      contentRefusal: undefined,
      envelope: envelope('<p><a href="https://example.com/a(b)">x</a></p>'),
      noteId: note.id,
      note,
      requestId: "req_ea6c",
    });
    expect(result).toMatchObject({
      outcome: "serializer_fallback",
      serializationReason: "malformed_link",
      serializationStage: "markdown_emission",
    });
  });
});
