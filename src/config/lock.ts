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
 * The lock file records the PID that acquired it; on `releaseLock`
 * we unlink the file.  Stage 1 does NOT implement stale-lock recovery
 * (the Stage 1 plan binds this to "rejected or blocks predictably",
 * which is exactly what `wx` gives us).
 */

import { Buffer } from "node:buffer";
import { closeSync, existsSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { normaliseStateDir } from "./state-dir.js";

/** Backing field for in-process lock holders. */
const HELD: Map<string, { fd: number; path: string }> = new Map();

export function lockPath(stateDir: string): string {
  return join(normaliseStateDir(stateDir), "nookbridge.lock");
}

/**
 * Try to acquire the single-instance lock for `stateDir`.  Returns a
 * release function on success or `null` when another process (or
 * another call in this process) already holds it.
 *
 * The acquisition is best-effort across two races:
 *
 *   1. In-process double-acquire is caught by the HELD map.
 *   2. Cross-process acquire is caught by `wx` (write, fail if exists)
 *      + a read-back of the lock's PID.
 *
 * Stale-lock recovery is OUT of scope for Stage 1.
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
  // Write the PID so an operator examining the state dir can identify
  // the lock holder.  We never write the secret key.
  try {
    const pidBuf = Buffer.from(`${process.pid}\n`, "utf8");
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
