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
type HeldLock = { fd: number; path: string; ino: number; record: string };

const HELD: Map<string, HeldLock> = new Map();

export function lockPath(stateDir: string): string {
  return join(normaliseStateDir(stateDir), "nookbridge.lock");
}

/**
 * Node has no atomic conditional unlink. Rename first isolates the current
 * directory entry, then inode/record verification decides whether it is ours.
 * We never unlink a file we have not first isolated and identified. Stale
 * files are removed only by an operator, never by this code.
 */
function releaseOwnedLockFile(
  path: string,
  expectedIno: number,
  expectedRecord: string | undefined,
): "released" | "gone" | "foreign" {
  // Token generation runs before any rename.  A failure leaves the file at
  // `path`, so it is reported as foreign, not gone.
  let detached: string;
  try {
    detached = `${path}.release-${randomBytes(8).toString("hex")}`;
  } catch {
    return "foreign";
  }
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
 * Facts a held inspect lock needs to prove ownership at release.  The holder
 * record and inode are captured by {@link acquireInspectLock}; the caller never
 * supplies either, so it cannot release a file this acquisition did not create.
 */
export interface InspectLockHandle {
  /** The holder record written for this lock, in the shared format. */
  readonly record: string;
  /** True when the full holder record was written; false on a short/failed write. */
  readonly recordWritten: boolean;
  /**
   * Release the lock file only while it is still this handle's: the same inode,
   * and, when a full holder record was written, the same record.  Closes the
   * file descriptor.  Returns `"released"`, `"gone"` (no file at the path), or
   * `"foreign"` (a replacement this handle does not own, left in place).
   * One-shot: only the first call acts.  Any later call returns `"foreign"` and
   * touches nothing, so a stale handle cannot release a newer inspect lock.
   */
  release(): "released" | "gone" | "foreign";
}

/** Outcome of {@link acquireInspectLock}. */
export type InspectLockAcquire =
  | Readonly<{ kind: "acquired"; handle: InspectLockHandle }>
  | Readonly<{ kind: "locked" }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "indeterminate" }>;

/**
 * Acquire the single-instance lock for the read-only inspect path and return a
 * handle that owns its inode and holder record.
 *
 * This is deliberately separate from {@link tryAcquireLock}: inspect must not
 * enter the in-process `HELD` cache (a diagnostic may legitimately hold the
 * lock while inspect runs), and it must refuse — never reclaim — any existing
 * lock file, live or stale.  The exclusive `wx` create is the atomic gate; an
 * `EEXIST` is a held lock, `ENOENT` a missing state directory, and any other
 * create failure is indeterminate.
 *
 * The holder record is REQUIRED: a short or failed write still yields a handle
 * (`recordWritten === false`) so the caller can release the file it created,
 * but it must not proceed with the record unproven.
 */
export function acquireInspectLock(stateDir: string): InspectLockAcquire {
  const path = lockPath(stateDir);
  // Atomic, exclusive create; an existing file — live or stale — refuses.
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "EEXIST") return { kind: "locked" };
    // A nonexistent state directory has nothing to inspect.
    if (code === "ENOENT") return { kind: "missing" };
    // Any other failure to create the lock is unsafe to proceed past.
    return { kind: "indeterminate" };
  }

  // The inode is the proof of ownership at release.  Without it no release can
  // be proved, so the file is left for an operator and the fd is closed.
  let ino: number;
  try {
    ino = fstatSync(fd).ino;
  } catch {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    return { kind: "indeterminate" };
  }

  // Holder record: the same one format the acquire path uses.  A short write is
  // a failed write, not a recorded one.
  const record = holderRecord();
  const recordBuf = Buffer.from(record, "utf8");
  let written: number;
  try {
    written = writeSync(fd, recordBuf, 0, recordBuf.length, 0);
  } catch {
    written = -1;
  }
  const recordWritten = written === recordBuf.length;

  // One-shot: the first release attempt is the only one that acts.  A retained
  // handle called again after a later acquisition must not re-run the rename
  // against that newer lock, so later calls touch nothing and report "foreign".
  let spent = false;
  const handle: InspectLockHandle = {
    record,
    recordWritten,
    release: (): "released" | "gone" | "foreign" => {
      if (spent) return "foreign";
      spent = true;
      try {
        return releaseOwnedLockFile(path, ino, recordWritten ? record : undefined);
      } finally {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    },
  };
  return { kind: "acquired", handle };
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
 * The holder record for `pid`: "<pid>\n<starttime-or-empty>\n".  Every writer
 * of the lock file uses this one format.  Diagnostic only; no path reclaims a
 * lock on the basis of it.
 */
export function holderRecord(pid: number = process.pid): string {
  return `${pid}\n${readStartTimeTicks(pid) ?? ""}\n`;
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
  const pidBuf = Buffer.from(holderRecord(), "utf8");
  let written: number;
  try {
    written = writeSync(fd, pidBuf, 0, pidBuf.length, 0);
  } catch {
    written = -1;
  }
  if (written !== pidBuf.length) {
    // Removal is best-effort.  Its outcome is not consumed: if the file
    // remains (at the lock path or under a `.release-*` name), this function
    // still returns null, so acquisition fails closed until an operator clears
    // it.  No path reclaims it.  The stage-9 doc states this residue path.
    try {
      releaseOwnedLockFile(canonical, ino, undefined);
    } catch {
      /* best-effort: a throw here must not escape; the caller still gets null */
    }
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    return null;
  }
  const entry: HeldLock = { fd, path: canonical, ino, record: pidBuf.toString("utf8") };
  HELD.set(canonical, entry);
  // The release closure is bound to this acquisition's entry, not to the
  // directory. After a release and a later re-acquire, an old closure finds a
  // different entry in HELD and does nothing, so it cannot release a newer lock.
  return () => releaseAcquisition(canonical, entry);
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
  return releaseAcquisition(canonical, held);
}

/**
 * Release one specific acquisition. Does nothing unless `held` is still the
 * entry in HELD for `canonical`, so a stale release capability cannot free a
 * lock acquired later.
 */
function releaseAcquisition(canonical: string, held: HeldLock): boolean {
  if (HELD.get(canonical) !== held) {
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
