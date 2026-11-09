/**
 * EA-2 — `notes.edit-census`: an operator-only, read-only measurement.
 *
 * It answers one question per note: which `notes.get` projection outcome would
 * this note take, and if a whole-document refusal is the cause, under which
 * closed internal reason. It never returns a body, a title, a raw note id or a
 * snippet. A scoped call echoes only the opaque handle the caller supplied.
 *
 * Visibility comes first, and it is decided before any snapshot is read. A note
 * in no bucket is never read. A corpus call counts the notes the discovery
 * visibility listing carries; a scoped call decides the named note itself, with
 * the same rule, because the listing is narrower than what the read path
 * serves — `notes.search-operator` and `notes.get` reach notes the listing
 * omits, and a scoped census that consulted only the listing answered `missing`
 * for a note the caller could open. The listing is bounded upstream at 256
 * notes (`MAX_LIST_NOTES`), so a corpus call covers at most the listed notes;
 * that ceiling is upstream and is not removed here.
 *
 * Bounded per run: a corpus call counts at most `MAX_EDIT_CENSUS_NOTES_PER_RUN`
 * visible notes, in listing order, and reports the cap, how many visible notes
 * it skipped and `truncated`. There is no cursor: every run measures the same
 * first notes, and the notes after the cap are never measured. Each counted
 * note is decoded synchronously, so the cap is what keeps a large corpus from
 * stalling live requests on the same loop.
 *
 * Unknown is not empty, and undecided is not hidden: when the visibility
 * listing cannot be established, or a scoped call cannot decide the named note
 * (no hierarchy snapshot, or the note's metadata cannot be read), the census
 * throws `NotesEditCensusUnavailableError` (an unavailable outcome on the wire)
 * instead of reporting a zero or claiming the note does not exist.
 *
 * Read-only by construction:
 *   - the source methods are `listVisibleNotes`, the optional `isNoteVisible`
 *     (visibility only) and `readNoteSnapshot`;
 *   - the classifier is the same pure function `notes.get` uses;
 *   - no write adapter, operation store, pending marker or mutation is imported.
 */

import { Buffer } from "node:buffer";

import { nativeFailureClass, type NativeFailureClass } from "../core/note-document-native.js";
import type { RpcNotesEditCensusResult } from "./rpc-protocol.js";
import {
  classifyNoteContentProjection,
  type NoteProjectionClassification,
  type NoteProjectionOutcome,
} from "./note-content-projection.js";

const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const bufferByteLength = Buffer.byteLength;

/** Visible notes decoded by one corpus call; the rest are counted as skipped. */
export const MAX_EDIT_CENSUS_NOTES_PER_RUN = 500;

/** The decode-refusal classes; the edit-refusal class is counted apart from them. */
type DecodeRefusalClass = Exclude<NativeFailureClass, "edit_refusal">;

export interface NotesEditCensusSource {
  /**
   * The visibility-filtered listing `notes.browse` uses; never the raw note
   * list. `undefined` means the filter could not be established.
   */
  readonly listVisibleNotes: () => Promise<ReadonlyArray<Readonly<{ id: string }>> | undefined>;
  /**
   * Visibility of ONE named note.
   *
   * The listing is not the whole corpus: a note `search` and `notes.get`
   * serve can be absent from it, and a scoped census that consulted only the
   * listing reported such a note as missing. `undefined` means unknown, which
   * is reported as unavailable rather than as a missing note.
   */
  readonly isNoteVisible?: (id: string) => Promise<boolean | undefined>;
  readonly readNoteSnapshot: (id: string) => Promise<unknown | undefined>;
}

/** Visibility is unknown, so nothing was measured. Maps to `service_unavailable`. */
export class NotesEditCensusUnavailableError extends Error {
  constructor() {
    super("census unavailable");
    this.name = "NotesEditCensusUnavailableError";
  }
}

/** The synthetic response id charged while classifying: never wire-visible. */
const CENSUS_REQUEST_ID = "notes.edit-census";

export interface NotesEditCensus {
  /** Whole corpus, one count per note. */
  readonly corpus: () => Promise<RpcNotesEditCensusResult>;
  /** One note, addressed by an already-resolved id; echoes only `handle`. */
  readonly note: (noteId: string, handle: string) => Promise<RpcNotesEditCensusResult | undefined>;
}

type OutcomeCounts = Record<NoteProjectionOutcome, number>;

interface Accumulator {
  total: number;
  readonly reasons: Record<DecodeRefusalClass, number>;
  /** Never a decode failure and never preservable: counted on its own. */
  editRefusals: number;
  readonly projection: OutcomeCounts;
  preservedBlocks: number;
  preservedTaskLists: number;
}

function emptyAccumulator(): Accumulator {
  return {
    total: 0,
    reasons: { hostile: 0, uninterpretable: 0, limit: 0, unclassified: 0 },
    editRefusals: 0,
    projection: {
      strict: 0,
      strict_with_preserved_blocks: 0,
      opaque_heading_fallback: 0,
      serializer_fallback: 0,
      locked: 0,
      oversize: 0,
      unavailable: 0,
    },
    preservedBlocks: 0,
    preservedTaskLists: 0,
  };
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Record<string, unknown>;
}

function ownField(record: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = objectGetOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function record(acc: Accumulator, classification: NoteProjectionClassification): void {
  acc.total += 1;
  acc.projection[classification.outcome] += 1;
  acc.preservedBlocks += classification.preservedBlocks;
  acc.preservedTaskLists += classification.preservedTaskLists;
  const reason = classification.reason;
  if (reason === undefined) return;
  const failureClass = nativeFailureClass(reason);
  if (failureClass === "edit_refusal") acc.editRefusals += 1;
  else acc.reasons[failureClass] += 1;
}

function classify(
  noteId: string,
  metadata: Record<string, unknown> | undefined,
  snapshot: unknown,
  requestId: string,
): NoteProjectionClassification {
  const snapshotRecord = ownRecord(snapshot);
  if (snapshotRecord === undefined) {
    // The note was listed but its consistent pair could not be read. Mirror the
    // read path's "unavailable" category, with no refusal reason.
    return { outcome: "unavailable", preservedBlocks: 0, preservedTaskLists: 0 };
  }
  const snapshotMetadata = ownRecord(ownField(snapshotRecord, "metadata")) ?? metadata ?? {};
  return classifyNoteContentProjection({
    contentRefusal: ownField(snapshotRecord, "contentRefusal"),
    envelope: ownField(snapshotRecord, "content"),
    noteId,
    note: snapshotMetadata,
    requestId,
  });
}

function result(
  acc: Accumulator,
  handle: string | undefined,
  skipped: number,
): RpcNotesEditCensusResult {
  const projection = Object.freeze({
    strict: acc.projection.strict,
    strictWithPreservedBlocks: acc.projection.strict_with_preserved_blocks,
    opaqueHeadingFallback: acc.projection.opaque_heading_fallback,
    serializerFallback: acc.projection.serializer_fallback,
    locked: acc.projection.locked,
    oversize: acc.projection.oversize,
    unavailable: acc.projection.unavailable,
  });
  return Object.freeze({
    kind: "edit-census" as const,
    scope: handle === undefined ? ("corpus" as const) : ("note" as const),
    ...(handle === undefined ? {} : { note: handle }),
    total: acc.total,
    reasons: Object.freeze({ ...acc.reasons }),
    editRefusals: acc.editRefusals,
    projection,
    preservedBlocks: acc.preservedBlocks,
    preservedTaskLists: acc.preservedTaskLists,
    cap: MAX_EDIT_CENSUS_NOTES_PER_RUN,
    skipped,
    truncated: skipped > 0,
  });
}

export function createNotesEditCensus(source: NotesEditCensusSource): NotesEditCensus {
  const readSnapshot = source.readNoteSnapshot;
  const listVisibleNotes = source.listVisibleNotes;
  const isNoteVisible = source.isNoteVisible;

  /**
   * The visible notes, as `[id, listed record]`; malformed entries are skipped.
   * Throws when visibility is unknown, so no snapshot is read and no zero is
   * reported for a corpus that was not measured.
   */
  const visibleNotes = async (): Promise<Array<[string, Record<string, unknown>]>> => {
    const listing = await listVisibleNotes();
    if (listing === undefined) throw new NotesEditCensusUnavailableError();
    const visible: Array<[string, Record<string, unknown>]> = [];
    for (const listed of listing) {
      const metadata = ownRecord(listed);
      const noteId = metadata === undefined ? undefined : ownField(metadata, "id");
      if (metadata !== undefined && typeof noteId === "string" && noteId.length > 0)
        visible.push([noteId, metadata]);
    }
    return visible;
  };

  return Object.freeze({
    corpus: async (): Promise<RpcNotesEditCensusResult> => {
      const acc = emptyAccumulator();
      const visible = await visibleNotes();
      const counted = visible.slice(0, MAX_EDIT_CENSUS_NOTES_PER_RUN);
      for (const [noteId, metadata] of counted) {
        const snapshot = await readSnapshot(noteId);
        record(acc, classify(noteId, metadata, snapshot, CENSUS_REQUEST_ID));
      }
      return result(acc, undefined, visible.length - counted.length);
    },
    note: async (noteId: string, handle: string): Promise<RpcNotesEditCensusResult | undefined> => {
      if (bufferByteLength(handle, "utf8") === 0) return undefined;
      // A handle outlives the minting call; a note hidden since then is
      // indistinguishable from an unknown handle, and its snapshot is not read.
      if (isNoteVisible === undefined) {
        if (!(await visibleNotes()).some(([visibleId]) => visibleId === noteId)) return undefined;
      } else {
        const visible = await isNoteVisible(noteId);
        // Unknown visibility is not a hidden note: reporting "missing" would
        // assert something the census could not establish.
        if (visible === undefined) throw new NotesEditCensusUnavailableError();
        if (visible !== true) return undefined;
      }
      const snapshot = await readSnapshot(noteId);
      const snapshotRecord = ownRecord(snapshot);
      const metadata =
        snapshotRecord === undefined ? undefined : ownRecord(ownField(snapshotRecord, "metadata"));
      if (snapshotRecord === undefined && metadata === undefined) return undefined;
      const acc = emptyAccumulator();
      record(acc, classify(noteId, metadata ?? undefined, snapshot, CENSUS_REQUEST_ID));
      return result(acc, handle, 0);
    },
  });
}
