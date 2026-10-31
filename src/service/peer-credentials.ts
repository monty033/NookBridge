/**
 * Stage 5 — bounded peer-credential parsing and asynchronous resolution.
 *
 * Both the service daemon and the operator socket use the asynchronous
 * resolver, so one slow helper cannot block the event loop.  Neither records
 * or forwards helper output.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Buffer } from "node:buffer";
import type net from "node:net";
import path from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

import type { OperatorPeer } from "./operator-server.js";

const GROUP_NAME_TOKEN = /^[A-Za-z0-9_.+-]{1,64}$/u;
const MAX_HELPER_STDOUT_BYTES = 4 * 1024;
const DEFAULT_PEER_TIMEOUT_MS = 1_000;

type PeerSocket = net.Socket & {
  readonly _handle?: {
    readonly fd?: number;
  };
};

export type PeerCredentialSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ResolvePeerAsyncOptions = Readonly<{
  /** Absolute helper path. Relative paths fail closed without spawning. */
  helperPath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Internal test seam; production always uses `child_process.spawn`. */
  spawn?: PeerCredentialSpawn;
}>;

/**
 * Parse the helper's line-oriented output into the closed operator peer shape.
 * Any other shape fails closed.
 */
export function parsePeerHelperOutput(stdout: string): OperatorPeer | undefined {
  const fields = stdout.trim().split(/\s+/u);
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
}

export function defaultPeerCredentialHelperPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../operator-peercred-helper",
  );
}

/**
 * Resolve the peer without blocking the event loop.  The returned promise
 * never rejects and never exposes helper output or error text.
 */
export function resolvePeerAsync(
  socket: net.Socket,
  options: ResolvePeerAsyncOptions,
): Promise<OperatorPeer | undefined> {
  const fd = (socket as PeerSocket)._handle?.fd;
  if (
    !Number.isInteger(fd) ||
    (fd as number) < 0 ||
    !path.isAbsolute(options.helperPath) ||
    options.signal?.aborted === true
  )
    return Promise.resolve(undefined);

  const spawnImpl = options.spawn ?? spawn;
  let child: ChildProcess;
  try {
    child = spawnImpl(options.helperPath, [], {
      stdio: [fd as number, "pipe", "ignore"],
      shell: false,
      windowsHide: true,
    });
  } catch {
    return Promise.resolve(undefined);
  }

  return new Promise<OperatorPeer | undefined>((resolve) => {
    let settled = false;
    let stdout = "";
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const finish = (peer: OperatorPeer | undefined): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(peer);
    };
    const killChild = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The helper may already have exited; never surface that failure.
      }
    };
    const onAbort = (): void => {
      killChild();
      finish(undefined);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_HELPER_STDOUT_BYTES) {
        killChild();
        finish(undefined);
      }
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code: number | null, signal: string | null) => {
      if (code !== 0 || signal !== null) {
        finish(undefined);
        return;
      }
      finish(parsePeerHelperOutput(stdout));
    });

    const timeoutMs = options.timeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
    timeoutHandle = setTimeout(() => {
      killChild();
      finish(undefined);
    }, timeoutMs);
    if (options.signal !== undefined) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
