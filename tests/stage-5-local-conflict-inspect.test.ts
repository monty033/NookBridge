/**
 * Stage 5 — offline tests for the read-only conflict inspection capability.
 *
 * The injected source supplies `notes.note(id)` and a pure by-id content
 * reader only. Each test records the upstream calls it made, so any mutating
 * or unexpected call shows up as an extra entry.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createNotesnookLocalConflictInspector,
  isNotesnookLocalConflictProjectionError,
  type NotesnookConflictInspection,
  type NotesnookLocalConflictInspectSource,
} from "../src/core/notesnook-local-conflict-projection.js";

const LOCAL_BODY = '<p data-block-id="l1">local edit</p>';
const REMOTE_BODY = '<p data-block-id="r1">remote edit</p>';
const REMOTE_WITH_ATTACHMENT =
  '<p data-block-id="r1">remote <img data-hash="att-1" data-mime="image/png"></p>';
const CIPHER = { cipher: "ciphertext", iv: "initialisation", salt: "salt", length: 10 };

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function remoteSide(data: unknown = REMOTE_BODY, overrides: Record<string, unknown> = {}) {
  return {
    id: "content-1",
    noteId: "note-1",
    type: "tiptap",
    locked: false,
    data,
    dateModified: 2_000,
    ...overrides,
  };
}

function contentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "content-1",
    noteId: "note-1",
    type: "tiptap",
    locked: false,
    data: LOCAL_BODY,
    dateModified: 1_000,
    conflicted: remoteSide(),
    ...overrides,
  };
}

function conflictedNote(overrides: Record<string, unknown> = {}) {
  return {
    id: "note-1",
    title: "Conflicted note",
    contentId: "content-1",
    conflicted: true,
    ...overrides,
  };
}

function inspectorFor(note: unknown, content?: unknown) {
  const calls: string[] = [];
  const source: NotesnookLocalConflictInspectSource = {
    notes: {
      note: async (id: string) => {
        calls.push(`note:${id}`);
        return note;
      },
    },
    contentWithConflicted: {
      get: async (id: string) => {
        calls.push(`content:${id}`);
        return content;
      },
    },
  };
  return { calls, inspector: createNotesnookLocalConflictInspector(source) };
}

async function bindingOf(note: unknown, content: unknown, id = "note-1"): Promise<string> {
  const result = await inspectorFor(note, content).inspector.inspectConflict(id);
  if (result.outcome !== "inspected") throw new Error(`expected inspected, got ${result.outcome}`);
  return result.binding;
}

function outcomeLabel(result: NotesnookConflictInspection): string {
  switch (result.outcome) {
    case "not-conflicted":
      return "clear";
    case "not-found":
      return "missing";
    case "unreadable":
      return "unreadable";
    case "inspected":
      return "inspected";
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

describe("Stage 5 local conflict inspection", () => {
  it("exposes only the read-only inspectConflict method", () => {
    const { inspector } = inspectorFor(conflictedNote());

    expect(Object.getOwnPropertyNames(inspector)).toEqual(["inspectConflict"]);
    expect(Object.isFrozen(inspector)).toBe(true);
  });

  it("reports a non-conflicted note without reading its content", async () => {
    const { calls, inspector } = inspectorFor(conflictedNote({ conflicted: false }), contentRow());

    await expect(inspector.inspectConflict("note-1")).resolves.toEqual({
      outcome: "not-conflicted",
    });
    expect(calls).toEqual(["note:note-1"]);
  });

  it("reports a missing or trashed note as not-found without reading its content", async () => {
    const { calls, inspector } = inspectorFor(undefined, contentRow());

    await expect(inspector.inspectConflict("note-1")).resolves.toEqual({ outcome: "not-found" });
    expect(calls).toEqual(["note:note-1"]);
  });

  it("binds a readable conflict to both sides, reading content by the note's content id", async () => {
    const { calls, inspector } = inspectorFor(conflictedNote(), contentRow());
    const result = await inspector.inspectConflict("note-1");

    expect(result).toEqual({
      outcome: "inspected",
      local: {
        present: true,
        unlocked: true,
        tiptap: true,
        byteSize: Buffer.byteLength(LOCAL_BODY, "utf8"),
      },
      remote: {
        present: true,
        unlocked: true,
        tiptap: true,
        byteSize: Buffer.byteLength(REMOTE_BODY, "utf8"),
      },
      sidesEqual: false,
      remoteHasAttachments: false,
      binding: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(calls).toEqual(["note:note-1", "content:content-1"]);
  });

  it("reports equal sides and remote-only attachments as categorical facts", async () => {
    const equal = await inspectorFor(
      conflictedNote(),
      contentRow({ data: REMOTE_BODY }),
    ).inspector.inspectConflict("note-1");
    expect(equal).toMatchObject({
      outcome: "inspected",
      sidesEqual: true,
      remoteHasAttachments: false,
    });

    const remoteAttached = await inspectorFor(
      conflictedNote(),
      contentRow({ conflicted: remoteSide(REMOTE_WITH_ATTACHMENT) }),
    ).inspector.inspectConflict("note-1");
    expect(remoteAttached).toMatchObject({
      outcome: "inspected",
      sidesEqual: false,
      remoteHasAttachments: true,
    });

    const localAttached = await inspectorFor(
      conflictedNote(),
      contentRow({ data: REMOTE_WITH_ATTACHMENT }),
    ).inspector.inspectConflict("note-1");
    expect(localAttached).toMatchObject({ outcome: "inspected", remoteHasAttachments: false });
  });

  it("derives a binding that moves with the note, the content, either side, or the remote date", async () => {
    const base = await bindingOf(conflictedNote(), contentRow());
    expect(await bindingOf(conflictedNote(), contentRow())).toBe(base);

    const variants = [
      await bindingOf(conflictedNote({ id: "note-2" }), contentRow({ noteId: "note-2" }), "note-2"),
      await bindingOf(conflictedNote({ contentId: "content-2" }), contentRow({ id: "content-2" })),
      await bindingOf(conflictedNote(), contentRow({ data: '<p data-block-id="l2">other</p>' })),
      await bindingOf(
        conflictedNote(),
        contentRow({ conflicted: remoteSide('<p data-block-id="r2">other</p>') }),
      ),
      await bindingOf(
        conflictedNote(),
        contentRow({ conflicted: remoteSide(REMOTE_BODY, { dateModified: 3_000 }) }),
      ),
    ];
    for (const variant of variants) expect(variant).not.toBe(base);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("reports a locked side as unreadable and leaves its size unknown", async () => {
    const { inspector } = inspectorFor(
      conflictedNote(),
      contentRow({ locked: true, data: CIPHER }),
    );

    await expect(inspector.inspectConflict("note-1")).resolves.toEqual({
      outcome: "unreadable",
      local: { present: true, unlocked: false, tiptap: true, byteSize: null },
      remote: {
        present: true,
        unlocked: true,
        tiptap: true,
        byteSize: Buffer.byteLength(REMOTE_BODY, "utf8"),
      },
    });
  });

  it("reports an absent, non-tiptap, or textless side as unreadable", async () => {
    const absentRemote = await inspectorFor(
      conflictedNote(),
      contentRow({ conflicted: null }),
    ).inspector.inspectConflict("note-1");
    expect(absentRemote).toEqual({
      outcome: "unreadable",
      local: {
        present: true,
        unlocked: true,
        tiptap: true,
        byteSize: Buffer.byteLength(LOCAL_BODY, "utf8"),
      },
      remote: { present: false, unlocked: false, tiptap: false, byteSize: null },
    });

    const htmlRemote = await inspectorFor(
      conflictedNote(),
      contentRow({ conflicted: remoteSide(REMOTE_BODY, { type: "html" }) }),
    ).inspector.inspectConflict("note-1");
    expect(htmlRemote).toMatchObject({
      outcome: "unreadable",
      remote: { present: true, unlocked: true, tiptap: false },
    });

    const missingLocal = await inspectorFor(conflictedNote(), undefined).inspector.inspectConflict(
      "note-1",
    );
    expect(missingLocal).toEqual({
      outcome: "unreadable",
      local: { present: false, unlocked: false, tiptap: false, byteSize: null },
      remote: { present: false, unlocked: false, tiptap: false, byteSize: null },
    });

    const textless = await inspectorFor(
      conflictedNote(),
      contentRow({ data: undefined }),
    ).inspector.inspectConflict("note-1");
    expect(textless).toMatchObject({
      outcome: "unreadable",
      local: { present: true, byteSize: null },
    });
  });

  it("keeps the outcome a closed union with a fixed key set per member", async () => {
    const results: NotesnookConflictInspection[] = [
      await inspectorFor(conflictedNote({ conflicted: false })).inspector.inspectConflict("note-1"),
      await inspectorFor(undefined).inspector.inspectConflict("note-1"),
      await inspectorFor(
        conflictedNote(),
        contentRow({ locked: true, data: CIPHER }),
      ).inspector.inspectConflict("note-1"),
      await inspectorFor(conflictedNote(), contentRow()).inspector.inspectConflict("note-1"),
    ];

    expect(results.map(outcomeLabel)).toEqual(["clear", "missing", "unreadable", "inspected"]);
    expect(results.map((result) => Object.keys(result).sort())).toEqual([
      ["outcome"],
      ["outcome"],
      ["local", "outcome", "remote"],
      ["binding", "local", "outcome", "remote", "remoteHasAttachments", "sidesEqual"],
    ]);
  });

  it("never returns bodies, raw ids, or per-side digests, and makes only the two reads", async () => {
    const { calls, inspector } = inspectorFor(conflictedNote(), contentRow());
    const result = await inspector.inspectConflict("note-1");
    const serialized = JSON.stringify(result);

    for (const forbidden of [
      LOCAL_BODY,
      REMOTE_BODY,
      "local edit",
      "remote edit",
      "note-1",
      "content-1",
      "Conflicted note",
      sha256(LOCAL_BODY),
      sha256(REMOTE_BODY),
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(calls).toEqual(["note:note-1", "content:content-1"]);
  });

  it("rejects an invalid requested id before any upstream lookup", async () => {
    const { calls, inspector } = inspectorFor(conflictedNote(), contentRow());

    await expect(inspector.inspectConflict("bad id")).rejects.toSatisfy((error: unknown) => {
      expect(isNotesnookLocalConflictProjectionError(error)).toBe(true);
      expect(error).toMatchObject({ message: "local conflict note id is invalid" });
      return true;
    });
    expect(calls).toEqual([]);
  });

  it("fails categorically on identity, shape, and upstream faults without leaking detail", async () => {
    const identityMessage = "local conflict inspect content record identity does not match request";

    await expect(
      inspectorFor(conflictedNote({ id: "note-2" })).inspector.inspectConflict("note-1"),
    ).rejects.toMatchObject({
      message: "local conflict inspect note record identity does not match request",
    });
    await expect(
      inspectorFor(conflictedNote({ contentId: undefined })).inspector.inspectConflict("note-1"),
    ).rejects.toMatchObject({ message: "local conflict inspect note content id is malformed" });
    await expect(
      inspectorFor(conflictedNote(), contentRow({ id: "content-2" })).inspector.inspectConflict(
        "note-1",
      ),
    ).rejects.toMatchObject({ message: identityMessage });
    await expect(
      inspectorFor(conflictedNote(), contentRow({ noteId: "note-2" })).inspector.inspectConflict(
        "note-1",
      ),
    ).rejects.toMatchObject({ message: identityMessage });
    await expect(
      inspectorFor(
        conflictedNote(),
        contentRow({ conflicted: '{"data":"not-an-object"}' }),
      ).inspector.inspectConflict("note-1"),
    ).rejects.toMatchObject({ message: "local conflict inspect remote side is malformed" });
    await expect(
      inspectorFor(
        conflictedNote(),
        contentRow({ conflicted: remoteSide(REMOTE_BODY, { dateModified: "tomorrow" }) }),
      ).inspector.inspectConflict("note-1"),
    ).rejects.toMatchObject({ message: "local conflict inspect remote date is malformed" });
  });

  it("collapses hostile getters and rejected lookups into chain-free categorical errors", async () => {
    const secret = "PRIVATE-CONFLICT-BODY-7c1e";

    const hostileRow = Object.defineProperty(contentRow(), "data", {
      get() {
        throw new Error(secret);
      },
    });
    const hostile = await inspectorFor(conflictedNote(), hostileRow)
      .inspector.inspectConflict("note-1")
      .catch((error: unknown) => error);
    expect(isNotesnookLocalConflictProjectionError(hostile)).toBe(true);
    expect(hostile).toMatchObject({
      message: "local conflict inspect content record is malformed",
    });
    expect(String(hostile)).not.toContain(secret);
    expect((hostile as Error & { cause?: unknown }).cause).toBeUndefined();

    const failingNote = createNotesnookLocalConflictInspector({
      notes: {
        note: async () => {
          throw new Error(secret);
        },
      },
      contentWithConflicted: { get: async () => contentRow() },
    });
    const noteFailure = await failingNote
      .inspectConflict("note-1")
      .catch((error: unknown) => error);
    expect(isNotesnookLocalConflictProjectionError(noteFailure)).toBe(true);
    expect(noteFailure).toMatchObject({
      message: "local conflict inspect note lookup call rejected",
    });
    expect(String(noteFailure)).not.toContain(secret);

    const failingContent = createNotesnookLocalConflictInspector({
      notes: { note: async () => conflictedNote() },
      contentWithConflicted: {
        get: async () => {
          throw new Error(secret);
        },
      },
    });
    const contentFailure = await failingContent
      .inspectConflict("note-1")
      .catch((error: unknown) => error);
    expect(isNotesnookLocalConflictProjectionError(contentFailure)).toBe(true);
    expect(contentFailure).toMatchObject({
      message: "local conflict inspect content lookup call rejected",
    });
    expect(String(contentFailure)).not.toContain(secret);
  });
});
