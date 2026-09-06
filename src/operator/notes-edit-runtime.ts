/** Bounded operator-only edit/undo composition over the reviewed write seams. */

import { Buffer } from "node:buffer";

import type { NotesCategoricalResult } from "./notes-cli.js";
import {
  NOTES_UNDO_CONTENT_MAX_BYTES,
  NOTES_UNDO_TITLE_MAX_LENGTH,
  type NotesUndoJournal,
  type NotesUndoJournalResult,
} from "./notes-undo-journal.js";

const POST_REVISION_KEY = "undoExpectedRevision";
const EXPIRES_AT_KEY = "undoExpiresAt";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const REVISION_PATTERN = /^rev_[0-9a-f]{32}$/;
const OPAQUE_PATTERN = /^[a-z][a-z0-9]{2,3}_[A-Za-z0-9_-]{4,124}$/;

export type NotesEditPreimage = Readonly<{
  handle: string;
  revision: string;
  title: string;
  content: string;
  metadata: Readonly<Record<string, string>>;
}>;

export type NotesEditUpdateResult =
  | Readonly<{ kind: "updated"; revision: string }>
  | Readonly<{ kind: "conflict" | "locked" | "missing" | "error" }>;

export interface NotesEditSource {
  readonly read: (handle: string) => Promise<NotesEditPreimage | undefined>;
  /** Predicts the exact revision produced by the next bounded content update. */
  readonly nextRevision: (command: {
    readonly handle: string;
    readonly currentRevision: string;
    readonly content: string;
  }) => string | undefined;
  readonly update: (command: {
    readonly handle: string;
    readonly expectedRevision: string;
    readonly title: string;
    readonly content: string;
    readonly metadata: Readonly<Record<string, string>>;
  }) => Promise<NotesEditUpdateResult>;
}

export interface NotesEditRuntimeOptions {
  readonly source: NotesEditSource;
  readonly journal: NotesUndoJournal;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly audit?: (
    event: "edit.updated" | "edit.conflict" | "edit.denied" | "undo.undone" | "undo.conflict",
  ) => void;
}

export interface NotesEditRuntime {
  readonly edit: (command: {
    readonly handle: string;
    readonly content: string;
    readonly undoToken: string;
  }) => Promise<NotesCategoricalResult>;
  readonly undo: (command: { readonly token: string }) => Promise<NotesCategoricalResult>;
}

export function createNotesEditRuntime(options: NotesEditRuntimeOptions): NotesEditRuntime {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 7 * DEFAULT_TTL_MS) {
    throw new Error("invalid undo lifetime");
  }

  const audit = (event: Parameters<NonNullable<NotesEditRuntimeOptions["audit"]>>[0]): void => {
    try {
      options.audit?.(event);
    } catch {
      // Audit is deliberately non-observable and never changes the result.
    }
  };

  const edit = async (command: {
    readonly handle: string;
    readonly content: string;
    readonly undoToken: string;
  }): Promise<NotesCategoricalResult> => {
    if (!validOpaque(command?.handle) || !validOpaque(command?.undoToken))
      return { kind: "invalid-input" };
    if (Buffer.byteLength(command.content, "utf8") > NOTES_UNDO_CONTENT_MAX_BYTES) {
      return { kind: "invalid-input" };
    }
    let observed: NotesEditPreimage | undefined;
    try {
      observed = await options.source.read(command.handle);
    } catch {
      return { kind: "error", exitCode: 3, message: "nookctl notes: edit unavailable" };
    }
    if (observed === undefined) return { kind: "missing" };
    const preimage = normalizePreimage(observed);
    if (preimage === undefined)
      return { kind: "error", exitCode: 3, message: "nookctl notes: edit unavailable" };

    let nextRevision: string | undefined;
    try {
      nextRevision = options.source.nextRevision({
        handle: preimage.handle,
        currentRevision: preimage.revision,
        content: command.content,
      });
    } catch {
      return { kind: "error", exitCode: 3, message: "nookctl notes: edit unavailable" };
    }
    if (!validRevision(nextRevision))
      return { kind: "error", exitCode: 3, message: "nookctl notes: edit unavailable" };

    const expiresAt = now() + ttlMs;
    if (!Number.isSafeInteger(expiresAt))
      return { kind: "error", exitCode: 3, message: "nookctl notes: edit unavailable" };
    const journalResult = await options.journal.record(
      {
        handle: preimage.handle,
        revision: preimage.revision,
        title: preimage.title,
        content: preimage.content,
        metadata: {
          ...preimage.metadata,
          [POST_REVISION_KEY]: nextRevision,
          [EXPIRES_AT_KEY]: String(expiresAt),
        },
      },
      command.undoToken,
    );
    if (journalResult.kind !== "stored") return mapJournalResult(journalResult);

    let result: NotesEditUpdateResult;
    try {
      result = await options.source.update({
        handle: preimage.handle,
        expectedRevision: preimage.revision,
        title: preimage.title,
        content: command.content,
        metadata: preimage.metadata,
      });
    } catch {
      await options.journal.remove({ token: journalResult.token });
      return { kind: "error", exitCode: 3, message: "nookctl notes: edit unavailable" };
    }
    if (result.kind !== "updated" || result.revision !== nextRevision) {
      await options.journal.remove({ token: journalResult.token });
      if (result.kind === "conflict") {
        audit("edit.conflict");
        return { kind: "conflict" };
      }
      if (result.kind === "locked") return { kind: "locked" };
      if (result.kind === "missing") return { kind: "missing" };
      return { kind: "error", exitCode: 3, message: "nookctl notes: edit unavailable" };
    }
    audit("edit.updated");
    return { kind: "updated" };
  };

  const undo = async (command: { readonly token: string }): Promise<NotesCategoricalResult> => {
    if (!validOpaque(command?.token)) return { kind: "invalid-input" };
    const loaded = await options.journal.load({ token: command.token });
    if (loaded.kind !== "preimage") return mapJournalResult(loaded);
    const expiry = Number(loaded.metadata[EXPIRES_AT_KEY]);
    const expectedRevision = loaded.metadata[POST_REVISION_KEY];
    if (!Number.isSafeInteger(expiry) || expiry < now() || !validRevision(expectedRevision)) {
      await options.journal.remove({ token: command.token });
      return { kind: "missing" };
    }
    let current: NotesEditPreimage | undefined;
    try {
      current = await options.source.read(loaded.handle);
    } catch {
      return { kind: "error", exitCode: 3, message: "nookctl notes: undo unavailable" };
    }
    if (current === undefined) return { kind: "missing" };
    if (current.revision !== expectedRevision) {
      audit("undo.conflict");
      return { kind: "conflict" };
    }
    const restoreMetadata = Object.fromEntries(
      Object.entries(loaded.metadata).filter(
        ([key]) => key !== POST_REVISION_KEY && key !== EXPIRES_AT_KEY,
      ),
    );
    let result: NotesEditUpdateResult;
    try {
      result = await options.source.update({
        handle: loaded.handle,
        expectedRevision,
        title: loaded.title,
        content: loaded.content,
        metadata: restoreMetadata,
      });
    } catch {
      return { kind: "error", exitCode: 3, message: "nookctl notes: undo unavailable" };
    }
    if (result.kind === "conflict") {
      audit("undo.conflict");
      return { kind: "conflict" };
    }
    if (result.kind === "locked") return { kind: "locked" };
    if (result.kind === "missing") return { kind: "missing" };
    if (result.kind !== "updated")
      return { kind: "error", exitCode: 3, message: "nookctl notes: undo unavailable" };
    const removed = await options.journal.remove({ token: command.token });
    if (removed.kind !== "removed")
      return { kind: "error", exitCode: 3, message: "nookctl notes: undo unavailable" };
    audit("undo.undone");
    return { kind: "undone" };
  };

  return Object.freeze({ edit, undo });
}

function validOpaque(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    OPAQUE_PATTERN.test(value) &&
    !value.startsWith("rev_")
  );
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && REVISION_PATTERN.test(value);
}

function normalizePreimage(value: NotesEditPreimage): NotesEditPreimage | undefined {
  try {
    if (
      !validOpaque(value.handle) ||
      !validRevision(value.revision) ||
      typeof value.title !== "string" ||
      value.title.length === 0 ||
      value.title.length > NOTES_UNDO_TITLE_MAX_LENGTH ||
      typeof value.content !== "string" ||
      Buffer.byteLength(value.content, "utf8") > NOTES_UNDO_CONTENT_MAX_BYTES ||
      value.metadata === null ||
      typeof value.metadata !== "object" ||
      Array.isArray(value.metadata)
    ) {
      return undefined;
    }
    const metadata: Record<string, string> = Object.create(null) as Record<string, string>;
    let count = 0;
    for (const key of Object.keys(value.metadata)) {
      const item = value.metadata[key];
      if (key.length === 0 || key.length > 128 || typeof item !== "string" || item.length > 100) {
        return undefined;
      }
      metadata[key] = item;
      count += 1;
      if (count > 16) return undefined;
    }
    return Object.freeze({
      handle: value.handle,
      revision: value.revision,
      title: value.title,
      content: value.content,
      metadata: Object.freeze(metadata),
    });
  } catch {
    return undefined;
  }
}

function mapJournalResult(result: NotesUndoJournalResult): NotesCategoricalResult {
  switch (result.kind) {
    case "missing":
      return { kind: "missing" };
    case "invalid-input":
      return { kind: "invalid-input" };
    case "locked":
      return { kind: "locked" };
    case "conflict":
      return { kind: "conflict" };
    case "error":
      return { kind: "error", exitCode: 3, message: "nookctl notes: undo unavailable" };
    case "stored":
    case "removed":
    case "preimage":
      return { kind: "error", exitCode: 3, message: "nookctl notes: undo unavailable" };
  }
}
