/**
 * EA-2 — the one decision order shared by `notes.get` and `notes.edit-census`.
 *
 * `readBoundedNoteContent` used to own this logic privately.  The census has to
 * partition the corpus exactly the way a read does, so the order lives here once
 * and both callers use it:
 *
 *   1. metadata says locked, or the snapshot refused the body as locked -> locked
 *   2. no body, or the snapshot refused it for another reason -> unavailable
 *   3. decode; a decode refusal -> serializer fallback (tolerant HTML)
 *   4. empty document -> strict (empty Markdown)
 *   5. otherwise strict; "strict with preserved blocks" when the decoded
 *      document still carries opaque blocks
 *   6. a failing strict serializer -> serializer fallback, whose closed
 *      validator code is recorded so the census can say why
 *   7. decoded Markdown over the response budget, or the whole response over
 *      preflight -> oversize
 *
 * The refusal reason is carried only so the operator census can count it.  It is
 * never included in the `notes.get` projection.
 */

import { Buffer } from "node:buffer";

import {
  decodeNoteDocumentNative,
  NoteDocumentNativeError,
  type NativeFailureReason,
} from "../core/note-document-native.js";
import {
  isNoteDocumentError,
  type NoteBlock,
  type NoteDocumentErrorCode,
} from "../core/note-document.js";
import { serializeNoteDocumentMarkdown } from "../core/note-document-markdown.js";
import { noteHtmlReadonlyMarkdown } from "../core/note-html-readonly-markdown.js";
import { fitsResponsePreflight, STAGE5_RPC_LIMITS } from "./rpc-protocol.js";

const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const bufferByteLength = Buffer.byteLength;

/** Bounded Markdown content size for `notes.get`; the whole frame shares it. */
const MAX_PROJECTION_MARKDOWN_BYTES = STAGE5_RPC_LIMITS.maxResponseBytes;

export type NoteProjectionOutcome =
  | "strict"
  | "strict_with_preserved_blocks"
  /**
   * Never produced from EA-4 on: the fallback was deleted, so an opaque heading is
   * preserved with readable `text` like any other preserved block. The value
   * stays in the closed vocabulary because the census field is on the wire and
   * a published field is not removed from under a client.
   */
  | "opaque_heading_fallback"
  | "serializer_fallback"
  | "locked"
  | "oversize"
  | "unavailable";

export interface NoteProjectionClassification {
  readonly outcome: NoteProjectionOutcome;
  /**
   * Internal refusal reason, present exactly when the native decoder refused
   * the document. Its outcome is then `serializer_fallback`, `oversize` when
   * the fallback is over budget, or `unavailable` when the fallback cannot
   * render it either (an `envelope_shape` refusal always lands there).
   */
  readonly reason?: NativeFailureReason;
  /**
   * Internal reason the strict Markdown serializer refused a document that
   * decoded successfully: the validator's own closed code, or `unclassified`
   * for anything else. Present exactly when the decode succeeded and the
   * serializer threw, so it and {@link reason} never appear together.
   *
   * `invalid_shape` is the serializer's catch-all: its own guard turns every
   * throw it does not recognise into that code, so it means "the serializer
   * refused, cause not named", not a precise shape fault.
   *
   * It exists so the census can name the failing stage instead of reporting
   * every refusal as a generic serializer fallback. Like {@link reason} it is
   * never included in the `notes.get` projection.
   */
  readonly serializationReason?: NoteDocumentErrorCode | "unclassified";
  readonly markdown?: string;
  readonly markdownBytes?: number;
  /**
   * Opaque blocks (and of those, list regions) in the decoded document, counted
   * only when the outcome is one of {@link PRESERVING_OUTCOMES}. Any other
   * outcome, including a note that decoded and then fell back or went over
   * budget, carries zero.
   */
  readonly preservedBlocks: number;
  readonly preservedTaskLists: number;
}

/**
 * The outcomes of a successful decode whose document held preserved blocks.
 *
 * `opaque_heading_fallback` was one of them until EA-4 deleted that branch; it
 * is no longer produced, so counting preserved blocks for it would be counting
 * a case that cannot occur.
 */
const PRESERVING_OUTCOMES: ReadonlySet<NoteProjectionOutcome> = new Set([
  "strict_with_preserved_blocks",
]);

export interface ClassifyNoteContentInput {
  readonly contentRefusal: unknown;
  readonly envelope: unknown;
  readonly noteId: string;
  readonly note: Record<string, unknown>;
  readonly requestId: string;
}

function readOwnBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  try {
    const descriptor = objectGetOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    return typeof descriptor.value === "boolean" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function readOwnStringField(record: Record<string, unknown>, key: string): string | undefined {
  try {
    const descriptor = objectGetOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    return typeof descriptor.value === "string" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function countPreserved(
  blocks: readonly NoteBlock[],
  acc: { blocks: number; lists: number },
): void {
  for (const block of blocks) {
    if (block.type === "opaque") {
      acc.blocks += 1;
      // A preserved list region is the signal EA-7 needs: a checklist whose
      // class/structure could not be represented is opaque with a list tag.
      if (block.nodeType === "ul" || block.nodeType === "ol") acc.lists += 1;
      continue;
    }
    if (block.type === "blockquote" || block.type === "callout") {
      countPreserved(block.blocks, acc);
      continue;
    }
    if (block.type === "bullet-list" || block.type === "ordered-list") {
      for (const item of block.items) countPreserved(item.blocks ?? [], acc);
    }
  }
}

function readOnlyMarkdownFallback(envelope: unknown): string {
  if (!envelope || typeof envelope !== "object") throw new Error("unavailable");
  const candidate = envelope as { type?: unknown; data?: unknown };
  if (
    (candidate.type !== "tiptap" && candidate.type !== "html") ||
    typeof candidate.data !== "string"
  )
    throw new Error("unavailable");
  return noteHtmlReadonlyMarkdown(candidate.data);
}

export function classifyNoteContentProjection(
  input: ClassifyNoteContentInput,
): NoteProjectionClassification {
  const nothing = { preservedBlocks: 0, preservedTaskLists: 0 } as const;
  if (readOwnBooleanField(input.note, "locked") === true || input.contentRefusal === "locked") {
    return { outcome: "locked", ...nothing };
  }
  if (input.contentRefusal !== undefined || input.envelope === undefined) {
    return { outcome: "unavailable", ...nothing };
  }
  // Outside the try, so a refusal survives a fallback that throws as well.
  let reason: NativeFailureReason | undefined;
  let serializationReason: NoteDocumentErrorCode | "unclassified" | undefined;
  try {
    const revision = readOwnStringField(input.note, "revision") ?? `rev_${"0".repeat(32)}`;
    let markdown: string;
    let outcome: NoteProjectionOutcome;
    const preserved = { blocks: 0, lists: 0 };
    try {
      const decoded = decodeNoteDocumentNative(input.envelope, {
        noteId: input.noteId,
        revision,
      });
      countPreserved(decoded.document.blocks, preserved);
      if (decoded.document.blocks.length === 0) {
        markdown = "";
        outcome = "strict";
      } else {
        markdown = serializeNoteDocumentMarkdown(decoded.document);
        outcome = preserved.blocks > 0 ? "strict_with_preserved_blocks" : "strict";
      }
    } catch (error) {
      // Every throw inside the decoder already arrives as a native refusal
      // (`guard`). Anything else came from the Markdown steps after a
      // successful decode, and the serializer's own guard makes those a
      // `NoteDocumentError` carrying a closed code — which is the only thing
      // that can tell an operator why a note is not editable.
      if (error instanceof NoteDocumentNativeError) reason = error.reason;
      else if (isNoteDocumentError(error)) serializationReason = error.code;
      else serializationReason = "unclassified";
      markdown = readOnlyMarkdownFallback(input.envelope);
      outcome = "serializer_fallback";
    }
    const markdownBytes = bufferByteLength(markdown, "utf8");
    // A fallback is counted with its preserved totals only when the decode
    // succeeded: that is the note shape the preservation work is about, and
    // zeroing it would hide whether a refused note even had preserved content.
    const reportsPreserved =
      PRESERVING_OUTCOMES.has(outcome) ||
      (serializationReason !== undefined && outcome === "serializer_fallback");
    const result = {
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(serializationReason === undefined ? {} : { serializationReason }),
      ...(reportsPreserved
        ? { preservedBlocks: preserved.blocks, preservedTaskLists: preserved.lists }
        : nothing),
    } as const;
    const oversize = { ...result, outcome: "oversize", ...nothing } as const;
    if (markdownBytes > MAX_PROJECTION_MARKDOWN_BYTES) return oversize;
    // Mirror the serializer's preflight over every response-owned string field
    // it will charge, so the census classifies a note the same way a read does.
    const charged: string[] = [input.requestId];
    for (const key of ["id", "title", "revision", "notebookId"] as const) {
      const value = input.note[key];
      if (typeof value === "string") charged.push(value);
    }
    charged.push(markdown);
    if (!fitsResponsePreflight(charged)) return oversize;
    return { ...result, markdown, markdownBytes };
  } catch {
    return {
      outcome: "unavailable",
      ...(reason === undefined ? {} : { reason }),
      ...(serializationReason === undefined ? {} : { serializationReason }),
      ...nothing,
    };
  }
}
