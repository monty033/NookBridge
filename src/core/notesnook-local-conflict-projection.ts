/**
 * Stage 5 — read-only observation of Notesnook's local conflict marker.
 *
 * The pinned @notesnook/core@8.1.3 runtime exposes `notes.conflicted` as a
 * FilteredSelector<Note>. Its only operation used here is `ids()`, followed by
 * the independent `notes.note(id)` metadata lookup. This module deliberately
 * does not import or expose the live Database, collection, sync, transport,
 * content, or mutation surfaces.
 */

const MAX_CONFLICTS = 256;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_TITLE_LENGTH = 512;

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
