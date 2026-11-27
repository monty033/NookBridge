/**
 * Stage 6 — framed Unix-socket transport seam for `nook-mcp`.
 *
 * The proxy talks to the trusted `nookd` daemon over a permission-
 * controlled Unix-domain socket using the existing Stage 5 framed
 * RPC. This module owns the transport and bounded response-decoding
 * layer; it does not import the service runtime or expose raw records.
 *
 * Hard rules:
 *
 *   - Only the configured absolute socket path is connected.
 *     No fallback paths, no env-driven path lookup, no implicit
 *     defaults. The transport seam rejects relative paths.
 *   - Requests are bounded by the published Stage 5 frame budget
 *     before they cross the wire, so a hostile caller cannot
 *     force the proxy to write an oversized framed payload. A
 *     request the single frame cannot carry takes the protocol-2
 *     body path only when the daemon has advertised it; the raw
 *     body is bounded by `WIRE_BODY_BYTES` and is written only
 *     after the daemon's `body_continue`.
 *   - Responses are bounded by the same Stage 5 frame budget.
 *   - Any connect / read / write / timeout failure is normalized
 *     to a categorical `service_unavailable` outcome. The
 *     underlying errno, syscall name, and socket path never
 *     appear in the error surface.
 *   - The `connect` seam exists so tests can inject a fake
 *     transport without ever opening a real socket.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";

import {
  STAGE5_RPC_LIMITS,
  type RpcErrorCode,
  type RpcNotesSearchParams,
  type RpcNotesCreateParams,
  type RpcNotesAppendParams,
  type RpcNotesUpdateParams,
  type RpcNotesDeleteParams,
  type RpcNotesGetParams,
  type RpcNotesLockedNoteProofParams,
  type RpcNotesPathDiagnosticParams,
  type RpcAnyResponseEnvelope,
  type RpcResult,
  type RpcAnySuccessEnvelope,
  type RpcSuccessEnvelope,
} from "../service/rpc-protocol.js";
import {
  NOTESNOOK_LIST_KINDS,
  type NotesnookListKind,
} from "../core/notesnook-write-list-intent.js";
import { DEFAULT_SERVICE_ABUSE_BOUNDS } from "../service/service-abuse-bounds.js";
import { RPC_RESPONSE_BYTES, RPC_TITLE_BYTES, WIRE_BODY_BYTES } from "../core/size-limits.js";

const FRAME_PREFIX_BYTES = 4;
const MAX_FRAME_BYTES_ON_WIRE = STAGE5_RPC_LIMITS.maxFrameBytes;
const MAX_RESPONSE_FRAME_BYTES = RPC_RESPONSE_BYTES;
const ARRAY_PROTOTYPE = Array.prototype;
const OBJECT_PROTOTYPE = Object.prototype;

/** Default whole-request deadline. It must outlast the daemon's own
 *  request timeout so the daemon can answer with its categorical
 *  timeout before the client gives up. */
const DEFAULT_IO_TIMEOUT_MS = DEFAULT_SERVICE_ABUSE_BOUNDS.requestTimeoutMs + 2_000;

/**
 * Closed result of a single socket I/O round-trip. Either the
 * decoded response envelope (which the caller hands back to the
 * MCP layer) or a categorical error code.
 *
 * `reason` is intentionally a closed string set so the MCP layer
 * never has to inspect a raw upstream message.
 */
export type NookdSocketResult =
  | { readonly ok: true; readonly envelope: RpcAnySuccessEnvelope }
  | { readonly ok: false; readonly code: NookdSocketFailure };

export type NookdSocketFailure =
  | "service_unavailable"
  | "invalid_request"
  | "too_large"
  | "permission_denied"
  | "sync_failed"
  | "stale_revision"
  | "conflict"
  | "vault_locked"
  | "not_found"
  | "local_sync_marker_failed"
  | "unapproved_pending"
  | "unsupported_content"
  | "sync_required"
  | "busy";

/**
 * The daemon protocol this client negotiated: 2 accepts a declared raw
 * body after a header frame, 1 accepts single frames only.
 */
export type NookdProtocolVersion = 1 | 2;

/**
 * Map a Stage 5 RPC error envelope code to the closed
 * socket-failure vocabulary. Anything we don't recognise falls
 * back to `service_unavailable` so the agent never sees a raw
 * upstream category.
 *
 * `busy` only reaches this function from a body-path header reply;
 * every other response is decoded without it, so a client that never
 * negotiates still reports a stray `busy` as `service_unavailable`.
 */
function mapRpcErrorCodeToSocketFailure(code: RpcErrorCode): NookdSocketFailure {
  switch (code) {
    case "invalid_request":
      return "invalid_request";
    case "busy":
      return "busy";
    case "too_large":
      return "too_large";
    case "permission_denied":
      return "permission_denied";
    case "service_unavailable":
      return "service_unavailable";
    case "stale_revision":
      return "stale_revision";
    case "conflict":
      return "conflict";
    case "sync_failed":
      return "sync_failed";
    case "vault_locked":
      return "vault_locked";
    case "not_found":
      return "not_found";
    case "local_sync_marker_failed":
      return "local_sync_marker_failed";
    case "unapproved_pending":
      return "unapproved_pending";
    case "unsupported_content":
      return "unsupported_content";
    case "sync_required":
      return "sync_required";
    default:
      return "service_unavailable";
  }
}

/**
 * Injection seam used by tests. The default opens a real
 * `net.Socket` and connects to `socketPath`; tests may override
 * it to return a fake.
 */
export type SocketConnect = (path: string, signal?: AbortSignal) => Promise<Socket>;

async function defaultConnect(socketPath: string, signal?: AbortSignal): Promise<Socket> {
  if (signal?.aborted) throw new Error("connect aborted");
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const cleanup = (): void => {
      socket.off("error", onError);
      socket.off("connect", onConnect);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = (error: Error): void => fail(error);
    const onConnect = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(new Error("connect aborted"));
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface NookdSocketClientOptions {
  readonly socketPath: string;
  /** Tests may substitute a fake connect. */
  readonly connect?: SocketConnect;
  /**
   * Whole-request deadline in ms, covering connect, write and read — and, on
   * the body path, the header, the continue, the body and the reply as one
   * exchange. Defaults to 12s.
   */
  readonly ioTimeoutMs?: number;
}

type SocketMethod =
  | "notes.capabilities"
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
  | "notes.sync";

type SocketParams =
  | RpcNotesSearchParams
  | RpcNotesCreateParams
  | RpcNotesAppendParams
  | RpcNotesUpdateParams
  | RpcNotesGetParams
  | RpcNotesDeleteParams
  | RpcNotesLockedNoteProofParams
  | RpcNotesPathDiagnosticParams
  | Record<string, never>
  | { readonly id: string };

/** How one request crosses the wire, decided before any connection opens. */
type RequestPlan =
  | { readonly kind: "frame"; readonly frame: Uint8Array }
  | { readonly kind: "body"; readonly header: Uint8Array; readonly body: Uint8Array }
  | { readonly kind: "refused"; readonly code: "invalid_request" | "too_large" };

export interface NookdSearchRequest extends RpcNotesSearchParams {
  /** Optional bounded internal correlation id used by tests and callers. */
  readonly id?: string;
}

export type NookdSearchResult =
  | { readonly ok: true; readonly envelope: RpcSuccessEnvelope }
  | { readonly ok: false; readonly code: NookdSocketFailure };

/**
 * The closed transport seam. Stateless apart from the configured
 * socket path and the negotiated protocol, which is probed lazily —
 * only for a request one frame cannot carry — and forgotten on any
 * `service_unavailable` so a restarted or replaced daemon is
 * re-probed. Safe to construct per-call.
 */
export class NookdSocketClient {
  readonly #socketPath: string;
  readonly #connect: SocketConnect;
  readonly #ioTimeoutMs: number;
  #protocol: Promise<NookdProtocolVersion | undefined> | undefined;

  constructor(options: NookdSocketClientOptions) {
    if (
      typeof options.socketPath !== "string" ||
      !isAbsolute(options.socketPath) ||
      hasControlCharacter(options.socketPath) ||
      resolve(options.socketPath) !== options.socketPath
    ) {
      throw new TypeError("nook-mcp: socket path must be absolute and canonical");
    }
    this.#socketPath = options.socketPath;
    this.#connect = options.connect ?? defaultConnect;
    if (
      options.ioTimeoutMs !== undefined &&
      (!Number.isInteger(options.ioTimeoutMs) || options.ioTimeoutMs < 1)
    ) {
      throw new TypeError("nook-mcp: ioTimeoutMs must be a positive integer");
    }
    this.#ioTimeoutMs = options.ioTimeoutMs ?? DEFAULT_IO_TIMEOUT_MS;
  }

  /** The canonical absolute socket path this client connects to. */
  get socketPath(): string {
    return this.#socketPath;
  }

  async search(params: NookdSearchRequest): Promise<NookdSearchResult> {
    const result = await this.#request("notes.search", params, params.id);
    if (!result.ok) return result;
    if (result.envelope.result.kind !== "search") return { ok: false, code: "service_unavailable" };
    return {
      ok: true,
      envelope: result.envelope as unknown as RpcSuccessEnvelope,
    };
  }

  async status(): Promise<NookdSocketResult> {
    return this.#request("notes.status", {});
  }

  async listNotebooks(): Promise<NookdSocketResult> {
    return this.#request("notes.list_notebooks", {});
  }

  async getNote(params: string | RpcNotesGetParams): Promise<NookdSocketResult> {
    return this.#request("notes.get", typeof params === "string" ? { id: params } : params);
  }

  async createNote(params: RpcNotesCreateParams): Promise<NookdSocketResult> {
    return this.#request("notes.create", params);
  }

  async appendNote(params: RpcNotesAppendParams): Promise<NookdSocketResult> {
    return this.#request("notes.append", params);
  }

  async updateNote(params: RpcNotesUpdateParams): Promise<NookdSocketResult> {
    return this.#request("notes.update", params);
  }

  async deleteNote(params: RpcNotesDeleteParams): Promise<NookdSocketResult> {
    return this.#request("notes.delete", params);
  }

  async lockedNoteProof(params: RpcNotesLockedNoteProofParams): Promise<NookdSocketResult> {
    return this.#request("notes.locked_note_proof", params);
  }

  async pathDiagnostic(params: RpcNotesPathDiagnosticParams): Promise<NookdSocketResult> {
    return this.#request("notes.path_diagnostic", params);
  }

  async requestSync(): Promise<NookdSocketResult> {
    return this.#request("notes.sync", {});
  }

  /**
   * The version-negotiation probe. A protocol-2 daemon answers
   * `{ kind: "capabilities", protocol: 2 }`; a protocol-1 daemon closes
   * the connection, which surfaces as `service_unavailable`.
   */
  async capabilities(): Promise<NookdSocketResult> {
    return this.#request("notes.capabilities", {});
  }

  async #request(
    method: SocketMethod,
    params: SocketParams,
    suppliedId?: string,
  ): Promise<NookdSocketResult> {
    const result = await this.#dispatch(method, params, suppliedId);
    if (!result.ok && result.code === "service_unavailable") this.#protocol = undefined;
    return result;
  }

  async #dispatch(
    method: SocketMethod,
    params: SocketParams,
    suppliedId?: string,
  ): Promise<NookdSocketResult> {
    const id = suppliedId ?? generateRequestId();
    const plan = planRequest(id, method, params);
    if (plan.kind === "refused") return { ok: false, code: plan.code };
    if (plan.kind === "frame") return this.#exchange(id, method, plan.frame);
    const protocol = await this.#negotiatedProtocol();
    if (protocol === undefined) return { ok: false, code: "service_unavailable" };
    // An old daemon cannot take the body; refuse here rather than connect and guess.
    if (protocol < 2) return { ok: false, code: "too_large" };
    return this.#exchange(id, method, plan.header, plan.body);
  }

  /** The cached protocol answer, probing once when there is none. */
  async #negotiatedProtocol(): Promise<NookdProtocolVersion | undefined> {
    let pending = this.#protocol;
    if (pending === undefined) {
      pending = this.#probeProtocol();
      this.#protocol = pending;
    }
    const protocol = await pending;
    if (protocol === undefined && this.#protocol === pending) this.#protocol = undefined;
    return protocol;
  }

  /**
   * `notes.capabilities` first; a daemon that does not answer it is asked
   * `notes.status` once, whose success means protocol 1 and whose failure
   * means the daemon is unavailable.
   */
  async #probeProtocol(): Promise<NookdProtocolVersion | undefined> {
    // The probes bypass `#request`: their own `service_unavailable` must not
    // clear the very answer they are computing.
    const capabilities = await this.#dispatch("notes.capabilities", {});
    if (capabilities.ok && capabilities.envelope.result.kind === "capabilities") return 2;
    const status = await this.#dispatch("notes.status", {});
    return status.ok ? 1 : undefined;
  }

  async #exchange(
    id: string,
    method: SocketMethod,
    frame: Uint8Array,
    body?: Uint8Array,
  ): Promise<NookdSocketResult> {
    const abortController = new AbortController();
    let socket: Socket | undefined;
    let deadlineExpired = false;
    let rejectDeadline: ((error: Error) => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timer = globalThis.setTimeout(() => {
      deadlineExpired = true;
      abortController.abort();
      if (socket !== undefined) destroyQuietly(socket);
      rejectDeadline?.(new Error("timeout"));
    }, this.#ioTimeoutMs);

    try {
      const connected = this.#connect(this.#socketPath, abortController.signal).then(
        async (connectedSocket) => {
          if (deadlineExpired) {
            destroyQuietly(connectedSocket);
            throw new Error("timeout");
          }
          socket = connectedSocket;
          await writeAll(connectedSocket, frame);
          return connectedSocket;
        },
      );
      socket = await Promise.race([connected, deadline]);
      if (body !== undefined) {
        // Phase two of the body path: nothing of the body is written unless
        // the daemon's reply to the header is a continue for exactly its size.
        const invitation = decodeResponseFrame(
          await Promise.race([readFramedResponse(socket, abortController.signal), deadline]),
          { method, allowBusy: true, continueBytes: body.byteLength },
        );
        if (invitation === undefined) return { ok: false, code: "service_unavailable" };
        if (invitation.ok === false) return mapResponseEnvelope(invitation, id);
        if (invitation.id !== id || invitation.result.kind !== "body_continue") {
          return { ok: false, code: "service_unavailable" };
        }
        if (deadlineExpired) throw new Error("timeout");
        // Listen for the reply before writing, so a close mid-body is observed.
        const reply = readFramedResponse(socket, abortController.signal);
        reply.catch(() => undefined);
        await Promise.race([writeAll(socket, body), deadline]);
        const response = decodeResponseFrame(await Promise.race([reply, deadline]), {
          method,
          resultContentBytes: WIRE_BODY_BYTES,
        });
        if (response === undefined) return { ok: false, code: "service_unavailable" };
        return mapResponseEnvelope(response, id);
      }
      const response = decodeResponseFrame(
        await Promise.race([readFramedResponse(socket, abortController.signal), deadline]),
        { method },
      );
      if (response === undefined) return { ok: false, code: "service_unavailable" };
      return mapResponseEnvelope(response, id);
    } catch {
      return { ok: false, code: "service_unavailable" };
    } finally {
      globalThis.clearTimeout(timer);
      if (socket !== undefined) destroyQuietly(socket);
    }
  }
}

/**
 * Decide how a request crosses the wire before anything connects.
 *
 * A request fits one frame exactly when today's serializer accepts it —
 * its field bounds, which are the daemon's protocol-1 grammar, and the
 * frame bound — and then it goes as that frame, byte for byte. Only a
 * create / append / update that today's serializer refuses, and that is
 * valid once its body field is bounded by `WIRE_BODY_BYTES` instead,
 * becomes a body-path candidate. A body over that bound is `too_large`
 * for any daemon; anything else keeps today's `invalid_request`.
 */
function planRequest(id: string, method: SocketMethod, params: SocketParams): RequestPlan {
  try {
    return { kind: "frame", frame: serializeRequest(id, method, params) };
  } catch {
    // Not a single frame; only a body method can go further.
  }
  if (method !== "notes.create" && method !== "notes.append" && method !== "notes.update") {
    return { kind: "refused", code: "invalid_request" };
  }
  try {
    requireRequestId(id);
    const split = splitBodyField(method, projectRequestParams(method, params, WIRE_BODY_BYTES));
    // A body the frame could not carry in full, with no body field to move.
    if (split === undefined) return { kind: "refused", code: "too_large" };
    // The declared bytes must be the caller's text exactly; a lone surrogate
    // would be replaced by U+FFFD on encoding rather than refused.
    if (!isWellFormedUtf16(split.value)) return { kind: "refused", code: "invalid_request" };
    const body = Buffer.from(split.value, "utf8");
    const declaration = Object.create(null) as Record<string, unknown>;
    declaration.field = split.field;
    declaration.bytes = body.byteLength;
    declaration.sha256 = createHash("sha256").update(body).digest("hex");
    return {
      kind: "body",
      header: frameRequestEnvelope(id, method, split.params, declaration),
      body: Uint8Array.from(body),
    };
  } catch {
    // Fall through: decide between oversize and malformed.
  }
  try {
    projectRequestParams(method, params, Number.POSITIVE_INFINITY);
  } catch {
    return { kind: "refused", code: "invalid_request" };
  }
  return { kind: "refused", code: "too_large" };
}

/**
 * The body field is fixed per method, matching the daemon's declaration
 * grammar: `content` for create and update, `markdownFragment` for append.
 * Returns the params with that field removed, or `undefined` when an
 * update patch carries no content.
 */
function splitBodyField(
  method: "notes.create" | "notes.append" | "notes.update",
  cleanParams: Record<string, unknown>,
):
  | {
      readonly field: "content" | "markdownFragment";
      readonly value: string;
      readonly params: Record<string, unknown>;
    }
  | undefined {
  const params = Object.create(null) as Record<string, unknown>;
  if (method === "notes.update") {
    const patch = Object.create(null) as Record<string, unknown>;
    const source = cleanParams.patch as Record<string, unknown>;
    if (typeof source.content !== "string") return undefined;
    for (const key of Object.keys(source)) {
      if (key !== "content") patch[key] = source[key];
    }
    for (const key of Object.keys(cleanParams)) {
      params[key] = key === "patch" ? Object.freeze(patch) : cleanParams[key];
    }
    return { field: "content", value: source.content, params: Object.freeze(params) };
  }
  const field = method === "notes.create" ? "content" : "markdownFragment";
  const value = cleanParams[field];
  if (typeof value !== "string") throw new TypeError("nook-mcp: body field is missing");
  for (const key of Object.keys(cleanParams)) {
    if (key !== field) params[key] = cleanParams[key];
  }
  return { field, value, params: Object.freeze(params) };
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function requireRequestId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || hasControlCharacter(id)) {
    throw new TypeError("nook-mcp: invalid request id");
  }
}

/**
 * Serialise the request payload into a length-prefixed frame.
 *
 * The implementation deliberately hand-rolls the JSON serialisation
 * so a hostile request envelope cannot smuggle extra fields or a
 * hostile `toJSON` trap past the boundary. The query is bounded by
 * the Stage 5 `maxQueryBytes` budget so a multi-byte hostile payload
 * is rejected before any allocation happens.
 */
function serializeRequest(id: string, method: SocketMethod, params: SocketParams): Uint8Array {
  requireRequestId(id);
  return frameRequestEnvelope(
    id,
    method,
    projectRequestParams(method, params, STAGE5_RPC_LIMITS.maxContentBytes),
  );
}

/**
 * Validate and project the caller's params. `contentCap` bounds the body
 * field — create `content`, append `markdownFragment`, update
 * `patch.content` — and nothing else: it is the single-frame field bound
 * for a single frame and `WIRE_BODY_BYTES` for a body-path header.
 */
function projectRequestParams(
  method: SocketMethod,
  params: SocketParams,
  contentCap: number,
): Record<string, unknown> {
  let cleanParams: Record<string, unknown> | Record<string, never>;
  if (method === "notes.search") {
    const query = (params as RpcNotesSearchParams).query;
    if (typeof query !== "string" || query.length === 0)
      throw new TypeError("nook-mcp: query is invalid");
    if (Buffer.byteLength(query, "utf8") > STAGE5_RPC_LIMITS.maxQueryBytes)
      throw new RangeError("nook-mcp: query is too large");
    cleanParams = { query };
  } else if (method === "notes.get") {
    const getParams = params as RpcNotesGetParams;
    if ("id" in getParams) {
      const noteId = getParams.id;
      if (
        typeof noteId !== "string" ||
        noteId.length === 0 ||
        noteId.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
        Buffer.byteLength(noteId, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
        hasControlCharacter(noteId)
      )
        throw new TypeError("nook-mcp: note id is invalid");
      cleanParams = { id: noteId };
    } else cleanParams = snapshotDeleteParams(getParams);
  } else if (method === "notes.create") {
    const create = params as RpcNotesCreateParams;
    if (
      typeof create.title !== "string" ||
      create.title.length === 0 ||
      Buffer.byteLength(create.title, "utf8") > RPC_TITLE_BYTES ||
      hasControlCharacter(create.title) ||
      typeof create.content !== "string" ||
      create.content.length === 0 ||
      Buffer.byteLength(create.content, "utf8") > contentCap ||
      hasDisallowedControlCharacter(create.content) ||
      (create.notebookId !== undefined &&
        (!isSafeIdentifier(create.notebookId) ||
          Buffer.byteLength(create.notebookId, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes)) ||
      (create.listKind !== undefined && !isClosedListKind(create.listKind))
    ) {
      throw new TypeError("nook-mcp: create parameters are invalid");
    }
    const baseParams: Record<string, unknown> = {
      title: create.title,
      content: create.content,
    };
    if (create.notebookId !== undefined) baseParams.notebookId = create.notebookId;
    if (create.listKind !== undefined) baseParams.listKind = create.listKind;
    cleanParams = baseParams;
  } else if (method === "notes.append") {
    const append = params as RpcNotesAppendParams;
    if (
      !isSafeIdentifier(append.id) ||
      Buffer.byteLength(append.id, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      typeof append.markdownFragment !== "string" ||
      append.markdownFragment.length === 0 ||
      Buffer.byteLength(append.markdownFragment, "utf8") > contentCap ||
      hasDisallowedControlCharacter(append.markdownFragment) ||
      typeof append.expectedRevision !== "string" ||
      !/^rev_[0-9a-f]{32}$/.test(append.expectedRevision) ||
      (append.listKind !== undefined && !isClosedListKind(append.listKind))
    ) {
      throw new TypeError("nook-mcp: append parameters are invalid");
    }
    const baseParams: Record<string, unknown> = {
      id: append.id,
      markdownFragment: append.markdownFragment,
      expectedRevision: append.expectedRevision,
    };
    if (append.listKind !== undefined) baseParams.listKind = append.listKind;
    cleanParams = baseParams;
  } else if (method === "notes.update") {
    cleanParams = snapshotUpdateParams(params, contentCap);
  } else if (method === "notes.delete") {
    cleanParams = snapshotDeleteParams(params);
  } else if (method === "notes.locked_note_proof") {
    cleanParams = snapshotDeleteParams(params);
  } else if (method === "notes.path_diagnostic") {
    cleanParams = snapshotDeleteParams(params);
  } else {
    if (Object.keys(params).length !== 0)
      throw new TypeError("nook-mcp: parameterless request has fields");
    cleanParams = {};
  }
  return cleanParams;
}

/**
 * Frame `{ id, method, params }` — plus `body` for a body-path header —
 * behind its four-byte length prefix, refusing a frame over the bound.
 */
function frameRequestEnvelope(
  id: string,
  method: SocketMethod,
  cleanParams: Record<string, unknown>,
  body?: Record<string, unknown>,
): Uint8Array {
  const envelope = Object.create(null) as Record<string, unknown>;
  envelope.id = id;
  envelope.method = method;
  envelope.params = cleanParams;
  if (body !== undefined) envelope.body = body;
  const payload = JSON.stringify(envelope);
  const payloadBytes = Buffer.from(payload, "utf8");
  if (payloadBytes.byteLength + FRAME_PREFIX_BYTES > MAX_FRAME_BYTES_ON_WIRE) {
    throw new RangeError("nook-mcp: request exceeds maximum frame bytes");
  }
  const frame = new Uint8Array(FRAME_PREFIX_BYTES + payloadBytes.byteLength);
  frame[0] = (payloadBytes.byteLength >>> 24) & 0xff;
  frame[1] = (payloadBytes.byteLength >>> 16) & 0xff;
  frame[2] = (payloadBytes.byteLength >>> 8) & 0xff;
  frame[3] = payloadBytes.byteLength & 0xff;
  payloadBytes.copy(frame, FRAME_PREFIX_BYTES);
  return frame;
}

/**
 * Validate and project the update request without ever serializing caller
 * objects.  In particular, descriptor reads reject accessors and copy only
 * primitive allowlisted values, so JSON.stringify cannot invoke a caller's
 * getter or toJSON hook after validation.
 */
function snapshotDeleteParams(value: unknown): Record<string, unknown> {
  try {
    const values = readExactDataProperties(value, ["path"]);
    const path = values.path;
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      Buffer.byteLength(path, "utf8") > STAGE5_RPC_LIMITS.maxQueryBytes ||
      hasDisallowedControlCharacter(path) ||
      path.includes("\\")
    ) {
      throw new TypeError("nook-mcp: delete parameters are invalid");
    }
    return Object.freeze({ path });
  } catch {
    // Fall through to the explicit notebook/title address forms.
  }

  for (const keys of [["noteTitle"], ["notebookPath", "noteTitle"]] as const) {
    try {
      const values = readExactDataProperties(value, keys);
      const noteTitle = values.noteTitle;
      const notebookPath = values.notebookPath;
      if (
        typeof noteTitle !== "string" ||
        noteTitle.length === 0 ||
        Buffer.byteLength(noteTitle, "utf8") > STAGE5_RPC_LIMITS.maxTitleBytes ||
        hasDisallowedControlCharacter(noteTitle) ||
        (keys.length === 2 &&
          (typeof notebookPath !== "string" ||
            notebookPath.length === 0 ||
            Buffer.byteLength(notebookPath, "utf8") > STAGE5_RPC_LIMITS.maxQueryBytes ||
            hasDisallowedControlCharacter(notebookPath)))
      ) {
        throw new TypeError("nook-mcp: delete parameters are invalid");
      }
      const output = Object.create(null) as Record<string, unknown>;
      output.noteTitle = noteTitle;
      if (keys.length === 2) output.notebookPath = notebookPath;
      return Object.freeze(output);
    } catch {
      // Try the next exact closed shape.
    }
  }
  throw new TypeError("nook-mcp: delete parameters are invalid");
}

function snapshotUpdateParams(value: unknown, contentCap: number): Record<string, unknown> {
  const values = readExactDataProperties(value, ["id", "expectedRevision", "patch"]);
  const id = values.id;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    Buffer.byteLength(id, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
    !isSafeIdentifier(id)
  ) {
    throw new TypeError("nook-mcp: update parameters are invalid");
  }
  const expectedRevision = values.expectedRevision;
  if (
    typeof expectedRevision !== "string" ||
    expectedRevision.length === 0 ||
    !/^rev_[0-9a-f]{32}$/.test(expectedRevision)
  ) {
    throw new TypeError("nook-mcp: update parameters are invalid");
  }

  const output = Object.create(null) as Record<string, unknown>;
  output.id = id;
  output.expectedRevision = expectedRevision;
  output.patch = snapshotUpdatePatch(values.patch, contentCap);
  return Object.freeze(output);
}

function readExactDataProperties(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new TypeError("nook-mcp: update parameters are invalid");
  }
  if (value === null || typeof value !== "object" || isArray) {
    throw new TypeError("nook-mcp: update parameters are invalid");
  }
  const record = value as object;
  try {
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
      throw new TypeError("nook-mcp: update parameters are invalid");
    }
    const names = Object.getOwnPropertyNames(record);
    if (Object.getOwnPropertySymbols(record).length !== 0 || names.length !== expected.length) {
      throw new TypeError("nook-mcp: update parameters are invalid");
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expected) {
      if (!names.includes(key)) throw new TypeError("nook-mcp: update parameters are invalid");
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
        throw new TypeError("nook-mcp: update parameters are invalid");
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof TypeError && error.message === "nook-mcp: update parameters are invalid") {
      throw error;
    }
    throw new TypeError("nook-mcp: update parameters are invalid");
  }
}

function snapshotUpdatePatch(
  value: unknown,
  contentCap: number,
): Readonly<Record<string, unknown>> {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new TypeError("nook-mcp: update patch is invalid");
  }
  if (value === null || typeof value !== "object" || isArray) {
    throw new TypeError("nook-mcp: update patch is invalid");
  }
  const patch = value as object;
  let names: string[];
  try {
    const prototype = Object.getPrototypeOf(patch);
    if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
      throw new TypeError("nook-mcp: update patch is invalid");
    }
    names = Object.getOwnPropertyNames(patch);
    if (Object.getOwnPropertySymbols(patch).length !== 0 || names.length === 0) {
      throw new TypeError("nook-mcp: update patch is invalid");
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === "nook-mcp: update patch is invalid") {
      throw error;
    }
    throw new TypeError("nook-mcp: update patch is invalid");
  }

  const output = Object.create(null) as Record<string, unknown>;
  for (const key of names) {
    if (!isUpdatePatchField(key)) throw new TypeError("nook-mcp: update patch is invalid");
    const descriptor = Object.getOwnPropertyDescriptor(patch, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError("nook-mcp: update patch is invalid");
    }
    const raw = descriptor.value;
    if (key === "tags") {
      output[key] = snapshotUpdateTags(raw);
    } else if (key === "title") {
      output[key] = requireBoundedSocketString(raw, RPC_TITLE_BYTES, false);
    } else if (key === "content") {
      output[key] = requireBoundedSocketString(raw, contentCap, false, true);
    } else if (key === "notebookId") {
      output[key] = requireBoundedSocketString(raw, STAGE5_RPC_LIMITS.maxIdentifierBytes, true);
    } else if (key === "listKind") {
      // Closed-set gate: reject any value outside `simple-checklist`
      // or `task-list` so the wire surface never sees a malformed
      // intent.  The codec and contract surface will accept the
      // closed-set value as-is.
      if (!isClosedListKind(raw)) {
        throw new TypeError("nook-mcp: update patch is invalid");
      }
      output[key] = raw;
    } else if (typeof raw !== "boolean") {
      throw new TypeError("nook-mcp: update patch is invalid");
    } else {
      output[key] = raw;
    }
  }
  return Object.freeze(output);
}

function isUpdatePatchField(value: string): boolean {
  return (
    value === "title" ||
    value === "content" ||
    value === "notebookId" ||
    value === "tags" ||
    value === "pinned" ||
    value === "favorite" ||
    value === "listKind"
  );
}

/**
 * Closed list-intent gate.  The selector is rejected BEFORE the
 * request is framed so a hostile client cannot smuggle an unknown
 * intent past the socket boundary.  Mirrors the closed
 * {@link NOTESNOOK_LIST_KINDS} set in the contract.
 */
function isClosedListKind(value: unknown): value is NotesnookListKind {
  return typeof value === "string" && NOTESNOOK_LIST_KINDS.includes(value as NotesnookListKind);
}

/**
 * `markdownContent` marks note body text: tab/LF/CR are structural whitespace there
 * (as in create/append), while every other control character stays invalid.
 */
function requireBoundedSocketString(
  value: unknown,
  maxBytes: number,
  identifier: boolean,
  markdownContent = false,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes) {
    throw new TypeError("nook-mcp: update patch is invalid");
  }
  const hasBadControl = markdownContent
    ? hasDisallowedControlCharacter(value)
    : hasControlCharacter(value);
  if (Buffer.byteLength(value, "utf8") > maxBytes || hasBadControl) {
    throw new TypeError("nook-mcp: update patch is invalid");
  }
  if (identifier && !isSafeIdentifier(value)) {
    throw new TypeError("nook-mcp: update patch is invalid");
  }
  return value;
}

function snapshotUpdateTags(value: unknown): readonly string[] {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new TypeError("nook-mcp: update patch is invalid");
  }
  if (!isArray) throw new TypeError("nook-mcp: update patch is invalid");
  const array = value as object;
  let length: number;
  let names: string[];
  try {
    const prototype = Object.getPrototypeOf(array);
    if (prototype !== ARRAY_PROTOTYPE && prototype !== null) {
      throw new TypeError("nook-mcp: update patch is invalid");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(array, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number"
    ) {
      throw new TypeError("nook-mcp: update patch is invalid");
    }
    length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length === 0 || length > 16) {
      throw new TypeError("nook-mcp: update patch is invalid");
    }
    names = Object.getOwnPropertyNames(array);
    if (Object.getOwnPropertySymbols(array).length !== 0 || names.length !== length + 1) {
      throw new TypeError("nook-mcp: update patch is invalid");
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === "nook-mcp: update patch is invalid") {
      throw error;
    }
    throw new TypeError("nook-mcp: update patch is invalid");
  }

  const output: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!names.includes(key)) throw new TypeError("nook-mcp: update patch is invalid");
    const descriptor = Object.getOwnPropertyDescriptor(array, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError("nook-mcp: update patch is invalid");
    }
    const entry = descriptor.value;
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      Buffer.byteLength(entry, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
      hasControlCharacter(entry)
    ) {
      throw new TypeError("nook-mcp: update patch is invalid");
    }
    output.push(entry);
  }
  Object.setPrototypeOf(output, null);
  return Object.freeze(output);
}

async function writeAll(socket: Socket, frame: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readFramedResponse(socket: Socket, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("timeout"));
      return;
    }
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (cb: () => void): void => {
      if (settled) return;
      settled = true;
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
      cb();
    };
    const onData = (chunk: Buffer): void => {
      if (
        chunk.length > MAX_RESPONSE_FRAME_BYTES + FRAME_PREFIX_BYTES ||
        buffer.length > MAX_RESPONSE_FRAME_BYTES + FRAME_PREFIX_BYTES - chunk.length
      ) {
        finish(() => reject(new Error("frame too large")));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < FRAME_PREFIX_BYTES) return;
      const declared = buffer.readUInt32BE(0);
      if (declared === 0 || declared > MAX_RESPONSE_FRAME_BYTES) {
        finish(() => reject(new Error("invalid frame length")));
        return;
      }
      if (buffer.length < FRAME_PREFIX_BYTES + declared) return;
      const frame = Uint8Array.from(buffer.subarray(0, FRAME_PREFIX_BYTES + declared));
      finish(() => resolve(frame));
    };
    const onError = (error: Error): void => {
      finish(() => reject(error));
    };
    const onClose = (): void => {
      finish(() => reject(new Error("socket closed before frame")));
    };
    const onAbort = (): void => {
      finish(() => reject(new Error("timeout")));
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function destroyQuietly(socket: Socket): void {
  try {
    socket.removeAllListeners();
    socket.destroy();
  } catch {
    // best-effort teardown
  }
}

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== expected.length) {
    return false;
  }
  for (const name of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || descriptor.enumerable !== true) return false;
  }
  return expected.every((name) => names.includes(name));
}

interface ResponseDecodeOptions {
  /** The request's method: only `notes.capabilities` may be answered with `capabilities`. */
  readonly method: SocketMethod;
  /** Admit `busy`, which only a body-path header reply may carry. */
  readonly allowBusy?: boolean;
  /** Admit `body_continue`, and only for exactly this many bytes. */
  readonly continueBytes?: number;
  /** Bound on a result's content byte count; a body-path reply may reach `WIRE_BODY_BYTES`. */
  readonly resultContentBytes?: number;
}

/** Decode one response frame, or `undefined` for anything not a valid envelope. */
function decodeResponseFrame(
  frame: Uint8Array,
  options: ResponseDecodeOptions,
): RpcAnyResponseEnvelope | undefined {
  if (frame.byteLength > MAX_RESPONSE_FRAME_BYTES) return undefined;
  try {
    const json = Buffer.from(frame.subarray(FRAME_PREFIX_BYTES)).toString("utf8");
    return decodeResponseEnvelope(JSON.parse(json) as unknown, options);
  } catch {
    return undefined;
  }
}

function decodeResponseEnvelope(
  value: unknown,
  options: ResponseDecodeOptions,
): RpcAnyResponseEnvelope {
  const resultContentBytes = options.resultContentBytes ?? STAGE5_RPC_LIMITS.maxContentBytes;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid response");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || typeof candidate.ok !== "boolean") {
    throw new Error("invalid response");
  }
  if (candidate.ok === true) {
    if (!hasExactOwnKeys(candidate, ["id", "ok", "result"])) {
      throw new Error("invalid response");
    }
    const result = candidate.result;
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("invalid response");
    }
    const resultRecord = result as Record<string, unknown>;
    if (resultRecord.kind === "body_continue" && options.continueBytes !== undefined) {
      if (
        !hasExactOwnKeys(resultRecord, ["kind", "bytes"]) ||
        resultRecord.bytes !== options.continueBytes
      )
        throw new Error("invalid response");
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze({ kind: "body_continue", bytes: options.continueBytes }),
      });
    }
    if (resultRecord.kind === "capabilities" && options.method === "notes.capabilities") {
      // Version 2 or greater can negotiate a body; this client speaks 2.
      if (
        !hasExactOwnKeys(resultRecord, ["kind", "protocol"]) ||
        typeof resultRecord.protocol !== "number" ||
        !Number.isSafeInteger(resultRecord.protocol) ||
        resultRecord.protocol < 2
      )
        throw new Error("invalid response");
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze({ kind: "capabilities", protocol: 2 }),
      });
    }
    if (resultRecord.kind === "search") {
      if (!hasExactOwnKeys(resultRecord, ["kind", "notes"]) || !Array.isArray(resultRecord.notes))
        throw new Error("invalid response");
      if (resultRecord.notes.length > STAGE5_RPC_LIMITS.maxSearchHits)
        throw new Error("invalid response");
      const notes = resultRecord.notes.map((note): { readonly title: string } => {
        if (
          typeof note !== "object" ||
          note === null ||
          Array.isArray(note) ||
          !hasExactOwnKeys(note, ["title"])
        )
          throw new Error("invalid response");
        const title = (note as Record<string, unknown>).title;
        if (
          typeof title !== "string" ||
          title.length === 0 ||
          Buffer.byteLength(title, "utf8") > STAGE5_RPC_LIMITS.maxTitleBytes ||
          hasControlCharacter(title)
        )
          throw new Error("invalid response");
        return Object.freeze({ title });
      });
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze({ kind: "search", notes: Object.freeze(notes) }),
      });
    }
    if (resultRecord.kind === "status") {
      // conflictedCount is optional: absent means "not measured". When present
      // it must be a safe non-negative integer; it is never defaulted to zero.
      const measured = Object.prototype.hasOwnProperty.call(resultRecord, "conflictedCount");
      if (
        !hasExactOwnKeys(
          resultRecord,
          measured
            ? ["kind", "lastSynced", "hasUnsyncedChanges", "conflictedCount"]
            : ["kind", "lastSynced", "hasUnsyncedChanges"],
        ) ||
        typeof resultRecord.lastSynced !== "number" ||
        !Number.isFinite(resultRecord.lastSynced) ||
        resultRecord.lastSynced < 0 ||
        typeof resultRecord.hasUnsyncedChanges !== "boolean" ||
        (measured &&
          (typeof resultRecord.conflictedCount !== "number" ||
            !Number.isSafeInteger(resultRecord.conflictedCount) ||
            resultRecord.conflictedCount < 0))
      )
        throw new Error("invalid response");
      const conflictedCount = resultRecord.conflictedCount;
      const statusResult =
        measured && typeof conflictedCount === "number"
          ? {
              kind: "status" as const,
              lastSynced: resultRecord.lastSynced,
              hasUnsyncedChanges: resultRecord.hasUnsyncedChanges,
              conflictedCount,
            }
          : {
              kind: "status" as const,
              lastSynced: resultRecord.lastSynced,
              hasUnsyncedChanges: resultRecord.hasUnsyncedChanges,
            };
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze(statusResult),
      });
    }
    if (resultRecord.kind === "notebooks") {
      if (
        !hasExactOwnKeys(resultRecord, ["kind", "notebooks"]) ||
        !Array.isArray(resultRecord.notebooks) ||
        resultRecord.notebooks.length > STAGE5_RPC_LIMITS.maxSearchHits
      )
        throw new Error("invalid response");
      const notebooks = resultRecord.notebooks.map((entry) => decodeNotebook(entry));
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze({ kind: "notebooks", notebooks: Object.freeze(notebooks) }),
      }) as unknown as RpcAnyResponseEnvelope;
    }
    if (resultRecord.kind === "note") {
      const hasContent = hasExactOwnKeys(resultRecord, [
        "kind",
        "note",
        "contentStatus",
        "markdown",
        "markdownBytes",
      ]);
      const hasNoContent = hasExactOwnKeys(resultRecord, ["kind", "note", "contentStatus"]);
      const hasUnavailableReason = hasExactOwnKeys(resultRecord, [
        "kind",
        "note",
        "contentStatus",
        "contentReason",
      ]);
      if (!hasContent && !hasNoContent && !hasUnavailableReason)
        throw new Error("invalid response");
      if (
        resultRecord.contentStatus !== "ok" &&
        resultRecord.contentStatus !== "locked" &&
        resultRecord.contentStatus !== "oversize" &&
        resultRecord.contentStatus !== "unavailable"
      )
        throw new Error("invalid response");
      if (hasContent !== (resultRecord.contentStatus === "ok")) throw new Error("invalid response");
      if (
        hasUnavailableReason &&
        (resultRecord.contentStatus !== "unavailable" ||
          (resultRecord.contentReason !== "reader_unavailable" &&
            resultRecord.contentReason !== "read_failed"))
      )
        throw new Error("invalid response");
      const note = decodeNote(resultRecord.note);
      if (!hasContent) {
        const noContentResult: Record<string, unknown> = {
          kind: "note",
          note,
          contentStatus: resultRecord.contentStatus,
        };
        if (hasUnavailableReason) noContentResult.contentReason = resultRecord.contentReason;
        return Object.freeze({
          id: candidate.id,
          ok: true,
          result: Object.freeze(noContentResult),
        }) as unknown as RpcAnyResponseEnvelope;
      }
      if (
        typeof resultRecord.markdown !== "string" ||
        // A title-only note is legitimately empty: `markdown: ""` with
        // `markdownBytes: 0` is a valid `contentStatus: "ok"` result. The
        // byte-length agreement below still pins the accounting exactly.
        Buffer.byteLength(resultRecord.markdown, "utf8") > STAGE5_RPC_LIMITS.maxResponseBytes ||
        typeof resultRecord.markdownBytes !== "number" ||
        !Number.isInteger(resultRecord.markdownBytes) ||
        resultRecord.markdownBytes < 0 ||
        resultRecord.markdownBytes > STAGE5_RPC_LIMITS.maxResponseBytes ||
        resultRecord.markdownBytes !== Buffer.byteLength(resultRecord.markdown, "utf8")
      )
        throw new Error("invalid response");
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze({
          kind: "note",
          note,
          contentStatus: "ok",
          markdown: resultRecord.markdown,
          markdownBytes: resultRecord.markdownBytes,
        }),
      }) as unknown as RpcAnyResponseEnvelope;
    }
    if (resultRecord.kind === "create") {
      if (
        !hasExactOwnKeys(resultRecord, ["kind", "id", "titleBytes", "contentBytes"]) ||
        typeof resultRecord.id !== "string" ||
        !isSafeIdentifier(resultRecord.id) ||
        Buffer.byteLength(resultRecord.id, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
        typeof resultRecord.titleBytes !== "number" ||
        !Number.isInteger(resultRecord.titleBytes) ||
        resultRecord.titleBytes < 0 ||
        resultRecord.titleBytes > RPC_TITLE_BYTES ||
        typeof resultRecord.contentBytes !== "number" ||
        !Number.isInteger(resultRecord.contentBytes) ||
        resultRecord.contentBytes < 0 ||
        resultRecord.contentBytes > resultContentBytes
      )
        throw new Error("invalid response");
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze({
          kind: "create",
          id: resultRecord.id,
          titleBytes: resultRecord.titleBytes,
          contentBytes: resultRecord.contentBytes,
        }),
      }) as unknown as RpcAnyResponseEnvelope;
    }
    if (resultRecord.kind === "append") {
      if (
        !hasExactOwnKeys(resultRecord, ["kind", "id", "fragmentBytes"]) ||
        typeof resultRecord.id !== "string" ||
        !isSafeIdentifier(resultRecord.id) ||
        Buffer.byteLength(resultRecord.id, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
        typeof resultRecord.fragmentBytes !== "number" ||
        !Number.isFinite(resultRecord.fragmentBytes) ||
        resultRecord.fragmentBytes < 0 ||
        resultRecord.fragmentBytes > resultContentBytes
      )
        throw new Error("invalid response");
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze({
          kind: "append",
          id: resultRecord.id,
          fragmentBytes: resultRecord.fragmentBytes,
        }),
      }) as unknown as RpcAnyResponseEnvelope;
    }
    if (resultRecord.kind === "update") {
      const hasContentBytes = Object.hasOwn(resultRecord, "contentBytes");
      const fields = resultRecord.appliedFields;
      if (
        !hasExactOwnKeys(
          resultRecord,
          hasContentBytes
            ? ["kind", "id", "appliedFields", "contentBytes"]
            : ["kind", "id", "appliedFields"],
        ) ||
        typeof resultRecord.id !== "string" ||
        !isSafeIdentifier(resultRecord.id) ||
        Buffer.byteLength(resultRecord.id, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes ||
        !Array.isArray(fields) ||
        fields.length === 0 ||
        fields.length > 6 ||
        new Set(fields).size !== fields.length ||
        fields.some(
          (field) =>
            !["title", "content", "notebookId", "tags", "pinned", "favorite"].includes(field),
        ) ||
        (hasContentBytes &&
          (typeof resultRecord.contentBytes !== "number" ||
            !Number.isFinite(resultRecord.contentBytes) ||
            resultRecord.contentBytes < 0 ||
            resultRecord.contentBytes > resultContentBytes))
      )
        throw new Error("invalid response");
      const updateResult: Record<string, unknown> = {
        kind: "update",
        id: resultRecord.id,
        appliedFields: Object.freeze([...fields]),
      };
      if (hasContentBytes) updateResult.contentBytes = resultRecord.contentBytes;
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze(updateResult),
      }) as unknown as RpcAnyResponseEnvelope;
    }
    if (resultRecord.kind === "delete") {
      if (
        !hasExactOwnKeys(resultRecord, ["kind", "id"]) ||
        typeof resultRecord.id !== "string" ||
        !isSafeIdentifier(resultRecord.id) ||
        Buffer.byteLength(resultRecord.id, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes
      )
        throw new Error("invalid response");
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze({ kind: "delete", id: resultRecord.id }),
      }) as unknown as RpcAnyResponseEnvelope;
    }
    if (resultRecord.kind === "locked_note_proof") {
      const read = resultRecord.read;
      const update = resultRecord.update;
      const remove = resultRecord.delete;
      if (
        !hasExactOwnKeys(resultRecord, ["kind", "pathBytes", "read", "update", "delete"]) ||
        typeof resultRecord.pathBytes !== "number" ||
        !Number.isSafeInteger(resultRecord.pathBytes) ||
        resultRecord.pathBytes < 0 ||
        resultRecord.pathBytes > STAGE5_RPC_LIMITS.maxQueryBytes ||
        !isLockedNoteProofCode(read) ||
        !isLockedNoteProofCode(update) ||
        !isLockedNoteProofCode(remove)
      )
        throw new Error("invalid response");
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze({
          kind: "locked_note_proof",
          pathBytes: resultRecord.pathBytes,
          read,
          update,
          delete: remove,
        }),
      }) as unknown as RpcAnyResponseEnvelope;
    }
    if (resultRecord.kind === "path_diagnostic") {
      const title = resultRecord.title;
      const notebook = resultRecord.notebook;
      const directMembership = resultRecord.directMembership;
      const recursiveMembership = resultRecord.recursiveMembership;
      const revision = resultRecord.revision;
      const contentType = resultRecord.contentType;
      const htmlPrefix = resultRecord.htmlPrefix;
      const simpleChecklist = resultRecord.simpleChecklist;
      const taskList = resultRecord.taskList;
      const literalMarkdown = resultRecord.literalMarkdown;
      if (
        !hasExactOwnKeys(resultRecord, [
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
        ]) ||
        typeof resultRecord.pathBytes !== "number" ||
        !Number.isSafeInteger(resultRecord.pathBytes) ||
        resultRecord.pathBytes < 0 ||
        resultRecord.pathBytes > STAGE5_RPC_LIMITS.maxQueryBytes ||
        !isPathDiagnosticTitle(title) ||
        !isPathDiagnosticStage(notebook) ||
        !isPathDiagnosticStage(directMembership) ||
        !isPathDiagnosticStage(recursiveMembership) ||
        !isPathDiagnosticRevision(revision) ||
        !isPathDiagnosticContentType(contentType) ||
        !isPathDiagnosticContentMarker(htmlPrefix) ||
        !isPathDiagnosticContentMarker(simpleChecklist) ||
        !isPathDiagnosticContentMarker(taskList) ||
        !isPathDiagnosticContentMarker(literalMarkdown)
      )
        throw new Error("invalid response");
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze({
          kind: "path_diagnostic",
          pathBytes: resultRecord.pathBytes,
          title,
          notebook,
          directMembership,
          recursiveMembership,
          revision,
          contentType,
          htmlPrefix,
          simpleChecklist,
          taskList,
          literalMarkdown,
        }),
      }) as unknown as RpcAnyResponseEnvelope;
    }
    if (resultRecord.kind === "sync") {
      if (
        !hasExactOwnKeys(resultRecord, ["kind", "status", "pendingSync", "attempts"]) ||
        (resultRecord.status !== "idle" && resultRecord.status !== "synced") ||
        typeof resultRecord.pendingSync !== "boolean" ||
        typeof resultRecord.attempts !== "number" ||
        !Number.isSafeInteger(resultRecord.attempts) ||
        resultRecord.attempts < 0 ||
        resultRecord.attempts > 8
      )
        throw new Error("invalid response");
      return Object.freeze({
        id: candidate.id,
        ok: true,
        result: Object.freeze({
          kind: "sync",
          status: resultRecord.status,
          pendingSync: resultRecord.pendingSync,
          attempts: resultRecord.attempts,
        }),
      }) as unknown as RpcAnyResponseEnvelope;
    }
    throw new Error("invalid response");
  }
  const error = candidate.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    throw new Error("invalid response");
  }
  const errorRecord = error as Record<string, unknown>;
  if (
    !hasExactOwnKeys(errorRecord, ["code", "message"]) ||
    !(
      isRpcErrorCode(errorRecord.code) ||
      (options.allowBusy === true && errorRecord.code === "busy")
    ) ||
    typeof errorRecord.message !== "string"
  ) {
    throw new Error("invalid response");
  }
  return Object.freeze({
    id: candidate.id,
    ok: false,
    error: Object.freeze({ code: errorRecord.code, message: "Categorical RPC error" }),
  });
}

function isLockedNoteProofCode(
  value: unknown,
): value is "vault_locked" | "ok" | "not_found" | "permission_denied" | "service_unavailable" {
  return (
    value === "vault_locked" ||
    value === "ok" ||
    value === "not_found" ||
    value === "permission_denied" ||
    value === "service_unavailable"
  );
}

function isPathDiagnosticTitle(
  value: unknown,
): value is "none" | "one" | "multiple" | "unavailable" {
  return value === "none" || value === "one" || value === "multiple" || value === "unavailable";
}

function isPathDiagnosticStage(
  value: unknown,
): value is "present" | "absent" | "unavailable" | "not_applicable" {
  return (
    value === "present" ||
    value === "absent" ||
    value === "unavailable" ||
    value === "not_applicable"
  );
}

function isPathDiagnosticRevision(
  value: unknown,
): value is "valid" | "invalid" | "unavailable" | "not_applicable" {
  return (
    value === "valid" ||
    value === "invalid" ||
    value === "unavailable" ||
    value === "not_applicable"
  );
}

function isPathDiagnosticContentType(value: unknown): value is "tiptap" | "other" | "unavailable" {
  return value === "tiptap" || value === "other" || value === "unavailable";
}

function isPathDiagnosticContentMarker(
  value: unknown,
): value is "present" | "absent" | "unavailable" {
  return value === "present" || value === "absent" || value === "unavailable";
}

function decodeNotebook(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid response");
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !isSafeIdentifier(record.id) ||
    Buffer.byteLength(record.id, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes
  )
    throw new Error("invalid response");
  if (
    typeof record.title !== "string" ||
    record.title.length === 0 ||
    Buffer.byteLength(record.title, "utf8") > STAGE5_RPC_LIMITS.maxTitleBytes ||
    hasControlCharacter(record.title)
  )
    throw new Error("invalid response");
  const projected: Record<string, unknown> = { id: record.id, title: record.title };
  for (const key of ["dateCreated", "dateModified"] as const) {
    if (Object.hasOwn(record, key)) {
      if (
        record[key] !== undefined &&
        (typeof record[key] !== "number" || !Number.isFinite(record[key]) || record[key] < 0)
      )
        throw new Error("invalid response");
      if (record[key] !== undefined) projected[key] = record[key];
    }
  }
  return Object.freeze(projected);
}

function decodeNote(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid response");
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    !isSafeIdentifier(record.id) ||
    Buffer.byteLength(record.id, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes
  )
    throw new Error("invalid response");
  if (
    typeof record.title !== "string" ||
    record.title.length === 0 ||
    Buffer.byteLength(record.title, "utf8") > STAGE5_RPC_LIMITS.maxTitleBytes ||
    hasControlCharacter(record.title)
  )
    throw new Error("invalid response");
  const projected: Record<string, unknown> = { id: record.id, title: record.title };
  if (Object.hasOwn(record, "revision")) {
    if (
      record.revision !== undefined &&
      (typeof record.revision !== "string" || !/^rev_[0-9a-f]{32}$/.test(record.revision))
    )
      throw new Error("invalid response");
    if (record.revision !== undefined) projected.revision = record.revision;
  }
  for (const key of ["dateCreated", "dateModified"] as const) {
    if (Object.hasOwn(record, key)) {
      if (
        record[key] !== undefined &&
        (typeof record[key] !== "number" || !Number.isFinite(record[key]) || record[key] < 0)
      )
        throw new Error("invalid response");
      if (record[key] !== undefined) projected[key] = record[key];
    }
  }
  if (Object.hasOwn(record, "notebookId")) {
    if (
      record.notebookId !== undefined &&
      (typeof record.notebookId !== "string" ||
        !isSafeIdentifier(record.notebookId) ||
        Buffer.byteLength(record.notebookId, "utf8") > STAGE5_RPC_LIMITS.maxIdentifierBytes)
    )
      throw new Error("invalid response");
    if (record.notebookId !== undefined) projected.notebookId = record.notebookId;
  }
  for (const key of ["pinned", "favorite", "localOnly", "conflicted", "locked"] as const) {
    if (Object.hasOwn(record, key)) {
      if (record[key] !== undefined && typeof record[key] !== "boolean")
        throw new Error("invalid response");
      if (record[key] !== undefined) projected[key] = record[key];
    }
  }
  return Object.freeze(projected);
}

function isRpcErrorCode(value: unknown): value is RpcErrorCode {
  return (
    value === "invalid_request" ||
    value === "too_large" ||
    value === "permission_denied" ||
    value === "service_unavailable" ||
    value === "stale_revision" ||
    value === "conflict" ||
    value === "sync_failed" ||
    value === "vault_locked" ||
    value === "not_found" ||
    value === "local_sync_marker_failed" ||
    value === "unapproved_pending" ||
    value === "unsupported_content" ||
    value === "sync_required"
  );
}

function mapResponseEnvelope(
  response: RpcAnyResponseEnvelope,
  expectedId: string,
): NookdSocketResult {
  if (response.id !== expectedId) {
    return { ok: false, code: "service_unavailable" };
  }
  if (response.ok === true) {
    const envelope = response as RpcAnySuccessEnvelope;
    const result = envelope.result as RpcResult;
    if (
      result === undefined ||
      result === null ||
      typeof result !== "object" ||
      ![
        "search",
        "status",
        "notebooks",
        "note",
        "create",
        "append",
        "update",
        "delete",
        "locked_note_proof",
        "path_diagnostic",
        "sync",
        "capabilities",
      ].includes(result.kind)
    ) {
      return { ok: false, code: "service_unavailable" };
    }
    return { ok: true, envelope };
  }
  return { ok: false, code: mapRpcErrorCodeToSocketFailure(response.error.code) };
}

function isSafeIdentifier(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const allowed =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x2d ||
      code === 0x5f;
    if (!allowed) return false;
  }
  return true;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0 && code <= 0x1f) || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whitelist tabs, LF, and CR for inputs that the codec re-tokenises
 * (Markdown fragments).  Reject every other ASCII control byte.
 * Identifiers and titles keep the strict check above.
 */
function hasDisallowedControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

let requestCounter = 0;
function generateRequestId(): string {
  requestCounter = (requestCounter + 1) >>> 0;
  // 64-bit hex prefix; opaque to the daemon (it treats the id as an
  // opaque token).  Generating it locally avoids leaking any
  // external id (e.g. an MCP request id) across the socket.
  const low = requestCounter.toString(16).padStart(8, "0");
  return `nook-mcp-${Date.now().toString(16)}-${low}`;
}
