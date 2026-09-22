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

import { Buffer } from "node:buffer";
import {
  STAGE5_RPC_LIMITS,
  type RpcErrorEnvelope,
  type RpcNotesSearchRequest,
  type RpcNotesGetRequest,
  type RpcNotesListNotebooksRequest,
  type RpcNotesStatusRequest,
  type RpcNotesCreateRequest,
  type RpcNotesAppendRequest,
  type RpcNotesUpdateRequest,
  type RpcNotesDeleteRequest,
  type RpcNotesLockedNoteProofRequest,
  type RpcNotesPathDiagnosticRequest,
  type RpcNotesSyncRequest,
  type RpcMethod,
  type RpcRequest,
  type RpcAnyResponseEnvelope,
  type RpcResponseEnvelope,
  type RpcSearchHit,
  type RpcSearchResult,
  type RpcStatusResult,
  type RpcListNotebooksResult,
  type RpcCreatedNoteResult,
  type RpcAppendNoteResult,
  type RpcUpdateNoteResult,
  type RpcDeleteNoteResult,
  type RpcLockedNoteProofResult,
  type RpcNotesPathDiagnosticResult,
  type RpcSyncResult,
  type RpcSuccessEnvelope,
} from "./rpc-protocol.js";
import type {
  CreateNoteCommand,
  AppendNoteCommand,
  DeleteNoteCommand,
  UpdateNoteCommand,
} from "../core/notesnook-write-contract.js";
import type {
  CreateNoteResult,
  AppendNoteResult,
  DeleteNoteResult,
  UpdateNoteResult,
} from "../core/notesnook-write-adapter.js";
import type { NotebookIndex } from "../settings/notebook-index.js";
import {
  ExactNotePathError,
  parseExactNotePath,
  type ExactNotePathInput,
  type ExactNotePathResolution,
} from "./exact-note-path-resolver.js";
import {
  authorizeServiceMethod,
  createReadOnlyServicePolicy,
  type ServicePolicySettingsContext,
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
const bufferByteLength = Buffer.byteLength;

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
        revision?: string;
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
  /** Optional trusted Stage 10 index for resolving notebook ids to titlePaths. */
  readonly notebookIndex?: NotebookIndex;
  /** Refresh resolver backed by the daemon's full notebook hierarchy projection. */
  readonly resolveNotebookPath?: (notebookId: string) => Promise<string | undefined>;
  readonly createNote?: (command: CreateNoteCommand) => Promise<CreateNoteResult>;
  readonly appendNote?: (command: AppendNoteCommand) => Promise<AppendNoteResult>;
  readonly updateNote?: (command: UpdateNoteCommand) => Promise<UpdateNoteResult>;
  readonly deleteNote?: (command: DeleteNoteCommand) => Promise<DeleteNoteResult>;
  /** Optional daemon-side resolver for exact destructive note paths. */
  readonly resolveNotePath?: (path: ExactNotePathInput) => Promise<ExactNotePathResolution>;
  /** Daemon-owned closed locked-note acceptance proof. */
  readonly lockedNoteProof?: (path: ExactNotePathInput) => Promise<RpcLockedNoteProofResult>;
  /** Daemon-owned closed read-only exact-path diagnostic. */
  readonly pathDiagnostic?: (path: ExactNotePathInput) => Promise<RpcNotesPathDiagnosticResult>;
  readonly requestSync?: () => Promise<
    Readonly<{
      status: "idle" | "synced" | "failed";
      pendingSync: boolean;
      attempts: number;
    }>
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
type RpcHandlerResponse<T extends RpcRequest> = T extends RpcNotesSearchRequest
  ? RpcResponseEnvelope
  : RpcAnyResponseEnvelope;

export async function handleRpcRequest<T extends RpcRequest>(
  request: T,
  runtime: RpcHandlerRuntimeLike,
  policy: ServicePolicy = DEFAULT_READ_ONLY_POLICY,
): Promise<RpcHandlerResponse<T>> {
  // Safe-id extraction MUST come first: any later failure must echo
  // back something categorical, and the id itself may be hostile.
  // We extract id here so the categorical wrapper below sees a
  // pre-resolved value (already empty-fallback on hostile input).
  const id = extractRequestId(request);
  try {
    const structural = validateRequestStructurally(request);
    if (structural.kind === "ok") {
      // Global operations have no note-specific context.  They still
      // consult an attached evaluator with the empty context, which lets
      // settings defaults decide whether the request is admitted.
      if (
        structural.request.method === "notes.search" ||
        structural.request.method === "notes.status" ||
        structural.request.method === "notes.list_notebooks" ||
        structural.request.method === "notes.path_diagnostic" ||
        structural.request.method === "notes.sync" ||
        policy.evaluator === undefined
      ) {
        const authorization = authorizeServiceMethod(policy, structural.request.method);
        if (!authorization.allowed) {
          return buildErrorEnvelope(id, "permission_denied") as unknown as RpcHandlerResponse<T>;
        }
        return (await runAuthorizedRpcMethod(
          structural.request,
          runtime,
          id,
        )) as unknown as RpcHandlerResponse<T>;
      }

      if (structural.request.method === "notes.get") {
        const resolved = await resolveNoteSettingsContext(structural.request.params.id, runtime);
        if (!resolved.ok)
          return buildErrorEnvelope(id, resolved.code) as unknown as RpcHandlerResponse<T>;
        const authorization = authorizeServiceMethod(policy, "notes.get", resolved.context);
        if (!authorization.allowed) {
          return buildErrorEnvelope(id, "permission_denied") as unknown as RpcHandlerResponse<T>;
        }
        return (await runNotesGet(
          structural.request,
          runtime,
          id,
          resolved.note,
        )) as unknown as RpcHandlerResponse<T>;
      }

      if (structural.request.method === "notes.create") {
        const context = await resolveCreateSettingsContext(
          structural.request.params.notebookId,
          runtime,
        );
        if (!context.ok)
          return buildErrorEnvelope(id, context.code) as unknown as RpcHandlerResponse<T>;
        const authorization = authorizeServiceMethod(policy, "notes.create", context.context);
        if (!authorization.allowed) {
          return buildErrorEnvelope(id, "permission_denied") as unknown as RpcHandlerResponse<T>;
        }
        return (await runNotesCreate(
          structural.request,
          runtime,
          id,
        )) as unknown as RpcHandlerResponse<T>;
      }

      if (structural.request.method === "notes.delete") {
        const target = exactNotePathInput(structural.request.params);
        const parsedPath = parseExactNotePath(target);
        const settingsContext =
          parsedPath.notebookPath === undefined
            ? { noteTitle: parsedPath.noteTitle }
            : { notebookPath: parsedPath.notebookPath, noteTitle: parsedPath.noteTitle };
        const authorization = authorizeServiceMethod(policy, "notes.delete", settingsContext);
        if (!authorization.allowed) {
          return buildErrorEnvelope(id, "permission_denied") as unknown as RpcHandlerResponse<T>;
        }
        return (await runNotesDelete(
          structural.request,
          runtime,
          id,
        )) as unknown as RpcHandlerResponse<T>;
      }

      if (structural.request.method === "notes.locked_note_proof") {
        const target = exactNotePathInput(structural.request.params);
        const resolver = runtime.resolveNotePath;
        if (resolver === undefined) {
          return buildErrorEnvelope(id, "service_unavailable") as unknown as RpcHandlerResponse<T>;
        }
        try {
          await reflectApply(resolver, runtime, [target]);
        } catch (error) {
          if (error instanceof ExactNotePathError && error.code === "not_found") {
            return buildErrorEnvelope(id, "not_found") as unknown as RpcHandlerResponse<T>;
          }
          return buildErrorEnvelope(id, "service_unavailable") as unknown as RpcHandlerResponse<T>;
        }
        const parsedPath = parseExactNotePath(target);
        const settingsContext =
          parsedPath.notebookPath === undefined
            ? { noteTitle: parsedPath.noteTitle }
            : { notebookPath: parsedPath.notebookPath, noteTitle: parsedPath.noteTitle };
        for (const method of ["notes.get", "notes.update", "notes.delete"] as const) {
          if (!authorizeServiceMethod(policy, method, settingsContext).allowed) {
            return buildErrorEnvelope(id, "permission_denied") as unknown as RpcHandlerResponse<T>;
          }
        }
        return (await runLockedNoteProof(
          structural.request,
          runtime,
          id,
        )) as unknown as RpcHandlerResponse<T>;
      }

      // T04 — the MCP endpoint rejects every canonical operator
      // method categorically.  Operator methods are routed to the
      // separate operator listener (and operator policy evaluator)
      // — they must never reach the MCP handler.
      //
      // In practice this block is UNREACHABLE for operator methods:
      // `validateRequestStructurally` above admits only the eleven
      // daemon methods, so an operator method is already refused with
      // `invalid_request` before it gets here.  That is the stronger
      // outcome — an operator method is indistinguishable from any
      // other unknown method, so probing cannot reveal that an
      // operator endpoint exists on this host.  The check is kept as
      // defence in depth in case the structural allowlist is ever
      // widened; `tests/stage-11-t10-mcp-non-regression.test.ts`
      // derives its cases from OPERATOR_METHODS so a widening cannot
      // silently open this boundary.
      if (
        structural.request.method === "notes.get-view" ||
        structural.request.method === "notes.edit-preimage" ||
        structural.request.method === "notes.apply-edit" ||
        structural.request.method === "notes.apply-undo" ||
        structural.request.method === "notes.operation-status" ||
        structural.request.method === "notes.operation-list" ||
        structural.request.method === "notes.browse" ||
        structural.request.method === "notes.search-operator"
      ) {
        return buildErrorEnvelope(id, "permission_denied") as unknown as RpcHandlerResponse<T>;
      }

      const resolved = await resolveNoteSettingsContext(structural.request.params.id, runtime);
      if (!resolved.ok)
        return buildErrorEnvelope(id, resolved.code) as unknown as RpcHandlerResponse<T>;
      const authorization = authorizeServiceMethod(
        policy,
        structural.request.method,
        resolved.context,
      );
      if (!authorization.allowed) {
        return buildErrorEnvelope(id, "permission_denied") as unknown as RpcHandlerResponse<T>;
      }
      if (structural.request.method === "notes.append") {
        return (await runNotesAppend(
          structural.request,
          runtime,
          id,
        )) as unknown as RpcHandlerResponse<T>;
      }
      return (await runNotesUpdate(
        structural.request,
        runtime,
        id,
      )) as unknown as RpcHandlerResponse<T>;
    }
    return buildErrorEnvelope(id, structural.code) as unknown as RpcHandlerResponse<T>;
  } catch {
    // The two helpers above are themselves hardened, but a hostile
    // Proxy / getter may still raise from a path the defence did not
    // cover.  Treat any such escape as a structural request failure.
    return buildErrorEnvelope(id, "invalid_request") as unknown as RpcHandlerResponse<T>;
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
    rawMethod !== "notes.get" &&
    rawMethod !== "notes.create" &&
    rawMethod !== "notes.append" &&
    rawMethod !== "notes.update" &&
    rawMethod !== "notes.delete" &&
    rawMethod !== "notes.locked_note_proof" &&
    rawMethod !== "notes.path_diagnostic" &&
    rawMethod !== "notes.sync"
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
  } else if (rawMethod === "notes.create") {
    const allowedCreateShapes: ReadonlyArray<ReadonlyArray<string>> = [
      ["title", "content"],
      ["title", "content", "notebookId"],
      ["title", "content", "listKind"],
      ["title", "content", "notebookId", "listKind"],
    ];
    let createShapeMatched = false;
    for (const shape of allowedCreateShapes) {
      if (hasExactKeys(paramKeys, shape)) {
        createShapeMatched = true;
        break;
      }
    }
    if (!createShapeMatched) return { kind: "err", code: "invalid_request" };
    const rawTitle = readOwnStringField(rawParams, "title");
    const rawContent = readOwnStringField(rawParams, "content");
    if (
      rawTitle === undefined ||
      rawTitle.length === 0 ||
      rawTitle.length > STAGE5_RPC_LIMITS.maxTitleBytes ||
      bufferByteLength(rawTitle, "utf8") > STAGE5_RPC_LIMITS.maxTitleBytes ||
      hasControlCharacter(rawTitle) ||
      rawContent === undefined ||
      rawContent.length === 0 ||
      rawContent.length > STAGE5_RPC_LIMITS.maxQueryBytes ||
      bufferByteLength(rawContent, "utf8") > STAGE5_RPC_LIMITS.maxQueryBytes ||
      hasDisallowedControlCharacter(rawContent)
    ) {
      return { kind: "err", code: "invalid_request" };
    }
    params = objectCreate(null) as Record<string, unknown>;
    params.title = rawTitle;
    params.content = rawContent;
    if (paramKeys.includes("notebookId")) {
      const rawNotebookId = readOwnStringField(rawParams, "notebookId");
      if (
        rawNotebookId === undefined ||
        rawNotebookId.length === 0 ||
        rawNotebookId.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
        bufferByteLength(rawNotebookId, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
        hasControlCharacter(rawNotebookId)
      ) {
        return { kind: "err", code: "invalid_request" };
      }
      params.notebookId = rawNotebookId;
    }
    if (paramKeys.includes("listKind")) {
      const rawListKind = readOwnStringField(rawParams, "listKind");
      if (rawListKind !== "simple-checklist" && rawListKind !== "task-list") {
        return { kind: "err", code: "invalid_request" };
      }
      params.listKind = rawListKind;
    }
  } else if (rawMethod === "notes.append") {
    const allowedAppendShapes: ReadonlyArray<ReadonlyArray<string>> = [
      ["id", "markdownFragment", "expectedRevision"],
      ["id", "markdownFragment", "expectedRevision", "listKind"],
    ];
    let appendShapeMatched = false;
    for (const shape of allowedAppendShapes) {
      if (hasExactKeys(paramKeys, shape)) {
        appendShapeMatched = true;
        break;
      }
    }
    if (!appendShapeMatched) return { kind: "err", code: "invalid_request" };
    const rawNoteId = readOwnStringField(rawParams, "id");
    const rawFragment = readOwnStringField(rawParams, "markdownFragment");
    const rawRevision = readOwnStringField(rawParams, "expectedRevision");
    if (
      !isBoundedRpcIdentifier(rawNoteId) ||
      rawFragment === undefined ||
      rawFragment.length === 0 ||
      rawFragment.length > STAGE5_RPC_LIMITS.maxQueryBytes ||
      bufferByteLength(rawFragment, "utf8") > STAGE5_RPC_LIMITS.maxQueryBytes ||
      hasDisallowedControlCharacter(rawFragment) ||
      !isRevisionToken(rawRevision)
    ) {
      return { kind: "err", code: "invalid_request" };
    }
    params = objectCreate(null) as Record<string, unknown>;
    params.id = rawNoteId;
    params.markdownFragment = rawFragment;
    params.expectedRevision = rawRevision;
    if (paramKeys.includes("listKind")) {
      const rawListKind = readOwnStringField(rawParams, "listKind");
      if (rawListKind !== "simple-checklist" && rawListKind !== "task-list") {
        return { kind: "err", code: "invalid_request" };
      }
      params.listKind = rawListKind;
    }
  } else if (rawMethod === "notes.update") {
    if (!hasExactKeys(paramKeys, ["id", "expectedRevision", "patch"])) {
      return { kind: "err", code: "invalid_request" };
    }
    const rawNoteId = readOwnStringField(rawParams, "id");
    const rawRevision = readOwnStringField(rawParams, "expectedRevision");
    const rawPatch = readOwnObjectField(rawParams, "patch");
    if (
      !isBoundedRpcIdentifier(rawNoteId) ||
      !isRevisionToken(rawRevision) ||
      rawPatch === undefined
    ) {
      return { kind: "err", code: "invalid_request" };
    }

    const patchKeys = Object.keys(rawPatch);
    if (patchKeys.length === 0) return { kind: "err", code: "invalid_request" };
    const patch = objectCreate(null) as Record<string, unknown>;
    for (const key of patchKeys) {
      if (
        key !== "title" &&
        key !== "content" &&
        key !== "notebookId" &&
        key !== "tags" &&
        key !== "pinned" &&
        key !== "favorite" &&
        key !== "listKind"
      ) {
        return { kind: "err", code: "invalid_request" };
      }
      const value = readOwnDataField(rawPatch, key);
      if (value === undefined) return { kind: "err", code: "invalid_request" };
      if (key === "title") {
        if (!isBoundedRpcText(value, STAGE5_RPC_LIMITS.maxTitleBytes)) {
          return { kind: "err", code: "invalid_request" };
        }
      } else if (key === "content") {
        if (!isBoundedRpcText(value, STAGE5_RPC_LIMITS.maxQueryBytes)) {
          return { kind: "err", code: "invalid_request" };
        }
      } else if (key === "notebookId") {
        if (!isBoundedRpcIdentifier(value)) return { kind: "err", code: "invalid_request" };
      } else if (key === "tags") {
        const cleanTags = normaliseRpcTags(value);
        if (cleanTags === undefined) return { kind: "err", code: "invalid_request" };
        patch.tags = cleanTags;
        continue;
      } else if (key === "listKind") {
        if (value !== "simple-checklist" && value !== "task-list") {
          return { kind: "err", code: "invalid_request" };
        }
      } else if (typeof value !== "boolean") {
        return { kind: "err", code: "invalid_request" };
      }
      patch[key] = value;
    }
    objectFreeze(patch);
    params = objectCreate(null) as Record<string, unknown>;
    params.id = rawNoteId;
    params.expectedRevision = rawRevision;
    params.patch = patch;
  } else if (
    rawMethod === "notes.delete" ||
    rawMethod === "notes.locked_note_proof" ||
    rawMethod === "notes.path_diagnostic"
  ) {
    const hasPath = hasExactKeys(paramKeys, ["path"]);
    const hasExplicitTitle =
      hasExactKeys(paramKeys, ["noteTitle"]) ||
      hasExactKeys(paramKeys, ["notebookPath", "noteTitle"]);
    if (!hasPath && !hasExplicitTitle) {
      return { kind: "err", code: "invalid_request" };
    }
    params = objectCreate(null) as Record<string, unknown>;
    if (hasPath) {
      const rawPath = readOwnStringField(rawParams, "path");
      if (!isBoundedRpcText(rawPath, STAGE5_RPC_LIMITS.maxQueryBytes)) {
        return { kind: "err", code: "invalid_request" };
      }
      params.path = rawPath;
    } else {
      const rawTitle = readOwnStringField(rawParams, "noteTitle");
      const rawNotebookPath = readOwnStringField(rawParams, "notebookPath");
      if (
        !isBoundedRpcText(rawTitle, STAGE5_RPC_LIMITS.maxTitleBytes) ||
        (paramKeys.length === 2 &&
          !isBoundedRpcText(rawNotebookPath, STAGE5_RPC_LIMITS.maxQueryBytes))
      ) {
        return { kind: "err", code: "invalid_request" };
      }
      params.noteTitle = rawTitle;
      if (paramKeys.length === 2) params.notebookPath = rawNotebookPath;
    }
  } else if (rawMethod === "notes.sync") {
    if (!hasExactKeys(paramKeys, [])) return { kind: "err", code: "invalid_request" };
    params = objectCreate(null) as Record<string, unknown>;
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

/** Markdown fragments may contain structural whitespace; other controls remain invalid. */
function hasDisallowedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const revisionTokenPattern = /^rev_[0-9a-f]{32}$/;
const APPEND_UPDATE_ERROR_CODES = [
  "stale_revision",
  "conflict",
  "vault_locked",
  "sync_failed",
] as const;
type AppendUpdateErrorCode = (typeof APPEND_UPDATE_ERROR_CODES)[number];

function isRevisionToken(value: string | undefined): value is string {
  return value !== undefined && revisionTokenPattern.test(value);
}

function isBoundedRpcText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxBytes &&
    bufferByteLength(value, "utf8") <= maxBytes &&
    !hasControlCharacter(value)
  );
}

function isBoundedRpcIdentifier(value: unknown): value is string {
  return isBoundedRpcText(value, STAGE5_RPC_LIMITS.maxIdentifierBytes);
}

function readOwnDataField(record: Record<string, unknown>, key: string): unknown | undefined {
  try {
    const descriptor = objectGetOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function normaliseRpcTags(value: unknown): readonly string[] | undefined {
  try {
    if (!arrayIsArray(value)) return undefined;
    const lengthDescriptor = objectGetOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !numberIsFinite(lengthDescriptor.value) ||
      mathFloor(lengthDescriptor.value) !== lengthDescriptor.value ||
      lengthDescriptor.value <= 0 ||
      lengthDescriptor.value > 16
    ) {
      return undefined;
    }
    const tags: string[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const entry = readOwnDataField(value as unknown as Record<string, unknown>, String(index));
      if (!isBoundedRpcIdentifier(entry)) return undefined;
      tags.push(entry);
    }
    objectSetPrototypeOf(tags, null);
    return objectFreeze(tags);
  } catch {
    return undefined;
  }
}

function mapRuntimeError(error: unknown, id: string): RpcAnyResponseEnvelope | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  const code = readOwnStringField(error as Record<string, unknown>, "code");
  if (code === undefined || !(APPEND_UPDATE_ERROR_CODES as readonly string[]).includes(code)) {
    return undefined;
  }
  return buildErrorEnvelope(id, code as AppendUpdateErrorCode);
}

async function runAuthorizedRpcMethod(
  request: RpcRequest,
  runtime: RpcHandlerRuntimeLike,
  id: string,
): Promise<RpcAnyResponseEnvelope> {
  switch (request.method) {
    case "notes.search":
      return runNotesSearch(request, runtime, id);
    case "notes.status":
      return runNotesStatus(request, runtime, id);
    case "notes.list_notebooks":
      return runNotesListNotebooks(request, runtime, id);
    case "notes.get":
      return runNotesGet(request, runtime, id);
    case "notes.create":
      return runNotesCreate(request, runtime, id);
    case "notes.append":
      return runNotesAppend(request, runtime, id);
    case "notes.update":
      return runNotesUpdate(request, runtime, id);
    case "notes.delete":
      return runNotesDelete(request, runtime, id);
    case "notes.locked_note_proof":
      return runLockedNoteProof(request, runtime, id);
    case "notes.path_diagnostic":
      return runPathDiagnostic(request, runtime, id);
    case "notes.sync":
      return runNotesSync(request, runtime, id);
    // T04 — the MCP endpoint does not reach this branch for operator
    // methods: the structural allowlist refuses them with
    // `invalid_request` first, and the check above refuses them again
    // if that allowlist is ever widened.  Kept as the final
    // defence-in-depth refusal.
    case "notes.get-view":
    case "notes.edit-preimage":
    case "notes.apply-edit":
    case "notes.apply-undo":
    case "notes.operation-status":
    case "notes.operation-list":
    case "notes.browse":
    case "notes.search-operator":
      return buildErrorEnvelope(id, "permission_denied");
  }
}

type SettingsContextResolution =
  | {
      readonly ok: true;
      readonly context: ServicePolicySettingsContext;
      readonly note: Record<string, unknown>;
    }
  | { readonly ok: false; readonly code: "not_found" | "service_unavailable" };

async function resolveNoteSettingsContext(
  noteId: string,
  runtime: RpcHandlerRuntimeLike,
): Promise<SettingsContextResolution> {
  const fn = readRuntimeMethod(runtime, "noteMetadata");
  if (fn === undefined) return { ok: false, code: "service_unavailable" };

  let raw: unknown;
  try {
    raw = await reflectApply(fn, runtime, [noteId]);
  } catch {
    return { ok: false, code: "service_unavailable" };
  }
  if (raw === undefined) return { ok: false, code: "not_found" };
  const note = normaliseNoteMetadata(raw);
  if (note === undefined) return { ok: false, code: "service_unavailable" };

  const notebookId = readOwnStringField(note, "notebookId");
  const noteTitle = readOwnStringField(note, "title");
  if (notebookId === undefined || noteTitle === undefined) {
    return { ok: false, code: "not_found" };
  }
  let notebookPath = resolveTrustedNotebookPath(runtime, notebookId);
  if (notebookPath === undefined) {
    const refreshResolver = readRuntimeMethod(runtime, "resolveNotebookPath");
    if (refreshResolver !== undefined) {
      try {
        const refreshedPath = await reflectApply(refreshResolver, runtime, [notebookId]);
        if (typeof refreshedPath === "string") notebookPath = refreshedPath;
      } catch {
        return { ok: false, code: "not_found" };
      }
    }
  }
  if (notebookPath === undefined) return { ok: false, code: "not_found" };

  return {
    ok: true,
    context: { notebookPath, noteTitle },
    note,
  };
}

type CreateSettingsContextResolution =
  | { readonly ok: true; readonly context: ServicePolicySettingsContext }
  | { readonly ok: false; readonly code: "not_found" };

async function resolveCreateSettingsContext(
  notebookId: string | undefined,
  runtime: RpcHandlerRuntimeLike,
): Promise<CreateSettingsContextResolution> {
  // A notebook-less create has no note-specific context.  The evaluator
  // receives its empty context so the configured default still applies.
  if (notebookId === undefined) return { ok: true, context: {} };
  let notebookPath = resolveTrustedNotebookPath(runtime, notebookId);
  if (notebookPath === undefined) {
    const refreshResolver = readRuntimeMethod(runtime, "resolveNotebookPath");
    if (refreshResolver !== undefined) {
      try {
        const refreshedPath = await reflectApply(refreshResolver, runtime, [notebookId]);
        if (typeof refreshedPath === "string") notebookPath = refreshedPath;
      } catch {
        return { ok: false, code: "not_found" };
      }
    }
  }
  if (notebookPath === undefined || hasControlCharacter(notebookPath)) {
    return { ok: false, code: "not_found" };
  }
  return { ok: true, context: { notebookPath } };
}

function resolveTrustedNotebookPath(
  runtime: RpcHandlerRuntimeLike,
  notebookId: string,
): string | undefined {
  try {
    const runtimeDescriptor = objectGetOwnPropertyDescriptor(runtime, "notebookIndex");
    if (
      runtimeDescriptor === undefined ||
      !("value" in runtimeDescriptor) ||
      runtimeDescriptor.value === null ||
      typeof runtimeDescriptor.value !== "object"
    ) {
      return undefined;
    }
    const index = runtimeDescriptor.value as object;
    const resolverDescriptor = objectGetOwnPropertyDescriptor(index, "resolvePath");
    if (
      resolverDescriptor === undefined ||
      !("value" in resolverDescriptor) ||
      typeof resolverDescriptor.value !== "function"
    ) {
      return undefined;
    }
    const path = reflectApply(resolverDescriptor.value, index, [notebookId]);
    if (typeof path !== "string" || path.length === 0 || hasControlCharacter(path))
      return undefined;
    return path;
  } catch {
    return undefined;
  }
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

async function runNotesCreate(
  request: RpcNotesCreateRequest,
  runtime: RpcHandlerRuntimeLike,
  id: string,
): Promise<RpcAnyResponseEnvelope> {
  const fn = readRuntimeMethod(runtime, "createNote");
  if (fn === undefined) return buildErrorEnvelope(id, "service_unavailable");

  const commandRecord = objectCreate(null) as Record<string, unknown>;
  commandRecord.title = request.params.title;
  commandRecord.content = request.params.content;
  if (request.params.notebookId !== undefined) {
    commandRecord.notebookId = request.params.notebookId;
  }
  // Forward the optional listKind selector verbatim — the contract
  // plan defaults it to `simple-checklist` when omitted so the wire
  // surface never sees `undefined`.
  if (request.params.listKind !== undefined) {
    commandRecord.listKind = request.params.listKind;
  }
  const command = objectFreeze(commandRecord) as unknown as CreateNoteCommand;

  let raw: unknown;
  try {
    raw = await reflectApply(fn, runtime, [command]);
  } catch {
    return buildErrorEnvelope(id, "service_unavailable");
  }

  const result = normaliseCreatedNoteResult(raw);
  if (result === undefined) return buildErrorEnvelope(id, "service_unavailable");
  return buildResultSuccessEnvelope(id, result);
}

async function runNotesAppend(
  request: RpcNotesAppendRequest,
  runtime: RpcHandlerRuntimeLike,
  id: string,
): Promise<RpcAnyResponseEnvelope> {
  const fn = readRuntimeMethod(runtime, "appendNote");
  if (fn === undefined) return buildErrorEnvelope(id, "service_unavailable");

  const commandRecord = objectCreate(null) as Record<string, unknown>;
  commandRecord.id = request.params.id;
  commandRecord.markdownFragment = request.params.markdownFragment;
  commandRecord.expectedRevision = request.params.expectedRevision;
  if (request.params.listKind !== undefined) {
    commandRecord.listKind = request.params.listKind;
  }
  const command = objectFreeze(commandRecord) as unknown as AppendNoteCommand;

  let raw: unknown;
  try {
    raw = await reflectApply(fn, runtime, [command]);
  } catch (error) {
    return mapRuntimeError(error, id) ?? buildErrorEnvelope(id, "service_unavailable");
  }
  const result = normaliseAppendedNoteResult(raw);
  if (result === undefined) return buildErrorEnvelope(id, "service_unavailable");
  return buildResultSuccessEnvelope(id, result);
}

async function runNotesUpdate(
  request: RpcNotesUpdateRequest,
  runtime: RpcHandlerRuntimeLike,
  id: string,
): Promise<RpcAnyResponseEnvelope> {
  const fn = readRuntimeMethod(runtime, "updateNote");
  if (fn === undefined) return buildErrorEnvelope(id, "service_unavailable");

  const patchRecord = objectCreate(null) as Record<string, unknown>;
  const parsedPatch = request.params.patch;
  for (const field of [
    "title",
    "content",
    "notebookId",
    "tags",
    "pinned",
    "favorite",
    "listKind",
  ] as const) {
    const value = readOwnDataField(parsedPatch as Record<string, unknown>, field);
    if (value !== undefined) patchRecord[field] = value;
  }
  const commandRecord = objectCreate(null) as Record<string, unknown>;
  commandRecord.id = request.params.id;
  commandRecord.expectedRevision = request.params.expectedRevision;
  commandRecord.patch = objectFreeze(patchRecord);
  const command = objectFreeze(commandRecord) as unknown as UpdateNoteCommand;

  let raw: unknown;
  try {
    raw = await reflectApply(fn, runtime, [command]);
  } catch (error) {
    return mapRuntimeError(error, id) ?? buildErrorEnvelope(id, "service_unavailable");
  }
  const result = normaliseUpdatedNoteResult(raw);
  if (result === undefined) return buildErrorEnvelope(id, "service_unavailable");
  return buildResultSuccessEnvelope(id, result);
}

function exactNotePathInput(params: RpcNotesDeleteRequest["params"]): ExactNotePathInput {
  return "path" in params ? params.path : params;
}

async function runNotesDelete(
  request: RpcNotesDeleteRequest,
  runtime: RpcHandlerRuntimeLike,
  id: string,
): Promise<RpcAnyResponseEnvelope> {
  const fn = readRuntimeMethod(runtime, "deleteNote");
  const resolvePath = readRuntimeMethod(runtime, "resolveNotePath");
  if (fn === undefined || resolvePath === undefined)
    return buildErrorEnvelope(id, "service_unavailable");
  const target = exactNotePathInput(request.params);
  let resolution: ExactNotePathResolution;
  try {
    resolution = (await reflectApply(resolvePath, runtime, [target])) as ExactNotePathResolution;
  } catch (error) {
    if (error instanceof ExactNotePathError) {
      if (error.code === "invalid_path" || error.code === "ambiguous") {
        return buildErrorEnvelope(id, "invalid_request");
      }
      if (error.code === "not_found") return buildErrorEnvelope(id, "not_found");
      return buildErrorEnvelope(id, "service_unavailable");
    }
    return buildErrorEnvelope(id, "service_unavailable");
  }
  const commandRecord = objectCreate(null) as Record<string, unknown>;
  commandRecord.id = resolution.id;
  commandRecord.expectedRevision = resolution.expectedRevision;
  const command = objectFreeze(commandRecord) as unknown as DeleteNoteCommand;
  let raw: unknown;
  try {
    raw = await reflectApply(fn, runtime, [command]);
  } catch (error) {
    return mapRuntimeError(error, id) ?? buildErrorEnvelope(id, "service_unavailable");
  }
  if (raw === null || typeof raw !== "object" || arrayIsArray(raw)) {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  const record = raw as Record<string, unknown>;
  const operation = readOwnStringField(record, "operation");
  const noteId = readOwnStringField(record, "id");
  const localCommitted = readOwnBooleanField(record, "localCommitted");
  const remoteSynced = readOwnBooleanField(record, "remoteSynced");
  const pendingSync = readOwnBooleanField(record, "pendingSync");
  if (
    operation !== "delete" ||
    noteId === undefined ||
    noteId !== resolution.id ||
    localCommitted !== true ||
    remoteSynced !== false ||
    pendingSync !== true ||
    noteId.length === 0 ||
    noteId.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    bufferByteLength(noteId, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    hasControlCharacter(noteId)
  ) {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  const result = objectFreeze(
    objectCreate(null, {
      kind: { value: "delete", enumerable: true, configurable: false, writable: false },
      id: { value: noteId, enumerable: true, configurable: false, writable: false },
    }),
  ) as RpcDeleteNoteResult;
  return buildResultSuccessEnvelope(id, result);
}

async function runLockedNoteProof(
  request: RpcNotesLockedNoteProofRequest,
  runtime: RpcHandlerRuntimeLike,
  id: string,
): Promise<RpcAnyResponseEnvelope> {
  const fn = readRuntimeMethod(runtime, "lockedNoteProof");
  if (fn === undefined) return buildErrorEnvelope(id, "service_unavailable");
  const target = exactNotePathInput(request.params);
  let raw: unknown;
  try {
    raw = await reflectApply(fn, runtime, [target]);
  } catch {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  if (raw === null || typeof raw !== "object" || arrayIsArray(raw)) {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  const record = raw as Record<string, unknown>;
  const kind = readOwnStringField(record, "kind");
  const pathBytes = readOwnNumberField(record, "pathBytes");
  const read = readOwnStringField(record, "read");
  const update = readOwnStringField(record, "update");
  const remove = readOwnStringField(record, "delete");
  const codes = ["vault_locked", "ok", "not_found", "permission_denied", "service_unavailable"];
  if (
    kind !== "locked_note_proof" ||
    pathBytes === undefined ||
    !Number.isSafeInteger(pathBytes) ||
    pathBytes < 0 ||
    pathBytes > STAGE5_RPC_LIMITS.maxQueryBytes ||
    read === undefined ||
    update === undefined ||
    remove === undefined ||
    !codes.includes(read) ||
    !codes.includes(update) ||
    !codes.includes(remove)
  ) {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  const result = objectFreeze(
    objectCreate(null, {
      kind: { value: "locked_note_proof", enumerable: true, configurable: false, writable: false },
      pathBytes: { value: pathBytes, enumerable: true, configurable: false, writable: false },
      read: { value: read, enumerable: true, configurable: false, writable: false },
      update: { value: update, enumerable: true, configurable: false, writable: false },
      delete: { value: remove, enumerable: true, configurable: false, writable: false },
    }),
  ) as RpcLockedNoteProofResult;
  return buildResultSuccessEnvelope(id, result);
}

async function runPathDiagnostic(
  request: RpcNotesPathDiagnosticRequest,
  runtime: RpcHandlerRuntimeLike,
  id: string,
): Promise<RpcAnyResponseEnvelope> {
  const fn = readRuntimeMethod(runtime, "pathDiagnostic");
  if (fn === undefined) return buildErrorEnvelope(id, "service_unavailable");
  const target = exactNotePathInput(request.params);
  let raw: unknown;
  try {
    raw = await reflectApply(fn, runtime, [target]);
  } catch {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  if (raw === null || typeof raw !== "object" || arrayIsArray(raw)) {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  const record = raw as Record<string, unknown>;
  const kind = readOwnStringField(record, "kind");
  const pathBytes = readOwnNumberField(record, "pathBytes");
  const title = readOwnStringField(record, "title");
  const notebook = readOwnStringField(record, "notebook");
  const directMembership = readOwnStringField(record, "directMembership");
  const recursiveMembership = readOwnStringField(record, "recursiveMembership");
  const revision = readOwnStringField(record, "revision");
  const contentType = readOwnStringField(record, "contentType");
  const htmlPrefix = readOwnStringField(record, "htmlPrefix");
  const simpleChecklist = readOwnStringField(record, "simpleChecklist");
  const taskList = readOwnStringField(record, "taskList");
  const literalMarkdown = readOwnStringField(record, "literalMarkdown");
  const titleStatuses = ["none", "one", "multiple", "unavailable"];
  const stageStatuses = ["present", "absent", "unavailable", "not_applicable"];
  const revisionStatuses = ["valid", "invalid", "unavailable", "not_applicable"];
  if (
    kind !== "path_diagnostic" ||
    pathBytes === undefined ||
    !Number.isSafeInteger(pathBytes) ||
    pathBytes < 0 ||
    pathBytes > STAGE5_RPC_LIMITS.maxQueryBytes ||
    title === undefined ||
    !titleStatuses.includes(title) ||
    notebook === undefined ||
    !stageStatuses.includes(notebook) ||
    directMembership === undefined ||
    !stageStatuses.includes(directMembership) ||
    recursiveMembership === undefined ||
    !stageStatuses.includes(recursiveMembership) ||
    revision === undefined ||
    !revisionStatuses.includes(revision) ||
    contentType === undefined ||
    !["tiptap", "other", "unavailable"].includes(contentType) ||
    htmlPrefix === undefined ||
    !stageStatuses.slice(0, 3).includes(htmlPrefix) ||
    simpleChecklist === undefined ||
    !stageStatuses.slice(0, 3).includes(simpleChecklist) ||
    taskList === undefined ||
    !stageStatuses.slice(0, 3).includes(taskList) ||
    literalMarkdown === undefined ||
    !stageStatuses.slice(0, 3).includes(literalMarkdown)
  ) {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  const result = objectFreeze(
    objectCreate(null, {
      kind: { value: "path_diagnostic", enumerable: true, configurable: false, writable: false },
      pathBytes: { value: pathBytes, enumerable: true, configurable: false, writable: false },
      title: { value: title, enumerable: true, configurable: false, writable: false },
      notebook: { value: notebook, enumerable: true, configurable: false, writable: false },
      directMembership: {
        value: directMembership,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      recursiveMembership: {
        value: recursiveMembership,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      revision: { value: revision, enumerable: true, configurable: false, writable: false },
      contentType: { value: contentType, enumerable: true, configurable: false, writable: false },
      htmlPrefix: { value: htmlPrefix, enumerable: true, configurable: false, writable: false },
      simpleChecklist: {
        value: simpleChecklist,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      taskList: {
        value: taskList,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      literalMarkdown: {
        value: literalMarkdown,
        enumerable: true,
        configurable: false,
        writable: false,
      },
    }),
  ) as RpcNotesPathDiagnosticResult;
  return buildResultSuccessEnvelope(id, result);
}

async function runNotesSync(
  _request: RpcNotesSyncRequest,
  runtime: RpcHandlerRuntimeLike,
  id: string,
): Promise<RpcAnyResponseEnvelope> {
  const fn = readRuntimeMethod(runtime, "requestSync");
  if (fn === undefined) return buildErrorEnvelope(id, "service_unavailable");

  let raw: unknown;
  try {
    raw = await reflectApply(fn, runtime, []);
  } catch (error) {
    return mapRuntimeError(error, id) ?? buildErrorEnvelope(id, "service_unavailable");
  }
  if (raw === null || typeof raw !== "object" || arrayIsArray(raw)) {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  const record = raw as Record<string, unknown>;
  const status = readOwnStringField(record, "status");
  const pendingSync = readOwnBooleanField(record, "pendingSync");
  const attempts = readOwnNumberField(record, "attempts");
  if (
    (status !== "idle" && status !== "synced" && status !== "failed") ||
    pendingSync === undefined ||
    attempts === undefined ||
    !Number.isSafeInteger(attempts) ||
    attempts < 0 ||
    attempts > 8
  ) {
    return buildErrorEnvelope(id, "service_unavailable");
  }
  if (status === "failed") return buildErrorEnvelope(id, "sync_failed");
  const result = objectFreeze(
    objectCreate(null, {
      kind: { value: "sync", enumerable: true, configurable: false, writable: false },
      status: { value: status, enumerable: true, configurable: false, writable: false },
      pendingSync: {
        value: pendingSync,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      attempts: { value: attempts, enumerable: true, configurable: false, writable: false },
    }),
  ) as RpcSyncResult;
  return buildResultSuccessEnvelope(id, result);
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
  resolvedNote?: Record<string, unknown>,
): Promise<RpcAnyResponseEnvelope> {
  let note = resolvedNote;
  if (note === undefined) {
    const fn = readRuntimeMethod(runtime, "noteMetadata");
    if (fn === undefined) return buildErrorEnvelope(id, "service_unavailable");
    let raw: unknown;
    try {
      raw = await reflectApply(fn, runtime, [request.params.id]);
    } catch {
      return buildErrorEnvelope(id, "service_unavailable");
    }
    if (raw === undefined) return buildErrorEnvelope(id, "not_found");
    note = normaliseNoteMetadata(raw);
    if (note === undefined) return buildErrorEnvelope(id, "service_unavailable");
  }
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
  key:
    | "status"
    | "listNotebooks"
    | "noteMetadata"
    | "createNote"
    | "appendNote"
    | "updateNote"
    | "deleteNote"
    | "resolveNotePath"
    | "resolveNotebookPath"
    | "lockedNoteProof"
    | "pathDiagnostic"
    | "requestSync",
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

function normaliseCreatedNoteResult(value: unknown): RpcCreatedNoteResult | undefined {
  if (value === null || typeof value !== "object" || arrayIsArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (readOwnStringField(record, "operation") !== "create") return undefined;
  const noteId = readOwnStringField(record, "id");
  const titleBytes = readOwnNumberField(record, "titleBytes");
  const contentBytes = readOwnNumberField(record, "contentBytes");
  if (
    noteId === undefined ||
    noteId.length === 0 ||
    noteId.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    bufferByteLength(noteId, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    hasControlCharacter(noteId) ||
    titleBytes === undefined ||
    contentBytes === undefined
  ) {
    return undefined;
  }
  return objectFreeze(
    objectCreate(null, {
      kind: { value: "create", enumerable: true, configurable: false, writable: false },
      id: { value: noteId, enumerable: true, configurable: false, writable: false },
      titleBytes: {
        value: titleBytes,
        enumerable: true,
        configurable: false,
        writable: false,
      },
      contentBytes: {
        value: contentBytes,
        enumerable: true,
        configurable: false,
        writable: false,
      },
    }),
  ) as RpcCreatedNoteResult;
}

function normaliseAppendedNoteResult(value: unknown): RpcAppendNoteResult | undefined {
  if (value === null || typeof value !== "object" || arrayIsArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (readOwnStringField(record, "operation") !== "append") return undefined;
  const id = readOwnStringField(record, "id");
  const fragmentBytes = readOwnNumberField(record, "contentBytes");
  if (
    id === undefined ||
    id.length === 0 ||
    id.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    bufferByteLength(id, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    hasControlCharacter(id) ||
    fragmentBytes === undefined
  ) {
    return undefined;
  }
  return objectFreeze(
    objectCreate(null, {
      kind: { value: "append", enumerable: true, configurable: false, writable: false },
      id: { value: id, enumerable: true, configurable: false, writable: false },
      fragmentBytes: {
        value: fragmentBytes,
        enumerable: true,
        configurable: false,
        writable: false,
      },
    }),
  ) as RpcAppendNoteResult;
}

function normaliseUpdatedNoteResult(value: unknown): RpcUpdateNoteResult | undefined {
  if (value === null || typeof value !== "object" || arrayIsArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (readOwnStringField(record, "operation") !== "update") return undefined;
  const id = readOwnStringField(record, "id");
  const fields = readOwnDataField(record, "appliedFields");
  if (
    id === undefined ||
    id.length === 0 ||
    id.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    bufferByteLength(id, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    hasControlCharacter(id) ||
    !arrayIsArray(fields) ||
    fields.length === 0 ||
    fields.length > 6
  ) {
    return undefined;
  }
  const allowed = ["title", "content", "notebookId", "tags", "pinned", "favorite"];
  const cleanFields: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = readOwnDataField(fields as unknown as Record<string, unknown>, String(index));
    if (typeof field !== "string" || !allowed.includes(field) || cleanFields.includes(field)) {
      return undefined;
    }
    cleanFields.push(field);
  }
  objectSetPrototypeOf(cleanFields, null);
  objectFreeze(cleanFields);
  const contentBytes = readOwnNumberField(record, "contentBytes");
  const result = objectCreate(null) as Record<string, unknown>;
  result.kind = "update";
  result.id = id;
  result.appliedFields = cleanFields;
  if (contentBytes !== undefined) result.contentBytes = contentBytes;
  return objectFreeze(result) as unknown as RpcUpdateNoteResult;
}

function normaliseNoteMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || arrayIsArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = readOwnStringField(record, "id");
  const title = readOwnStringField(record, "title");
  let revision: string | undefined;
  try {
    const revisionDescriptor = objectGetOwnPropertyDescriptor(record, "revision");
    if (revisionDescriptor !== undefined) {
      if (!("value" in revisionDescriptor) || typeof revisionDescriptor.value !== "string") {
        return undefined;
      }
      revision = revisionDescriptor.value;
    }
  } catch {
    return undefined;
  }
  if (
    id === undefined ||
    title === undefined ||
    id.length === 0 ||
    title.length === 0 ||
    id.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    title.length > STAGE5_RPC_LIMITS.maxTitleBytes ||
    hasControlCharacter(id) ||
    hasControlCharacter(title) ||
    (revision !== undefined && !isRevisionToken(revision))
  )
    return undefined;
  const output = objectCreate(null) as Record<string, unknown>;
  output.id = id;
  output.title = title;
  if (revision !== undefined) output.revision = revision;
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
    | { readonly kind: "note"; readonly note: Record<string, unknown> }
    | RpcCreatedNoteResult
    | RpcAppendNoteResult
    | RpcUpdateNoteResult
    | RpcDeleteNoteResult
    | RpcLockedNoteProofResult
    | RpcNotesPathDiagnosticResult
    | RpcSyncResult,
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
    | "stale_revision"
    | "conflict"
    | "sync_failed"
    | "vault_locked"
    | "not_found",
): RpcAnyResponseEnvelope {
  const messages = {
    invalid_request: "Invalid request",
    permission_denied: "Permission denied",
    service_unavailable: "Service unavailable",
    stale_revision: "Stale revision",
    conflict: "Conflict",
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
