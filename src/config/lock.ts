/**
 * NookBridge Stage 1 — single-instance locking.
 *
 * Gate 1.4 requires that a second DB-owning process against the same
 * state be **rejected** or **blocked predictably**.  The lock file is
 * the rejection mechanism: an exclusive create (mode `wx`) with
 * permissions 0o600.  An in-process cache tracks the same lock so the
 * same process can hold the lock while building two storage handles
 * against the same state (used by the doctor diagnostic, which opens
 * the DB to verify it can be decrypted).
 *
 * The lock file records the PID and start time of the acquiring process. On
 * `releaseLock` the file is renamed aside and removed only when its inode and
 * record still match (see `releaseOwnedLockFile`). A holder that dies
 * without releasing — SIGKILL, OOM kill, power loss — would otherwise leave
 * a file that every later start is refused against until an operator removes it by hand.
 */

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  linkSync,
  lstatSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { normaliseStateDir } from "./state-dir.js";

/** Backing field for in-process lock holders. */
const HELD: Map<string, { fd: number; path: string; ino: number; record: string }> = new Map();

export function lockPath(stateDir: string): string {
  return join(normaliseStateDir(stateDir), "nookbridge.lock");
}

/**
 * Node has no atomic conditional unlink. Rename first isolates the current
 * directory entry, then inode/record verification decides whether it is ours.
 * We never unlink a file we have not first isolated and identified. Stale
 * files are removed only by an operator, never by this code.
 */
export function releaseOwnedLockFile(
  path: string,
  expectedIno: number,
  expectedRecord: string | undefined,
): "released" | "gone" | "foreign" {
  const detached = `${path}.release-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(path, detached);
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? "gone" : "foreign";
  }
  try {
    const stat = lstatSync(detached);
    const matches =
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.ino === expectedIno &&
      (expectedRecord === undefined || readFileSync(detached, "utf8") === expectedRecord);
    if (matches) {
      unlinkSync(detached);
      return "released";
    }
    try {
      linkSync(detached, path);
      unlinkSync(detached);
    } catch {
      /* keep detached */
    }
    return "foreign";
  } catch {
    try {
      linkSync(detached, path);
      unlinkSync(detached);
    } catch {
      /* keep detached */
    }
    return "foreign";
  }
}

/**
 * Field 22 (`starttime`) of `/proc/<pid>/stat`, in clock ticks since boot.
 * The `comm` field can contain spaces and parentheses, so parse from the last
 * `)`; the fields after it begin at index 0 for field 3.  Diagnostic only: no
 * code path reclaims a lock on the basis of it.
 */
function readStartTimeTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = stat.lastIndexOf(")");
    if (closing === -1) {
      return null;
    }
    return stat.slice(closing + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * Try to acquire the single-instance lock for `stateDir`.  Returns a
 * release function on success or `null` when another process (or
 * another call in this process) already holds it.
 *
 * The acquisition is best-effort across three races:
 *
 *   1. In-process double-acquire is caught by the HELD map.
 *   2. Cross-process acquire is caught by `wx` (write, fail if exists).
 *   3. Any pre-existing lock file, stale or live, refuses acquisition.
 */
export function tryAcquireLock(stateDir: string): (() => void) | null {
  const path = lockPath(stateDir);
  // Resolve+normalise so HELD keys are canonical.
  const canonical = resolve(path);
  if (HELD.has(canonical)) {
    return null;
  }
  let fd: number;
  try {
    fd = openSync(canonical, "wx", 0o600);
  } catch {
    return null;
  }
  // The inode is the proof of ownership at release.  Without it this process
  // cannot tell its file from a replacement, so acquisition is refused.  The
  // file is left in place and is NOT unlinked by path: a path unlink could
  // delete another holder's lock.  The next start refuses against it, and an
  // operator clears it like any other stale lock.
  let ino: number;
  try {
    ino = fstatSync(fd).ino;
  } catch {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    return null;
  }
  // Holder record: pid, then start time.  Diagnostic only; no path reclaims on it.
  const pidBuf = Buffer.from(`${process.pid}\n${readStartTimeTicks(process.pid) ?? ""}\n`, "utf8");
  let written: number;
  try {
    written = writeSync(fd, pidBuf, 0, pidBuf.length, 0);
  } catch {
    written = -1;
  }
  if (written !== pidBuf.length) {
    releaseOwnedLockFile(canonical, ino, undefined);
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    return null;
  }
  HELD.set(canonical, { fd, path: canonical, ino, record: pidBuf.toString("utf8") });
  return () => releaseLock(stateDir);
}

/** Return whether the current process currently holds the lock. */
export function isLocked(stateDir: string): boolean {
  const canonical = resolve(lockPath(stateDir));
  return HELD.has(canonical);
}

/**
 * Return whether a lock file currently exists on disk for `stateDir`.
 *
 * This is the non-mutating equivalent of {@link tryAcquireLock} and
 * is intended for read-only inspection paths (e.g. the Stage 9
 * recovery readiness probe) that need to detect an active holder
 * without acquiring the lock themselves.  Callers MUST treat a
 * positive result as authoritative for "another process is currently
 * using this state directory" and refuse mutation accordingly.
 *
 * Every existing lock file counts, regardless of holder age or liveness.
 * This function never removes anything; errors fail closed.
 */
export function lockFileExists(stateDir: string): boolean {
  const canonical = resolve(lockPath(stateDir));
  try {
    lstatSync(canonical);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== "ENOENT";
  }
}

export function releaseLock(stateDir: string): boolean {
  const canonical = resolve(lockPath(stateDir));
  const held = HELD.get(canonical);
  if (!held) {
    return false;
  }
  releaseOwnedLockFile(canonical, held.ino, held.record);
  try {
    closeSync(held.fd);
  } catch {
    /* already closed */
  }
  HELD.delete(canonical);
  return true;
}
