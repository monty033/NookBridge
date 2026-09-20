/**
 * Stage 5 Task 4 — pure closed framed RPC protocol boundary.
 *
 * This module is the pure wire-protocol layer that sits in front of the
 * future `nookd` Unix-socket daemon.  It is intentionally runtime-free:
 *
 *   - No filesystem, network, daemon, socket, auth, or Notesnook import.
 *   - No state.  Every call is a pure function of its input bytes /
 *     candidate envelope.
 *   - Length-prefixed (4-byte big-endian) framing.
 *   - Bounded frame / query / response / hit counts via
 *     {@link STAGE5_RPC_LIMITS}.
 *   - Parsed requests are frozen objects with a null prototype so a
 *     hostile proxy / inherited getter cannot smuggle data back out.
 *   - Duplicate JSON keys are rejected at every level (rather than
 *     silently last-wins).
 *   - Errors are categorical, chain-free (`cause` and `__context__` are
 *     explicitly cleared), and never echo request values, raw parser
 *     exceptions, paths, or unknown method names.
 *   - The success surface is title-only: notes carry only `title` —
 *     never `id`, never `body`, never `notebookId`, never anything else.
 *
 * This file is the *boundary*.  The future `nookd` server, the MCP
 * proxy, the permission engine, and the live Notesnook runtime are
 * deliberately NOT imported here.  Everything the protocol needs to
 * reject happens BEFORE any of those surfaces are touched.
 */

import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

import {
  NOTESNOOK_LIST_KINDS,
  type NotesnookListKind,
} from "../core/notesnook-write-list-intent.js";

// Capture every mutable intrinsic used by this closed boundary before any
// caller can pollute a shared prototype or static method.
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectSetPrototypeOf = Object.setPrototypeOf;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectDefineProperty = Object.defineProperty;
const objectKeys = Object.keys;
const objectHasOwnProperty = Object.prototype.hasOwnProperty;
const objectPrototype = Object.prototype;
const reflectOwnKeys = Reflect.ownKeys;
const reflectApply = Reflect.apply;
const arrayIsArray = Array.isArray;
const Uint8ArrayConstructor = Uint8Array;
const ErrorConstructor = Error;
const weakSetAdd = WeakSet.prototype.add;
const weakSetHas = WeakSet.prototype.has;
const weakMapSet = WeakMap.prototype.set;
const weakMapGet = WeakMap.prototype.get;
const jsonStringify = JSON.stringify;
const bufferFrom = Buffer.from;
const textDecoderDecode = TextDecoder.prototype.decode;
const stringCharCodeAt = String.prototype.charCodeAt;
const stringFromCodePoint = String.fromCodePoint;
const stringSlice = String.prototype.slice;
const numberFromString = Number;
const numberIsFinite = Number.isFinite;

// ---------------------------------------------------------------------------
// Published limits — frozen constants the rest of the protocol is bounded by.
// ---------------------------------------------------------------------------

export interface Stage5RpcLimits {
  readonly maxFrameBytes: number;
  readonly maxQueryBytes: number;
  readonly maxResponseBytes: number;
  readonly maxSearchHits: number;
  readonly maxTitleBytes: number;
  readonly maxIdentifierBytes: number;
}

/**
 * The published Stage 5 RPC bounds.
 *
 * Frame limits are deliberately conservative for a single-method search
 * surface: a search request only needs to carry a small `query` string
 * plus a few identifier bytes, and the title-only success envelope only
 * needs to carry a short `title` per hit.
 *
 * `maxFrameBytes` / `maxResponseBytes` are the byte budgets the parser
 * and serializer enforce BEFORE JSON parsing / allocation so a hostile
 * caller cannot force unbounded memory growth.  `maxQueryBytes`
 * bounds the parsed UTF-8 query string so a single multi-byte query
 * cannot smuggle arbitrary payload past a length check.  `maxTitleBytes`
 * bounds the UTF-8 byte length of each returned title (a hit title is
 * never expected to exceed a single short note title).
 *
 * `maxSearchHits` caps the number of hits a successful response may
 * carry.  This is enforced at the serializer boundary.
 *
 * These numbers are the contract; downstream callers may read them
 * directly but MUST NOT widen them without an explicit decision-record
 * amendment.
 */
const stage5RpcLimits = objectCreate(null) as {
  maxFrameBytes: number;
  maxQueryBytes: number;
  maxResponseBytes: number;
  maxSearchHits: number;
  maxTitleBytes: number;
  maxIdentifierBytes: number;
};
stage5RpcLimits.maxFrameBytes = 65_536;
stage5RpcLimits.maxQueryBytes = 512;
stage5RpcLimits.maxResponseBytes = 65_536;
stage5RpcLimits.maxSearchHits = 64;
stage5RpcLimits.maxTitleBytes = 256;
stage5RpcLimits.maxIdentifierBytes = 256;
export const STAGE5_RPC_LIMITS: Stage5RpcLimits = objectFreeze(stage5RpcLimits);

// ---------------------------------------------------------------------------
// Wire envelope shapes.
//
// These are the ONLY shapes the protocol accepts on the wire.  Any
// deviation is rejected categorically.
// ---------------------------------------------------------------------------

export interface RpcNotesSearchParams {
  readonly query: string;
}

export type RpcNotesStatusParams = Record<string, never>;
export type RpcNotesSyncParams = Record<string, never>;

export type RpcNotesListNotebooksParams = Record<string, never>;

export interface RpcNotesGetParams {
  readonly id: string;
}

/**
 * Bounded `notes.create` params.  The closed surface is exactly
 * `title`, `content`, the optional `notebookId`, and the optional
 * `listKind` selector.  Tags, MIME, attachments, color, pin state, and
 * every other upstream field are intentionally absent — they are
 * reachable only through future dedicated methods and never through
 * the bounded `notes.create` envelope.
 *
 * Title and content are bounded by the published
 * {@link STAGE5_RPC_LIMITS} cap (`maxTitleBytes`,
 * `maxQueryBytes` used as a generic content-byte cap).
 *
 * `listKind` is an optional selector between Notesnook's lightweight
 * `simple-checklist` HTML and the rich interactive `checklist` HTML.
 * Omitting the field preserves the existing behaviour (the codec
 * defaults to `simple-checklist`); setting it to anything outside the
 * closed set is rejected categorically with `invalid_request`.  The
 * selector is published in
 * `docs/notesnook-list-intent.md` (forthcoming) so callers know which
 * HTML shape each value emits.
 */
export interface RpcNotesCreateParams {
  readonly title: string;
  readonly content: string;
  readonly notebookId?: string;
  readonly listKind?: NotesnookListKind;
}

/**
 * Bounded `notes.append` params.  The closed surface is exactly
 * `id`, `markdownFragment`, `expectedRevision`, and the optional
 * `listKind` selector.  The revision is a well-formed opaque token
 * (the format is published by the Stage 4 write contract) — anything
 * else is rejected categorically.  Body, raw stored content,
 * internal flags, tag relations, and every other upstream field are
 * intentionally absent; they are reachable only through future
 * dedicated methods.
 */
export interface RpcNotesAppendParams {
  readonly id: string;
  readonly markdownFragment: string;
  readonly expectedRevision: string;
  readonly listKind?: NotesnookListKind;
}

/**
 * The closed set of patch field names the wire protocol
 * admits inside a `notes.update` envelope.  This is the
 * same allowlist the Stage 4 update contract publishes —
 * `deleted`, `locked`, `password`, `force`, `readonly`, and
 * every other field are outside the contract and fail closed
 * with `invalid_request`.
 */
export type RpcNotesUpdatePatchField =
  | "title"
  | "content"
  | "notebookId"
  | "tags"
  | "pinned"
  | "favorite";

/**
 * Bounded patch object for `notes.update`.  At least one field must
 * be present.  Values are bounded by the same Stage 5 limits the
 * create / append envelopes use.  `listKind` only changes the stored
 * representation when the patch also includes `content`; the contract
 * plan surfaces the resolved kind on the update plan only in that
 * case.
 */
export interface RpcNotesUpdatePatch {
  readonly title?: string;
  readonly content?: string;
  readonly notebookId?: string;
  readonly tags?: readonly string[];
  readonly pinned?: boolean;
  readonly favorite?: boolean;
  readonly listKind?: NotesnookListKind;
}

/**
 * Bounded `notes.update` params.  The closed surface is exactly
 * `id`, `expectedRevision`, and `patch`.  No other fields may
 * cross the wire.
 */
export interface RpcNotesUpdateParams {
  readonly id: string;
  readonly expectedRevision: string;
  readonly patch: RpcNotesUpdatePatch;
}

/** Backward-compatible slash-delimited exact path. */
export interface RpcNotesPathParams {
  readonly path: string;
}

/** Explicit exact-note address; `noteTitle` may contain `/`. */
export interface RpcNotesExplicitPathParams {
  readonly notebookPath?: string;
  readonly noteTitle: string;
}

export type RpcNotesDeleteParams = RpcNotesPathParams | RpcNotesExplicitPathParams;
export type RpcNotesLockedNoteProofParams = RpcNotesPathParams | RpcNotesExplicitPathParams;
export type RpcNotesPathDiagnosticParams = RpcNotesPathParams | RpcNotesExplicitPathParams;

// ---------------------------------------------------------------------------
// T04 — canonical operator RPC vocabulary.
//
// The frozen T00 operator vocabulary (notes.get-view, notes.edit-preimage,
// notes.apply-edit, notes.apply-undo, notes.create, notes.operation-status,
// notes.operation-list) is admitted on the wire but routed to a SEPARATE
// operator listener.  The MCP endpoint continues to reject every operator
// method categorically (no body, no edit, no undo) at the policy layer.
//
// The request / response shapes below are the CLOSED wire surfaces the
// operator listener forwards to the policy seam.  No body bytes are
// projected into the MCP endpoint; the MCP listener is unchanged and
// keeps its body-free contract for the four read methods.
// ---------------------------------------------------------------------------

/** Bounded opaque handle for the operator vocabulary (note id). */
export interface RpcOperatorNoteParams {
  readonly id: string;
}

/** Bounded opaque handle for `notes.operation-status`. */
export interface RpcOperatorOperationStatusParams {
  readonly operationHandle: string;
}

/** Bounded apply-edit params; canonical closed shape. */
export interface RpcOperatorApplyEditParams {
  readonly id: string;
  readonly expectedRevision: string;
  readonly markdown: string;
}

/** Bounded apply-undo params; canonical closed shape. */
export interface RpcOperatorApplyUndoParams {
  readonly id: string;
  readonly operationHandle: string;
  readonly expectedRevision: string;
}

export interface RpcOperatorPageParams {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RpcOperatorSearchParams extends RpcOperatorPageParams {
  readonly query: string;
}

/** Bounded operator discovery note projection. */
export interface RpcOperatorDiscoveryNote {
  readonly handle: string;
  readonly label: string;
  readonly bytes: number;
}

export interface RpcOperatorDiscoveryPageResult {
  readonly kind: "operator-page";
  readonly notes: ReadonlyArray<RpcOperatorDiscoveryNote>;
  readonly next: string | null;
}

/** The closed set of allowed RPC methods. */
export type RpcMethod =
  | "notes.search"
  | "notes.status"
  | "notes.list_notebooks"
  | "notes.get"
  | "notes.create"
  | "notes.append"
  | "notes.update"
  | "notes.delete"
  | "notes.locked_note_proof"
  | "notes.path_diagnostic"
  | "notes.sync"
  // T04 — canonical operator RPC vocabulary.  Operator methods live in
  // the SAME `RpcMethod` union (the parser is the wire contract); the
  // MCP endpoint rejects them categorically, and the operator listener
  // is the only surface that admits them.
  | "notes.get-view"
  | "notes.edit-preimage"
  | "notes.apply-edit"
  | "notes.apply-undo"
  | "notes.operation-status"
  | "notes.operation-list"
  | "notes.browse"
  | "notes.search-operator";

export interface RpcNotesSearchRequest {
  readonly id: string;
  readonly method: "notes.search";
  readonly params: RpcNotesSearchParams;
}

export interface RpcNotesStatusRequest {
  readonly id: string;
  readonly method: "notes.status";
  readonly params: RpcNotesStatusParams;
}

export interface RpcNotesListNotebooksRequest {
  readonly id: string;
  readonly method: "notes.list_notebooks";
  readonly params: RpcNotesListNotebooksParams;
}

export interface RpcNotesGetRequest {
  readonly id: string;
  readonly method: "notes.get";
  readonly params: RpcNotesGetParams;
}

export interface RpcNotesCreateRequest {
  readonly id: string;
  readonly method: "notes.create";
  readonly params: RpcNotesCreateParams;
}

export interface RpcNotesAppendRequest {
  readonly id: string;
  readonly method: "notes.append";
  readonly params: RpcNotesAppendParams;
}

export interface RpcNotesUpdateRequest {
  readonly id: string;
  readonly method: "notes.update";
  readonly params: RpcNotesUpdateParams;
}

export interface RpcNotesDeleteRequest {
  readonly id: string;
  readonly method: "notes.delete";
  readonly params: RpcNotesDeleteParams;
}

export interface RpcNotesLockedNoteProofRequest {
  readonly id: string;
  readonly method: "notes.locked_note_proof";
  readonly params: RpcNotesLockedNoteProofParams;
}

export interface RpcNotesPathDiagnosticRequest {
  readonly id: string;
  readonly method: "notes.path_diagnostic";
  readonly params: RpcNotesPathDiagnosticParams;
}

export interface RpcNotesSyncRequest {
  readonly id: string;
  readonly method: "notes.sync";
  readonly params: RpcNotesSyncParams;
}

// T04 — operator request shapes.
export interface RpcNotesGetViewRequest {
  readonly id: string;
  readonly method: "notes.get-view";
  readonly params: RpcOperatorNoteParams;
}
export interface RpcNotesEditPreimageRequest {
  readonly id: string;
  readonly method: "notes.edit-preimage";
  readonly params: RpcOperatorNoteParams;
}
export interface RpcNotesApplyEditRequest {
  readonly id: string;
  readonly method: "notes.apply-edit";
  readonly params: RpcOperatorApplyEditParams;
}
export interface RpcNotesApplyUndoRequest {
  readonly id: string;
  readonly method: "notes.apply-undo";
  readonly params: RpcOperatorApplyUndoParams;
}
export interface RpcNotesOperationStatusRequest {
  readonly id: string;
  readonly method: "notes.operation-status";
  readonly params: RpcOperatorOperationStatusParams;
}
export interface RpcNotesOperationListRequest {
  readonly id: string;
  readonly method: "notes.operation-list";
  readonly params: Record<string, never>;
}
export interface RpcNotesBrowseRequest {
  readonly id: string;
  readonly method: "notes.browse";
  readonly params: RpcOperatorPageParams;
}
export interface RpcNotesSearchOperatorRequest {
  readonly id: string;
  readonly method: "notes.search-operator";
  readonly params: RpcOperatorSearchParams;
}

export type RpcRequest =
  | RpcNotesSearchRequest
  | RpcNotesStatusRequest
  | RpcNotesListNotebooksRequest
  | RpcNotesGetRequest
  | RpcNotesCreateRequest
  | RpcNotesAppendRequest
  | RpcNotesUpdateRequest
  | RpcNotesDeleteRequest
  | RpcNotesLockedNoteProofRequest
  | RpcNotesPathDiagnosticRequest
  | RpcNotesSyncRequest
  // T04 — canonical operator RPC vocabulary.
  | RpcNotesGetViewRequest
  | RpcNotesEditPreimageRequest
  | RpcNotesApplyEditRequest
  | RpcNotesApplyUndoRequest
  | RpcNotesOperationStatusRequest
  | RpcNotesOperationListRequest
  | RpcNotesBrowseRequest
  | RpcNotesSearchOperatorRequest;

/**
 * The closed success-result shape for `notes.search`.  Notes are
 * title-only: `id`, `body`, `notebookId`, and any other metadata are
 * intentionally absent.
 */
export interface RpcSearchHit {
  readonly title: string;
}

export interface RpcSearchResult {
  readonly kind: "search";
  readonly notes: ReadonlyArray<RpcSearchHit>;
}

export interface RpcStatusResult {
  readonly kind: "status";
  readonly lastSynced: number;
  readonly hasUnsyncedChanges: boolean;
}

export interface RpcNotebookSummary {
  readonly id: string;
  readonly title: string;
  readonly dateCreated?: number;
  readonly dateModified?: number;
}

export interface RpcListNotebooksResult {
  readonly kind: "notebooks";
  readonly notebooks: ReadonlyArray<RpcNotebookSummary>;
}

export interface RpcNoteMetadata {
  readonly id: string;
  readonly title: string;
  readonly revision?: string;
  readonly dateCreated?: number;
  readonly dateModified?: number;
  readonly notebookId?: string;
  readonly pinned?: boolean;
  readonly favorite?: boolean;
  readonly localOnly?: boolean;
  readonly conflicted?: boolean;
  readonly locked?: boolean;
}

export interface RpcGetNoteResult {
  readonly kind: "note";
  readonly note: RpcNoteMetadata;
}

/**
 * The closed success-result shape for `notes.create`.  Only the
 * canonical note identifier and bounded byte counts cross the
 * boundary; the runtime's internal flags (localCommitted,
 * remoteSynced, pendingSync, operation, contentBytes flags, etc.)
 * are intentionally not projected.
 */
export interface RpcCreatedNoteResult {
  readonly kind: "create";
  readonly id: string;
  readonly titleBytes: number;
  readonly contentBytes: number;
}

/**
 * The closed success-result shape for `notes.append`.  Only the
 * canonical note identifier and the bounded fragment byte count
 * cross the boundary; raw fragment text, stored content, internal
 * flags, and revision details are intentionally not projected.
 */
export interface RpcAppendNoteResult {
  readonly kind: "append";
  readonly id: string;
  readonly fragmentBytes: number;
}

/**
 * The closed success-result shape for `notes.update`.  Only the
 * canonical note identifier, the sorted list of applied field
 * names, and the optional bounded content byte count cross the
 * boundary.  Raw patch values, internal flags, and revision
 * details are intentionally not projected.
 */
export interface RpcUpdateNoteResult {
  readonly kind: "update";
  readonly id: string;
  readonly appliedFields: ReadonlyArray<RpcNotesUpdatePatchField>;
  readonly contentBytes?: number;
}

/** The bounded success result for a single-note delete. */
export interface RpcDeleteNoteResult {
  readonly kind: "delete";
  readonly id: string;
}

export type RpcLockedNoteProofCode =
  | "vault_locked"
  | "ok"
  | "not_found"
  | "permission_denied"
  | "service_unavailable";

/** Closed, redacted result of the operator-only locked-note proof. */
export interface RpcLockedNoteProofResult {
  readonly kind: "locked_note_proof";
  readonly pathBytes: number;
  readonly read: RpcLockedNoteProofCode;
  readonly update: RpcLockedNoteProofCode;
  readonly delete: RpcLockedNoteProofCode;
}

export type RpcPathDiagnosticTitleStatus = "none" | "one" | "multiple" | "unavailable";
export type RpcPathDiagnosticStage = "present" | "absent" | "unavailable" | "not_applicable";
export type RpcPathDiagnosticRevision = "valid" | "invalid" | "unavailable" | "not_applicable";

export type RpcPathDiagnosticContentType = "tiptap" | "other" | "unavailable";
export type RpcPathDiagnosticContentMarker = "present" | "absent" | "unavailable";

/** Closed, redacted result of the operator-only exact-path diagnostic. */
export interface RpcNotesPathDiagnosticResult {
  readonly kind: "path_diagnostic";
  readonly pathBytes: number;
  readonly title: RpcPathDiagnosticTitleStatus;
  readonly notebook: RpcPathDiagnosticStage;
  readonly directMembership: RpcPathDiagnosticStage;
  readonly recursiveMembership: RpcPathDiagnosticStage;
  readonly revision: RpcPathDiagnosticRevision;
  readonly contentType: RpcPathDiagnosticContentType;
  readonly htmlPrefix: RpcPathDiagnosticContentMarker;
  readonly simpleChecklist: RpcPathDiagnosticContentMarker;
  readonly taskList: RpcPathDiagnosticContentMarker;
  readonly literalMarkdown: RpcPathDiagnosticContentMarker;
}

export interface RpcSyncResult {
  readonly kind: "sync";
  readonly status: "idle" | "synced";
  readonly pendingSync: boolean;
  readonly attempts: number;
}

// T04 — canonical operator RPC result shapes.  These are the closed
// envelopes the operator listener serialises; their bodies are
// bounded by the published wire limits (D9) and never include
// credentials, keys, raw stored content beyond the editor Markdown
// projection, or operator argv/env tokens.  The integration with
// the operator listener is the T05 handoff; the type definitions
// land here so the operator policy seam can be wired without
// widening `RpcResult`.
export interface RpcNotesGetViewResult {
  readonly kind: "view";
  readonly id: string;
  readonly revision: string;
  /** Bounded Markdown projection for the operator editor/view path. */
  readonly markdown: string;
  readonly contentBytes: number;
}

export interface RpcNotesEditPreimageResult {
  readonly kind: "preimage";
  readonly id: string;
  readonly revision: string;
  /** Trusted pre-edit Markdown projection captured before the editor opens. */
  readonly markdown: string;
  readonly contentBytes: number;
}

export interface RpcNotesApplyEditResult {
  readonly kind: "edit";
  readonly id: string;
  readonly appliedFields: ReadonlyArray<"content">;
  readonly revision: string;
  readonly contentBytes: number;
}

export interface RpcNotesApplyUndoResult {
  readonly kind: "undo";
  /**
   * Note handle, echoed only when the caller addressed one.  A bare
   * `notes undo` addresses the operation alone and the daemon must not
   * answer with the raw note id (D8), so this is omitted then.
   */
  readonly id?: string;
  readonly appliedFields: ReadonlyArray<"content">;
  readonly revision: string;
  readonly contentBytes: number;
}

export type RpcOperatorOperationState =
  | "prepared"
  | "committing"
  | "committed"
  | "undone"
  | "unresolved"
  | "aborted";

export interface RpcNotesOperationStatusResult {
  readonly kind: "operation-status";
  readonly operationHandle: string;
  readonly state: RpcOperatorOperationState;
  readonly id?: string;
}

export interface RpcNotesOperationListResult {
  readonly kind: "operation-list";
  readonly handles: ReadonlyArray<string>;
}

export type RpcResult =
  | RpcSearchResult
  | RpcStatusResult
  | RpcListNotebooksResult
  | RpcGetNoteResult
  | RpcCreatedNoteResult
  | RpcAppendNoteResult
  | RpcUpdateNoteResult
  | RpcDeleteNoteResult
  | RpcLockedNoteProofResult
  | RpcNotesPathDiagnosticResult
  | RpcSyncResult
  // T04 — canonical operator RPC result shapes.
  | RpcNotesGetViewResult
  | RpcNotesEditPreimageResult
  | RpcNotesApplyEditResult
  | RpcNotesApplyUndoResult
  | RpcNotesOperationStatusResult
  | RpcNotesOperationListResult
  | RpcOperatorDiscoveryPageResult;

export interface RpcSuccessEnvelope {
  readonly id: string;
  readonly ok: true;
  readonly result: RpcSearchResult;
}

export interface RpcAnySuccessEnvelope {
  readonly id: string;
  readonly ok: true;
  readonly result: RpcResult;
}

export interface RpcErrorEnvelopePayload {
  readonly code: RpcErrorCode;
  readonly message: string;
}

/** The only error categories that may cross the RPC response boundary. */
export type RpcErrorCode =
  | "invalid_request"
  | "permission_denied"
  | "service_unavailable"
  | "stale_revision"
  | "conflict"
  | "sync_failed"
  | "vault_locked"
  | "not_found";

/** Fixed, non-sensitive messages for the categorical RPC error vocabulary. */
const rpcErrorMessages = objectCreate(null) as Record<RpcErrorCode, string>;
rpcErrorMessages.invalid_request = "Invalid request";
rpcErrorMessages.permission_denied = "Permission denied";
rpcErrorMessages.service_unavailable = "Service unavailable";
rpcErrorMessages.stale_revision = "Stale revision";
rpcErrorMessages.conflict = "Conflict";
rpcErrorMessages.sync_failed = "Sync failed";
rpcErrorMessages.vault_locked = "Vault locked";
rpcErrorMessages.not_found = "Not found";
/**
 * The single source of truth for the categorical error vocabulary.
 *
 * `serializeRpcResponse` rejects any envelope whose `message` is not
 * exactly the fixed string for its `code`, so every producer (including
 * the operator handler) MUST derive its error message from this table
 * rather than inventing one.  Exporting it keeps that rule mechanical
 * instead of duplicated.
 */
export const RPC_ERROR_MESSAGES: Readonly<Record<RpcErrorCode, string>> =
  objectFreeze(rpcErrorMessages);

export interface RpcErrorEnvelope {
  readonly id: string;
  readonly ok: false;
  readonly error: RpcErrorEnvelopePayload;
}

export type RpcResponseEnvelope = RpcSuccessEnvelope | RpcErrorEnvelope;
export type RpcAnyResponseEnvelope = RpcAnySuccessEnvelope | RpcErrorEnvelope;

// ---------------------------------------------------------------------------
// Error type + predicate.
// ---------------------------------------------------------------------------

/**
 * Module-private set of protocol-owned Error instances.  Predicates key
 * off object identity rather than message matching so callers cannot
 * accidentally treat an arbitrary error as a protocol error.
 */
const RPC_PROTOCOL_ERRORS = new WeakSet<object>();
const RPC_PROTOCOL_ERROR_MESSAGES = new WeakMap<object, string>();

/**
 * Construct a categorical, chain-free protocol error.  `cause` and
 * `__context__` are explicitly cleared so a hostile parser exception
 * cannot smuggle data through the error chain.
 */
function rpcProtocolError(message: string): Error {
  const error = new ErrorConstructor(message);
  objectDefineProperty(error, "cause", { configurable: true, value: undefined });
  objectDefineProperty(error, "__context__", { configurable: true, value: undefined });
  objectDefineProperty(error, "name", { configurable: true, value: "RpcProtocolError" });
  reflectApply(weakSetAdd, RPC_PROTOCOL_ERRORS, [error]);
  reflectApply(weakMapSet, RPC_PROTOCOL_ERROR_MESSAGES, [error, message]);
  return error;
}

/**
 * True iff `value` is an Error instance produced by this module.  Used
 * by callers that want to distinguish protocol rejections from
 * upstream / runtime failures without parsing messages.
 */
export function isRpcProtocolError(value: unknown): value is Error {
  return (
    typeof value === "object" &&
    value !== null &&
    reflectApply(weakSetHas, RPC_PROTOCOL_ERRORS, [value])
  );
}

// ---------------------------------------------------------------------------
// Boundary wrappers.
//
// `parseRpcFrame` and `serializeRpcResponse` perform property access
// on hostile inputs.  Any non-RpcProtocolError thrown during input
// inspection / serialization is normalized to a categorical
// RpcProtocolError so a hostile Proxy / getter / `toJSON` trap cannot
// leak raw error messages, `cause` chains, or context through the
// Existing RpcProtocolErrors are reconstructed from their private identity
// to canonical-message mapping so hostile mutation cannot alter the
// diagnostic messages from the categorical rejections below.
// ---------------------------------------------------------------------------

function wrapProtocolBoundary<Arg, Result>(fn: (arg: Arg) => Result): (arg: Arg) => Result {
  return (arg: Arg): Result => {
    try {
      return fn(arg);
    } catch (error) {
      if (isRpcProtocolError(error)) {
        const canonicalMessage = reflectApply(weakMapGet, RPC_PROTOCOL_ERROR_MESSAGES, [error]);
        if (typeof canonicalMessage === "string") throw rpcProtocolError(canonicalMessage);
        throw rpcProtocolError("rpc protocol: internal boundary failure");
      }
      throw rpcProtocolError("rpc protocol: internal boundary failure");
    }
  };
}

// ---------------------------------------------------------------------------
// Frame parsing.
// ---------------------------------------------------------------------------

const LENGTH_PREFIX_BYTES = 4;

function writeLengthPrefix(frame: Uint8Array, payloadLength: number): void {
  frame[0] = (payloadLength >>> 24) & 0xff;
  frame[1] = (payloadLength >>> 16) & 0xff;
  frame[2] = (payloadLength >>> 8) & 0xff;
  frame[3] = payloadLength & 0xff;
}

const TYPED_ARRAY_PROTOTYPE = objectGetPrototypeOf(Uint8ArrayConstructor.prototype);
const UINT8_ARRAY_BUFFER_GETTER = objectGetOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const UINT8_ARRAY_BYTE_OFFSET_GETTER = objectGetOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
)?.get;
const UINT8_ARRAY_BYTE_LENGTH_GETTER = objectGetOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;

function getIntrinsicUint8ArrayMetadata(input: Uint8Array): {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
} {
  if (
    UINT8_ARRAY_BUFFER_GETTER === undefined ||
    UINT8_ARRAY_BYTE_OFFSET_GETTER === undefined ||
    UINT8_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) {
    throw rpcProtocolError("rpc protocol: Uint8Array accessors are unavailable");
  }
  const metadata = objectCreate(null) as {
    buffer: ArrayBufferLike;
    byteOffset: number;
    byteLength: number;
  };
  metadata.buffer = reflectApply(UINT8_ARRAY_BUFFER_GETTER, input, []);
  metadata.byteOffset = reflectApply(UINT8_ARRAY_BYTE_OFFSET_GETTER, input, []);
  metadata.byteLength = reflectApply(UINT8_ARRAY_BYTE_LENGTH_GETTER, input, []);
  return metadata;
}

/**
 * Maximum UTF-16 code units we are willing to walk via Buffer.byteLength
 * during the preflight response-size guard.  Anything larger is rejected
 * with a cheap O(1) length check before the walk runs, so a hostile
 * multi-megabyte input cannot force a multi-megabyte Buffer.byteLength
 * walk either.
 */
const PREFLIGHT_UTF16_WALK_CAP = STAGE5_RPC_LIMITS.maxResponseBytes * 6;

/**
 * Conservative envelope overhead used by the preflight response-size
 * guard when summing worst-case JSON-escaped field sizes against
 * `maxResponseBytes`. The envelope adds the literal JSON key names,
 * value separators, and per-hit field structure. 1024 bytes is
 * sufficient for the success envelope and the error envelope.
 */
const PREFLIGHT_ENVELOPE_OVERHEAD_BYTES = 1024;

/**
 * Run the preflight response-size guard on a single response-owned
 * string field. The guard updates a running worst-case JSON-size sum
 * that the serializer uses to reject envelopes that could exceed
 * `maxResponseBytes` BEFORE any JSON.stringify allocation.
 *
 * Implementation notes:
 *   - The first check is O(1) on the string's UTF-16 code-unit length
 *     so a multi-megabyte hostile string never reaches any further
 *     processing.
 *   - Six output code units per input code unit covers JSON escaping
 *     (`\\uXXXX`) conservatively, including structural characters.
 *
 * The guard never reads, copies, or echoes the field's contents into
 * the thrown error.
 */
function preflightResponseStringField(value: string, rawSum: { n: number }): void {
  // Cheap O(1) UTF-16 code-unit cap.  Rejects multi-megabyte hostile
  // inputs before any linear walk runs.
  if (value.length > PREFLIGHT_UTF16_WALK_CAP) {
    throw rpcProtocolError("rpc protocol: response field exceeds maximum response bytes");
  }
  // Six output code units per input code unit is a conservative upper
  // bound for JSON escaping.  The preceding cap keeps this multiplication
  // small and safe before JSON.stringify is reached.
  const escapedUpperBound = value.length * 6;
  if (escapedUpperBound > STAGE5_RPC_LIMITS.maxResponseBytes) {
    throw rpcProtocolError("rpc protocol: response field exceeds maximum response bytes");
  }
  rawSum.n += escapedUpperBound;
  // Conservative upper-bound sum: if the worst-case escaped output plus
  // fixed envelope overhead exceeds the response cap, reject before
  // JSON.stringify rather than allocating a potentially oversized string.
  if (rawSum.n + PREFLIGHT_ENVELOPE_OVERHEAD_BYTES > STAGE5_RPC_LIMITS.maxResponseBytes) {
    throw rpcProtocolError("rpc protocol: response exceeds maximum response bytes");
  }
}

/**
 * Length-prefixed framing.  The first 4 bytes are a big-endian unsigned
 * length; the remaining bytes are the UTF-8 encoded JSON payload.
 *
 * The parser is intentionally explicit about every step so an attacker
 * cannot trick the boundary into allocating / parsing / forwarding
 * anything beyond the published bounds:
 *
 *   1. The byte buffer is rejected as soon as its size exceeds
 *      `maxFrameBytes`; no JSON parsing happens before that check.
 *   2. The declared length is rejected if it exceeds `maxFrameBytes`,
 *      if it is zero, or if it overflows the supplied buffer.
 *   3. The payload is decoded as UTF-8; invalid UTF-8 is rejected.
 *   4. The JSON parser is a hand-written strict parser that rejects
 *      duplicate keys at every level and only accepts plain objects
 *      with `Object.prototype === null` as the prototype.
 *   5. The parsed request is wrapped in a frozen, null-prototype
 *      object so any hostile getter / inherited field cannot smuggle
 *      data back out of the boundary.
 *
 * Any non-RpcProtocolError thrown by input inspection / decoding /
 * parsing is normalized to a categorical RpcProtocolError so a hostile
 * Proxy / getter cannot leak raw error messages, `cause` chains, or
 * context through the boundary.
 */
function parseRpcFrameInternal(input: Uint8Array): RpcRequest {
  if (!(input instanceof Uint8ArrayConstructor)) {
    throw rpcProtocolError("rpc protocol: input must be a Uint8Array");
  }
  const inputMetadata = getIntrinsicUint8ArrayMetadata(input);
  if (inputMetadata.byteLength > STAGE5_RPC_LIMITS.maxFrameBytes) {
    throw rpcProtocolError("rpc protocol: frame exceeds maximum frame bytes");
  }
  if (inputMetadata.byteLength < LENGTH_PREFIX_BYTES) {
    throw rpcProtocolError("rpc protocol: frame missing length prefix");
  }

  const header = new Uint8ArrayConstructor(
    inputMetadata.buffer,
    inputMetadata.byteOffset,
    LENGTH_PREFIX_BYTES,
  );
  const declaredLength =
    (((header[0] ?? 0) << 24) |
      ((header[1] ?? 0) << 16) |
      ((header[2] ?? 0) << 8) |
      (header[3] ?? 0)) >>>
    0;

  if (declaredLength === 0) {
    throw rpcProtocolError("rpc protocol: declared frame length is zero");
  }
  if (declaredLength > STAGE5_RPC_LIMITS.maxFrameBytes) {
    throw rpcProtocolError("rpc protocol: declared frame length exceeds maximum frame bytes");
  }
  if (LENGTH_PREFIX_BYTES + declaredLength !== inputMetadata.byteLength) {
    throw rpcProtocolError("rpc protocol: declared frame length does not match buffer length");
  }

  const payload = new Uint8ArrayConstructor(
    inputMetadata.buffer,
    inputMetadata.byteOffset + LENGTH_PREFIX_BYTES,
    declaredLength,
  );
  const text = decodeUtf8Strict(payload);
  if (reflectApply(stringCharCodeAt, text, [0]) === 0xfeff) {
    throw rpcProtocolError("rpc protocol: payload must not start with a UTF-8 BOM");
  }

  const parsed = parseJsonStrict(text);
  if (parsed === null || typeof parsed !== "object" || arrayIsArray(parsed)) {
    throw rpcProtocolError("rpc protocol: request root must be a plain object");
  }
  const root = parsed as Record<string, JsonValue>;

  // Only three top-level keys are allowed: id, method, params.  Anything
  // else — `path`, `core`, `sync`, `credential`, `__proto__`, etc. —
  // is rejected categorically.
  const topKeys = objectKeys(root);
  if (topKeys.length !== 3 || !keysAreExactly(topKeys, ["id", "method", "params"])) {
    throw rpcProtocolError("rpc protocol: request root has unexpected fields");
  }

  const id = root.id;
  if (typeof id !== "string" || id.length === 0) {
    throw rpcProtocolError("rpc protocol: request id must be a non-empty string");
  }

  const method = root.method;
  if (
    method !== "notes.search" &&
    method !== "notes.status" &&
    method !== "notes.list_notebooks" &&
    method !== "notes.get" &&
    method !== "notes.create" &&
    method !== "notes.append" &&
    method !== "notes.update" &&
    method !== "notes.delete" &&
    method !== "notes.locked_note_proof" &&
    method !== "notes.path_diagnostic" &&
    method !== "notes.sync" &&
    // T04 — canonical operator RPC vocabulary.  The parser admits the
    // method literal so the operator listener (which owns the
    // body-aware handler chain) can route it to the operator policy
    // seam.  Aliases (notes.edit / notes.undo /
    // notes.predict-next-revision / any "snapshot RPC") are NOT
    // accepted here.
    method !== "notes.get-view" &&
    method !== "notes.edit-preimage" &&
    method !== "notes.apply-edit" &&
    method !== "notes.apply-undo" &&
    method !== "notes.operation-status" &&
    method !== "notes.operation-list" &&
    method !== "notes.browse" &&
    method !== "notes.search-operator"
  ) {
    throw rpcProtocolError("rpc protocol: method is not allowed");
  }

  const params = root.params;
  if (params === null || typeof params !== "object" || arrayIsArray(params)) {
    throw rpcProtocolError("rpc protocol: request params must be a plain object");
  }
  const paramsRecord = params as Record<string, JsonValue>;
  const paramKeys = objectKeys(paramsRecord);

  // Reconstruct the frozen, null-prototype request. `Object.create(null)`
  // ensures no inherited getter can intercept field reads.
  let paramsObj: Record<string, unknown>;
  if (method === "notes.search") {
    if (paramKeys.length !== 1 || paramKeys[0] !== "query") {
      throw rpcProtocolError("rpc protocol: search params must contain exactly one field: query");
    }
    const query = paramsRecord.query;
    if (typeof query !== "string") {
      throw rpcProtocolError("rpc protocol: request query must be a string");
    }
    if (query.length === 0) {
      throw rpcProtocolError("rpc protocol: request query must not be empty");
    }
    if (
      query.length > STAGE5_RPC_LIMITS.maxQueryBytes ||
      utf8ByteLength(query, STAGE5_RPC_LIMITS.maxQueryBytes) > STAGE5_RPC_LIMITS.maxQueryBytes
    ) {
      throw rpcProtocolError("rpc protocol: request query exceeds maximum query bytes");
    }
    paramsObj = objectCreate(null) as Record<string, unknown>;
    paramsObj.query = query;
  } else if (method === "notes.get") {
    if (paramKeys.length !== 1 || paramKeys[0] !== "id") {
      throw rpcProtocolError("rpc protocol: get params must contain exactly one field: id");
    }
    const noteId = paramsRecord.id;
    if (
      typeof noteId !== "string" ||
      noteId.length === 0 ||
      noteId.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      utf8ByteLength(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes) >
        STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      hasControlCharacter(noteId)
    ) {
      throw rpcProtocolError("rpc protocol: request note id is invalid");
    }
    paramsObj = objectCreate(null) as Record<string, unknown>;
    paramsObj.id = noteId;
  } else if (method === "notes.create") {
    // Closed surface params: exactly one of the three published
    // shapes.  Either { title, content }, { title, content,
    // notebookId }, or { title, content, listKind }, or
    // { title, content, notebookId, listKind }.  Tags, MIME,
    // attachments, and every other upstream field are rejected
    // categorically.
    const allowedCreateShapes: ReadonlyArray<ReadonlyArray<string>> = [
      ["title", "content"],
      ["title", "content", "notebookId"],
      ["title", "content", "listKind"],
      ["title", "content", "notebookId", "listKind"],
    ];
    let createShapeMatched = false;
    for (const shape of allowedCreateShapes) {
      if (keysAreExactly(paramKeys, shape)) {
        createShapeMatched = true;
        break;
      }
    }
    if (!createShapeMatched) {
      throw rpcProtocolError("rpc protocol: create params have unexpected fields");
    }
    const title = paramsRecord.title;
    if (
      typeof title !== "string" ||
      title.length === 0 ||
      title.length > STAGE5_RPC_LIMITS.maxTitleBytes ||
      utf8ByteLength(title, STAGE5_RPC_LIMITS.maxTitleBytes) > STAGE5_RPC_LIMITS.maxTitleBytes ||
      hasControlCharacter(title)
    ) {
      throw rpcProtocolError("rpc protocol: request create title is invalid");
    }
    const content = paramsRecord.content;
    if (
      typeof content !== "string" ||
      content.length === 0 ||
      content.length > STAGE5_RPC_LIMITS.maxQueryBytes ||
      utf8ByteLength(content, STAGE5_RPC_LIMITS.maxQueryBytes) > STAGE5_RPC_LIMITS.maxQueryBytes ||
      hasDisallowedControlCharacter(content)
    ) {
      throw rpcProtocolError("rpc protocol: request create content is invalid");
    }
    paramsObj = objectCreate(null) as Record<string, unknown>;
    paramsObj.title = title;
    paramsObj.content = content;
    if (reflectApply(objectHasOwnProperty, paramsRecord, ["notebookId"])) {
      const notebookId = paramsRecord.notebookId;
      if (
        typeof notebookId !== "string" ||
        notebookId.length === 0 ||
        notebookId.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
        utf8ByteLength(notebookId, STAGE5_RPC_LIMITS.maxIdentifierBytes) >
          STAGE5_RPC_LIMITS.maxIdentifierBytes ||
        hasControlCharacter(notebookId)
      ) {
        throw rpcProtocolError("rpc protocol: request create notebookId is invalid");
      }
      paramsObj.notebookId = notebookId;
    }
    if (reflectApply(objectHasOwnProperty, paramsRecord, ["listKind"])) {
      const listKind = paramsRecord.listKind;
      if (typeof listKind !== "string" || !arrayContainsString(NOTESNOOK_LIST_KINDS, listKind)) {
        throw rpcProtocolError("rpc protocol: request create listKind is invalid");
      }
      paramsObj.listKind = listKind;
    }
  } else if (method === "notes.append") {
    // Closed params surface: exactly { id, markdownFragment,
    // expectedRevision, listKind? } in any object-key order.
    // Anything else — body, content, tag lists, force flags — is
    // rejected categorically.  The revision token must match the
    // closed `rev_<32 hex chars>` format published by the Stage 4
    // write contract.
    const allowedAppendShapes: ReadonlyArray<ReadonlyArray<string>> = [
      ["id", "markdownFragment", "expectedRevision"],
      ["id", "markdownFragment", "expectedRevision", "listKind"],
    ];
    let appendShapeMatched = false;
    for (const shape of allowedAppendShapes) {
      if (keysAreExactly(paramKeys, shape)) {
        appendShapeMatched = true;
        break;
      }
    }
    if (!appendShapeMatched) {
      throw rpcProtocolError("rpc protocol: append params have unexpected fields");
    }
    const noteId = paramsRecord.id;
    if (
      typeof noteId !== "string" ||
      noteId.length === 0 ||
      noteId.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      utf8ByteLength(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes) >
        STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      hasControlCharacter(noteId)
    ) {
      throw rpcProtocolError("rpc protocol: request append note id is invalid");
    }
    const markdownFragment = paramsRecord.markdownFragment;
    if (
      typeof markdownFragment !== "string" ||
      markdownFragment.length === 0 ||
      markdownFragment.length > STAGE5_RPC_LIMITS.maxQueryBytes ||
      utf8ByteLength(markdownFragment, STAGE5_RPC_LIMITS.maxQueryBytes) >
        STAGE5_RPC_LIMITS.maxQueryBytes ||
      hasDisallowedControlCharacter(markdownFragment)
    ) {
      throw rpcProtocolError("rpc protocol: request append markdown fragment is invalid");
    }
    const expectedRevision = paramsRecord.expectedRevision;
    if (
      typeof expectedRevision !== "string" ||
      expectedRevision.length === 0 ||
      !isWellFormedRevisionToken(expectedRevision)
    ) {
      throw rpcProtocolError("rpc protocol: request append revision token is invalid");
    }
    paramsObj = objectCreate(null) as Record<string, unknown>;
    paramsObj.id = noteId;
    paramsObj.markdownFragment = markdownFragment;
    paramsObj.expectedRevision = expectedRevision;
    if (reflectApply(objectHasOwnProperty, paramsRecord, ["listKind"])) {
      const listKind = paramsRecord.listKind;
      if (typeof listKind !== "string" || !arrayContainsString(NOTESNOOK_LIST_KINDS, listKind)) {
        throw rpcProtocolError("rpc protocol: request append listKind is invalid");
      }
      paramsObj.listKind = listKind;
    }
  } else if (method === "notes.update") {
    // Closed params surface: exactly { id, expectedRevision, patch }.
    // The patch must itself be a closed object whose keys are a
    // non-empty subset of the Stage 4 update allowlist.  Any other
    // field — `deleted`, `locked`, `force`, `password`, `readonly` —
    // is rejected categorically.
    if (!keysAreExactly(paramKeys, ["id", "expectedRevision", "patch"])) {
      throw rpcProtocolError("rpc protocol: update params have unexpected fields");
    }
    const noteId = paramsRecord.id;
    if (
      typeof noteId !== "string" ||
      noteId.length === 0 ||
      noteId.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      utf8ByteLength(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes) >
        STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      hasControlCharacter(noteId)
    ) {
      throw rpcProtocolError("rpc protocol: request update note id is invalid");
    }
    const expectedRevision = paramsRecord.expectedRevision;
    if (
      typeof expectedRevision !== "string" ||
      expectedRevision.length === 0 ||
      !isWellFormedRevisionToken(expectedRevision)
    ) {
      throw rpcProtocolError("rpc protocol: request update revision token is invalid");
    }
    const patchRecord = paramsRecord.patch;
    if (patchRecord === null || typeof patchRecord !== "object" || arrayIsArray(patchRecord)) {
      throw rpcProtocolError("rpc protocol: request update patch is invalid");
    }
    const patchObj = objectCreate(null) as Record<string, unknown>;
    const patchKeys = objectKeys(patchRecord);
    if (patchKeys.length === 0) {
      throw rpcProtocolError("rpc protocol: request update patch is empty");
    }
    const ALLOWED_PATCH_FIELDS_READONLY: ReadonlyArray<string> = [
      "title",
      "content",
      "notebookId",
      "tags",
      "pinned",
      "favorite",
      "listKind",
    ];
    for (let index = 0; index < patchKeys.length; index += 1) {
      const key = patchKeys[index] as string;
      if (!arrayContains(ALLOWED_PATCH_FIELDS_READONLY, key)) {
        throw rpcProtocolError("rpc protocol: update patch has unsupported field");
      }
    }
    if (patchRecord.title !== undefined) {
      const value = patchRecord.title;
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > STAGE5_RPC_LIMITS.maxTitleBytes ||
        utf8ByteLength(value, STAGE5_RPC_LIMITS.maxTitleBytes) > STAGE5_RPC_LIMITS.maxTitleBytes ||
        hasControlCharacter(value)
      ) {
        throw rpcProtocolError("rpc protocol: update patch title is invalid");
      }
      patchObj.title = value;
    }
    if (patchRecord.content !== undefined) {
      const value = patchRecord.content;
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > STAGE5_RPC_LIMITS.maxQueryBytes ||
        utf8ByteLength(value, STAGE5_RPC_LIMITS.maxQueryBytes) > STAGE5_RPC_LIMITS.maxQueryBytes ||
        hasControlCharacter(value)
      ) {
        throw rpcProtocolError("rpc protocol: update patch content is invalid");
      }
      patchObj.content = value;
    }
    if (patchRecord.notebookId !== undefined) {
      const value = patchRecord.notebookId;
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
        utf8ByteLength(value, STAGE5_RPC_LIMITS.maxIdentifierBytes) >
          STAGE5_RPC_LIMITS.maxIdentifierBytes ||
        hasControlCharacter(value)
      ) {
        throw rpcProtocolError("rpc protocol: update patch notebookId is invalid");
      }
      patchObj.notebookId = value;
    }
    if (patchRecord.tags !== undefined) {
      const value = patchRecord.tags;
      if (!arrayIsArray(value)) {
        throw rpcProtocolError("rpc protocol: update patch tags is invalid");
      }
      // Closed tag bound: max 16 entries, each bounded by the
      // published identifier cap.  Anything else is rejected.
      if (value.length === 0 || value.length > 16) {
        throw rpcProtocolError("rpc protocol: update patch tags count is invalid");
      }
      const tagArr: string[] = [];
      for (let tagIndex = 0; tagIndex < value.length; tagIndex += 1) {
        const entry = value[tagIndex] as unknown;
        if (
          typeof entry !== "string" ||
          entry.length === 0 ||
          entry.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
          utf8ByteLength(entry, STAGE5_RPC_LIMITS.maxIdentifierBytes) >
            STAGE5_RPC_LIMITS.maxIdentifierBytes ||
          hasControlCharacter(entry)
        ) {
          throw rpcProtocolError("rpc protocol: update patch tag entry is invalid");
        }
        tagArr.push(entry);
      }
      objectSetPrototypeOf(tagArr, null);
      objectFreeze(tagArr);
      patchObj.tags = tagArr;
    }
    if (patchRecord.pinned !== undefined) {
      if (typeof patchRecord.pinned !== "boolean") {
        throw rpcProtocolError("rpc protocol: update patch pinned is invalid");
      }
      patchObj.pinned = patchRecord.pinned;
    }
    if (patchRecord.favorite !== undefined) {
      if (typeof patchRecord.favorite !== "boolean") {
        throw rpcProtocolError("rpc protocol: update patch favorite is invalid");
      }
      patchObj.favorite = patchRecord.favorite;
    }
    if (patchRecord.listKind !== undefined) {
      if (
        typeof patchRecord.listKind !== "string" ||
        !arrayContains(NOTESNOOK_LIST_KINDS, patchRecord.listKind)
      ) {
        throw rpcProtocolError("rpc protocol: update patch listKind is invalid");
      }
      patchObj.listKind = patchRecord.listKind;
    }
    objectFreeze(patchObj);
    paramsObj = objectCreate(null) as Record<string, unknown>;
    paramsObj.id = noteId;
    paramsObj.expectedRevision = expectedRevision;
    paramsObj.patch = patchObj;
  } else if (
    method === "notes.delete" ||
    method === "notes.locked_note_proof" ||
    method === "notes.path_diagnostic"
  ) {
    const hasPath = keysAreExactly(paramKeys, ["path"]);
    const hasExplicitTitle =
      keysAreExactly(paramKeys, ["noteTitle"]) ||
      keysAreExactly(paramKeys, ["notebookPath", "noteTitle"]);
    if (!hasPath && !hasExplicitTitle) {
      throw rpcProtocolError("rpc protocol: path params have unexpected fields");
    }
    paramsObj = objectCreate(null) as Record<string, unknown>;
    if (hasPath) {
      const path = paramsRecord.path;
      if (
        typeof path !== "string" ||
        path.length === 0 ||
        path.length > STAGE5_RPC_LIMITS.maxQueryBytes ||
        utf8ByteLength(path, STAGE5_RPC_LIMITS.maxQueryBytes) > STAGE5_RPC_LIMITS.maxQueryBytes ||
        hasControlCharacter(path)
      ) {
        throw rpcProtocolError("rpc protocol: request path params are invalid");
      }
      paramsObj.path = path;
    } else {
      const noteTitle = paramsRecord.noteTitle;
      const notebookPath = paramsRecord.notebookPath;
      if (
        typeof noteTitle !== "string" ||
        noteTitle.length === 0 ||
        noteTitle.length > STAGE5_RPC_LIMITS.maxTitleBytes ||
        utf8ByteLength(noteTitle, STAGE5_RPC_LIMITS.maxTitleBytes) >
          STAGE5_RPC_LIMITS.maxTitleBytes ||
        hasControlCharacter(noteTitle) ||
        (reflectApply(objectHasOwnProperty, paramsRecord, ["notebookPath"]) &&
          (typeof notebookPath !== "string" ||
            notebookPath.length === 0 ||
            notebookPath.length > STAGE5_RPC_LIMITS.maxQueryBytes ||
            utf8ByteLength(notebookPath, STAGE5_RPC_LIMITS.maxQueryBytes) >
              STAGE5_RPC_LIMITS.maxQueryBytes ||
            hasControlCharacter(notebookPath)))
      ) {
        throw rpcProtocolError("rpc protocol: explicit path params are invalid");
      }
      paramsObj.noteTitle = noteTitle;
      if (reflectApply(objectHasOwnProperty, paramsRecord, ["notebookPath"]))
        paramsObj.notebookPath = notebookPath;
    }
  } else if (method === "notes.browse" || method === "notes.search-operator") {
    const allowedShapes =
      method === "notes.browse"
        ? [[], ["cursor"], ["limit"], ["cursor", "limit"]]
        : [["query"], ["query", "cursor"], ["query", "limit"], ["query", "cursor", "limit"]];
    if (!allowedShapes.some((shape) => keysAreExactly(paramKeys, shape)))
      throw rpcProtocolError("rpc protocol: operator discovery params are invalid");
    if (method === "notes.search-operator") {
      const query = paramsRecord.query;
      if (
        typeof query !== "string" ||
        query.length === 0 ||
        hasControlCharacter(query) ||
        utf8ByteLength(query, STAGE5_RPC_LIMITS.maxQueryBytes) > STAGE5_RPC_LIMITS.maxQueryBytes
      )
        throw rpcProtocolError("rpc protocol: operator search query is invalid");
    }
    const cursor = paramsRecord.cursor;
    if (cursor !== undefined && !isWellFormedCursorToken(cursor))
      throw rpcProtocolError("rpc protocol: operator cursor is invalid");
    const limit = paramsRecord.limit;
    if (
      limit !== undefined &&
      (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
    )
      throw rpcProtocolError("rpc protocol: operator limit is invalid");
    paramsObj = objectCreate(null) as Record<string, unknown>;
    if (method === "notes.search-operator") paramsObj.query = paramsRecord.query;
    if (cursor !== undefined) paramsObj.cursor = cursor;
    if (limit !== undefined) paramsObj.limit = limit;
  } else if (method === "notes.get-view" || method === "notes.edit-preimage") {
    // T04 — closed `notes.get-view` / `notes.edit-preimage` params:
    // exactly one field, `id` (an opaque operator handle, bounded by
    // the published identifier cap).  Anything else is rejected.
    if (paramKeys.length !== 1 || paramKeys[0] !== "id") {
      throw rpcProtocolError(
        "rpc protocol: operator note params must contain exactly one field: id",
      );
    }
    const noteId = paramsRecord.id;
    if (
      typeof noteId !== "string" ||
      noteId.length === 0 ||
      noteId.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      utf8ByteLength(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes) >
        STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      hasControlCharacter(noteId)
    ) {
      throw rpcProtocolError("rpc protocol: operator note id is invalid");
    }
    paramsObj = objectCreate(null) as Record<string, unknown>;
    paramsObj.id = noteId;
  } else if (method === "notes.apply-edit") {
    // T04 — closed `notes.apply-edit` params: exactly
    // { id, expectedRevision, markdown } (canonical vocabulary).
    // The `markdown` field is bounded by the editor markdown budget
    // (D9 — 4 MiB upper; the wire cap below is the closed form).
    if (!keysAreExactly(paramKeys, ["id", "expectedRevision", "markdown"])) {
      throw rpcProtocolError("rpc protocol: apply-edit params have unexpected fields");
    }
    const noteId = paramsRecord.id;
    const expectedRevision = paramsRecord.expectedRevision;
    const markdown = paramsRecord.markdown;
    if (
      typeof noteId !== "string" ||
      noteId.length === 0 ||
      noteId.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      utf8ByteLength(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes) >
        STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      hasControlCharacter(noteId) ||
      typeof expectedRevision !== "string" ||
      expectedRevision.length === 0 ||
      !isWellFormedRevisionToken(expectedRevision) ||
      typeof markdown !== "string"
    ) {
      throw rpcProtocolError("rpc protocol: apply-edit params are invalid");
    }
    paramsObj = objectCreate(null) as Record<string, unknown>;
    paramsObj.id = noteId;
    paramsObj.expectedRevision = expectedRevision;
    paramsObj.markdown = markdown;
  } else if (method === "notes.apply-undo") {
    // T04 — closed `notes.apply-undo` params: exactly
    // { id, operationHandle, expectedRevision }.  The
    // `operationHandle` is a daemon-minted opaque handle and never
    // crosses argv / env in production (T00.7 #1).
    if (!keysAreExactly(paramKeys, ["id", "operationHandle", "expectedRevision"])) {
      throw rpcProtocolError("rpc protocol: apply-undo params have unexpected fields");
    }
    const noteId = paramsRecord.id;
    const operationHandle = paramsRecord.operationHandle;
    const expectedRevision = paramsRecord.expectedRevision;
    if (
      typeof noteId !== "string" ||
      noteId.length === 0 ||
      noteId.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      utf8ByteLength(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes) >
        STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      hasControlCharacter(noteId) ||
      typeof operationHandle !== "string" ||
      operationHandle.length === 0 ||
      operationHandle.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      utf8ByteLength(operationHandle, STAGE5_RPC_LIMITS.maxIdentifierBytes) >
        STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      hasControlCharacter(operationHandle) ||
      typeof expectedRevision !== "string" ||
      expectedRevision.length === 0 ||
      !isWellFormedRevisionToken(expectedRevision)
    ) {
      throw rpcProtocolError("rpc protocol: apply-undo params are invalid");
    }
    paramsObj = objectCreate(null) as Record<string, unknown>;
    paramsObj.id = noteId;
    paramsObj.operationHandle = operationHandle;
    paramsObj.expectedRevision = expectedRevision;
  } else if (method === "notes.operation-status") {
    // T04 — closed `notes.operation-status` params: exactly one field,
    // `operationHandle` (daemon-minted opaque handle).
    if (paramKeys.length !== 1 || paramKeys[0] !== "operationHandle") {
      throw rpcProtocolError(
        "rpc protocol: operation-status params must contain exactly one field: operationHandle",
      );
    }
    const operationHandle = paramsRecord.operationHandle;
    if (
      typeof operationHandle !== "string" ||
      operationHandle.length === 0 ||
      operationHandle.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      utf8ByteLength(operationHandle, STAGE5_RPC_LIMITS.maxIdentifierBytes) >
        STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      hasControlCharacter(operationHandle)
    ) {
      throw rpcProtocolError("rpc protocol: operation-status operationHandle is invalid");
    }
    paramsObj = objectCreate(null) as Record<string, unknown>;
    paramsObj.operationHandle = operationHandle;
  } else if (method === "notes.operation-list") {
    // T04 — closed `notes.operation-list` params: parameterless.
    if (paramKeys.length !== 0) {
      throw rpcProtocolError("rpc protocol: operation-list params must be empty");
    }
    paramsObj = objectCreate(null) as Record<string, unknown>;
  } else {
    if (paramKeys.length !== 0) {
      throw rpcProtocolError("rpc protocol: parameterless request has unexpected fields");
    }
    paramsObj = objectCreate(null) as Record<string, unknown>;
  }
  objectFreeze(paramsObj);

  const requestTarget = objectCreate(null) as {
    id: string;
    method: RpcMethod;
    params: Record<string, unknown>;
  };
  requestTarget.id = id;
  requestTarget.method = method;
  requestTarget.params = paramsObj;
  objectFreeze(requestTarget);
  return requestTarget as unknown as RpcRequest;
}

/**
 * Public `parseRpcFrame` entry point.  Wraps the internal parser with
 * the boundary wrapper so any non-RpcProtocolError thrown by input
 * inspection / decoding / parsing is normalized to a categorical
 * RpcProtocolError before it crosses the module boundary.
 */
export const parseRpcFrame = wrapProtocolBoundary(parseRpcFrameInternal);

// ---------------------------------------------------------------------------
// Response serialization.
// ---------------------------------------------------------------------------

/**
 * Serialize a closed response envelope into a length-prefixed frame.
 *
 *   - The envelope is structurally validated: only the documented own
 *     fields are accepted; unknown / inherited / proxy-injected fields
 *     are rejected.
 *   - `notes.search` results are title-only: any hit field beyond
 *     `title` is rejected.
 *   - The hit count is bounded by `maxSearchHits`.
 *   - The UTF-8 byte length of each title is bounded by
 *     `maxTitleBytes`.
 *   - A preflight response-size guard bounds every response-owned
 *     string field (`id`, `code`, `message`) and the running
 *     conservative UTF-8 byte sum BEFORE JSON.stringify allocates.
 *     The post-stringify cap on `maxResponseBytes` remains as
 *     belt-and-braces but is no longer the only line of defence.
 *   - The final frame byte length is bounded by `maxResponseBytes`.
 *
 * Any deviation is reported through a thrown RpcProtocolError.  The
 * thrown error never echoes the offending envelope.
 *
 * Any non-RpcProtocolError thrown by input inspection / serialization
 * (e.g. a hostile Proxy / getter / `toJSON` trap) is normalized to a
 * categorical RpcProtocolError so a hostile envelope cannot leak raw
 * error messages, `cause` chains, or context through the boundary.
 */
function serializeRpcResponseInternal(envelope: unknown): Uint8Array {
  if (envelope === null || typeof envelope !== "object" || arrayIsArray(envelope)) {
    throw rpcProtocolError("rpc protocol: response envelope must be a plain object");
  }

  const env = envelope as Record<string, JsonValue>;
  const envKeys = validateClosedObject(
    env,
    ["id", "ok", "result", "error"],
    "rpc protocol: response envelope has unexpected fields",
  );

  const id = env.id;
  if (typeof id !== "string" || id.length === 0) {
    throw rpcProtocolError("rpc protocol: response id must be a non-empty string");
  }

  // Preflight response-size guard for `id` BEFORE any further property
  // access or allocation.  This is the line of defence that catches a
  // multi-megabyte hostile `id` before JSON.stringify would allocate
  // the payload.  The same guard is re-invoked for `code` / `message`
  // on the error path and for `title` on each hit.
  const rawSum = objectCreate(null) as { n: number };
  rawSum.n = 0;
  preflightResponseStringField(id, rawSum);

  const ok = env.ok;
  if (ok !== true && ok !== false) {
    throw rpcProtocolError("rpc protocol: response ok must be a boolean");
  }

  if (ok === true) {
    if (envKeys.length !== 3 || !keysAreExactly(envKeys, ["id", "ok", "result"])) {
      throw rpcProtocolError("rpc protocol: success envelope has unexpected fields");
    }
    const result = env.result;
    if (result === null || typeof result !== "object" || arrayIsArray(result)) {
      throw rpcProtocolError("rpc protocol: success result must be a plain object");
    }
    const resultRecord = result as Record<string, JsonValue>;
    const kind = resultRecord.kind;
    if (kind === "search") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "notes"],
        "rpc protocol: search result has unexpected fields",
      );
      if (resultKeys.length !== 2 || !keysAreExactly(resultKeys, ["kind", "notes"])) {
        throw rpcProtocolError("rpc protocol: search result has unexpected fields");
      }
      const notes = resultRecord.notes;
      if (!arrayIsArray(notes) || notes.length > STAGE5_RPC_LIMITS.maxSearchHits) {
        throw rpcProtocolError("rpc protocol: search notes are invalid");
      }
      const cleanNotes: Array<{ title: string }> = [];
      objectSetPrototypeOf(cleanNotes, null);
      for (let index = 0; index < notes.length; index += 1) {
        if (!reflectApply(objectHasOwnProperty, notes, [index])) {
          throw rpcProtocolError(
            "rpc protocol: search notes must contain only own numeric entries",
          );
        }
        const note = notes[index];
        if (note === null || typeof note !== "object" || arrayIsArray(note)) {
          throw rpcProtocolError("rpc protocol: search hit must be a plain object");
        }
        const noteRecord = note as Record<string, JsonValue>;
        const noteKeys = validateClosedObject(
          noteRecord,
          ["title"],
          "rpc protocol: search hit has unexpected fields",
        );
        if (noteKeys.length !== 1 || noteKeys[0] !== "title") {
          throw rpcProtocolError("rpc protocol: search hit must contain exactly one field: title");
        }
        const title = noteRecord.title;
        assertBoundedString(title, STAGE5_RPC_LIMITS.maxTitleBytes, "search hit title");
        preflightResponseStringField(title, rawSum);
        const cleanNote = objectCreate(null) as { title: string };
        cleanNote.title = title;
        cleanNotes[index] = cleanNote;
      }
      const resultPayload = objectCreate(null) as {
        kind: "search";
        notes: Array<{ title: string }>;
      };
      resultPayload.kind = "search";
      resultPayload.notes = cleanNotes;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "status") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "lastSynced", "hasUnsyncedChanges"],
        "rpc protocol: status result has unexpected fields",
      );
      if (
        resultKeys.length !== 3 ||
        !keysAreExactly(resultKeys, ["kind", "lastSynced", "hasUnsyncedChanges"])
      ) {
        throw rpcProtocolError("rpc protocol: status result has unexpected fields");
      }
      if (
        !isNonNegativeFiniteNumber(resultRecord.lastSynced) ||
        typeof resultRecord.hasUnsyncedChanges !== "boolean"
      ) {
        throw rpcProtocolError("rpc protocol: status result fields are invalid");
      }
      const resultPayload = objectCreate(null) as {
        kind: "status";
        lastSynced: number;
        hasUnsyncedChanges: boolean;
      };
      resultPayload.kind = "status";
      resultPayload.lastSynced = resultRecord.lastSynced;
      resultPayload.hasUnsyncedChanges = resultRecord.hasUnsyncedChanges;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "notebooks") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "notebooks"],
        "rpc protocol: notebooks result has unexpected fields",
      );
      if (resultKeys.length !== 2 || !keysAreExactly(resultKeys, ["kind", "notebooks"])) {
        throw rpcProtocolError("rpc protocol: notebooks result has unexpected fields");
      }
      const notebooks = resultRecord.notebooks;
      if (!arrayIsArray(notebooks) || notebooks.length > STAGE5_RPC_LIMITS.maxSearchHits) {
        throw rpcProtocolError("rpc protocol: notebooks result is invalid");
      }
      const cleanNotebooks: Array<Record<string, JsonValue>> = [];
      objectSetPrototypeOf(cleanNotebooks, null);
      for (let index = 0; index < notebooks.length; index += 1) {
        if (!reflectApply(objectHasOwnProperty, notebooks, [index]))
          throw rpcProtocolError("rpc protocol: notebooks result has sparse entries");
        const clean = normaliseNotebookResult(notebooks[index], rawSum);
        cleanNotebooks[index] = clean;
      }
      const resultPayload = objectCreate(null) as {
        kind: "notebooks";
        notebooks: Array<Record<string, JsonValue>>;
      };
      resultPayload.kind = "notebooks";
      resultPayload.notebooks = cleanNotebooks;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "note") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "note"],
        "rpc protocol: note result has unexpected fields",
      );
      if (resultKeys.length !== 2 || !keysAreExactly(resultKeys, ["kind", "note"])) {
        throw rpcProtocolError("rpc protocol: note result has unexpected fields");
      }
      const cleanNote = normaliseNoteResult(resultRecord.note, rawSum);
      const resultPayload = objectCreate(null) as { kind: "note"; note: Record<string, JsonValue> };
      resultPayload.kind = "note";
      resultPayload.note = cleanNote;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "create") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "id", "titleBytes", "contentBytes"],
        "rpc protocol: create result has unexpected fields",
      );
      if (
        resultKeys.length !== 4 ||
        !keysAreExactly(resultKeys, ["kind", "id", "titleBytes", "contentBytes"])
      ) {
        throw rpcProtocolError("rpc protocol: create result has unexpected fields");
      }
      const noteId = resultRecord.id;
      assertBoundedString(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes, "created note id");
      preflightResponseStringField(noteId, rawSum);
      if (
        !isNonNegativeFiniteNumber(resultRecord.titleBytes) ||
        resultRecord.titleBytes > STAGE5_RPC_LIMITS.maxTitleBytes ||
        !isNonNegativeFiniteNumber(resultRecord.contentBytes) ||
        resultRecord.contentBytes > STAGE5_RPC_LIMITS.maxQueryBytes
      ) {
        throw rpcProtocolError("rpc protocol: create result byte counts are invalid");
      }
      const resultPayload = objectCreate(null) as {
        kind: "create";
        id: string;
        titleBytes: number;
        contentBytes: number;
      };
      resultPayload.kind = "create";
      resultPayload.id = noteId;
      resultPayload.titleBytes = resultRecord.titleBytes;
      resultPayload.contentBytes = resultRecord.contentBytes;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "append") {
      // Closed success-result shape: exactly { kind, id,
      // fragmentBytes }.  No body, no raw stored content, no
      // internal flags, no revision tokens cross the boundary.
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "id", "fragmentBytes"],
        "rpc protocol: append result has unexpected fields",
      );
      if (resultKeys.length !== 3 || !keysAreExactly(resultKeys, ["kind", "id", "fragmentBytes"])) {
        throw rpcProtocolError("rpc protocol: append result has unexpected fields");
      }
      const noteId = resultRecord.id;
      assertBoundedString(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes, "appended note id");
      preflightResponseStringField(noteId, rawSum);
      if (
        !isNonNegativeFiniteNumber(resultRecord.fragmentBytes) ||
        resultRecord.fragmentBytes > STAGE5_RPC_LIMITS.maxQueryBytes
      ) {
        throw rpcProtocolError("rpc protocol: append result fragmentBytes is invalid");
      }
      const resultPayload = objectCreate(null) as {
        kind: "append";
        id: string;
        fragmentBytes: number;
      };
      resultPayload.kind = "append";
      resultPayload.id = noteId;
      resultPayload.fragmentBytes = resultRecord.fragmentBytes;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "update") {
      // Closed success-result shape: exactly { kind, id,
      // appliedFields, contentBytes? }.  Raw patch values,
      // internal flags, and revision tokens are never projected.
      // The optional contentBytes field is only present when the
      // patch contains a content update — otherwise it is
      // intentionally omitted so the success envelope stays minimal.
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "id", "appliedFields", "contentBytes"],
        "rpc protocol: update result has unexpected fields",
      );
      // Validate the exact own-key shape: the three required keys
      // must be present, and contentBytes may additionally be
      // present.  Anything else — duplicate/unknown fields — is
      // rejected categorically.
      const requiredKeys: ReadonlyArray<string> = ["kind", "id", "appliedFields"];
      if (!keysAreExactly(resultKeys, requiredKeys)) {
        const hasAllRequired =
          arrayContains(resultKeys, "kind") &&
          arrayContains(resultKeys, "id") &&
          arrayContains(resultKeys, "appliedFields") &&
          resultKeys.length <= 4;
        if (!hasAllRequired) {
          throw rpcProtocolError("rpc protocol: update result has unexpected fields");
        }
        // Allow the optional contentBytes fourth key.
        if (
          resultKeys.length !== 4 ||
          !arrayContains(resultKeys, "contentBytes") ||
          !keysAreExactly(resultKeys, ["kind", "id", "appliedFields", "contentBytes"])
        ) {
          throw rpcProtocolError("rpc protocol: update result has unexpected fields");
        }
      }
      const noteId = resultRecord.id;
      assertBoundedString(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes, "updated note id");
      preflightResponseStringField(noteId, rawSum);
      // appliedFields must be a non-empty bounded array whose every
      // entry is one of the closed update patch allowlist names.
      // No duplicate/unknown entries cross the boundary.
      const appliedFields = resultRecord.appliedFields;
      if (
        appliedFields === undefined ||
        !arrayIsArray(appliedFields) ||
        appliedFields.length === 0 ||
        appliedFields.length > 6
      ) {
        throw rpcProtocolError("rpc protocol: update result appliedFields is invalid");
      }
      const APPLIED_FIELDS_ALLOWLIST: ReadonlyArray<string> = [
        "title",
        "content",
        "notebookId",
        "tags",
        "pinned",
        "favorite",
      ];
      const cleanAppliedFields: string[] = [];
      for (let index = 0; index < appliedFields.length; index += 1) {
        if (!reflectApply(objectHasOwnProperty, appliedFields, [index])) {
          throw rpcProtocolError(
            "rpc protocol: update result appliedFields must contain only own numeric entries",
          );
        }
        const entry = appliedFields[index] as unknown;
        if (
          typeof entry !== "string" ||
          !arrayContains(APPLIED_FIELDS_ALLOWLIST, entry) ||
          arrayContains(cleanAppliedFields, entry)
        ) {
          throw rpcProtocolError("rpc protocol: update result appliedFields entry is invalid");
        }
        cleanAppliedFields.push(entry);
      }
      objectSetPrototypeOf(cleanAppliedFields, null);
      objectFreeze(cleanAppliedFields);
      const resultPayload = objectCreate(null) as {
        kind: "update";
        id: string;
        appliedFields: ReadonlyArray<string>;
        contentBytes?: number;
      };
      resultPayload.kind = "update";
      resultPayload.id = noteId;
      resultPayload.appliedFields = cleanAppliedFields;
      if (
        resultRecord.contentBytes !== undefined &&
        (!isNonNegativeFiniteNumber(resultRecord.contentBytes) ||
          resultRecord.contentBytes > STAGE5_RPC_LIMITS.maxQueryBytes)
      ) {
        throw rpcProtocolError("rpc protocol: update result contentBytes is invalid");
      }
      if (resultRecord.contentBytes !== undefined) {
        resultPayload.contentBytes = resultRecord.contentBytes;
      }
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "delete") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "id"],
        "rpc protocol: delete result has unexpected fields",
      );
      if (resultKeys.length !== 2 || !keysAreExactly(resultKeys, ["kind", "id"])) {
        throw rpcProtocolError("rpc protocol: delete result has unexpected fields");
      }
      const noteId = resultRecord.id;
      assertBoundedString(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes, "deleted note id");
      preflightResponseStringField(noteId, rawSum);
      const resultPayload = objectCreate(null) as { kind: "delete"; id: string };
      resultPayload.kind = "delete";
      resultPayload.id = noteId;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "locked_note_proof") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "pathBytes", "read", "update", "delete"],
        "rpc protocol: locked-note proof result has unexpected fields",
      );
      if (
        resultKeys.length !== 5 ||
        !keysAreExactly(resultKeys, ["kind", "pathBytes", "read", "update", "delete"])
      ) {
        throw rpcProtocolError("rpc protocol: locked-note proof result has unexpected fields");
      }
      if (
        typeof resultRecord.pathBytes !== "number" ||
        !Number.isSafeInteger(resultRecord.pathBytes) ||
        resultRecord.pathBytes < 0 ||
        resultRecord.pathBytes > STAGE5_RPC_LIMITS.maxQueryBytes
      ) {
        throw rpcProtocolError("rpc protocol: locked-note proof path bytes are invalid");
      }
      const codes = ["vault_locked", "ok", "not_found", "permission_denied", "service_unavailable"];
      if (
        typeof resultRecord.read !== "string" ||
        typeof resultRecord.update !== "string" ||
        typeof resultRecord.delete !== "string" ||
        !codes.includes(resultRecord.read) ||
        !codes.includes(resultRecord.update) ||
        !codes.includes(resultRecord.delete)
      ) {
        throw rpcProtocolError("rpc protocol: locked-note proof result category is invalid");
      }
      const resultPayload = objectCreate(null) as {
        kind: "locked_note_proof";
        pathBytes: number;
        read: string;
        update: string;
        delete: string;
      };
      resultPayload.kind = "locked_note_proof";
      resultPayload.pathBytes = resultRecord.pathBytes;
      resultPayload.read = resultRecord.read;
      resultPayload.update = resultRecord.update;
      resultPayload.delete = resultRecord.delete;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "path_diagnostic") {
      const resultKeys = validateClosedObject(
        resultRecord,
        [
          "kind",
          "pathBytes",
          "title",
          "notebook",
          "directMembership",
          "recursiveMembership",
          "revision",
          "contentType",
          "htmlPrefix",
          "simpleChecklist",
          "taskList",
          "literalMarkdown",
        ],
        "rpc protocol: path diagnostic result has unexpected fields",
      );
      if (
        resultKeys.length !== 12 ||
        !keysAreExactly(resultKeys, [
          "kind",
          "pathBytes",
          "title",
          "notebook",
          "directMembership",
          "recursiveMembership",
          "revision",
          "contentType",
          "htmlPrefix",
          "simpleChecklist",
          "taskList",
          "literalMarkdown",
        ])
      ) {
        throw rpcProtocolError("rpc protocol: path diagnostic result has unexpected fields");
      }
      if (
        typeof resultRecord.pathBytes !== "number" ||
        !Number.isSafeInteger(resultRecord.pathBytes) ||
        resultRecord.pathBytes < 0 ||
        resultRecord.pathBytes > STAGE5_RPC_LIMITS.maxQueryBytes
      ) {
        throw rpcProtocolError("rpc protocol: path diagnostic path bytes are invalid");
      }
      const titleStatuses = ["none", "one", "multiple", "unavailable"];
      const stageStatuses = ["present", "absent", "unavailable", "not_applicable"];
      const revisionStatuses = ["valid", "invalid", "unavailable", "not_applicable"];
      if (
        typeof resultRecord.title !== "string" ||
        !titleStatuses.includes(resultRecord.title) ||
        typeof resultRecord.notebook !== "string" ||
        !stageStatuses.includes(resultRecord.notebook) ||
        typeof resultRecord.directMembership !== "string" ||
        !stageStatuses.includes(resultRecord.directMembership) ||
        typeof resultRecord.recursiveMembership !== "string" ||
        !stageStatuses.includes(resultRecord.recursiveMembership) ||
        typeof resultRecord.revision !== "string" ||
        !revisionStatuses.includes(resultRecord.revision) ||
        typeof resultRecord.contentType !== "string" ||
        !["tiptap", "other", "unavailable"].includes(resultRecord.contentType) ||
        typeof resultRecord.htmlPrefix !== "string" ||
        !["present", "absent", "unavailable"].includes(resultRecord.htmlPrefix) ||
        typeof resultRecord.simpleChecklist !== "string" ||
        !["present", "absent", "unavailable"].includes(resultRecord.simpleChecklist) ||
        typeof resultRecord.taskList !== "string" ||
        !["present", "absent", "unavailable"].includes(resultRecord.taskList) ||
        typeof resultRecord.literalMarkdown !== "string" ||
        !["present", "absent", "unavailable"].includes(resultRecord.literalMarkdown)
      ) {
        throw rpcProtocolError("rpc protocol: path diagnostic result category is invalid");
      }
      const resultPayload = objectCreate(null) as {
        kind: "path_diagnostic";
        pathBytes: number;
        title: string;
        notebook: string;
        directMembership: string;
        recursiveMembership: string;
        revision: string;
        contentType: string;
        htmlPrefix: string;
        simpleChecklist: string;
        taskList: string;
        literalMarkdown: string;
      };
      resultPayload.kind = "path_diagnostic";
      resultPayload.pathBytes = resultRecord.pathBytes;
      resultPayload.title = resultRecord.title;
      resultPayload.notebook = resultRecord.notebook;
      resultPayload.directMembership = resultRecord.directMembership;
      resultPayload.recursiveMembership = resultRecord.recursiveMembership;
      resultPayload.revision = resultRecord.revision;
      resultPayload.contentType = resultRecord.contentType;
      resultPayload.htmlPrefix = resultRecord.htmlPrefix;
      resultPayload.simpleChecklist = resultRecord.simpleChecklist;
      resultPayload.taskList = resultRecord.taskList;
      resultPayload.literalMarkdown = resultRecord.literalMarkdown;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "sync") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "status", "pendingSync", "attempts"],
        "rpc protocol: sync result has unexpected fields",
      );
      if (
        resultKeys.length !== 4 ||
        !keysAreExactly(resultKeys, ["kind", "status", "pendingSync", "attempts"])
      ) {
        throw rpcProtocolError("rpc protocol: sync result has unexpected fields");
      }
      const status = resultRecord.status;
      if (status !== "idle" && status !== "synced") {
        throw rpcProtocolError("rpc protocol: sync result status is invalid");
      }
      if (typeof resultRecord.pendingSync !== "boolean") {
        throw rpcProtocolError("rpc protocol: sync result pendingSync is invalid");
      }
      if (
        !isNonNegativeFiniteNumber(resultRecord.attempts) ||
        !Number.isSafeInteger(resultRecord.attempts) ||
        resultRecord.attempts > 8
      ) {
        throw rpcProtocolError("rpc protocol: sync result attempts is invalid");
      }
      const resultPayload = objectCreate(null) as {
        kind: "sync";
        status: "idle" | "synced";
        pendingSync: boolean;
        attempts: number;
      };
      resultPayload.kind = "sync";
      resultPayload.status = status;
      resultPayload.pendingSync = resultRecord.pendingSync;
      resultPayload.attempts = resultRecord.attempts;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    // T04 — canonical operator RPC result shapes.  Each operator
    // listener result is validated against its closed own-key set;
    // unknown fields, missing fields, and oversize fields are
    // rejected categorically with a categorical RpcProtocolError
    // (the raw envelope is never echoed into the error).

    if (kind === "operator-page") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "notes", "next"],
        "rpc protocol: operator page result has unexpected fields",
      );
      if (resultKeys.length !== 3 || !keysAreExactly(resultKeys, ["kind", "notes", "next"]))
        throw rpcProtocolError("rpc protocol: operator page result has unexpected fields");
      const notes = resultRecord.notes;
      const next = resultRecord.next;
      if (
        !arrayIsArray(notes) ||
        notes.length > 100 ||
        (next !== null && (typeof next !== "string" || !isWellFormedCursorToken(next)))
      )
        throw rpcProtocolError("rpc protocol: operator page result is invalid");
      const cleanNotes: Array<{ handle: string; label: string; bytes: number }> = [];
      for (const note of notes) {
        if (note === null || typeof note !== "object" || arrayIsArray(note))
          throw rpcProtocolError("rpc protocol: operator page note is invalid");
        const noteRecord = note as Record<string, JsonValue>;
        const noteKeys = validateClosedObject(
          noteRecord,
          ["handle", "label", "bytes"],
          "rpc protocol: operator page note has unexpected fields",
        );
        if (noteKeys.length !== 3 || !keysAreExactly(noteKeys, ["handle", "label", "bytes"]))
          throw rpcProtocolError("rpc protocol: operator page note has unexpected fields");
        const handle = noteRecord.handle;
        const label = noteRecord.label;
        const bytes = noteRecord.bytes;
        if (typeof handle !== "string" || typeof label !== "string" || typeof bytes !== "number")
          throw rpcProtocolError("rpc protocol: operator page note is invalid");
        assertBoundedString(handle, STAGE5_RPC_LIMITS.maxIdentifierBytes, "operator handle");
        assertBoundedString(label, STAGE5_RPC_LIMITS.maxTitleBytes, "operator label");
        if (!isNonNegativeFiniteNumber(bytes) || bytes !== Buffer.byteLength(label, "utf8"))
          throw rpcProtocolError("rpc protocol: operator page note bytes are invalid");
        preflightResponseStringField(handle, rawSum);
        preflightResponseStringField(label, rawSum);
        cleanNotes.push({ handle, label, bytes });
      }
      if (next !== null) preflightResponseStringField(next, rawSum);
      const resultPayload = objectCreate(null) as {
        kind: "operator-page";
        notes: Array<{ handle: string; label: string; bytes: number }>;
        next: string | null;
      };
      resultPayload.kind = "operator-page";
      resultPayload.notes = cleanNotes;
      resultPayload.next = next;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "view") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "id", "revision", "markdown", "contentBytes"],
        "rpc protocol: view result has unexpected fields",
      );
      if (
        resultKeys.length !== 5 ||
        !keysAreExactly(resultKeys, ["kind", "id", "revision", "markdown", "contentBytes"])
      ) {
        throw rpcProtocolError("rpc protocol: view result has unexpected fields");
      }
      const noteId = resultRecord.id;
      const revision = resultRecord.revision;
      const markdown = resultRecord.markdown;
      const contentBytes = resultRecord.contentBytes;
      assertBoundedString(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes, "view id");
      assertBoundedString(revision, 64, "view revision");
      assertBoundedMarkdown(markdown, STAGE5_RPC_LIMITS.maxResponseBytes, "view markdown");
      preflightResponseStringField(noteId, rawSum);
      preflightResponseStringField(revision, rawSum);
      preflightResponseStringField(markdown, rawSum);
      if (
        !isNonNegativeFiniteNumber(contentBytes) ||
        contentBytes !== Buffer.byteLength(markdown, "utf8")
      ) {
        throw rpcProtocolError("rpc protocol: view result contentBytes is invalid");
      }
      const resultPayload = objectCreate(null) as {
        kind: "view";
        id: string;
        revision: string;
        markdown: string;
        contentBytes: number;
      };
      resultPayload.kind = "view";
      resultPayload.id = noteId;
      resultPayload.revision = revision;
      resultPayload.markdown = markdown;
      resultPayload.contentBytes = contentBytes;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "preimage") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "id", "revision", "markdown", "contentBytes"],
        "rpc protocol: preimage result has unexpected fields",
      );
      if (
        resultKeys.length !== 5 ||
        !keysAreExactly(resultKeys, ["kind", "id", "revision", "markdown", "contentBytes"])
      ) {
        throw rpcProtocolError("rpc protocol: preimage result has unexpected fields");
      }
      const noteId = resultRecord.id;
      const revision = resultRecord.revision;
      const markdown = resultRecord.markdown;
      const contentBytes = resultRecord.contentBytes;
      assertBoundedString(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes, "preimage id");
      assertBoundedString(revision, 64, "preimage revision");
      assertBoundedMarkdown(markdown, STAGE5_RPC_LIMITS.maxResponseBytes, "preimage markdown");
      preflightResponseStringField(noteId, rawSum);
      preflightResponseStringField(revision, rawSum);
      preflightResponseStringField(markdown, rawSum);
      if (
        !isNonNegativeFiniteNumber(contentBytes) ||
        contentBytes !== Buffer.byteLength(markdown, "utf8")
      ) {
        throw rpcProtocolError("rpc protocol: preimage result contentBytes is invalid");
      }
      const resultPayload = objectCreate(null) as {
        kind: "preimage";
        id: string;
        revision: string;
        markdown: string;
        contentBytes: number;
      };
      resultPayload.kind = "preimage";
      resultPayload.id = noteId;
      resultPayload.revision = revision;
      resultPayload.markdown = markdown;
      resultPayload.contentBytes = contentBytes;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "edit") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "id", "appliedFields", "revision", "contentBytes"],
        "rpc protocol: edit result has unexpected fields",
      );
      if (
        resultKeys.length !== 5 ||
        !keysAreExactly(resultKeys, ["kind", "id", "appliedFields", "revision", "contentBytes"])
      ) {
        throw rpcProtocolError("rpc protocol: edit result has unexpected fields");
      }
      const noteId = resultRecord.id;
      const appliedFields = resultRecord.appliedFields;
      const revision = resultRecord.revision;
      const contentBytes = resultRecord.contentBytes;
      assertBoundedString(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes, "edit id");
      assertBoundedString(revision, 64, "edit revision");
      preflightResponseStringField(noteId, rawSum);
      preflightResponseStringField(revision, rawSum);
      if (
        !arrayIsArray(appliedFields) ||
        appliedFields.length !== 1 ||
        appliedFields[0] !== "content"
      ) {
        throw rpcProtocolError("rpc protocol: edit result appliedFields is invalid");
      }
      if (!isNonNegativeFiniteNumber(contentBytes)) {
        throw rpcProtocolError("rpc protocol: edit result contentBytes is invalid");
      }
      const resultPayload = objectCreate(null) as {
        kind: "edit";
        id: string;
        appliedFields: ReadonlyArray<"content">;
        revision: string;
        contentBytes: number;
      };
      resultPayload.kind = "edit";
      resultPayload.id = noteId;
      resultPayload.appliedFields = ["content"];
      resultPayload.revision = revision;
      resultPayload.contentBytes = contentBytes;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "undo") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "id", "appliedFields", "revision", "contentBytes"],
        "rpc protocol: undo result has unexpected fields",
      );
      if (
        resultKeys.length !== 5 ||
        !keysAreExactly(resultKeys, ["kind", "id", "appliedFields", "revision", "contentBytes"])
      ) {
        throw rpcProtocolError("rpc protocol: undo result has unexpected fields");
      }
      const noteId = resultRecord.id;
      const appliedFields = resultRecord.appliedFields;
      const revision = resultRecord.revision;
      const contentBytes = resultRecord.contentBytes;
      assertBoundedString(noteId, STAGE5_RPC_LIMITS.maxIdentifierBytes, "undo id");
      assertBoundedString(revision, 64, "undo revision");
      preflightResponseStringField(noteId, rawSum);
      preflightResponseStringField(revision, rawSum);
      if (
        !arrayIsArray(appliedFields) ||
        appliedFields.length !== 1 ||
        appliedFields[0] !== "content"
      ) {
        throw rpcProtocolError("rpc protocol: undo result appliedFields is invalid");
      }
      if (!isNonNegativeFiniteNumber(contentBytes)) {
        throw rpcProtocolError("rpc protocol: undo result contentBytes is invalid");
      }
      const resultPayload = objectCreate(null) as {
        kind: "undo";
        id: string;
        appliedFields: ReadonlyArray<"content">;
        revision: string;
        contentBytes: number;
      };
      resultPayload.kind = "undo";
      resultPayload.id = noteId;
      resultPayload.appliedFields = ["content"];
      resultPayload.revision = revision;
      resultPayload.contentBytes = contentBytes;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "operation-status") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "operationHandle", "state", "id"],
        "rpc protocol: operation-status result has unexpected fields",
      );
      // `id` is optional; either three or four keys are accepted.
      const requiredKeys: ReadonlyArray<string> = ["kind", "operationHandle", "state"];
      if (
        !(
          (resultKeys.length === 3 && keysAreExactly(resultKeys, requiredKeys)) ||
          (resultKeys.length === 4 &&
            keysAreExactly(resultKeys, ["kind", "operationHandle", "state", "id"]))
        )
      ) {
        throw rpcProtocolError("rpc protocol: operation-status result has unexpected fields");
      }
      const operationHandle = resultRecord.operationHandle;
      const state = resultRecord.state;
      assertBoundedString(
        operationHandle,
        STAGE5_RPC_LIMITS.maxIdentifierBytes,
        "operation-status operationHandle",
      );
      preflightResponseStringField(operationHandle, rawSum);
      const allowedStates = [
        "prepared",
        "committing",
        "committed",
        "undone",
        "unresolved",
        "aborted",
      ] as const;
      if (
        typeof state !== "string" ||
        !allowedStates.includes(state as (typeof allowedStates)[number])
      ) {
        throw rpcProtocolError("rpc protocol: operation-status result state is invalid");
      }
      const resultPayload = objectCreate(null) as {
        kind: "operation-status";
        operationHandle: string;
        state: (typeof allowedStates)[number];
        id?: string;
      };
      resultPayload.kind = "operation-status";
      resultPayload.operationHandle = operationHandle;
      resultPayload.state = state as (typeof allowedStates)[number];
      if (resultKeys.length === 4) {
        const idValue = resultRecord.id;
        assertBoundedString(idValue, STAGE5_RPC_LIMITS.maxIdentifierBytes, "operation-status id");
        preflightResponseStringField(idValue, rawSum);
        resultPayload.id = idValue;
      }
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    if (kind === "operation-list") {
      const resultKeys = validateClosedObject(
        resultRecord,
        ["kind", "handles"],
        "rpc protocol: operation-list result has unexpected fields",
      );
      if (resultKeys.length !== 2 || !keysAreExactly(resultKeys, ["kind", "handles"])) {
        throw rpcProtocolError("rpc protocol: operation-list result has unexpected fields");
      }
      const handles = resultRecord.handles;
      if (!arrayIsArray(handles) || handles.length > STAGE5_RPC_LIMITS.maxSearchHits) {
        throw rpcProtocolError("rpc protocol: operation-list result handles is invalid");
      }
      const cleanHandles: string[] = [];
      for (let index = 0; index < handles.length; index += 1) {
        const descriptor = objectGetOwnPropertyDescriptor(handles, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          throw rpcProtocolError("rpc protocol: operation-list handle must be a value");
        }
        const handleValue = descriptor.value;
        if (
          typeof handleValue !== "string" ||
          handleValue.length === 0 ||
          handleValue.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
          hasControlCharacter(handleValue)
        ) {
          throw rpcProtocolError("rpc protocol: operation-list handle is invalid");
        }
        cleanHandles.push(handleValue);
      }
      objectSetPrototypeOf(cleanHandles, null);
      objectFreeze(cleanHandles);
      const resultPayload = objectCreate(null) as {
        kind: "operation-list";
        handles: ReadonlyArray<string>;
      };
      resultPayload.kind = "operation-list";
      resultPayload.handles = cleanHandles;
      return serializeSuccessFrame(id, resultPayload, rawSum);
    }

    throw rpcProtocolError("rpc protocol: result kind is not allowed");
  }

  // ok === false
  if (envKeys.length !== 3 || !keysAreExactly(envKeys, ["id", "ok", "error"])) {
    throw rpcProtocolError("rpc protocol: error envelope has unexpected fields");
  }
  const error = env.error;
  if (error === null || typeof error !== "object" || arrayIsArray(error)) {
    throw rpcProtocolError("rpc protocol: response error must be a plain object");
  }
  const errorRecord = error as Record<string, JsonValue>;
  const errorKeys = validateClosedObject(
    errorRecord,
    ["code", "message"],
    "rpc protocol: response error has unexpected fields",
  );
  if (errorKeys.length !== 2 || !keysAreExactly(errorKeys, ["code", "message"])) {
    throw rpcProtocolError("rpc protocol: response error has unexpected fields");
  }
  const code = errorRecord.code;
  const message = errorRecord.message;
  if (typeof code !== "string" || typeof message !== "string") {
    throw rpcProtocolError("rpc protocol: response error fields must be strings");
  }
  if (!isRpcErrorCode(code) || message !== RPC_ERROR_MESSAGES[code]) {
    throw rpcProtocolError("rpc protocol: response error category is not allowed");
  }
  const fixedMessage = RPC_ERROR_MESSAGES[code];
  // Preflight `code` and `message` so a hostile multi-megabyte
  // either of them is rejected before JSON.stringify would allocate
  // the payload.  Per-field byte bound plus conservative sum bound
  // together prevent any stringify-sized allocation for an oversize
  // error envelope.
  preflightResponseStringField(code, rawSum);
  preflightResponseStringField(fixedMessage, rawSum);

  const errorPayload = objectCreate(null) as { code: string; message: string };
  errorPayload.code = code;
  errorPayload.message = fixedMessage;
  const errorEnvelope = objectCreate(null) as {
    id: string;
    ok: false;
    error: { code: string; message: string };
  };
  errorEnvelope.id = id;
  errorEnvelope.ok = false;
  errorEnvelope.error = errorPayload;
  const payload = jsonStringify(errorEnvelope);
  const payloadBytes = bufferFrom(payload, "utf8");
  const payloadByteLength = getIntrinsicUint8ArrayMetadata(payloadBytes).byteLength;
  if (payloadByteLength > STAGE5_RPC_LIMITS.maxResponseBytes) {
    throw rpcProtocolError("rpc protocol: response exceeds maximum response bytes");
  }

  const frame = new Uint8ArrayConstructor(LENGTH_PREFIX_BYTES + payloadByteLength);
  writeLengthPrefix(frame, payloadByteLength);
  for (let index = 0; index < payloadByteLength; index += 1) {
    frame[LENGTH_PREFIX_BYTES + index] = payloadBytes[index] ?? 0;
  }
  return frame;
}

/**
 * Public `serializeRpcResponse` entry point.  Wraps the internal
 * serializer with the boundary wrapper so any non-RpcProtocolError
 * thrown by input inspection / serialization (e.g. a hostile Proxy
 * getter or `toJSON` trap) is normalized to a categorical
 * RpcProtocolError before it crosses the module boundary.
 */
export const serializeRpcResponse = wrapProtocolBoundary(serializeRpcResponseInternal);

function serializeSuccessFrame(
  id: string,
  resultPayload: Record<string, unknown>,
  rawSum: { n: number },
): Uint8Array {
  const successEnvelope = objectCreate(null) as {
    id: string;
    ok: true;
    result: Record<string, unknown>;
  };
  successEnvelope.id = id;
  successEnvelope.ok = true;
  successEnvelope.result = resultPayload;
  const payload = jsonStringify(successEnvelope);
  if (typeof payload !== "string")
    throw rpcProtocolError("rpc protocol: response is not serializable");
  void rawSum;
  const payloadBytes = bufferFrom(payload, "utf8");
  const payloadByteLength = getIntrinsicUint8ArrayMetadata(payloadBytes).byteLength;
  if (payloadByteLength > STAGE5_RPC_LIMITS.maxResponseBytes) {
    throw rpcProtocolError("rpc protocol: response exceeds maximum response bytes");
  }
  const frame = new Uint8ArrayConstructor(LENGTH_PREFIX_BYTES + payloadByteLength);
  writeLengthPrefix(frame, payloadByteLength);
  for (let index = 0; index < payloadByteLength; index += 1) {
    frame[LENGTH_PREFIX_BYTES + index] = payloadBytes[index] ?? 0;
  }
  return frame;
}

function assertBoundedString(
  value: JsonValue | undefined,
  maxBytes: number,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || hasControlCharacter(value)) {
    throw rpcProtocolError(`rpc protocol: ${label} is invalid`);
  }
  const boundLabel = label.includes("title")
    ? "title bytes"
    : label.includes("id")
      ? "identifier bytes"
      : "bytes";
  if (value.length > maxBytes || utf8ByteLength(value, maxBytes) > maxBytes) {
    throw rpcProtocolError(`rpc protocol: ${label} exceeds maximum ${boundLabel}`);
  }
}

function assertBoundedMarkdown(
  value: JsonValue | undefined,
  maxBytes: number,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || hasDisallowedControlCharacter(value)) {
    throw rpcProtocolError(`rpc protocol: ${label} is invalid`);
  }
  if (value.length > maxBytes || utf8ByteLength(value, maxBytes) > maxBytes) {
    throw rpcProtocolError(`rpc protocol: ${label} exceeds maximum bytes`);
  }
}

function isNonNegativeFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && numberIsFinite(value) && value >= 0;
}

function validateOptionalMetadataNumber(
  record: Record<string, JsonValue>,
  key: "dateCreated" | "dateModified",
): number | undefined {
  const value = record[key];
  if (value !== undefined && !isNonNegativeFiniteNumber(value)) {
    throw rpcProtocolError("rpc protocol: metadata timestamp is invalid");
  }
  return value;
}

function normaliseNotebookResult(
  value: JsonValue | undefined,
  rawSum: { n: number },
): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || arrayIsArray(value)) {
    throw rpcProtocolError("rpc protocol: notebook summary must be an object");
  }
  const record = value as Record<string, JsonValue>;
  const keys = validateClosedObject(
    record,
    ["id", "title", "dateCreated", "dateModified"],
    "rpc protocol: notebook summary has unexpected fields",
  );
  if (keys.length < 2 || !keys.includes("id") || !keys.includes("title")) {
    throw rpcProtocolError("rpc protocol: notebook summary is missing fields");
  }
  assertBoundedString(record.id, STAGE5_RPC_LIMITS.maxIdentifierBytes, "notebook id");
  assertBoundedString(record.title, STAGE5_RPC_LIMITS.maxTitleBytes, "notebook title");
  preflightResponseStringField(record.id, rawSum);
  preflightResponseStringField(record.title, rawSum);
  const clean = objectCreate(null) as Record<string, JsonValue>;
  clean.id = record.id;
  clean.title = record.title;
  const dateCreated = validateOptionalMetadataNumber(record, "dateCreated");
  const dateModified = validateOptionalMetadataNumber(record, "dateModified");
  if (dateCreated !== undefined) clean.dateCreated = dateCreated;
  if (dateModified !== undefined) clean.dateModified = dateModified;
  return clean;
}

function normaliseNoteResult(
  value: JsonValue | undefined,
  rawSum: { n: number },
): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || arrayIsArray(value)) {
    throw rpcProtocolError("rpc protocol: note metadata must be an object");
  }
  const record = value as Record<string, JsonValue>;
  const keys = validateClosedObject(
    record,
    [
      "id",
      "title",
      "revision",
      "dateCreated",
      "dateModified",
      "notebookId",
      "pinned",
      "favorite",
      "localOnly",
      "conflicted",
      "locked",
    ],
    "rpc protocol: note metadata has unexpected fields",
  );
  if (keys.length < 2 || !keys.includes("id") || !keys.includes("title")) {
    throw rpcProtocolError("rpc protocol: note metadata is missing fields");
  }
  assertBoundedString(record.id, STAGE5_RPC_LIMITS.maxIdentifierBytes, "note id");
  assertBoundedString(record.title, STAGE5_RPC_LIMITS.maxTitleBytes, "note title");
  preflightResponseStringField(record.id, rawSum);
  preflightResponseStringField(record.title, rawSum);
  if (record.revision !== undefined) {
    if (!isWellFormedRevisionToken(record.revision)) {
      throw rpcProtocolError("rpc protocol: note revision token is invalid");
    }
    preflightResponseStringField(record.revision as string, rawSum);
  }
  const clean = objectCreate(null) as Record<string, JsonValue>;
  clean.id = record.id;
  clean.title = record.title;
  if (record.revision !== undefined) clean.revision = record.revision;
  const dateCreated = validateOptionalMetadataNumber(record, "dateCreated");
  const dateModified = validateOptionalMetadataNumber(record, "dateModified");
  if (dateCreated !== undefined) clean.dateCreated = dateCreated;
  if (dateModified !== undefined) clean.dateModified = dateModified;
  if (record.notebookId !== undefined) {
    assertBoundedString(record.notebookId, STAGE5_RPC_LIMITS.maxIdentifierBytes, "notebook id");
    preflightResponseStringField(record.notebookId, rawSum);
    clean.notebookId = record.notebookId;
  }
  for (const key of ["pinned", "favorite", "localOnly", "conflicted", "locked"] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== "boolean")
        throw rpcProtocolError("rpc protocol: note metadata flag is invalid");
      clean[key] = record[key];
    }
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Count the UTF-8 bytes TextEncoder would emit without allocating.
 *
 * Callers apply a cheap UTF-16 code-unit cap first, and this helper returns
 * as soon as the bounded byte budget is exceeded.  Lone surrogates are
 * counted as the three-byte replacement sequence emitted by TextEncoder.
 */
function utf8ByteLength(value: string, maxBytes: number): number {
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = reflectApply(stringCharCodeAt, value, [index]);
    if (code <= 0x7f) {
      byteLength += 1;
    } else if (code <= 0x7ff) {
      byteLength += 2;
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      (reflectApply(stringCharCodeAt, value, [index + 1]) ?? 0) >= 0xdc00 &&
      (reflectApply(stringCharCodeAt, value, [index + 1]) ?? 0) <= 0xdfff
    ) {
      byteLength += 4;
      index += 1;
    } else {
      byteLength += 3;
    }
    if (byteLength > maxBytes) return byteLength;
  }
  return byteLength;
}

/**
 * Minimal JSON value type used for narrowing the strict parser output.
 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Strict UTF-8 decode that throws on any invalid sequence.  We use
 * `TextDecoder({ fatal: true })` so a hostile byte that fails UTF-8
 * validation surfaces as an error rather than being silently replaced
 * with U+FFFD.
 */
function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    return reflectApply(textDecoderDecode, decoder, [bytes]);
  } catch {
    throw rpcProtocolError("rpc protocol: payload is not valid UTF-8");
  }
}

/**
 * Hand-written strict JSON parser.  Rejects:
 *
 *   - duplicate keys at every object level (including nested objects
 *     inside `params` and inside array elements);
 *   - non-object / array / scalar roots and the `null` root;
 *   - any value whose prototype is not `Object.prototype` — proxy /
 *     inherited-field smuggling is rejected because every value we
 *     emit is a fresh `Object.create(null)` instance;
 *   - non-string keys (the JSON spec already restricts keys to
 *     strings, but we surface any deviation as an explicit rejection
 *     so the caller can see the wire contract was violated rather
 *     than getting a generic parse error).
 *
 * The parser is intentionally conservative: it allocates nothing
 * beyond the result tree and never returns anything outside the wire
 * shape contract.
 */
function parseJsonStrict(text: string): JsonValue {
  let cursor = 0;

  function fail(): never {
    throw rpcProtocolError("rpc protocol: payload is not valid JSON");
  }

  function skipWhitespace(): void {
    while (cursor < text.length && isWhitespace(reflectApply(stringCharCodeAt, text, [cursor]))) {
      cursor += 1;
    }
  }

  function peek(): string {
    return cursor < text.length ? (text[cursor] as string) : "";
  }

  function expect(ch: string): void {
    if (peek() !== ch) fail();
    cursor += 1;
  }

  function parseValue(): JsonValue {
    skipWhitespace();
    if (cursor >= text.length) fail();
    const ch = peek();
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') return parseString();
    if (ch === "t" || ch === "f") return parseBoolean();
    if (ch === "n") return parseNull();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber();
    fail();
  }

  function parseObject(): JsonValue {
    expect("{");
    const obj: Record<string, JsonValue> = objectCreate(null);
    skipWhitespace();
    if (peek() === "}") {
      cursor += 1;
      return obj;
    }
    while (true) {
      skipWhitespace();
      const key = parseString();
      if (reflectApply(objectHasOwnProperty, obj, [key])) {
        throw rpcProtocolError("rpc protocol: duplicate JSON key is not allowed");
      }
      skipWhitespace();
      expect(":");
      const value = parseValue();
      obj[key] = value;
      skipWhitespace();
      if (cursor >= text.length) fail();
      const sep = peek();
      cursor += 1;
      if (sep === ",") continue;
      if (sep === "}") return obj;
      fail();
    }
  }

  function parseArray(): JsonValue {
    expect("[");
    const arr: JsonValue[] = [];
    objectSetPrototypeOf(arr, null);
    skipWhitespace();
    if (peek() === "]") {
      cursor += 1;
      return arr;
    }
    while (true) {
      arr[arr.length] = parseValue();
      skipWhitespace();
      if (cursor >= text.length) fail();
      const sep = peek();
      cursor += 1;
      if (sep === ",") continue;
      if (sep === "]") return arr;
      fail();
    }
  }

  function parseString(): string {
    expect('"');
    let out = "";
    while (cursor < text.length) {
      const ch = peek();
      if (ch === '"') {
        cursor += 1;
        return out;
      }
      if (ch === "\\") {
        cursor += 1;
        const esc = peek();
        cursor += 1;
        if (esc === '"') out += '"';
        else if (esc === "\\") out += "\\";
        else if (esc === "/") out += "/";
        else if (esc === "b") out += "\b";
        else if (esc === "f") out += "\f";
        else if (esc === "n") out += "\n";
        else if (esc === "r") out += "\r";
        else if (esc === "t") out += "\t";
        else if (esc === "u") {
          if (cursor + 4 > text.length) fail();
          const hex = reflectApply(stringSlice, text, [cursor, cursor + 4]);
          if (!isFourHexDigits(hex)) fail();
          cursor += 4;
          let code = 0;
          for (let hexIndex = 0; hexIndex < 4; hexIndex += 1) {
            code = code * 16 + hexDigitValue(reflectApply(stringCharCodeAt, hex, [hexIndex]));
          }
          out += stringFromCodePoint(code);
        } else fail();
        continue;
      }
      if (reflectApply(stringCharCodeAt, ch, [0]) <= 0x1f) fail();
      out += ch;
      cursor += 1;
    }
    fail();
  }

  function parseBoolean(): boolean {
    if (matchesLiteral(text, cursor, "true")) {
      cursor += 4;
      return true;
    }
    if (matchesLiteral(text, cursor, "false")) {
      cursor += 5;
      return false;
    }
    fail();
  }

  function parseNull(): null {
    if (matchesLiteral(text, cursor, "null")) {
      cursor += 4;
      return null;
    }
    fail();
  }

  function parseNumber(): number {
    const start = cursor;
    if (peek() === "-") cursor += 1;
    const firstDigit = peek();
    if (firstDigit === "0") {
      cursor += 1;
      if (isDecimalDigit(peek())) fail();
    } else if (firstDigit >= "1" && firstDigit <= "9") {
      cursor += 1;
      while (isDecimalDigit(peek())) cursor += 1;
    } else {
      fail();
    }
    if (peek() === ".") {
      cursor += 1;
      if (!isDecimalDigit(peek())) fail();
      while (isDecimalDigit(peek())) cursor += 1;
    }
    const expChar = peek();
    if (expChar === "e" || expChar === "E") {
      cursor += 1;
      const sign = peek();
      if (sign === "+" || sign === "-") cursor += 1;
      if (!isDecimalDigit(peek())) fail();
      while (isDecimalDigit(peek())) cursor += 1;
    }
    const numberText = reflectApply(stringSlice, text, [start, cursor]);
    const value = numberFromString(numberText);
    if (!numberIsFinite(value)) fail();
    return value;
  }

  function isWhitespace(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  }

  const result = parseValue();
  skipWhitespace();
  if (cursor !== text.length) fail();
  return result;
}

function matchesLiteral(text: string, offset: number, literal: string): boolean {
  if (offset + literal.length > text.length) return false;
  for (let index = 0; index < literal.length; index += 1) {
    if (text[offset + index] !== literal[index]) return false;
  }
  return true;
}

function isDecimalDigit(value: string): boolean {
  return value >= "0" && value <= "9";
}

function hexDigitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return code - 0x61 + 10;
}

function arrayContains(values: ReadonlyArray<string>, candidate: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === candidate) return true;
  }
  return false;
}

function arrayContainsString(
  values: ReadonlyArray<string>,
  candidate: unknown,
): candidate is string {
  return typeof candidate === "string" && arrayContains(values, candidate);
}

/**
 * True iff `actual` is a permutation of `expected` and has the same
 * length.  Used to enforce the closed allowlist of own keys without
 * allocating a sorted copy.
 */
function keysAreExactly(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  if (actual.length !== expected.length) return false;
  for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
    const expectedKey = expected[expectedIndex];
    let found = false;
    for (let actualIndex = 0; actualIndex < actual.length; actualIndex += 1) {
      if (actual[actualIndex] === expectedKey) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

const standardObjectPrototypeNames = [
  "constructor",
  "__defineGetter__",
  "__defineSetter__",
  "hasOwnProperty",
  "__lookupGetter__",
  "__lookupSetter__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "__proto__",
  "toLocaleString",
];
objectSetPrototypeOf(standardObjectPrototypeNames, null);
const STANDARD_OBJECT_PROTOTYPE_NAMES: ReadonlyArray<string> = objectFreeze(
  standardObjectPrototypeNames,
);

/**
 * Validate the object boundary before reading any response-owned fields.
 *
 * `Object.keys` is insufficient here: it omits symbols and non-enumerable
 * own properties, and it says nothing about enumerable properties inherited
 * from a polluted prototype.  Response objects remain ordinary object
 * literals (or null-prototype objects), but custom prototypes and every
 * unknown own/inherited key are rejected.
 */
function validateClosedObject(
  value: object,
  allowed: ReadonlyArray<string>,
  failureMessage: string,
): ReadonlyArray<string> {
  const prototype = objectGetPrototypeOf(value);
  if (prototype !== objectPrototype && prototype !== null) {
    throw rpcProtocolError(failureMessage);
  }

  const ownKeys = reflectOwnKeys(value);
  for (let keyIndex = 0; keyIndex < ownKeys.length; keyIndex += 1) {
    const key = ownKeys[keyIndex];
    if (typeof key !== "string" || !arrayContains(allowed, key)) {
      throw rpcProtocolError(failureMessage);
    }
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true) {
      throw rpcProtocolError(failureMessage);
    }
  }

  for (let inherited = prototype; inherited !== null; inherited = objectGetPrototypeOf(inherited)) {
    const inheritedKeys = reflectOwnKeys(inherited);
    for (let keyIndex = 0; keyIndex < inheritedKeys.length; keyIndex += 1) {
      const key = inheritedKeys[keyIndex];
      if (typeof key !== "string" || !arrayContains(STANDARD_OBJECT_PROTOTYPE_NAMES, key)) {
        throw rpcProtocolError(failureMessage);
      }
      const descriptor = objectGetOwnPropertyDescriptor(inherited, key);
      if (descriptor?.enumerable) {
        throw rpcProtocolError(failureMessage);
      }
    }
  }

  return ownKeys as string[];
}

function isFourHexDigits(value: string): boolean {
  if (value.length !== 4) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = reflectApply(stringCharCodeAt, value, [index]);
    const isDecimal = code >= 0x30 && code <= 0x39;
    const isLowerHex = code >= 0x61 && code <= 0x66;
    const isUpperHex = code >= 0x41 && code <= 0x46;
    if (!isDecimal && !isLowerHex && !isUpperHex) return false;
  }
  return true;
}

/**
 * `true` iff `value` is one of the fixed categorical error codes.
 *
 * Exported so operator-side clients classify a daemon error envelope
 * against the SAME closed vocabulary the daemon serializes with. A
 * hardcoded client-side subset silently reclassifies any category it
 * forgot — a losing revision check would surface as "unavailable".
 */
export function isRpcErrorCode(value: string): value is RpcErrorCode {
  return reflectApply(objectHasOwnProperty, RPC_ERROR_MESSAGES, [value]);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = reflectApply(stringCharCodeAt, value, [index]);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Markdown whitespace is structurally significant: line breaks separate
 * blocks and tabs indent code.  Allow these in any input where the codec
 * itself will re-tokenise the value, and reject every other ASCII control
 * byte that has no place in a well-formed document.  The fragment passes
 * through the markdown codec which strips and re-encodes whitespace, so a
 * permissive boundary here does not weaken the on-disk validator.
 */
function hasDisallowedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = reflectApply(stringCharCodeAt, value, [index]);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Defensive check for an opaque Notesnook revision token as published by the
 * Stage 4 write contract.
 *
 * The token is structurally `rev_` followed by exactly 32 lowercase
 * hexadecimal characters — the truncated SHA-256 of the observed note
 * revision state.  It is treated as opaque: it is a digest, never a
 * counter, never a path, and never a credential label, so any deviation
 * from the literal shape is rejected categorically at the wire
 * boundary.
 *
 * This helper is intentionally permissive about its inputs: any
 * non-string / wrong-shape / wrong-length value returns `false`
 * without throwing.  A hostile Proxy that throws from `String.length`
 * is also tolerated — the helper only ever inspects the value
 * through typed access, never through a method call that could
 * trigger a `Symbol.match` trap.
 */
function isWellFormedCursorToken(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 6 || value.length > 128) return false;
  if (value.slice(0, 4) !== "cur_") return false;
  for (let index = 4; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const digit = code >= 0x30 && code <= 0x39;
    const lower = code >= 0x61 && code <= 0x7a;
    const upper = code >= 0x41 && code <= 0x5a;
    if (!digit && !lower && !upper && code !== 0x5f && code !== 0x2d) return false;
  }
  return true;
}

function isWellFormedRevisionToken(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length !== 36) return false;
  if (
    reflectApply(stringCharCodeAt, value, [0]) !== 0x72 ||
    reflectApply(stringCharCodeAt, value, [1]) !== 0x65 ||
    reflectApply(stringCharCodeAt, value, [2]) !== 0x76 ||
    reflectApply(stringCharCodeAt, value, [3]) !== 0x5f
  ) {
    return false;
  }
  for (let index = 4; index < 36; index += 1) {
    const code = reflectApply(stringCharCodeAt, value, [index]);
    const isDecimal = code >= 0x30 && code <= 0x39;
    const isLowerHex = code >= 0x61 && code <= 0x66;
    if (!isDecimal && !isLowerHex) return false;
  }
  return true;
}
