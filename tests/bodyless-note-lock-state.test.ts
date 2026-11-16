/**
 * A note with a title and no body has no content record, so there is no lock
 * flag to read. It is genuinely empty only when three metadata signals agree:
 * no content record, no `contentId` on the note, and zero vault links. Anything
 * short of that is undecidable and must still throw, because "no content
 * record" also describes a locked note whose content has not arrived.
 */

import { describe, expect, it } from "vitest";

import {
  flattenLiveDatabaseToReadOnly,
  isNotesnookReadOnlyProjectionError,
} from "../src/core/notesnook-readonly-projection.js";
import { LIVE_CONTENT, makeFakeCore, type FakeNote } from "./helpers/bodyless-fake-core.js";

function projectionFor(
  note: Partial<FakeNote>,
  extra: Parameters<typeof makeFakeCore>[0]["relationsTo"] | "none" = undefined,
) {
  const core = makeFakeCore({
    notes: [{ id: "n1", title: "Empty", ...note }],
    ...(typeof extra === "function" ? { relationsTo: extra } : {}),
    ...(extra === "none" ? { omitRelations: true } : {}),
  });
  return flattenLiveDatabaseToReadOnly(core as never);
}

async function lockState(note: Partial<FakeNote>) {
  return projectionFor(note).readNoteLockState!("n1");
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("bodyless note lock state — three-signal rule", () => {
  it("1. no content record, no contentId, zero vault links is unlocked", async () => {
    await expect(lockState({})).resolves.toBe("unlocked");
  });

  it("1b. a null contentId counts as no contentId", async () => {
    await expect(lockState({ contentId: null })).resolves.toBe("unlocked");
  });

  it("2. no content record, no contentId, one vault link is locked", async () => {
    await expect(lockState({ vaultLinks: 1 })).resolves.toBe("locked");
  });

  it("3. no content record but a contentId set still throws (content not yet arrived)", async () => {
    const error = await rejection(lockState({ contentId: "content-1" }));
    expect(isNotesnookReadOnlyProjectionError(error)).toBe(true);
  });

  it("3b. a malformed contentId throws rather than being read as absent", async () => {
    for (const contentId of [0, 1, false, true, {}, [], ""]) {
      const error = await rejection(lockState({ contentId }));
      expect(
        isNotesnookReadOnlyProjectionError(error),
        `contentId=${JSON.stringify(contentId)}`,
      ).toBe(true);
    }
  });

  describe("4. the vault-link probe must answer well", () => {
    const cases: Array<[string, Parameters<typeof makeFakeCore>[0]["relationsTo"] | "none"]> = [
      ["relations slot missing", "none"],
      [
        "relations.to missing",
        () => {
          throw new Error("unused");
        },
      ],
      [
        "relations.to throws",
        () => {
          throw new Error("boom");
        },
      ],
      ["count() rejects", () => ({ count: async () => Promise.reject(new Error("boom")) })],
      ["count() returns -1", () => ({ count: async () => -1 })],
      ["count() returns a non-integer", () => ({ count: async () => 1.5 })],
      ["count() returns NaN", () => ({ count: async () => Number.NaN })],
      ["count() returns a string", () => ({ count: async () => "0" })],
      ["count() returns undefined", () => ({ count: async () => undefined })],
      ["count is not a function", () => ({ count: 0 })],
      ["to() returns a primitive", () => 0],
      ["to() returns null", () => null],
    ];
    for (const [label, probe] of cases) {
      it(`throws when ${label}`, async () => {
        const core =
          label === "relations.to missing"
            ? makeFakeCore({ notes: [{ id: "n1", title: "Empty" }], omitRelationsTo: true })
            : probe === "none"
              ? makeFakeCore({ notes: [{ id: "n1", title: "Empty" }], omitRelations: true })
              : makeFakeCore({
                  notes: [{ id: "n1", title: "Empty" }],
                  relationsTo: probe as (reference: unknown, type: unknown) => unknown,
                });
        const projection = flattenLiveDatabaseToReadOnly(core as never);
        const error = await rejection(projection.readNoteLockState!("n1"));
        expect(isNotesnookReadOnlyProjectionError(error)).toBe(true);
      });
    }

    it("a note that names content but is Vault-linked is locked, not undecidable", async () => {
      const core = makeFakeCore({
        notes: [{ id: "n1", title: "Pending", contentId: "content-1", vaultLinks: 1 }],
      });
      await expect(
        flattenLiveDatabaseToReadOnly(core as never).readNoteLockState!("n1"),
      ).resolves.toBe("locked");
    });

    it("an unprobed content record with a false marker stays undecided", async () => {
      // No way to read content: the deprecated marker must not decide.
      const core = makeFakeCore({
        notes: [{ id: "n1", title: "Unknown", locked: false }],
        omitContentFind: true,
      });
      await expect(
        flattenLiveDatabaseToReadOnly(core as never).readNoteLockState!("n1"),
      ).rejects.toThrow(/relations|lock state/i);
    });

    it("throws when the vault probe cannot answer", async () => {
      const bad: unknown[] = [
        {},
        { count: "0" },
        { count: async () => -1 },
        { count: async () => "0" },
        { count: async () => Number.NaN },
        {
          count: async () => {
            throw new Error("boom");
          },
        },
      ];
      for (const probe of bad) {
        const core = makeFakeCore({
          notes: [{ id: "n1", title: "Empty" }],
          relationsTo: () => probe as { count: () => Promise<number> },
        });
        const projection = flattenLiveDatabaseToReadOnly(core as never);
        // Lock state cannot decide, so it refuses: never "unlocked".
        await expect(projection.readNoteLockState!("n1")).rejects.toThrow(/lock state/i);
        // Metadata makes no claim either.
        await expect(projection.noteMetadata!("n1")).resolves.not.toMatchObject({ locked: true });
        // And the presence probe refuses outright rather than guessing "bodyless".
        await expect(projection.readNoteBodyPresence!("n1")).rejects.toThrow(/relations/i);
      }
    });

    it("a deprecated locked:false marker cannot loosen the no-content rule", async () => {
      // The note-level marker is deprecated and never stored by core, so it
      // may only make the answer stricter.
      const records: unknown[] = [
        { id: "n1", title: "Pending", locked: false, contentId: "content-1" },
      ];
      const pending = makeFakeCore({ notes: records as never });
      await expect(
        flattenLiveDatabaseToReadOnly(pending as never).readNoteLockState!("n1"),
      ).rejects.toThrow(/lock state/i);

      const linked = makeFakeCore({
        notes: [{ id: "n1", title: "Linked", locked: false, vaultLinks: 1 }],
      });
      await expect(
        flattenLiveDatabaseToReadOnly(linked as never).readNoteLockState!("n1"),
      ).resolves.toBe("locked");
    });

    it("asks the vault probe about this note, as a note reference", async () => {
      const seen: unknown[][] = [];
      const core = makeFakeCore({
        notes: [{ id: "n1", title: "Empty" }],
        relationsTo: (reference, type) => {
          seen.push([reference, type]);
          return { count: async () => 0 };
        },
      });
      await flattenLiveDatabaseToReadOnly(core as never).readNoteLockState!("n1");
      expect(seen).toEqual([[{ id: "n1", type: "note" }, "vault"]]);
    });
  });

  it("a true marker alone is enough to be locked", async () => {
    // No content record, no contentId, no Vault link: only the marker says
    // locked.  Discovery must not admit the note.
    const core = makeFakeCore({ notes: [{ id: "n1", title: "Marked", locked: true }] });
    const projection = flattenLiveDatabaseToReadOnly(core as never);
    await expect(projection.readNoteLockState!("n1")).resolves.toBe("locked");
    await expect(projection.noteMetadata!("n1")).resolves.toMatchObject({ locked: true });
    await expect(projection.readNoteBodyPresence!("n1")).resolves.toBe("content");
  });

  it("metadata reports locked for a Vault-linked note with no content", async () => {
    const core = makeFakeCore({ notes: [{ id: "n1", title: "Locked", vaultLinks: 1 }] });
    const projection = flattenLiveDatabaseToReadOnly(core as never);
    await expect(projection.readNoteLockState!("n1")).resolves.toBe("locked");
    await expect(projection.noteMetadata!("n1")).resolves.toMatchObject({ locked: true });
  });

  it("a true marker beats a readable content record, so nothing can disagree", async () => {
    // A readable record saying locked:false and a note marker saying true is
    // unreachable in core (the marker is never stored), but if a caller saw
    // both the stricter answer has to win everywhere.
    const core = makeFakeCore({
      notes: [{ id: "n1", title: "Contradiction", locked: true, content: LIVE_CONTENT }],
    });
    const projection = flattenLiveDatabaseToReadOnly(core as never);
    await expect(projection.readNoteLockState!("n1")).resolves.toBe("locked");
    await expect(projection.noteMetadata!("n1")).resolves.toMatchObject({ locked: true });
    await expect(projection.readNoteBodyPresence!("n1")).resolves.toBe("content");
  });

  describe("5. content-present behaviour is unchanged", () => {
    it("a content record with locked:false is unlocked, whatever the other signals say", async () => {
      await expect(lockState({ content: LIVE_CONTENT })).resolves.toBe("unlocked");
      await expect(
        lockState({ content: LIVE_CONTENT, contentId: "content-1", vaultLinks: 3 }),
      ).resolves.toBe("unlocked");
    });

    it("a content record with locked:true is locked", async () => {
      await expect(
        lockState({ content: { type: "tiptap", data: "x", locked: true } }),
      ).resolves.toBe("locked");
    });

    it("a cipher record is locked", async () => {
      await expect(
        lockState({ content: { type: "tiptap", data: { cipher: "c", iv: "i", salt: "s" } } }),
      ).resolves.toBe("locked");
    });

    it("a content record with no lock flag still falls back to the note's own marker", async () => {
      await expect(
        lockState({ content: { type: "tiptap", data: "x" }, locked: true }),
      ).resolves.toBe("locked");
      await expect(
        lockState({ content: { type: "tiptap", data: "x" }, locked: false }),
      ).resolves.toBe("unlocked");
    });

    it("a content record with no lock flag and no note marker still throws, even if all three bodyless signals would hold", async () => {
      const error = await rejection(lockState({ content: { type: "tiptap", data: "x" } }));
      expect(isNotesnookReadOnlyProjectionError(error)).toBe(true);
    });

    it("never consults the vault probe when a content record exists", async () => {
      let probed = 0;
      const core = makeFakeCore({
        notes: [{ id: "n1", title: "Full", content: LIVE_CONTENT }],
        relationsTo: () => {
          probed += 1;
          return { count: async () => 0 };
        },
      });
      await flattenLiveDatabaseToReadOnly(core as never).readNoteLockState!("n1");
      expect(probed).toBe(0);
    });
  });
});

describe("readNoteBodyPresence", () => {
  const presence = (note: Partial<FakeNote>) => projectionFor(note).readNoteBodyPresence!("n1");

  it("is bodyless only when all three signals hold", async () => {
    await expect(presence({})).resolves.toBe("bodyless");
    await expect(presence({ contentId: null })).resolves.toBe("bodyless");
  });

  it("is content when a content record exists", async () => {
    await expect(presence({ content: LIVE_CONTENT })).resolves.toBe("content");
  });

  it("is content when the note carries a contentId", async () => {
    await expect(presence({ contentId: "content-1" })).resolves.toBe("content");
  });

  it("is content when the note has a vault link", async () => {
    await expect(presence({ vaultLinks: 1 })).resolves.toBe("content");
  });

  it("is content when the note carries a locked marker", async () => {
    await expect(presence({ locked: true })).resolves.toBe("content");
  });

  it("is content, never bodyless, when the content probe cannot run", async () => {
    const unprobed = flattenLiveDatabaseToReadOnly(
      makeFakeCore({ notes: [{ id: "n1", title: "Unknown" }], omitContentFind: true }) as never,
    );
    await expect(unprobed.readNoteBodyPresence!("n1")).resolves.toBe("content");
  });

  it("throws when the vault probe is missing or bad", async () => {
    const missing = flattenLiveDatabaseToReadOnly(
      makeFakeCore({ notes: [{ id: "n1", title: "Empty" }], omitRelations: true }) as never,
    );
    expect(
      isNotesnookReadOnlyProjectionError(await rejection(missing.readNoteBodyPresence!("n1"))),
    ).toBe(true);
    const bad = flattenLiveDatabaseToReadOnly(
      makeFakeCore({
        notes: [{ id: "n1", title: "Empty" }],
        relationsTo: () => ({ count: async () => -1 }),
      }) as never,
    );
    expect(
      isNotesnookReadOnlyProjectionError(await rejection(bad.readNoteBodyPresence!("n1"))),
    ).toBe(true);
  });
});
