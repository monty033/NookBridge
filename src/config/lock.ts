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
 * The lock file records the PID that acquired it, plus the holder's process
 * start time; on `releaseLock` we unlink the file.  A holder that dies
 * without releasing — SIGKILL, OOM kill, power loss — would otherwise leave
 * a file that every later start is refused against, forever, so a holder
 * that is provably gone is reclaimed instead.
 */

import { Buffer } from "node:buffer";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { normaliseStateDir } from "./state-dir.js";

/** Backing field for in-process lock holders. */
const HELD: Map<string, { fd: number; path: string }> = new Map();

export function lockPath(stateDir: string): string {
  return join(normaliseStateDir(stateDir), "nookbridge.lock");
}

/**
 * A lock file whose holder cannot be identified is only treated as stale once
 * it is older than this.  Acquisition creates the file before writing the
 * holder's pid, so a start that landed inside that window would otherwise
 * steal a lock a live process is in the middle of taking — and two processes
 * owning the same database is worse than a delayed start.
 */
const UNIDENTIFIED_LOCK_GRACE_MS = 5_000;

interface LockHolder {
  readonly pid: number;
  /** Boot-relative start time of the holder, when the file records one. */
  readonly startTimeTicks: string | null;
}

function readLockHolder(path: string): LockHolder | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const [firstLine = "", secondLine = ""] = raw.trim().split("\n");
  const pid = Number.parseInt(firstLine, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  const recorded = secondLine.trim();
  return { pid, startTimeTicks: recorded === "" ? null : recorded };
}

/**
 * Field 22 (`starttime`) of `/proc/<pid>/stat`, in clock ticks since boot.
 * The `comm` field can contain spaces and parentheses, so parse from the last
 * `)`; the fields after it begin at index 0 for field 3.
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
 * Whether the lock file at `path` was left behind by a holder that is gone.
 *
 * Only positive evidence of death counts: a pid that no longer exists
 * (`ESRCH`), or a live pid whose recorded start time differs from the process
 * now holding that pid (a reused pid).  Anything else — an unreadable file,
 * `EPERM` because the holder belongs to another user, a live pid with a
 * matching start time, an unidentified file inside the grace window — is an
 * active holder, and is left alone.
 */
function isLockHolderGone(path: string): boolean {
  const holder = readLockHolder(path);
  if (holder === null) {
    try {
      return Date.now() - statSync(path).mtimeMs >= UNIDENTIFIED_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
  if (holder.pid === process.pid) {
    return false;
  }
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    return (error as { code?: string }).code === "ESRCH";
  }
  if (holder.startTimeTicks === null) {
    return false;
  }
  const live = readStartTimeTicks(holder.pid);
  return live !== null && live !== holder.startTimeTicks;
}

/** Remove the lock file when, and only when, its holder is provably gone. */
function reclaimStaleLock(path: string): boolean {
  if (!isLockHolderGone(path)) {
    return false;
  }
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
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
 *   3. A holder that died without releasing leaves the file behind; that lock
 *      is reclaimed when its holder is provably gone, and only then, so a live
 *      holder is never stolen.
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
    if (!reclaimStaleLock(canonical)) {
      return null;
    }
    try {
      fd = openSync(canonical, "wx", 0o600);
    } catch {
      return null;
    }
  }
  // Record the holder so an operator examining the state dir can identify it,
  // and so a later start can tell a dead holder from a live one.  The start
  // time is what makes reclaiming a reused pid safe.  We never write the
  // secret key.
  try {
    const pidBuf = Buffer.from(
      `${process.pid}\n${readStartTimeTicks(process.pid) ?? ""}\n`,
      "utf8",
    );
    // Synchronous write via fs.writeSync through the fd.
    writeSync(fd, pidBuf, 0, pidBuf.length, 0);
  } catch {
    // best-effort metadata
  }
  HELD.set(canonical, { fd, path: canonical });
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
 * A lock file whose holder is provably gone does not count: otherwise a
 * single crash would wedge every read and recovery path until an operator
 * deleted the file by hand.  This function never removes anything.
 */
export function lockFileExists(stateDir: string): boolean {
  const canonical = resolve(lockPath(stateDir));
  try {
    if (!existsSync(canonical)) {
      return false;
    }
    return !isLockHolderGone(canonical);
  } catch {
    // Unknown filesystem state is unsafe for mutation; fail closed.
    return true;
  }
}

export function releaseLock(stateDir: string): boolean {
  const canonical = resolve(lockPath(stateDir));
  const held = HELD.get(canonical);
  if (!held) {
    return false;
  }
  try {
    closeSync(held.fd);
  } catch {
    /* already closed */
  }
  try {
    if (existsSync(canonical)) {
      unlinkSync(canonical);
    }
  } catch {
    /* file may already be gone; the in-process record is the truth */
  }
  HELD.delete(canonical);
  return true;
}
