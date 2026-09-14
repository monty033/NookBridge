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
    findNoteIdsByNotebook: async (notebookId: string) =>
      notes.filter((note) => note.notebookId === notebookId).map((note) => note.id),
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

  it("resolves a slash-containing title when notebook and title are explicit", async () => {
    await expect(
      resolveExactNotePath(
        { notebookPath: "Outdoors/Canoe Trips", noteTitle: "Canoe/Trip" } as unknown as string,
        source([{ id: "canoe", title: "Canoe/Trip", notebookId: "trips" }]),
      ),
    ).resolves.toEqual({
      id: "canoe",
      expectedRevision: revision,
    });
  });

  it("resolves a root note from a title-only path", async () => {
    const rootSource = {
      notebooks,
      findNotesByTitle: async () => [{ id: "root-note", title: "Root Note" }],
      findNoteIdsByNotebook: async () => {
        throw new Error("root notes must not query notebook membership");
      },
      noteMetadata: async () => ({
        id: "root-note",
        title: "Root Note",
        revision,
      }),
    };

    await expect(resolveExactNotePath("Root Note", rootSource)).resolves.toEqual({
      id: "root-note",
      expectedRevision: revision,
    });
  });

  it("reuses a validated title-candidate revision when the second metadata read fails", async () => {
    const rootSource = {
      notebooks,
      findNotesByTitle: async () => [{ id: "root-note", title: "Root Note", revision }],
      findNoteIdsByNotebook: async () => [],
      noteMetadata: async () => {
        throw new Error("second metadata read is unavailable");
      },
    };

    await expect(resolveExactNotePath("Root Note", rootSource)).resolves.toEqual({
      id: "root-note",
      expectedRevision: revision,
    });
  });

  it("rejects a title-only path for a notebook note", async () => {
    await expect(resolveExactNotePath("Canoe Trip", source())).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects duplicate root-note titles as ambiguous", async () => {
    const duplicateRootSource = {
      notebooks,
      findNotesByTitle: async () => [
        { id: "root-one", title: "Root Note" },
        { id: "root-two", title: "Root Note" },
      ],
      findNoteIdsByNotebook: async () => [],
      noteMetadata: async () => undefined,
    };

    await expect(resolveExactNotePath("Root Note", duplicateRootSource)).rejects.toMatchObject({
      code: "ambiguous",
    });
  });

  it("ignores a same-title notebook note for a root-only path", async () => {
    const mixedSource = {
      notebooks,
      findNotesByTitle: async () => [
        { id: "root-note", title: "Root Note" },
        { id: "nested-note", title: "Root Note", notebookId: "trips" },
      ],
      findNoteIdsByNotebook: async () => [],
      noteMetadata: async (id: string) =>
        id === "root-note" ? { id, title: "Root Note", revision } : undefined,
    };

    await expect(resolveExactNotePath("Root Note", mixedSource)).resolves.toEqual({
      id: "root-note",
      expectedRevision: revision,
    });
  });

  it("rejects traversal, repeated-separator, and backslash paths", async () => {
    for (const path of ["Outdoors/../Canoe Trip", "Outdoors//Canoe Trip", "Outdoors\\Canoe Trip"]) {
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

  it("does not require notebook membership when the title index has no candidates", async () => {
    let membershipCalls = 0;
    const missingTitleSource = {
      notebooks,
      findNotesByTitle: async () => [],
      findNoteIdsByNotebook: async () => {
        membershipCalls += 1;
        throw new Error("live notebooks.notes failure");
      },
      noteMetadata: async () => undefined,
    };

    await expect(
      resolveExactNotePath("Outdoors/Canoe Trips/Definitely Missing", missingTitleSource),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(membershipCalls).toBe(0);
  });

  it("does not build notebook hierarchy when the title index has no candidates", async () => {
    const missingTitleSource = {
      notebooks: [{ id: "invalid id", title: "Outdoors" }],
      findNotesByTitle: async () => [],
      findNoteIdsByNotebook: async () => {
        throw new Error("membership must not be queried");
      },
      noteMetadata: async () => undefined,
    };

    await expect(
      resolveExactNotePath("Outdoors/Canoe Trips/Definitely Missing", missingTitleSource),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("uses validated notebook membership before live notebook enumeration", async () => {
    const candidateSource = {
      notebooks,
      findNotesByTitle: async () => [{ id: "canoe", title: "Canoe Trip", notebookId: "trips" }],
      findNoteIdsByNotebook: async () => {
        throw new Error("live notebooks.notes failure");
      },
      noteMetadata: async () => ({
        id: "canoe",
        title: "Canoe Trip",
        notebookId: "trips",
        revision,
      }),
    };

    await expect(
      resolveExactNotePath("Outdoors/Canoe Trips/Canoe Trip", candidateSource),
    ).resolves.toEqual({ id: "canoe", expectedRevision: revision });
  });

  it("resolves one exact candidate without enumerating an oversized notebook", async () => {
    let enumerationCalls = 0;
    let membershipCalls = 0;
    const candidateSource = {
      notebooks,
      findNotesByTitle: async () => [{ id: "canoe", title: "Canoe Trip", revision }],
      hasNoteInNotebook: async (notebookId: string, noteId: string) => {
        membershipCalls += 1;
        return notebookId === "trips" && noteId === "canoe";
      },
      findNoteIdsByNotebook: async () => {
        enumerationCalls += 1;
        return Array.from({ length: 257 }, (_, index) => `unrelated-${index}`);
      },
      noteMetadata: async () => ({ id: "canoe", title: "Canoe Trip", revision }),
    };

    await expect(
      resolveExactNotePath("Outdoors/Canoe Trips/Canoe Trip", candidateSource),
    ).resolves.toEqual({ id: "canoe", expectedRevision: revision });
    expect(membershipCalls).toBe(1);
    expect(enumerationCalls).toBe(0);
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
