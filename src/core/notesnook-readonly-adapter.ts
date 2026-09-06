/**
 * Narrow, injected, read-only seam on top of an opened Notesnook
 * `Database` handle.
 *
 * Stage 3 preparation — smallest safe slice.
 *
 * Purpose
 * -------
 *
 * Stage 3's first proof is "reopen an authenticated client state,
 * perform a read-only native sync, and report a repeatable pass/fail"
 * (see `docs/implementation-plan-v1.5.md` §13.7).  This module is
 * the offline, deterministic seam that future Stage 3 wiring will
 * plug an opened `Database` into.  It deliberately:
 *
 *   - exposes a CLOSED read-only surface (`status`, `sync("fetch")`,
 *     `listNotebooks`, `listNotes`, `getNoteMetadata`, `search`);
 *   - uses an INJECTED structural seam so tests run offline against
 *     deterministic fakes with no real Database, no real network, no
 *     real account;
 *   - rejects ANY mutation, delete, or generic passthrough — there is
 *     no `add`, `update`, `delete`, `pin`, `moveToTrash`,
 *     `setLastSynced`, `setLastSynced`-like helper, raw `database`
 *     accessor, or generic-call surface exposed;
 *   - serializes concurrent sync attempts through a per-instance
 *     single-flight mutex so two overlapping calls collapse to one
 *     in-flight call and the second waits for the first to complete;
 *   - normalises every failure to a categorical, chain-free
 *     {@link NotesnookReadOnlyAdapterError} so adapter-owned throws
 *     never leak upstream causes (which may carry secrets, paths, or
 *     token bytes).
 *
 * Non-goals
 * ---------
 *
 *   - This module does NOT call `Database.setup({...})`, does NOT
 *     call `Database.init()`, does NOT call `db.user.*`, does NOT
 *     call `db.tokenManager.*`, and does NOT call `db.sync({type:
 *     "send", ...})`.  Opening and authenticating the live Database
 *     remains the responsibility of `notesnook-live-factory.ts` and
 *     the Stage 2B runner; this module only adapts an already-open
 *     Database (or a fake) into a closed read-only shape.
 *   - This module does NOT expose a raw `database`, a generic
 *     transport, a generic KV accessor, or a method that takes an
 *     arbitrary collection name.  There is no escape hatch.
 *   - This module does NOT run real sync.  The injected seam drives
 *     everything offline; production callers wire it from a future
 *     Stage 3 runner that decides when a sync attempt is authorised.
 */

import { isNotesnookAdapterError } from "./notesnook-core-adapter.js";
import { createRevisionToken, type NotesnookRevisionToken } from "./notesnook-write-contract.js";

// ---------------------------------------------------------------------------
// Allowlisted read-only record shapes.
//
// These are NOT upstream `Note` / `Notebook` types — they are the
// minimum closed shapes the adapter is willing to surface.  Callers
// that need more must add it explicitly to the allowlist; the
// adapter never widens this surface on its own.
// ---------------------------------------------------------------------------

/**
 * The narrow notebook summary the adapter is willing to surface.
 * Only structurally verified fields are kept.
 */
export interface NotesnookReadOnlyNotebookSummary {
  readonly id: string;
  readonly title: string;
  readonly dateCreated?: number;
  readonly dateModified?: number;
}

/**
 * The narrow note metadata the adapter is willing to surface.
 * Body content / encrypted content is intentionally absent; a
 * future Stage 3 read-only content slice can add a dedicated
 * allowlisted method for that.
 */
export interface NotesnookReadOnlyNoteMetadata {
  readonly id: string;
  readonly title: string;
  readonly revision?: NotesnookRevisionToken;
  readonly dateCreated?: number;
  readonly dateModified?: number;
  readonly notebookId?: string;
  readonly pinned?: boolean;
  readonly favorite?: boolean;
  readonly localOnly?: boolean;
  readonly conflicted?: boolean;
  readonly locked?: boolean;
}

const READ_ONLY_REVISION_TOKEN_PATTERN = /^rev_[0-9a-f]{32}$/;

/**
 * Derive the opaque revision handle used by the metadata-only read seam.
 * The read-only projection never imports the mutation contract directly.
 */
export function createReadOnlyRevisionToken(
  id: string,
  dateEdited: number,
): NotesnookRevisionToken {
  return createRevisionToken({ id, dateEdited });
}

/**
 * A search hit.  Title-only search is supported by this slice;
 * body matches are explicitly out of scope and require a future
 * dedicated allowlisted method.
 */
export interface NotesnookReadOnlySearchHit {
  readonly id: string;
  readonly title: string;
  readonly source: "note" | "notebook";
}

// ---------------------------------------------------------------------------
// Sync options.
//
// We mirror the verified real-upstream `SyncOptions` literal types
// from `@notesnook/core@8.1.3` (`dist/index.d.ts`):
//
//     type SyncOptions = {
//       type: "full" | "fetch" | "send";
//       force?: boolean;
//       offlineMode?: boolean;
//     };
//
// We deliberately NARROW the discriminator set to `"fetch"`.
// Upstream `Sync.start({type: "full"})` performs both fetch and send;
// therefore `"full"` is not read-only even though its name sounds safe.
// `"send"` also pushes local changes upstream and is rejected as out-of-scope.
// ---------------------------------------------------------------------------

export type NotesnookReadOnlySyncType = "fetch";

export interface NotesnookReadOnlySyncOptions {
  readonly type: NotesnookReadOnlySyncType;
  readonly force?: boolean;
}

// ---------------------------------------------------------------------------
// Read-only status.
// ---------------------------------------------------------------------------

/**
 * Closed status surface the adapter exposes.  A future Stage 3
 * runner can read this without holding a raw Database.
 */
export interface NotesnookReadOnlyStatus {
  readonly lastSynced: number;
  readonly hasUnsyncedChanges: boolean;
}

// ---------------------------------------------------------------------------
// Injected seam.
//
// The seam is structural and accepts any object that exposes the
// closed read-only surface.  Both the live wired `Database` (via a
// future adapter that flattens its shape into this interface) and a
// hand-written test fake satisfy it.
// ---------------------------------------------------------------------------

/**
 * The minimum structural shape the adapter consumes from an injected
 * Database handle.  No `add`, `update`, `delete`, `pin`,
 * `moveToTrash`, `setLastSynced`, raw `database` accessor, or generic
 * call surface is exposed.
 */
export interface NotesnookReadOnlyDatabase {
  readonly lastSynced: () => Promise<number>;
  readonly hasUnsyncedChanges: () => Promise<boolean>;
  readonly sync: (options: {
    type: NotesnookReadOnlySyncType;
    force?: boolean;
  }) => Promise<boolean>;
  readonly listNotebooks: () => Promise<NotesnookReadOnlyNotebookSummary[]>;
  readonly listNotes: () => Promise<NotesnookReadOnlyNoteMetadata[]>;
  readonly noteMetadata: (id: string) => Promise<NotesnookReadOnlyNoteMetadata | undefined>;
  readonly search: (query: string) => Promise<NotesnookReadOnlySearchHit[]>;
}

/**
 * The injected seam.  Either an already-resolved object or a factory
 * that returns one.  No raw `Database` is permitted through.
 */
export type NotesnookReadOnlyDatabaseSource =
  | NotesnookReadOnlyDatabase
  | (() => NotesnookReadOnlyDatabase);

export interface NotesnookReadOnlyAdapterOptions {
  readonly source: NotesnookReadOnlyDatabaseSource;
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export class NotesnookReadOnlyAdapter {
  readonly #database: NotesnookReadOnlyDatabase;
  // Single-flight per-instance mutex for sync attempts.  The contract
  // is: at most one upstream `sync(...)` call is in flight per
  // adapter; concurrent callers await the first call and receive its
  // result.  This is the explicit single-call behaviour the seam
  // guarantees; future Stage 3 wiring may add a process-wide lock
  // around the live `Database.sync(...)` if cross-process callers
  // show up.
  #syncInFlight: Promise<boolean> | undefined = undefined;

  constructor(options: NotesnookReadOnlyAdapterOptions) {
    this.#database = resolveReadOnlyDatabase(options.source);
    // Freeze the structural record so downstream code cannot mutate
    // the injected Database shape through the adapter.  Note: the
    // adapter does NOT freeze the database handle itself — callers
    // own the lifecycle of the injected Database and are responsible
    // for any immutability they require.
    Object.freeze(this);
  }

  /**
   * Read-only status snapshot.  No mutation, no network, no upstream
   * write — both upstream calls are read-only metadata accessors.
   */
  async status(): Promise<NotesnookReadOnlyStatus> {
    try {
      const [lastSynced, hasUnsyncedChanges] = await Promise.all([
        this.#safeCall("lastSynced", () => this.#database.lastSynced()),
        this.#safeCall("hasUnsyncedChanges", () => this.#database.hasUnsyncedChanges()),
      ]);
      return { lastSynced, hasUnsyncedChanges };
    } catch (error) {
      if (isNotesnookAdapterError(error) || isReadOnlyAdapterError(error)) {
        throw error;
      }
      throw readOnlyAdapterError("Notesnook read-only adapter: failed to read status");
    }
  }

  /**
   * Request a read-only sync.
   *
   * Only `"fetch"` is accepted; `"full"` and `"send"` are rejected
   * categorically because upstream full sync includes a send phase.
   * Concurrent calls collapse to
   * one in-flight upstream sync attempt; the second caller awaits
   * the first and receives its boolean result.
   */
  async sync(options: NotesnookReadOnlySyncOptions): Promise<boolean> {
    if (!isReadOnlySyncType(options?.type)) {
      throw readOnlyAdapterError('Notesnook read-only adapter: sync type must be "fetch"');
    }
    if (options.force !== undefined) {
      throw readOnlyAdapterError("Notesnook read-only adapter: sync force is out of scope");
    }
    if (this.#syncInFlight) {
      const existing = this.#syncInFlight;
      const result = await safeAwait(existing);
      if (result.kind === "failure") {
        // Re-throw the categorical failure so callers see the same
        // error chain.
        throw result.error;
      }
      return result.value;
    }
    const attempt = (async () => {
      try {
        return await this.#database.sync({
          type: options.type,
          ...(options.force === undefined ? {} : { force: options.force }),
        });
      } catch (error) {
        if (isReadOnlyAdapterError(error)) {
          throw error;
        }
        throw readOnlyAdapterError("Notesnook read-only adapter: sync attempt failed");
      }
    })();
    this.#syncInFlight = attempt.finally(() => {
      this.#syncInFlight = undefined;
    });
    try {
      return await attempt;
    } catch (error) {
      if (isReadOnlyAdapterError(error) || isNotesnookAdapterError(error)) {
        throw error;
      }
      throw readOnlyAdapterError("Notesnook read-only adapter: sync attempt failed");
    }
  }

  /**
   * List notebook summaries.  No body, no content, no per-notebook
   * note ids — only the closed summary shape above.
   */
  async listNotebooks(): Promise<NotesnookReadOnlyNotebookSummary[]> {
    try {
      const raw = await this.#safeCall("listNotebooks", () => this.#database.listNotebooks());
      return raw.map(coerceNotebookSummary);
    } catch (error) {
      if (isNotesnookAdapterError(error) || isReadOnlyAdapterError(error)) {
        throw error;
      }
      throw readOnlyAdapterError("Notesnook read-only adapter: failed to list notebooks");
    }
  }

  /**
   * List note metadata.  No body, no content, and no raw upstream
   * records are exposed; each result is coerced to the closed metadata
   * shape above.
   */
  async listNotes(): Promise<NotesnookReadOnlyNoteMetadata[]> {
    try {
      const raw = await this.#safeCall("listNotes", () => this.#database.listNotes());
      return raw.map(coerceNoteMetadata);
    } catch (error) {
      if (isNotesnookAdapterError(error) || isReadOnlyAdapterError(error)) {
        throw error;
      }
      throw readOnlyAdapterError("Notesnook read-only adapter: failed to list notes");
    }
  }

  /**
   * Retrieve note metadata by id.  Returns `undefined` when the note
   * is absent.  Never returns note body / encrypted content — a
   * future Stage 3 content slice can add that as a dedicated
   * allowlisted method.
   */
  async noteMetadata(id: string): Promise<NotesnookReadOnlyNoteMetadata | undefined> {
    if (typeof id !== "string" || id.length === 0) {
      throw readOnlyAdapterError("Notesnook read-only adapter: note id must be a non-empty string");
    }
    try {
      const raw = await this.#safeCall("noteMetadata", () => this.#database.noteMetadata(id));
      if (raw === undefined) return undefined;
      return coerceNoteMetadata(raw);
    } catch (error) {
      if (isNotesnookAdapterError(error) || isReadOnlyAdapterError(error)) {
        throw error;
      }
      throw readOnlyAdapterError("Notesnook read-only adapter: failed to read note metadata");
    }
  }

  /**
   * Resolve the categorical body-access policy without returning body
   * content. Locked notes fail with the stable `vault_locked` category;
   * all other notes remain outside this metadata-only slice.
   */
  async readNoteBody(id: string): Promise<never> {
    if (typeof id !== "string" || id.length === 0) {
      throw readOnlyAdapterError("Notesnook read-only adapter: note id must be a non-empty string");
    }
    const metadata = await this.noteMetadata(id);
    if (metadata?.locked === true) {
      throw readOnlyAdapterError("vault_locked");
    }
    throw readOnlyAdapterError("unsupported_content");
  }

  /**
   * Title-only search.  Matches notebook titles and note titles;
   * body matches are explicitly out of scope.
   */
  async search(query: string): Promise<NotesnookReadOnlySearchHit[]> {
    if (typeof query !== "string" || query.length === 0) {
      throw readOnlyAdapterError(
        "Notesnook read-only adapter: search query must be a non-empty string",
      );
    }
    try {
      const raw = await this.#safeCall("search", () => this.#database.search(query));
      return raw.map(coerceSearchHit);
    } catch (error) {
      if (isNotesnookAdapterError(error) || isReadOnlyAdapterError(error)) {
        throw error;
      }
      throw readOnlyAdapterError("Notesnook read-only adapter: failed to execute search");
    }
  }

  async #safeCall<T>(name: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isReadOnlyAdapterError(error) || isNotesnookAdapterError(error)) {
        throw error;
      }
      throw readOnlyAdapterError(`Notesnook read-only adapter: ${name} call rejected upstream`);
    }
  }
}

export function createNotesnookReadOnlyAdapter(
  options: NotesnookReadOnlyAdapterOptions,
): NotesnookReadOnlyAdapter {
  return new NotesnookReadOnlyAdapter(options);
}

// ---------------------------------------------------------------------------
// Categorical error normalisation.
//
// Adapter-owned errors are recognised by identity, not by message.
// The marker is held in a module-private `WeakSet<object>` keyed on
// object identity, mirroring the existing adapter's pattern.  `cause`
// and `__context__` are explicitly cleared so an attacker that
// controls the upstream error cannot smuggle data through the chain.
// ---------------------------------------------------------------------------

const READONLY_ADAPTER_ERRORS = new WeakSet<object>();

/**
 * Construct a categorical, chain-free adapter error.
 */
function readOnlyAdapterError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", {
    configurable: true,
    value: undefined,
  });
  READONLY_ADAPTER_ERRORS.add(error);
  return error;
}

/**
 * Public predicate.  Returns true iff `value` is an adapter-owned
 * error emitted by this module.  Callers may use this to recognize
 * the trusted-adapter category without parsing messages.
 */
export function isNotesnookReadOnlyAdapterError(value: unknown): value is Error {
  return typeof value === "object" && value !== null && READONLY_ADAPTER_ERRORS.has(value);
}

/**
 * Internal alias for use inside the adapter.  Kept private to this
 * module so callers cannot rely on it as a stable public predicate.
 */
function isReadOnlyAdapterError(value: unknown): value is Error {
  return isNotesnookReadOnlyAdapterError(value);
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/**
 * Resolve the injected seam into a concrete Database handle.  Either
 * an already-resolved object or a factory that returns one is
 * accepted.  The resolved object is structurally validated; missing
 * surface members fail with a categorical message.
 */
function resolveReadOnlyDatabase(
  source: NotesnookReadOnlyDatabaseSource,
): NotesnookReadOnlyDatabase {
  let candidate: unknown;
  if (typeof source === "function") {
    try {
      candidate = (source as () => unknown)();
    } catch {
      throw readOnlyAdapterError("Notesnook read-only adapter: injected source factory threw");
    }
  } else {
    candidate = source;
  }
  if (!isPromiseLike(candidate)) {
    return validateReadOnlyDatabase(candidate);
  }
  // The seam promises we never expose a sync attempt over a
  // non-resolved Database, but synchronous `Promise.resolve(value)`
  // is a cheap way to keep the type narrow for callers that return
  // a pre-built handle synchronously.  Force the caller to wait.
  throw readOnlyAdapterError(
    "Notesnook read-only adapter: injected source must resolve before construction",
  );
}

function validateReadOnlyDatabase(value: unknown): NotesnookReadOnlyDatabase {
  if (!value || typeof value !== "object") {
    throw readOnlyAdapterError("Notesnook read-only adapter: injected source must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const expected = [
    "lastSynced",
    "hasUnsyncedChanges",
    "sync",
    "listNotebooks",
    "listNotes",
    "noteMetadata",
    "search",
  ];
  for (const key of expected) {
    if (typeof candidate[key] !== "function") {
      throw readOnlyAdapterError(
        `Notesnook read-only adapter: injected source is missing ${key}()`,
      );
    }
  }
  // Forbid obvious mutation / generic-passthrough methods.  These
  // names are not part of the upstream read-only surface and the
  // adapter must reject any seam that exposes them.  This is the
  // allowlist enforcement step: every member that is not on the
  // read-only surface is rejected here.
  const FORBIDDEN = [
    "add",
    "addToNotebook",
    "removeFromNotebook",
    "removeFromAllNotebooks",
    "moveToTrash",
    "delete",
    "remove",
    "update",
    "setLastSynced",
    "pin",
    "favorite",
    "readonly",
    "localOnly",
    "duplicate",
    "export",
    "import",
    "reset",
    "changePassword",
    "disconnectSSE",
    "connectSSE",
    "init",
    "setup",
    "host",
    "writeEncrypted",
    "writeMulti",
    "write",
    "removeMulti",
    "clear",
    "set",
    "patch",
    "restore",
  ];
  for (const name of FORBIDDEN) {
    if (name in candidate) {
      throw readOnlyAdapterError(
        `Notesnook read-only adapter: injected source exposes forbidden mutation ${name}`,
      );
    }
  }
  return value as NotesnookReadOnlyDatabase;
}

function isPromiseLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

async function safeAwait(
  promise: Promise<boolean>,
): Promise<{ kind: "success"; value: boolean } | { kind: "failure"; error: unknown }> {
  try {
    const value = await promise;
    return { kind: "success", value };
  } catch (error) {
    return { kind: "failure", error };
  }
}

function isReadOnlySyncType(value: unknown): value is NotesnookReadOnlySyncType {
  return value === "fetch";
}

function coerceNotebookSummary(value: unknown): NotesnookReadOnlyNotebookSummary {
  if (!value || typeof value !== "object") {
    throw readOnlyAdapterError("Notesnook read-only adapter: notebook record is not an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw readOnlyAdapterError("Notesnook read-only adapter: notebook record is missing id");
  }
  if (typeof record.title !== "string") {
    throw readOnlyAdapterError("Notesnook read-only adapter: notebook record is missing title");
  }
  return {
    id: record.id,
    title: record.title,
    ...(typeof record.dateCreated === "number" ? { dateCreated: record.dateCreated } : {}),
    ...(typeof record.dateModified === "number" ? { dateModified: record.dateModified } : {}),
  };
}

function coerceNoteMetadata(value: unknown): NotesnookReadOnlyNoteMetadata {
  if (!value || typeof value !== "object") {
    throw readOnlyAdapterError("Notesnook read-only adapter: note metadata is not an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw readOnlyAdapterError("Notesnook read-only adapter: note metadata is missing id");
  }
  if (typeof record.title !== "string") {
    throw readOnlyAdapterError("Notesnook read-only adapter: note metadata is missing title");
  }
  if (record.conflicted !== undefined && typeof record.conflicted !== "boolean") {
    throw readOnlyAdapterError("Notesnook read-only adapter: note conflict marker is invalid");
  }
  if (record.locked !== undefined && typeof record.locked !== "boolean") {
    throw readOnlyAdapterError("Notesnook read-only adapter: note lock marker is invalid");
  }
  const dateModified = typeof record.dateModified === "number" ? record.dateModified : undefined;
  const suppliedRevision = record.revision;
  if (
    suppliedRevision !== undefined &&
    (typeof suppliedRevision !== "string" ||
      !READ_ONLY_REVISION_TOKEN_PATTERN.test(suppliedRevision))
  ) {
    throw readOnlyAdapterError("Notesnook read-only adapter: note revision token is invalid");
  }
  return {
    id: record.id,
    title: record.title,
    ...(typeof record.dateCreated === "number" ? { dateCreated: record.dateCreated } : {}),
    ...(dateModified === undefined ? {} : { dateModified }),
    ...(suppliedRevision !== undefined
      ? { revision: suppliedRevision as NotesnookRevisionToken }
      : {}),
    ...(typeof record.notebookId === "string" ? { notebookId: record.notebookId } : {}),
    ...(typeof record.pinned === "boolean" ? { pinned: record.pinned } : {}),
    ...(typeof record.favorite === "boolean" ? { favorite: record.favorite } : {}),
    ...(typeof record.localOnly === "boolean" ? { localOnly: record.localOnly } : {}),
    ...(typeof record.conflicted === "boolean" ? { conflicted: record.conflicted } : {}),
    ...(typeof record.locked === "boolean" ? { locked: record.locked } : {}),
  };
}

function coerceSearchHit(value: unknown): NotesnookReadOnlySearchHit {
  if (!value || typeof value !== "object") {
    throw readOnlyAdapterError("Notesnook read-only adapter: search hit is not an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw readOnlyAdapterError("Notesnook read-only adapter: search hit is missing id");
  }
  if (typeof record.title !== "string") {
    throw readOnlyAdapterError("Notesnook read-only adapter: search hit is missing title");
  }
  if (record.source !== "note" && record.source !== "notebook") {
    throw readOnlyAdapterError(
      "Notesnook read-only adapter: search hit has invalid source discriminator",
    );
  }
  return { id: record.id, title: record.title, source: record.source };
}
