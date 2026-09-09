/**
 * Bounded exact note-path resolver used only by the destructive delete path.
 *
 * A delete target is a complete hierarchical path, for example
 * `Outdoors/Canoe Trip`.  The notebook portion is resolved through the
 * boot-time hierarchy index and the final component is an exact,
 * case-sensitive note title match.  Title-only, fuzzy, traversal-like, and
 * separator-ambiguous inputs are rejected before the write capability sees an
 * internal id.
 */

import { Buffer } from "node:buffer";

import {
  buildNotebookIndex,
  NotebookIndexError,
  type NotebookRecord,
} from "../settings/notebook-index.js";

const MAX_PATH_BYTES = 2_048;
const MAX_PATH_SEGMENTS = 32;
const MAX_NOTES = 256;
const REVISION_PATTERN = /^rev_[0-9a-f]{32}$/;

export type ExactNotePathErrorCode =
  | "invalid_path"
  | "not_found"
  | "ambiguous"
  | "source_unavailable";

/** Fixed categorical resolver error; it never contains the supplied path. */
export class ExactNotePathError extends Error {
  public readonly code: ExactNotePathErrorCode;

  public constructor(code: ExactNotePathErrorCode) {
    super("exact note path could not be resolved");
    this.code = code;
    Object.setPrototypeOf(this, ExactNotePathError.prototype);
    Object.defineProperty(this, "cause", { configurable: true, value: undefined });
    Object.defineProperty(this, "__context__", { configurable: true, value: undefined });
  }
}

export type ExactNotePathNote = Readonly<{
  readonly id: string;
  readonly title: string;
  readonly notebookId?: string;
  readonly revision?: string;
}>;

export type ExactNotePathMetadata = ExactNotePathNote &
  Readonly<{
    readonly revision?: string;
  }>;

export type ExactNotePathResolution = Readonly<{
  readonly id: string;
  readonly expectedRevision: string;
}>;

export type ExactNotePathSource = Readonly<{
  readonly notebooks: readonly NotebookRecord[];
  /** Search-indexed candidates for the exact note title. */
  readonly findNotesByTitle: (title: string) => Promise<readonly ExactNotePathNote[]>;
  /** Authoritative notebook membership ids from the live Notesnook manager. */
  readonly findNoteIdsByNotebook: (notebookId: string) => Promise<readonly string[]>;
  readonly noteMetadata: (id: string) => Promise<ExactNotePathMetadata | undefined>;
}>;

/**
 * Resolve exactly one human-visible note path to the opaque id and the
 * current revision token required by the write adapter.
 *
 * The source is intentionally injected so this function has no socket,
 * filesystem, Notesnook, or credential access.  Every source irregularity
 * fails closed with a categorical error and the note corpus is capped before
 * any candidate processing begins.
 */
export async function resolveExactNotePath(
  path: unknown,
  source: ExactNotePathSource,
): Promise<ExactNotePathResolution> {
  const parsed = parseExactNotePath(path);

  // Search the title index before touching notebook hierarchy data. A
  // missing title is definitively not_found; unrelated hierarchy/index
  // failures must not turn that absence into service_unavailable.
  let notes: readonly ExactNotePathNote[];
  try {
    notes = await source.findNotesByTitle(parsed.noteTitle);
  } catch {
    throw new ExactNotePathError("source_unavailable");
  }
  if (!Array.isArray(notes) || notes.length > MAX_NOTES) {
    throw new ExactNotePathError("source_unavailable");
  }
  if (notes.length === 0) throw new ExactNotePathError("not_found");

  const validatedNotes: ExactNotePathNote[] = [];
  for (const note of notes) {
    if (
      note === null ||
      typeof note !== "object" ||
      typeof note.id !== "string" ||
      note.id.length === 0 ||
      typeof note.title !== "string" ||
      (note.notebookId !== undefined && typeof note.notebookId !== "string")
    ) {
      throw new ExactNotePathError("source_unavailable");
    }
    validatedNotes.push(note);
  }

  let candidates: ExactNotePathNote[];
  if (parsed.notebookPath === undefined) {
    candidates = validatedNotes.filter(
      (note) => note.title === parsed.noteTitle && note.notebookId === undefined,
    );
  } else {
    let index: ReturnType<typeof buildNotebookIndex>;
    try {
      index = buildNotebookIndex(source.notebooks);
    } catch (error) {
      if (error instanceof NotebookIndexError && error.code === "notebook_duplicate_path") {
        throw new ExactNotePathError("ambiguous");
      }
      throw new ExactNotePathError("source_unavailable");
    }

    const notebookId = index.resolveId(parsed.notebookPath);
    if (notebookId === undefined || index.resolvePath(notebookId) !== parsed.notebookPath) {
      throw new ExactNotePathError("not_found");
    }

    const directCandidates = validatedNotes.filter(
      (note) =>
        note.title === parsed.noteTitle &&
        note.notebookId !== undefined &&
        note.notebookId === notebookId,
    );
    if (directCandidates.length > 0) {
      candidates = directCandidates;
    } else {
      let notebookNoteIds: readonly string[];
      try {
        notebookNoteIds = await source.findNoteIdsByNotebook(notebookId);
      } catch {
        throw new ExactNotePathError("source_unavailable");
      }
      if (
        !Array.isArray(notebookNoteIds) ||
        notebookNoteIds.length > MAX_NOTES ||
        notebookNoteIds.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        throw new ExactNotePathError("source_unavailable");
      }

      const notebookNoteIdSet = new Set(notebookNoteIds);
      candidates = validatedNotes.filter(
        (note) => note.title === parsed.noteTitle && notebookNoteIdSet.has(note.id),
      );
    }
  }
  if (candidates.length === 0) throw new ExactNotePathError("not_found");
  if (candidates.length !== 1) throw new ExactNotePathError("ambiguous");

  const candidate = candidates[0];
  if (candidate === undefined) throw new ExactNotePathError("source_unavailable");
  if (typeof candidate.revision === "string" && REVISION_PATTERN.test(candidate.revision)) {
    return Object.freeze({ id: candidate.id, expectedRevision: candidate.revision });
  }
  let metadata: ExactNotePathMetadata | undefined;
  try {
    metadata = await source.noteMetadata(candidate.id);
  } catch {
    throw new ExactNotePathError("source_unavailable");
  }
  if (
    metadata === undefined ||
    metadata.id !== candidate.id ||
    metadata.title !== parsed.noteTitle ||
    typeof metadata.revision !== "string" ||
    !REVISION_PATTERN.test(metadata.revision)
  ) {
    throw new ExactNotePathError("not_found");
  }

  return Object.freeze({ id: metadata.id, expectedRevision: metadata.revision });
}

export function parseExactNotePath(path: unknown): Readonly<{
  readonly notebookPath: string | undefined;
  readonly noteTitle: string;
}> {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ||
    hasControlCharacter(path) ||
    path.includes("\\")
  ) {
    throw new ExactNotePathError("invalid_path");
  }

  const segments = path.split("/");
  if (
    segments.length === 0 ||
    segments.length > MAX_PATH_SEGMENTS ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ExactNotePathError("invalid_path");
  }
  const noteTitle = segments[segments.length - 1];
  if (noteTitle === undefined) throw new ExactNotePathError("invalid_path");
  const notebookPath = segments.length === 1 ? undefined : segments.slice(0, -1).join("/");
  return Object.freeze({ notebookPath, noteTitle });
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
