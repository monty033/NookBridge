/**
 * Stage 4 runtime-to-write-capability wiring.
 *
 * This module owns a closed structural runtime type and projects it into the
 * existing mutator-only NotesnookWriteDatabase seam.  It deliberately imports
 * no Notesnook package and never exposes a raw database, generic collection,
 * sync, transport, vault, or authentication capability.
 */

import {
  NotesnookWriteContractError,
  isNotesnookWriteContractError,
  STAGE4_WRITE_LIMITS,
  type NotesnookWriteErrorCode,
} from "./notesnook-write-contract.js";
import type {
  NotesnookStoredContent,
  NotesnookWriteDatabase,
  NotesnookWriteNoteMetadata,
  NotesnookWriteStoredContent,
} from "./notesnook-write-adapter.js";

/** Maximum number of runtime array entries admitted across this boundary. */
const MAX_RUNTIME_ARRAY_ITEMS = 1024;

export interface NotesnookWriteRuntimeContent {
  readonly id: string;
  readonly noteId: string;
  readonly type: "tiptap" | "tiny";
  readonly data: string;
}

export interface NotesnookWriteRuntimeNote {
  readonly id: string;
  readonly title: string;
  readonly contentId?: string;
  readonly notebookId?: string;
  readonly pinned: boolean;
  readonly favorite: boolean;
  readonly conflicted: boolean;
  readonly locked: boolean;
  readonly dateEdited: number;
  readonly tags?: readonly string[];
}

export interface NotesnookWriteRuntimeNotes {
  readonly note: (id: string) => Promise<NotesnookWriteRuntimeNote | undefined>;
  readonly add: (item: {
    readonly title: string;
    readonly content?: NotesnookWriteRuntimeContent;
  }) => Promise<string>;
  readonly addToNotebook: (notebookId: string, ...noteIds: string[]) => Promise<void>;
  readonly removeFromNotebook: (notebookId: string, ...noteIds: string[]) => Promise<void>;
  readonly collection: {
    readonly update: (ids: readonly string[], partial: Record<string, unknown>) => Promise<void>;
  };
}

export interface NotesnookWriteRuntimeContentCollection {
  readonly add: (partial: Record<string, unknown>) => Promise<string>;
  readonly findByNoteId: (noteId: string) => Promise<NotesnookWriteRuntimeContent | undefined>;
  readonly updateByNoteId: (partial: Record<string, unknown>, ...ids: string[]) => Promise<void>;
}

export interface NotesnookWriteRuntimeNotebooks {
  readonly exists: (id: string) => Promise<boolean>;
  readonly notes: (id: string) => Promise<readonly string[]>;
}

/** Only the ID lookup and creation operations are consumed by the seam. */
export interface NotesnookWriteRuntimeTags {
  readonly tag: (
    id: string,
  ) => Promise<{ readonly id: string; readonly title: string } | undefined>;
  readonly add: (input: { readonly title: string }) => Promise<string>;
}

export interface NotesnookWriteRuntimeRelations {
  readonly add: (
    from: { readonly id: string; readonly type: string },
    to: { readonly id: string; readonly type: string },
  ) => Promise<void>;
  readonly unlink: (
    from: { readonly id: string; readonly type: string },
    to: { readonly id: string; readonly type: string },
  ) => Promise<void>;
  readonly from: (
    reference:
      | { readonly id: string; readonly type: string }
      | { readonly type: string; readonly ids: readonly string[] },
  ) => {
    readonly get: () => Promise<
      ReadonlyArray<{
        readonly fromId: string;
        readonly fromType: string;
        readonly toId: string;
        readonly toType: string;
      }>
    >;
  };
}

export interface NotesnookWriteRuntime {
  readonly notes: NotesnookWriteRuntimeNotes;
  readonly content: NotesnookWriteRuntimeContentCollection;
  readonly notebooks: NotesnookWriteRuntimeNotebooks;
  readonly tags: NotesnookWriteRuntimeTags;
  readonly relations: NotesnookWriteRuntimeRelations;
}

export type NotesnookWriteRuntimeSource = NotesnookWriteRuntime | (() => NotesnookWriteRuntime);

const FORBIDDEN_RUNTIME_NAMES: readonly string[] = [
  "sync",
  "lastSynced",
  "hasUnsyncedChanges",
  "listNotebooks",
  "noteMetadata",
  "search",
  "database",
  "collection",
  "raw",
  "core",
  "internal",
  "send",
  "full",
  "fetch",
  "delete",
  "remove",
  "moveToTrash",
  "duplicate",
  "restore",
  "force",
  "clear",
  "reset",
  "dropTable",
  "exec",
  "import",
  "export",
  "vaultUnlock",
  "vaultLock",
  "vaultAdd",
  "vaultRemove",
  "vaultCreate",
  "vaultClear",
  "changePassword",
  "user",
  "tokenManager",
  "kv",
  "transport",
  "disconnectSSE",
  "connectSSE",
  "host",
  "pin",
  "favorite",
  "readonly",
  "localOnly",
  "setLastSynced",
  "addToNotebook",
  "removeFromNotebook",
  "removeFromAllNotebooks",
  "publish",
  "unpublish",
  "writeEncrypted",
  "writeMulti",
  "write",
  "removeMulti",
  "init",
  "setup",
];

const RUNTIME_SLOTS = {
  notes: ["note", "add", "addToNotebook", "removeFromNotebook", "collection"],
  content: ["add", "findByNoteId", "updateByNoteId"],
  notebooks: ["exists", "notes"],
  tags: ["tag", "add"],
  relations: ["add", "unlink", "from"],
} as const;

/**
 * Validate and snapshot the runtime.  Each top-level child, nested
 * collection, and method reference is read exactly once through a guarded
 * read.  The returned immutable null-prototype snapshot retains the original
 * owners alongside methods already bound to those owners; construction never
 * reads the source or any original child again.
 */
interface RuntimeSnapshot {
  readonly notes: {
    readonly owner: object;
    readonly note: NotesnookWriteRuntimeNotes["note"];
    readonly add: NotesnookWriteRuntimeNotes["add"];
    readonly addToNotebook: NotesnookWriteRuntimeNotes["addToNotebook"];
    readonly removeFromNotebook: NotesnookWriteRuntimeNotes["removeFromNotebook"];
    readonly collection: {
      readonly owner: object;
      readonly update: NotesnookWriteRuntimeNotes["collection"]["update"];
    };
  };
  readonly content: {
    readonly owner: object;
    readonly add: NotesnookWriteRuntimeContentCollection["add"];
    readonly findByNoteId: NotesnookWriteRuntimeContentCollection["findByNoteId"];
    readonly updateByNoteId: NotesnookWriteRuntimeContentCollection["updateByNoteId"];
  };
  readonly notebooks: {
    readonly owner: object;
    readonly exists: NotesnookWriteRuntimeNotebooks["exists"];
    readonly notes: NotesnookWriteRuntimeNotebooks["notes"];
  };
  readonly tags: {
    readonly owner: object;
    readonly tag: NotesnookWriteRuntimeTags["tag"];
    readonly add: NotesnookWriteRuntimeTags["add"];
  };
  readonly relations: {
    readonly owner: object;
    readonly add: NotesnookWriteRuntimeRelations["add"];
    readonly unlink: NotesnookWriteRuntimeRelations["unlink"];
    readonly from: NotesnookWriteRuntimeRelations["from"];
  };
}

export function bindNotesnookWriteRuntime(
  source: NotesnookWriteRuntimeSource,
): NotesnookWriteDatabase {
  const snapshot = validateRuntime(resolveRuntime(source));

  const note = async (id: string): Promise<NotesnookWriteNoteMetadata | undefined> => {
    const safeId = requireIdentifier(id);
    const noteResult = await safeCall(() => snapshot.notes.note(safeId));
    if (noteResult === undefined) return undefined;
    // Fetch the stored content in parallel only when the upstream
    // `note.locked` field is absent (Astra finding P1-2).  When the
    // note record explicitly supplies the flag, that value is the
    // source of truth and the content lookup is wasted work.
    const noteRecord =
      typeof noteResult === "object" && noteResult !== null
        ? (noteResult as unknown as Record<string, unknown>)
        : undefined;
    const hasExplicitLocked =
      noteRecord !== undefined && Object.prototype.hasOwnProperty.call(noteRecord, "locked");
    let contentLocked: boolean | undefined;
    if (hasExplicitLocked) {
      contentLocked = undefined;
    } else {
      try {
        const contentResult = await safeCall(() => snapshot.content.findByNoteId(safeId));
        contentLocked =
          contentResult !== undefined && contentResult !== null && typeof contentResult === "object"
            ? readOptionalLockedMarker(contentResult)
            : undefined;
      } catch {
        contentLocked = undefined;
      }
    }
    return mapNote(noteResult, safeId, contentLocked);
  };

  const notesAdd = async (input: {
    readonly title: string;
    readonly content: NotesnookStoredContent;
  }): Promise<string> => {
    const record = requireAllowedObject(input, ["title", "content"]);
    const title = requireString(record.values.title);
    const content = requireAllowedObject(record.values.content, ["type", "data"]);
    const contentType = mapSeamContentType(content.values.type);
    const data = requireString(content.values.data);
    const upstreamContent: NotesnookWriteRuntimeContent = {
      id: "",
      noteId: "",
      type: contentType,
      data,
    };
    const result = await safeCall(() => snapshot.notes.add({ title, content: upstreamContent }));
    return requireIdentifier(result, "sync_failed");
  };

  const notesUpdate = async (
    ids: readonly string[],
    partial: Record<string, unknown>,
  ): Promise<void> => {
    const safeIds = readStringArray(ids, "invalid_input", true);
    const safePartial = mapNotesPartial(partial);
    await safeCall(() => snapshot.notes.collection.update(safeIds, safePartial));
  };

  const contentFindByNoteId = async (
    noteId: string,
  ): Promise<NotesnookWriteStoredContent | undefined> => {
    const safeNoteId = requireIdentifier(noteId);
    const result = await safeCall(() => snapshot.content.findByNoteId(safeNoteId));
    if (result === undefined) return undefined;
    return mapContent(result, safeNoteId);
  };

  const contentAdd = async (partial: Record<string, unknown>): Promise<string> => {
    const safePartial = mapContentPartial(partial);
    const result = await safeCall(() => snapshot.content.add(safePartial));
    return requireIdentifier(result, "sync_failed");
  };

  const contentUpdateByNoteId = async (
    partial: Record<string, unknown>,
    ...ids: string[]
  ): Promise<void> => {
    const safePartial = mapContentPartial(partial);
    const safeIds = readStringArray(ids, "invalid_input", true);
    await safeCall(() => snapshot.content.updateByNoteId(safePartial, ...safeIds));
  };

  const notebookExists = async (id: string): Promise<boolean> => {
    const safeId = requireIdentifier(id);
    const result: unknown = await safeCall(() => snapshot.notebooks.exists(safeId));
    if (typeof result !== "boolean") throw wiringError("sync_failed");
    return result;
  };

  const notebookNotes = async (id: string): Promise<readonly string[]> => {
    const safeId = requireIdentifier(id);
    const result: unknown = await safeCall(() => snapshot.notebooks.notes(safeId));
    return readStringArray(result, "sync_failed", false);
  };

  const notebookAddNote = async (notebookId: string, noteId: string): Promise<void> => {
    const safeNotebookId = requireIdentifier(notebookId);
    const safeNoteId = requireIdentifier(noteId);
    await safeCall(() => snapshot.notes.addToNotebook(safeNotebookId, safeNoteId));
  };

  const notebookRemoveNote = async (notebookId: string, noteId: string): Promise<void> => {
    const safeNotebookId = requireIdentifier(notebookId);
    const safeNoteId = requireIdentifier(noteId);
    await safeCall(() => snapshot.notes.removeFromNotebook(safeNotebookId, safeNoteId));
  };

  const tagExists = async (id: string): Promise<boolean> => {
    const safeId = requireIdentifier(id);
    const result = await safeCall(() => snapshot.tags.tag(safeId));
    if (result === undefined) return false;
    mapTag(result, safeId);
    return true;
  };

  const tagAdd = async (input: { readonly title: string }): Promise<string> => {
    const record = requireAllowedObject(input, ["title"]);
    const title = requireString(record.values.title);
    const result = await safeCall(() => snapshot.tags.add({ title }));
    return requireIdentifier(result, "sync_failed");
  };

  const relationAdd = async (input: {
    readonly fromId: string;
    readonly toId: string;
    readonly type: string;
  }): Promise<void> => {
    const relation = mapRelationInput(input);
    await safeCall(() =>
      snapshot.relations.add(
        { id: relation.fromId, type: "note" },
        { id: relation.toId, type: relation.type },
      ),
    );
  };

  const relationRemove = async (input: {
    readonly fromId: string;
    readonly toId: string;
    readonly type: string;
  }): Promise<void> => {
    const relation = mapRelationInput(input);
    await safeCall(() =>
      snapshot.relations.unlink(
        { id: relation.fromId, type: "note" },
        { id: relation.toId, type: relation.type },
      ),
    );
  };

  const relationListForNote = async (
    noteId: string,
  ): Promise<ReadonlyArray<{ readonly toId: string; readonly type: string }>> => {
    const safeNoteId = requireIdentifier(noteId);
    const handle = safeSyncCall(() => snapshot.relations.from({ id: safeNoteId, type: "note" }));
    const handleRecord = requireObject(handle, "sync_failed");
    const getValue = readPropertyGuarded(handleRecord, "get", "sync_failed");
    if (typeof getValue !== "function") throw wiringError("sync_failed");
    const get = bindMethod(getValue, handleRecord, "sync_failed");
    const result = await safeCall(() => get());
    return mapRelations(result, safeNoteId);
  };

  const seam = Object.create(null) as NotesnookWriteDatabase;
  defineSeamMethod(seam, "note", note);
  defineSeamMethod(seam, "contentFindByNoteId", contentFindByNoteId);
  defineSeamMethod(seam, "notesAdd", notesAdd);
  defineSeamMethod(seam, "notesUpdate", notesUpdate);
  defineSeamMethod(seam, "contentAdd", contentAdd);
  defineSeamMethod(seam, "contentUpdateByNoteId", contentUpdateByNoteId);
  defineSeamMethod(seam, "notebookExists", notebookExists);
  defineSeamMethod(seam, "notebookNotes", notebookNotes);
  defineSeamMethod(seam, "notebookAddNote", notebookAddNote);
  defineSeamMethod(seam, "notebookRemoveNote", notebookRemoveNote);
  defineSeamMethod(seam, "tagExists", tagExists);
  defineSeamMethod(seam, "tagAdd", tagAdd);
  defineSeamMethod(seam, "relationAdd", relationAdd);
  defineSeamMethod(seam, "relationRemove", relationRemove);
  defineSeamMethod(seam, "relationListForNote", relationListForNote);
  return Object.freeze(seam);
}

function resolveRuntime(source: NotesnookWriteRuntimeSource): unknown {
  let candidate: unknown;
  if (typeof source === "function") {
    try {
      candidate = source();
    } catch {
      throw wiringError("invalid_input");
    }
  } else {
    candidate = source;
  }
  if (isThenable(candidate)) throw wiringError("invalid_input");
  return candidate;
}

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  let then: unknown;
  try {
    then = Reflect.get(value, "then", value);
  } catch {
    throw wiringError("invalid_input");
  }
  return typeof then === "function";
}

function validateRuntime(value: unknown): RuntimeSnapshot {
  const root = requireObject(value, "invalid_input");
  for (let index = 0; index < FORBIDDEN_RUNTIME_NAMES.length; index += 1) {
    const name = FORBIDDEN_RUNTIME_NAMES[index]!;
    if (readHas(root, name)) throw wiringError("invalid_input");
  }

  const notesOwner = requireObject(readPropertyGuarded(root, "notes"), "invalid_input");
  const contentOwner = requireObject(readPropertyGuarded(root, "content"), "invalid_input");
  const notebooksOwner = requireObject(readPropertyGuarded(root, "notebooks"), "invalid_input");
  const tagsOwner = requireObject(readPropertyGuarded(root, "tags"), "invalid_input");
  const relationsOwner = requireObject(readPropertyGuarded(root, "relations"), "invalid_input");
  const collectionOwner = requireObject(
    readPropertyGuarded(notesOwner, "collection"),
    "invalid_input",
  );

  const notes = frozenRecord({
    owner: notesOwner,
    note: bindMethod(readPropertyGuarded(notesOwner, RUNTIME_SLOTS.notes[0]), notesOwner),
    add: bindMethod(readPropertyGuarded(notesOwner, RUNTIME_SLOTS.notes[1]), notesOwner),
    addToNotebook: bindMethod(readPropertyGuarded(notesOwner, RUNTIME_SLOTS.notes[2]), notesOwner),
    removeFromNotebook: bindMethod(
      readPropertyGuarded(notesOwner, RUNTIME_SLOTS.notes[3]),
      notesOwner,
    ),
    collection: frozenRecord({
      owner: collectionOwner,
      update: bindMethod(readPropertyGuarded(collectionOwner, "update"), collectionOwner),
    }),
  }) as RuntimeSnapshot["notes"];

  const content = frozenRecord({
    owner: contentOwner,
    add: bindMethod(readPropertyGuarded(contentOwner, RUNTIME_SLOTS.content[0]), contentOwner),
    findByNoteId: bindMethod(
      readPropertyGuarded(contentOwner, RUNTIME_SLOTS.content[1]),
      contentOwner,
    ),
    updateByNoteId: bindMethod(
      readPropertyGuarded(contentOwner, RUNTIME_SLOTS.content[2]),
      contentOwner,
    ),
  }) as RuntimeSnapshot["content"];

  const notebooks = frozenRecord({
    owner: notebooksOwner,
    exists: bindMethod(
      readPropertyGuarded(notebooksOwner, RUNTIME_SLOTS.notebooks[0]),
      notebooksOwner,
    ),
    notes: bindMethod(
      readPropertyGuarded(notebooksOwner, RUNTIME_SLOTS.notebooks[1]),
      notebooksOwner,
    ),
  }) as RuntimeSnapshot["notebooks"];

  const tags = frozenRecord({
    owner: tagsOwner,
    tag: bindMethod(readPropertyGuarded(tagsOwner, RUNTIME_SLOTS.tags[0]), tagsOwner),
    add: bindMethod(readPropertyGuarded(tagsOwner, RUNTIME_SLOTS.tags[1]), tagsOwner),
  }) as RuntimeSnapshot["tags"];

  const relations = frozenRecord({
    owner: relationsOwner,
    add: bindMethod(
      readPropertyGuarded(relationsOwner, RUNTIME_SLOTS.relations[0]),
      relationsOwner,
    ),
    unlink: bindMethod(
      readPropertyGuarded(relationsOwner, RUNTIME_SLOTS.relations[1]),
      relationsOwner,
    ),
    from: bindMethod(
      readPropertyGuarded(relationsOwner, RUNTIME_SLOTS.relations[2]),
      relationsOwner,
    ),
  }) as RuntimeSnapshot["relations"];

  return frozenRecord({ notes, content, notebooks, tags, relations }) as RuntimeSnapshot;
}

function requireObject(value: unknown, failureCode: NotesnookWriteErrorCode): object {
  let array = false;
  try {
    array = Array.isArray(value);
  } catch {
    throw wiringError(failureCode);
  }
  if (value === null || typeof value !== "object" || array) throw wiringError(failureCode);
  return value;
}

function readHas(value: object, key: string): boolean {
  try {
    return Reflect.has(value, key);
  } catch {
    throw wiringError("invalid_input");
  }
}

function readPropertyGuarded(
  value: unknown,
  key: string,
  failureCode: NotesnookWriteErrorCode = "invalid_input",
): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return Reflect.get(value, key, value);
  } catch {
    throw wiringError(failureCode);
  }
}

function bindMethod(
  method: unknown,
  owner: object,
  failureCode: NotesnookWriteErrorCode = "invalid_input",
): (...args: never[]) => unknown {
  if (typeof method !== "function") throw wiringError(failureCode);
  try {
    const bound = Reflect.apply(Function.prototype.bind, method, [owner]);
    if (typeof bound !== "function") throw new TypeError("bind did not return a function");
    return bound as (...args: never[]) => unknown;
  } catch {
    throw wiringError(failureCode);
  }
}

function frozenRecord(values: Record<string, unknown>): object {
  const record = Object.create(null) as Record<string, unknown>;
  const keys = Object.keys(values);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    Object.defineProperty(record, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: values[key],
    });
  }
  return Object.freeze(record);
}

function defineSeamMethod(
  seam: NotesnookWriteDatabase,
  key: keyof NotesnookWriteDatabase,
  method: (...args: never[]) => unknown,
): void {
  Object.defineProperty(seam, key, {
    configurable: false,
    enumerable: true,
    writable: false,
    value: method,
  });
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw wiringError("invalid_input");
  return value;
}

function requireIdentifier(
  value: unknown,
  failureCode: NotesnookWriteErrorCode = "invalid_input",
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > STAGE4_WRITE_LIMITS.maxIdLength ||
    value.trim().length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw wiringError(failureCode);
  }
  return value;
}

function mapSeamContentType(value: unknown): "tiptap" {
  if (value === "tiptap" || value === "html") return "tiptap";
  throw wiringError("invalid_input");
}

interface CapturedFields {
  readonly keys: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}

interface OwnProperty {
  readonly present: boolean;
  readonly value: unknown;
}

/**
 * Read only an own record field. Returned records cross a trust boundary, so
 * inherited values are never accepted as record data. Own accessors remain
 * legitimate, but descriptor lookup and accessor invocation are guarded so
 * hostile or revoked proxies stay categorical.
 */
function readOwnProperty(
  value: object,
  key: string,
  failureCode: NotesnookWriteErrorCode,
): OwnProperty {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  } catch {
    throw wiringError(failureCode);
  }
  if (!descriptor) return { present: false, value: undefined };
  try {
    if ("value" in descriptor) return { present: true, value: descriptor.value };
    if (typeof descriptor.get === "function") {
      return { present: true, value: Reflect.apply(descriptor.get, value, []) };
    }
    return { present: true, value: undefined };
  } catch {
    throw wiringError(failureCode);
  }
}

function requireOwnProperty(
  value: object,
  key: string,
  failureCode: NotesnookWriteErrorCode,
): unknown {
  const property = readOwnProperty(value, key, failureCode);
  if (!property.present) throw wiringError(failureCode);
  return property.value;
}

function captureOwnFields(value: unknown): CapturedFields {
  const record = requireObject(value, "invalid_input");
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(record);
  } catch {
    throw wiringError("invalid_input");
  }
  if (prototype !== null && prototype !== Object.prototype) throw wiringError("invalid_input");
  if (prototype !== null) {
    let prototypeKeys: PropertyKey[];
    try {
      prototypeKeys = Reflect.ownKeys(prototype);
    } catch {
      throw wiringError("invalid_input");
    }
    for (let index = 0; index < prototypeKeys.length; index += 1) {
      const key = prototypeKeys[index]!;
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);
      } catch {
        throw wiringError("invalid_input");
      }
      if (descriptor?.enumerable === true) throw wiringError("invalid_input");
    }
  }

  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(record);
  } catch {
    throw wiringError("invalid_input");
  }
  if (keys.length > 32) throw wiringError("invalid_input");
  const stringKeys: string[] = [];
  const values = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (typeof key !== "string") throw wiringError("invalid_input");
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(record, key);
    } catch {
      throw wiringError("invalid_input");
    }
    if (!descriptor) throw wiringError("invalid_input");
    let field: unknown;
    try {
      field =
        "value" in descriptor
          ? descriptor.value
          : typeof descriptor.get === "function"
            ? Reflect.apply(descriptor.get, record, [])
            : undefined;
    } catch {
      throw wiringError("invalid_input");
    }
    stringKeys.push(key);
    Object.defineProperty(values, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: field,
    });
  }
  return Object.freeze({
    keys: Object.freeze(stringKeys),
    values: Object.freeze(values),
  });
}

function requireAllowedObject(value: unknown, allowed: readonly string[]): CapturedFields {
  const captured = captureOwnFields(value);
  if (captured.keys.length === 0) throw wiringError("invalid_input");
  for (let index = 0; index < captured.keys.length; index += 1) {
    if (allowed.indexOf(captured.keys[index]!) === -1) throw wiringError("invalid_input");
  }
  return captured;
}

function mapNotesPartial(value: unknown): Record<string, unknown> {
  const captured = requireAllowedObject(value, [
    "title",
    "pinned",
    "favorite",
    "notebookId",
    "tags",
  ]);
  const keys = captured.keys;
  const result = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const field = captured.values[key];
    switch (key) {
      case "title":
        result.title = requireString(field);
        break;
      case "pinned":
      case "favorite":
        if (typeof field !== "boolean") throw wiringError("invalid_input");
        result[key] = field;
        break;
      case "notebookId":
        result.notebookId = requireIdentifier(field);
        break;
      case "tags":
        result.tags = readStringArray(field, "invalid_input", false, 16);
        break;
    }
  }
  return result;
}

function mapContentPartial(value: unknown): Record<string, unknown> {
  const captured = requireAllowedObject(value, ["noteId", "type", "data"]);
  const keys = captured.keys;
  const result = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const field = captured.values[key];
    switch (key) {
      case "noteId":
        result.noteId = requireIdentifier(field);
        break;
      case "type":
        result.type = mapSeamContentType(field);
        break;
      case "data":
        result.data = requireString(field);
        break;
    }
  }
  return result;
}

function mapRelationInput(value: unknown): {
  readonly fromId: string;
  readonly toId: string;
  readonly type: string;
} {
  const captured = requireAllowedObject(value, ["fromId", "toId", "type"]);
  const fromId = requireIdentifier(captured.values.fromId);
  const toId = requireIdentifier(captured.values.toId);
  const type = requireIdentifier(captured.values.type);
  return { fromId, toId, type };
}

function mapNote(
  value: unknown,
  requestedId: string,
  contentLocked: boolean | undefined,
): NotesnookWriteNoteMetadata {
  const record = requireObject(value, "invalid_input");
  const id = requireIdentifier(requireOwnProperty(record, "id", "invalid_input"));
  const title = requireString(requireOwnProperty(record, "title", "invalid_input"));
  const pinned = requireOwnProperty(record, "pinned", "invalid_input");
  const favorite = requireOwnProperty(record, "favorite", "invalid_input");
  const conflicted = requireOwnProperty(record, "conflicted", "invalid_input");
  const locked = resolveLockedState(record, contentLocked);
  const dateEdited = requireOwnProperty(record, "dateEdited", "invalid_input");
  if (
    typeof pinned !== "boolean" ||
    typeof favorite !== "boolean" ||
    typeof conflicted !== "boolean" ||
    typeof locked !== "boolean" ||
    typeof dateEdited !== "number" ||
    !Number.isFinite(dateEdited)
  ) {
    throw wiringError("invalid_input");
  }
  if (id !== requestedId) throw wiringError("invalid_input");
  const contentId = readOwnProperty(record, "contentId", "invalid_input");
  const notebookId = readOwnProperty(record, "notebookId", "invalid_input");
  const tags = readOwnProperty(record, "tags", "invalid_input");
  const result: {
    id: string;
    title: string;
    pinned: boolean;
    favorite: boolean;
    conflicted: boolean;
    locked: boolean;
    dateEdited: number;
    contentId?: string;
    notebookId?: string;
    tags?: readonly string[];
  } = { id, title, pinned, favorite, conflicted, locked, dateEdited };
  if (contentId.present && contentId.value !== undefined) {
    result.contentId = requireIdentifier(contentId.value);
  }
  if (notebookId.present && notebookId.value !== undefined) {
    result.notebookId = requireIdentifier(notebookId.value);
  }
  if (tags.present && tags.value !== undefined) {
    result.tags = readStringArray(tags.value, "invalid_input", false, 16);
  }
  return Object.freeze(result);
}

/**
 * Resolve the authoritative locked marker for a note (Astra finding
 * P1-2).  When the upstream `note.locked` field is supplied, that
 * value is the source of truth — even if it disagrees with the
 * content marker, the adapter honors what upstream actually returned.
 *
 * When `note.locked` is absent the projection consults the content
 * record's `locked` marker (`content.locked` is the canonical Vault
 * flag in Notesnook).  The seam derives this hint through a single
 * `content.findByNoteId(id)` call performed alongside `notes.note(id)`
 * so the adapter's gate receives the merged projection without a
 * follow-up fetch.
 *
 * When neither the note record nor the content record carries the
 * marker, the projection fails closed: `locked` is `false`, the
 * authoritative check remains a non-issue, and the gate does not
 * falsely raise `vault_locked`.
 */
function resolveLockedState(record: object, contentLocked: boolean | undefined): boolean {
  const noteProperty = readOwnProperty(record, "locked", "invalid_input");
  if (noteProperty.present && noteProperty.value !== undefined) {
    if (typeof noteProperty.value !== "boolean") throw wiringError("invalid_input");
    return noteProperty.value;
  }
  return contentLocked === true;
}

function mapContent(value: unknown, requestedNoteId: string): NotesnookWriteStoredContent {
  const record = requireObject(value, "invalid_input");
  const id = requireIdentifier(requireOwnProperty(record, "id", "invalid_input"));
  const noteId = requireIdentifier(requireOwnProperty(record, "noteId", "invalid_input"));
  const type = requireOwnProperty(record, "type", "invalid_input");
  const data = requireString(requireOwnProperty(record, "data", "invalid_input"));
  if (noteId !== requestedNoteId) throw wiringError("invalid_input");
  const locked = readOptionalLockedMarker(record);
  if (type === "tiptap") {
    return locked === undefined
      ? Object.freeze({ id, noteId, type: "tiptap", data })
      : Object.freeze({ id, noteId, type: "tiptap", data, locked });
  }
  if (type === "tiny") {
    return locked === undefined
      ? Object.freeze({ id, noteId, type: "html", data })
      : Object.freeze({ id, noteId, type: "html", data, locked });
  }
  throw wiringError("invalid_input");
}

/**
 * Read the optional `locked` marker off a runtime record.  Returns
 * `undefined` when the field is absent, `true` / `false` when present
 * and a boolean, and throws a categorically-safe `invalid_input` when
 * the field is present but the wrong shape.
 */
function readOptionalLockedMarker(record: object): boolean | undefined {
  const property = readOwnProperty(record, "locked", "invalid_input");
  if (!property.present) return undefined;
  const value = property.value;
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw wiringError("invalid_input");
  return value;
}

function mapTag(
  value: unknown,
  requestedId: string,
): { readonly id: string; readonly title: string } {
  const record = requireObject(value, "sync_failed");
  const id = requireIdentifier(requireOwnProperty(record, "id", "sync_failed"), "sync_failed");
  const titleValue = requireOwnProperty(record, "title", "sync_failed");
  if (typeof titleValue !== "string" || titleValue.length === 0) {
    throw wiringError("sync_failed");
  }
  const title = titleValue;
  if (id !== requestedId) throw wiringError("sync_failed");
  return { id, title };
}

function readStringArray(
  value: unknown,
  failureCode: NotesnookWriteErrorCode,
  requireNonEmpty: boolean,
  maxItems = MAX_RUNTIME_ARRAY_ITEMS,
): readonly string[] {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw wiringError(failureCode);
  }
  if (!isArray) throw wiringError(failureCode);
  const lengthValue = readPropertyGuarded(value, "length", failureCode);
  if (
    typeof lengthValue !== "number" ||
    !Number.isSafeInteger(lengthValue) ||
    lengthValue < 0 ||
    lengthValue > maxItems
  ) {
    throw wiringError(failureCode);
  }
  if (requireNonEmpty && lengthValue === 0) throw wiringError(failureCode);
  const result: string[] = [];
  for (let index = 0; index < lengthValue; index += 1) {
    const entry = readArrayEntry(value, index, failureCode);
    result.push(requireIdentifier(entry, failureCode));
  }
  return Object.freeze(result);
}

function readArrayEntry(
  value: unknown,
  index: number,
  failureCode: NotesnookWriteErrorCode,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(value as object, String(index));
  } catch {
    throw wiringError(failureCode);
  }
  if (!descriptor) throw wiringError(failureCode);
  try {
    if ("value" in descriptor) return descriptor.value;
    if (typeof descriptor.get === "function") return Reflect.apply(descriptor.get, value, []);
    return undefined;
  } catch {
    throw wiringError(failureCode);
  }
}

function mapRelations(
  value: unknown,
  requestedNoteId: string,
): ReadonlyArray<{ readonly toId: string; readonly type: string }> {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw wiringError("sync_failed");
  }
  if (!isArray) throw wiringError("sync_failed");
  const lengthValue = readPropertyGuarded(value, "length", "sync_failed");
  if (
    typeof lengthValue !== "number" ||
    !Number.isSafeInteger(lengthValue) ||
    lengthValue < 0 ||
    lengthValue > MAX_RUNTIME_ARRAY_ITEMS
  ) {
    throw wiringError("sync_failed");
  }
  const result: Array<{ readonly toId: string; readonly type: string }> = [];
  for (let index = 0; index < lengthValue; index += 1) {
    const row = requireObject(readArrayEntry(value, index, "sync_failed"), "sync_failed");
    const fromId = requireIdentifier(
      requireOwnProperty(row, "fromId", "sync_failed"),
      "sync_failed",
    );
    const toId = requireIdentifier(requireOwnProperty(row, "toId", "sync_failed"), "sync_failed");
    const fromType = requireIdentifier(
      requireOwnProperty(row, "fromType", "sync_failed"),
      "sync_failed",
    );
    const toType = requireIdentifier(
      requireOwnProperty(row, "toType", "sync_failed"),
      "sync_failed",
    );
    if (fromId !== requestedNoteId || fromType !== "note") throw wiringError("sync_failed");
    result.push(Object.freeze({ toId, type: toType }));
  }
  return Object.freeze(result);
}

async function safeCall<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw sanitizeError(error, "sync_failed");
  }
}

function safeSyncCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw sanitizeError(error, "sync_failed");
  }
}

function sanitizeError(
  error: unknown,
  fallback: NotesnookWriteErrorCode,
): NotesnookWriteContractError {
  let code = fallback;
  if (isNotesnookWriteContractError(error)) {
    let candidate: unknown;
    try {
      candidate = Reflect.get(error, "code", error);
    } catch {
      candidate = undefined;
    }
    if (
      candidate === "invalid_input" ||
      candidate === "unsupported_content" ||
      candidate === "unsupported_patch_field" ||
      candidate === "stale_revision" ||
      candidate === "conflict" ||
      candidate === "vault_locked" ||
      candidate === "sync_failed"
    ) {
      code = candidate;
    }
  }
  return hardenedError(code);
}

function hardenedError(code: NotesnookWriteErrorCode): NotesnookWriteContractError {
  const error = new NotesnookWriteContractError(code);
  Object.defineProperties(error, {
    cause: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: undefined,
    },
    __context__: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: undefined,
    },
  });
  return Object.freeze(error);
}

function wiringError(code: NotesnookWriteErrorCode): never {
  throw hardenedError(code);
}
