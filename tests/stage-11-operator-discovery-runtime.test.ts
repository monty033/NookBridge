import { describe, expect, it } from "vitest";
import { createOperatorDiscoveryRuntime } from "../src/service/operator-discovery-runtime.js";

describe("daemon operator discovery runtime", () => {
  it("mints opaque handles and paginates source-side", async () => {
    const runtime = createOperatorDiscoveryRuntime({
      readOnly: {
        listNotes: async () => [
          { id: "raw-id-1", title: "One" },
          { id: "raw-id-2", title: "Two" },
        ],
      },
    } as unknown as Parameters<typeof createOperatorDiscoveryRuntime>[0]);
    const first = await runtime.browse({ limit: 1 });
    expect(first.notes).toHaveLength(1);
    expect(first.notes[0]?.handle).toMatch(/^h_[A-Za-z0-9_-]+$/);
    expect(first.notes[0]?.handle).not.toContain("raw-id-1");
    expect(first.next).toMatch(/^cur_/);
    const second = await runtime.browse({
      ...(first.next === null ? {} : { cursor: first.next }),
      limit: 1,
    });
    expect(second.notes[0]?.label).toBe("Two");
    expect(second.next).toBeNull();
  });

  it("resolves an opaque handle to bounded Markdown", async () => {
    const runtime = createOperatorDiscoveryRuntime({
      readOnly: {
        listNotes: async () => [{ id: "raw-note", title: "Body" }],
        noteMetadata: async () => ({
          id: "raw-note",
          title: "Body",
          revision: `rev_${"1".repeat(32)}`,
        }),
        readNoteContent: async () => ({
          type: "html",
          data: "<p>Hello <strong>world</strong></p>",
        }),
      },
    } as unknown as Parameters<typeof createOperatorDiscoveryRuntime>[0]);
    const page = await runtime.browse({ limit: 1 });
    const handle = page.notes[0]?.handle;
    if (handle === undefined) throw new Error("missing test handle");
    const view = await runtime.view?.({ id: handle });
    expect(view?.id).toBe(handle);
    expect(view?.markdown).toContain("Hello **world**");
    expect(view?.markdown).not.toContain("raw-note");
  });

  it("filters notebook search hits before minting note handles", async () => {
    const runtime = createOperatorDiscoveryRuntime({
      readOnly: {
        search: async () => [
          { id: "notebook-1", title: "Notebook", source: "notebook" },
          { id: "note-1", title: "Note", source: "note" },
        ],
      },
    } as unknown as Parameters<typeof createOperatorDiscoveryRuntime>[0]);
    const page = await runtime.search({ query: "n", limit: 10 });
    expect(page.notes.map((note) => note.label)).toEqual(["Note"]);
  });
});
