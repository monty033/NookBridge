/**
 * Stage 5 Task 5 — `notes.search` RPC handler.
 *
 * This module is the *application* layer that bridges the closed Task 4
 * wire envelopes (`parseRpcFrame` / `serializeRpcResponse`) to the
 * bounded Task 3 {@link ServiceRuntime.search} capability.  It is
 * intentionally tiny:
 *
 *   - Pure: it does not parse frames, does not open sockets, does not
 *     touch the filesystem, does not import `@notesnook/core`, and has
 *     no daemon lifecycle.
 *   - Bounded: the only contract surface it depends on is the
 *     {@link RpcRequest} type produced by the parser and a structurally
 *     narrowed `RpcHandlerRuntimeLike` interface that maps to the
 *     Task 3 {@link ServiceRuntime.search} signature.
 *   - Closed: the response envelope it returns is a frozen,
 *     null-prototype value with only the published own keys — ready
 *     to hand to `serializeRpcResponse` without further validation.
 *   - Safe: every runtime failure is collapsed to the closed
 *     categorical RPC vocabulary, and no raw upstream message,
 *     `cause`, `path`, credential label, or hit field beyond `title`
 *     can cross the boundary.
 *
 * The handler is intentionally permissive on input (because the
 * parser has already validated the request) but it still applies
 * defence-in-depth structural checks so a hostile caller that passes
 * an unparsed object directly cannot smuggle data through.
 */

import {
  STAGE5_RPC_LIMITS,
  type RpcErrorEnvelope,
  type RpcNotesSearchRequest,
  type RpcNotesGetRequest,
  type RpcNotesListNotebooksRequest,
  type RpcNotesStatusRequest,
  type RpcMethod,
  type RpcRequest,
  type RpcAnyResponseEnvelope,
  type RpcResponseEnvelope,
  type RpcSearchHit,
  type RpcSearchResult,
  type RpcStatusResult,
  type RpcListNotebooksResult,
  type RpcSuccessEnvelope,
} from "./rpc-protocol.js";
import {
  authorizeServiceMethod,
  createReadOnlyServicePolicy,
  type ServicePolicy,
} from "./service-policy.js";

// Capture every mutable intrinsic up front so a hostile module
// loader cannot swap them out from under the handler.  This is
// mandatory: live `Object.*` calls would leak a hostile module-loader
// mutation into the boundary, and live `Reflect.*` calls would let a
// patched receiver re-enter the handler through traps.
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectSetPrototypeOf = Object.setPrototypeOf;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectPrototype = Object.prototype;
const reflectApply = Reflect.apply;
const arrayIsArray = Array.isArray;
const numberIsFinite = Number.isFinite;
const mathFloor = Math.floor;

// ---------------------------------------------------------------------------
// Public runtime contract.
// ---------------------------------------------------------------------------

/**
 * Structural contract for the runtime the handler talks to.  This is
 * deliberately a narrow seam — anything beyond `search()` would
 * widen the RPC surface and must be added through an explicit
 * decision-record amendment.
 *
 * The full {@link ServiceRuntime} from Task 3 satisfies this
 * interface; the tests inject minimal fakes that match it.
 */
export interface RpcHandlerRuntimeLike {
  /**
   * Title-only search.  Returns a Promise of read-only hit objects.
   * Any thrown error is collapsed to the categorical RPC vocabulary
   * before the handler returns.
   */
  readonly search: (query: string) => Promise<ReadonlyArray<Readonly<{ title: string }>>>;
  readonly status?: () => Promise<Readonly<{ lastSynced: number; hasUnsyncedChanges: boolean }>>;
  readonly listNotebooks?: () => Promise<
    ReadonlyArray<
      Readonly<{
        id: string;
        title: string;
        dateCreated?: number;
        dateModified?: number;
      }>
    >
  >;
  readonly noteMetadata?: (id: string) => Promise<
    | Readonly<{
        id: string;
        title: string;
        dateCreated?: number;
        dateModified?: number;
        notebookId?: string;
        pinned?: boolean;
        favorite?: boolean;
        localOnly?: boolean;
        conflicted?: boolean;
        locked?: boolean;
      }>
    | undefined
  >;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * The single closed readOnly policy the handler consults when no
 * caller-supplied policy is provided.  Constructed once at module
 * load so every dispatch shares the same frozen object; tests
 * that want to exercise a different policy must pass it
 * explicitly.
 */
const DEFAULT_READ_ONLY_POLICY: ServicePolicy = createReadOnlyServicePolicy();

/**
 * Run a single closed `RpcRequest` against the supplied
 * {@link RpcHandlerRuntimeLike} and return a closed
 * {@link RpcAnyResponseEnvelope}.
 *
 *   - The request MUST already have been validated by
 *     `parseRpcFrame`; defence-in-depth structural checks below
 *     catch the rare case where the handler is called directly with
 *     a hostile shape (unparsed JSON, unknown method, etc.).
 *   - The returned envelope is frozen, null-prototype, and contains
 *     only the documented own keys — safe to feed to
 *     `serializeRpcResponse` without further validation.
 *   - The request id is preserved on every code path.  The parser
 *     has already validated the id, so echoing it cannot leak data
 *     and silently dropping it would make the response useless.
 *   - Runtime errors collapse to `service_unavailable`; request
 *     shape errors collapse to `invalid_request`; policy denials
 *     collapse to `permission_denied`.  No raw upstream detail,
 *     `cause`, path, credential label, or note corpus data crosses
 *     the boundary.
 *   - The active authorization policy defaults to the closed
 *     readOnly profile.  Callers that need to inject a different
 *     policy (e.g. tests) can pass an explicit `policy` argument;
 *     the parser, the method union, and the dispatcher do not
 *     change either way.
 *
 * The entire body is wrapped in a top-level categorical boundary so
 * any unexpected error from a hostile request Proxy / getter is
 * normalised to a categorical envelope with a safe id — never a raw
 * throw crossing the handler boundary.
 */
export async function handleRpcRequest(
  request: RpcRequest,
  runtime: RpcHandlerRuntimeLike,
  policy: ServicePolicy = DEFAULT_READ_ONLY_POLICY,
): Promise<RpcResponseEnvelope> {
  // Safe-id extraction MUST come first: any later failure must echo
  // back something categorical, and the id itself may be hostile.
  // We extract id here so the categorical wrapper below sees a
  // pre-resolved value (already empty-fallback on hostile input).
  const id = extractRequestId(request);
  try {
    const structural = validateRequestStructurally(request);
    if (structural.kind === "ok") {
      // Service-side authorization.  The parser has already
      // narrowed `method` to the closed `RpcMethod` union, so the
      // policy decision is exercised here as a belt-and-braces
      // guard: a future write-capable profile (Slice 2+) will
      // reuse the same seam to admit additional methods without
      // changing the parser or the dispatcher.  Any policy
      // denial is converted to a `permission_denied` envelope
      // before the runtime is touched.
      const authorization = authorizeServiceMethod(policy, structural.request.method);
      if (!authorization.allowed) {
        return buildErrorEnvelope(id, "permission_denied") as unknown as RpcResponseEnvelope;
      }
      switch (structural.request.method) {
        case "notes.search":
          return (await runNotesSearch(
            structural.request,
            runtime,
            id,
          )) as unknown as RpcResponseEnvelope;
        case "notes.status":
          return (await runNotesStatus(
            structural.request,
            runtime,
            id,
          )) as unknown as RpcResponseEnvelope;
        case "notes.list_notebooks":
          return (await runNotesListNotebooks(
            structural.request,
            runtime,
            id,
          )) as unknown as RpcResponseEnvelope;
        case "notes.get":
          return (await runNotesGet(
            structural.request,
            runtime,
            id,
          )) as unknown as RpcResponseEnvelope;
      }
    }
    return buildErrorEnvelope(id, structural.code) as unknown as RpcResponseEnvelope;
  } catch {
    // The two helpers above are themselves hardened, but a hostile
    // Proxy / getter may still raise from a path the defence did not
    // cover.  Treat any such escape as a structural request failure.
    return buildErrorEnvelope(id, "invalid_request") as unknown as RpcResponseEnvelope;
  }
}

// ---------------------------------------------------------------------------
// Request validation — defence in depth.
// ---------------------------------------------------------------------------

type StructuralCheck =
  | { readonly kind: "ok"; readonly request: RpcRequest }
  | { readonly kind: "err"; readonly code: "invalid_request" };

/**
 * Re-narrow a (possibly hostile) `RpcRequest` to the closed
 * `RpcNotesSearchRequest` shape.  Any deviation is reported as
 * `invalid_request` so the response envelope cannot smuggle a
 * different method type past the boundary.  Never reads or echoes
 * the request value into the error.
 *
 * Field reads go through `Reflect`-safe, own-property-only access
 * (descriptor-inspected) so a hostile Proxy / getter cannot
 * substitute code or trigger a side effect.  The reconstructed
 * request / params are built with `objectCreate(null, ...)` +
 * captured `objectFreeze`, never with object literals that would
 * carry an `Object.prototype` link.
 */
function validateRequestStructurally(input: unknown): StructuralCheck {
  if (input === null || typeof input !== "object" || arrayIsArray(input)) {
    return { kind: "err", code: "invalid_request" };
  }
  const record = input as Record<string, unknown>;

  // Each accessor is itself defensive: it accepts an own DATA
  // descriptor only and refuses getters / inherited fields.  A
  // hostile `input.method = { get() { ... } }` shape is rejected
  // before the getter runs.
  const rawMethod = readOwnStringField(record, "method");
  if (
    rawMethod !== "notes.search" &&
    rawMethod !== "notes.status" &&
    rawMethod !== "notes.list_notebooks" &&
    rawMethod !== "notes.get"
  ) {
    return { kind: "err", code: "invalid_request" };
  }

  const rawParams = readOwnObjectField(record, "params");
  if (rawParams === undefined) {
    return { kind: "err", code: "invalid_request" };
  }
  const paramKeys = Object.keys(rawParams);
  let params: Record<string, unknown>;
  if (rawMethod === "notes.search") {
    if (!hasExactKeys(paramKeys, ["query"])) return { kind: "err", code: "invalid_request" };
    const rawQuery = readOwnStringField(rawParams, "query");
    if (rawQuery === undefined) return { kind: "err", code: "invalid_request" };
    params = objectCreate(null) as Record<string, unknown>;
    params.query = rawQuery;
  } else if (rawMethod === "notes.get") {
    if (!hasExactKeys(paramKeys, ["id"])) return { kind: "err", code: "invalid_request" };
    const rawNoteId = readOwnStringField(rawParams, "id");
    if (
      rawNoteId === undefined ||
      rawNoteId.length === 0 ||
      rawNoteId.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      hasControlCharacter(rawNoteId)
    ) {
      return { kind: "err", code: "invalid_request" };
    }
    params = objectCreate(null) as Record<string, unknown>;
    params.id = rawNoteId;
  } else {
    if (!hasExactKeys(paramKeys, [])) return { kind: "err", code: "invalid_request" };
    params = objectCreate(null) as Record<string, unknown>;
  }
  objectFreeze(params);

  const request = objectFreeze(
    objectCreate(null, {
      id: {
        value: readOwnStringField(record, "id") ?? "",
        enumerable: true,
        configurable: false,
        writable: false,
      },
      method: {
        value: rawMethod as RpcMethod,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      params: { value: params, enumerable: true, configurable: false, writable: false },
    }) as unknown as RpcRequest,
  );
  return { kind: "ok", request };
}

function hasExactKeys(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((key) => actual.includes(key));
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Read a closed string own-field from a record.  Returns `undefined`
 * when the field is missing, the wrong type, inherited, an accessor
 * descriptor, or otherwise unsafe.  The descriptor is fetched through
 * captured intrinsics so a live `Object.getOwnPropertyDescriptor`
 * mutation cannot smuggle a hostile descriptor past the boundary.
 */
function readOwnStringField(record: Record<string, unknown>, key: string): string | undefined {
  try {
    // Captured intrinsic descriptor lookup prevents inherited fields
    // and rejects accessors before any getter can run.
    const descriptor = reflectApply(objectGetOwnPropertyDescriptor, Object, [record, key]);
    if (descriptor === undefined || descriptor === null || !("value" in descriptor)) {
      return undefined;
    }
    return typeof descriptor.value === "string" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a closed object own-field (a plain non-array object) from a
 * record.  Returns `undefined` when the field is missing, the wrong
 * type, inherited, an accessor, an array, or `null`.  Used by
 * structural validation to safely pull `params` before reading the
 * nested `query` field.
 */
function readOwnObjectField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  try {
    const descriptor = reflectApply(objectGetOwnPropertyDescriptor, Object, [record, key]);
    if (descriptor === undefined || descriptor === null || !("value" in descriptor)) {
      return undefined;
    }
    const value = descriptor.value;
    if (value === null || typeof value !== "object" || arrayIsArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Extract the request id for echo-back.  When the input is structurally
 * hostile, we fall back to a frozen empty string; the response envelope
 * still has a non-empty id when the request itself was a sane
 * `RpcNotesSearchRequest`, and the serializer will reject an empty
 * id downstream — so the empty-fallback exists only to keep the
 * envelope self-consistent, never to leak the hostile input.
 *
 * The id lookup is descriptor-based so an accessor on the request
 * itself cannot substitute a sensitive value for the id.
 */
function extractRequestId(input: unknown): string {
  try {
    if (input === null || typeof input !== "object" || arrayIsArray(input)) {
      return "";
    }
    const id = readOwnStringField(input as Record<string, unknown>, "id");
    return id ?? "";
  } catch {
    return "";
  }
}

async function runNotesStatus(
  _request: RpcNotesStatusRequest,
  runtime: RpcHandlerRuntimeLike,
  id: string,
): Promise<RpcAnyResponseEnvelope> {
  const fn = readRuntimeMethod(runtime, "status");
  if (fn === undefined) return buildErrorEnvelope(id, "service_unavailable");
  let raw: unknown;
  try {
    raw = await reflectApply(fn, runtime, []);
  } catch {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  if (raw === null || typeof raw !== "object" || arrayIsArray(raw)) {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  const status = raw as Record<string, unknown>;
  const lastSynced = readOwnNumberField(status, "lastSynced");
  const hasUnsyncedChanges = readOwnBooleanField(status, "hasUnsyncedChanges");
  if (lastSynced === undefined || hasUnsyncedChanges === undefined) {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  const result = objectFreeze(
    objectCreate(null, {
      kind: { value: "status", enumerable: true, configurable: false, writable: false },
      lastSynced: { value: lastSynced, enumerable: true, configurable: false, writable: false },
      hasUnsyncedChanges: {
        value: hasUnsyncedChanges,
        enumerable: true,
        configurable: false,
        writable: false,
      },
    }),
  ) as RpcStatusResult;
  return buildResultSuccessEnvelope(id, result);
}

async function runNotesListNotebooks(
  _request: RpcNotesListNotebooksRequest,
  runtime: RpcHandlerRuntimeLike,
  id: string,
): Promise<RpcAnyResponseEnvelope> {
  const fn = readRuntimeMethod(runtime, "listNotebooks");
  if (fn === undefined) return buildErrorEnvelope(id, "service_unavailable");
  let raw: unknown;
  try {
    raw = await reflectApply(fn, runtime, []);
  } catch {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  if (!arrayIsArray(raw)) return buildErrorEnvelope(id, "service_unavailable");
  const notebooks: Array<unknown> = [];
  const bound =
    raw.length < STAGE5_RPC_LIMITS.maxSearchHits ? raw.length : STAGE5_RPC_LIMITS.maxSearchHits;
  for (let index = 0; index < bound; index += 1) {
    const summary = normaliseNotebook(raw[index]);
    if (summary !== undefined) notebooks.push(summary);
  }
  const result = objectFreeze(
    objectCreate(null, {
      kind: { value: "notebooks", enumerable: true, configurable: false, writable: false },
      notebooks: {
        value: Object.freeze(notebooks),
        enumerable: true,
        configurable: false,
        writable: false,
      },
    }),
  ) as RpcListNotebooksResult;
  return buildResultSuccessEnvelope(id, result);
}

async function runNotesGet(
  request: RpcNotesGetRequest,
  runtime: RpcHandlerRuntimeLike,
  id: string,
): Promise<RpcAnyResponseEnvelope> {
  const fn = readRuntimeMethod(runtime, "noteMetadata");
  if (fn === undefined) return buildErrorEnvelope(id, "service_unavailable");
  let raw: unknown;
  try {
    raw = await reflectApply(fn, runtime, [request.params.id]);
  } catch {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  if (raw === undefined) return buildErrorEnvelope(id, "not_found");
  const note = normaliseNoteMetadata(raw);
  if (note === undefined) return buildErrorEnvelope(id, "service_unavailable");
  const result = objectFreeze(
    objectCreate(null, {
      kind: { value: "note", enumerable: true, configurable: false, writable: false },
      note: { value: note, enumerable: true, configurable: false, writable: false },
    }),
  );
  return buildResultSuccessEnvelope(id, result);
}

function readRuntimeMethod(
  runtime: RpcHandlerRuntimeLike,
  key: "status" | "listNotebooks" | "noteMetadata",
): ((...args: unknown[]) => unknown) | undefined {
  try {
    const descriptor = objectGetOwnPropertyDescriptor(runtime, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      return undefined;
    }
    return descriptor.value as (...args: unknown[]) => unknown;
  } catch {
    return undefined;
  }
}

function readOwnNumberField(record: Record<string, unknown>, key: string): number | undefined {
  try {
    const descriptor = objectGetOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    const value = descriptor.value;
    return typeof value === "number" && numberIsFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
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

function normaliseNotebook(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || arrayIsArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = readOwnStringField(record, "id");
  const title = readOwnStringField(record, "title");
  if (
    id === undefined ||
    title === undefined ||
    id.length === 0 ||
    title.length === 0 ||
    id.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    title.length > STAGE5_RPC_LIMITS.maxTitleBytes ||
    hasControlCharacter(id) ||
    hasControlCharacter(title)
  )
    return undefined;
  const output = objectCreate(null) as Record<string, unknown>;
  output.id = id;
  output.title = title;
  const dateCreated = readOwnNumberField(record, "dateCreated");
  const dateModified = readOwnNumberField(record, "dateModified");
  if (dateCreated !== undefined) output.dateCreated = dateCreated;
  if (dateModified !== undefined) output.dateModified = dateModified;
  return objectFreeze(output);
}

function normaliseNoteMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || arrayIsArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = readOwnStringField(record, "id");
  const title = readOwnStringField(record, "title");
  if (
    id === undefined ||
    title === undefined ||
    id.length === 0 ||
    title.length === 0 ||
    id.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    title.length > STAGE5_RPC_LIMITS.maxTitleBytes ||
    hasControlCharacter(id) ||
    hasControlCharacter(title)
  )
    return undefined;
  const output = objectCreate(null) as Record<string, unknown>;
  output.id = id;
  output.title = title;
  for (const key of ["dateCreated", "dateModified"] as const) {
    const value = readOwnNumberField(record, key);
    if (value !== undefined) output[key] = value;
  }
  const notebookId = readOwnStringField(record, "notebookId");
  if (
    notebookId !== undefined &&
    notebookId.length > 0 &&
    notebookId.length <= STAGE5_RPC_LIMITS.maxIdentifierBytes &&
    !hasControlCharacter(notebookId)
  ) {
    output.notebookId = notebookId;
  }
  for (const key of ["pinned", "favorite", "localOnly", "conflicted", "locked"] as const) {
    const value = readOwnBooleanField(record, key);
    if (value !== undefined) output[key] = value;
  }
  return objectFreeze(output);
}

function buildResultSuccessEnvelope(
  id: string,
  result:
    | RpcStatusResult
    | RpcListNotebooksResult
    | { readonly kind: "note"; readonly note: Record<string, unknown> },
): RpcAnyResponseEnvelope {
  return objectFreeze(
    objectCreate(null, {
      id: { value: id, enumerable: true, configurable: false, writable: false },
      ok: { value: true, enumerable: true, configurable: false, writable: false },
      result: { value: result, enumerable: true, configurable: false, writable: false },
    }),
  ) as RpcAnyResponseEnvelope;
}

// ---------------------------------------------------------------------------
// Runtime invocation.
// ---------------------------------------------------------------------------

async function runNotesSearch(
  request: RpcNotesSearchRequest,
  runtime: RpcHandlerRuntimeLike,
  id: string,
): Promise<RpcAnyResponseEnvelope> {
  // Validate the runtime structurally before invoking it.  A Proxy /
  // non-function / missing search() should never reach a real call.
  // The structural check itself is wrapped because a hostile Proxy
  // trap can throw from inside the descriptor probe.
  let callable: RpcHandlerRuntimeLike | undefined;
  try {
    callable = isCallableRuntime(runtime) ? runtime : undefined;
  } catch {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  if (callable === undefined) {
    return buildErrorEnvelope(id, "service_unavailable");
  }

  // Pull the search function out through the SAME data descriptor
  // the structural check inspected — never via plain property access,
  // which a hostile / stateful getter could mutate between checks
  // and invocations to substitute code.  Captured
  // `Reflect.getOwnPropertyDescriptor` + captured `Reflect.apply`
  // freezes the function value to the descriptor seen at inspection
  // time.
  let searchFn: unknown;
  try {
    const descriptor = reflectApply(objectGetOwnPropertyDescriptor, callable, [callable, "search"]);
    if (descriptor === undefined || descriptor === null) {
      return buildErrorEnvelope(id, "service_unavailable");
    }
    if (!("value" in descriptor)) {
      return buildErrorEnvelope(id, "service_unavailable");
    }
    searchFn = descriptor.value;
  } catch {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  if (typeof searchFn !== "function") {
    return buildErrorEnvelope(id, "service_unavailable");
  }

  let rawHits: unknown;
  try {
    // Invoke the captured function with the original runtime as
    // `this` so any expected binding (rare, but possible) survives.
    rawHits = await reflectApply(searchFn as (...args: unknown[]) => unknown, callable, [
      request.params.query,
    ]);
  } catch {
    // The runtime already normalises its own internal errors to
    // categorical messages; the handler must never echo them.
    return buildErrorEnvelope(id, "service_unavailable");
  }

  if (!arrayIsArray(rawHits)) {
    return buildErrorEnvelope(id, "service_unavailable");
  }

  // Wrap success-envelope construction so a hostile hit / array
  // Proxy can never let a raw throw escape the handler boundary.
  try {
    return buildSuccessEnvelope(id, rawHits);
  } catch {
    return buildErrorEnvelope(id, "service_unavailable");
  }
}

/**
 * Structural defence for the runtime.  Refuse:
 *
 *   - non-objects / arrays / `null`;
 *   - objects whose `search` is missing, inherited, defined via a
 *     getter descriptor (a hostile Proxy-getter trap would intercept
 *     a plain `.search` read but produce a data descriptor that
 *     leaks through this static check), or not a function;
 *   - objects whose prototype is not `Object.prototype`, so a
 *     hostile prototype-smuggling Proxy or class instance cannot
 *     reach the trust boundary.
 *
 * Any deviation collapses the response to `service_unavailable` and
 * the runtime is never invoked.  All descriptor probes go through
 * captured intrinsics so a live `Object.*` mutation cannot smuggle
 * data past the boundary.
 */
function isCallableRuntime(runtime: unknown): runtime is RpcHandlerRuntimeLike {
  try {
    if (runtime === null || typeof runtime !== "object" || arrayIsArray(runtime)) {
      return false;
    }
    // Captured prototype lookup prevents a live Object.* mutation from
    // substituting a misleading prototype.  Proxy traps may still run,
    // so this entire probe is categorical and never escapes.
    const proto = reflectApply(objectGetPrototypeOf, Object, [runtime]);
    if (proto !== objectPrototype && proto !== null) {
      return false;
    }
    const record = runtime as Record<string, unknown>;
    const descriptor = reflectApply(objectGetOwnPropertyDescriptor, Object, [record, "search"]);
    if (descriptor === undefined || descriptor === null || !("value" in descriptor)) {
      return false;
    }
    return typeof descriptor.value === "function";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Envelope construction.
// ---------------------------------------------------------------------------

/**
 * Build the success envelope.  Hits are normalised to plain
 * `{ title: string }` own-field objects; the bound
 * `STAGE5_RPC_LIMITS.maxSearchHits` is enforced fail-closed (extra
 * hits are silently truncated).  The notes array, each hit, the
 * result, and the envelope itself are all frozen on a null
 * prototype so a hostile inherited getter cannot smuggle data
 * back out.
 *
 * Hostile arrays / Proxies whose `length` or index accessors throw
 * are tolerated: callers wrap this helper in a try/catch and map
 * construction failure to `service_unavailable`.
 */
function buildSuccessEnvelope(id: string, rawHits: ReadonlyArray<unknown>): RpcAnyResponseEnvelope {
  // Probe `length` and `String(index)` own-property presence through
  // captured intrinsics; fall back silently on any deviation.  We
  // do NOT rely on `rawHits.length` (which a hostile Proxy can make
  // throw) — we read the length descriptor first.
  const length = readArrayLength(rawHits);

  // Build the array with intrinsic `length` tracking, then null the
  // prototype / freeze once every slot is filled.  A hand-rolled
  // `Object.create(null)` array lacks `length` plumbing so we
  // cannot rely on it for bound tracking.
  const cleanNotes: RpcSearchHit[] = [];
  const limit = STAGE5_RPC_LIMITS.maxSearchHits;
  const bound = length < limit ? length : limit;
  for (let index = 0; index < bound; index += 1) {
    const descriptor = reflectApply(objectGetOwnPropertyDescriptor, Object, [
      rawHits,
      String(index),
    ]);
    if (descriptor === undefined || descriptor === null || !("value" in descriptor)) continue;
    const hit: unknown = descriptor.value;
    const title = normaliseHit(hit);
    if (title === undefined) continue;
    cleanNotes[index] = objectFreeze(
      objectCreate(null, {
        title: { value: title, enumerable: true, configurable: false, writable: false },
      }),
    ) as RpcSearchHit;
  }
  objectSetPrototypeOf(cleanNotes, null);
  objectFreeze(cleanNotes);

  const result: RpcSearchResult = objectFreeze(
    objectCreate(null, {
      kind: { value: "search", enumerable: true, configurable: false, writable: false },
      notes: { value: cleanNotes, enumerable: true, configurable: false, writable: false },
    }),
  ) as RpcSearchResult;

  const success: RpcSuccessEnvelope = objectFreeze(
    objectCreate(null, {
      id: { value: id, enumerable: true, configurable: false, writable: false },
      ok: { value: true, enumerable: true, configurable: false, writable: false },
      result: { value: result, enumerable: true, configurable: false, writable: false },
    }),
  ) as RpcSuccessEnvelope;

  return success;
}

/**
 * Read the `length` of an array-like value via the captured
 * `Reflect.get` so a hostile Proxy whose length-getter throws cannot
 * escape the boundary.  The caller is responsible for treating an
 * out-of-range length as 0 (i.e. empty result) when an envelope
 * cannot be safely constructed; this helper never throws.
 */
function readArrayLength(rawHits: ReadonlyArray<unknown>): number {
  try {
    const descriptor = reflectApply(objectGetOwnPropertyDescriptor, rawHits, [rawHits, "length"]);
    if (descriptor === undefined || descriptor === null) return 0;
    if (!("value" in descriptor)) return 0;
    const value = descriptor.value;
    if (typeof value !== "number" || !numberIsFinite(value) || value < 0) return 0;
    return mathFloor(value);
  } catch {
    return 0;
  }
}

/**
 * Coerce a runtime hit into a plain `string` title.  The hit is
 * expected to expose a string `title` own-property; anything else is
 * dropped silently.  A hostile object with inherited getters /
 * `Proxy` traps cannot smuggle data through this helper because we
 * only read through `Reflect`-safe, own-property-only access.  The
 * descriptor probe is captured-intrinsic so a live
 * `Object.getOwnPropertyDescriptor` mutation cannot smuggle a
 * hostile descriptor past the boundary.
 */
function normaliseHit(value: unknown): string | undefined {
  try {
    if (value === null || typeof value !== "object" || arrayIsArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    // Read only an own data descriptor. Accessor descriptors are
    // rejected without invoking their getter.
    const descriptor = reflectApply(objectGetOwnPropertyDescriptor, Object, [record, "title"]);
    if (descriptor === undefined || descriptor === null || !("value" in descriptor)) {
      return undefined;
    }
    const title = descriptor.value;
    return typeof title === "string" ? title : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a closed error envelope.  Only the published categorical
 * vocabulary is allowed at the call sites; the message is the
 * canonical (non-sensitive) per-code message and is never derived
 * from the runtime / request value.  The envelope and the
 * `error` payload are frozen on a null prototype so a hostile
 * inherited getter cannot smuggle data back out.
 */
function buildErrorEnvelope(
  id: string,
  code:
    | "invalid_request"
    | "permission_denied"
    | "service_unavailable"
    | "sync_failed"
    | "vault_locked"
    | "not_found",
): RpcAnyResponseEnvelope {
  const messages = {
    invalid_request: "Invalid request",
    permission_denied: "Permission denied",
    service_unavailable: "Service unavailable",
    sync_failed: "Sync failed",
    vault_locked: "Vault locked",
    not_found: "Not found",
  } as const;
  const message = messages[code];

  const error: RpcErrorEnvelope["error"] = objectFreeze(
    objectCreate(null, {
      code: { value: code, enumerable: true, configurable: false, writable: false },
      message: {
        value: message,
        enumerable: true,
        configurable: false,
        writable: false,
      },
    }),
  ) as RpcErrorEnvelope["error"];

  const envelope: RpcErrorEnvelope = objectFreeze(
    objectCreate(null, {
      id: { value: id, enumerable: true, configurable: false, writable: false },
      ok: { value: false, enumerable: true, configurable: false, writable: false },
      error: { value: error, enumerable: true, configurable: false, writable: false },
    }),
  ) as RpcErrorEnvelope;

  return envelope;
}
