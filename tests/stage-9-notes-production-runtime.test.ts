import { describe, expect, it, vi } from "vitest";

import {
  createNotesCommandRuntimeFromReadOnly,
  createNotesOpaqueHandleCodec,
  createNotesReadSource,
} from "../src/operator/notes-production-runtime.js";
import type { NotesCategoricalResult } from "../src/operator/notes-cli.js";

function expectPage(result: NotesCategoricalResult) {
  if (result.kind !== "page") throw new Error(`expected page, got ${result.kind}`);
  return result;
}

function expectNote(result: NotesCategoricalResult) {
  if (result.kind !== "note") throw new Error(`expected note, got ${result.kind}`);
  return result;
}

describe("Stage 9 production read-only notes composition", () => {
  it("uses only the closed list/search/note metadata source surface", async () => {
    const search = vi.fn(async (query: string) => [
      { source: "note" as const, id: "note-1", title: `Match ${query}`, dateModified: 2 },
      { source: "notebook" as const, id: "notebook-1", title: "Do not expose" },
    ]);
    const source = createNotesReadSource({
      listNotes: async () => [{ id: "note-1", title: "First note", dateModified: 1 }],
      search,
      noteMetadata: async (id: string) =>
        id === "note-1" ? { id, title: "First note", dateModified: 1 } : undefined,
    });

    const listed = await source.list();
    expect(listed).toEqual([{ id: "note-1", title: "First note", dateModified: 1 }]);
    expect(await source.search("leaf")).toEqual([{ id: "note-1", title: "Match leaf" }]);
    expect(search).toHaveBeenCalledWith("leaf");
    expect(JSON.stringify(source)).not.toContain("notebook-1");
  });

  it("round-trips handles across codec instances without exposing the source id", () => {
    const first = createNotesOpaqueHandleCodec("stable local database key");
    const second = createNotesOpaqueHandleCodec("stable local database key");
    const handle = first.encode("note-1");

    expect(handle).toMatch(/^not_[A-Za-z0-9_-]+$/);
    expect(handle).not.toContain("note-1");
    expect(second.decode(handle)).toEqual({ kind: "ok", sourceId: "note-1" });
    expect(createNotesOpaqueHandleCodec("wrong key").decode(handle)).toEqual({ kind: "invalid" });
  });

  it("wires browse/search/get through the bounded runtime and never emits raw ids", async () => {
    const source = createNotesReadSource({
      listNotes: async () => [{ id: "note-1", title: "First note", dateModified: 1 }],
      search: async () => [{ source: "note", id: "note-1", title: "First note", dateModified: 1 }],
      noteMetadata: async (id: string) =>
        id === "note-1" ? { id, title: "First note", dateModified: 1 } : undefined,
    });
    const runtime = createNotesCommandRuntimeFromReadOnly(
      source,
      createNotesOpaqueHandleCodec("stable local database key"),
    );

    const browse = expectPage(await runtime.browse({ limit: 10 }));
    expect(browse.notes).toHaveLength(1);
    const handle = browse.notes[0]?.handle;
    expect(handle).toMatch(/^not_[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(browse)).not.toContain("note-1");

    const search = expectPage(await runtime.search({ query: "leaf" }));
    expect(search.notes[0]?.handle).toMatch(/^not_[A-Za-z0-9_-]+$/);

    const note = expectNote(await runtime.get({ handle: handle as string }));
    expect(note.content).toEqual({ label: "First note", bytes: 10 });
    expect(JSON.stringify(note)).not.toContain("note-1");
  });

  it("returns categorical unavailable results for mutation methods", async () => {
    const runtime = createNotesCommandRuntimeFromReadOnly(
      createNotesReadSource({
        listNotes: async () => [],
        search: async () => [],
        noteMetadata: async () => undefined,
      }),
      createNotesOpaqueHandleCodec("stable local database key"),
    );

    await expect(runtime.edit({ handle: "not_handle" })).resolves.toEqual({
      kind: "error",
      exitCode: 3,
      message: "nookctl notes: runtime unavailable",
    });
    await expect(runtime.undo()).resolves.toEqual({
      kind: "error",
      exitCode: 3,
      message: "nookctl notes: runtime unavailable",
    });
  });
});
