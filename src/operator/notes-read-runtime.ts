import { TextEncoder } from "node:util";

/**
 * NookBridge Stage 9 §13.11 — bounded read-only runtime adapter slice.
 *
 * This is the SECOND slice of §13.11, the read-only runtime adapter
 * for `nookctl notes browse | search | get`.  It is intentionally
 * isolated from the existing `notes-cli.ts` parser/contract surface
 * and is NOT yet wired into the operator CLI dispatcher.
 *
 * Purpose
 * -------
 *
 * The CLI grammar in `notes-cli.ts` returns one of three read-only
 * `NotesCategoricalResult` shapes — `page`, `note`, and `empty` —
 * from `browse`, `search`, and `get`.  This module is the
 * deterministic seam that produces those shapes from a bounded
 * Notesnook source, without exposing a raw `Database`, a raw
 * transport, a generic call surface, or a mutation path.
 *
 * Scope pinned in the task allowlist:
 *
 *   - the source is INJECTED; no real `Database`, no real network,
 *     no real Notesnook handle, no filesystem, no RPC, no MCP, no
 *     sync, no auth, no editor, no undo preimage;
 *   - the opaque handle codec is INJECTED via the adapter
 *     `handleCodec` option — the adapter NEVER constructs or
 *     decodes handles itself, and the codec is the SOLE producer
 *     and SOLE consumer of opaque handles;
 *   - raw source IDs are NEVER returned; only codec-produced
 *     opaque handles pass through, and only validated opaque
 *     handles may be decoded back into source identities;
 *   - decoded identity is bound to the requested note so a stale
 *     or hand-tampered handle cannot resolve to the wrong note;
 *   - codec-produced handles MUST satisfy the bounded opaque
 *     handle grammar (including the reserved `rev_` family
 *     rejection); a codec that emits a handle outside that
 *     grammar collapses to a fixed categorical error and the
 *     handle never crosses the formatter boundary;
 *   - cursor / limit bounds are preserved and page output is
 *     capped at {@link NOTES_READ_PAGE_LIMIT_MAX};
 *   - the adapter does NOT call a mutating, sync, transport, or
 *     generic capability; `notes.delete` is structurally absent
 *     and no `tree` vocabulary is admitted;
 *   - every bounded record returned to the formatter is frozen
 *     so downstream code cannot mutate the adapter's output
 *     through this slice;
 *   - malformed / oversized / hostile source records collapse
 *     to a fixed categorical `error` without leaking the
 *     underlying values, paths, titles, bodies, or upstream
 *     messages.
 *
 * Non-goals
 * ---------
 *
 *   - this module does NOT read `process.env`, `process.argv`, or
 *     `process.stdin`; the CLI parser / dispatcher owns those
 *     concerns and supplies the bounded inputs already;
 *   - this module does NOT load, open, or sync any real
 *     Notesnook `Database`; it adapts an injected source only;
 *   - this module does NOT carry edit / undo / delete / tree
 *     semantics; it is the read-only runtime adapter slice
 *     only;
 *   - this module does NOT ship a reversible built-in source-id
 *     encoding.  The adapter is fully codec-driven — there is no
 *     Buffer/base64/checksum codec inside this slice.
 */

import { Buffer } from "node:buffer";

// ---------------------------------------------------------------------------
// Public constants.
// ---------------------------------------------------------------------------

/**
 * Closed page-size cap.  The CLI contract already enforces
 * `1..100` at the parser boundary; the adapter clamps again here
 * so a future caller that bypasses the CLI cannot push more than
 * this many items through the page result shape.
 */
export const NOTES_READ_PAGE_LIMIT_MAX = 100;

/** Bounded UTF-8 byte length for title-search queries. */
export const MAX_NOTES_READ_QUERY_BYTES = 4 * 1024 * 1024;

/**
 * Closed per-input title-length cap.  Source titles longer than
 * this are categorically rejected without the value crossing the
 * formatter boundary.
 */
const SOURCE_TITLE_MAX_LENGTH = 100;

/**
 * Closed per-input source-id length cap.  Source ids longer than
 * this are categorically rejected; the upstream Notesnook note
 * identifier shape is fixed-length hex and the closed bound keeps
 * the adapter small, deterministic, and immune to hostile
 * upstream leakage.
 */
const SOURCE_ID_MAX_LENGTH = 100;

// ---------------------------------------------------------------------------
// Opaque handle codec seam.
//
// The adapter is fully codec-driven — it does NOT construct or
// decode handles itself.  The injected codec is the SOLE producer
// of handles in the bounded output and the SOLE consumer of
// handles on input.  A built-in reversible encoding would leak
// source ids through the formatter boundary; the injection seam
// keeps that property out of this slice entirely.
// ---------------------------------------------------------------------------

/**
 * Bounded decode verdict.  `ok` carries the source id the codec
 * resolved; `invalid` covers every failure mode (unknown handle,
 * wrong shape, codec-internal rejection) without exposing the
 * underlying value to the adapter.
 */
export type NotesReadRuntimeDecodeVerdict =
  | Readonly<{ kind: "ok"; sourceId: string }>
  | Readonly<{ kind: "invalid" }>;

/**
 * The injected codec interface.  Every call MUST return a handle
 * that satisfies the bounded opaque handle grammar
 * (`isBoundedOpaqueValue` from `notes-cli.ts`); otherwise the
 * adapter collapses the result to a fixed categorical error and
 * never emits the codec's value.
 */
export interface NotesReadRuntimeHandleCodec {
  /**
   * Produce a bounded opaque handle for `sourceId`.  The returned
   * string MUST satisfy `isBoundedOpaqueValue`; a codec that
   * violates the grammar is treated as a runtime fault and its
   * output is never propagated.
   */
  readonly encode: (sourceId: string) => string;
  /**
   * Resolve a bounded opaque handle back to its source id, OR
   * return `{ kind: "invalid" }` for any handle the codec did not
   * mint itself.  The adapter consults the codec FIRST and only
   * invokes `source.note` with the returned source id.
   */
  readonly decode: (handle: string) => NotesReadRuntimeDecodeVerdict;
}

// ---------------------------------------------------------------------------
// Closed categorical result mirrors.
// ---------------------------------------------------------------------------

/**
 * Bounded note metadata the formatter is willing to print.  This
 * mirrors `BoundedNoteMetadata` from `notes-cli.ts` but is
 * declared locally so this slice can evolve independently of the
 * CLI parser.  The adapter freezes every instance.
 */
export interface BoundedReadNoteMetadata {
  readonly handle: string;
  readonly label: string;
  readonly bytes: number;
}

/**
 * Bounded single-note content the formatter is willing to print.
 * Mirrors `BoundedNoteContent` from `notes-cli.ts` and is also
 * frozen.
 */
export interface BoundedReadNoteContent {
  readonly label: string;
  readonly bytes: number;
}

/**
 * Closed categorical results the adapter can emit.  Mirrors the
 * read-only subset of `NotesCategoricalResult` from `notes-cli.ts`
 * (page / note / empty / missing / error).
 */
export type NotesReadRuntimeResult =
  | Readonly<{ kind: "page"; notes: readonly BoundedReadNoteMetadata[]; next: string | null }>
  | Readonly<{ kind: "note"; content: BoundedReadNoteContent }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 | 3 }>;

// ---------------------------------------------------------------------------
// Injected source seam.
// ---------------------------------------------------------------------------

/** A single source-side note metadata record. */
export interface NotesReadRuntimeSourceNote {
  readonly id: string;
  readonly title: string;
  readonly dateModified?: number;
}

/** A single source-side search hit. */
export interface NotesReadRuntimeSourceSearchHit {
  readonly id: string;
  readonly title: string;
}

/**
 * The narrow structural seam the adapter consumes from an injected
 * source.  No `add`, `update`, `delete`, `pin`, `moveToTrash`,
 * `setLastSynced`, raw `database` accessor, or generic call
 * surface is exposed.
 */
export interface NotesReadRuntimeSource {
  readonly list: () => Promise<readonly NotesReadRuntimeSourceNote[]>;
  readonly search: (query: string) => Promise<readonly NotesReadRuntimeSourceSearchHit[]>;
  readonly note: (id: string) => Promise<NotesReadRuntimeSourceNote | undefined>;
}

/**
 * Names of methods the adapter will NEVER expose on a seam.  The
 * constructor rejects any source object that carries any of these
 * keys, mirroring the allowlist enforcement used by the existing
 * `NotesnookReadOnlyAdapter`.
 */
const FORBIDDEN_SOURCE_METHODS: readonly string[] = [
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
  "call",
  "invoke",
  "transport",
  "sync",
  "send",
];

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export interface NotesReadRuntimeAdapterOptions {
  readonly source: NotesReadRuntimeSource;
  /**
   * The injected opaque-handle codec.  The adapter delegates ALL
   * handle production and ALL handle decoding to this seam; it
   * NEVER constructs or decodes handles itself.
   */
  readonly handleCodec: NotesReadRuntimeHandleCodec;
}

/**
 * Bounded read-only runtime adapter.  Maps an injected source
 * onto the closed categorical results the operator formatter
 * already understands.  Construction is synchronous; the runtime
 * is frozen so its methods cannot be swapped at runtime.
 */
export class NotesReadRuntimeAdapter {
  readonly #source: NotesReadRuntimeSource;
  readonly #handleCodec: NotesReadRuntimeHandleCodec;

  constructor(options: NotesReadRuntimeAdapterOptions) {
    this.#source = resolveSource(options.source);
    this.#handleCodec = resolveHandleCodec(options.handleCodec);
    Object.freeze(this);
  }

  /** Paginated read of bounded note metadata. */
  async browse(command: {
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<NotesReadRuntimeResult> {
    const validated = validatePageCommand(command);
    if (validated.kind === "error") return validated.error;
    const { limit } = validated;
    let raw: readonly NotesReadRuntimeSourceNote[];
    try {
      raw = await this.#source.list();
    } catch {
      return runtimeError();
    }
    if (!Array.isArray(raw)) return runtimeError();
    const bounded: BoundedReadNoteMetadata[] = [];
    for (const entry of raw) {
      if (bounded.length >= NOTES_READ_PAGE_LIMIT_MAX) break;
      const coerced = coerceSourceNote(entry);
      if (coerced.kind === "error") return coerced.error;
      const encoded = encodeViaCodec(this.#handleCodec, coerced.id);
      if (encoded.kind === "error") return encoded.error;
      bounded.push(
        freezeRecord({
          handle: encoded.handle,
          label: coerced.title,
          bytes: boundedByteSize(coerced.title),
        }),
      );
    }
    const trimmed =
      limit !== undefined && limit < bounded.length ? bounded.slice(0, limit) : bounded;
    if (trimmed.length === 0) return { kind: "empty" };
    return freezeRecord({
      kind: "page",
      notes: Object.freeze(trimmed) as readonly BoundedReadNoteMetadata[],
      next: null,
    });
  }

  /** Paginated read of bounded title-only search hits. */
  async search(command: {
    readonly query: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<NotesReadRuntimeResult> {
    const validated = validatePageCommand(command);
    if (validated.kind === "error") return validated.error;
    if (
      typeof command?.query !== "string" ||
      command.query.length === 0 ||
      new TextEncoder().encode(command.query).byteLength > MAX_NOTES_READ_QUERY_BYTES
    ) {
      return invalidInputError();
    }
    const { limit } = validated;
    let raw: readonly NotesReadRuntimeSourceSearchHit[];
    try {
      raw = await this.#source.search(command.query);
    } catch {
      return runtimeError();
    }
    if (!Array.isArray(raw)) return runtimeError();
    const bounded: BoundedReadNoteMetadata[] = [];
    for (const entry of raw) {
      if (bounded.length >= NOTES_READ_PAGE_LIMIT_MAX) break;
      const coerced = coerceSourceSearchHit(entry);
      if (coerced.kind === "error") return coerced.error;
      const encoded = encodeViaCodec(this.#handleCodec, coerced.id);
      if (encoded.kind === "error") return encoded.error;
      bounded.push(
        freezeRecord({
          handle: encoded.handle,
          label: coerced.title,
          bytes: boundedByteSize(coerced.title),
        }),
      );
    }
    const trimmed =
      limit !== undefined && limit < bounded.length ? bounded.slice(0, limit) : bounded;
    if (trimmed.length === 0) return { kind: "empty" };
    return freezeRecord({
      kind: "page",
      notes: Object.freeze(trimmed) as readonly BoundedReadNoteMetadata[],
      next: null,
    });
  }

  /** Single bounded note view by opaque handle. */
  async get(command: { readonly handle: string }): Promise<NotesReadRuntimeResult> {
    if (typeof command?.handle !== "string") return invalidInputError();
    // Bounded opaque handle grammar MUST be validated BEFORE the
    // codec is consulted.  A forged, malformed, or reserved
    // handle (including the `rev_` family) never crosses the
    // codec boundary; only a handle that already satisfies
    // `isBoundedOpaqueHandleValue` may be passed to `decode`.
    if (!isBoundedOpaqueHandleValue(command.handle)) return invalidInputError();
    // The codec is the SOLE consumer of input handles.  A codec
    // that throws (rather than returning `invalid`) is treated
    // as a runtime fault: the exception is swallowed, the
    // exception text never crosses the formatter boundary, and
    // the adapter collapses to a fixed categorical error before
    // any source-side I/O.
    let decoded: NotesReadRuntimeDecodeVerdict;
    try {
      decoded = this.#handleCodec.decode(command.handle);
    } catch {
      return runtimeError();
    }
    // Verdict shape guard.  The adapter accepts EXACTLY
    // `{kind:'ok', sourceId: string}` with a non-empty source
    // id of length <= 100.  Every other shape — wrong kind,
    // missing sourceId, non-string / empty / oversized
    // sourceId — collapses to a fixed categorical error and
    // never invokes `source.note`.
    if (
      decoded === null ||
      decoded === undefined ||
      typeof decoded !== "object" ||
      (decoded as { kind?: unknown }).kind !== "ok"
    ) {
      return invalidInputError();
    }
    const verdict = decoded as { kind: "ok"; sourceId: unknown };
    if (typeof verdict.sourceId !== "string") {
      return runtimeError();
    }
    if (verdict.sourceId.length === 0) {
      return runtimeError();
    }
    if (verdict.sourceId.length > SOURCE_ID_MAX_LENGTH) {
      return runtimeError();
    }
    let raw: NotesReadRuntimeSourceNote | undefined;
    try {
      raw = await this.#source.note(verdict.sourceId);
    } catch {
      return runtimeError();
    }
    if (raw === undefined || raw === null) return { kind: "missing" };
    const coerced = coerceSourceNote(raw);
    if (coerced.kind === "error") return coerced.error;
    if (coerced.id !== verdict.sourceId) {
      // The source returned a different identity than the codec
      // decoded.  This is a categorical error — the decoded
      // identity MUST bind to the requested note.
      return runtimeError();
    }
    return freezeRecord({
      kind: "note",
      content: freezeRecord({
        label: coerced.title,
        bytes: boundedByteSize(coerced.title),
      }),
    });
  }
}

/** Factory helper. */
export function createNotesReadRuntime(
  options: NotesReadRuntimeAdapterOptions,
): NotesReadRuntimeAdapter {
  return new NotesReadRuntimeAdapter(options);
}

// ---------------------------------------------------------------------------
// Categorical error normalisation.
// ---------------------------------------------------------------------------

const READ_RUNTIME_ERRORS = new WeakSet<object>();

function readRuntimeError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  READ_RUNTIME_ERRORS.add(error);
  return error;
}

/** Public predicate.  Returns true iff `value` is an adapter-owned error. */
export function isNotesReadRuntimeError(value: unknown): value is Error {
  return typeof value === "object" && value !== null && READ_RUNTIME_ERRORS.has(value);
}

/** Fixed-shape closed categorical errors. */
function invalidInputError(): NotesReadRuntimeResult {
  return { kind: "error", exitCode: 2, message: "Notes read runtime: invalid input" };
}

function runtimeError(): NotesReadRuntimeResult {
  return { kind: "error", exitCode: 3, message: "Notes read runtime: runtime failure" };
}

function invalidCodecHandleError(): NotesReadRuntimeResult {
  // The codec emitted a handle that violates the bounded opaque
  // value grammar.  The handle NEVER crosses the formatter
  // boundary; the failure is fixed-shape and never echoes the
  // codec's minted value.
  return { kind: "error", exitCode: 3, message: "Notes read runtime: invalid codec handle" };
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function resolveSource(source: unknown): NotesReadRuntimeSource {
  if (source === undefined || source === null || typeof source !== "object") {
    throw readRuntimeError("Notes read runtime: injected source must be an object");
  }
  const record = source as Record<string, unknown>;
  for (const key of ["list", "search", "note"] as const) {
    if (typeof record[key] !== "function") {
      throw readRuntimeError(`Notes read runtime: injected source is missing ${key}()`);
    }
  }
  for (const name of FORBIDDEN_SOURCE_METHODS) {
    if (name in record) {
      throw readRuntimeError(`Notes read runtime: injected source exposes forbidden ${name}`);
    }
  }
  return record as unknown as NotesReadRuntimeSource;
}

function resolveHandleCodec(codec: unknown): NotesReadRuntimeHandleCodec {
  if (codec === undefined || codec === null || typeof codec !== "object") {
    throw readRuntimeError("Notes read runtime: injected handle codec must be an object");
  }
  const record = codec as Record<string, unknown>;
  if (typeof record.encode !== "function") {
    throw readRuntimeError("Notes read runtime: injected handle codec is missing encode()");
  }
  if (typeof record.decode !== "function") {
    throw readRuntimeError("Notes read runtime: injected handle codec is missing decode()");
  }
  return record as unknown as NotesReadRuntimeHandleCodec;
}

type PageCommandValidated =
  | Readonly<{ kind: "ok"; cursor: string | undefined; limit: number | undefined }>
  | Readonly<{ kind: "error"; error: NotesReadRuntimeResult }>;

function validatePageCommand(command: unknown): PageCommandValidated {
  if (typeof command !== "object" || command === null) {
    return { kind: "error", error: invalidInputError() };
  }
  const record = command as Record<string, unknown>;
  let cursor: string | undefined;
  let limit: number | undefined;
  if (record.cursor !== undefined) {
    if (typeof record.cursor !== "string") {
      return { kind: "error", error: invalidInputError() };
    }
    if (!isBoundedCursorValue(record.cursor)) {
      return { kind: "error", error: invalidInputError() };
    }
    cursor = record.cursor;
  }
  if (record.limit !== undefined) {
    if (
      typeof record.limit !== "number" ||
      !Number.isInteger(record.limit) ||
      record.limit < 1 ||
      record.limit > NOTES_READ_PAGE_LIMIT_MAX
    ) {
      return { kind: "error", error: invalidInputError() };
    }
    limit = record.limit;
  }
  return { kind: "ok", cursor, limit };
}

/**
 * Validate a bounded cursor value WITHOUT using the CLI parser's
 * `<prefix>_<token>` regex literally.  This slice is independent
 * of the CLI contract; the cursor must simply be a stable
 * non-empty token that survives round-trip, so we keep the rule
 * local and small.  A reserved `rev_` prefix is rejected to keep
 * parity with the CLI contract.
 */
function isBoundedCursorValue(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 128) return false;
  if (/^rev_/.test(value)) return false;
  // Match the CLI contract shape for cursors: lowercase ascii
  // letters/digits/underscore/hyphen, no whitespace, no control.
  return /^[a-z0-9_-]{1,128}$/.test(value);
}

type CoercedSourceNote =
  | Readonly<{ kind: "ok"; id: string; title: string }>
  | Readonly<{ kind: "error"; error: NotesReadRuntimeResult }>;

function coerceSourceNote(value: unknown): CoercedSourceNote {
  if (value === undefined || value === null || typeof value !== "object") {
    return { kind: "error", error: runtimeError() };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    return { kind: "error", error: runtimeError() };
  }
  if (record.id.length > SOURCE_ID_MAX_LENGTH) {
    return { kind: "error", error: runtimeError() };
  }
  if (typeof record.title !== "string") {
    return { kind: "error", error: runtimeError() };
  }
  if (record.title.length > SOURCE_TITLE_MAX_LENGTH) {
    return { kind: "error", error: runtimeError() };
  }
  return { kind: "ok", id: record.id, title: record.title };
}

type CoercedSourceSearchHit =
  | Readonly<{ kind: "ok"; id: string; title: string }>
  | Readonly<{ kind: "error"; error: NotesReadRuntimeResult }>;

function coerceSourceSearchHit(value: unknown): CoercedSourceSearchHit {
  if (value === undefined || value === null || typeof value !== "object") {
    return { kind: "error", error: runtimeError() };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    return { kind: "error", error: runtimeError() };
  }
  if (record.id.length > SOURCE_ID_MAX_LENGTH) {
    return { kind: "error", error: runtimeError() };
  }
  if (typeof record.title !== "string") {
    return { kind: "error", error: runtimeError() };
  }
  if (record.title.length > SOURCE_TITLE_MAX_LENGTH) {
    return { kind: "error", error: runtimeError() };
  }
  return { kind: "ok", id: record.id, title: record.title };
}

type EncodedHandle =
  | Readonly<{ kind: "ok"; handle: string }>
  | Readonly<{ kind: "error"; error: NotesReadRuntimeResult }>;

/**
 * Encode a source id via the injected codec and validate the
 * returned handle against the bounded opaque value grammar.  The
 * adapter NEVER synthesises handles itself — every handle in the
 * bounded output came from the codec and the codec's value is
 * rejected categorically if it violates the grammar (including
 * the reserved `rev_` family exclusion).
 */
function encodeViaCodec(codec: NotesReadRuntimeHandleCodec, sourceId: string): EncodedHandle {
  let handle: string;
  try {
    handle = codec.encode(sourceId);
  } catch {
    return { kind: "error", error: invalidCodecHandleError() };
  }
  if (typeof handle !== "string" || handle.length === 0) {
    return { kind: "error", error: invalidCodecHandleError() };
  }
  if (!isBoundedOpaqueHandleValue(handle)) {
    return { kind: "error", error: invalidCodecHandleError() };
  }
  return { kind: "ok", handle };
}

/**
 * Mirror of `isBoundedOpaqueValue` from `notes-cli.ts`.  Inlined
 * here so this slice is independent of the CLI parser — the
 * grammar is the documented `<prefix>_<token>` shape with a
 * reserved-prefix exclusion (`rev_` family).  Any codec that
 * mints a handle outside this grammar is rejected categorically.
 */
function isBoundedOpaqueHandleValue(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 128) return false;
  if (/^rev_/.test(value)) return false;
  return /^[a-z][a-z0-9]{2,3}_[A-Za-z0-9_-]{4,124}$/.test(value);
}

function boundedByteSize(title: string): number {
  // `Buffer.byteLength` reflects UTF-8 bytes, which is what the
  // existing `BoundedNoteContent.bytes` field documents.  We use
  // the title alone because the adapter is title-only and never
  // carries body content.
  return Buffer.byteLength(title, "utf8");
}

/**
 * Build a frozen record so downstream code cannot mutate the
 * adapter's output.  `Object.freeze` is sufficient for the
 * project's immutability contract; the records carry no
 * prototype-chain extensions by design.
 */
function freezeRecord<T extends object>(value: T): T {
  return Object.freeze(value);
}
