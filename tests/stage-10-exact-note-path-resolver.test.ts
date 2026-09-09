import { describe, expect, it } from "vitest";

import {
  ExactNotePathError,
  resolveExactNotePath,
} from "../src/service/exact-note-path-resolver.js";

const notebooks = [
  { id: "outdoors", title: "Outdoors" },
  { id: "trips", title: "Canoe Trips", parentId: "outdoors" },
];

const revision = "rev_00000000000000000000000000000001";

function source(notes = [{ id: "canoe", title: "Canoe Trip", notebookId: "trips" }]) {
  return {
    notebooks,
    findNotesByTitle: async (title: string) =>
      notes.filter((note) => note.title === title).map((note) => ({ ...note })),
    noteMetadata: async (id: string) => {
      const note = notes.find((value) => value.id === id);
      return note === undefined ? undefined : { ...note, revision };
    },
  };
}

describe("exact note path resolver", () => {
  it("resolves a nested notebook path and revision", async () => {
    await expect(
      resolveExactNotePath("Outdoors/Canoe Trips/Canoe Trip", source()),
    ).resolves.toEqual({
      id: "canoe",
      expectedRevision: revision,
    });
  });

  it("rejects title-only, traversal, repeated-separator, and backslash paths", async () => {
    for (const path of [
      "Canoe Trip",
      "Outdoors/../Canoe Trip",
      "Outdoors//Canoe Trip",
      "Outdoors\\Canoe Trip",
    ]) {
      await expect(resolveExactNotePath(path, source())).rejects.toMatchObject({
        code: "invalid_path",
      });
    }
  });

  it("fails closed for missing and ambiguous exact matches", async () => {
    await expect(
      resolveExactNotePath("Outdoors/Canoe Trips/Missing", source()),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      resolveExactNotePath(
        "Outdoors/Canoe Trips/Canoe Trip",
        source([
          { id: "one", title: "Canoe Trip", notebookId: "trips" },
          { id: "two", title: "Canoe Trip", notebookId: "trips" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "ambiguous" });
  });

  it("rejects a path whose notebook casing is not exact", async () => {
    await expect(
      resolveExactNotePath("outdoors/Canoe Trips/Canoe Trip", source()),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not expose the supplied path in categorical errors", async () => {
    const secret = "Outdoors/secret-canary";
    let error: unknown;
    try {
      await resolveExactNotePath(secret, source());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ExactNotePathError);
    expect(String(error)).not.toContain(secret);
  });
});
