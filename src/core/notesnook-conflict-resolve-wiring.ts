/**
 * Stage 5 slice A — the keep-both conflict resolver and its injected seam.
 *
 * `createNotesnookConflictResolver` resolves one conflicted note in keep-both
 * mode. It runs these steps in order: re-run the inspection and check its
 * binding; create a copy that holds the bridge-local side; read the copy back
 * and require its title and byte-equal content; re-create the original's
 * notebook and tag memberships on the copy as relations, then read them back
 * and require every one; re-check the binding; adopt the remote side on the
 * original through core's `content.add` with `dateResolved`; clear the note's
 * conflicted flag; read the original back and require every resolved field,
 * including the content row's own id and note id.
 *
 * Nothing is trashed, deleted, merged, or synced. The module reaches upstream
 * only through the seven slots of `NotesnookConflictResolveSeam`, and it has no
 * delete, trash, sync, or generic-write slot. The caller must hold the database
 * mutex for the whole `resolveKeepBoth` or `capture` call. The seam's
 * `contentWithConflicted` must be the pure by-id reader (`content.collection.get`).
 */

import { Buffer } from "node:buffer";

import {
  createNotesnookLocalConflictInspector,
  type NotesnookConflictInspection,
  type NotesnookConflictSideFacts,
} from "./notesnook-local-conflict-projection.js";
import { STAGE4_WRITE_LIMITS } from "./notesnook-write-contract.js";

const MAX_IDENTIFIER_LENGTH = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;
const BINDING_PATTERN = /^[0-9a-f]{64}$/;
/** Upper bound on the notebook and tag memberships one note may carry. */
const MAX_MEMBERSHIPS = 256;
/** Same marker the Stage 0 projection uses. Kept local so the projection stays unchanged. */
const ATTACHMENT_MARKER = /\sdata-hash\s*=/i;
/** Suffix for the copy. A derived title always differs from the original's, so it cannot collide. */
const COPY_TITLE_SUFFIX = " (bridge copy)";
const UNTITLED_BASE = "Untitled";

const RESOLVE_ERRORS = new WeakSet<object>();

/** A frozen, chain-free categorical error. Only invalid caller arguments reach the caller. */
export class NotesnookConflictResolveError extends Error {
  constructor(message: string) {
    super(message);
    Object.defineProperty(this, "cause", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: undefined,
    });
    Object.defineProperty(this, "__context__", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: undefined,
    });
    Object.defineProperty(this, "name", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: "NotesnookConflictResolveError",
    });
    RESOLVE_ERRORS.add(this);
    Object.freeze(this);
  }
}

/** Identify only errors created by this module. */
export function isNotesnookConflictResolveError(
  value: unknown,
): value is NotesnookConflictResolveError {
  return typeof value === "object" && value !== null && RESOLVE_ERRORS.has(value);
}

/** A notebook or tag the original note belongs to. Membership is a relation, never a field. */
export type NotesnookConflictMembership = Readonly<{
  type: "notebook" | "tag";
  id: string;
}>;

/** Fields the copy write receives. The copy's content is always the local side, verbatim. */
export type NotesnookConflictCopyInput = Readonly<{
  title: string;
  content: Readonly<{ type: "tiptap"; data: string }>;
}>;

/** One relation FROM the copy note TO a notebook or a tag. Nothing else is expressible. */
export type NotesnookConflictRelateInput = Readonly<{
  noteId: string;
  to: NotesnookConflictMembership;
}>;

/** The only fields the resolution write may carry. The allowlist is exact. */
export type NotesnookConflictContentResolveInput = Readonly<{
  id: string;
  noteId: string;
  data: string;
  dateResolved: number;
}>;

/**
 * The seven injected slots, and nothing else. `contentWithConflicted` must be a
 * pure by-id read. `notesAddVerbatim` and `contentResolve` are the only content
 * writes. `noteClearConflict` is the only flag write. `noteRelate` creates
 * copy-to-notebook and copy-to-tag relations and nothing more. `noteRelations`
 * is read-only: it returns the notebook and tag memberships of one note id, and
 * no other relation type is reachable through it.
 *
 * `noteMeta` returns the note row with a `memberships` array of
 * {@link NotesnookConflictMembership}. A row without that array fails closed.
 */
export type NotesnookConflictResolveSeam = Readonly<{
  noteMeta(id: string): PromiseLike<unknown>;
  contentWithConflicted(contentId: string): PromiseLike<unknown>;
  notesAddVerbatim(input: NotesnookConflictCopyInput): PromiseLike<unknown>;
  contentResolve(input: NotesnookConflictContentResolveInput): PromiseLike<unknown>;
  noteClearConflict(id: string): PromiseLike<unknown>;
  noteRelate(input: NotesnookConflictRelateInput): PromiseLike<unknown>;
  noteRelations(noteId: string): PromiseLike<unknown>;
}>;

/**
 * Closed failure set. Every failure leaves the original untouched except where
 * the variant says otherwise. Titles name the notes, so no ids leave the module.
 */
export type NotesnookConflictResolveFailure =
  /** The note is not conflicted. Nothing was written. */
  | Readonly<{ outcome: "not-conflicted" }>
  /** The note is missing or trashed. Nothing was written. */
  | Readonly<{ outcome: "not-found" }>
  /** A side is locked or ciphered. Nothing was written. */
  | Readonly<{ outcome: "vault_locked" }>
  /** A side is non-tiptap, has no data, or is over the size cap, or has attachments. */
  | Readonly<{ outcome: "unsupported_content" }>
  /** The binding moved. `copyCreated` says whether a copy was already made. */
  | Readonly<{ outcome: "stale_revision"; copyCreated: boolean }>
  /** A read failed before any write. */
  | Readonly<{ outcome: "read_failed" }>
  /** Creating the copy threw. The original is untouched. */
  | Readonly<{ outcome: "copy_failed" }>
  /** The copy exists but did not read back as the local side. The original is untouched. */
  | Readonly<{ outcome: "copy_unverified" }>
  /** A membership relation on the copy could not be created. The original is untouched. */
  | Readonly<{ outcome: "relation_failed" }>
  /** The content write threw. It may or may not have landed, and the flag is still set. */
  | Readonly<{ outcome: "content_write_failed" }>
  /** The content is resolved but the flag clear failed. The note still refuses writes. */
  | Readonly<{ outcome: "resolved_flag_pending" }>
  /** The writes ran, but the original did not read back as resolved. */
  | Readonly<{ outcome: "post_write_unverified" }>;

export type NotesnookConflictResolveResult =
  | Readonly<{ outcome: "resolved"; originalTitle: string; copyTitle: string }>
  | NotesnookConflictResolveFailure;

/**
 * A verified, write-free plan for one conflicted note. The caller records the
 * identifiers and digests it needs from this; it never serialises the bodies.
 */
export type NotesnookConflictCapture =
  | Readonly<{
      outcome: "ready";
      noteId: string;
      contentId: string;
      originalTitle: string;
      copyTitle: string;
      remoteDate: number;
      remoteText: string;
    }>
  | NotesnookConflictResolveFailure;

/** Separately named keep-both resolver. Construction performs no upstream operation. */
export type NotesnookConflictResolver = Readonly<{
  /** Inspect and gate one note. Writes nothing. Refusals match `resolveKeepBoth`. */
  capture(id: string, expectedBinding: string): Promise<NotesnookConflictCapture>;
  resolveKeepBoth(id: string, expectedBinding: string): Promise<NotesnookConflictResolveResult>;
}>;

/**
 * Capture the six slots from an injected seam. Construction reads each slot
 * once, refuses any extra or missing slot, and performs no upstream call.
 */
export function createNotesnookConflictResolver(
  seam: NotesnookConflictResolveSeam,
): NotesnookConflictResolver {
  const slots = captureSlots(seam);

  const capture = async (
    id: string,
    expectedBinding: string,
  ): Promise<NotesnookConflictCapture> => {
    const requestedId = validateIdentifier(id, "conflict resolve note id is invalid");
    if (typeof expectedBinding !== "string" || !BINDING_PATTERN.test(expectedBinding)) {
      throw resolveError("conflict resolve binding is invalid");
    }
    const gated = await gate(slots, requestedId, expectedBinding);
    if ("refusal" in gated) return Object.freeze(gated.refusal);
    const plan = gated.plan;
    return Object.freeze({
      outcome: "ready",
      noteId: plan.noteId,
      contentId: plan.contentId,
      originalTitle: plan.originalTitle,
      copyTitle: plan.copyTitle,
      remoteDate: plan.remoteDate,
      remoteText: plan.remoteText,
    });
  };

  const resolveKeepBoth = async (
    id: string,
    expectedBinding: string,
  ): Promise<NotesnookConflictResolveResult> => {
    const requestedId = validateIdentifier(id, "conflict resolve note id is invalid");
    if (typeof expectedBinding !== "string" || !BINDING_PATTERN.test(expectedBinding)) {
      throw resolveError("conflict resolve binding is invalid");
    }
    return Object.freeze(await resolveOnce(slots, requestedId, expectedBinding));
  };

  return Object.freeze({ capture, resolveKeepBoth });
}

type SlotFunction = (...args: unknown[]) => unknown;

type CapturedSlots = Readonly<{
  noteMeta(id: string): Promise<unknown>;
  contentWithConflicted(contentId: string): Promise<unknown>;
  notesAddVerbatim(input: NotesnookConflictCopyInput): Promise<unknown>;
  contentResolve(input: NotesnookConflictContentResolveInput): Promise<unknown>;
  noteClearConflict(id: string): Promise<unknown>;
  noteRelate(input: NotesnookConflictRelateInput): Promise<unknown>;
  noteRelations(noteId: string): Promise<unknown>;
}>;

const SEAM_SLOT_NAMES: ReadonlyArray<string> = [
  "noteMeta",
  "contentWithConflicted",
  "notesAddVerbatim",
  "contentResolve",
  "noteClearConflict",
  "noteRelate",
  "noteRelations",
];

function captureSlots(seam: unknown): CapturedSlots {
  if (!isObjectLike(seam)) throw resolveError("conflict resolve seam is unavailable");
  const keys = Reflect.ownKeys(seam);
  if (keys.length !== SEAM_SLOT_NAMES.length || !SEAM_SLOT_NAMES.every((k) => keys.includes(k))) {
    throw resolveError("conflict resolve seam must expose exactly the seven resolve slots");
  }

  const noteMeta = readSlot(seam, "noteMeta");
  const contentWithConflicted = readSlot(seam, "contentWithConflicted");
  const notesAddVerbatim = readSlot(seam, "notesAddVerbatim");
  const contentResolve = readSlot(seam, "contentResolve");
  const noteClearConflict = readSlot(seam, "noteClearConflict");
  const noteRelate = readSlot(seam, "noteRelate");
  const noteRelations = readSlot(seam, "noteRelations");

  return Object.freeze({
    noteMeta: (id: string) => invoke(seam, noteMeta, [id]),
    contentWithConflicted: (contentId: string) => invoke(seam, contentWithConflicted, [contentId]),
    notesAddVerbatim: (input: NotesnookConflictCopyInput) =>
      invoke(seam, notesAddVerbatim, [input]),
    contentResolve: (input: NotesnookConflictContentResolveInput) =>
      invoke(seam, contentResolve, [input]),
    noteClearConflict: (id: string) => invoke(seam, noteClearConflict, [id]),
    noteRelate: (input: NotesnookConflictRelateInput) => invoke(seam, noteRelate, [input]),
    noteRelations: (noteId: string) => invoke(seam, noteRelations, [noteId]),
  });
}

function readSlot(owner: object, name: string): SlotFunction {
  let value: unknown;
  try {
    value = Reflect.get(owner, name);
  } catch {
    throw resolveError("conflict resolve seam slot is unavailable");
  }
  if (typeof value !== "function") throw resolveError("conflict resolve seam slot is unavailable");
  return value as SlotFunction;
}

async function invoke(
  owner: object,
  slot: SlotFunction,
  args: readonly unknown[],
): Promise<unknown> {
  return await Reflect.apply(slot, owner, [...args]);
}

/** One inspection pass, with the note and content rows it read captured. */
type Observation = Readonly<{
  inspection: NotesnookConflictInspection;
  note: unknown;
  row: unknown;
}>;

/**
 * Run the Stage 0 inspector. The injected readers are wrapped so the rows the
 * binding was computed over are the rows the copy uses. Returns `undefined` if
 * the inspection could not complete.
 */
async function observe(slots: CapturedSlots, id: string): Promise<Observation | undefined> {
  const seen: { note?: unknown; row?: unknown } = {};
  const inspector = createNotesnookLocalConflictInspector({
    notes: {
      note: async (noteId: string) => {
        seen.note = await slots.noteMeta(noteId);
        return seen.note;
      },
    },
    contentWithConflicted: {
      get: async (contentId: string) => {
        seen.row = await slots.contentWithConflicted(contentId);
        return seen.row;
      },
    },
  });

  try {
    const inspection = await inspector.inspectConflict(id);
    return Object.freeze({ inspection, note: seen.note, row: seen.row });
  } catch {
    return undefined;
  }
}

type ResolvePlan = Readonly<{
  noteId: string;
  contentId: string;
  originalTitle: string;
  copyTitle: string;
  copyInput: NotesnookConflictCopyInput;
  memberships: readonly NotesnookConflictMembership[];
  localText: string;
  remoteText: string;
  remoteDate: number;
}>;

type Gated =
  | Readonly<{ plan: ResolvePlan }>
  | Readonly<{ refusal: NotesnookConflictResolveFailure }>;

async function resolveOnce(
  slots: CapturedSlots,
  id: string,
  expectedBinding: string,
): Promise<NotesnookConflictResolveResult> {
  const gated = await gate(slots, id, expectedBinding);
  if ("refusal" in gated) return gated.refusal;
  const plan = gated.plan;

  // Step 2: create the copy from the bridge-local side. An id that names the
  // original is not a copy, and reading it back would read the original row.
  let created: unknown;
  try {
    created = await slots.notesAddVerbatim(plan.copyInput);
  } catch {
    return { outcome: "copy_failed" };
  }
  const copyId = optionalIdentifier(created);
  if (copyId === undefined || copyId === plan.noteId) return { outcome: "copy_unverified" };

  // Step 3: the copy must read back as the derived title, byte-for-byte equal to the local side.
  if ((await readCopyText(slots, copyId, plan.copyTitle)) !== plan.localText) {
    return { outcome: "copy_unverified" };
  }

  // Step 4: the copy takes the original's notebook and tag memberships, as relations.
  for (const membership of plan.memberships) {
    try {
      await slots.noteRelate({ noteId: copyId, to: membership });
    } catch {
      return { outcome: "relation_failed" };
    }
  }

  // Step 4b: read the copy's memberships back. A relation that did not land is
  // refused here, before the content write, so the original is untouched.
  if (!(await copyCarriesMemberships(slots, copyId, plan.memberships))) {
    return { outcome: "relation_failed" };
  }

  // Step 5: re-check the binding before the original is touched.
  const recheck = await observe(slots, plan.noteId);
  if (
    recheck === undefined ||
    recheck.inspection.outcome !== "inspected" ||
    recheck.inspection.binding !== expectedBinding
  ) {
    return { outcome: "stale_revision", copyCreated: true };
  }

  // Step 6: the original adopts the remote side, through core's resolution protocol.
  try {
    await slots.contentResolve({
      id: plan.contentId,
      noteId: plan.noteId,
      data: plan.remoteText,
      dateResolved: plan.remoteDate,
    });
  } catch {
    return { outcome: "content_write_failed" };
  }

  // Step 7: clear the conflicted flag. A failure here leaves the content resolved.
  try {
    await slots.noteClearConflict(plan.noteId);
  } catch {
    return { outcome: "resolved_flag_pending" };
  }

  // Step 8: the original must read back with every resolved field.
  if (!(await verifyOriginal(slots, plan))) return { outcome: "post_write_unverified" };
  return { outcome: "resolved", originalTitle: plan.originalTitle, copyTitle: plan.copyTitle };
}

/** Inspect the note and decide whether it may be resolved. Refusals never write. */
async function gate(slots: CapturedSlots, id: string, expectedBinding: string): Promise<Gated> {
  const observation = await observe(slots, id);
  if (observation === undefined) return refuse({ outcome: "read_failed" });

  const inspection = observation.inspection;
  if (inspection.outcome === "not-conflicted") return refuse({ outcome: "not-conflicted" });
  if (inspection.outcome === "not-found") return refuse({ outcome: "not-found" });
  if (inspection.outcome === "unreadable") {
    return refuse(unreadableFailure(inspection.local, inspection.remote));
  }
  if (inspection.binding !== expectedBinding) {
    return refuse({ outcome: "stale_revision", copyCreated: false });
  }

  let plan: ResolvePlan;
  try {
    plan = planFrom(id, observation);
  } catch {
    return refuse({ outcome: "read_failed" });
  }
  const oversized =
    Buffer.byteLength(plan.localText, "utf8") > STAGE4_WRITE_LIMITS.maxContentBytes ||
    Buffer.byteLength(plan.remoteText, "utf8") > STAGE4_WRITE_LIMITS.maxContentBytes;
  const hasAttachments = ATTACHMENT_MARKER.test(plan.localText) || inspection.remoteHasAttachments;
  if (oversized || hasAttachments) return refuse({ outcome: "unsupported_content" });

  return Object.freeze({ plan });
}

function refuse(failure: NotesnookConflictResolveFailure): Gated {
  return Object.freeze({ refusal: failure });
}

/** A locked side means the vault is locked. Any other unreadable side is unsupported content. */
function unreadableFailure(
  local: NotesnookConflictSideFacts,
  remote: NotesnookConflictSideFacts,
): NotesnookConflictResolveFailure {
  return lockedSide(local) || lockedSide(remote)
    ? { outcome: "vault_locked" }
    : { outcome: "unsupported_content" };
}

function lockedSide(side: NotesnookConflictSideFacts): boolean {
  return side.present && !side.unlocked;
}

/** Build the plan from the same rows the binding covers. Throws on any malformed field. */
function planFrom(noteId: string, observation: Observation): ResolvePlan {
  const note = observation.note;
  const originalTitle = readText(field(note, "title"));
  const contentId = readIdentifier(field(note, "contentId"));
  const memberships = readMemberships(field(note, "memberships"));

  const row = observation.row;
  const localText = readText(field(row, "data"));
  const remote = field(row, "conflicted");
  const remoteText = readText(field(remote, "data"));
  const remoteDate = readDate(field(remote, "dateModified"));

  const copyTitle = copyTitleFor(originalTitle);
  const copyInput: NotesnookConflictCopyInput = {
    title: copyTitle,
    content: { type: "tiptap", data: localText },
  };

  return {
    noteId,
    contentId,
    originalTitle,
    copyTitle,
    copyInput,
    memberships,
    localText,
    remoteText,
    remoteDate,
  };
}

/** Keep the title's first characters, then append the suffix. The result always differs from the original. */
export function copyTitleFor(title: string): string {
  const base = title.trim().length === 0 ? UNTITLED_BASE : title;
  const room = STAGE4_WRITE_LIMITS.maxTitleLength - COPY_TITLE_SUFFIX.length;
  return `${Array.from(base).slice(0, room).join("")}${COPY_TITLE_SUFFIX}`;
}

/**
 * Read the copy back by its note id. The copy must carry the derived copy title,
 * so a row that is not the copy this resolve asked for cannot satisfy the check.
 * Returns `undefined` on any mismatch or failure.
 */
async function readCopyText(
  slots: CapturedSlots,
  copyId: string,
  copyTitle: string,
): Promise<string | undefined> {
  try {
    const note = await slots.noteMeta(copyId);
    if (field(note, "id") !== copyId) return undefined;
    if (field(note, "title") !== copyTitle) return undefined;
    const contentId = readIdentifier(field(note, "contentId"));
    const row = await slots.contentWithConflicted(contentId);
    if (field(row, "id") !== contentId) return undefined;
    if (field(row, "noteId") !== copyId) return undefined;
    return readText(field(row, "data"));
  } catch {
    return undefined;
  }
}

/**
 * Whether the copy's own memberships include every notebook and tag the original
 * holds. A read that fails or returns a malformed list reads as missing.
 */
async function copyCarriesMemberships(
  slots: CapturedSlots,
  copyId: string,
  wanted: readonly NotesnookConflictMembership[],
): Promise<boolean> {
  try {
    const held = readMemberships(await slots.noteRelations(copyId));
    return wanted.every((membership) =>
      held.some((present) => present.type === membership.type && present.id === membership.id),
    );
  } catch {
    return false;
  }
}

/**
 * Whether a content row's `conflicted` marker reads as cleared. Absent, `null`,
 * and `false` all clear it. Any other present value still reports a conflict.
 * This applies to the content row only. The note's own flag stays strictly
 * `false`.
 */
export function isClearedContentMarker(value: unknown): boolean {
  return value === undefined || value === null || value === false;
}

/**
 * Read the original back. Every resolved field must match before the resolve counts.
 * The content row must also be the original's own row: its id and its note id are checked.
 */
async function verifyOriginal(slots: CapturedSlots, plan: ResolvePlan): Promise<boolean> {
  try {
    const note = await slots.noteMeta(plan.noteId);
    if (
      field(note, "id") !== plan.noteId ||
      field(note, "conflicted") !== false ||
      field(note, "contentId") !== plan.contentId
    ) {
      return false;
    }
    const row = await slots.contentWithConflicted(plan.contentId);
    return (
      field(row, "id") === plan.contentId &&
      field(row, "noteId") === plan.noteId &&
      isClearedContentMarker(field(row, "conflicted")) &&
      field(row, "dateResolved") === plan.remoteDate &&
      field(row, "data") === plan.remoteText
    );
  } catch {
    return false;
  }
}

/** The original's memberships. A missing or malformed list fails closed. */
function readMemberships(value: unknown): readonly NotesnookConflictMembership[] {
  if (!Array.isArray(value) || value.length > MAX_MEMBERSHIPS) {
    throw resolveError("conflict resolve note memberships are malformed");
  }
  const items: unknown[] = value;
  return Object.freeze(
    items.map((item) => {
      const type = field(item, "type");
      if (type !== "notebook" && type !== "tag") {
        throw resolveError("conflict resolve note memberships are malformed");
      }
      return Object.freeze({ type, id: readIdentifier(field(item, "id")) });
    }),
  );
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

/** Read a field from a plain record. Anything that is not an object reads as absent. */
function field(value: unknown, key: string): unknown {
  if (!isObjectLike(value)) return undefined;
  return Reflect.get(value, key);
}

function readText(value: unknown): string {
  if (typeof value !== "string") throw resolveError("conflict resolve text is malformed");
  return value;
}

function readDate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw resolveError("conflict resolve date is malformed");
  }
  return value;
}

function readIdentifier(value: unknown): string {
  return validateIdentifier(value, "conflict resolve identifier is malformed");
}

function optionalIdentifier(value: unknown): string | undefined {
  try {
    return readIdentifier(value);
  } catch {
    return undefined;
  }
}

function validateIdentifier(value: unknown, message: string): string {
  if (typeof value !== "string") throw resolveError(message);
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw resolveError(message);
  }
  return value;
}

function resolveError(message: string): NotesnookConflictResolveError {
  return new NotesnookConflictResolveError(message);
}
