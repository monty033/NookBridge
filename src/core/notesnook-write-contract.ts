/**
 * Stage 4 — pure write contract and opaque revision guards.
 *
 * This module implements ONLY the first pure slice of
 * `docs/stage-4-write-plan.md`:
 *
 *   §1 "Define the write contract" — typed application-layer commands
 *      (`createNote`, `appendNote`, `updateNote`), bounded input sizes,
 *      allowed patch fields, stable result shapes, opaque revision
 *      tokens, and categorical errors.
 *   §3 "Add revision and conflict guards" — the *pure* comparison half
 *      of the guard: an `expectedRevision` must equal the observed
 *      current revision or the operation fails closed, and the guard
 *      never chooses a side.
 *
 * Deliberate non-goals (later Stage 4 slices)
 * -------------------------------------------
 *
 *   - No Notesnook `Database`, `Notes`, `Notebooks`, transport, storage,
 *     credential, or collection-mutator access.  This module imports
 *     nothing from `@notesnook/*` and holds no upstream handle, so it
 *     structurally cannot mutate a vault.
 *   - No mutation of any kind.  The `plan*` functions validate a command
 *     and return an inert, frozen description of what a *future* adapter
 *     would be permitted to attempt.  `localCommitted` and
 *     `remoteSynced` are always `false`.
 *   - No CLI seam, no `SyncCoordinator`, no network, no retry/backoff,
 *     no `send`/`full` sync, no delete, no force-overwrite, no Vault
 *     unlock or password handling, no live state.
 *
 * Redaction
 * ---------
 *
 * Every failure is a categorical, chain-free
 * {@link NotesnookWriteContractError} carrying a stable `code` and a
 * fixed message.  Messages are constructed from literals only: no note
 * id, title, body, fragment, tag, patch-field value, path, revision
 * token, or upstream cause is ever interpolated.  Rejected field names
 * are not echoed either, because a caller can supply an arbitrary
 * attacker-chosen key.
 */

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import {
  DEFAULT_NOTESNOOK_LIST_KIND,
  normaliseNotesnookListKind,
  type NotesnookListKind,
} from "./notesnook-write-list-intent.js";

// ---------------------------------------------------------------------------
// Categorical error codes.
// ---------------------------------------------------------------------------

/**
 * Stable categorical failure codes for the Stage 4 write contract.
 *
 * `conflict`, `vault_locked`, and `sync_failed` are part of the contract
 * vocabulary defined by the plan.  They are not raised by this pure
 * slice (there is no vault, no local materialised conflict, and no sync
 * path here); they exist so the later adapter and coordinator slices map
 * onto an already-published closed set rather than inventing codes.
 */
export type NotesnookWriteErrorCode =
  | "invalid_input"
  | "unsupported_content"
  | "unsupported_patch_field"
  | "stale_revision"
  | "conflict"
  | "vault_locked"
  | "sync_failed";

const WRITE_CONTRACT_ERRORS = new WeakSet<object>();

/**
 * Fixed, categorical message table for {@link NotesnookWriteContractError}.
 *
 * Messages are derived only from the categorical code; the constructor's
 * second argument is accepted for compatibility but never inspected or
 * interpolated.  This stops an attacker from smuggling a canary through
 * `new NotesnookWriteContractError(code, secret)`.
 */
const WRITE_CONTRACT_ERROR_MESSAGES: { readonly [K in NotesnookWriteErrorCode]: string } =
  Object.freeze({
    invalid_input: "Notesnook write contract: invalid input",
    unsupported_content: "Notesnook write contract: unsupported content",
    unsupported_patch_field: "Notesnook write contract: unsupported patch field",
    stale_revision: "Notesnook write contract: stale revision",
    conflict: "Notesnook write contract: conflict",
    vault_locked: "Notesnook write contract: vault locked",
    sync_failed: "Notesnook write contract: sync failed",
  });

/**
 * Categorical, chain-free Stage 4 write-contract error.
 *
 * Recognised by object identity only (see
 * {@link isNotesnookWriteContractError}), matching the Stage 2/3
 * adapter and projection error convention.  `cause` and `__context__`
 * are cleared so a caller-supplied options bag cannot smuggle upstream
 * payloads (paths, tokens, note bodies) across the boundary.
 *
 * The constructor accepts a second argument for backwards compatibility
 * but it is *ignored*: the public message is fixed by the categorical
 * `code` only, so a caller cannot interpolate a canary through
 * `new NotesnookWriteContractError(code, secret)`.
 */
export class NotesnookWriteContractError extends Error {
  public readonly code!: NotesnookWriteErrorCode;

  constructor(code: NotesnookWriteErrorCode, _ignoredMessage?: unknown) {
    super(WRITE_CONTRACT_ERROR_MESSAGES[code]);
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: code,
    });
    Object.defineProperty(this, "cause", { configurable: true, value: undefined });
    Object.defineProperty(this, "__context__", { configurable: true, value: undefined });
    Object.defineProperty(this, "name", {
      configurable: true,
      value: "NotesnookWriteContractError",
    });
    WRITE_CONTRACT_ERRORS.add(this);
  }
}

/**
 * Identity predicate for {@link NotesnookWriteContractError}.
 *
 * A look-alike object with the right `name`/`code` is rejected.
 */
export function isNotesnookWriteContractError(
  value: unknown,
): value is NotesnookWriteContractError {
  return typeof value === "object" && value !== null && WRITE_CONTRACT_ERRORS.has(value);
}

function fail(code: NotesnookWriteErrorCode, message: string): never {
  throw new NotesnookWriteContractError(code, message);
}

// ---------------------------------------------------------------------------
// Bounded limits and the allowed patch-field set.
// ---------------------------------------------------------------------------

/**
 * Bounded input limits for every Stage 4 write command.
 *
 * Byte limits are measured in UTF-8 bytes, not code units, so a
 * multi-byte body cannot smuggle extra payload past a length check.
 */
export interface Stage4WriteLimits {
  readonly maxTitleLength: number;
  readonly maxContentBytes: number;
  readonly maxFragmentBytes: number;
  readonly maxTags: number;
  readonly maxTagLength: number;
  readonly maxIdLength: number;
}

/** Frozen, published bounded limits. */
export const STAGE4_WRITE_LIMITS: Stage4WriteLimits = Object.freeze({
  maxTitleLength: 256,
  maxContentBytes: 262_144,
  maxFragmentBytes: 32_768,
  maxTags: 16,
  maxTagLength: 64,
  maxIdLength: 128,
});

/**
 * The only note fields a Stage 4 update may address.
 *
 * `deleted`, `locked`, `password`, `force`, `readonly`, `conflicted`,
 * and every other field are outside the contract and fail closed with
 * `unsupported_patch_field`.
 *
 * `listKind` is a meta-field: it does not mutate a note attribute
 * itself, it tells the codec which checklist HTML shape to emit when
 * the patch also carries a `content` field.  Including it in the
 * allowlist lets a wire envelope update the note body and pick the
 * intent in a single patch; a patch that omits `content` is still
 * valid with `listKind` set, and the contract surfaces the resolved
 * kind on the plan so the adapter can forward it to the codec seam.
 *
 * This is *not* a real `Set` instance.  A real `Set` exposes its internal
 * `[[SetData]]` slot to `Set.prototype.add`/`delete`/`clear` even when the
 * own mutator properties are replaced, so a caller could otherwise widen
 * the allowlist at runtime via `Set.prototype.add.call(set, "deleted")`.
 * `sealedReadonlySet` returns a frozen plain object that implements the
 * `ReadonlySet<T>` interface without any backing Set, so the prototype
 * bypass has nothing to mutate.
 */
export const ALLOWED_UPDATE_PATCH_FIELDS: ReadonlySet<NotesnookUpdatePatchField> =
  sealedReadonlySet<NotesnookUpdatePatchField>([
    "title",
    "content",
    "notebookId",
    "tags",
    "pinned",
    "favorite",
    "listKind",
    "storedContent",
  ]);

/**
 * Build a genuinely immutable `ReadonlySet<T>` that is **not** a real
 * `Set` instance.
 *
 * `Object.freeze` alone is insufficient: `Set.prototype.add`/`delete`/`clear`
 * mutate internal slots directly and bypass the replaced own mutators.
 * To make the prototype bypass impossible we return a frozen plain object
 * whose `has` / iteration methods consult a frozen backing array held in
 * a closure — no internal Set slot exists, so no prototype call can widen
 * or narrow the contents.  Only `has`, iteration, `size`, and the
 * `ReadonlySet<T>` accessors are exposed; mutator methods are absent and
 * the container is frozen.
 */
function sealedReadonlySet<T>(values: readonly T[]): ReadonlySet<T> {
  // Freeze the backing array so the closure-captured list is itself
  // immutable.  Sort a copy so iteration is deterministic for callers
  // like `[...ALLOWED_UPDATE_PATCH_FIELDS].sort()`.
  const backing: readonly T[] = Object.freeze([...values].sort());
  const has = (value: unknown): boolean => backing.indexOf(value as T) !== -1;
  const iterator = function* (): IterableIterator<T> {
    for (const value of backing) yield value;
  };
  const container: ReadonlySet<T> = {
    has,
    get size(): number {
      return backing.length;
    },
    forEach(callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
      for (const value of backing) callback.call(thisArg, value, value, container);
    },
    keys(): IterableIterator<T> {
      return iterator();
    },
    values(): IterableIterator<T> {
      return iterator();
    },
    entries(): IterableIterator<[T, T]> {
      const it = iterator();
      return {
        [Symbol.iterator]() {
          return this;
        },
        next(): IteratorResult<[T, T]> {
          const step = it.next();
          if (step.done === true) return { done: true, value: undefined as unknown as [T, T] };
          return { done: false, value: [step.value, step.value] };
        },
      };
    },
    [Symbol.iterator](): IterableIterator<T> {
      return iterator();
    },
  };
  return Object.freeze(container);
}

/** Field names accepted inside an `updateNote` patch. */
export type NotesnookUpdatePatchField =
  | "title"
  | "content"
  | "notebookId"
  | "tags"
  | "pinned"
  | "favorite"
  | "listKind"
  | "storedContent";

/**
 * An already-encoded native stored-content envelope for the update path.
 *
 * The operator edit path decodes the stored document, applies the
 * editor's Markdown, and re-encodes it natively so untouched opaque
 * subtrees survive byte-for-byte.  Routing that result back through the
 * Markdown codec would lose them, so the contract admits the exact
 * `{type, data}` envelope instead.  This is a **closed** shape: an
 * unknown content type, an unexpected key, or an oversize body fails
 * closed.  `storedContent` and `content` are mutually exclusive — a
 * patch must pick exactly one content channel.
 */
export interface NotesnookStoredContentPatch {
  readonly type: "tiptap" | "html";
  readonly data: string;
}

// ---------------------------------------------------------------------------
// Opaque revision tokens.
// ---------------------------------------------------------------------------

/**
 * Opaque revision token.
 *
 * Callers must treat it as a meaningless string: it is a digest of the
 * observed note revision state, so it does not expose the note id,
 * timestamps, counters, or anything else about the vault.  Only
 * equality is meaningful.
 */
export type NotesnookRevisionToken = string & { readonly __brand: "NotesnookRevisionToken" };
/** Observed note revision state used to derive a revision token. */
export interface NotesnookRevisionState {
  readonly id: string;
  readonly dateEdited: number;
  readonly revisionCounter?: number;
}

const REVISION_TOKEN_PATTERN = /^rev_[0-9a-f]{32}$/;

/**
 * Derive an opaque revision token from observed note revision state.
 *
 * Pure and deterministic: identical state yields an identical token,
 * different state yields a different token.  The hex suffix is the
 * first 32 lowercase hex characters of `sha256("<id>\u0000<dateEdited>\u0000<revisionCounter ?? 0>")`
 * over UTF-8, encoded as `rev_` + 32 hex chars.  SHA-256 is used for
 * collision resistance on the concurrency token; this is *not* a
 * security primitive and is never used to authorise anything on its
 * own — the guard only ever compares two tokens the caller already
 * holds.
 */
/**
 * Validate and brand a revision token that arrived as a plain string.
 *
 * A daemon-side read returns the observed revision as an ordinary string;
 * this is the one place that turns it back into the branded token while
 * still enforcing the published shape.  A malformed value fails closed
 * with the categorical contract error, so callers never hand-brand a
 * string with a cast.
 */
export function asRevisionToken(value: unknown): NotesnookRevisionToken {
  return requireRevisionToken(value);
}

export function createRevisionToken(state: NotesnookRevisionState): NotesnookRevisionToken {
  if (!state || typeof state !== "object") {
    fail("invalid_input", "revision state must be an object");
  }
  const record = state as unknown as Record<string, unknown>;
  // Each property may carry a throwing getter or Proxy trap; the readers
  // normalise any attacker throw to categorical `invalid_input` without
  // echoing the throw site.  Order is fixed so the message is stable
  // regardless of which accessor first fired.
  const id = readProperty(record, "id");
  const dateEdited = readProperty(record, "dateEdited");
  const counter = readProperty(record, "revisionCounter");
  if (typeof id !== "string" || id.length === 0 || id.length > STAGE4_WRITE_LIMITS.maxIdLength) {
    fail("invalid_input", "revision state has an invalid note id");
  }
  if (typeof dateEdited !== "number" || !Number.isFinite(dateEdited) || dateEdited < 0) {
    fail("invalid_input", "revision state has an invalid edit timestamp");
  }
  if (
    counter !== undefined &&
    (typeof counter !== "number" || !Number.isInteger(counter) || counter < 0)
  ) {
    fail("invalid_input", "revision state has an invalid revision counter");
  }
  const canonical = `${id}\u0000${dateEdited}\u0000${counter ?? 0}`;
  return `rev_${sha256HexPrefix(canonical, 32)}` as NotesnookRevisionToken;
}

/**
 * First `width` lowercase hex characters of `sha256(input)` in UTF-8.
 *
 * The digest is a collision-resistance surface for the concurrency
 * token; nothing about the input beyond byte count is observable, so
 * the partial truncation is fine for opacity.  Standard `createHash`
 * keeps the implementation cryptographically grounded instead of a
 * homegrown FNV-style mixer.
 */
function sha256HexPrefix(input: string, width: number): string {
  const digest = createHash("sha256").update(input, "utf8").digest("hex");
  return digest.slice(0, width);
}

function isRevisionToken(value: unknown): value is NotesnookRevisionToken {
  // `RegExp.prototype.test` invokes `Symbol.match` on the receiver; a
  // hostile string proxy can throw through that trap.  Guard the call.
  if (typeof value !== "string") return false;
  let matched: boolean;
  try {
    matched = REVISION_TOKEN_PATTERN.test(value);
  } catch {
    return false;
  }
  return matched;
}

function requireRevisionToken(value: unknown): NotesnookRevisionToken {
  if (!isRevisionToken(value)) {
    fail("invalid_input", "revision token is malformed");
  }
  return value;
}

/**
 * Compare two revision tokens for equality.
 *
 * Returns `false` for any malformed input rather than throwing, so a
 * caller can probe equality without branching on error shape.  It never
 * reports *which* side is malformed or newer.
 */
export function revisionTokensMatch(left: unknown, right: unknown): boolean {
  if (!isRevisionToken(left) || !isRevisionToken(right)) return false;
  return constantTimeEquals(left, right);
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let delta = 0;
  for (let index = 0; index < left.length; index += 1) {
    delta |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return delta === 0;
}

// ---------------------------------------------------------------------------
// Hostile-getter / Proxy-safe property readers.
//
// A caller-controlled object may have throwing own-property getters or be a
// `Proxy` whose `get`/`has`/`ownKeys`/`getOwnPropertyDescriptor` traps throw
// attacker-controlled Errors.  Without normalisation, those Errors would
// escape past the categorical boundary and could carry forbidden payloads in
// their message or stack.  The readers below intentionally use `Reflect.*`
// so the trap is invoked exactly once, in a controlled site that cannot
// reflect a canary back into an error string.  Any throw becomes a
// categorical `invalid_input`; nothing the attacker throws is observed,
// stored, or re-emitted.
// ---------------------------------------------------------------------------

function readProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    return Reflect.get(record, key, record);
  } catch {
    fail("invalid_input", "an input property accessor threw");
  }
}

function readOwnKeys(record: Record<string, unknown>): string[] {
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(record);
  } catch {
    fail("invalid_input", "an input property accessor threw");
  }
  const out: string[] = [];
  for (const key of keys as readonly PropertyKey[]) {
    // Each accessor may throw independently — an attacker could otherwise
    // smuggle a canary through a single bad key while still letting the
    // legal keys reveal what the patch "intended".
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(record, key);
    } catch {
      fail("invalid_input", "an input property accessor threw");
    }
    if (!descriptor || descriptor.enumerable !== true) continue;
    if (typeof key !== "string") continue;
    out.push(key);
  }
  return out;
}

/**
 * Pure revision guard: the caller's `expectedRevision` must equal the
 * observed `currentRevision`, or the operation fails closed with
 * `stale_revision` *before* any mutation is attempted.
 *
 * The guard deliberately does not choose a side.  It performs no merge,
 * no last-writer-wins, no force, and it does not report either token,
 * which of them is newer, or any resolution hint.  Reconciliation is the
 * caller's (ultimately the operator's) decision.
 */
export function assertRevisionMatch(expectedRevision: unknown, currentRevision: unknown): void {
  const expected = requireRevisionToken(expectedRevision);
  const current = requireRevisionToken(currentRevision);
  if (!constantTimeEquals(expected, current)) {
    fail("stale_revision", "expected revision does not match the current revision");
  }
}

// ---------------------------------------------------------------------------
// Command inputs.
// ---------------------------------------------------------------------------

/** `createNote(title, content, notebookId?, tags?)` input. */
export interface CreateNoteCommand {
  readonly title: string;
  readonly content: string;
  readonly notebookId?: string;
  readonly tags?: readonly string[];
  /**
   * Optional intent for the Markdown → stored-content codec.  When
   * omitted the codec defaults to `simple-checklist` (the lightweight
   * `<ul class="simple-checklist">` HTML); setting `task-list` switches
   * to the rich interactive `<ul class="checklist">` HTML the
   * `@notesnook/core` task-list extension understands.  Any value
   * outside the closed set is a categorical `invalid_input`.
   */
  readonly listKind?: NotesnookListKind;
}

/** `appendNote(id, markdownFragment, expectedRevision)` input. */
export interface AppendNoteCommand {
  readonly id: string;
  readonly markdownFragment: string;
  readonly expectedRevision: NotesnookRevisionToken;
  /**
   * Optional intent for the Markdown fragment the codec appends.
   * See {@link CreateNoteCommand.listKind}; the same defaults and
   * closed set apply.
   */
  readonly listKind?: NotesnookListKind;
}

/**
 * Allowed `updateNote` patch. At least one field must be present.
 *
 * `listKind` is the closed-set intent the codec uses when the patch
 * also carries a `content` field.  A patch that contains `listKind`
 * without `content` is accepted by the contract plan and ignored by
 * the mutation path — the codec is the only consumer of the resolved
 * intent.
 */
export interface UpdateNotePatch {
  readonly title?: string;
  readonly content?: string;
  /**
   * Exact native stored content.  Mutually exclusive with `content`
   * and `listKind`: a patch picks one content channel, never both.
   */
  readonly storedContent?: NotesnookStoredContentPatch;
  readonly notebookId?: string;
  readonly tags?: readonly string[];
  readonly pinned?: boolean;
  readonly favorite?: boolean;
  readonly listKind?: NotesnookListKind;
}

/** `updateNote(id, patch, expectedRevision)` input. */
export interface UpdateNoteCommand {
  readonly id: string;
  readonly patch: UpdateNotePatch;
  readonly expectedRevision: NotesnookRevisionToken;
}

/** `deleteNote(id, expectedRevision)` input. */
export interface DeleteNoteCommand {
  readonly id: string;
  readonly expectedRevision: NotesnookRevisionToken;
}

// ---------------------------------------------------------------------------
// Stable result shapes.
//
// A plan describes an *authorised, not yet attempted* write.  Local
// commit and remote synchronization are reported as separate outcomes
// per the plan's boundary rules, and both are `false` in this pure
// slice because nothing has been committed anywhere.
// ---------------------------------------------------------------------------

interface WriteOutcomeFlags {
  readonly localCommitted: false;
  readonly remoteSynced: false;
  readonly pendingSync: true;
}

/** Bounded description of an authorised create. */
export interface CreateNotePlan extends WriteOutcomeFlags {
  readonly operation: "create";
  readonly title: string;
  readonly contentBytes: number;
  readonly notebookId?: string;
  readonly tags?: readonly string[];
  /**
   * Resolved list-intent the codec uses for this create.  When the
   * caller omitted the selector the contract surfaces the published
   * default so downstream code never sees an `undefined` it must
   * re-resolve.
   */
  readonly listKind: NotesnookListKind;
}

/** Bounded description of an authorised append. */
export interface AppendNotePlan extends WriteOutcomeFlags {
  readonly operation: "append";
  readonly id: string;
  readonly fragmentBytes: number;
  readonly expectedRevision: NotesnookRevisionToken;
  /** Resolved list-intent the codec uses for this append. */
  readonly listKind: NotesnookListKind;
}

/** Bounded description of an authorised update. */
export interface UpdateNotePlan extends WriteOutcomeFlags {
  readonly operation: "update";
  readonly id: string;
  readonly patchFields: readonly NotesnookUpdatePatchField[];
  readonly expectedRevision: NotesnookRevisionToken;
  /**
   * Resolved list-intent the codec uses for the `content` half of an
   * update patch, when present.  Undefined when the patch did not
   * include a content rewrite — the codec is only invoked for the
   * `content` field, and the field does not carry a listKind outside
   * of that context.
   */
  readonly listKind?: NotesnookListKind;
  /**
   * The exact native stored-content envelope the adapter must write for
   * a `storedContent` patch.  Present only when the patch supplied one;
   * the adapter writes it verbatim and never consults the Markdown
   * codec.
   */
  readonly storedContent?: NotesnookStoredContentPatch;
}

/** Bounded description of an authorised single-note delete. */
export interface DeleteNotePlan extends WriteOutcomeFlags {
  readonly operation: "delete";
  readonly id: string;
  readonly expectedRevision: NotesnookRevisionToken;
}

const PENDING: WriteOutcomeFlags = Object.freeze({
  localCommitted: false as const,
  remoteSynced: false as const,
  pendingSync: true as const,
});

// ---------------------------------------------------------------------------
// Validation helpers.
//
// Every helper defends against revoked/hostile proxies and throwing
// accessors.  `Array.isArray`, property access, regex test, and iteration
// all flow through a normalised reader that rewrites any attacker throw
// to a categorical `invalid_input` so no foreign Error escapes.
// ---------------------------------------------------------------------------

/**
 * Wrap a predicate so that a throwing accessor (hostile proxy, revoked
 * proxy, throwing getter) is rewritten to a categorical `invalid_input`.
 * The `what` label is used only to construct a fixed message; the
 * caller's value is never echoed.
 */
function safePredicate(predicate: () => boolean, what: string): boolean {
  let result: boolean;
  try {
    result = predicate();
  } catch {
    fail("invalid_input", what);
  }
  return result;
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  // `Array.isArray` itself throws on a revoked Proxy — wrap it.  A
  // hostile Proxy whose `get` traps throw is fine because V8's IsArray
  // does not consult the `get` trap, but we still guard the `typeof`
  // check defensively in case a future runtime diverges.
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail("invalid_input", `${what} must be an object`);
  }
  if (!value || typeof value !== "object" || isArray) {
    fail("invalid_input", `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireId(value: unknown): string {
  // Read the value defensively: hostile `Symbol.match` traps can throw
  // inside `String.prototype.match`-driven regex tests.  The reader
  // rewrites any throw to `invalid_input`.
  if (typeof value !== "string") {
    fail("invalid_input", "note or notebook id is invalid");
  }
  if (!safePredicate(() => value.trim().length > 0, "note or notebook id is invalid")) {
    fail("invalid_input", "note or notebook id is invalid");
  }
  if (
    !safePredicate(
      () => value.length <= STAGE4_WRITE_LIMITS.maxIdLength && /^[A-Za-z0-9_-]+$/.test(value),
      "note or notebook id is invalid",
    )
  ) {
    fail("invalid_input", "note or notebook id is invalid");
  }
  return value;
}

function requireTitle(value: unknown): string {
  if (typeof value !== "string") {
    fail("invalid_input", "title must be a non-empty string");
  }
  if (!safePredicate(() => value.trim().length > 0, "title must be a non-empty string")) {
    fail("invalid_input", "title must be a non-empty string");
  }
  if (
    !safePredicate(
      () => value.length <= STAGE4_WRITE_LIMITS.maxTitleLength,
      "title exceeds the bounded length limit",
    )
  ) {
    fail("invalid_input", "title exceeds the bounded length limit");
  }
  if (
    !safePredicate(
      () => !containsControlCharacters(value),
      "title contains unsupported control characters",
    )
  ) {
    fail("unsupported_content", "title contains unsupported control characters");
  }
  return value;
}

function readIteratorStep(iterator: Iterator<unknown>): IteratorResult<unknown> {
  // `next()` may throw (revoked/hostile Proxy).  The returned step's
  // `done` and `value` are also attacker-controlled — wrap them too so
  // a throwing getter on the step object cannot smuggle a canary past
  // the boundary.
  let step: IteratorResult<unknown>;
  try {
    step = iterator.next();
  } catch {
    fail("invalid_input", "tags must be an array of strings");
  }
  let done: boolean | undefined;
  try {
    done = (step as { done?: unknown }).done as boolean | undefined;
  } catch {
    fail("invalid_input", "tags must be an array of strings");
  }
  if (done === true) return { done: true, value: undefined };
  let value: unknown;
  try {
    value = (step as { value?: unknown }).value;
  } catch {
    fail("invalid_input", "tags must be an array of strings");
  }
  return { done: false, value };
}

function requireTags(value: unknown): readonly string[] {
  // `Array.isArray` throws on a revoked Proxy; `value.length` may fire
  // a hostile getter; `for...of` invokes the iterator trap.  Wrap all
  // three sites defensively, and the iterator step accessors, so no
  // throwing site can leak a canary past the categorical boundary.
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail("invalid_input", "tags must be an array of strings");
  }
  if (!isArray) {
    fail("invalid_input", "tags must be an array of strings");
  }
  const array = value as unknown as {
    readonly length: number;
    [Symbol.iterator](): Iterator<unknown>;
  };
  let length: number;
  try {
    length = array.length;
  } catch {
    fail("invalid_input", "tags must be an array of strings");
  }
  // Reported-length check: catches the *honest* over-large array first,
  // so a normal caller never has to wait for iteration to fail.  The
  // per-entry check below is the trust boundary against a hostile Proxy
  // whose reported length is smaller than the iterator yield count.
  if (length > STAGE4_WRITE_LIMITS.maxTags) {
    fail("invalid_input", "tags exceed the bounded count limit");
  }
  let iterator: Iterator<unknown>;
  try {
    iterator = array[Symbol.iterator]();
  } catch {
    fail("invalid_input", "tags must be an array of strings");
  }
  const tags: string[] = [];
  while (true) {
    const step = readIteratorStep(iterator);
    if (step.done === true) break;
    // Per-entry count guard: a hostile Proxy/iterator can lie about
    // `length` and yield arbitrarily many entries past `maxTags`.  We
    // refuse to accept entry `maxTags + 1` (1-indexed) — i.e. we fail
    // closed before pushing when we have already accepted `maxTags`.
    if (tags.length >= STAGE4_WRITE_LIMITS.maxTags) {
      fail("invalid_input", "tags exceed the bounded count limit");
    }
    const entry = step.value;
    if (
      typeof entry !== "string" ||
      !safePredicate(() => entry.trim().length > 0, "a tag entry is invalid") ||
      !safePredicate(
        () => entry.length <= STAGE4_WRITE_LIMITS.maxTagLength,
        "a tag entry is invalid",
      )
    ) {
      fail("invalid_input", "a tag entry is invalid");
    }
    if (
      !safePredicate(
        () => !containsControlCharacters(entry),
        "a tag entry contains unsupported control characters",
      )
    ) {
      fail("unsupported_content", "a tag entry contains unsupported control characters");
    }
    tags.push(entry);
  }
  return Object.freeze(tags);
}

/**
 * Resolve a `listKind` selector into the closed set.  `undefined`
 * collapses to the published default so existing call sites that
 * never set the selector see the same stored HTML shape.  Any non-
 * `undefined` value outside the closed set is rewritten to a
 * categorical `invalid_input` so the plan surface stays inside the
 * contract vocabulary.
 */
function requireListKind(value: unknown): NotesnookListKind {
  try {
    return normaliseNotesnookListKind(value);
  } catch {
    fail("invalid_input", "list kind is not supported");
  }
}

function containsControlCharacters(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

/**
 * Bounded Markdown-ish body check.
 *
 * Rejects non-strings, oversized bodies, control characters, and raw
 * HTML/script markup.  The rejected text is never echoed.  Every
 * accessor (`.length`, regex test, byte counting) flows through
 * `safePredicate` so a hostile/revoked string proxy is rewritten to a
 * categorical `invalid_input` without leaking the canary.
 */
function requireBoundedBody(value: unknown, maxBytes: number, what: string): number {
  if (typeof value !== "string") {
    fail("invalid_input", `${what} must be a non-empty string`);
  }
  if (!safePredicate(() => value.length > 0, `${what} must be a non-empty string`)) {
    fail("invalid_input", `${what} must be a non-empty string`);
  }
  let bytes: number;
  try {
    bytes = Buffer.byteLength(value, "utf8");
  } catch {
    fail("invalid_input", `${what} must be a non-empty string`);
  }
  if (bytes > maxBytes) {
    fail("unsupported_content", `${what} exceeds the bounded byte limit`);
  }
  if (
    !safePredicate(
      () => !containsControlCharacters(value),
      `${what} contains unsupported control characters`,
    )
  ) {
    fail("unsupported_content", `${what} contains unsupported control characters`);
  }
  if (
    !safePredicate(
      () => !/<\s*(script|style|iframe|object|embed)\b/i.test(value),
      `${what} contains unsupported embedded markup`,
    )
  ) {
    fail("unsupported_content", `${what} contains unsupported embedded markup`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Command validation ("plan") functions.
// ---------------------------------------------------------------------------

/**
 * Validate a `createNote` command and return its bounded plan.
 *
 * Performs no mutation: there is no vault handle in this module.
 */
export function planCreateNote(command: CreateNoteCommand): CreateNotePlan {
  const record = requireRecord(command, "create command");
  // Each property may carry a throwing getter or Proxy trap; the readers
  // normalise any attacker throw to categorical `invalid_input` without
  // echoing the throw site.  None of the canary-bearing throw payloads ever
  // reaches a message string.
  const title = requireTitle(readProperty(record, "title"));
  const contentBytes = requireBoundedBody(
    readProperty(record, "content"),
    STAGE4_WRITE_LIMITS.maxContentBytes,
    "content",
  );
  const notebookIdRaw = readProperty(record, "notebookId");
  const tagsRaw = readProperty(record, "tags");
  const listKindRaw = readProperty(record, "listKind");
  const notebookId = notebookIdRaw === undefined ? undefined : requireId(notebookIdRaw);
  const tags = tagsRaw === undefined ? undefined : requireTags(tagsRaw);
  // Resolve the listKind selector up front so any out-of-set value is
  // a categorical `invalid_input` (rather than silently selecting the
  // default).  `undefined` collapses to the published default so the
  // existing call sites that never set the selector see the same stored
  // HTML shape they saw before.  The selector throws a closed
  // `NotesnookListKindError`; we rewrite it to a contract error here so
  // the plan surface stays inside the categorical vocabulary.
  const listKind = requireListKind(listKindRaw);
  return Object.freeze({
    operation: "create" as const,
    title,
    contentBytes,
    ...(notebookId === undefined ? {} : { notebookId }),
    ...(tags === undefined ? {} : { tags }),
    listKind,
    ...PENDING,
  });
}

/**
 * Validate an `appendNote` command and return its bounded plan.
 *
 * The `expectedRevision` must be a well-formed opaque token; the actual
 * match is enforced by {@link assertRevisionMatch} immediately before a
 * future mutation, once a current revision can be observed.
 */
export function planAppendNote(command: AppendNoteCommand): AppendNotePlan {
  const record = requireRecord(command, "append command");
  // Each property may carry a throwing getter or Proxy trap; the readers
  // normalise any attacker throw to categorical `invalid_input` without
  // echoing the throw site.  None of the canary-bearing throw payloads ever
  // reaches a message string.
  const id = requireId(readProperty(record, "id"));
  const fragmentBytes = requireBoundedBody(
    readProperty(record, "markdownFragment"),
    STAGE4_WRITE_LIMITS.maxFragmentBytes,
    "markdown fragment",
  );
  const expectedRevision = requireRevisionToken(readProperty(record, "expectedRevision"));
  const listKindRaw = readProperty(record, "listKind");
  const listKind = requireListKind(listKindRaw);
  return Object.freeze({
    operation: "append" as const,
    id,
    fragmentBytes,
    expectedRevision,
    listKind,
    ...PENDING,
  });
}

/**
 * Validate an `updateNote` command and return its bounded plan.
 *
 * Only {@link ALLOWED_UPDATE_PATCH_FIELDS} may appear.  Any other key —
 * including `deleted`, `locked`, `password`, and `force` — fails closed
 * with `unsupported_patch_field` and is not echoed back.
 *
 * The `listKind` patch field carries the closed-set codec intent for
 * the `content` half of the patch.  It is only resolved when the patch
 * includes a `content` field — a `listKind`-only patch still passes
 * validation but the codec is never invoked, so the plan omits the
 * resolved kind rather than fabricating a content write.
 */
export function planUpdateNote(command: UpdateNoteCommand): UpdateNotePlan {
  const record = requireRecord(command, "update command");
  // Each property may carry a throwing getter or Proxy trap; the readers
  // normalise any attacker throw to categorical `invalid_input` without
  // echoing the throw site.  None of the canary-bearing throw payloads ever
  // reaches a message string.
  const id = requireId(readProperty(record, "id"));
  const patch = requireRecord(readProperty(record, "patch"), "update patch");
  const expectedRevision = requireRevisionToken(readProperty(record, "expectedRevision"));

  const keys = readOwnKeys(patch);
  if (keys.length === 0) {
    fail("invalid_input", "update patch must contain at least one allowed field");
  }
  for (const key of keys) {
    if (!ALLOWED_UPDATE_PATCH_FIELDS.has(key as NotesnookUpdatePatchField)) {
      fail("unsupported_patch_field", "update patch contains an unsupported field");
    }
  }

  const fields: NotesnookUpdatePatchField[] = [];
  let patchListKind: NotesnookListKind | undefined;
  let patchStoredContent: NotesnookStoredContentPatch | undefined;
  let patchHasMarkdownContent = false;
  for (const key of keys as NotesnookUpdatePatchField[]) {
    const value = readProperty(patch, key);
    switch (key) {
      case "title":
        requireTitle(value);
        break;
      case "content":
        requireBoundedBody(value, STAGE4_WRITE_LIMITS.maxContentBytes, "content");
        patchHasMarkdownContent = true;
        break;
      case "storedContent":
        patchStoredContent = requireStoredContentPatch(value);
        // A native write is a content write: the plan reports it on the
        // `content` channel so downstream consumers see one vocabulary.
        fields.push("content" as NotesnookUpdatePatchField);
        continue;
      case "notebookId":
        requireId(value);
        break;
      case "tags":
        requireTags(value);
        break;
      case "pinned":
      case "favorite":
        if (typeof value !== "boolean") {
          fail("invalid_input", "a boolean patch field has a non-boolean value");
        }
        break;
      case "listKind":
        // Resolve up-front so an out-of-set value is a categorical
        // `invalid_input` rather than a silent coercion.  The resolved
        // kind is only surfaced on the plan when the patch also carries
        // a `content` field — see the `patchHasMarkdownContent` flag below.
        patchListKind = requireListKind(value);
        break;
    }
    fields.push(key);
  }
  // One content channel per patch.  A native envelope and a Markdown
  // body (or a list-intent selector, which only means anything for
  // Markdown) cannot both be present.
  if (
    patchStoredContent !== undefined &&
    (patchHasMarkdownContent || patchListKind !== undefined)
  ) {
    fail("unsupported_patch_field", "update patch mixes a native envelope with Markdown content");
  }
  const listKind = patchHasMarkdownContent
    ? (patchListKind ?? DEFAULT_NOTESNOOK_LIST_KIND)
    : undefined;

  return Object.freeze({
    operation: "update" as const,
    id,
    patchFields: Object.freeze([...fields].sort()),
    expectedRevision,
    ...(listKind === undefined ? {} : { listKind }),
    ...(patchStoredContent === undefined ? {} : { storedContent: patchStoredContent }),
    ...PENDING,
  });
}

/**
 * Validate a closed native stored-content envelope.
 *
 * Exactly `{type, data}` is admitted: `type` must be one of the two
 * stored kinds the pinned runtime understands, and `data` must be a
 * bounded UTF-8 string.  Any extra key — including a note id or a
 * `locked` flag smuggled alongside the body — fails closed without
 * echoing the offending key.
 */
function requireStoredContentPatch(value: unknown): NotesnookStoredContentPatch {
  const record = requireRecord(value, "stored content");
  const keys = readOwnKeys(record);
  if (keys.length !== 2 || !keys.includes("type") || !keys.includes("data")) {
    fail("unsupported_patch_field", "stored content has unexpected fields");
  }
  const type = readProperty(record, "type");
  if (type !== "tiptap" && type !== "html") {
    fail("invalid_input", "stored content type is outside the closed set");
  }
  const data = readProperty(record, "data");
  if (typeof data !== "string") {
    fail("invalid_input", "stored content data must be a string");
  }
  if (Buffer.byteLength(data, "utf8") > STAGE4_WRITE_LIMITS.maxContentBytes) {
    fail("invalid_input", "stored content exceeds the bounded byte limit");
  }
  return Object.freeze({ type, data });
}

/**
 * Validate a revision-guarded single-note delete.  The command is
 * intentionally closed to exactly `{ id, expectedRevision }`; force,
 * bulk identifiers, and every other upstream option are rejected.
 */
export function planDeleteNote(command: DeleteNoteCommand): DeleteNotePlan {
  const record = requireRecord(command, "delete command");
  const keys = readOwnKeys(record);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("expectedRevision")) {
    fail("invalid_input", "delete command contains unsupported fields");
  }
  const id = requireId(readProperty(record, "id"));
  const expectedRevision = requireRevisionToken(readProperty(record, "expectedRevision"));
  return Object.freeze({
    operation: "delete" as const,
    id,
    expectedRevision,
    ...PENDING,
  });
}
