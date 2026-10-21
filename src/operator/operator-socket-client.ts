import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { createConnection, type Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_SERVICE_ABUSE_BOUNDS } from "../service/service-abuse-bounds.js";
import {
  STAGE5_RPC_LIMITS,
  isRpcErrorCode,
  type RpcAnyResponseEnvelope,
  type RpcErrorCode,
  type RpcResult,
} from "../service/rpc-protocol.js";
import { isOperatorMethod, type OperatorMethod } from "../service/operator-methods.js";

const FRAME_PREFIX_BYTES = 4;
/**
 * The client's deadline must outlive the daemon's own per-request deadline,
 * otherwise the client reports `service_unavailable` while the daemon is
 * still working. Same formula as the R9a client deadline.
 */
const DEFAULT_TIMEOUT_MS = DEFAULT_SERVICE_ABUSE_BOUNDS.requestTimeoutMs + 2_000;

/**
 * Failure categories the operator client can report.
 *
 * This is deliberately the daemon's full closed error vocabulary rather
 * than a hand-picked subset: a subset silently reclassifies every
 * category it omits, so a `conflict` or `stale_revision` reply would
 * reach the operator as "service unavailable".
 */
export type OperatorSocketErrorCode = RpcErrorCode;

export type OperatorSocketResult =
  | Readonly<{ ok: true; result: RpcResult }>
  | Readonly<{ ok: false; code: OperatorSocketErrorCode; operationHandle?: string }>;

export type OperatorSocketConnect = (path: string) => Promise<Socket>;

export interface OperatorSocketClientOptions {
  readonly socketPath: string;
  readonly connect?: OperatorSocketConnect;
  readonly timeoutMs?: number;
}

export class OperatorSocketClient {
  readonly #socketPath: string;
  readonly #connect: OperatorSocketConnect;
  readonly #timeoutMs: number;

  constructor(options: OperatorSocketClientOptions) {
    if (
      typeof options.socketPath !== "string" ||
      !isAbsolute(options.socketPath) ||
      resolve(options.socketPath) !== options.socketPath ||
      // eslint-disable-next-line no-control-regex -- rejecting C0 control characters is the intent here
      /[\u0000-\u001f\u007f]/.test(options.socketPath)
    ) {
      throw new TypeError("operator socket path is invalid");
    }
    this.#socketPath = options.socketPath;
    this.#connect = options.connect ?? defaultConnect;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new TypeError("operator socket timeout is invalid");
    }
  }

  async request(
    method: OperatorMethod,
    params: Record<string, unknown>,
  ): Promise<OperatorSocketResult> {
    if (!isOperatorMethod(method)) return { ok: false, code: "invalid_request" };
    const id = `op_${randomBytes(12).toString("hex")}`;
    let body: Buffer;
    try {
      body = Buffer.from(JSON.stringify({ id, method, params }), "utf8");
    } catch {
      return { ok: false, code: "invalid_request" };
    }
    if (
      body.byteLength === 0 ||
      body.byteLength > STAGE5_RPC_LIMITS.maxFrameBytes - FRAME_PREFIX_BYTES
    )
      return { ok: false, code: "invalid_request" };
    const frame = Buffer.allocUnsafe(FRAME_PREFIX_BYTES + body.byteLength);
    frame.writeUInt32BE(body.byteLength, 0);
    body.copy(frame, FRAME_PREFIX_BYTES);

    return await this.#exchange(id, frame);
  }

  /**
   * Runs one request under a single deadline that starts before `connect` and
   * covers connect, write and read.
   *
   * The deadline is owned here rather than inside `roundTrip` so a stalled
   * connect cannot outlive it: the daemon has no per-request deadline, so a
   * client that only bounded the read phase would hang `nookctl` forever.
   * A socket that resolves from `connect` after expiry is destroyed instead
   * of being used.
   */
  async #exchange(id: string, frame: Buffer): Promise<OperatorSocketResult> {
    let socket: Socket | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<OperatorSocketResult>((resolveDeadline) => {
      timer = setTimeout(() => {
        expired = true;
        socket?.destroy();
        resolveDeadline({ ok: false, code: "service_unavailable" });
      }, this.#timeoutMs);
    });

    const work = (async (): Promise<OperatorSocketResult> => {
      try {
        const connected = await this.#connect(this.#socketPath);
        socket = connected;
        if (expired) {
          // The deadline expired while `connect` was pending: destroy the
          // late socket instead of using it, and absorb any late `error`
          // event so an abandoned connection cannot crash the CLI.
          connected.once("error", () => undefined);
          connected.destroy();
          return { ok: false, code: "service_unavailable" };
        }
        return decodeResponse(await roundTrip(connected, frame), id);
      } catch {
        return { ok: false, code: "service_unavailable" };
      }
    })();

    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

async function defaultConnect(path: string): Promise<Socket> {
  return await new Promise<Socket>((resolveSocket, reject) => {
    const socket = createConnection(path);
    const fail = (): void => reject(new Error("connect failed"));
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.off("error", fail);
      resolveSocket(socket);
    });
  });
}

/**
 * Writes one frame and resolves with the framed reply.
 *
 * There is deliberately no timer here: the caller owns the one deadline for
 * the whole operation. Teardown still destroys the socket and detaches every
 * listener so a deadline-driven `destroy` (or a server-side close) settles
 * this promise instead of leaving it pending.
 */
async function roundTrip(socket: Socket, frame: Buffer): Promise<Buffer> {
  return await new Promise<Buffer>((resolveBytes, reject) => {
    let received = Buffer.alloc(0);
    let expected: number | undefined;
    const finish = (error?: Error): void => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
    };
    socket.on("error", () => finish(new Error("socket error")));
    socket.on("close", () => finish(new Error("socket closed")));
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.byteLength > STAGE5_RPC_LIMITS.maxResponseBytes)
        return finish(new Error("response too large"));
      if (expected === undefined && received.byteLength >= FRAME_PREFIX_BYTES) {
        expected = received.readUInt32BE(0);
        if (expected > STAGE5_RPC_LIMITS.maxResponseBytes - FRAME_PREFIX_BYTES)
          return finish(new Error("response too large"));
      }
      if (expected !== undefined && received.byteLength >= expected + FRAME_PREFIX_BYTES) {
        const exact = received.subarray(0, expected + FRAME_PREFIX_BYTES);
        finish();
        resolveBytes(Buffer.from(exact));
      }
    });
    socket.write(frame, (error) => {
      if (error) finish(error);
    });
  });
}

function decodeResponse(frame: Buffer, expectedId: string): OperatorSocketResult {
  if (frame.byteLength < FRAME_PREFIX_BYTES) return { ok: false, code: "service_unavailable" };
  const length = frame.readUInt32BE(0);
  if (length !== frame.byteLength - FRAME_PREFIX_BYTES)
    return { ok: false, code: "service_unavailable" };
  let candidate: unknown;
  try {
    candidate = JSON.parse(frame.subarray(FRAME_PREFIX_BYTES).toString("utf8"));
  } catch {
    return { ok: false, code: "service_unavailable" };
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
    return { ok: false, code: "service_unavailable" };
  const record = candidate as Partial<RpcAnyResponseEnvelope>;
  if (record.id !== expectedId) return { ok: false, code: "service_unavailable" };
  if (record.ok === false) {
    const error = record.error;
    if (error !== null && typeof error === "object" && !Array.isArray(error)) {
      const code = (error as { code?: unknown }).code;
      const operationHandle = (error as { operationHandle?: unknown }).operationHandle;
      if (typeof code === "string" && isRpcErrorCode(code)) {
        return {
          ok: false,
          code,
          ...(typeof operationHandle === "string" ? { operationHandle } : {}),
        };
      }
    }
    return { ok: false, code: "service_unavailable" };
  }
  if (record.ok !== true || record.result === undefined)
    return { ok: false, code: "service_unavailable" };
  return { ok: true, result: record.result as RpcResult };
}
