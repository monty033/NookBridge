/**
 * A note with a title and no body is deletable through the same write seam as
 * any other note (issue #308).
 *
 * Core reads rows with `select *`, so a note created without content comes back
 * with `contentId: null` rather than an absent key.  The write wiring used to
 * reject that `null` as a malformed identifier, which surfaced as
 * `invalid_input` before the revision, lock and conflict guards ever ran.
 *
 * Removing that accidental refusal must not turn a locked note into a deletable
 * one, so the seam asks two questions before calling a bodyless note unlocked:
 * does the note still name a content row (its body has not arrived), and does a
 * Vault link point at it?  Core stores a Vault lock as a link from the vault to
 * the note, so the fixtures put vault, notebook and tag rows in `relations.to`
 * and leave `relations.from` empty by default — a probe that asks the wrong
 * direction cannot pass.
 *
 * Everything here is offline: a structural runtime stands in for core and
 * nothing touches disk, the network, or live state.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createNotesnookWriteAdapter,
  isNotesnookWriteAdapterError,
} from "../src/core/notesnook-write-adapter.js";
import { DETERMINISTIC_MARKDOWN_CODEC } from "../src/core/notesnook-write-codec.js";
import {
  isNotesnookWriteContractError,
  type NotesnookRevisionToken,
  type NotesnookWriteErrorCode,
} from "../src/core/notesnook-write-contract.js";
import {
  bindNotesnookWriteRuntime,
  type NotesnookWriteRuntime,
} from "../src/core/notesnook-write-wiring.js";

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const VAULT_ID = "1111111111111111111111111111aaaa";
const NOTEBOOK_ID = "2222222222222222222222222222bbbb";
const TAG_ID = "3333333333333333333333333333cccc";
const DATE_EDITED = 1_700_000_000_000;

function revisionToken(id: string, dateEdited: number): NotesnookRevisionToken {
  const hex = createHash("sha256")
    .update(`${id}\u0000${dateEdited}\u0000${0}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `rev_${hex}` as NotesnookRevisionToken;
}

/** One link row, in the shape core stores it: `from` → `to`. */
function link(
  fromId: string,
  fromType: string,
  toId: string,
  toType: string,
): Record<string, unknown> {
  return { fromId, fromType, toId, toType };
}

interface RuntimeShape {
  /** The note record exactly as core hands it back. */
  readonly note: Record<string, unknown>;
  /** What `content.findByNoteId` does; defaults to "no content record". */
  readonly findByNoteId?: () => Promise<unknown>;
  /** Rows that point AT the note; defaults to none. */
  readonly linksToNote?: () => unknown;
  /** Rows returned regardless of the query, modelling a runtime that over-returns. */
  readonly rawLinksToNote?: () => unknown;
  /** Rows that start AT the note; defaults to none. */
  readonly linksFromNote?: () => unknown;
}

function createRuntime(shape: RuntimeShape): {
  runtime: NotesnookWriteRuntime;
  trashed: string[];
  updates: Array<Record<string, unknown>>;
  toCalls: Array<{ reference: { id: string; type: string }; type: string | undefined }>;
} {
  const trashed: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const toCalls: Array<{ reference: { id: string; type: string }; type: string | undefined }> = [];
  const runtime = {
    notes: {
      note: async (id: string) => (id === NOTE_ID ? { ...shape.note } : undefined),
      add: async () => {
        throw new Error("unexpected add");
      },
      addToNotebook: async () => undefined,
      removeFromNotebook: async () => undefined,
      moveToTrash: async (...ids: string[]) => {
        trashed.push(...ids);
      },
      collection: {
        update: async (_ids: string[], partial: Record<string, unknown>) => {
          updates.push(partial);
        },
      },
    },
    content: {
      add: async () => "content-1",
      findByNoteId: shape.findByNoteId ?? (async () => undefined),
      updateByNoteId: async () => undefined,
    },
    notebooks: { exists: async () => false, notes: async () => [] },
    tags: { tag: async () => undefined, add: async () => "tag-1" },
    relations: {
      add: async () => undefined,
      unlink: async () => undefined,
      from: () => ({ get: async () => shape.linksFromNote?.() ?? [] }),
      // `to` is the only direction that can see a vault → note lock, so the fake
      // applies the same filter core does.  A probe that asks the wrong
      // reference, the wrong type or the wrong direction gets nothing back, and
      // the tests below fail.
      to: (reference: { readonly id: string; readonly type: string }, type?: string) => ({
        get: async () => {
          toCalls.push({ reference: { ...reference }, type });
          if (shape.rawLinksToNote !== undefined) return shape.rawLinksToNote();
          const rows: unknown = shape.linksToNote?.() ?? [];
          if (!Array.isArray(rows)) return rows;
          return rows.filter((row: unknown) => {
            if (typeof row !== "object" || row === null) return false;
            const record = row as Record<string, unknown>;
            return (
              record.toId === reference.id &&
              record.toType === reference.type &&
              (type === undefined || record.fromType === type)
            );
          });
        },
      }),
    },
  } as unknown as NotesnookWriteRuntime;
  return { runtime, trashed, updates, toCalls };
}

/** A root-level title-only note, as a phone creates it and core reads it back. */
function bodylessNote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: NOTE_ID,
    title: "Restart canary 1",
    contentId: null,
    pinned: false,
    favorite: false,
    conflicted: false,
    dateEdited: DATE_EDITED,
    ...overrides,
  };
}

function adapterFor(runtime: NotesnookWriteRuntime) {
  return createNotesnookWriteAdapter({
    source: bindNotesnookWriteRuntime(runtime),
    codec: DETERMINISTIC_MARKDOWN_CODEC,
  });
}

/**
 * `"ok"` or the categorical code the write refused with.  Asserting on a plain
 * string keeps a failing case readable: the adapter's errors are frozen, which
 * the test reporter cannot annotate.
 */
async function codeOf(fn: () => Promise<unknown>): Promise<NotesnookWriteErrorCode | "ok"> {
  try {
    await fn();
    return "ok";
  } catch (error) {
    if (!isNotesnookWriteAdapterError(error) && !isNotesnookWriteContractError(error)) {
      throw new Error("expected a categorical write error");
    }
    return (error as unknown as { code: NotesnookWriteErrorCode }).code;
  }
}

function deleteNote(runtime: NotesnookWriteRuntime, dateEdited = DATE_EDITED) {
  return codeOf(() =>
    adapterFor(runtime).deleteNote({
      id: NOTE_ID,
      expectedRevision: revisionToken(NOTE_ID, dateEdited),
    }),
  );
}

describe("deleting a note that has a title and no body", () => {
  it("deletes a note whose contentId is null and which has no content record", async () => {
    const { runtime, trashed } = createRuntime({ note: bodylessNote() });

    expect(await deleteNote(runtime)).toBe("ok");
    expect(trashed).toEqual([NOTE_ID]);
  });

  it("still deletes a note that omits contentId entirely", async () => {
    const note = bodylessNote();
    delete note.contentId;
    const { runtime, trashed } = createRuntime({ note });

    expect(await deleteNote(runtime)).toBe("ok");
    expect(trashed).toEqual([NOTE_ID]);
  });

  it("keeps the revision guard: a stale revision refuses with stale_revision", async () => {
    const { runtime, trashed } = createRuntime({ note: bodylessNote() });

    expect(await deleteNote(runtime, DATE_EDITED - 1)).toBe("stale_revision");
    expect(trashed).toEqual([]);
  });

  it("refuses a bodyless note whose content lookup reports a Vault lock", async () => {
    const { runtime, trashed } = createRuntime({
      note: bodylessNote(),
      findByNoteId: async () => {
        throw new Error("ERR_VAULT_LOCKED");
      },
    });

    expect(await deleteNote(runtime)).toBe("vault_locked");
    expect(trashed).toEqual([]);
  });

  it("refuses a bodyless note carrying a locked marker with vault_locked", async () => {
    const { runtime, trashed } = createRuntime({ note: bodylessNote({ locked: true }) });

    expect(await deleteNote(runtime)).toBe("vault_locked");
    expect(trashed).toEqual([]);
  });

  it("refuses a conflicted bodyless note with conflict", async () => {
    const { runtime, trashed } = createRuntime({ note: bodylessNote({ conflicted: true }) });

    expect(await deleteNote(runtime)).toBe("conflict");
    expect(trashed).toEqual([]);
  });

  it("refuses a bodyless note that a vault links to", async () => {
    // The lock core writes: vault → note.  A note-to-vault row is not a shape
    // this database produces, so the fixture uses the real direction.
    const { runtime, trashed } = createRuntime({
      note: bodylessNote(),
      linksToNote: () => [link(VAULT_ID, "vault", NOTE_ID, "note")],
    });

    expect(await deleteNote(runtime)).toBe("vault_locked");
    expect(trashed).toEqual([]);
  });

  it("ignores a note-to-vault row, which is not how core stores a lock", async () => {
    // Proves the probe asks `relations.to`: a row leaving the note says nothing
    // about a lock on it.
    const { runtime, trashed } = createRuntime({
      note: bodylessNote(),
      linksFromNote: () => [link(NOTE_ID, "note", VAULT_ID, "vault")],
    });

    expect(await deleteNote(runtime)).toBe("ok");
    expect(trashed).toEqual([NOTE_ID]);
  });

  it("still deletes a bodyless note whose only incoming links are notebook and tag", async () => {
    const { runtime, trashed } = createRuntime({
      note: bodylessNote(),
      linksToNote: () => [
        link(NOTEBOOK_ID, "notebook", NOTE_ID, "note"),
        link(TAG_ID, "tag", NOTE_ID, "note"),
      ],
    });

    expect(await deleteNote(runtime)).toBe("ok");
    expect(trashed).toEqual([NOTE_ID]);
  });

  it("refuses a bodyless note when the Vault probe cannot answer", async () => {
    const { runtime, trashed } = createRuntime({
      note: bodylessNote(),
      linksToNote: () => {
        throw new Error("relations unavailable");
      },
    });

    expect(await deleteNote(runtime)).toBe("vault_locked");
    expect(trashed).toEqual([]);
  });

  it("refuses a note that names content whose row has not arrived", async () => {
    // The read side calls this undecidable; the write side must not treat it as
    // unlocked and delete a note whose body it cannot see.
    const { runtime, trashed } = createRuntime({
      note: bodylessNote({ contentId: "content-1" }),
    });

    expect(await deleteNote(runtime)).toBe("sync_required");
    expect(trashed).toEqual([]);
  });

  it("refuses a content-bearing note that reads locked:false but is Vault-linked", async () => {
    // The exact case in the issue: a readable record that says it is unlocked.
    const { runtime, trashed } = createRuntime({
      note: bodylessNote({ contentId: "content-1" }),
      findByNoteId: async () => ({
        id: "content-1",
        noteId: NOTE_ID,
        data: "<p>x</p>",
        locked: false,
      }),
      linksToNote: () => [link(VAULT_ID, "vault", NOTE_ID, "note")],
    });

    expect(await deleteNote(runtime)).toBe("vault_locked");
    expect(trashed).toEqual([]);
  });

  it("refuses a content-bearing note when the Vault probe cannot answer", async () => {
    // Same fail-closed rule the read side applies: no answer is not "unlocked".
    const { runtime, trashed } = createRuntime({
      note: bodylessNote({ contentId: "content-1" }),
      findByNoteId: async () => ({
        id: "content-1",
        noteId: NOTE_ID,
        data: "<p>x</p>",
        locked: false,
      }),
      linksToNote: () => {
        throw new Error("relations unavailable");
      },
    });

    expect(await deleteNote(runtime)).toBe("vault_locked");
    expect(trashed).toEqual([]);
  });

  it("lets a note-level locked marker beat an unlocked content record", async () => {
    // The read side already treats the note marker as strictest, so the write
    // side cannot call this note unlocked.
    const { runtime, trashed } = createRuntime({
      note: bodylessNote({ contentId: "content-1", locked: true }),
      findByNoteId: async () => ({
        id: "content-1",
        noteId: NOTE_ID,
        data: "<p>x</p>",
        locked: false,
      }),
    });

    expect(await deleteNote(runtime)).toBe("vault_locked");
    expect(trashed).toEqual([]);
  });

  it("lets the note's legacy locked:false marker decide when the content record has none", async () => {
    // The read side calls this unlocked, so the write seam must not refuse it.
    const { runtime, trashed } = createRuntime({
      note: bodylessNote({ contentId: "content-1", locked: false }),
      findByNoteId: async () => ({ id: "content-1", noteId: NOTE_ID, data: "<p>x</p>" }),
      linksToNote: () => [],
    });

    expect(await deleteNote(runtime)).toBe("ok");
    expect(trashed).toEqual([NOTE_ID]);
  });

  it("refuses when neither record carries a lock marker and no Vault link answers", async () => {
    // Undecidable on the read side; a mutation must not treat it as unlocked.
    const { runtime, trashed } = createRuntime({
      note: bodylessNote({ contentId: "content-1" }),
      findByNoteId: async () => ({ id: "content-1", noteId: NOTE_ID, data: "<p>x</p>" }),
      linksToNote: () => [],
    });

    expect(await deleteNote(runtime)).toBe("vault_locked");
    expect(trashed).toEqual([]);
  });

  it("still deletes a note with a content row and no Vault link", async () => {
    const { runtime, trashed } = createRuntime({
      note: bodylessNote({ contentId: "content-1" }),
      findByNoteId: async () => ({
        id: "content-1",
        noteId: NOTE_ID,
        data: "<p>x</p>",
        locked: false,
      }),
      linksToNote: () => [],
    });

    expect(await deleteNote(runtime)).toBe("ok");
    expect(trashed).toEqual([NOTE_ID]);
  });

  it("deletes a note whose contentId is null although a content row exists", async () => {
    const { runtime, trashed } = createRuntime({
      note: bodylessNote(),
      findByNoteId: async () => ({
        id: "content-1",
        noteId: NOTE_ID,
        data: "<p>x</p>",
        locked: false,
      }),
    });

    expect(await deleteNote(runtime)).toBe("ok");
    expect(trashed).toEqual([NOTE_ID]);
  });

  it("asks core for incoming vault links on this note, and only those", async () => {
    const { runtime, toCalls } = createRuntime({
      note: bodylessNote(),
      linksToNote: () => [link(VAULT_ID, "vault", NOTE_ID, "note")],
    });

    expect(await deleteNote(runtime)).toBe("vault_locked");
    expect(toCalls).toEqual([{ reference: { id: NOTE_ID, type: "note" }, type: "vault" }]);
  });

  it("refuses when the runtime cannot answer the incoming-link query", async () => {
    // A runtime that predates the probe cannot prove the note unlocked.
    const { runtime, trashed } = createRuntime({ note: bodylessNote() });
    const relations = (runtime as unknown as { relations: Record<string, unknown> }).relations;
    delete relations.to;

    expect(await deleteNote(runtime)).toBe("vault_locked");
    expect(trashed).toEqual([]);
  });

  it("refuses a link row that does not actually end at this note", async () => {
    // A runtime that ignores the query and hands back someone else's notebook
    // link cannot be read as "no lock on this note": the row proves the query is
    // not the one we asked for, so the answer is not trustworthy either way.
    const { runtime, trashed } = createRuntime({
      note: bodylessNote(),
      rawLinksToNote: () => [
        link(NOTEBOOK_ID, "notebook", "ffffffffffffffffffffffffffffffff", "note"),
      ],
    });

    expect(await deleteNote(runtime)).toBe("vault_locked");
    expect(trashed).toEqual([]);
  });

  it("now allows a metadata-only update on a title-only note", async () => {
    // Title, pinned, favorite and notebook changes do not need the body.  This
    // used to fail with invalid_input by accident; it is deliberately allowed
    // now, and only content operations refuse.
    const { runtime, updates } = createRuntime({ note: bodylessNote() });

    const code = await codeOf(() =>
      adapterFor(runtime).updateNote({
        id: NOTE_ID,
        expectedRevision: revisionToken(NOTE_ID, DATE_EDITED),
        patch: { title: "Renamed canary" },
      }),
    );

    expect(code).toBe("ok");
    expect(updates).toEqual([{ title: "Renamed canary" }]);
  });
});
