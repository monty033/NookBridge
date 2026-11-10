/**
 * EA-4 — the census bucket a preserved note lands in.
 *
 * `tests/ea-2-edit-census.test.ts` asserts these buckets over the synthetic
 * corpus, but it starts a real daemon and so needs working encrypted SQLite.
 * These cases call the same classifier directly: the projection outcome, the
 * preserved-block count and the fallback are decided here, and nowhere else.
 */
import { describe, expect, it } from "vitest";

import { classifyNoteContentProjection } from "../src/service/note-content-projection.js";

const note = {
  id: "n_ea4_projection",
  title: "Synthetic",
  revision: `rev_${"a".repeat(32)}`,
  notebookId: "nb_ea4_projection",
};

const envelope = (data: string) =>
  ({ type: "tiptap", data: `<div data-type="document">${data}</div>` }) as const;

const classify = (data: string) =>
  classifyNoteContentProjection({
    contentRefusal: undefined,
    envelope: envelope(data),
    noteId: note.id,
    note,
    requestId: "req_ea4_projection",
  });

describe("EA-4 — a preserved heading is a strict projection with preserved blocks", () => {
  it("counts an opaque heading as strict_with_preserved_blocks, never the deleted fallback", () => {
    const result = classify('<h4><span style="color:red">Synthetic heading body</span></h4>');
    expect(result.outcome).toBe("strict_with_preserved_blocks");
    expect(result.preservedBlocks).toBe(1);
    expect(result).not.toHaveProperty("reason");
  });

  it("counts a structural separator the same way", () => {
    const result = classify("<hr>");
    expect(result.outcome).toBe("strict_with_preserved_blocks");
    expect(result.preservedBlocks).toBe(1);
  });

  it("counts both, which is the corpus total the census test expects", () => {
    // The two notes EA-4 moved out of `opaque_heading_fallback`: one heading and
    // one separator, two preserved blocks, no fallback.
    const heading = classify('<h4><span style="color:red">Synthetic heading body</span></h4>');
    const separator = classify("<hr>");
    const preserved = [heading, separator].filter(
      (result) => result.outcome === "strict_with_preserved_blocks",
    );
    expect(preserved).toHaveLength(2);
    expect(preserved.reduce((sum, result) => sum + result.preservedBlocks, 0)).toBe(2);
    expect(
      [heading, separator].filter((r) => r.outcome === "opaque_heading_fallback"),
    ).toHaveLength(0);
  });

  it("still falls back to the serializer for bytes the decoder refuses", () => {
    // A control character is hostile to the parser, so it is not a preserved
    // block: the note stays readable through the serializer and is counted as a
    // fallback, which is what the corpus numbers call `serializer_fallback`.
    const result = classify("<p>a\u0000b</p>");
    expect(result.outcome).toBe("serializer_fallback");
    expect(result.preservedBlocks).toBe(0);
  });
});
