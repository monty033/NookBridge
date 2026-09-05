/**
 * Stage 5 — bounded `nookd` Unix-socket service.
 *
 * This is the transport/lifecycle boundary for the one allowed service
 * operation. It owns no Notesnook object: the only capability it receives is
 * the already-bounded service runtime's title-only `search` function and
 * cleanup hook.
 */

import { Buffer } from "node:buffer";
import { chmodSync } from "node:fs";
import { lstat, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as scheduleTimeout, clearTimeout } from "node:timers";

import {
  buildServiceAuditRecord,
  emitServiceAudit,
  type ServiceAuditEvent,
  type ServiceAuditOutcome,
  type ServiceAuditPeerCredentials,
} from "./service-audit.js";
import {
  DEFAULT_SERVICE_ABUSE_BOUNDS,
  normalizeServiceAbuseBounds,
  type ServiceAbuseBounds,
} from "./service-abuse-bounds.js";
import { handleRpcRequest, type RpcHandlerRuntimeLike } from "./rpc-handler.js";
import {
  createReadOnlyServicePolicy,
  narrowServicePolicy,
  type ServicePolicy,
} from "./service-policy.js";
import {
  STAGE5_RPC_LIMITS,
  parseRpcFrame,
  serializeRpcResponse,
  type RpcMethod,
} from "./rpc-protocol.js";
import type { Logger } from "../logging/logger.js";

const FRAME_PREFIX_BYTES = 4;
const MAX_FRAME_BYTES_ON_WIRE = STAGE5_RPC_LIMITS.maxFrameBytes;
const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES_ON_WIRE - FRAME_PREFIX_BYTES;
const MAX_PENDING_BYTES = MAX_FRAME_BYTES_ON_WIRE * 2;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_SOCKET_MODE = 0o770;
const DEFAULT_MAX_CONNECTIONS = 32;
const MAX_CONNECTIONS = 128;
const DEFAULT_MAX_REQUESTS_PER_CONNECTION = 64;
const MAX_REQUESTS_PER_CONNECTION = 1_024;
const AUDIT_METHOD_SENTINEL = "notes.search" as const;

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
  /** The frozen service-side authorization policy; defaults to readOnly. */
  policy?: ServicePolicy;
  /** Optional socket permission bits, applied after a successful bind. Defaults to 0770. */
  socketMode?: number;
  /** Maximum time to let an in-flight handler finish during shutdown. */
  shutdownTimeoutMs?: number;
  /** Maximum number of simultaneously accepted Unix-socket connections. */
  maxConnections?: number;
  /** Maximum number of requests processed on one connection. */
  maxRequestsPerConnection?: number;
  /** Closed service-side abuse bounds; defaults are applied once at startup. */
  abuseBounds?: ServiceAbuseBounds;
  /** Best-effort categorical audit logger. */
  auditLogger?: Logger;
  /** Entry points may install SIGTERM/SIGINT; tests can disable the hooks. */
  installSignalHandlers?: boolean;
}>;

export interface NookdServerHandle {
  readonly socketPath: string;
  readonly shutdown: () => Promise<void>;
  /** Alias for callers that use the conventional server lifecycle name. */
  readonly close: () => Promise<void>;
}

interface ConnectionState {
  readonly socket: net.Socket;
  pending: Buffer;
  processing: boolean;
  requestsHandled: number;
  ended: boolean;
  closed: boolean;
  closing: boolean;
  lastActivityMs: number;
  elapsedMs: number;
  idleTimer: ReturnType<typeof scheduleTimeout> | undefined;
  readonly closePromise: Promise<void>;
  readonly resolveClosed: () => void;
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
  let accepting = true;
  let ownedSocketIdentity: { readonly dev: number; readonly ino: number } | undefined;
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

  const onConnection = (socket: net.Socket): void => {
    if (!accepting || connections.size >= normalized.maxConnections || !admitConnection()) {
      audit("rpc.connection.admission_rejected", "admission_rejected");
      socket.destroy();
      return;
    }
    let resolveClosed: () => void = () => undefined;
    const stateResolver = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const state: ConnectionState = {
      socket,
      pending: Buffer.alloc(0),
      processing: false,
      requestsHandled: 0,
      ended: false,
      closed: false,
      closing: false,
      lastActivityMs: Date.now(),
      elapsedMs: 0,
      idleTimer: undefined,
      closePromise: stateResolver,
      resolveClosed: () => resolveClosed(),
    };
    connections.add(state);
    socket.on("data", (chunk: Buffer): void => {
      if (state.closed || !accepting) return;
      state.lastActivityMs = Date.now();
      armIdleTimer(state);
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
      processConnection(state);
    });
    socket.on("error", (): void => {
      // The close event normally follows, but unblock the cancellation race
      // immediately as defense in depth. Never forward the raw error.
      state.closed = true;
      state.resolveClosed();
    });
    socket.on("close", (): void => {
      state.closed = true;
      clearIdleTimer(state);
      state.resolveClosed();
      connections.delete(state);
      audit("rpc.connection.closed", "ok");
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
  } catch (error) {
    server.close();
    await unlinkOwnedSocket(normalized.socketPath, ownedSocketIdentity);
    if (isNookdServerError(error)) throw error;
    throw nookdServerError("nookd Unix socket could not be created");
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
      await unlinkOwnedSocket(normalized.socketPath, ownedSocketIdentity);
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

  return Object.freeze({ socketPath: normalized.socketPath, shutdown, close: shutdown });

  function clearIdleTimer(state: ConnectionState): void {
    if (state.idleTimer === undefined) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }

  function destroyConnection(state: ConnectionState): void {
    state.closing = true;
    clearIdleTimer(state);
    state.socket.destroy();
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
      audit("rpc.connection.idle_timeout", "timeout", AUDIT_METHOD_SENTINEL, false, idleForMs);
      destroyConnection(state);
    }, normalized.abuseBounds.connectionIdleTimeoutMs);
  }

  function processConnection(state: ConnectionState): void {
    if (state.processing || state.closed || state.closing) return;
    state.processing = true;
    const work = (async (): Promise<void> => {
      try {
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
          let request;
          try {
            request = parseRpcFrame(next.frame);
          } catch {
            // A malformed frame has no trusted request id. The protocol has no
            // nullable-id response envelope, so close without an error body.
            destroyConnection(state);
            break;
          }
          state.requestsHandled += 1;
          const requestStartedMs = Date.now();
          audit("rpc.request.received", "ok", request.method, request.id.length > 0, 0);
          let timeoutHandle: ReturnType<typeof scheduleTimeout> | undefined;
          const timeout = new Promise<"timeout">((resolve) => {
            timeoutHandle = scheduleTimeout(
              () => resolve("timeout"),
              normalized.abuseBounds.requestTimeoutMs,
            );
          });
          const responsePromise = handleRpcRequest(request, normalized.runtime, normalized.policy)
            .then((response) => ({
              kind: "response" as const,
              response,
            }))
            .catch(() => ({ kind: "handler_failure" as const }));
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
            );
            destroyConnection(state);
            break;
          }
          const response = raced.response;
          if (state.closed || state.closing || state.socket.destroyed) break;
          const outcome: ServiceAuditOutcome = response.ok ? "ok" : response.error.code;
          audit(
            "rpc.request.dispatched",
            outcome,
            request.method,
            request.id.length > 0,
            requestElapsedMs,
          );
          let responseFrame: Uint8Array;
          try {
            responseFrame = serializeRpcResponse(response);
          } catch {
            // In particular, do not attempt to serialize a second error when
            // the original response itself exceeded the published bound.
            destroyConnection(state);
            break;
          }
          const wrote = await writeFrame(state, responseFrame);
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
          );
        }
      } finally {
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

/** Alias retained for callers that use a factory-style name. */
export const createNookdServer = startNookdServer;

function captureStartOptions(options: StartNookdServerOptions): StartNookdServerOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw nookdServerError("invalid nookd server options");
  }
  try {
    const socketPath = options.socketPath;
    const runtime = options.runtime;
    const policy = options.policy;
    const socketMode = options.socketMode;
    const shutdownTimeoutMs = options.shutdownTimeoutMs;
    const maxConnections = options.maxConnections;
    const maxRequestsPerConnection = options.maxRequestsPerConnection;
    const abuseBounds = options.abuseBounds;
    const auditLogger = options.auditLogger;
    const installSignalHandlers = options.installSignalHandlers;
    return Object.freeze({
      socketPath,
      runtime,
      ...(policy === undefined ? {} : { policy }),
      ...(socketMode === undefined ? {} : { socketMode }),
      ...(shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }),
      ...(maxConnections === undefined ? {} : { maxConnections }),
      ...(maxRequestsPerConnection === undefined ? {} : { maxRequestsPerConnection }),
      ...(abuseBounds === undefined ? {} : { abuseBounds }),
      ...(auditLogger === undefined ? {} : { auditLogger }),
      ...(installSignalHandlers === undefined ? {} : { installSignalHandlers }),
    });
  } catch {
    throw nookdServerError("invalid nookd server options");
  }
}

type NormalizedStartNookdServerOptions = Omit<
  StartNookdServerOptions,
  | "socketMode"
  | "shutdownTimeoutMs"
  | "maxConnections"
  | "maxRequestsPerConnection"
  | "abuseBounds"
  | "auditLogger"
  | "installSignalHandlers"
> & {
  readonly socketMode: number;
  readonly policy: ServicePolicy;
  readonly shutdownTimeoutMs: number;
  readonly maxConnections: number;
  readonly maxRequestsPerConnection: number;
  readonly abuseBounds: ServiceAbuseBounds;
  readonly auditLogger: Logger | undefined;
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
  const auditLogger = options.auditLogger;
  if (auditLogger !== undefined && (typeof auditLogger !== "object" || auditLogger === null)) {
    throw nookdServerError("invalid nookd audit logger");
  }
  const installSignalHandlers = options.installSignalHandlers ?? true;
  if (typeof installSignalHandlers !== "boolean") {
    throw nookdServerError("invalid nookd signal-handler option");
  }
  return {
    socketPath: options.socketPath,
    runtime: options.runtime,
    policy,
    socketMode: options.socketMode ?? DEFAULT_SOCKET_MODE,
    shutdownTimeoutMs,
    maxConnections,
    maxRequestsPerConnection,
    abuseBounds,
    auditLogger,
    installSignalHandlers,
  };
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
