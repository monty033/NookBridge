/**
 * Stage 5 — bounded `nookd` Unix-socket service.
 *
 * This is the transport/lifecycle boundary for the one allowed service
 * operation. It owns no Notesnook object: the only capability it receives is
 * the already-bounded service runtime's title-only `search` function and
 * cleanup hook.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { lchown, lstat, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as scheduleTimeout, clearTimeout } from "node:timers";
import { TextDecoder } from "node:util";

import {
  buildServiceAuditRecord,
  emitServiceAudit,
  type ServiceAuditEvent,
  type ServiceAuditOutcome,
  type ServiceAuditPeerCredentials,
  type ServiceAuditPhase,
} from "./service-audit.js";
import {
  DEFAULT_SERVICE_ABUSE_BOUNDS,
  normalizeServiceAbuseBounds,
  type ServiceAbuseBounds,
} from "./service-abuse-bounds.js";
import { handleRpcRequest, type RpcHandlerRuntimeLike } from "./rpc-handler.js";
import { fitsSingleFrameNoteProjection } from "./note-content-projection.js";
import {
  createReadOnlyServicePolicy,
  narrowServicePolicy,
  policyNamesMethod,
  type ServicePolicy,
} from "./service-policy.js";
import {
  RPC_ERROR_MESSAGES,
  createRpcFrameParser,
  createRpcResponseSerializer,
  isRpcProtocolOversizeError,
  type RpcAcceptRequest,
  type RpcAnyResponseEnvelope,
  type RpcBodyRequest,
  type RpcErrorCode,
  type RpcFrameRequest,
  type RpcMethod,
  type RpcRequest,
} from "./rpc-protocol.js";
import {
  createLargeBodyBudget,
  type LargeBodyBudget,
  type LargeBodyLease,
} from "./large-body-budget.js";
import {
  startOperatorSocketServer,
  UNIX_SOCKET_PATH_MAX_BYTES,
  type StartOperatorSocketServerOptions,
  type OperatorSocketServerHandle,
} from "./operator-socket-server.js";
import { isOperatorTransportMethod } from "./operator-methods.js";
import type { OperatorPeer } from "./operator-server.js";
import { defaultPeerCredentialHelperPath, resolvePeerAsync } from "./peer-credentials.js";
import type { Logger } from "../logging/logger.js";
import { RPC_FRAME_BYTES, WIRE_BODY_BYTES } from "../core/size-limits.js";

const FRAME_PREFIX_BYTES = 4;
const MAX_FRAME_BYTES_ON_WIRE = RPC_FRAME_BYTES;
const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES_ON_WIRE - FRAME_PREFIX_BYTES;
const MAX_PENDING_BYTES = MAX_FRAME_BYTES_ON_WIRE * 2;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_SOCKET_MODE = 0o770;
const DEFAULT_MAX_CONNECTIONS = 32;
const MAX_CONNECTIONS = 128;
const DEFAULT_MAX_REQUESTS_PER_CONNECTION = 64;
const MAX_REQUESTS_PER_CONNECTION = 1_024;
const AUDIT_METHOD_SENTINEL = "notes.search" as const;
const PEER_RESOLUTION_TIMEOUT_MS = 1_000;
const parseDaemonRpcFrame = createRpcFrameParser({ allowBody: true });
const serializeDaemonRpcResponse = createRpcResponseSerializer({ allowBody: true });

export type NookdPeerResolver = (
  socket: net.Socket,
  signal: AbortSignal,
) => Promise<OperatorPeer | undefined>;

/** Operator literals the daemon socket neither serves nor answers. */
function isOperatorOnlyMethod(method: string): boolean {
  return (
    isOperatorTransportMethod(method) &&
    method !== "notes.create" &&
    method !== "notes.path_diagnostic"
  );
}

function peekRpcMethod(frame: Buffer): RpcMethod {
  try {
    if (frame.length < FRAME_PREFIX_BYTES) return AUDIT_METHOD_SENTINEL;
    const payloadLength = frame.readUInt32BE(0);
    if (payloadLength !== frame.length - FRAME_PREFIX_BYTES) return AUDIT_METHOD_SENTINEL;
    const parsed: unknown = JSON.parse(frame.subarray(FRAME_PREFIX_BYTES).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return AUDIT_METHOD_SENTINEL;
    }
    const method = (parsed as Record<string, unknown>).method;
    if (
      method === "notes.capabilities" ||
      method === "notes.search" ||
      method === "notes.status" ||
      method === "notes.list_notebooks" ||
      method === "notes.get" ||
      method === "notes.create" ||
      method === "notes.append" ||
      method === "notes.update" ||
      method === "notes.delete" ||
      method === "notes.locked_note_proof" ||
      method === "notes.path_diagnostic" ||
      method === "notes.sync"
    ) {
      return method;
    }
  } catch {
    // The full parser remains authoritative; this is a body-free breadcrumb.
  }
  return AUDIT_METHOD_SENTINEL;
}

/**
 * `true` when a codec-refused frame names an operator literal the daemon must
 * not answer. A frame that cannot be re-read is treated as one: no answer.
 */
function peekOperatorOnlyMethod(frame: Buffer): boolean {
  try {
    if (frame.length < FRAME_PREFIX_BYTES) return true;
    const payloadLength = frame.readUInt32BE(0);
    if (payloadLength !== frame.length - FRAME_PREFIX_BYTES) return true;
    const parsed: unknown = JSON.parse(frame.subarray(FRAME_PREFIX_BYTES).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return true;
    const method = (parsed as Record<string, unknown>).method;
    return typeof method !== "string" || isOperatorOnlyMethod(method);
  } catch {
    return true;
  }
}

/** Recover only the already size-bounded id for a codec-identified wire refusal. */
function peekRpcRequestId(frame: Buffer): string | undefined {
  try {
    if (frame.length < FRAME_PREFIX_BYTES) return undefined;
    const payloadLength = frame.readUInt32BE(0);
    if (payloadLength !== frame.length - FRAME_PREFIX_BYTES) return undefined;
    const parsed: unknown = JSON.parse(frame.subarray(FRAME_PREFIX_BYTES).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const id = (parsed as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The deliberately narrow runtime seam owned by the daemon. */
export type NookdServerRuntime = RpcHandlerRuntimeLike &
  Readonly<{
    cleanup: () => Promise<void>;
  }>;

export type StartNookdServerOptions = Readonly<{
  /** Absolute filesystem path for the Unix stream socket. */
  socketPath: string;
  /** The bounded service runtime; no raw Notesnook handle is accepted here. */
  runtime: NookdServerRuntime;
  /** Optional daemon-owned operator endpoint; omitted disables it. */
  operator?: StartOperatorSocketServerOptions;
  /** The frozen service-side authorization policy; defaults to readOnly. */
  policy?: ServicePolicy;
  /** Optional socket permission bits, applied after a successful bind. Defaults to 0770. */
  socketMode?: number;
  /**
   * Group to apply to the bound socket. When set, startup resolves it, applies
   * it if needed, and verifies the result before any connection is accepted;
   * any failure unlinks the socket and rejects startup.
   */
  socketGroup?: string;
  /** Resolves `socketGroup` to a gid. Required when `socketGroup` is set. */
  resolveGroupId?: (name: string) => Promise<number | undefined>;
  /** Internal seam; defaults to `lchown(path, -1, gid)`. */
  applySocketGroup?: (socketPath: string, gid: number) => Promise<void>;
  /** Maximum time to let an in-flight handler finish during shutdown. */
  shutdownTimeoutMs?: number;
  /** Maximum number of simultaneously accepted Unix-socket connections. */
  maxConnections?: number;
  /** Maximum number of requests processed on one connection. */
  maxRequestsPerConnection?: number;
  /** Closed service-side abuse bounds; defaults are applied once at startup. */
  abuseBounds?: ServiceAbuseBounds;
  /** Internal test seam; production uses the daemon's one-slot body budget. */
  bodyBudget?: LargeBodyBudget;
  /** Best-effort categorical audit logger. */
  auditLogger?: Logger;
  /**
   * Internal seam for resolving the connecting peer. Defaults to the
   * asynchronous SO_PEERCRED helper resolver; tests inject a deterministic
   * result.
   */
  resolvePeer?: NookdPeerResolver;
  /** Entry points may install SIGTERM/SIGINT; tests can disable the hooks. */
  installSignalHandlers?: boolean;
}>;

export interface NookdServerHandle {
  readonly socketPath: string;
  readonly operatorSocketPath?: string;
  readonly shutdown: () => Promise<void>;
  /** Alias for callers that use the conventional server lifecycle name. */
  readonly close: () => Promise<void>;
}

interface BodyReceiveState {
  readonly lease: LargeBodyLease;
  readonly buffer: Buffer;
  readonly completion: Promise<Buffer | undefined>;
  readonly resolve: (buffer: Buffer | undefined) => void;
  offset: number;
  continueSent: boolean;
  timer: ReturnType<typeof scheduleTimeout> | undefined;
}

interface ConnectionState {
  readonly socket: net.Socket;
  pending: Buffer;
  body: BodyReceiveState | undefined;
  /**
   * Set once a body is complete and cleared only as its response is written.
   * Any byte in between is beyond the declared length, not a next request.
   */
  bodyAwaitingResponse: boolean;
  processing: boolean;
  requestsHandled: number;
  ended: boolean;
  closed: boolean;
  closing: boolean;
  lastActivityMs: number;
  elapsedMs: number;
  idleTimer: ReturnType<typeof scheduleTimeout> | undefined;
  /**
   * Runtime operations still settling after the transport moved on
   * (PR-65 P1-5).  The connection stays "closing" until this set is
   * empty so a follow-up request cannot race against a still-running
   * runtime call.
   */
  readonly runtimeInFlight: Set<Promise<unknown>>;
  readonly closePromise: Promise<void>;
  readonly resolveClosed: () => void;
  readonly peerController: AbortController;
  peer: Promise<ServiceAuditPeerCredentials>;
  /** Effective category after the bounded wait; never a numeric peer id. */
  peerCategory: ServiceAuditPeerCredentials;
  peerWaited: boolean;
}

type FrameRead =
  | { readonly kind: "incomplete" }
  | { readonly kind: "invalid" }
  | { readonly kind: "frame"; readonly frame: Buffer };

/**
 * Bind and start the local service. Existing filesystem entries are never
 * removed: stale socket recovery is an operator/deployment responsibility.
 */
export async function startNookdServer(
  options: StartNookdServerOptions,
): Promise<NookdServerHandle> {
  const capturedOptions = captureStartOptions(options);
  const normalized = validateOptions(capturedOptions);
  const existing = await inspectExistingSocketPath(normalized.socketPath);
  if (existing) {
    throw nookdServerError("nookd socket path has an existing entry");
  }

  const connections = new Set<ConnectionState>();
  const inFlight = new Set<Promise<void>>();
  // Every handleRpcRequest promise until it settles. A timeout or disconnect
  // never removes an entry: only the runtime settling does.
  const runtimeOps = new Set<Promise<unknown>>();
  const runtimeOpOwners = new Map<Promise<unknown>, ConnectionState>();
  // Stays false until the socket group (if any) has been applied and verified,
  // so a peer that connects right after bind is destroyed, not served.
  let accepting = false;
  let ownedSocketIdentity: { readonly dev: number; readonly ino: number } | undefined;
  let operatorServer: OperatorSocketServerHandle | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let signalHandlersInstalled = false;
  let admissionTokens = normalized.abuseBounds.perProcessBurstSize;
  let admissionRefillMs = Date.now();

  const audit = (
    event: ServiceAuditEvent,
    outcome: ServiceAuditOutcome,
    method: RpcMethod = AUDIT_METHOD_SENTINEL,
    requestIdEcho = false,
    latencyMs = 0,
    peerCredentials: ServiceAuditPeerCredentials = "unknown",
    phase?: ServiceAuditPhase,
  ): void => {
    try {
      emitServiceAudit(
        normalized.auditLogger,
        buildServiceAuditRecord({
          event,
          outcome,
          method,
          requestIdEcho,
          latencyMs,
          peerCredentials,
          ...(phase === undefined ? {} : { phase }),
        }),
      );
    } catch {
      // Audit is best effort and must never alter transport behaviour.
    }
  };

  const admitConnection = (): boolean => {
    const now = Date.now();
    const elapsed = Math.max(0, now - admissionRefillMs);
    if (elapsed > 0) {
      admissionTokens = Math.min(
        normalized.abuseBounds.perProcessBurstSize,
        admissionTokens + (elapsed * normalized.abuseBounds.perProcessRequestsPerSecond) / 1_000,
      );
      admissionRefillMs = now;
    }
    if (admissionTokens < 1) return false;
    admissionTokens -= 1;
    return true;
  };

  // Runtime ops whose connection is gone. Derived from the live sets on each
  // call, so an op settling after its connection was destroyed cannot be
  // counted twice or leave a stale count behind.
  const detachedOps = (): number => {
    let count = 0;
    for (const owner of runtimeOpOwners.values()) {
      if (!connections.has(owner)) count += 1;
    }
    return count;
  };

  const onConnection = (socket: net.Socket): void => {
    if (
      !accepting ||
      connections.size + detachedOps() >= normalized.maxConnections ||
      !admitConnection()
    ) {
      audit(
        "rpc.connection.admission_rejected",
        "admission_rejected",
        AUDIT_METHOD_SENTINEL,
        false,
        0,
        "rejected",
      );
      socket.destroy();
      return;
    }
    let resolveClosed: () => void = () => undefined;
    const stateResolver = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const peerController = new AbortController();
    const state: ConnectionState = {
      socket,
      pending: Buffer.alloc(0),
      body: undefined,
      bodyAwaitingResponse: false,
      processing: false,
      requestsHandled: 0,
      ended: false,
      closed: false,
      closing: false,
      lastActivityMs: Date.now(),
      elapsedMs: 0,
      idleTimer: undefined,
      runtimeInFlight: new Set<Promise<unknown>>(),
      closePromise: stateResolver,
      resolveClosed: () => resolveClosed(),
      peerController,
      peer: Promise.resolve("unknown"),
      peerCategory: "unknown",
      peerWaited: false,
    };
    connections.add(state);
    const selfUid = process.getuid?.();
    let peerLookup: Promise<OperatorPeer | undefined>;
    try {
      peerLookup = Promise.resolve(normalized.resolvePeer(socket, peerController.signal));
    } catch {
      peerLookup = Promise.resolve(undefined);
    }
    state.peer = peerLookup.then(
      (peer) => {
        if (peer === undefined) return "unknown";
        return peer.uid === selfUid ? "self" : "verified";
      },
      () => "unknown",
    );
    socket.on("data", (chunk: Buffer): void => {
      if (state.closed || !accepting) return;
      state.lastActivityMs = Date.now();
      armIdleTimer(state);
      if (state.body !== undefined) {
        receiveBodyBytes(state, chunk);
        return;
      }
      if (state.bodyAwaitingResponse) {
        destroyConnection(state);
        return;
      }
      if (state.pending.length + chunk.length > MAX_PENDING_BYTES) {
        destroyConnection(state);
        return;
      }
      state.pending =
        state.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([state.pending, chunk]);
      processConnection(state);
    });
    socket.on("end", (): void => {
      state.ended = true;
      clearIdleTimer(state);
      if (state.body !== undefined) {
        destroyConnection(state);
        return;
      }
      processConnection(state);
    });
    socket.on("error", (): void => {
      // The close event normally follows, but unblock the cancellation race
      // immediately as defense in depth. Never forward the raw error.
      state.closed = true;
      cancelBodyReceive(state);
      state.resolveClosed();
    });
    socket.on("close", (): void => {
      state.closed = true;
      clearIdleTimer(state);
      cancelBodyReceive(state);
      state.resolveClosed();
      connections.delete(state);
      audit("rpc.connection.closed", "ok", AUDIT_METHOD_SENTINEL, false, 0, state.peerCategory);
    });
    armIdleTimer(state);
  };
  const server = net.createServer();
  server.on("connection", onConnection);

  try {
    await listenOnUnixSocket(server, normalized.socketPath, normalized.socketMode);
    const bound = await lstat(normalized.socketPath);
    if (!bound.isSocket()) throw nookdServerError("nookd did not create a Unix socket");
    ownedSocketIdentity = { dev: bound.dev, ino: bound.ino };
    if (normalized.socketGroup !== undefined) {
      await applyAndVerifySocketGroup(
        normalized.socketPath,
        ownedSocketIdentity,
        normalized.socketMode,
        normalized.socketGroup,
        normalized.resolveGroupId,
        normalized.applySocketGroup,
      );
    }
    accepting = true;
  } catch (error) {
    server.close();
    await unlinkOwnedSocket(normalized.socketPath, ownedSocketIdentity);
    if (isNookdServerError(error)) throw error;
    throw nookdServerError("nookd Unix socket could not be created");
  }

  if (normalized.operator !== undefined) {
    try {
      operatorServer = await startOperatorSocketServer(normalized.operator);
    } catch {
      await closeServer(server);
      await unlinkOwnedSocket(normalized.socketPath, ownedSocketIdentity);
      throw nookdServerError("nookd operator socket could not be created");
    }
  }

  const removeSignalHandlers = (): void => {
    if (!signalHandlersInstalled) return;
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    signalHandlersInstalled = false;
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = (async (): Promise<void> => {
      accepting = false;
      removeSignalHandlers();
      const serverClosed = closeServer(server);
      for (const state of connections) destroyConnection(state);
      admissionTokens = 0;
      await waitForInFlight(inFlight, normalized.shutdownTimeoutMs);
      await serverClosed;
      await operatorServer?.close();
      await unlinkOwnedSocket(normalized.socketPath, ownedSocketIdentity);
      // shutdownTimeoutMs only caps the connection loops above. The runtime
      // (and its database) is released only once every runtime op has settled;
      // there is deliberately no timeout here. systemd TimeoutStopSec/SIGKILL
      // is the backstop and SQLite WAL recovers a crash.
      while (runtimeOps.size > 0) {
        await Promise.allSettled([...runtimeOps]);
      }
      try {
        await normalized.runtime.cleanup();
      } catch {
        throw nookdServerError("nookd runtime cleanup failed");
      }
    })();
    return shutdownPromise;
  };

  const onSignal = (): void => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  };

  if (normalized.installSignalHandlers) {
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    signalHandlersInstalled = true;
  }

  return Object.freeze({
    socketPath: normalized.socketPath,
    ...(operatorServer === undefined ? {} : { operatorSocketPath: operatorServer.socketPath }),
    shutdown,
    close: shutdown,
  });

  function clearIdleTimer(state: ConnectionState): void {
    if (state.idleTimer === undefined) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }

  function destroyConnection(state: ConnectionState): void {
    state.closing = true;
    cancelBodyReceive(state);
    state.peerController.abort();
    clearIdleTimer(state);
    // PR-65 P1-5 — runtime ownership.  Resolve the close promise only
    // after every runtime operation handed off via `registerInFlight`
    // has settled.  The transport races ahead of the runtime, but
    // shutdown waits for the runtime so a follow-up connection cannot
    // race against a still-running operation.
    const drain = Promise.allSettled([...state.runtimeInFlight]).then(() => undefined);
    state.runtimeInFlight.clear();
    void drain.then(() => state.resolveClosed());
    state.socket.destroy();
  }

  function cancelBodyReceive(state: ConnectionState): void {
    const body = state.body;
    if (body === undefined) return;
    state.body = undefined;
    if (body.timer !== undefined) clearTimeout(body.timer);
    body.lease.release();
    body.resolve(undefined);
  }

  function completeBodyReceive(state: ConnectionState): void {
    const body = state.body;
    if (body === undefined) return;
    state.body = undefined;
    state.bodyAwaitingResponse = true;
    if (body.timer !== undefined) clearTimeout(body.timer);
    // The caller owns the lease from here until the dispatched runtime settles.
    body.resolve(body.buffer);
  }

  function receiveBodyBytes(state: ConnectionState, chunk: Buffer): void {
    const body = state.body;
    if (body === undefined) return;
    if (!body.continueSent || chunk.length > body.buffer.length - body.offset) {
      destroyConnection(state);
      return;
    }
    chunk.copy(body.buffer, body.offset);
    body.offset += chunk.length;
    if (body.offset === body.buffer.length) completeBodyReceive(state);
  }

  function armIdleTimer(state: ConnectionState): void {
    clearIdleTimer(state);
    if (state.closed || state.ended || state.closing) return;
    state.idleTimer = scheduleTimeout(() => {
      state.idleTimer = undefined;
      if (state.closed || state.ended || state.closing) return;
      const idleForMs = Date.now() - state.lastActivityMs;
      if (idleForMs < normalized.abuseBounds.connectionIdleTimeoutMs) {
        armIdleTimer(state);
        return;
      }
      audit(
        "rpc.connection.idle_timeout",
        "timeout",
        AUDIT_METHOD_SENTINEL,
        false,
        idleForMs,
        state.peerCategory,
      );
      destroyConnection(state);
    }, normalized.abuseBounds.connectionIdleTimeoutMs);
  }

  /**
   * Register a runtime operation so the connection waits for it
   * during shutdown (PR-65 P1-5).  Idempotent: registering the same
   * promise twice is a no-op.
   */
  function registerInFlight(state: ConnectionState, promise: Promise<unknown>): void {
    state.runtimeInFlight.add(promise);
    const cleanup = (): void => {
      state.runtimeInFlight.delete(promise);
    };
    promise.then(cleanup, cleanup);
  }

  /**
   * Track a runtime operation at process level until it settles, independent
   * of the connection that started it. Removal is idempotent.
   */
  function registerRuntimeOp(state: ConnectionState, promise: Promise<unknown>): void {
    runtimeOps.add(promise);
    runtimeOpOwners.set(promise, state);
    const release = (): void => {
      runtimeOps.delete(promise);
      runtimeOpOwners.delete(promise);
    };
    promise.then(release, release);
  }

  /**
   * Bound the first frame's wait on peer resolution. Timeout and close both
   * degrade to "unknown"; the connection is still served when it is open.
   */
  async function waitForPeerResolution(
    state: ConnectionState,
  ): Promise<ServiceAuditPeerCredentials> {
    let timeoutHandle: ReturnType<typeof scheduleTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = scheduleTimeout(() => resolve("timeout"), PEER_RESOLUTION_TIMEOUT_MS);
    });
    const closed = state.closePromise.then(() => "closed" as const);
    try {
      const result = await Promise.race([state.peer, timeout, closed]);
      return result === "timeout" || result === "closed" ? "unknown" : result;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  async function refuseRequest(
    state: ConnectionState,
    id: string,
    method: RpcMethod,
    code: RpcErrorCode,
    event: "rpc.protocol.rejected" | "rpc.request.dispatched",
    phase?: ServiceAuditPhase,
  ): Promise<void> {
    audit(event, code, method, id.length > 0, 0, state.peerCategory, phase);
    try {
      const response: RpcAnyResponseEnvelope = {
        id,
        ok: false,
        error: { code, message: RPC_ERROR_MESSAGES[code] },
      };
      const wrote = await writeFrame(state, serializeDaemonRpcResponse(response));
      if (wrote) {
        audit("rpc.response.sent", code, method, id.length > 0, 0, state.peerCategory, phase);
      }
    } catch {
      // A malformed or unserialisable refusal has no safe second response.
    }
    destroyConnection(state);
  }

  /**
   * Write a body-framed response: the header, then exactly the declared raw
   * bytes. The exchange runs under the same absolute deadline as a received
   * body, so a peer that stops reading cannot hold the connection and the
   * buffered body indefinitely. Any failure, including that deadline, destroys
   * the connection; nothing about the exchange outlives it. An expired
   * deadline is audited as the receive side's is: method and outcome only.
   */
  async function writeHeaderAndBody(
    state: ConnectionState,
    header: Uint8Array,
    body: Buffer,
    method: RpcMethod,
    hasId: boolean,
  ): Promise<boolean> {
    let timer: ReturnType<typeof scheduleTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = scheduleTimeout(() => {
        audit(
          "rpc.request.timeout",
          "timeout",
          method,
          hasId,
          normalized.abuseBounds.bodyReceiveTimeoutMs,
          state.peerCategory,
        );
        destroyConnection(state);
        resolve(false);
      }, normalized.abuseBounds.bodyReceiveTimeoutMs);
    });
    try {
      const wrote = await Promise.race([
        writeFrame(state, header).then((ok) => ok && writeFrame(state, body)),
        expired,
      ]);
      return wrote;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function processConnection(state: ConnectionState): void {
    if (state.processing || state.closed || state.closing) return;
    state.processing = true;
    const work = (async (): Promise<void> => {
      // The response-body lease of the accepted read in flight, if any, and
      // the runtime operation computing its projection. See the acquisition.
      let responseLease: LargeBodyLease | undefined;
      let responseRuntime: Promise<unknown> | undefined;
      const releaseResponseLease = (): void => {
        const lease = responseLease;
        if (lease === undefined) return;
        const runtime = responseRuntime;
        responseLease = undefined;
        responseRuntime = undefined;
        // A projection the transport gave up on is still being built: the
        // slot stays owned until the runtime operation building it settles.
        if (runtime === undefined) lease.release();
        else
          runtime.then(
            () => lease.release(),
            () => lease.release(),
          );
      };
      try {
        if (!state.peerWaited) {
          state.peerWaited = true;
          state.peerCategory = await waitForPeerResolution(state);
          if (state.closed || state.closing) return;
        }
        while (!state.closed && !state.closing) {
          if (
            state.requestsHandled >= normalized.maxRequestsPerConnection ||
            state.elapsedMs >= normalized.abuseBounds.perConnectionBudgetMs
          ) {
            audit(
              "rpc.connection.budget_exceeded",
              "budget_exceeded",
              AUDIT_METHOD_SENTINEL,
              false,
              state.elapsedMs,
              state.peerCategory,
            );
            destroyConnection(state);
            break;
          }
          const next = takeFrame(state);
          if (next.kind === "incomplete") break;
          if (next.kind === "invalid") {
            destroyConnection(state);
            break;
          }
          audit("rpc.frame.extracted", "ok", AUDIT_METHOD_SENTINEL, false, 0, state.peerCategory);
          audit(
            "rpc.frame.method_peek",
            "ok",
            peekRpcMethod(next.frame),
            false,
            0,
            state.peerCategory,
          );
          let request: RpcFrameRequest;
          try {
            request = parseDaemonRpcFrame(next.frame);
            if (
              request === undefined ||
              typeof request !== "object" ||
              request === null ||
              typeof request.id !== "string" ||
              typeof request.method !== "string"
            ) {
              throw new Error("rpc protocol: parser returned an invalid request");
            }
            // parseRpcFrame is shared with the operator listener, so it admits the
            // operator literals. The daemon serves notes.create and answers
            // notes.path_diagnostic itself; every other operator literal must be
            // indistinguishable here from an unknown method: no envelope, closed.
            if (isOperatorOnlyMethod(request.method)) {
              throw new Error("rpc protocol: operator method on the daemon socket");
            }
          } catch (error) {
            // An operator literal stays unanswered even when its declaration is
            // oversize; answering too_large would reveal the method exists here.
            if (isRpcProtocolOversizeError(error) && !peekOperatorOnlyMethod(next.frame)) {
              const id = peekRpcRequestId(next.frame);
              if (id !== undefined) {
                await refuseRequest(
                  state,
                  id,
                  peekRpcMethod(next.frame),
                  "too_large",
                  "rpc.protocol.rejected",
                  "wire",
                );
              } else {
                destroyConnection(state);
              }
              break;
            }
            // A malformed frame has no trusted request id. The protocol has no
            // nullable-id response envelope, so close without an error body.
            audit(
              "rpc.protocol.rejected",
              "invalid_request",
              AUDIT_METHOD_SENTINEL,
              false,
              0,
              state.peerCategory,
            );
            destroyConnection(state);
            break;
          }
          audit("rpc.request.parsed", "ok", request.method, false, 0, state.peerCategory);
          state.requestsHandled += 1;
          const requestStartedMs = Date.now();
          audit(
            "rpc.request.received",
            "ok",
            request.method,
            request.id.length > 0,
            0,
            state.peerCategory,
          );
          const usedBody = request.body !== undefined;
          let handlerRequest: RpcRequest;
          let bodyLease: LargeBodyLease | undefined;
          // Set only for a read that carried `accept`: the projection bound.
          let acceptBodyBytes: number | undefined;
          if (request.body !== undefined) {
            // Bytes coalesced with the header arrived before continue could be
            // written. They are framing violations, never pending body data.
            if (state.pending.length > 0) {
              destroyConnection(state);
              break;
            }
            const bodyRequest = request;
            // Refuse before the lease or any continue: a method the allowlist
            // does not name can never be admitted, because a settings context
            // only narrows within the allowlist. Inviting the body first would
            // let any peer hold the single slot for a request bound to fail.
            if (!policyNamesMethod(normalized.policy, bodyRequest.method)) {
              await refuseRequest(
                state,
                bodyRequest.id,
                bodyRequest.method,
                "permission_denied",
                "rpc.protocol.rejected",
              );
              break;
            }
            let acquisition: ReturnType<LargeBodyBudget["tryAcquire"]>;
            try {
              acquisition = normalized.bodyBudget.tryAcquire(bodyRequest.body.bytes);
            } catch {
              destroyConnection(state);
              break;
            }
            if (acquisition.kind === "busy") {
              await refuseRequest(
                state,
                bodyRequest.id,
                bodyRequest.method,
                "busy",
                "rpc.protocol.rejected",
              );
              break;
            }
            bodyLease = acquisition;
            let bodyState: BodyReceiveState;
            try {
              let resolveBody: (buffer: Buffer | undefined) => void = () => undefined;
              const completion = new Promise<Buffer | undefined>((resolve) => {
                resolveBody = resolve;
              });
              bodyState = {
                lease: acquisition,
                buffer: Buffer.alloc(bodyRequest.body.bytes),
                completion,
                resolve: resolveBody,
                offset: 0,
                continueSent: false,
                timer: undefined,
              };
            } catch {
              bodyLease.release();
              destroyConnection(state);
              break;
            }
            state.body = bodyState;
            bodyState.timer = scheduleTimeout(() => {
              audit(
                "rpc.request.timeout",
                "timeout",
                bodyRequest.method,
                bodyRequest.id.length > 0,
                normalized.abuseBounds.bodyReceiveTimeoutMs,
                state.peerCategory,
              );
              destroyConnection(state);
            }, normalized.abuseBounds.bodyReceiveTimeoutMs);
            let continueFrame: Uint8Array;
            try {
              continueFrame = serializeDaemonRpcResponse({
                id: bodyRequest.id,
                ok: true,
                result: { kind: "body_continue", bytes: bodyRequest.body.bytes },
              });
            } catch {
              cancelBodyReceive(state);
              destroyConnection(state);
              break;
            }
            if (!(await writeFrame(state, continueFrame))) {
              cancelBodyReceive(state);
              destroyConnection(state);
              break;
            }
            if (state.body !== bodyState || state.closed || state.closing) break;
            bodyState.continueSent = true;
            const bodyBytes = await bodyState.completion;
            if (bodyBytes === undefined) break;
            if (state.closed || state.closing) {
              bodyLease.release();
              break;
            }
            try {
              const digest = createHash("sha256").update(bodyBytes).digest("hex");
              if (digest !== bodyRequest.body.sha256) throw new Error("body digest mismatch");
              // The lease accounts for the assembly buffer only, sized to the
              // declared bytes. The decoded string and the request that carries
              // it are additional, unaccounted memory held alongside it.
              const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                bodyBytes,
              );
              handlerRequest = attachRpcBody(bodyRequest, value);
            } catch {
              bodyLease.release();
              audit(
                "rpc.protocol.rejected",
                "invalid_request",
                bodyRequest.method,
                bodyRequest.id.length > 0,
                0,
                state.peerCategory,
              );
              destroyConnection(state);
              break;
            }
          } else if (request.accept !== undefined) {
            // The offer bounds the projection; it is not part of the request
            // the handler authorizes, so it never reaches the handler.
            handlerRequest = withoutAccept(request);
            acceptBodyBytes = Math.min(request.accept.bodyBytes, WIRE_BODY_BYTES);
            // An accepted read is admitted through the same single process-
            // wide slot as a received body, taken before the projection is
            // computed. The lease covers that projection (a string of up to
            // the offered bound) and the body buffer encoded from it. A
            // single-frame answer hands it back once serialized; a declared
            // body holds it until the body is written or the exchange ends:
            // success, refusal, deadline, disconnect or throw. A client that stops
            // reading therefore holds it until the send deadline expires, and
            // every other large body or accepted read is refused busy until
            // then. Like a received body's, it is also held until the runtime
            // operation settles, however the transport ended.
            let acquisition: ReturnType<LargeBodyBudget["tryAcquire"]>;
            try {
              acquisition = normalized.bodyBudget.tryAcquire(acceptBodyBytes);
            } catch {
              destroyConnection(state);
              break;
            }
            if (acquisition.kind === "busy") {
              await refuseRequest(
                state,
                request.id,
                request.method,
                "busy",
                "rpc.protocol.rejected",
              );
              break;
            }
            responseLease = acquisition;
          } else {
            handlerRequest = request;
          }
          let timeoutHandle: ReturnType<typeof scheduleTimeout> | undefined;
          const timeout = new Promise<"timeout">((resolve) => {
            timeoutHandle = scheduleTimeout(
              () => resolve("timeout"),
              normalized.abuseBounds.requestTimeoutMs,
            );
          });
          const runtimeOp: Promise<RpcAnyResponseEnvelope> =
            request.method === "notes.capabilities"
              ? Promise.resolve({
                  id: request.id,
                  ok: true,
                  result: { kind: "capabilities", protocol: 2 },
                })
              : handleRpcRequest(handlerRequest, normalized.runtime, normalized.policy, {
                  bodyPath: usedBody,
                  ...(acceptBodyBytes === undefined ? {} : { markdownBodyBytes: acceptBodyBytes }),
                });
          if (bodyLease !== undefined) {
            const lease = bodyLease;
            // A disconnect can end the transport first; the slot remains owned
            // until the already-dispatched runtime operation actually settles.
            // By design there is no timeout here: a runtime operation that
            // never settles holds the slot indefinitely, and every later body
            // is refused busy until it does.
            runtimeOp.then(
              () => lease.release(),
              () => lease.release(),
            );
          }
          if (responseLease !== undefined) responseRuntime = runtimeOp;
          registerRuntimeOp(state, runtimeOp);
          const responsePromise = runtimeOp
            .then((response) => ({
              kind: "response" as const,
              response,
            }))
            .catch(() => ({ kind: "handler_failure" as const }));
          // PR-65 P1-5 — runtime ownership.  When the transport wins
          // (timeout / cancel), the underlying runtime promise keeps
          // running.  Hand it to `inFlight` so the shutdown drain
          // waits for the runtime to settle before closing the
          // connection's lifecycle, and so the next connection cannot
          // race against a still-running operation.  On natural
          // completion the promise is already settled and the drain
          // is a no-op.
          void registerInFlight(state, responsePromise);
          const closed = state.closePromise.then(() => "cancelled" as const);
          const raced = await Promise.race([responsePromise, timeout, closed]);
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          const requestElapsedMs = Math.max(0, Date.now() - requestStartedMs);
          state.elapsedMs += requestElapsedMs;
          if (raced === "timeout") {
            audit(
              "rpc.request.timeout",
              "timeout",
              request.method,
              request.id.length > 0,
              requestElapsedMs,
              state.peerCategory,
            );
            destroyConnection(state);
            break;
          }
          if (raced === "cancelled") break;
          if (state.elapsedMs >= normalized.abuseBounds.perConnectionBudgetMs) {
            audit(
              "rpc.connection.budget_exceeded",
              "budget_exceeded",
              request.method,
              request.id.length > 0,
              state.elapsedMs,
              state.peerCategory,
            );
            destroyConnection(state);
            break;
          }
          if (raced.kind === "handler_failure") {
            audit(
              "rpc.request.dispatched",
              "service_unavailable",
              request.method,
              request.id.length > 0,
              requestElapsedMs,
              state.peerCategory,
            );
            destroyConnection(state);
            break;
          }
          const response = raced.response;
          if (state.closed || state.closing || state.socket.destroyed) break;
          const outcome: ServiceAuditOutcome = response.ok ? "ok" : response.error.code;
          const phase = outcome === "too_large" ? "admission" : undefined;
          audit(
            "rpc.request.dispatched",
            outcome,
            request.method,
            request.id.length > 0,
            requestElapsedMs,
            state.peerCategory,
            phase,
          );
          let responseFrame: Uint8Array;
          let responseBody: Buffer | undefined;
          try {
            // The handler has already produced the whole projection, so the
            // header and every body byte exist before anything is written.
            const split =
              acceptBodyBytes === undefined
                ? undefined
                : splitMarkdownBody(response, acceptBodyBytes);
            responseFrame = serializeDaemonRpcResponse(split?.header ?? response);
            responseBody = split?.body;
            // The single-frame answers carry no body; hand back the slot now.
            if (responseBody === undefined) releaseResponseLease();
          } catch {
            // In particular, do not attempt to serialize a second error when
            // the original response itself exceeded the published bound.
            destroyConnection(state);
            break;
          }
          // From the response write on, a following byte is the peer's next
          // request. There is no await between this and writeFrame issuing it.
          state.bodyAwaitingResponse = false;
          const wrote =
            responseBody === undefined
              ? await writeFrame(state, responseFrame)
              : await writeHeaderAndBody(
                  state,
                  responseFrame,
                  responseBody,
                  request.method,
                  request.id.length > 0,
                );
          releaseResponseLease();
          if (!wrote) {
            destroyConnection(state);
            break;
          }
          if (state.closed || state.closing || state.socket.destroyed) break;
          audit(
            "rpc.response.sent",
            outcome,
            request.method,
            request.id.length > 0,
            Math.max(0, Date.now() - requestStartedMs),
            state.peerCategory,
            phase,
          );
        }
      } finally {
        // Every other exit from an accepted read — refusal, timeout,
        // disconnect, a throw — leaves the loop through here.
        releaseResponseLease();
        state.processing = false;
        if (state.ended && !state.closed) destroyConnection(state);
        else if (!state.closed && !state.closing) armIdleTimer(state);
      }
    })();
    inFlight.add(work);
    void work
      .finally(() => {
        inFlight.delete(work);
      })
      .catch(() => {
        // The work promise is intentionally not exposed; consume finalizer
        // rejection so a transport write failure cannot become unhandled.
      });
  }
}

/** Attach verified text only to the field the closed declaration named. */
function attachRpcBody(request: RpcBodyRequest, value: string): RpcRequest {
  const params = Object.assign(Object.create(null), request.params) as Record<string, unknown>;
  if (request.method === "notes.update") {
    const patch = Object.assign(Object.create(null), request.params.patch) as Record<
      string,
      unknown
    >;
    patch.content = value;
    params.patch = Object.freeze(patch);
  } else if (request.method === "notes.create") {
    params.content = value;
  } else if (request.method === "notes.append") {
    params.markdownFragment = value;
  } else {
    params.markdown = value;
  }
  Object.freeze(params);
  return Object.freeze(
    Object.assign(Object.create(null), {
      id: request.id,
      method: request.method,
      params,
    }),
  ) as RpcRequest;
}

/** The `notes.get` request the handler sees: the same read without the offer. */
function withoutAccept(request: RpcAcceptRequest): RpcRequest {
  return Object.freeze(
    Object.assign(Object.create(null), {
      id: request.id,
      method: request.method,
      params: request.params,
    }),
  ) as RpcRequest;
}

/**
 * Turn an accepted read's content into a header and the raw bytes it
 * declares. `undefined` means the result goes as one frame unchanged: any
 * result without content (`locked`, `oversize`, `unavailable`, an error), and
 * an empty note, because a declared body is at least one byte.
 *
 * Control characters are refused exactly as the single-frame serializer
 * refuses inline Markdown: a failure throws and the caller closes the
 * connection with nothing sent, as it does for the same note without `accept`.
 *
 * A lone surrogate is different. Raw bytes cannot carry one (encoding would
 * replace it), but the single frame does, as a JSON `\uDXXX` escape, and the
 * client accepts it. Such Markdown therefore goes back in one frame under the
 * single-frame bound — inline when the read without `accept` would deliver
 * it, `oversize` when that read would refuse it — so offering `accept` never
 * turns a note that reads today into a failure.
 */
function splitMarkdownBody(
  response: RpcAnyResponseEnvelope,
  bound: number,
): { readonly header: RpcAnyResponseEnvelope; readonly body?: Buffer } | undefined {
  if (!response.ok || response.result.kind !== "note") return undefined;
  const result = response.result;
  if (result.contentStatus !== "ok") return undefined;
  const markdown = result.markdown;
  if (typeof markdown !== "string") throw new Error("note result carries no markdown");
  if (markdown.length === 0) return undefined;
  if (hasDisallowedMarkdownControl(markdown)) {
    throw new Error("note markdown is not deliverable");
  }
  if (!isWellFormedUtf16(markdown)) {
    if (fitsSingleFrameNoteProjection(response.id, result.note, markdown)) return undefined;
    return {
      header: {
        id: response.id,
        ok: true,
        result: { kind: "note", note: result.note, contentStatus: "oversize" },
      },
    };
  }
  const body = Buffer.from(markdown, "utf8");
  if (body.length !== result.markdownBytes || body.length > bound) {
    throw new Error("note markdown does not match its declared size");
  }
  const header: RpcAnyResponseEnvelope = {
    id: response.id,
    ok: true,
    result: {
      kind: "note",
      note: result.note,
      contentStatus: "ok",
      markdownBytes: body.length,
    },
    body: {
      field: "markdown",
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    },
  };
  return { header, body };
}

/** A lone surrogate would be replaced on encoding rather than carried. */
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

/** The serializer's rule for inline Markdown: tab, LF and CR only. */
function hasDisallowedMarkdownControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Alias retained for callers that use a factory-style name. */
export const createNookdServer = startNookdServer;

function captureStartOptions(options: StartNookdServerOptions): StartNookdServerOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw nookdServerError("invalid nookd server options");
  }
  try {
    const socketPath = options.socketPath;
    const runtime = options.runtime;
    const operator = options.operator;
    const policy = options.policy;
    const socketMode = options.socketMode;
    const socketGroup = options.socketGroup;
    const resolveGroupId = options.resolveGroupId;
    const applySocketGroup = options.applySocketGroup;
    const shutdownTimeoutMs = options.shutdownTimeoutMs;
    const maxConnections = options.maxConnections;
    const maxRequestsPerConnection = options.maxRequestsPerConnection;
    const abuseBounds = options.abuseBounds;
    const bodyBudget = options.bodyBudget;
    const auditLogger = options.auditLogger;
    const resolvePeer = options.resolvePeer;
    const installSignalHandlers = options.installSignalHandlers;
    return Object.freeze({
      socketPath,
      runtime,
      ...(operator === undefined ? {} : { operator }),
      ...(policy === undefined ? {} : { policy }),
      ...(socketMode === undefined ? {} : { socketMode }),
      ...(socketGroup === undefined ? {} : { socketGroup }),
      ...(resolveGroupId === undefined ? {} : { resolveGroupId }),
      ...(applySocketGroup === undefined ? {} : { applySocketGroup }),
      ...(shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }),
      ...(maxConnections === undefined ? {} : { maxConnections }),
      ...(maxRequestsPerConnection === undefined ? {} : { maxRequestsPerConnection }),
      ...(abuseBounds === undefined ? {} : { abuseBounds }),
      ...(bodyBudget === undefined ? {} : { bodyBudget }),
      ...(auditLogger === undefined ? {} : { auditLogger }),
      ...(resolvePeer === undefined ? {} : { resolvePeer }),
      ...(installSignalHandlers === undefined ? {} : { installSignalHandlers }),
    });
  } catch {
    throw nookdServerError("invalid nookd server options");
  }
}

type NormalizedStartNookdServerOptions = Omit<
  StartNookdServerOptions,
  | "socketMode"
  | "applySocketGroup"
  | "shutdownTimeoutMs"
  | "maxConnections"
  | "maxRequestsPerConnection"
  | "abuseBounds"
  | "bodyBudget"
  | "auditLogger"
  | "resolvePeer"
  | "installSignalHandlers"
> & {
  readonly socketMode: number;
  readonly applySocketGroup: (socketPath: string, gid: number) => Promise<void>;
  readonly policy: ServicePolicy;
  readonly shutdownTimeoutMs: number;
  readonly maxConnections: number;
  readonly maxRequestsPerConnection: number;
  readonly abuseBounds: ServiceAbuseBounds;
  readonly bodyBudget: LargeBodyBudget;
  readonly auditLogger: Logger | undefined;
  readonly resolvePeer: NookdPeerResolver;
  readonly installSignalHandlers: boolean;
};

function validateOptions(options: StartNookdServerOptions): NormalizedStartNookdServerOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw nookdServerError("invalid nookd server options");
  }
  if (
    typeof options.socketPath !== "string" ||
    hasControlCharacter(options.socketPath) ||
    !path.isAbsolute(options.socketPath) ||
    path.resolve(options.socketPath) !== options.socketPath
  ) {
    throw nookdServerError("nookd socket path must be absolute");
  }
  if (Buffer.byteLength(options.socketPath) > UNIX_SOCKET_PATH_MAX_BYTES) {
    throw nookdServerError("nookd socket path is too long");
  }
  if (
    typeof options.runtime !== "object" ||
    options.runtime === null ||
    typeof options.runtime.search !== "function" ||
    typeof options.runtime.cleanup !== "function"
  ) {
    throw nookdServerError("invalid nookd runtime");
  }
  const policy =
    options.policy === undefined
      ? createReadOnlyServicePolicy()
      : narrowServicePolicy(options.policy);
  if (policy === undefined) throw nookdServerError("invalid nookd service policy");
  if (
    options.socketMode !== undefined &&
    (!Number.isInteger(options.socketMode) || options.socketMode < 0 || options.socketMode > 0o777)
  ) {
    throw nookdServerError("invalid nookd socket mode");
  }
  if (
    options.socketGroup !== undefined &&
    (typeof options.socketGroup !== "string" ||
      options.socketGroup.length === 0 ||
      hasControlCharacter(options.socketGroup) ||
      typeof options.resolveGroupId !== "function")
  ) {
    throw nookdServerError("invalid nookd socket group");
  }
  if (options.resolveGroupId !== undefined && typeof options.resolveGroupId !== "function") {
    throw nookdServerError("invalid nookd socket group");
  }
  if (options.applySocketGroup !== undefined && typeof options.applySocketGroup !== "function") {
    throw nookdServerError("invalid nookd socket group");
  }
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1) {
    throw nookdServerError("invalid nookd shutdown timeout");
  }
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > MAX_CONNECTIONS) {
    throw nookdServerError("invalid nookd connection limit");
  }
  const maxRequestsPerConnection =
    options.maxRequestsPerConnection ?? DEFAULT_MAX_REQUESTS_PER_CONNECTION;
  if (
    !Number.isInteger(maxRequestsPerConnection) ||
    maxRequestsPerConnection < 1 ||
    maxRequestsPerConnection > MAX_REQUESTS_PER_CONNECTION
  ) {
    throw nookdServerError("invalid nookd request limit");
  }
  let abuseBounds: ServiceAbuseBounds;
  try {
    abuseBounds = normalizeServiceAbuseBounds(options.abuseBounds ?? DEFAULT_SERVICE_ABUSE_BOUNDS);
  } catch {
    throw nookdServerError("invalid nookd abuse bounds");
  }
  const bodyBudget = options.bodyBudget;
  if (
    bodyBudget !== undefined &&
    (typeof bodyBudget !== "object" ||
      bodyBudget === null ||
      typeof bodyBudget.tryAcquire !== "function")
  ) {
    throw nookdServerError("invalid nookd body budget");
  }
  const auditLogger = options.auditLogger;
  if (auditLogger !== undefined && (typeof auditLogger !== "object" || auditLogger === null)) {
    throw nookdServerError("invalid nookd audit logger");
  }
  if (options.resolvePeer !== undefined && typeof options.resolvePeer !== "function") {
    throw nookdServerError("invalid nookd peer resolver");
  }
  const resolvePeer =
    options.resolvePeer ??
    ((socket: net.Socket, signal: AbortSignal) =>
      resolvePeerAsync(socket, { helperPath: defaultPeerCredentialHelperPath(), signal }));
  const installSignalHandlers = options.installSignalHandlers ?? true;
  if (typeof installSignalHandlers !== "boolean") {
    throw nookdServerError("invalid nookd signal-handler option");
  }
  const operator = options.operator;
  if (operator !== undefined && (typeof operator !== "object" || operator === null)) {
    throw nookdServerError("invalid nookd operator options");
  }
  return {
    socketPath: options.socketPath,
    runtime: options.runtime,
    policy,
    socketMode: options.socketMode ?? DEFAULT_SOCKET_MODE,
    applySocketGroup: options.applySocketGroup ?? defaultApplySocketGroup,
    shutdownTimeoutMs,
    maxConnections,
    maxRequestsPerConnection,
    abuseBounds,
    bodyBudget: bodyBudget ?? createLargeBodyBudget(),
    auditLogger,
    resolvePeer,
    installSignalHandlers,
    // Must be carried through explicitly: this return value is a hand-written
    // whitelist, and `operator` is optional on the normalized type, so dropping
    // it here disables the operator endpoint silently with no startup error.
    ...(operator === undefined ? {} : { operator }),
    // Same whitelist hazard as `operator`: dropping these would silently skip
    // the group check instead of failing startup.
    ...(options.socketGroup === undefined ? {} : { socketGroup: options.socketGroup }),
    ...(options.resolveGroupId === undefined ? {} : { resolveGroupId: options.resolveGroupId }),
  };
}

function defaultApplySocketGroup(socketPath: string, gid: number): Promise<void> {
  return lchown(socketPath, -1, gid);
}

/**
 * Resolve, apply and verify the socket group. Every failure, including a
 * resolver or chown that throws, collapses to one categorical error so no
 * cause, path or group-file detail leaves this function.
 */
async function applyAndVerifySocketGroup(
  socketPath: string,
  identity: { readonly dev: number; readonly ino: number },
  socketMode: number,
  socketGroup: string,
  resolveGroupId: ((name: string) => Promise<number | undefined>) | undefined,
  applySocketGroup: (socketPath: string, gid: number) => Promise<void>,
): Promise<void> {
  const failure = (): Error => nookdServerError("nookd socket group could not be applied");
  try {
    if (resolveGroupId === undefined) throw failure();
    const gid = await resolveGroupId(socketGroup);
    if (typeof gid !== "number" || !Number.isSafeInteger(gid) || gid < 0) throw failure();
    const before = await lstat(socketPath);
    if (before.gid !== gid) await applySocketGroup(socketPath, gid);
    const after = await lstat(socketPath);
    if (
      !after.isSocket() ||
      after.dev !== identity.dev ||
      after.ino !== identity.ino ||
      after.gid !== gid ||
      (after.mode & 0o777) !== socketMode
    ) {
      throw failure();
    }
  } catch {
    throw failure();
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

async function inspectExistingSocketPath(socketPath: string): Promise<boolean> {
  try {
    await lstat(socketPath);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw nookdServerError("nookd socket path could not be inspected");
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function listenOnUnixSocket(
  server: net.Server,
  socketPath: string,
  socketMode: number,
): Promise<void> {
  const previousUmask = process.umask(0o777 ^ socketMode);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (): void => {
        server.removeListener("listening", onListening);
        reject(nookdServerError("nookd Unix socket could not be created"));
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        try {
          chmodSync(socketPath, socketMode);
        } catch {
          reject(nookdServerError("nookd socket permissions could not be applied"));
          return;
        }
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
  } finally {
    process.umask(previousUmask);
  }
}

function takeFrame(state: ConnectionState): FrameRead {
  if (state.pending.length < FRAME_PREFIX_BYTES) return { kind: "incomplete" };
  const declaredLength = state.pending.readUInt32BE(0);
  if (declaredLength === 0 || declaredLength > MAX_PAYLOAD_BYTES) return { kind: "invalid" };
  const frameLength = FRAME_PREFIX_BYTES + declaredLength;
  if (state.pending.length < frameLength) return { kind: "incomplete" };
  const frame = Buffer.from(state.pending.subarray(0, frameLength));
  state.pending = Buffer.from(state.pending.subarray(frameLength));
  return { kind: "frame", frame };
}

async function writeFrame(state: ConnectionState, frame: Uint8Array): Promise<boolean> {
  if (state.closed || state.closing || state.socket.destroyed) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (success: boolean): void => {
      if (settled) return;
      settled = true;
      state.socket.removeListener("error", onError);
      resolve(success);
    };
    const onError = (): void => finish(false);
    state.socket.once("error", onError);
    try {
      // Keep this state check adjacent to the actual write. There is no await
      // between this check and socket.write, so shutdown cannot interleave.
      if (state.closed || state.closing || state.socket.destroyed) {
        finish(false);
        return;
      }
      state.socket.write(frame, () =>
        finish(!state.closed && !state.closing && !state.socket.destroyed),
      );
    } catch {
      finish(false);
    }
  });
}

async function waitForInFlight(inFlight: Set<Promise<void>>, timeoutMs: number): Promise<void> {
  if (inFlight.size === 0) return;
  const work = Promise.allSettled([...inFlight]).then(() => undefined);
  let timeoutHandle: ReturnType<typeof scheduleTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = scheduleTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function unlinkOwnedSocket(
  socketPath: string,
  identity: { readonly dev: number; readonly ino: number } | undefined,
): Promise<void> {
  if (identity === undefined) return;
  try {
    const current = await lstat(socketPath);
    if (!current.isSocket() || current.dev !== identity.dev || current.ino !== identity.ino) return;
    await unlink(socketPath);
  } catch (error) {
    if (!isFileNotFound(error)) throw nookdServerError("nookd socket cleanup failed");
  }
}

function nookdServerError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  Object.defineProperty(error, "name", { configurable: true, value: "NookdServerError" });
  return error;
}

function isNookdServerError(error: unknown): error is Error {
  return error instanceof Error && error.name === "NookdServerError";
}
