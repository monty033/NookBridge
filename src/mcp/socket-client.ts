/**
 * Stage 6 — framed Unix-socket transport seam for `nook-mcp`.
 *
 * The proxy talks to the trusted `nookd` daemon over a permission-
 * controlled Unix-domain socket using the existing Stage 5 framed
 * `notes.search` RPC. This module owns the *transport* layer only;
 * it does NOT parse the RPC envelope (Stage 5 already does that in
 * `rpc-protocol.ts`) and it does NOT inspect the response payload
 * beyond its top-level `ok` flag.
 *
 * Hard rules:
 *
 *   - Only the configured absolute socket path is connected.
 *     No fallback paths, no env-driven path lookup, no implicit
 *     defaults. The transport seam rejects relative paths.
 *   - Requests are bounded by the published Stage 5 frame budget
 *     before they cross the wire, so a hostile caller cannot
 *     force the proxy to write an oversized framed payload.
 *   - Responses are bounded by the same Stage 5 frame budget.
 *   - Any connect / read / write / timeout failure is normalized
 *     to a categorical `service_unavailable` outcome. The
 *     underlying errno, syscall name, and socket path never
 *     appear in the error surface.
 *   - The `connect` seam exists so tests can inject a fake
 *     transport without ever opening a real socket.
 */

import { Buffer } from "node:buffer";
import { createConnection, type Socket } from "node:net";
import { clearTimeout, setTimeout } from "node:timers";
import { isAbsolute, resolve } from "node:path";

import {
  STAGE5_RPC_LIMITS,
  type RpcErrorCode,
  type RpcNotesSearchParams,
  type RpcResponseEnvelope,
  type RpcSearchResult,
  type RpcSuccessEnvelope,
} from "../service/rpc-protocol.js";

const FRAME_PREFIX_BYTES = 4;
const MAX_FRAME_BYTES_ON_WIRE = STAGE5_RPC_LIMITS.maxFrameBytes;
const MAX_RESPONSE_FRAME_BYTES = STAGE5_RPC_LIMITS.maxResponseBytes;

/** Default connect / read timeout. Kept short to surface a closed
 *  socket quickly rather than leaving Hermes waiting. */
const DEFAULT_IO_TIMEOUT_MS = 5_000;

/**
 * Closed result of a single socket I/O round-trip. Either the
 * decoded response envelope (which the caller hands back to the
 * MCP layer) or a categorical error code.
 *
 * `reason` is intentionally a closed string set so the MCP layer
 * never has to inspect a raw upstream message.
 */
export type NookdSocketResult =
  | { readonly ok: true; readonly envelope: RpcSuccessEnvelope }
  | { readonly ok: false; readonly code: NookdSocketFailure };

export type NookdSocketFailure =
  | "service_unavailable"
  | "invalid_request"
  | "permission_denied"
  | "sync_failed"
  | "vault_locked"
  | "not_found";

/**
 * Map a Stage 5 RPC error envelope code to the closed
 * socket-failure vocabulary. Anything we don't recognise falls
 * back to `service_unavailable` so the agent never sees a raw
 * upstream category.
 */
function mapRpcErrorCodeToSocketFailure(code: RpcErrorCode): NookdSocketFailure {
  switch (code) {
    case "invalid_request":
      return "invalid_request";
    case "permission_denied":
      return "permission_denied";
    case "service_unavailable":
      return "service_unavailable";
    case "sync_failed":
      return "sync_failed";
    case "vault_locked":
      return "vault_locked";
    case "not_found":
      return "not_found";
    default:
      return "service_unavailable";
  }
}

/**
 * Injection seam used by tests. The default opens a real
 * `net.Socket` and connects to `socketPath`; tests may override
 * it to return a fake.
 */
export type SocketConnect = (path: string) => Promise<Socket>;

async function defaultConnect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

export interface NookdSocketClientOptions {
  readonly socketPath: string;
  /** Tests may substitute a fake connect. */
  readonly connect?: SocketConnect;
  /** Per-operation timeout in ms. Defaults to 5s. */
  readonly ioTimeoutMs?: number;
}

export interface NookdSearchRequest extends RpcNotesSearchParams {
  /** Optional bounded internal correlation id used by tests and callers. */
  readonly id?: string;
}

/**
 * The closed transport seam. Stateless apart from the configured
 * socket path; safe to construct per-call.
 */
export class NookdSocketClient {
  readonly #socketPath: string;
  readonly #connect: SocketConnect;
  readonly #ioTimeoutMs: number;

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

  /**
   * Issue a single `notes.search` RPC against the daemon and
   * return the closed result. The query is bounded by the
   * Stage 5 frame budget before any I/O happens.
   */
  async search(params: NookdSearchRequest): Promise<NookdSocketResult> {
    const id = params.id ?? generateRequestId();
    let frame: Uint8Array;
    try {
      frame = serializeSearchRequest(id, params);
    } catch {
      return { ok: false, code: "invalid_request" };
    }
    if (frame.byteLength > MAX_FRAME_BYTES_ON_WIRE) {
      return { ok: false, code: "invalid_request" };
    }

    let socket: Socket;
    try {
      socket = await this.#connect(this.#socketPath);
    } catch {
      return { ok: false, code: "service_unavailable" };
    }

    try {
      await writeAll(socket, frame);
      const responseFrame = await readFramedResponse(socket, this.#ioTimeoutMs);
      if (responseFrame.byteLength > MAX_RESPONSE_FRAME_BYTES) {
        return { ok: false, code: "service_unavailable" };
      }
      let response: RpcResponseEnvelope;
      try {
        const json = Buffer.from(responseFrame.subarray(FRAME_PREFIX_BYTES)).toString("utf8");
        const decoded: unknown = JSON.parse(json);
        response = decodeResponseEnvelope(decoded);
      } catch {
        return { ok: false, code: "service_unavailable" };
      }
      return mapResponseEnvelope(response, id);
    } catch {
      return { ok: false, code: "service_unavailable" };
    } finally {
      destroyQuietly(socket);
    }
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
function serializeSearchRequest(id: string, params: RpcNotesSearchParams): Uint8Array {
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || hasControlCharacter(id)) {
    throw new TypeError("nook-mcp: invalid request id");
  }
  if (typeof params.query !== "string") {
    throw new TypeError("nook-mcp: query must be a string");
  }
  if (params.query.length === 0) {
    throw new TypeError("nook-mcp: query must be non-empty");
  }
  if (Buffer.byteLength(params.query, "utf8") > STAGE5_RPC_LIMITS.maxQueryBytes) {
    throw new RangeError("nook-mcp: query exceeds maximum query bytes");
  }
  const payload = JSON.stringify({
    id,
    method: "notes.search",
    params: { query: params.query },
  });
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

async function writeAll(socket: Socket, frame: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readFramedResponse(socket: Socket, ioTimeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (cb: () => void): void => {
      if (settled) return;
      settled = true;
      socket.off("data", onData);
      socket.off("error", onError);
      clearTimeout(timer);
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
    const timer = setTimeout(() => {
      finish(() => reject(new Error("timeout")));
    }, ioTimeoutMs);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.once("close", () => {
      finish(() => reject(new Error("socket closed before frame")));
    });
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

function decodeResponseEnvelope(value: unknown): RpcResponseEnvelope {
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
    if (
      !hasExactOwnKeys(resultRecord, ["kind", "notes"]) ||
      resultRecord.kind !== "search" ||
      !Array.isArray(resultRecord.notes)
    ) {
      throw new Error("invalid response");
    }
    if (resultRecord.notes.length > STAGE5_RPC_LIMITS.maxSearchHits) {
      throw new Error("invalid response");
    }
    const notes = resultRecord.notes.map((note): { readonly title: string } => {
      if (
        typeof note !== "object" ||
        note === null ||
        Array.isArray(note) ||
        !hasExactOwnKeys(note, ["title"])
      ) {
        throw new Error("invalid response");
      }
      const title = (note as Record<string, unknown>).title;
      if (
        typeof title !== "string" ||
        Buffer.byteLength(title, "utf8") > STAGE5_RPC_LIMITS.maxTitleBytes
      ) {
        throw new Error("invalid response");
      }
      return Object.freeze({ title });
    });
    return Object.freeze({
      id: candidate.id,
      ok: true,
      result: Object.freeze({ kind: "search", notes: Object.freeze(notes) }),
    });
  }
  if (!hasExactOwnKeys(candidate, ["id", "ok", "error"])) {
    throw new Error("invalid response");
  }
  const error = candidate.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    throw new Error("invalid response");
  }
  const errorRecord = error as Record<string, unknown>;
  if (
    !hasExactOwnKeys(errorRecord, ["code", "message"]) ||
    !isRpcErrorCode(errorRecord.code) ||
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

function isRpcErrorCode(value: unknown): value is RpcErrorCode {
  return (
    value === "invalid_request" ||
    value === "permission_denied" ||
    value === "service_unavailable" ||
    value === "sync_failed" ||
    value === "vault_locked" ||
    value === "not_found"
  );
}

function mapResponseEnvelope(response: RpcResponseEnvelope, expectedId: string): NookdSocketResult {
  if (response.id !== expectedId) {
    return { ok: false, code: "service_unavailable" };
  }
  if (response.ok === true) {
    const envelope = response as RpcSuccessEnvelope;
    const result = envelope.result as RpcSearchResult;
    if (
      result === undefined ||
      result === null ||
      typeof result !== "object" ||
      result.kind !== "search"
    ) {
      return { ok: false, code: "service_unavailable" };
    }
    return { ok: true, envelope };
  }
  return { ok: false, code: mapRpcErrorCodeToSocketFailure(response.error.code) };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0 && code <= 0x1f) || code === 0x7f) return true;
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
