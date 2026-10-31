import { Buffer } from "node:buffer";
import { chmodSync } from "node:fs";
import { lstat, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import {
  parseRpcFrame,
  serializeRpcResponse,
  type RpcAnyResponseEnvelope,
  type RpcRequest,
} from "./rpc-protocol.js";
import { isOperatorTransportMethod, type OperatorTransportMethod } from "./operator-methods.js";
import type { OperatorPeer } from "./operator-server.js";
import type { OperatorPolicyDecision } from "./operator-policy.js";
import { defaultPeerCredentialHelperPath, resolvePeerAsync } from "./peer-credentials.js";

const FRAME_PREFIX_BYTES = 4;
const MAX_FRAME_BYTES = 65_536;
const DEFAULT_SOCKET_MODE = 0o660;
const SOCKET_ROOT = "/run/nookbridge";

/**
 * Conservative maximum byte length for a Unix socket path.
 *
 * Chosen below the `sun_path` limits of common platforms rather than equal to
 * any one of them: macOS allows 104 bytes including the terminator, and the
 * Linux kernel accepts 108, but on this host a 109-byte path silently binds
 * without creating a socket file, so the guard must sit below that edge.
 */
export const UNIX_SOCKET_PATH_MAX_BYTES = 103;

export type OperatorSocketPeerResolver = (
  socket: net.Socket,
  signal: AbortSignal,
) => OperatorPeer | undefined | Promise<OperatorPeer | undefined>;
export type OperatorSocketAuthorization = (
  method: OperatorTransportMethod,
  peer: OperatorPeer,
  request?: RpcRequest,
) => OperatorPolicyDecision | Promise<OperatorPolicyDecision>;
export type OperatorSocketHandler = (
  request: RpcRequest,
  peer: OperatorPeer,
) => Promise<RpcAnyResponseEnvelope>;

export type StartOperatorSocketServerOptions = Readonly<{
  socketPath: string;
  /** Test-only root override; production callers must omit this. */
  socketPathRoot?: string;
  resolvePeer?: OperatorSocketPeerResolver;
  /** Absolute helper path; defaults to the packaged Linux peer-credential helper. */
  peerCredentialHelperPath?: string;
  authorize: OperatorSocketAuthorization;
  handle: OperatorSocketHandler;
  socketMode?: number;
}>;

export type OperatorSocketServerHandle = Readonly<{
  socketPath: string;
  close: () => Promise<void>;
}>;

/**
 * Bind the daemon-owned operator endpoint. Node versions without a native
 * peer-credential accessor fail closed; production must provide a resolver
 * backed by SO_PEERCRED rather than falling back to socket reachability.
 */
export async function startOperatorSocketServer(
  options: StartOperatorSocketServerOptions,
): Promise<OperatorSocketServerHandle> {
  const socketPath = validateSocketPath(options.socketPath, options.socketPathRoot);
  const socketMode = validateSocketMode(options.socketMode ?? DEFAULT_SOCKET_MODE);
  if (typeof options.authorize !== "function" || typeof options.handle !== "function")
    throw new Error("operator socket configuration is invalid");
  if (await exists(socketPath)) throw new Error("operator socket path is occupied");

  const helperPath = options.peerCredentialHelperPath ?? defaultPeerCredentialHelperPath();
  const resolvePeer: OperatorSocketPeerResolver =
    options.resolvePeer ?? ((socket, signal) => resolvePeerAsync(socket, { helperPath, signal }));
  let owned = false;
  const server = net.createServer((socket) => {
    // Resolution is asynchronous so a slow helper never blocks the event loop,
    // and it is aborted if the client leaves first.
    const controller = new AbortController();
    socket.once("close", () => controller.abort());
    let lookup: Promise<OperatorPeer | undefined>;
    try {
      lookup = Promise.resolve(resolvePeer(socket, controller.signal));
    } catch {
      lookup = Promise.resolve(undefined);
    }
    const peerLookup = lookup.catch(() => undefined);
    // An unresolved peer is dropped as soon as that is known, as before.
    void peerLookup.then((peer) => {
      if (peer === undefined) socket.destroy();
    });
    serveOneRequest(socket, peerLookup, options.authorize, options.handle);
  });

  try {
    await listen(server, socketPath, socketMode);
    const bound = await lstat(socketPath);
    if (!bound.isSocket()) throw new Error("operator socket was not created");
    owned = true;
  } catch (error) {
    server.close();
    if (owned) await unlink(socketPath).catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolve) => {
      server.close(() => {
        void unlink(socketPath)
          .catch(() => undefined)
          .finally(resolve);
      });
    });
    return closePromise;
  };
  return Object.freeze({ socketPath, close });
}

function serveOneRequest(
  socket: net.Socket,
  peerLookup: Promise<OperatorPeer | undefined>,
  authorize: OperatorSocketAuthorization,
  handle: OperatorSocketHandler,
): void {
  let pending = Buffer.alloc(0);
  // Set when the first frame is taken, not when its dispatch ends: the
  // connection serves exactly one request, however the client pipelines.
  let completed = false;
  socket.on("data", (chunk: Buffer) => {
    // Anything after the first frame is ignored; the one request in flight is
    // still answered.
    if (completed) return;
    if (pending.length + chunk.length > MAX_FRAME_BYTES) {
      socket.destroy();
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    if (pending.length < FRAME_PREFIX_BYTES) return;
    const declared = pending.readUInt32BE(0);
    if (declared === 0 || declared > MAX_FRAME_BYTES - FRAME_PREFIX_BYTES) {
      socket.destroy();
      return;
    }
    const frameLength = FRAME_PREFIX_BYTES + declared;
    if (pending.length < frameLength) return;
    const frame = pending.subarray(0, frameLength);
    pending = Buffer.alloc(0);
    completed = true;
    void peerLookup
      .then(async (peer) => {
        if (peer === undefined) return;
        await dispatchFrame(socket, frame, peer, authorize, handle);
      })
      .finally(() => socket.end());
  });
  socket.on("error", () => undefined);
}

async function dispatchFrame(
  socket: net.Socket,
  frame: Buffer,
  peer: OperatorPeer,
  authorize: OperatorSocketAuthorization,
  handle: OperatorSocketHandler,
): Promise<void> {
  let request: RpcRequest;
  try {
    request = parseRpcFrame(frame);
  } catch {
    socket.destroy();
    return;
  }
  if (!isOperatorTransportMethod(request.method)) {
    socket.destroy();
    return;
  }
  let decision: OperatorPolicyDecision;
  try {
    decision = await authorize(request.method, peer, request);
  } catch {
    socket.destroy();
    return;
  }
  if (decision.allowed !== true) {
    // The policy's categorical reason is the code the operator receives, so a
    // lock refusal stays distinguishable from a permission problem.
    const message = decision.reason === "vault_locked" ? "Vault locked" : "Permission denied";
    await writeResponse(socket, {
      id: request.id,
      ok: false,
      error: { code: decision.reason, message },
    });
    return;
  }
  try {
    const response = await handle(request, peer);
    await writeResponse(socket, response);
  } catch {
    await writeResponse(socket, {
      id: request.id,
      ok: false,
      error: { code: "service_unavailable", message: "Service unavailable" },
    });
  }
}

async function writeResponse(socket: net.Socket, response: RpcAnyResponseEnvelope): Promise<void> {
  let frame: Uint8Array;
  try {
    frame = serializeRpcResponse(response);
  } catch {
    socket.destroy();
    return;
  }
  await new Promise<void>((resolve) => {
    socket.write(frame, () => resolve());
  });
}

function validateSocketPath(value: string, testRoot?: string): string {
  const root = testRoot ?? SOCKET_ROOT;
  if (testRoot !== undefined && process.env.NODE_ENV !== "test")
    throw new Error("operator socket test root is unavailable");
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    !value.startsWith(`${root}/`)
  )
    throw new Error("operator socket path is invalid");
  if (Buffer.byteLength(value) > UNIX_SOCKET_PATH_MAX_BYTES)
    throw new Error("operator socket path is too long");
  return value;
}

function validateSocketMode(value: number): number {
  if (value !== 0o660 && value !== 0o770) throw new Error("operator socket mode is invalid");
  return value;
}

async function exists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function listen(server: net.Server, socketPath: string, socketMode: number): Promise<void> {
  const previousUmask = process.umask(0o777 ^ socketMode);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (): void => reject(new Error("operator socket bind failed"));
      server.once("error", onError);
      server.once("listening", () => {
        server.removeListener("error", onError);
        try {
          chmodSync(socketPath, socketMode);
          resolve();
        } catch {
          reject(new Error("operator socket permission setup failed"));
        }
      });
      server.listen(socketPath);
    });
  } finally {
    process.umask(previousUmask);
  }
}
