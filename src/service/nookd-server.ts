/**
 * Stage 5 — bounded `nookd` Unix-socket service.
 *
 * This is the transport/lifecycle boundary for the one allowed service
 * operation. It owns no Notesnook object: the only capability it receives is
 * the already-bounded service runtime's title-only `search` function and
 * cleanup hook.
 */

import { Buffer } from "node:buffer";
import { chmod, lstat, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as scheduleTimeout } from "node:timers";

import { handleRpcRequest, type RpcHandlerRuntimeLike } from "./rpc-handler.js";
import { STAGE5_RPC_LIMITS, parseRpcFrame, serializeRpcResponse } from "./rpc-protocol.js";

const FRAME_PREFIX_BYTES = 4;
const MAX_FRAME_BYTES_ON_WIRE = STAGE5_RPC_LIMITS.maxFrameBytes;
const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES_ON_WIRE - FRAME_PREFIX_BYTES;
const MAX_PENDING_BYTES = MAX_FRAME_BYTES_ON_WIRE * 2;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

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
  /** Optional socket permission bits, applied after a successful bind. */
  socketMode?: number;
  /** Maximum time to let an in-flight handler finish during shutdown. */
  shutdownTimeoutMs?: number;
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
  ended: boolean;
  closed: boolean;
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
  const normalized = validateOptions(options);
  const existing = await inspectExistingSocketPath(normalized.socketPath);
  if (existing) {
    throw nookdServerError("nookd socket path has an existing entry");
  }

  const server = net.createServer();
  const connections = new Set<ConnectionState>();
  const inFlight = new Set<Promise<void>>();
  let accepting = true;
  let ownedSocketIdentity: { readonly dev: number; readonly ino: number } | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let signalHandlersInstalled = false;

  const onConnection = (socket: net.Socket): void => {
    if (!accepting) {
      socket.destroy();
      return;
    }
    const state: ConnectionState = {
      socket,
      pending: Buffer.alloc(0),
      processing: false,
      ended: false,
      closed: false,
    };
    connections.add(state);
    socket.on("data", (chunk: Buffer): void => {
      if (state.closed || !accepting) return;
      if (state.pending.length + chunk.length > MAX_PENDING_BYTES) {
        socket.destroy();
        return;
      }
      state.pending =
        state.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([state.pending, chunk]);
      processConnection(state);
    });
    socket.on("end", (): void => {
      state.ended = true;
      processConnection(state);
    });
    socket.on("error", (): void => {
      // Socket errors are transport state, not an API response. Never log or
      // forward the underlying error because it may contain local details.
      state.closed = true;
    });
    socket.on("close", (): void => {
      state.closed = true;
      connections.delete(state);
    });
  };
  server.on("connection", onConnection);

  try {
    await listenOnUnixSocket(server, normalized.socketPath);
    const bound = await lstat(normalized.socketPath);
    if (!bound.isSocket()) throw nookdServerError("nookd did not create a Unix socket");
    ownedSocketIdentity = { dev: bound.dev, ino: bound.ino };
    if (normalized.socketMode !== undefined) {
      try {
        await chmod(normalized.socketPath, normalized.socketMode);
      } catch {
        throw nookdServerError("nookd socket permissions could not be applied");
      }
    }
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
      await waitForInFlight(inFlight, normalized.shutdownTimeoutMs);
      for (const state of connections) state.socket.destroy();
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

  function processConnection(state: ConnectionState): void {
    if (state.processing || state.closed) return;
    state.processing = true;
    const work = (async (): Promise<void> => {
      try {
        while (!state.closed) {
          const next = takeFrame(state);
          if (next.kind === "incomplete") break;
          if (next.kind === "invalid") {
            state.socket.destroy();
            break;
          }
          let request;
          try {
            request = parseRpcFrame(next.frame);
          } catch {
            // A malformed frame has no trusted request id. The protocol has no
            // nullable-id response envelope, so close without an error body.
            state.socket.destroy();
            break;
          }
          let response;
          try {
            response = await handleRpcRequest(request, normalized.runtime);
          } catch {
            state.socket.destroy();
            break;
          }
          let responseFrame: Uint8Array;
          try {
            responseFrame = serializeRpcResponse(response);
          } catch {
            // In particular, do not attempt to serialize a second error when
            // the original response itself exceeded the published bound.
            state.socket.destroy();
            break;
          }
          await writeFrame(state.socket, responseFrame);
        }
      } finally {
        state.processing = false;
        if (state.ended && !state.closed) state.socket.destroy();
      }
    })();
    inFlight.add(work);
    void work.finally(() => {
      inFlight.delete(work);
    });
  }
}

/** Alias retained for callers that use a factory-style name. */
export const createNookdServer = startNookdServer;

function validateOptions(
  options: StartNookdServerOptions,
): Required<
  Pick<
    StartNookdServerOptions,
    "socketPath" | "runtime" | "shutdownTimeoutMs" | "installSignalHandlers"
  >
> &
  Pick<StartNookdServerOptions, "socketMode"> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw nookdServerError("invalid nookd server options");
  }
  if (typeof options.socketPath !== "string" || !path.isAbsolute(options.socketPath)) {
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
  const installSignalHandlers = options.installSignalHandlers ?? true;
  if (typeof installSignalHandlers !== "boolean") {
    throw nookdServerError("invalid nookd signal-handler option");
  }
  return {
    socketPath: options.socketPath,
    runtime: options.runtime,
    ...(options.socketMode === undefined ? {} : { socketMode: options.socketMode }),
    shutdownTimeoutMs,
    installSignalHandlers,
  };
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

async function listenOnUnixSocket(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (): void => {
      server.removeListener("listening", onListening);
      reject(nookdServerError("nookd Unix socket could not be created"));
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
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

async function writeFrame(socket: net.Socket, frame: Uint8Array): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      socket.removeListener("error", finish);
      resolve();
    };
    socket.once("error", finish);
    socket.write(frame, finish);
    if (socket.destroyed) finish();
  });
}

async function waitForInFlight(inFlight: Set<Promise<void>>, timeoutMs: number): Promise<void> {
  if (inFlight.size === 0) return;
  const work = Promise.allSettled([...inFlight]).then(() => undefined);
  await Promise.race([work, new Promise<void>((resolve) => scheduleTimeout(resolve, timeoutMs))]);
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
