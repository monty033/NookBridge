/**
 * Stage 5 — read-only observation of Notesnook's local conflict marker.
 *
 * The pinned @notesnook/core@8.1.3 runtime exposes `notes.conflicted` as a
 * FilteredSelector<Note>. Its only operation used here is `ids()`, followed by
 * the independent `notes.note(id)` metadata lookup. This module deliberately
 * does not import or expose the live Database, collection, sync, transport,
 * content, or mutation surfaces.
 *
 * `createNotesnookLocalConflictInspector` adds a read-only, categorical view of
 * both sides of a conflict. It reads only the note and its content by id,
 * through an injected reader that the wiring must keep pure.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

const MAX_CONFLICTS = 256;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TITLE_LENGTH = 512;

/** Domain separator so the binding digest cannot collide with other digests. */
const CONFLICT_BINDING_DOMAIN = "nookbridge.local-conflict.binding.v1";
/** Notesnook marks embedded attachments with a `data-hash` attribute. */
const ATTACHMENT_MARKER = /\sdata-hash\s*=/i;

const LOCAL_CONFLICT_ERRORS = new WeakSet<object>();

/** A frozen, chain-free categorical error emitted by this projection. */
export class NotesnookLocalConflictProjectionError extends Error {
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
      value: "NotesnookLocalConflictProjectionError",
    });
    LOCAL_CONFLICT_ERRORS.add(this);
    Object.freeze(this);
  }
}

/** Identify only errors created by this module. */
export function isNotesnookLocalConflictProjectionError(
  value: unknown,
): value is NotesnookLocalConflictProjectionError {
  return typeof value === "object" && value !== null && LOCAL_CONFLICT_ERRORS.has(value);
}

/** The minimum pinned-runtime-shaped selector needed by the observer. */
export type NotesnookLocalConflictSelector = Readonly<{
  ids(): PromiseLike<unknown>;
}>;

/**
 * Structural injected source. Extra upstream capabilities are intentionally
 * not represented here; the implementation captures only these two methods.
 */
export type NotesnookLocalConflictSource = Readonly<{
  notes: Readonly<{
    conflicted: NotesnookLocalConflictSelector;
    note(id: string): PromiseLike<unknown>;
  }>;
}>;

/** Metadata allowed to leave the local conflict projection. */
export type NotesnookLocalConflictMetadata = Readonly<{
  id: string;
  title: string;
  dateModified?: number;
}>;

/** A positive observation includes the categorical marker and no note body. */
export type NotesnookLocalConflictObservation = NotesnookLocalConflictMetadata &
  Readonly<{
    conflicted: true;
  }>;

/** Separately named, read-only local conflict observer. */
export type NotesnookLocalConflictObserver = Readonly<{
  listLocalConflicts(): Promise<ReadonlyArray<NotesnookLocalConflictMetadata>>;
  observeNoteConflict(id: string): Promise<false | NotesnookLocalConflictObservation>;
}>;

/**
 * Capture the smallest safe local-state observer surface from an already-open
 * Notesnook-shaped source. Construction performs no upstream operation.
 */
export function createNotesnookLocalConflictObserver(
  source: NotesnookLocalConflictSource,
): NotesnookLocalConflictObserver {
  const notes = readObjectProperty(source, "notes", "local conflict notes slot is unavailable");
  const selector = readObjectProperty(
    notes,
    "conflicted",
    "local conflict selector is unavailable",
  );
  const selectorIds = readFunction(selector, "ids", "local conflict selector ids is unavailable");
  const note = readFunction(notes, "note", "local conflict note lookup is unavailable");

  const listLocalConflicts = async (): Promise<ReadonlyArray<NotesnookLocalConflictMetadata>> => {
    const ids = await readConflictedIds(selector, selectorIds);
    const result: NotesnookLocalConflictMetadata[] = [];
    for (const id of ids) {
      const record = await callAsync(note, notes, [id], "local conflict note lookup call rejected");
      const projected = projectNote(record, id, true);
      if (projected === undefined) {
        throw localConflictError("local conflict selector id has no note record");
      }
      result.push(projected.metadata);
    }

    return Object.freeze(result);
  };

  const observeNoteConflict = async (
    id: string,
  ): Promise<false | NotesnookLocalConflictObservation> => {
    const requestedId = validateIdentifier(id, "local conflict note id is invalid");
    const record = await callAsync(
      note,
      notes,
      [requestedId],
      "local conflict note lookup call rejected",
    );
    const projected = projectNote(record, requestedId, false);
    if (projected === undefined || projected.conflicted !== true) return false;
    return Object.freeze({
      ...projected.metadata,
      conflicted: true as const,
    });
  };

  return Object.freeze({ listLocalConflicts, observeNoteConflict });
}

/** Separately named, read-only conflicted-note counter. Reads the selector only. */
export type NotesnookLocalConflictCounter = Readonly<{
  countLocalConflicts(): Promise<number>;
}>;

/**
 * Capture the conflicted-note count from an already-open source. The count
 * comes from the same bounded, validated `notes.conflicted.ids()` read the
 * observer uses. It performs no per-note lookup, so it is one upstream call
 * whatever the set's size, up to the bound. A set beyond the bound is refused.
 */
export function createNotesnookLocalConflictCounter(
  source: NotesnookLocalConflictSource,
): NotesnookLocalConflictCounter {
  const notes = readObjectProperty(source, "notes", "local conflict notes slot is unavailable");
  const selector = readObjectProperty(
    notes,
    "conflicted",
    "local conflict selector is unavailable",
  );
  const selectorIds = readFunction(selector, "ids", "local conflict selector ids is unavailable");

  const countLocalConflicts = async (): Promise<number> =>
    (await readConflictedIds(selector, selectorIds)).length;

  return Object.freeze({ countLocalConflicts });
}

/**
 * Read the conflicted selector once. The result is bounded by `MAX_CONFLICTS`,
 * every id is validated, and duplicate ids are refused.
 */
async function readConflictedIds(
  selector: object,
  selectorIds: (...args: unknown[]) => unknown,
): Promise<string[]> {
  const rawIds = await callAsync(
    selectorIds,
    selector,
    [],
    "local conflict selector ids call rejected",
  );
  const values = readBoundedArray(rawIds, "local conflict selector ids result");
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const id = validateIdentifier(value, "local conflict selector returned an invalid id");
    if (seen.has(id)) {
      throw localConflictError("local conflict selector returned duplicate ids");
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Categorical facts about one side of a conflict. Never carries the body. */
export type NotesnookConflictSideFacts = Readonly<{
  present: boolean;
  unlocked: boolean;
  tiptap: boolean;
  /** UTF-8 byte length. `null` unless the side is present, unlocked, and text. */
  byteSize: number | null;
}>;

/**
 * Closed outcome set for a read-only conflict inspection. Callers must switch
 * on `outcome` exhaustively. No free-form strings or upstream messages appear.
 */
export type NotesnookConflictInspection =
  | Readonly<{ outcome: "not-conflicted" }>
  | Readonly<{ outcome: "not-found" }>
  | Readonly<{
      outcome: "unreadable";
      local: NotesnookConflictSideFacts;
      remote: NotesnookConflictSideFacts;
    }>
  | Readonly<{
      outcome: "inspected";
      local: NotesnookConflictSideFacts;
      remote: NotesnookConflictSideFacts;
      sidesEqual: boolean;
      remoteHasAttachments: boolean;
      /**
       * sha256 over the note id, content id, each side's sha256, and the remote
       * dateModified. A later resolver re-checks it before it writes.
       */
      binding: string;
    }>;

/**
 * Injected inspection source. `contentWithConflicted.get` must be a pure by-id
 * read, such as `content.collection.get`. `content.get` and
 * `content.findByNoteId` run `preProcess`, which can rewrite and persist a row.
 */
export type NotesnookLocalConflictInspectSource = Readonly<{
  notes: Readonly<{
    note(id: string): PromiseLike<unknown>;
  }>;
  contentWithConflicted: Readonly<{
    get(contentId: string): PromiseLike<unknown>;
  }>;
}>;

/** Separately named, read-only conflict inspector. Construction performs no upstream operation. */
export type NotesnookLocalConflictInspector = Readonly<{
  inspectConflict(id: string): Promise<NotesnookConflictInspection>;
}>;

/**
 * Capture the read-only inspection surface from an already-open source. Only
 * the note lookup and the by-id content reader are captured.
 */
export function createNotesnookLocalConflictInspector(
  source: NotesnookLocalConflictInspectSource,
): NotesnookLocalConflictInspector {
  const notes = readObjectProperty(
    source,
    "notes",
    "local conflict inspect notes slot is unavailable",
  );
  const note = readFunction(notes, "note", "local conflict inspect note lookup is unavailable");
  const contents = readObjectProperty(
    source,
    "contentWithConflicted",
    "local conflict inspect content slot is unavailable",
  );
  const contentGet = readFunction(
    contents,
    "get",
    "local conflict inspect content lookup is unavailable",
  );

  const inspectConflict = async (id: string): Promise<NotesnookConflictInspection> => {
    const requestedId = validateIdentifier(id, "local conflict note id is invalid");
    const record = await callAsync(
      note,
      notes,
      [requestedId],
      "local conflict inspect note lookup call rejected",
    );
    if (record === undefined || record === null)
      return Object.freeze({ outcome: "not-found" as const });
    if (!readNoteConflictMarker(record, requestedId)) {
      return Object.freeze({ outcome: "not-conflicted" as const });
    }

    const contentId = readNoteContentId(record);
    const row = await callAsync(
      contentGet,
      contents,
      [contentId],
      "local conflict inspect content lookup call rejected",
    );
    const contentRecord = readContentRecord(row, requestedId, contentId);
    const local = readSide(contentRecord, "local conflict inspect content record is malformed");
    const remoteRaw =
      contentRecord === undefined
        ? undefined
        : readOptionalOwn(
            contentRecord,
            "conflicted",
            "local conflict inspect content record is malformed",
          );
    const remote = readSide(remoteRaw, "local conflict inspect remote side is malformed");

    if (!isReadable(local) || !isReadable(remote)) {
      return Object.freeze({
        outcome: "unreadable" as const,
        local: local.facts,
        remote: remote.facts,
      });
    }

    const remoteDate = readRemoteDate(remoteRaw);
    const binding = sha256Hex(
      JSON.stringify([
        CONFLICT_BINDING_DOMAIN,
        requestedId,
        contentId,
        sha256Hex(local.text),
        sha256Hex(remote.text),
        remoteDate,
      ]),
    );
    return Object.freeze({
      outcome: "inspected" as const,
      local: local.facts,
      remote: remote.facts,
      sidesEqual: local.text === remote.text,
      remoteHasAttachments: ATTACHMENT_MARKER.test(remote.text),
      binding,
    });
  };

  return Object.freeze({ inspectConflict });
}

/** One side as read, with its text kept only for in-memory digesting. */
type SideRead = Readonly<{
  facts: NotesnookConflictSideFacts;
  text: string | undefined;
}>;

type ReadableSide = SideRead & Readonly<{ text: string }>;

function isReadable(side: SideRead): side is ReadableSide {
  return side.facts.present && side.facts.unlocked && side.facts.tiptap && side.text !== undefined;
}

function readSide(value: unknown, message: string): SideRead {
  if (value === undefined || value === null) {
    return Object.freeze({
      facts: Object.freeze({ present: false, unlocked: false, tiptap: false, byteSize: null }),
      text: undefined,
    });
  }
  const side = asObject(value, message);
  const locked = readOptionalOwn(side, "locked", message);
  if (locked !== undefined && typeof locked !== "boolean") throw localConflictError(message);
  const data = readOptionalOwn(side, "data", message);
  const type = readOptionalOwn(side, "type", message);
  const unlocked = locked !== true && !isCipherValue(data, message);
  const text = unlocked && typeof data === "string" ? data : undefined;

  return Object.freeze({
    facts: Object.freeze({
      present: true,
      unlocked,
      tiptap: type === "tiptap",
      byteSize: text === undefined ? null : Buffer.byteLength(text, "utf8"),
    }),
    text,
  });
}

function isCipherValue(value: unknown, message: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  return (
    readOptionalOwn(value, "cipher", message) !== undefined &&
    readOptionalOwn(value, "iv", message) !== undefined &&
    readOptionalOwn(value, "salt", message) !== undefined
  );
}

function readNoteConflictMarker(value: unknown, requestedId: string): boolean {
  const note = asObject(value, "local conflict inspect note record is malformed");
  const id = readRequiredOwn(note, "id", "local conflict inspect note record is malformed");
  const validatedId = validateIdentifier(id, "local conflict inspect note record is malformed");
  if (validatedId !== requestedId) {
    throw localConflictError("local conflict inspect note record identity does not match request");
  }
  const marker = readRequiredOwn(
    note,
    "conflicted",
    "local conflict inspect note record is malformed",
  );
  if (typeof marker !== "boolean") {
    throw localConflictError("local conflict inspect note record is malformed");
  }
  return marker;
}

function readNoteContentId(value: unknown): string {
  const note = asObject(value, "local conflict inspect note record is malformed");
  const contentId = readRequiredOwn(
    note,
    "contentId",
    "local conflict inspect note content id is malformed",
  );
  return validateIdentifier(contentId, "local conflict inspect note content id is malformed");
}

function readContentRecord(value: unknown, noteId: string, contentId: string): object | undefined {
  if (value === undefined || value === null) return undefined;
  const row = asObject(value, "local conflict inspect content record is malformed");
  const id = readRequiredOwn(row, "id", "local conflict inspect content record is malformed");
  const owner = readRequiredOwn(
    row,
    "noteId",
    "local conflict inspect content record is malformed",
  );
  if (id !== contentId || owner !== noteId) {
    throw localConflictError(
      "local conflict inspect content record identity does not match request",
    );
  }
  return row;
}

function readRemoteDate(value: unknown): number {
  const remote = asObject(value, "local conflict inspect remote side is malformed");
  const modified = readOptionalOwn(
    remote,
    "dateModified",
    "local conflict inspect remote date is malformed",
  );
  if (typeof modified !== "number" || !Number.isFinite(modified) || modified < 0) {
    throw localConflictError("local conflict inspect remote date is malformed");
  }
  return modified;
}

function readOptionalOwn(owner: object, key: string, message: string): unknown {
  const result = readOwn(owner, key, message);
  return result.present ? result.value : undefined;
}

function asObject(value: unknown, message: string): object {
  if (typeof value !== "object" || value === null) throw localConflictError(message);
  return value;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function localConflictError(message: string): NotesnookLocalConflictProjectionError {
  return new NotesnookLocalConflictProjectionError(message);
}

function readObjectProperty(owner: unknown, key: string, message: string): object {
  if ((typeof owner !== "object" && typeof owner !== "function") || owner === null) {
    throw localConflictError(message);
  }
  let value: unknown;
  try {
    value = Reflect.get(owner, key);
  } catch {
    throw localConflictError(message);
  }
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw localConflictError(message);
  }
  return value;
}

function readFunction(
  owner: object,
  key: string,
  message: string,
): (...args: unknown[]) => unknown {
  let value: unknown;
  try {
    value = Reflect.get(owner, key);
  } catch {
    throw localConflictError(message);
  }
  if (typeof value !== "function") throw localConflictError(message);
  return value as (...args: unknown[]) => unknown;
}

async function callAsync(
  fn: (...args: unknown[]) => unknown,
  owner: object,
  args: readonly unknown[],
  message: string,
): Promise<unknown> {
  let raw: unknown;
  try {
    raw = Reflect.apply(fn, owner, [...args]);
  } catch {
    throw localConflictError(message);
  }

  let then: unknown;
  try {
    if ((typeof raw !== "object" && typeof raw !== "function") || raw === null) {
      throw localConflictError(message);
    }
    then = Reflect.get(raw, "then");
  } catch (error) {
    if (isNotesnookLocalConflictProjectionError(error)) throw error;
    throw localConflictError(message);
  }
  if (typeof then !== "function") throw localConflictError(message);

  try {
    return await (raw as PromiseLike<unknown>);
  } catch {
    throw localConflictError(message);
  }
}

function readBoundedArray(value: unknown, message: string): unknown[] {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw localConflictError(message);
  }
  if (!isArray) throw localConflictError(message);

  let length: number;
  try {
    length = (value as { length: number }).length;
  } catch {
    throw localConflictError(message);
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CONFLICTS) {
    throw localConflictError(message);
  }

  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    } catch {
      throw localConflictError(message);
    }
    if (descriptor === undefined) throw localConflictError(message);

    try {
      result.push(
        descriptor.get === undefined ? descriptor.value : Reflect.apply(descriptor.get, value, []),
      );
    } catch {
      throw localConflictError(message);
    }
  }
  return result;
}

function validateIdentifier(value: unknown, message: string): string {
  if (typeof value !== "string") throw localConflictError(message);
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw localConflictError(message);
  }
  return value;
}

type ProjectedNote = Readonly<{
  metadata: NotesnookLocalConflictMetadata;
  conflicted: boolean;
}>;

function projectNote(
  value: unknown,
  requestedId: string,
  requireConflict: boolean,
): ProjectedNote | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") {
    throw localConflictError("local conflict note record is malformed");
  }

  const id = readRequiredOwn(value, "id", "local conflict note record id is malformed");
  const validatedId = validateIdentifier(id, "local conflict note record id is malformed");
  if (validatedId !== requestedId) {
    throw localConflictError("local conflict note record identity does not match request");
  }

  const title = readRequiredOwn(value, "title", "local conflict note record title is malformed");
  if (typeof title !== "string" || title.length > MAX_TITLE_LENGTH) {
    throw localConflictError("local conflict note record title is malformed");
  }

  const marker = readRequiredOwn(value, "conflicted", "local conflict note marker is malformed");
  if (typeof marker !== "boolean") {
    throw localConflictError("local conflict note marker is malformed");
  }
  if (requireConflict && marker !== true) {
    throw localConflictError("local conflict selector note is not marked conflicted");
  }

  const dateModified = readDateModified(value);
  const mutableMetadata: {
    id: string;
    title: string;
    dateModified?: number;
  } = { id: validatedId, title };
  if (dateModified !== undefined) mutableMetadata.dateModified = dateModified;

  return {
    metadata: Object.freeze(mutableMetadata),
    conflicted: marker,
  };
}

function readRequiredOwn(owner: object, key: string, message: string): unknown {
  const value = readOwn(owner, key, message);
  if (!value.present) throw localConflictError(message);
  return value.value;
}

function readDateModified(owner: object): number | undefined {
  const modified = readOwn(owner, "dateModified", "local conflict note date is malformed");
  if (modified.present && modified.value !== undefined) {
    return validateDate(modified.value);
  }

  const edited = readOwn(owner, "dateEdited", "local conflict note date is malformed");
  if (edited.present && edited.value !== undefined) return validateDate(edited.value);
  return undefined;
}

function validateDate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw localConflictError("local conflict note date is malformed");
  }
  return value;
}

type ReadOwnResult = Readonly<{
  present: boolean;
  value?: unknown;
}>;

function readOwn(owner: object, key: string, message: string): ReadOwnResult {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(owner, key);
  } catch {
    throw localConflictError(message);
  }
  if (descriptor === undefined) return { present: false };

  try {
    return {
      present: true,
      value:
        descriptor.get === undefined ? descriptor.value : Reflect.apply(descriptor.get, owner, []),
    };
  } catch {
    throw localConflictError(message);
  }
}
