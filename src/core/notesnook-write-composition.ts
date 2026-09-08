/**
 * Stage 4 — narrow local-write composition seam.
 *
 * This module implements exactly one bounded slice of
 * `docs/stage-4-write-plan.md`: it composes the already-merged local
 * mutation adapter with the already-merged metadata-only
 * `SyncCoordinator` so that a *successful local write* is recorded as
 * pending synchronization metadata before the composition returns.
 *
 * What it does
 * ------------
 *
 *   - exposes exactly three local mutation methods — `createNote`,
 *     `appendNote`, `updateNote` — each of which awaits the injected
 *     adapter operation, validates and copies only the bounded local
 *     result shape, hands a *fresh* metadata receipt
 *     `{operation, id, localCommitted, remoteSynced, pendingSync}` to
 *     `coordinator.recordLocalCommit`, and then returns a fresh frozen
 *     bounded local result;
 *   - exposes remote execution and queue inspection ONLY as the
 *     separate, explicit `requestSync()` and `pendingSnapshot()`
 *     methods.
 *
 * What it deliberately does not do
 * --------------------------------
 *
 *   - It never runs remote synchronization as part of a local write.
 *     A local commit is reported as `localCommitted: true`,
 *     `remoteSynced: false`, `pendingSync: true` and nothing else; the
 *     separation between local commit and remote sync is the whole
 *     point of the slice.
 *   - It imports nothing from `@notesnook/*` and holds no `Database`,
 *     collection, transport, network, credential, Vault, keystore, or
 *     storage handle.  The injected adapter and coordinator handles are
 *     held in a module-private `WeakMap` and are never exposed, echoed,
 *     or reachable from the public surface.
 *   - It publishes no generic passthrough (`invoke`, `call`, `execute`,
 *     `database`, `db`, `raw`), no `sync`/`send`/`full`, no delete, no
 *     force overwrite, no Vault unlock, no read-only projection
 *     capability, and no widening of `NotesnookReadOnlyDatabase`.
 *   - It caches no note body.  Only the adapter's bounded metadata
 *     fields (operation, id, byte counts, applied patch field names)
 *     are copied; every other field on an injected result — including
 *     `body`, `content`, `data`, or a credential canary — is dropped.
 *
 * Redaction
 * ---------
 *
 * Every failure is a categorical, chain-free error built from the
 * closed {@link NotesnookWriteErrorCode} table published by the write
 * contract.  Adapter and coordinator categorical codes are *preserved*
 * by rebuilding a fresh error from the code alone, so a mutated
 * `message`, a populated `cause`, or an attacker-controlled `stack` on
 * the original throw cannot cross this boundary.  Foreign throws are
 * normalised to `sync_failed`; nothing observed from the injected seam
 * is interpolated into a message.
 *
 * Closure hygiene
 * ---------------
 *
 * Public outputs (relayed create/append/update results, receipts,
 * pending-marker copies, coordinator results, snapshots) are
 * constructed as null-prototype objects and *then* frozen, so a frozen
 * output cannot accidentally expose `Object.prototype` methods, cannot
 * be used as a constructor, and cannot route a hostile
 * `constructor.constructor` lookup to `Function`.  Inherited class
 * methods on the *real* `NotesnookWriteAdapter` and `SyncCoordinator`
 * keep working because handle methods are still read off the live
 * prototype (see {@link readOwnMethod}); only the composition's
 * *output* objects are sealed against prototype-chain tricks.
 *
 * Inherited-field enforcement
 * ---------------------------
 *
 * Every required field on a result / receipt / marker is read through
 * {@link readOwnProperty}, which only accepts own enumerable string-keyed
 * data properties.  Inherited class fields on a real
 * `NotesnookWriteAdapter` result are *not* sufficient — the adapter must
 * expose them as own data, and a malicious object with a class
 * prototype that adds the field is rejected.  Index-keyed array reads
 * go through {@link readOwnIndex} so a hostile array whose indexed
 * elements live only on a Proxy prototype is also rejected.  This keeps
 * the contract "what the adapter hands us must be the surface we relay"
 * even against Proxy/Object.setPrototypeOf tricks.
 */

import {
  ALLOWED_UPDATE_PATCH_FIELDS,
  NotesnookWriteContractError,
  STAGE4_WRITE_LIMITS,
  isNotesnookWriteContractError,
  type AppendNoteCommand,
  type CreateNoteCommand,
  type NotesnookUpdatePatchField,
  type NotesnookWriteErrorCode,
  type UpdateNoteCommand,
} from "./notesnook-write-contract.js";
import {
  isNotesnookWriteAdapterError,
  type AppendNoteResult,
  type CreateNoteResult,
  type UpdateNoteResult,
} from "./notesnook-write-adapter.js";
import type {
  SyncCoordinatorResult,
  SyncCoordinatorState,
  SyncLocalCommit,
  SyncLocalCommitResult,
  SyncOperation,
  SyncPendingMarker,
} from "./notesnook-sync-coordinator.js";
import { withMutex } from "./notesnook-database-mutex.js";

// ---------------------------------------------------------------------------
// Bounds.
//
// The composition never recomputes a byte count or re-derives a note id;
// it only refuses to relay an unbounded or malformed one.  The limits
// below are derived from the published contract limits so this module
// cannot drift away from the adapter it composes.
// ---------------------------------------------------------------------------

/** Largest byte count the composition will relay for a body/fragment. */
const MAX_RESULT_CONTENT_BYTES = STAGE4_WRITE_LIMITS.maxContentBytes;

/** Largest byte count the composition will relay for a title (UTF-8 ≤ 4 B/char). */
const MAX_RESULT_TITLE_BYTES = STAGE4_WRITE_LIMITS.maxTitleLength * 4;

/** Largest number of allowed patch fields an update result may report. */
const MAX_RESULT_PATCH_FIELDS = 6;

/**
 * Largest pending-marker count the composition will relay from a
 * snapshot.  This mirrors the coordinator's own published bound; the
 * coordinator does not export the constant and this slice must not
 * modify it, so the value is restated here with an explicit comment.
 */
const MAX_PENDING_MARKERS = 64;

/**
 * Largest `attempts` value the composition will relay from a
 * coordinator result.  The coordinator's own `maxAttempts` is bounded
 * to 8 (see `notesnook-sync-coordinator.ts`), so anything beyond that
 * is either fabricated by a hostile coordinator stand-in or escapes
 * the coordinator's published bound — either way, fail closed.
 */
const MAX_RESULT_ATTEMPTS = 8;

// ---------------------------------------------------------------------------
// Injected handles.
//
// Both handles are *structural* and separately named.  The concrete
// `NotesnookWriteAdapter` and `SyncCoordinator` classes already satisfy
// them, so production wiring passes the real objects unchanged and this
// module needs no change to either published type.
// ---------------------------------------------------------------------------

/** The only local mutation capability the composition may consume. */
export interface NotesnookLocalWriteHandle {
  readonly createNote: (command: CreateNoteCommand) => Promise<CreateNoteResult>;
  readonly appendNote: (command: AppendNoteCommand) => Promise<AppendNoteResult>;
  readonly updateNote: (command: UpdateNoteCommand) => Promise<UpdateNoteResult>;
}

/** The only pending-synchronization capability the composition may consume. */
export interface NotesnookPendingSyncHandle {
  readonly recordLocalCommit: (receipt: SyncLocalCommit) => SyncLocalCommitResult;
  readonly requestSync: () => Promise<SyncCoordinatorResult>;
  readonly snapshot: () => SyncCoordinatorState;
  /** Optional on legacy test seams; production coordinators provide it. */
  readonly checkCapacity?: () => unknown;
}

/** Construction options.  Both handles are required and separate. */
export interface NotesnookLocalWriteCompositionOptions {
  readonly adapter: NotesnookLocalWriteHandle;
  readonly coordinator: NotesnookPendingSyncHandle;
  /**
   * Optional database identity used for per-database serialization
   * (P1-1).  When provided, every public method acquires a per-Database
   * mutex before executing.  When omitted, the composition relies on its
   * legacy per-instance `localDepth` counter for reentrancy guards and
   * does not coordinate across distinct composition instances — that
   * is the legacy seam preserved for tests and injected fakes.
   */
  readonly database?: object;
}

/** The union of bounded local results the composition can return. */
export type NotesnookLocalWriteResult = CreateNoteResult | AppendNoteResult | UpdateNoteResult;

// ---------------------------------------------------------------------------
// Categorical errors.
// ---------------------------------------------------------------------------

const COMPOSITION_ERRORS = new WeakSet<object>();

const COMPOSITION_ERROR_CODES: ReadonlyArray<NotesnookWriteErrorCode> = Object.freeze([
  "invalid_input",
  "unsupported_content",
  "unsupported_patch_field",
  "stale_revision",
  "conflict",
  "vault_locked",
  "sync_failed",
]);

/**
 * Build a categorical, chain-free composition error.
 *
 * The message is fixed by the contract's closed code table; `cause` and
 * `__context__` are cleared so no injected payload can ride along.
 */
function compositionError(code: NotesnookWriteErrorCode): NotesnookWriteContractError {
  const error = new NotesnookWriteContractError(code);
  Object.defineProperty(error, "name", {
    configurable: true,
    value: "NotesnookWriteCompositionError",
  });
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  COMPOSITION_ERRORS.add(error);
  return error;
}

function fail(code: NotesnookWriteErrorCode): never {
  throw compositionError(code);
}

/**
 * Identity predicate for errors emitted by this module.
 *
 * Recognition is by object identity only, so a look-alike with the right
 * `name`/`code` is rejected.  Every composition error is also a
 * {@link NotesnookWriteContractError}, so existing callers that branch on
 * `isNotesnookWriteContractError` keep working unchanged.
 */
export function isNotesnookWriteCompositionError(
  value: unknown,
): value is NotesnookWriteContractError {
  return typeof value === "object" && value !== null && COMPOSITION_ERRORS.has(value);
}

/**
 * Rebuild a categorical error from an injected throw.
 *
 * A recognised adapter/contract error contributes ONLY its `code`; the
 * observed object's message, cause, context, and stack are discarded,
 * because `Error.prototype.message` is writable and a caller that owns
 * the injected adapter could otherwise smuggle a canary through a
 * genuine categorical error.  Anything else — including a foreign
 * `Error`, a thrown string, or a hostile Proxy — becomes `sync_failed`.
 */
function normaliseThrow(error: unknown): NotesnookWriteContractError {
  if (isNotesnookWriteCompositionError(error)) {
    // Already ours: re-issue from the validated code so identity and
    // message stay under this module's control.
    return compositionError(readCategoricalCode(error) ?? "sync_failed");
  }
  if (isNotesnookWriteAdapterError(error) || isNotesnookWriteContractError(error)) {
    return compositionError(readCategoricalCode(error) ?? "sync_failed");
  }
  return compositionError("sync_failed");
}

function readCategoricalCode(error: unknown): NotesnookWriteErrorCode | undefined {
  // Read the code through the *own* property descriptor so a hostile
  // object that hides a forged `code` on a custom prototype cannot
  // smuggle a recognised code past this boundary.  The contract error
  // has `code` defined as own, so this also accepts the genuine case.
  let code: unknown;
  try {
    code = readOwnProperty(error as object, "code");
  } catch {
    return undefined;
  }
  if (typeof code !== "string") return undefined;
  return COMPOSITION_ERROR_CODES.includes(code as NotesnookWriteErrorCode)
    ? (code as NotesnookWriteErrorCode)
    : undefined;
}

// ---------------------------------------------------------------------------
// Hostile-input readers.
//
// Every injected object may be a Proxy with throwing traps or carry
// throwing accessors.  All reads flow through these guarded readers so
// an attacker throw is rewritten to a categorical failure and never
// observed, stored, or re-emitted.
//
// Two additional protections live here:
//
//   1. `readOwnProperty` and `readOwnIndex` only accept own string-keyed
//      enumerable descriptors.  Inherited class fields, prototype-
//      chain fields, or Proxy traps that lie about ownership are
//      rejected with `invalid_input`.  Own accessors are invoked once
//      through their descriptor getter.  This blocks the
//      "result-with-inherited-required-fields" attack where a Proxy
//      exposes `operation` / `localCommitted` only on its prototype.
//
//   2. `readOwnMethod` reads a method through its own descriptor so a
//      hostile object whose required slot is implemented as a
//      stateful getter that swaps itself out between validation and
//      capture cannot smuggle a different callable into the captured
//      state.  When the descriptor is a getter, it is invoked exactly
//      once and the result is bound.
// ---------------------------------------------------------------------------

type UnknownFunction = (...args: readonly unknown[]) => unknown;

function readProperty(record: object, key: string): unknown {
  try {
    return Reflect.get(record, key, record);
  } catch {
    fail("invalid_input");
  }
}

/**
 * Read an *own*, enumerable, string-keyed data property.
 *
 * A throwing `getOwnPropertyDescriptor` trap, an inherited property,
 * a Symbol key, or an accessor without a getter is rejected.  Inherited
 * class fields, prototype-chain fields, or Proxy traps that lie about
 * ownership are rejected with `invalid_input`.  Legitimate own accessors
 * are invoked exactly once through their descriptor getter; inherited
 * accessors do not satisfy the own-field requirement.
 */
function readOwnProperty(record: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(record, key);
  } catch {
    fail("invalid_input");
  }
  if (!descriptor) fail("invalid_input");
  if (Object.prototype.hasOwnProperty.call(descriptor, "value")) return descriptor.value;
  const getter = descriptor.get;
  if (typeof getter !== "function") fail("invalid_input");
  try {
    return Reflect.apply(getter, record, []);
  } catch {
    fail("invalid_input");
  }
}

function hasOwnProperty(record: object, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(record, key);
  } catch {
    fail("invalid_input");
  }
}

function hasProperty(record: object, key: string): boolean {
  try {
    return Reflect.has(record, key);
  } catch {
    fail("invalid_input");
  }
}

/**
 * Resolve a single required handle method exactly once.
 *
 * The value is read by walking the prototype chain so a real
 * `NotesnookWriteAdapter` or `SyncCoordinator` class still works (their
 * methods live on the prototype, not as own data), but the resolved
 * callable is captured into local state and re-checked here.  Any
 * throwing accessor becomes `invalid_input`; a non-callable, a thenable
 * masquerading as a function, or a getter that returns a non-function
 * is refused.
 */
function readOwnMethod(record: object, slot: string): UnknownFunction {
  let value: unknown;
  try {
    value = Reflect.get(record, slot, record);
  } catch {
    fail("invalid_input");
  }
  if (typeof value !== "function") fail("invalid_input");
  return value as UnknownFunction;
}

function requireRecord(value: unknown): Record<string, unknown> {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail("invalid_input");
  }
  if (value === null || typeof value !== "object" || isArray) {
    fail("invalid_input");
  }
  // Class instances (`NotesnookWriteAdapter`, `SyncCoordinator`) are
  // legitimately accepted here.  The "inherited fields" rule from
  // finding #2 is enforced on the *required fields*, not on the
  // record itself: every required field is read through
  // `readOwnProperty`, which only accepts own string-keyed data
  // descriptors.  An object whose prototype carries the required
  // fields is rejected at field-read time, not here.
  return value as Record<string, unknown>;
}

function requireArray(value: unknown): readonly unknown[] {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    fail("invalid_input");
  }
  if (!isArray) fail("invalid_input");
  // Indexed entries must be on a real Array; a Proxy that returns its
  // indexed values from a custom prototype is rejected by
  // `readOwnIndex`.  The prototype check here is a cheap first pass;
  // the per-index own-descriptor check is the actual trust boundary.
  const array = value as readonly unknown[];
  let proto: object | null;
  try {
    proto = Reflect.getPrototypeOf(array as object);
  } catch {
    fail("invalid_input");
  }
  if (proto !== Array.prototype) fail("invalid_input");
  return array;
}

/**
 * Read an indexed array slot through its OWN descriptor.
 *
 * A hostile array Proxy can pretend its indexed entries exist on a
 * custom prototype or can yield them from a `get` trap even though the
 * own descriptor is absent.  We require the descriptor to be an own,
 * enumerable, configurable:false, writable:true data descriptor with a
 * defined value slot — the strict shape of a real array slot.  Frozen
 * arrays (used by `Object.freeze`) drop `writable` and `configurable`,
 * so the descriptor is still a data descriptor with a `value` slot and
 * the read succeeds; we only reject non-data descriptors and indexed
 * lookups that resolve through the prototype chain.
 */
function readOwnIndex(values: readonly unknown[], index: number): unknown {
  const key = String(index);
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(values as unknown as object, key);
  } catch {
    fail("invalid_input");
  }
  if (!descriptor) fail("invalid_input");
  if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) fail("invalid_input");
  try {
    return descriptor.value;
  } catch {
    fail("invalid_input");
  }
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return true;
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Strict identifier rule for note ids relayed out of the adapter or
 * coordinator.  Same charset the contract enforces for command ids —
 * ASCII letters, digits, underscore, hyphen — but applied to the
 * *result* and *marker* ids as well so a coordinator that hands us a
 * space, a leading/trailing/embedded Unicode whitespace, or a
 * control character cannot ride through the composition.  Length is
 * checked before the regex to keep the failure mode consistent and
 * to bound the regex work on an attacker-controlled string.
 */
const STRICT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Bound a note id relayed out of the adapter or coordinator.
 *
 * Required: own string-keyed data property whose value is a non-empty
 * ASCII identifier no longer than `STAGE4_WRITE_LIMITS.maxIdLength`.
 * The strict charset blocks leading/trailing/embedded spaces, embedded
 * Unicode whitespace (NBSP, ZWSP, etc.), and control characters — all
 * of which the upstream marker validator accepted because its check
 * was only `length > 0 && length <= MAX && !includes("\u0000")`.
 */
function requireNoteId(record: object, key: string): string {
  if (!hasOwnProperty(record, key)) fail("invalid_input");
  const value = readOwnProperty(record, key);
  if (typeof value !== "string") fail("invalid_input");
  let length: number;
  try {
    length = value.length;
  } catch {
    fail("invalid_input");
  }
  if (length === 0 || length > STAGE4_WRITE_LIMITS.maxIdLength) fail("invalid_input");
  let matched: boolean;
  try {
    matched = STRICT_ID_PATTERN.test(value);
  } catch {
    fail("invalid_input");
  }
  if (!matched) fail("invalid_input");
  try {
    if (CONTROL_CHARACTERS.test(value)) fail("invalid_input");
  } catch {
    fail("invalid_input");
  }
  return value;
}

function requireByteCount(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail("invalid_input");
  }
  return value;
}

function isSyncOperation(value: unknown): value is SyncOperation {
  return value === "create" || value === "append" || value === "update";
}

// ---------------------------------------------------------------------------
// Injected-handle validation.
// ---------------------------------------------------------------------------

/**
 * Names that must be absent from an injected handle.
 *
 * A handle that exposes any of these is refused at construction: the
 * composition must not be able to reach a raw database, a generic
 * passthrough, a transport/credential/Vault capability, or the Stage 3
 * read-only projection through the object it was handed.
 */
const FORBIDDEN_HANDLE_NAMES: ReadonlyArray<string> = Object.freeze([
  // Sync/remote widening.
  "sync",
  "send",
  "full",
  "fetch",
  "setLastSynced",
  "connectSSE",
  "disconnectSSE",
  // Destructive / force capability.
  "delete",
  "remove",
  "removeMulti",
  "moveToTrash",
  "restore",
  "force",
  "clear",
  "reset",
  // Raw handles and generic passthrough.
  "database",
  "db",
  "raw",
  "collection",
  "notes",
  "content",
  "notebooks",
  "tags",
  "relations",
  "invoke",
  "call",
  "apply",
  "exec",
  "execute",
  "run",
  "passthrough",
  // Transport / credential / Vault.
  "transport",
  "network",
  "request",
  "http",
  "credentials",
  "token",
  "password",
  "keystore",
  "vault",
  "vaultUnlock",
  "vaultLock",
  "unlock",
  "login",
  "logout",
  "user",
  // Stage 3 read-only projection surface.
  "listNotebooks",
  "noteMetadata",
  "search",
  "status",
  "lastSynced",
  "hasUnsyncedChanges",
]);

/**
 * Validate an injected handle and capture each required method exactly
 * once.
 *
 * Each required slot is resolved through `readOwnMethod` (which walks
 * the prototype chain to support real class instances) so a stateful
 * getter that swaps itself between validation and capture cannot
 * hand us a different callable than the one we checked.
 */
interface CapturedHandle {
  readonly target: object;
  readonly methods: Readonly<Record<string, UnknownFunction>>;
}

function requireHandle(value: unknown, slots: ReadonlyArray<string>): CapturedHandle {
  const record = requireRecord(value);
  const methods = Object.create(null) as Record<string, UnknownFunction>;
  for (const slot of slots) {
    // Validate slot presence and callability first.  Capture the
    // callable into a local binding so a hostile getter that returns
    // `fn` during validation and a different `fn2` during capture
    // cannot succeed — the captured value is what the composition
    // will actually invoke.
    Object.defineProperty(methods, slot, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: readOwnMethod(record, slot),
    });
  }
  for (const name of FORBIDDEN_HANDLE_NAMES) {
    if (hasProperty(record, name) && readProperty(record, name) !== undefined) {
      fail("invalid_input");
    }
  }
  return Object.freeze({ target: record, methods: Object.freeze(methods) });
}

function capturedMethod(
  methods: Readonly<Record<string, UnknownFunction>>,
  slot: string,
): UnknownFunction {
  const method = methods[slot];
  if (method === undefined) fail("invalid_input");
  return method;
}

// ---------------------------------------------------------------------------
// Private state.
//
// The adapter and coordinator handles live in a module-private WeakMap
// keyed by the composition instance, so they are not own properties, are
// not enumerable, are not reachable through the public surface, and are
// not exposed by `Object.getOwnPropertyNames`.  A detached or hostile
// receiver resolves to no state and fails closed categorically instead of
// raising a raw `TypeError`.
//
// A per-instance reentrancy depth counter in the same WeakMap entry is
// incremented while a local operation is in flight.  It is decremented
// in a `finally`, so a thrown adapter/queue failure cannot leave it
// stuck.  While the depth is nonzero, `requestSync()` fails categorically
// rather than invoking the coordinator's executor — this stops a
// hostile adapter from calling `composition.requestSync()` from inside
// `createNote`/`appendNote`/`updateNote` and triggering a remote drain
// during a local write.
// ---------------------------------------------------------------------------

interface CompositionState {
  readonly adapterTarget: object;
  readonly createNote: UnknownFunction;
  readonly appendNote: UnknownFunction;
  readonly updateNote: UnknownFunction;
  readonly coordinatorTarget: object;
  readonly recordLocalCommit: UnknownFunction;
  readonly requestSync: UnknownFunction;
  readonly snapshot: UnknownFunction;
  readonly checkCapacity: UnknownFunction | undefined;
  readonly database: object | undefined;
  localDepth: number;
}

const STATE = new WeakMap<object, CompositionState>();

function requireState(instance: unknown): CompositionState {
  if (typeof instance !== "object" || instance === null) fail("invalid_input");
  const state = STATE.get(instance);
  if (state === undefined) fail("invalid_input");
  return state;
}

function buildState(options: unknown): CompositionState {
  const record = requireRecord(options);
  const adapter = requireHandle(readProperty(record, "adapter"), [
    "createNote",
    "appendNote",
    "updateNote",
  ]);
  const coordinator = requireHandle(readProperty(record, "coordinator"), [
    "recordLocalCommit",
    "requestSync",
    "snapshot",
  ]);
  if (adapter.target === coordinator.target) {
    // A single object satisfying both roles would fuse the local-write
    // and remote-sync boundaries this slice exists to keep apart.
    fail("invalid_input");
  }
  const databaseValue = readProperty(record, "database");
  const database: object | undefined =
    databaseValue === undefined
      ? undefined
      : typeof databaseValue === "object" && databaseValue !== null
        ? databaseValue
        : (fail("invalid_input"), undefined);
  return {
    adapterTarget: adapter.target,
    createNote: capturedMethod(adapter.methods, "createNote"),
    appendNote: capturedMethod(adapter.methods, "appendNote"),
    updateNote: capturedMethod(adapter.methods, "updateNote"),
    coordinatorTarget: coordinator.target,
    recordLocalCommit: capturedMethod(coordinator.methods, "recordLocalCommit"),
    requestSync: capturedMethod(coordinator.methods, "requestSync"),
    snapshot: capturedMethod(coordinator.methods, "snapshot"),
    checkCapacity: hasProperty(coordinator.target, "checkCapacity")
      ? readOwnMethod(coordinator.target, "checkCapacity")
      : undefined,
    database,
    localDepth: 0,
  };
}

// ---------------------------------------------------------------------------
// Bounded local-result copying.
//
// The composition copies ONLY the published bounded fields.  Any extra
// field on an injected result — `body`, `content`, `data`, a credential,
// a canary, an upstream record — is dropped rather than relayed, and the
// outcome flags are re-asserted from literals so a hostile adapter can
// never have its `remoteSynced: true` claim echoed.
// ---------------------------------------------------------------------------

function requireLocalReceipt(
  operation: SyncOperation,
  raw: Record<string, unknown>,
): { readonly id: string } {
  // `operation`, the three outcome flags, and `id` must all be own,
  // string-keyed data properties.  Inherited class fields are not
  // sufficient: a Proxy whose prototype carries the required fields
  // must not satisfy the receipt contract.
  if (readOwnProperty(raw, "operation") !== operation) fail("invalid_input");
  if (readOwnProperty(raw, "localCommitted") !== true) fail("invalid_input");
  if (readOwnProperty(raw, "remoteSynced") !== false) fail("invalid_input");
  if (readOwnProperty(raw, "pendingSync") !== true) fail("invalid_input");
  return { id: requireNoteId(raw, "id") };
}

function copyCreateResult(raw: unknown): CreateNoteResult {
  const record = requireRecord(raw);
  const { id } = requireLocalReceipt("create", record);
  return freezeSealed({
    operation: "create" as const,
    id,
    titleBytes: requireByteCount(readOwnProperty(record, "titleBytes"), MAX_RESULT_TITLE_BYTES),
    contentBytes: requireByteCount(
      readOwnProperty(record, "contentBytes"),
      MAX_RESULT_CONTENT_BYTES,
    ),
    localCommitted: true as const,
    remoteSynced: false as const,
    pendingSync: true as const,
  }) as unknown as CreateNoteResult;
}

function copyAppendResult(raw: unknown): AppendNoteResult {
  const record = requireRecord(raw);
  const { id } = requireLocalReceipt("append", record);
  return freezeSealed({
    operation: "append" as const,
    id,
    contentBytes: requireByteCount(
      readOwnProperty(record, "contentBytes"),
      MAX_RESULT_CONTENT_BYTES,
    ),
    localCommitted: true as const,
    remoteSynced: false as const,
    pendingSync: true as const,
  }) as unknown as AppendNoteResult;
}

function copyUpdateResult(raw: unknown): UpdateNoteResult {
  const record = requireRecord(raw);
  const { id } = requireLocalReceipt("update", record);
  const appliedFields = copyAppliedFields(readOwnProperty(record, "appliedFields"));
  // `contentBytes` is optional on an update result; it must be absent
  // or an own data property with a bounded byte count.  An inherited
  // or accessor-presented `contentBytes` is refused.
  const contentBytesDescriptor = (() => {
    try {
      return Reflect.getOwnPropertyDescriptor(record, "contentBytes");
    } catch {
      fail("invalid_input");
    }
  })();
  const base = freezeSealed({
    operation: "update" as const,
    id,
    appliedFields,
    localCommitted: true as const,
    remoteSynced: false as const,
    pendingSync: true as const,
  }) as unknown as UpdateNoteResult;
  if (contentBytesDescriptor === undefined) return base;
  if (!Object.prototype.hasOwnProperty.call(contentBytesDescriptor, "value")) fail("invalid_input");
  return freezeSealed({
    operation: "update" as const,
    id,
    appliedFields,
    contentBytes: requireByteCount(contentBytesDescriptor.value, MAX_RESULT_CONTENT_BYTES),
    localCommitted: true as const,
    remoteSynced: false as const,
    pendingSync: true as const,
  }) as unknown as UpdateNoteResult;
}

function copyAppliedFields(value: unknown): readonly NotesnookUpdatePatchField[] {
  const values = requireArray(value);
  let length: number;
  try {
    length = values.length;
  } catch {
    fail("invalid_input");
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_RESULT_PATCH_FIELDS) {
    fail("invalid_input");
  }
  const fields: NotesnookUpdatePatchField[] = [];
  for (let index = 0; index < length; index++) {
    const entry = readOwnIndex(values, index);
    if (typeof entry !== "string") fail("invalid_input");
    let allowed: boolean;
    try {
      allowed = ALLOWED_UPDATE_PATCH_FIELDS.has(entry as NotesnookUpdatePatchField);
    } catch {
      fail("invalid_input");
    }
    if (!allowed) fail("unsupported_patch_field");
    if (fields.includes(entry as NotesnookUpdatePatchField)) fail("invalid_input");
    fields.push(entry as NotesnookUpdatePatchField);
  }
  // Build the array as a null-prototype frozen container so a hostile
  // caller cannot route `appliedFields.__proto__` to `Array.prototype`
  // to install `push`/`splice`/`constructor`.  The published TypeScript
  // type is `readonly NotesnookUpdatePatchField[]`, which is a real
  // `Array`; we cast through `unknown` because the runtime type is
  // deliberately null-prototype.  Iteration via index/length/values
  // continues to work because we still set those as own data.
  return freezeArrayAsSealed(fields) as unknown as readonly NotesnookUpdatePatchField[];
}

// ---------------------------------------------------------------------------
// Queue recording.
//
// The receipt handed to the coordinator is built from literals plus the
// validated operation/id.  No adapter object, byte count, applied-field
// list, body, or extra field is passed across; the coordinator therefore
// cannot observe anything beyond the bounded metadata it is specified to
// persist.
// ---------------------------------------------------------------------------

function freezeReceipt(operation: SyncOperation, id: string): SyncLocalCommit {
  return freezeSealed({
    operation,
    id,
    localCommitted: true as const,
    remoteSynced: false as const,
    pendingSync: true as const,
  }) as unknown as SyncLocalCommit;
}

/**
 * Record the pending marker, or fail closed.
 *
 * A queue-recording failure is surfaced categorically — the
 * coordinator's own code is preserved when it is one of the published
 * codes (a full queue reports `invalid_input`, a persistence failure
 * reports `sync_failed`), and anything else becomes `sync_failed`.  The
 * composition never swallows the failure and never reports the write as
 * remotely synchronized.
 */
function recordPending(state: CompositionState, operation: SyncOperation, id: string): void {
  const receipt = freezeReceipt(operation, id);
  let acknowledgement: unknown;
  try {
    acknowledgement = Reflect.apply(state.recordLocalCommit, state.coordinatorTarget, [receipt]);
  } catch (error) {
    throw normaliseThrow(error);
  }
  // Every acknowledgement problem is a queue-recording failure, not an
  // input problem: the caller's command was already committed locally,
  // so the only honest report is "local write done, queue not proven".
  if (!acknowledgesPending(acknowledgement, operation, id)) fail("sync_failed");
}

/**
 * True only when the coordinator acknowledged exactly "queued and still
 * pending" for this operation/id.
 *
 * A thenable acknowledgement is refused because the coordinator seam is
 * specified as synchronous — a pending promise means the marker is not
 * durable yet, so relaying success would be a false claim.  Any hostile
 * accessor throw is absorbed here and reported as a recording failure.
 * The required fields must be own on the acknowledgement record.
 */
function acknowledgesPending(
  acknowledgement: unknown,
  operation: SyncOperation,
  id: string,
): boolean {
  try {
    if (isThenable(acknowledgement)) return false;
    const record = requireRecord(acknowledgement);
    if (!hasOwnProperty(record, "operation")) return false;
    if (!hasOwnProperty(record, "id")) return false;
    if (!hasOwnProperty(record, "localCommitted")) return false;
    if (!hasOwnProperty(record, "remoteSynced")) return false;
    if (!hasOwnProperty(record, "pendingSync")) return false;
    return (
      readOwnProperty(record, "operation") === operation &&
      readOwnProperty(record, "id") === id &&
      readOwnProperty(record, "localCommitted") === true &&
      readOwnProperty(record, "remoteSynced") === false &&
      readOwnProperty(record, "pendingSync") === true
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Remote-boundary copying.
// ---------------------------------------------------------------------------

function copyCoordinatorResult(raw: unknown): SyncCoordinatorResult {
  const record = requireRecord(raw);
  const status = readOwnProperty(record, "status");
  const localCommitted = readOwnProperty(record, "localCommitted");
  const remoteSynced = readOwnProperty(record, "remoteSynced");
  const pendingSync = readOwnProperty(record, "pendingSync");
  const attempts = readOwnProperty(record, "attempts");
  const startedAt = readOwnProperty(record, "startedAt");
  if (
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    startedAt < 0 ||
    typeof attempts !== "number" ||
    !Number.isSafeInteger(attempts) ||
    attempts < 0 ||
    attempts > MAX_RESULT_ATTEMPTS
  ) {
    fail("sync_failed");
  }
  if (status === "idle") {
    if (localCommitted !== false || remoteSynced !== false || pendingSync !== false) {
      fail("sync_failed");
    }
    if (attempts !== 0) fail("sync_failed");
    return freezeSealed({
      status: "idle" as const,
      localCommitted: false as const,
      remoteSynced: false as const,
      pendingSync: false as const,
      attempts: 0 as const,
      startedAt,
    }) as unknown as SyncCoordinatorResult;
  }
  if (status === "synced") {
    // A remote-success claim is relayed only when the coordinator states
    // it unambiguously; any inconsistent flag fails closed.
    if (
      typeof localCommitted !== "boolean" ||
      remoteSynced !== true ||
      typeof pendingSync !== "boolean"
    ) {
      fail("sync_failed");
    }
    if (attempts < 1) fail("sync_failed");
    return freezeSealed({
      status: "synced" as const,
      localCommitted,
      remoteSynced: true as const,
      pendingSync,
      attempts,
      startedAt,
    }) as unknown as SyncCoordinatorResult;
  }
  if (status === "failed") {
    if (readOwnProperty(record, "errorCode") !== "sync_failed") fail("sync_failed");
    if (
      typeof localCommitted !== "boolean" ||
      remoteSynced !== false ||
      typeof pendingSync !== "boolean"
    ) {
      fail("sync_failed");
    }
    if (attempts < 1) fail("sync_failed");
    return freezeSealed({
      status: "failed" as const,
      errorCode: "sync_failed" as const,
      localCommitted,
      remoteSynced: false as const,
      pendingSync,
      attempts,
      startedAt,
    }) as unknown as SyncCoordinatorResult;
  }
  fail("sync_failed");
}

function copySnapshot(raw: unknown): SyncCoordinatorState {
  const record = requireRecord(raw);
  const rawPending = readOwnProperty(record, "pending");
  const values = requireArray(rawPending);
  let length: number;
  try {
    length = values.length;
  } catch {
    fail("invalid_input");
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PENDING_MARKERS) {
    fail("invalid_input");
  }
  const pending: SyncPendingMarker[] = [];
  for (let index = 0; index < length; index++) {
    const rawMarker = readOwnIndex(values, index);
    const markerRecord = requireRecord(rawMarker);
    if (!hasOwnProperty(markerRecord, "operation")) fail("invalid_input");
    if (!hasOwnProperty(markerRecord, "noteId")) fail("invalid_input");
    if (!hasOwnProperty(markerRecord, "sequence")) fail("invalid_input");
    const operation = readOwnProperty(markerRecord, "operation");
    const sequence = readOwnProperty(markerRecord, "sequence");
    if (!isSyncOperation(operation)) fail("invalid_input");
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
      fail("invalid_input");
    }
    pending.push(
      freezeSealed({
        operation,
        noteId: requireNoteId(markerRecord, "noteId"),
        sequence,
      }) as unknown as SyncPendingMarker,
    );
  }
  return freezeSealed({
    pending: freezeArrayAsSealed(pending),
  }) as unknown as SyncCoordinatorState;
}

// ---------------------------------------------------------------------------
// Null-prototype / closed construction helpers.
//
// Every public output goes through these helpers so the frozen object
// has `null` as its prototype.  That removes the inherited
// `Object.prototype` methods (no `toString`/`hasOwnProperty` aliases
// from `null`-prototype objects), removes the inherited
// `constructor`, and removes the inherited
// `constructor.constructor === Function` chain that would otherwise
// let a hostile caller route `obj.constructor.constructor("return
// process")()` past a frozen boundary.  Nested arrays and the inner
// pending array go through `freezeArrayAsSealed` for the same reason.
// ---------------------------------------------------------------------------

function freezeSealed<T extends object>(shape: T): T {
  // `Object.create(null)` yields an object with no prototype, so
  // `Object.freeze` only locks down the fields we actually define.
  // We then assign every key from `shape` as a non-writable,
  // non-configurable, enumerable own data property so the resulting
  // surface is exactly the bounded fields — no inherited `toString`,
  // no inherited `constructor`, no inherited `hasOwnProperty`.
  const result = Object.create(null) as Record<string, unknown>;
  const keys = Object.keys(shape);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    let value: unknown;
    try {
      value = (shape as Record<string, unknown>)[key];
    } catch {
      fail("invalid_input");
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value,
    });
  }
  Object.freeze(result);
  return result as T;
}

function freezeArrayAsSealed<T>(values: readonly T[]): readonly T[] {
  // Start with a real Array so Array.isArray() remains true at downstream
  // boundaries, then remove its inherited surface before exposing it.  A
  // null prototype preserves the closure-hygiene guarantee while retaining
  // the standard array brand required by consumers such as the RPC handler.
  const result = [] as unknown as T[];
  Object.setPrototypeOf(result, null);
  for (let index = 0; index < values.length; index++) {
    Object.defineProperty(result as unknown as object, String(index), {
      configurable: false,
      enumerable: true,
      writable: false,
      value: values[index],
    });
  }
  // `length` is a non-enumerable, non-writable, non-configurable own
  // data property on a real `Array`.  `Object.create(null)` leaves us
  // without one, so we install it explicitly to keep consumers that
  // index by `length` working without going through the prototype.
  Object.defineProperty(result as unknown as object, "length", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: values.length,
  });
  Object.freeze(result);
  return result;
}

// ---------------------------------------------------------------------------
// Composition.
// ---------------------------------------------------------------------------

/**
 * Narrow composition of the local write adapter and the metadata-only
 * synchronization coordinator.
 *
 * The public surface is exactly:
 *
 *   - `createNote`, `appendNote`, `updateNote` — local mutation followed
 *     by pending-metadata recording;
 *   - `requestSync` — the explicit, separate remote execution request;
 *   - `pendingSnapshot` — a defensive copy of the bounded queue metadata.
 *
 * Nothing else is exposed, the instance is frozen, and the injected
 * handles are unreachable from any published member.
 */
export class NotesnookLocalWriteComposition {
  constructor(options: NotesnookLocalWriteCompositionOptions) {
    STATE.set(this, buildState(options));
    Object.freeze(this);
  }

  /**
   * Create a note locally, then record it as pending synchronization.
   *
   * Remote synchronization is NOT started: the returned result reports
   * `localCommitted: true`, `remoteSynced: false`, `pendingSync: true`.
   * While the local operation is in flight the per-instance
   * reentrancy flag is set, so a hostile adapter that calls
   * `composition.requestSync()` from inside its own `createNote`
   * implementation is rejected categorically before the remote
   * executor is invoked.  The flag is cleared in a `finally` so a
   * thrown adapter or queue-recording error cannot leave it stuck.
   */
  async createNote(command: CreateNoteCommand): Promise<CreateNoteResult> {
    const state = requireState(this);
    return gate(state, "local:create", () =>
      runLocalOperation(state, "create", () => state.createNote, command, copyCreateResult),
    );
  }

  /** Append one Markdown fragment locally, then record it as pending. */
  async appendNote(command: AppendNoteCommand): Promise<AppendNoteResult> {
    const state = requireState(this);
    return gate(state, "local:append", () =>
      runLocalOperation(state, "append", () => state.appendNote, command, copyAppendResult),
    );
  }

  /** Apply an allowlisted patch locally, then record it as pending. */
  async updateNote(command: UpdateNoteCommand): Promise<UpdateNoteResult> {
    const state = requireState(this);
    return gate(state, "local:update", () =>
      runLocalOperation(state, "update", () => state.updateNote, command, copyUpdateResult),
    );
  }

  /**
   * Explicitly ask the injected coordinator to execute pending work.
   *
   * This is the ONLY remote-facing method and it is never called as part
   * of a local mutation.  While a local mutation is in flight
   * (`localDepth > 0`), this method fails closed with
   * `invalid_input` rather than invoking the coordinator's executor —
   * a reentrant call from a hostile adapter must not be able to drain
   * the queue while a local write is still committing.  When the
   * composition was constructed with a database identity, the same gate
   * also serialises this method against any other composition or
   * remote-sync capability bound to that database — see
   * {@link withMutex}.  The coordinator's own single-flight policy
   * still governs amplification; the composition merely relays a
   * validated bounded copy of the outcome.
   */
  async requestSync(): Promise<SyncCoordinatorResult> {
    const state = requireState(this);
    // Check before queueing on the database mutex.  If an adapter calls
    // back into this composition and awaits requestSync, queueing first
    // would deadlock behind the mutation that is awaiting the callback.
    if (state.localDepth > 0) fail("invalid_input");
    return gate(state, "remote:sync", async () => {
      let raw: unknown;
      try {
        raw = await Reflect.apply(state.requestSync, state.coordinatorTarget, []);
      } catch (error) {
        throw normaliseThrow(error);
      }
      return copyCoordinatorResult(raw);
    });
  }

  /**
   * Defensive, frozen copy of the bounded pending queue metadata.
   *
   * Only `operation`, `noteId`, and `sequence` are relayed; no body,
   * record, path, or credential can appear here because the coordinator
   * never received one.  Like `requestSync`, this fails closed if a
   * local mutation is currently in flight — a hostile adapter cannot
   * use a local write to peek at the queue through this surface.  The
   * snapshot is not gated behind the per-Database mutex: it is a pure
   * read with no remote side effects, and gating it would unnecessarily
   * serialise every queue inspection behind the mutation queue.
   */
  pendingSnapshot(): SyncCoordinatorState {
    const state = requireState(this);
    if (state.localDepth > 0) fail("invalid_input");
    let raw: unknown;
    try {
      raw = Reflect.apply(state.snapshot, state.coordinatorTarget, []);
    } catch (error) {
      throw normaliseThrow(error);
    }
    return copySnapshot(raw);
  }
}

/**
 * Run `fn` either under the per-Database mutex (when the composition was
 * constructed with a `database` identity) or directly (legacy seam).  When
 * the mutex is in use, two distinct compositions pointing at the same
 * `database` object serialise their create/append/update/requestSync calls
 * — the underlying Notesnook database is now a single-owner resource.
 *
 * The label is short, bounded, and used only for fail-closed overflow
 * diagnostics.  It is never logged by this module.
 */
async function gate<T>(
  state: CompositionState,
  label: string,
  fn: () => T | PromiseLike<T>,
): Promise<T> {
  if (state.database === undefined) return fn();
  return withMutex(state.database, label, fn);
}

function checkMutationCapacity(state: CompositionState): void {
  if (state.checkCapacity === undefined) return;
  let raw: unknown;
  try {
    raw = Reflect.apply(state.checkCapacity, state.coordinatorTarget, []);
  } catch (error) {
    throw normaliseThrow(error);
  }
  const record = requireRecord(raw);
  const kind = readOwnProperty(record, "kind");
  if (kind === "accept") return;
  if (kind === "full") fail("invalid_input");
  fail("sync_failed");
}

/**
 * Run one local operation under the per-instance reentrancy guard.
 *
 * The guard is set BEFORE invoking the injected adapter and cleared in
 * a `finally`, so the state is always consistent on the way out:
 *
 *   - normal return → flag cleared, copy returned;
 *   - adapter throw → flag cleared, normalised error thrown;
 *   - copy/queue throw → flag cleared, normalised error thrown;
 *   - caller never observes the flag stuck on.
 *
 * The captured `invoker` binding (a getter that resolves the callable
 * once and returns the same reference) is what stops a hostile
 * adapter whose required method is a stateful getter from swapping
 * the callable between validation and invocation.  The composition
 * has already captured the bound function into `state`, so any later
 * swap on the host object's prototype is irrelevant.
 */
async function runLocalOperation<T>(
  state: CompositionState,
  operation: SyncOperation,
  invoker: () => UnknownFunction,
  command: unknown,
  copy: (raw: unknown) => T,
): Promise<T> {
  state.localDepth += 1;
  try {
    checkMutationCapacity(state);
    const fn = invoker();
    let raw: unknown;
    try {
      raw = await Reflect.apply(fn, state.adapterTarget, [command]);
    } catch (error) {
      throw normaliseThrow(error);
    }
    const result = copy(raw);
    recordPending(state, operation, (result as { readonly id: string }).id);
    return result;
  } finally {
    state.localDepth -= 1;
  }
}

Object.freeze(NotesnookLocalWriteComposition);
Object.freeze(NotesnookLocalWriteComposition.prototype);

/** Construct a {@link NotesnookLocalWriteComposition}. */
export function createNotesnookLocalWriteComposition(
  options: NotesnookLocalWriteCompositionOptions,
): NotesnookLocalWriteComposition {
  return new NotesnookLocalWriteComposition(options);
}
