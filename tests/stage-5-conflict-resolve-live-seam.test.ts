import { describe, expect, it } from "vitest";
import { buildLiveConflictResolveSeam } from "../src/core/notesnook-conflict-resolve-live.js";

/**
 * The live seam wraps the database's note row. The inspector reads `id`,
 * `conflicted` and `contentId` as OWN properties, so a wrapper that only
 * inherits them fails closed at inspection and can never reach a write. The
 * operator tests use plain-object fakes and never exercised this, so this file
 * drives the real wrapper with a class-backed row, the shape the live database
 * returns.
 */

class NoteRow {
  get id(): string {
    return "note-1";
  }
  get conflicted(): boolean {
    return true;
  }
  get contentId(): string {
    return "content-1";
  }
  get title(): string {
    return "Original";
  }
}

function liveDatabase(): object {
  return {
    notes: {
      note: (id: string) => (id === "note-1" ? new NoteRow() : null),
      add: async () => undefined,
    },
    content: {
      collection: { get: async () => undefined },
      add: async () => undefined,
    },
    relations: {
      from: () => ({ get: async () => [] }),
      add: async () => undefined,
    },
  };
}

describe("live conflict resolve seam", () => {
  it("exposes id, conflicted and contentId as own properties on the note wrapper", async () => {
    const seam = buildLiveConflictResolveSeam(liveDatabase(), () => undefined);
    expect(seam).toBeDefined();
    const meta = await seam!.noteMeta("note-1");
    expect(meta).toBeDefined();
    expect(Object.hasOwn(meta!, "id")).toBe(true);
    expect(Object.hasOwn(meta!, "conflicted")).toBe(true);
    expect(Object.hasOwn(meta!, "contentId")).toBe(true);
    expect(meta).toMatchObject({ id: "note-1", conflicted: true, contentId: "content-1" });
    expect((meta as { memberships: unknown[] }).memberships).toEqual([]);
  });

  it("keeps the class-backed title readable through the prototype link", async () => {
    const seam = buildLiveConflictResolveSeam(liveDatabase(), () => undefined);
    const meta = await seam!.noteMeta("note-1");
    expect((meta as { title: string }).title).toBe("Original");
  });
});
