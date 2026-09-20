import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { chmodSync } from "node:fs";
import { lstat, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import {
  parseRpcFrame,
  serializeRpcResponse,
  type RpcAnyResponseEnvelope,
  type RpcRequest,
} from "./rpc-protocol.js";
import { isOperatorMethod, type OperatorMethod } from "./operator-methods.js";
import type { OperatorPeer } from "./operator-server.js";
import type { OperatorPolicyDecision } from "./operator-policy.js";

const FRAME_PREFIX_BYTES = 4;
const MAX_FRAME_BYTES = 65_536;
const DEFAULT_SOCKET_MODE = 0o660;
const SOCKET_ROOT = "/run/nookbridge";
/**
 * The token shape accepted for a peer's group entry: a POSIX group name as
 * resolved by the credential helper, or the numeric id it falls back to when
 * no name mapping exists. Mirrors the conservative group-name validation the
 * service config applies, and rejects every other shape (separators,
 * whitespace, over-long tokens) so a malformed helper fails closed.
 */
const GROUP_NAME_TOKEN = /^[A-Za-z0-9_.+-]{1,64}$/u;

type PeerSocket = net.Socket & {
  readonly _handle?: {
    readonly fd?: number;
  };
};

export type OperatorSocketPeerResolver = (socket: net.Socket) => OperatorPeer | undefined;
export type OperatorSocketAuthorization = (
  method: OperatorMethod,
  peer: OperatorPeer,
) => OperatorPolicyDecision;
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

  const resolvePeer =
    options.resolvePeer ??
    ((socket) => resolveNativePeer(socket, options.peerCredentialHelperPath));
  let owned = false;
  const server = net.createServer((socket) => {
    const peer = resolvePeer(socket);
    if (peer === undefined) {
      socket.destroy();
      return;
    }
    serveOneRequest(socket, peer, options.authorize, options.handle);
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

async function serveOneRequest(
  socket: net.Socket,
  peer: OperatorPeer,
  authorize: OperatorSocketAuthorization,
  handle: OperatorSocketHandler,
): Promise<void> {
  let pending = Buffer.alloc(0);
  let completed = false;
  const finish = (): void => {
    if (!completed) {
      completed = true;
      socket.end();
    }
  };
  socket.on("data", (chunk: Buffer) => {
    if (completed || pending.length + chunk.length > MAX_FRAME_BYTES) {
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
    pending = pending.subarray(frameLength);
    void dispatchFrame(socket, frame, peer, authorize, handle).finally(finish);
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
  if (!isOperatorMethod(request.method)) {
    socket.destroy();
    return;
  }
  let decision: OperatorPolicyDecision;
  try {
    decision = authorize(request.method, peer);
  } catch {
    socket.destroy();
    return;
  }
  if (decision.allowed !== true) {
    await writeResponse(socket, {
      id: request.id,
      ok: false,
      error: { code: "permission_denied", message: "Permission denied" },
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

function resolveNativePeer(
  socket: net.Socket,
  helperPath = defaultPeerCredentialHelperPath(),
): OperatorPeer | undefined {
  const fd = (socket as PeerSocket)._handle?.fd;
  if (!Number.isInteger(fd) || (fd as number) < 0 || !path.isAbsolute(helperPath)) return undefined;
  try {
    const result = spawnSync(helperPath, [], {
      stdio: [fd as number, "pipe", "ignore"],
      timeout: 1000,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0 || result.signal !== null || typeof result.stdout !== "string")
      return undefined;
    const fields = result.stdout.trim().split(/\s+/u);
    if (fields.length < 3 || fields.length > 67) return undefined;
    const uidText = fields[0];
    const gidText = fields[1];
    const pidText = fields[2];
    if (uidText === undefined || gidText === undefined || pidText === undefined) return undefined;
    if (!/^\d+$/u.test(uidText) || !/^\d+$/u.test(gidText) || !/^\d+$/u.test(pidText))
      return undefined;
    const uid = Number(uidText);
    const gid = Number(gidText);
    const pid = Number(pidText);
    if (![uid, gid, pid].every((value) => Number.isSafeInteger(value) && value >= 0))
      return undefined;
    const groups = fields.slice(3);
    if (groups.length === 0 || groups.length > 64) return undefined;
    // The helper resolves each group to its POSIX name, because the
    // authorization policy matches on names; a group with no name mapping
    // falls back to its numeric id. Accept both, and reject every other shape
    // so a malformed helper fails closed.
    if (!groups.every((group) => GROUP_NAME_TOKEN.test(group))) return undefined;
    return Object.freeze({ uid, gid, groups: Object.freeze(groups) });
  } catch {
    return undefined;
  }
}

function defaultPeerCredentialHelperPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../operator-peercred-helper",
  );
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
