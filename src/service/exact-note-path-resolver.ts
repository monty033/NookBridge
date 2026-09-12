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
  readonly pinned?: boolean;
  readonly revision?: string;
}>;

export type ExactNotePathMetadata = ExactNotePathNote &
  Readonly<{
    readonly revision?: string;
  }>;

export type ExactNotePathResolution = Readonly<{
  readonly id: string;
  readonly expectedRevision: string;
  readonly pinned?: boolean;
}>;

export type ExactNotePathSource = Readonly<{
  readonly notebooks: readonly NotebookRecord[];
  /** Search-indexed candidates for the exact note title. */
  readonly findNotesByTitle: (title: string) => Promise<readonly ExactNotePathNote[]>;
  /**
   * Authoritative notebook membership ids from the live Notesnook
   * manager.  Recursive: returns every note id nested under the
   * notebook.  Rejected above the published 256 cap.
   */
  readonly findNoteIdsByNotebook: (notebookId: string) => Promise<readonly string[]>;
  /**
   * Direct, bounded notebook membership probe.  When the title
   * candidate set is bounded (≤ 256) but
   * {@link findNoteIdsByNotebook} refuses an oversized notebook, the
   * resolver can ask for membership one candidate at a time without
   * ever materialising the corpus.  Optional: when absent the
   * resolver falls back to {@link findNoteIdsByNotebook}.
   */
  readonly hasNoteInNotebook?: (notebookId: string, noteId: string) => Promise<boolean>;
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
      (note.notebookId !== undefined && typeof note.notebookId !== "string") ||
      (note.pinned !== undefined && typeof note.pinned !== "boolean")
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
      // Title matches exist but none declared the expected
      // `notebookId`.  Before asking the recursive notebook manager
      // for every member id (which a real Notesnook DB refuses once
      // the corpus crosses the 256 cap), probe each bounded title
      // candidate one at a time through the optional direct
      // membership seam.  The bound on probe calls is the same
      // MAX_NOTES title-candidate cap already enforced above.
      const probed = await probeMembershipForTitleCandidates(
        source,
        notebookId,
        validatedNotes,
        parsed.noteTitle,
      );
      if (probed !== undefined) {
        candidates = probed;
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
  }
  if (candidates.length === 0) throw new ExactNotePathError("not_found");
  if (candidates.length !== 1) throw new ExactNotePathError("ambiguous");

  const candidate = candidates[0];
  if (candidate === undefined) throw new ExactNotePathError("source_unavailable");
  if (typeof candidate.revision === "string" && REVISION_PATTERN.test(candidate.revision)) {
    return Object.freeze({
      id: candidate.id,
      expectedRevision: candidate.revision,
      ...(candidate.pinned === undefined ? {} : { pinned: candidate.pinned }),
    });
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

  return Object.freeze({
    id: metadata.id,
    expectedRevision: metadata.revision,
    ...(metadata.pinned === undefined ? {} : { pinned: metadata.pinned }),
  });
}

export type ExactNotePathDiagnostic = Readonly<{
  readonly title: "none" | "one" | "multiple" | "unavailable";
  readonly notebook: "present" | "absent" | "unavailable" | "not_applicable";
  readonly directMembership: "present" | "absent" | "unavailable" | "not_applicable";
  readonly recursiveMembership: "present" | "absent" | "unavailable" | "not_applicable";
  readonly revision: "valid" | "invalid" | "unavailable" | "not_applicable";
}>;

const DIAGNOSTIC_NOT_APPLICABLE = "not_applicable" as const;

/**
 * Read-only, redacted diagnostic for the exact-path resolver.  It deliberately
 * reports the direct relation and recursive notebook-manager checks separately
 * so a live mismatch cannot be mistaken for a Vault-lock result.
 */
export async function diagnoseExactNotePath(
  path: unknown,
  source: ExactNotePathSource,
): Promise<ExactNotePathDiagnostic> {
  let parsed: Readonly<{ notebookPath: string | undefined; noteTitle: string }>;
  try {
    parsed = parseExactNotePath(path);
  } catch {
    return Object.freeze({
      title: "unavailable",
      notebook: "unavailable",
      directMembership: "unavailable",
      recursiveMembership: "unavailable",
      revision: "unavailable",
    });
  }

  let notes: readonly ExactNotePathNote[];
  try {
    notes = await source.findNotesByTitle(parsed.noteTitle);
  } catch {
    return Object.freeze({
      title: "unavailable",
      notebook: parsed.notebookPath === undefined ? DIAGNOSTIC_NOT_APPLICABLE : "unavailable",
      directMembership: DIAGNOSTIC_NOT_APPLICABLE,
      recursiveMembership: DIAGNOSTIC_NOT_APPLICABLE,
      revision: "unavailable",
    });
  }
  if (!Array.isArray(notes) || notes.length > MAX_NOTES) {
    return Object.freeze({
      title: "unavailable",
      notebook: parsed.notebookPath === undefined ? DIAGNOSTIC_NOT_APPLICABLE : "unavailable",
      directMembership: DIAGNOSTIC_NOT_APPLICABLE,
      recursiveMembership: DIAGNOSTIC_NOT_APPLICABLE,
      revision: "unavailable",
    });
  }

  const candidates: ExactNotePathNote[] = [];
  for (const note of notes) {
    if (
      note === null ||
      typeof note !== "object" ||
      typeof note.id !== "string" ||
      note.id.length === 0 ||
      typeof note.title !== "string" ||
      (note.notebookId !== undefined && typeof note.notebookId !== "string") ||
      (note.pinned !== undefined && typeof note.pinned !== "boolean")
    ) {
      return Object.freeze({
        title: "unavailable",
        notebook: parsed.notebookPath === undefined ? DIAGNOSTIC_NOT_APPLICABLE : "unavailable",
        directMembership: DIAGNOSTIC_NOT_APPLICABLE,
        recursiveMembership: DIAGNOSTIC_NOT_APPLICABLE,
        revision: "unavailable",
      });
    }
    if (note.title === parsed.noteTitle) candidates.push(note);
  }

  const title =
    candidates.length === 0 ? "none" : candidates.length === 1 ? "one" : ("multiple" as const);
  if (candidates.length === 0) {
    return Object.freeze({
      title,
      notebook: parsed.notebookPath === undefined ? DIAGNOSTIC_NOT_APPLICABLE : "not_applicable",
      directMembership: DIAGNOSTIC_NOT_APPLICABLE,
      recursiveMembership: DIAGNOSTIC_NOT_APPLICABLE,
      revision: DIAGNOSTIC_NOT_APPLICABLE,
    });
  }

  const revision = await diagnoseRevision(source, candidates);
  if (parsed.notebookPath === undefined) {
    return Object.freeze({
      title,
      notebook: DIAGNOSTIC_NOT_APPLICABLE,
      directMembership: DIAGNOSTIC_NOT_APPLICABLE,
      recursiveMembership: DIAGNOSTIC_NOT_APPLICABLE,
      revision,
    });
  }

  let index: ReturnType<typeof buildNotebookIndex>;
  try {
    index = buildNotebookIndex(source.notebooks);
  } catch {
    return Object.freeze({
      title,
      notebook: "unavailable",
      directMembership: DIAGNOSTIC_NOT_APPLICABLE,
      recursiveMembership: DIAGNOSTIC_NOT_APPLICABLE,
      revision,
    });
  }
  const notebookId = index.resolveId(parsed.notebookPath);
  if (notebookId === undefined || index.resolvePath(notebookId) !== parsed.notebookPath) {
    return Object.freeze({
      title,
      notebook: "absent",
      directMembership: DIAGNOSTIC_NOT_APPLICABLE,
      recursiveMembership: DIAGNOSTIC_NOT_APPLICABLE,
      revision,
    });
  }

  const directMembership = await diagnoseDirectMembership(source, notebookId, candidates);
  const recursiveMembership = await diagnoseRecursiveMembership(source, notebookId, candidates);
  return Object.freeze({
    title,
    notebook: "present",
    directMembership,
    recursiveMembership,
    revision,
  });
}

async function diagnoseRevision(
  source: ExactNotePathSource,
  candidates: readonly ExactNotePathNote[],
): Promise<ExactNotePathDiagnostic["revision"]> {
  if (candidates.length !== 1) return DIAGNOSTIC_NOT_APPLICABLE;
  const candidate = candidates[0];
  if (candidate === undefined) return "unavailable";
  if (typeof candidate.revision === "string") {
    return REVISION_PATTERN.test(candidate.revision) ? "valid" : "invalid";
  }
  try {
    const metadata = await source.noteMetadata(candidate.id);
    if (
      metadata === undefined ||
      metadata.id !== candidate.id ||
      metadata.title !== candidate.title
    ) {
      return "invalid";
    }
    return typeof metadata.revision === "string" && REVISION_PATTERN.test(metadata.revision)
      ? "valid"
      : "invalid";
  } catch {
    return "unavailable";
  }
}

async function diagnoseDirectMembership(
  source: ExactNotePathSource,
  notebookId: string,
  candidates: readonly ExactNotePathNote[],
): Promise<ExactNotePathDiagnostic["directMembership"]> {
  if (source.hasNoteInNotebook === undefined) return "unavailable";
  try {
    let matched = false;
    for (const candidate of candidates) {
      const result = await source.hasNoteInNotebook(notebookId, candidate.id);
      if (typeof result !== "boolean") return "unavailable";
      matched ||= result;
    }
    return matched ? "present" : "absent";
  } catch {
    return "unavailable";
  }
}

async function diagnoseRecursiveMembership(
  source: ExactNotePathSource,
  notebookId: string,
  candidates: readonly ExactNotePathNote[],
): Promise<ExactNotePathDiagnostic["recursiveMembership"]> {
  try {
    const ids = await source.findNoteIdsByNotebook(notebookId);
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_NOTES ||
      ids.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      return "unavailable";
    }
    const idSet = new Set(ids);
    return candidates.some((candidate) => idSet.has(candidate.id)) ? "present" : "absent";
  } catch {
    return "unavailable";
  }
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

/**
 * Probe each title-matched candidate through the optional direct
 * membership seam.  Returns the bounded list of candidates that are
 * confirmed members of `notebookId`, or `undefined` when the seam
 * is absent and the caller must fall back to corpus enumeration.
 *
 * The probe loop is bounded by the already-enforced MAX_NOTES
 * title-candidate cap.  A single hostile membership answer (a
 * non-boolean) maps to `source_unavailable`; a thrown probe
 * likewise.  An empty membership answer is NOT treated as
 * `source_unavailable` — it means "not in this notebook" and the
 * resolver will continue probing the remaining candidates.
 */
async function probeMembershipForTitleCandidates(
  source: ExactNotePathSource,
  notebookId: string,
  notes: readonly ExactNotePathNote[],
  noteTitle: string,
): Promise<ExactNotePathNote[] | undefined> {
  if (source.hasNoteInNotebook === undefined) return undefined;
  const probe = source.hasNoteInNotebook;
  const matches: ExactNotePathNote[] = [];
  for (const note of notes) {
    if (note.title !== noteTitle) continue;
    let inNotebook: boolean;
    try {
      inNotebook = await probe(notebookId, note.id);
    } catch {
      throw new ExactNotePathError("source_unavailable");
    }
    if (typeof inNotebook !== "boolean") {
      throw new ExactNotePathError("source_unavailable");
    }
    if (inNotebook) matches.push(note);
  }
  return matches;
}
