/**
 * NookBridge Stage 9.5 (PR-66) — production database-bundle recovery.
 *
 * The development recovery path in `recover-local-state.ts` knows a single
 * `nookbridge.db`.  Production does not use that layout: the daemon opens a
 * *bundle* of three encrypted SQLite databases (see
 * `auth/live-login-runtime.ts` and implementation-plan §3.5/§13.12 P1-9):
 *
 *   - `nookbridge-storage.db` — PersistentStorage KV/meta state;
 *   - `notesnook.db`          — upstream Notesnook core database;
 *   - `notesnook-logs.db`     — upstream Notesnook log database.
 *
 * Each member may also carry `-wal` and `-shm` SQLite sidecars (the runtime
 * sets `journalMode: "WAL"`).  This module treats the three members and any
 * present sidecars as ONE quarantine unit and refuses a partial bundle.
 *
 * Security contract:
 *
 *   - The key is read from the systemd `$CREDENTIALS_DIRECTORY/nookbridge-db-key`
 *     slot only — never argv, never env, never logs.  The caller injects the
 *     directory; this module never reads `process.env` itself.
 *   - A live single-instance lock refuses mutation, and the lock is held for
 *     the whole mutation.  A stale lock file alone is not trusted: a provably
 *     dead holder is reclaimed by the shared lock module.
 *   - A manifest is written into the quarantine entry BEFORE the first move.
 *     Every move records its checkpoint.  A rerun resumes an incomplete
 *     checkpoint or refuses; it never guesses.
 *   - Moves are same-filesystem, no-copy, no-clobber (`link` then `unlink`).
 *     Quarantine directories are `0o700` and identifiers are opaque.
 *   - Inspection is read-only: it opens no writable handle and changes no
 *     byte.
 *   - Every public result is categorical.  No path, key, note body, member
 *     name, or upstream error is ever echoed.
 */

import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import Database from "better-sqlite3-multiple-ciphers";

import { lockPath, tryAcquireLock } from "../config/lock.js";
import { normaliseStateDir } from "../config/state-dir.js";
import {
  NOOKBRIDGE_DB_KEY_LABEL,
  createSystemdCredentialKeyStore,
} from "../keystore/systemd-credential-keystore.js";
import { SqliteStorage, inspectEncryptedSqlite } from "../storage/sqlite-storage.js";
import {
  QUARANTINE_DIR_MODE,
  QUARANTINE_ENTRY_MODE,
  QUARANTINE_ID_PATTERN,
  QUARANTINE_RELATIVE_DIR,
  makeQuarantineId,
  moveNoReplace,
} from "./recover-quarantine.js";

// ---------------------------------------------------------------------------
// Bundle shape.
// ---------------------------------------------------------------------------

/** The three production members, in deterministic order. */
export const PRODUCTION_BUNDLE_MEMBERS: readonly string[] = [
  "nookbridge-storage.db",
  "notesnook.db",
  "notesnook-logs.db",
] as const;

/** SQLite sidecar suffixes preserved alongside each member. */
export const BUNDLE_SIDECAR_SUFFIXES: readonly string[] = ["-wal", "-shm"] as const;

export const BUNDLE_MANIFEST_FILENAME = "recovery-manifest.json" as const;
export const BUNDLE_MANIFEST_VERSION = 1 as const;

// Bundle rollback refusal messages.  They mirror the development rollback
// style and are the exact strings the tests assert.
const ROLLBACK_OPAQUE =
  "nookctl recover-local-state bundle rollback: refusing opaque identifier" as const;
const ROLLBACK_UNKNOWN =
  "nookctl recover-local-state bundle rollback: unknown quarantine identifier" as const;
const ROLLBACK_INCOMPLETE =
  "nookctl recover-local-state bundle rollback: preserved state is incomplete" as const;
const ROLLBACK_OCCUPIED =
  "nookctl recover-local-state bundle rollback: destination is occupied" as const;
const ROLLBACK_RESTORE_FAILED =
  "nookctl recover-local-state bundle rollback: failed to restore preserved state" as const;
const ROLLBACK_PARTIAL =
  "nookctl recover-local-state bundle rollback: restore partially applied; manual recovery required" as const;

// ---------------------------------------------------------------------------
// Public result shapes (closed unions — categorical only).
// ---------------------------------------------------------------------------

export type BundleInspection =
  | Readonly<{ kind: "healthy" }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "partial" }>
  | Readonly<{ kind: "corrupt" }>
  | Readonly<{ kind: "locked" }>
  | Readonly<{ kind: "indeterminate" }>;

export type BundleReinitializeResult =
  | Readonly<{ kind: "reinitialized"; quarantineId: string }>
  | Readonly<{ kind: "error"; exitCode: 2 | 3; message: string }>;

export type BundleRollbackResult =
  | Readonly<{ kind: "rolled-back"; quarantineId: string }>
  | Readonly<{ kind: "error"; exitCode: 2 | 3; message: string }>;

export type ReinitializeBundleOptions = Readonly<{
  stateDir: string;
  /**
   * Absolute path of the systemd `$CREDENTIALS_DIRECTORY` to read
   * `nookbridge-db-key` from.  The value is a directory, never the key.
   */
  credentialsDirectory?: string;
}>;

export type RollbackBundleOptions = Readonly<{
  stateDir: string;
  /** Opaque quarantine identifier received from a prior reinitialize. */
  quarantineId: string;
}>;

// ---------------------------------------------------------------------------
// Crash-checkpoint manifest.
//
// The manifest lives inside the quarantine entry.  It lists only
// allowlisted bundle-relative names (members and their sidecars), never an
// absolute path, and never any key or body.  It is written before the first
// move so a crash mid-quarantine is resumable rather than guessed.
// ---------------------------------------------------------------------------

export type BundleManifestItem = Readonly<{ name: string; state: "pending" | "moved" }>;

export type BundleManifest = Readonly<{
  version: number;
  id: string;
  status: "incomplete" | "complete";
  items: readonly BundleManifestItem[];
}>;

// ---------------------------------------------------------------------------
// Credential boundary.
// ---------------------------------------------------------------------------

/**
 * Read the production database key from the systemd credential slot only.
 *
 * `credentialsDirectory` is injected by the CLI from `$CREDENTIALS_DIRECTORY`;
 * the key itself never travels through argv, env, or logs.  The systemd
 * credential backend performs a bounded `O_RDONLY | O_NOFOLLOW` read and
 * refuses missing/empty/oversized/non-regular sources by returning
 * `undefined`.
 */
export function readProductionBundleKey(
  credentialsDirectory: string | undefined,
): string | undefined {
  if (typeof credentialsDirectory !== "string" || credentialsDirectory.length === 0) {
    return undefined;
  }
  return createSystemdCredentialKeyStore({
    credentialsDirectory,
    credentialName: NOOKBRIDGE_DB_KEY_LABEL,
  }).getDatabaseKey();
}

// ---------------------------------------------------------------------------
// Inspection (read-only).
// ---------------------------------------------------------------------------

/**
 * True when a directory entry exists, including a dangling symlink.
 * `existsSync` follows symlinks and reports a dangling one as absent, so a
 * bundle artifact check built on it would silently skip a sidecar that a move
 * then leaves behind.  Only ENOENT counts as absent; any other lstat failure
 * is treated as present so the caller fails closed.
 */
function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    return !(err instanceof Error && "code" in err && err.code === "ENOENT");
  }
}

type MemberPresence = "complete" | "partial" | "missing" | "unsafe";

function memberPresence(stateDir: string): MemberPresence {
  let present = 0;
  for (const member of PRODUCTION_BUNDLE_MEMBERS) {
    const candidate = join(stateDir, member);
    if (!pathEntryExists(candidate)) continue;
    try {
      const stat = lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) return "unsafe";
      present += 1;
    } catch {
      return "unsafe";
    }
  }
  if (present === 0) return "missing";
  if (present === PRODUCTION_BUNDLE_MEMBERS.length) return "complete";
  return "partial";
}

/**
 * Inspect the production bundle without opening the real member files.
 *
 * A WAL-mode database cannot be probed in place without SQLite touching the
 * shared-memory `-shm` index (rewriting it, and recreating `-shm`/`-wal` when
 * they are absent).  This function therefore copies each present member and
 * its present `-wal`/`-shm` sidecars into a private `mkdtempSync` directory
 * outside the state root, probes only the copy, and removes the copy in a
 * `finally` block.  The originals stay byte-identical with identical names.
 *
 * The whole copy-and-probe runs under the single-instance lock so a gateway
 * cannot start mid-inspect.  The lock is taken with an exclusive `wx` create
 * (never `tryAcquireLock`, which reclaims dead holders) and any pre-existing
 * lock file — live or stale — refuses the inspect.  The lock is released on
 * every path, but only while the file is still the exact one this call
 * created.
 *
 * `key` is optional: with it, each present member is probed; without it the
 * result is categorical and indeterminate rather than an unhealthy guess.
 */
export function inspectProductionBundle(
  stateDir: string,
  key: string | undefined,
): BundleInspection {
  // 1. Read-only presence check first, before creating anything, so a
  //    nonexistent state directory still reports "missing".
  const initialPresence = memberPresence(stateDir);
  if (initialPresence === "missing") return { kind: "missing" };
  if (initialPresence === "partial") return { kind: "partial" };
  if (initialPresence === "unsafe") return { kind: "corrupt" };

  // 2. The key is required before taking the lock.
  if (typeof key !== "string" || key.length === 0) return { kind: "indeterminate" };

  // 3. Acquire atomically.  Any existing lock file — live or stale — refuses;
  //    nothing is reclaimed and nothing is unlinked here.
  let fd: number;
  try {
    fd = openSync(lockPath(stateDir), "wx", 0o600);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return { kind: "locked" };
    // Any other failure to create the lock is unsafe to proceed past.
    return { kind: "indeterminate" };
  }

  // The holder record, verified at release.  lock.ts's holder reader accepts
  // a pid-only record (the optional start-time line is omitted here).
  const record = `${process.pid}\n`;
  let lockIno: number | undefined;

  // 6. Everything after acquire runs inside ONE outer try/finally.
  try {
    // 5. Record ownership of the file just created.
    lockIno = fstatSync(fd).ino;

    // 4. Best-effort holder record; ownership is tracked by the inode above.
    try {
      writeSync(fd, record, 0, "utf8");
    } catch {
      /* best-effort metadata */
    }

    // 7. A mutation may have changed the state between step 1 and the
    //    acquire, so re-run the presence check under the lock.
    const presence = memberPresence(stateDir);
    if (presence === "missing") return { kind: "missing" };
    if (presence === "partial") return { kind: "partial" };
    if (presence === "unsafe") return { kind: "corrupt" };

    const probe = probeBundleCopyUnderLock(stateDir, key);
    if (probe.kind === "missing") return { kind: "missing" };
    if (probe.kind === "corrupt") return { kind: "corrupt" };
    for (const member of PRODUCTION_BUNDLE_MEMBERS) {
      if (probe.statuses[member] !== "healthy") return { kind: "corrupt" };
    }
    return { kind: "healthy" };
  } finally {
    // 8. Release only the lock file this call still owns.
    releaseIfOwned(stateDir, fd, lockIno, record);
  }
}

/** Three-way read-only classification of one copied member. */
type MemberReinitStatus = "healthy" | "readable-corrupt" | "unreadable";

/** Result of probing a private copy of the bundle. */
type BundleCopyProbe =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "corrupt" }>
  | Readonly<{ kind: "probed"; statuses: Record<string, MemberReinitStatus> }>;

/**
 * Copy the bundle members (and their present sidecars) into a private temp
 * directory and classify each copy read-only.
 *
 * The CALLER MUST HOLD the state-directory lock: this helper does no locking
 * of its own so it can be reused by both `inspectProductionBundle` and
 * `reinitializeProductionBundle` while either holds the lock.  The originals
 * are never opened or modified.  `members` limits the probe to a subset; the
 * resume path uses it to probe only the members that are still in the root.
 */
function probeBundleCopyUnderLock(
  stateDir: string,
  key: string,
  members: readonly string[] = PRODUCTION_BUNDLE_MEMBERS,
): BundleCopyProbe {
  // Sweep stale inspect copies left behind by a crashed run.  We hold the
  // lock, so no concurrent inspect can race this.  Never throws.
  sweepStaleInspectCopies(tmpdir());

  let tempDir: string;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "nookbridge-bundle-inspect-"));
  } catch {
    return { kind: "corrupt" };
  }

  try {
    chmodSync(tempDir, 0o700);
    // Owner record: lets a later run sweep this copy if we crash.  A failed
    // write fails closed (the finally removes the copy dir).
    try {
      writeFileSync(join(tempDir, "owner.pid"), String(process.pid), {
        mode: 0o600,
        flag: "wx",
      });
    } catch {
      return { kind: "corrupt" };
    }

    const statuses: Record<string, MemberReinitStatus> = {};
    for (const member of members) {
      const original = join(stateDir, member);
      // A missing member is never copied and keeps its existing mapping.
      if (!pathEntryExists(original)) return { kind: "missing" };

      const copy = join(tempDir, member);
      if (!copyRegularFile(original, copy)) return { kind: "corrupt" };

      for (const suffix of BUNDLE_SIDECAR_SUFFIXES) {
        const sidecar = join(stateDir, `${member}${suffix}`);
        if (!pathEntryExists(sidecar)) continue;
        if (!copyRegularFile(sidecar, join(tempDir, `${member}${suffix}`))) {
          return { kind: "corrupt" };
        }
      }

      // Preserve the original read-only probe call so the inspect seam (the
      // mocked `inspectEncryptedSqlite`) still fires at its current point.
      // Its collapsed result is not used for the three-way status below.
      inspectEncryptedSqlite({ dbPath: copy, key });
      statuses[member] = classifyMemberForReinit(copy, key);
    }
    return { kind: "probed", statuses };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort: the copy is private and disposable */
    }
  }
}

/**
 * Classify one COPIED member read-only.
 *
 * Unlike `inspectEncryptedSqlite` (which collapses every throw to
 * "unreadable"), this opens the copy itself and discriminates by error code,
 * so a readable-but-corrupt original can still be quarantined while an
 * unreadable one refuses.
 *
 * The error code is the discriminator: observed in scratch on the R2 fixture,
 * a right key with a corrupted data page raises SQLITE_CORRUPT, while a wrong
 * key or a destroyed header raises SQLITE_NOTADB.  This is observed on this
 * SQLCipher build, not proven in general.
 */
function classifyMemberForReinit(copyPath: string, key: string): MemberReinitStatus {
  try {
    const db = new Database(copyPath, { readonly: true, fileMustExist: true });
    try {
      db.pragma("cipher='sqlcipher'");
      db.pragma(`key="${escapeReinitKey(key)}"`);
      const rows = db.pragma("integrity_check(100)") as unknown;
      if (!Array.isArray(rows) || rows.length === 0) return "readable-corrupt";
      const healthy = rows.every(
        (row: unknown) =>
          typeof row === "object" &&
          row !== null &&
          "integrity_check" in row &&
          (row as { integrity_check?: unknown }).integrity_check === "ok",
      );
      return healthy ? "healthy" : "readable-corrupt";
    } finally {
      try {
        db.close();
      } catch {
        /* best-effort */
      }
    }
  } catch (error) {
    if ((error as { code?: unknown }).code === "SQLITE_CORRUPT") return "readable-corrupt";
    return "unreadable";
  }
}

/**
 * Copied verbatim from `escapeKey` in src/storage/sqlite-storage.ts: strips
 * `"` and `\` so a key cannot terminate the `key=` pragma.
 */
function escapeReinitKey(key: string): string {
  return key.replace(/["\\]/g, "");
}

/**
 * Close the lock fd, then remove the lock file only while it is still the
 * exact file this call created: same inode AND same holder record.  A foreign
 * or replaced lock file is left in place.  Never throws.
 */
function releaseIfOwned(
  stateDir: string,
  fd: number,
  lockIno: number | undefined,
  record: string,
): void {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
  if (lockIno === undefined) return;
  try {
    const path = lockPath(stateDir);
    const stat = statSync(path);
    if (!stat.isFile() || stat.ino !== lockIno) return;
    if (readFileSync(path, "utf8") !== record) return;
    unlinkSync(path);
  } catch {
    /* ENOENT, or any other failure: leave the lock file alone */
  }
}

/**
 * A copy directory younger than this is never swept.  The state lock is per
 * state root, so an inspect for another root may still be starting; a fresh
 * directory with a dead owner pid is not yet proof of a crash.
 */
const SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Sweep inspect copy directories left behind by a crashed run.
 *
 * Must be called while the state lock is held, so no concurrent inspect can
 * race it.  An entry is removed only when every one of these holds:
 *
 *   - its name starts with `nookbridge-bundle-inspect-`;
 *   - `lstat` says it is a real directory, not a symlink;
 *   - its modification time is at least `SWEEP_MIN_AGE_MS` in the past;
 *   - it is owned by the current user (`lstat.uid === getuid()`), so another
 *     user's directory is never deleted from the shared temp dir;
 *   - it contains a regular (non-symlink) `owner.pid` whose trimmed text is a
 *     positive integer matching `/^[1-9][0-9]*$/`;
 *   - that pid is not alive (`ESRCH`); no error or `EPERM` counts as alive.
 *
 * Anything else — no owner file, a live owner, a symlink, a non-directory, a
 * foreign owner — is left alone.  The helper never throws.
 */
function sweepStaleInspectCopies(root: string): void {
  try {
    const getuid = (process as { getuid?: () => number }).getuid;
    if (getuid === undefined) return;
    const uid = getuid();

    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }

    for (const name of names) {
      if (!name.startsWith("nookbridge-bundle-inspect-")) continue;
      const entryPath = join(root, name);

      let entryStat;
      try {
        entryStat = lstatSync(entryPath);
      } catch {
        continue;
      }
      if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) continue;
      if (entryStat.uid !== uid) continue;
      if (Date.now() - entryStat.mtimeMs < SWEEP_MIN_AGE_MS) continue;

      const ownerPath = join(entryPath, "owner.pid");
      let ownerStat;
      try {
        ownerStat = lstatSync(ownerPath);
      } catch {
        continue;
      }
      if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) continue;

      let ownerText: string;
      try {
        ownerText = readFileSync(ownerPath, "utf8").trim();
      } catch {
        continue;
      }
      if (!/^[1-9][0-9]*$/.test(ownerText)) continue;

      const pid = Number.parseInt(ownerText, 10);
      let alive: boolean;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        // ESRCH means the process is gone; EPERM or any other error means it
        // is (or may be) alive, so leave the entry alone.
        alive = (error as { code?: string }).code !== "ESRCH";
      }
      if (alive) continue;

      try {
        rmSync(entryPath, { recursive: true, force: true });
      } catch {
        /* best-effort: leave it for a later sweep */
      }
    }
  } catch {
    /* the sweep must never throw */
  }
}

/**
 * Copy a regular file without following a symlink.  Returns `false` for a
 * symlink, a non-regular file, or a failed copy so the caller can fail closed.
 * `COPYFILE_EXCL` guarantees the private copy directory is never overwritten.
 */
function copyRegularFile(source: string, destination: string): boolean {
  try {
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reinitialize (mutation).
// ---------------------------------------------------------------------------

export function reinitializeProductionBundle(
  options: ReinitializeBundleOptions,
): BundleReinitializeResult {
  let stateDir: string;
  try {
    stateDir = normaliseStateDir(options.stateDir);
  } catch {
    return error(2, "refusing unsafe state root");
  }

  if (!existsSync(stateDir)) return error(2, "state root is missing");
  try {
    const stat = lstatSync(stateDir);
    if (stat.isSymbolicLink()) return error(2, "refusing symlink state root");
    if (!stat.isDirectory()) return error(2, "state root is not a directory");
  } catch {
    return error(2, "cannot inspect state root");
  }

  const key = readProductionBundleKey(options.credentialsDirectory);
  if (typeof key !== "string" || key.length === 0) {
    return error(2, "production database key is unavailable");
  }

  const presence = memberPresence(stateDir);
  if (presence === "missing") return error(2, "production database bundle is missing");
  if (presence === "unsafe") return error(2, "refusing unsafe production database bundle");

  // Exclusive ownership: refuse while a live holder exists, and hold the
  // lock for the WHOLE mutation — the quarantine scan, the empty-remnant
  // cleanup, the moves, and the fresh-state initialization.  A provably-dead
  // holder's stale file is reclaimed inside `tryAcquireLock`, so the lock
  // file alone is never trusted.
  const release = tryAcquireLock(stateDir);
  if (!release) return error(2, "state directory is currently locked by another process");
  try {
    // Scan under the lock.  This also removes empty leftover entry
    // directories recursively, so a failed move cannot block the next run.
    const quarantineDir = join(stateDir, QUARANTINE_RELATIVE_DIR);
    const scan = scanQuarantine(quarantineDir);
    if (scan.kind === "error") return scan.error;

    // A crash mid-quarantine legitimately leaves a partial state root with an
    // incomplete checkpoint.  A partial bundle is refused UNLESS a single
    // resumable checkpoint explains it.
    if (presence === "partial" && scan.kind !== "resume") {
      return error(2, "refusing partial production database bundle");
    }

    // A resumed run re-probes each pending member still in the state root.
    // A member an earlier run already moved is inside the entry, and one a
    // crash moved is reconciled rather than read, so neither is probed here.
    // Any other pending member that became unreadable since the first run is
    // refused before anything else moves.
    const probeMembers =
      scan.kind === "resume"
        ? scan.manifest.items
            .filter((item) => item.state === "pending")
            .map((item) => item.name)
            .filter(
              (name) =>
                PRODUCTION_BUNDLE_MEMBERS.includes(name) && pathEntryExists(join(stateDir, name)),
            )
        : [...PRODUCTION_BUNDLE_MEMBERS];
    if (probeMembers.length > 0) {
      const probe = probeBundleCopyUnderLock(stateDir, key, probeMembers);
      if (probe.kind !== "probed") {
        return error(2, "refusing unprobeable production database bundle");
      }
      for (const member of probeMembers) {
        const status = probe.statuses[member];
        if (status !== "healthy" && status !== "readable-corrupt") {
          return error(2, "refusing unprobeable production database bundle");
        }
      }
    }
    return quarantineAndReinitialize(stateDir, key, scan);
  } finally {
    try {
      release();
    } catch {
      /* the in-process record is the source of truth; best-effort release */
    }
  }
}

function quarantineAndReinitialize(
  stateDir: string,
  key: string,
  scan: ResolvedQuarantineScan,
): BundleReinitializeResult {
  const quarantineDir = join(stateDir, QUARANTINE_RELATIVE_DIR);
  try {
    mkdirSync(quarantineDir, { recursive: true, mode: QUARANTINE_DIR_MODE });
    chmodSync(quarantineDir, QUARANTINE_DIR_MODE);
  } catch {
    return error(3, "failed to create quarantine directory");
  }

  let quarantineId: string;
  let entry: string;
  let manifest: BundleManifest;

  if (scan.kind === "resume") {
    quarantineId = scan.id;
    entry = join(quarantineDir, quarantineId);
    manifest = scan.manifest;
  } else {
    quarantineId = makeQuarantineId();
    entry = join(quarantineDir, quarantineId);
    try {
      mkdirSync(entry, { mode: QUARANTINE_ENTRY_MODE });
      chmodSync(entry, QUARANTINE_ENTRY_MODE);
    } catch {
      return error(3, "failed to create quarantine directory");
    }
    // The manifest is written BEFORE the first move so a crash is resumable.
    manifest = {
      version: BUNDLE_MANIFEST_VERSION,
      id: quarantineId,
      status: "incomplete",
      items: planBundleItems(stateDir).map((name) => ({ name, state: "pending" as const })),
    };
    if (!writeManifest(entry, manifest)) {
      discardEmptyEntry(entry);
      return error(3, "failed to record recovery manifest");
    }
  }

  // Reconcile and move each planned artefact exactly once.
  for (const item of manifest.items) {
    const source = join(stateDir, item.name);
    const destination = join(entry, item.name);
    const verdict = reconcileItem(source, destination, item.state);
    if (verdict === "inconsistent") {
      return error(2, "refusing inconsistent quarantine state");
    }
    if (verdict === "move") {
      if (!moveNoReplace(source, destination)) {
        discardEmptyEntry(entry);
        return error(3, "failed to quarantine the original state");
      }
      manifest = withItemState(manifest, item.name, "moved");
      if (!writeManifest(entry, manifest)) {
        return error(3, "failed to record recovery manifest");
      }
    } else if (verdict === "moved") {
      manifest = withItemState(manifest, item.name, "moved");
      if (!writeManifest(entry, manifest)) {
        return error(3, "failed to record recovery manifest");
      }
    }
  }

  manifest = { ...manifest, status: "complete" };
  if (!writeManifest(entry, manifest)) {
    return error(3, "failed to record recovery manifest");
  }

  // Initialize fresh encrypted members so the service can start and resync.
  try {
    for (const member of PRODUCTION_BUNDLE_MEMBERS) {
      const fresh = new SqliteStorage({
        dbPath: join(stateDir, member),
        key,
        withExtensions: false,
      });
      fresh.close();
    }
  } catch {
    return error(3, "failed to initialize fresh state");
  }

  return { kind: "reinitialized", quarantineId };
}

// ---------------------------------------------------------------------------
// Rollback (bundle path).
//
// Restores the three members — and every sidecar the manifest lists — from a
// named quarantine entry back to the state root.  Rollback does NOT read the
// database key: it is a pure filesystem move and works without a credentials
// directory.  Each move is a no-clobber link-then-unlink.  If a forward move
// fails, completed moves are undone; if an undo also fails the result is
// reported as a partial restore (exit 3, manual recovery).  The moves are not
// journaled, so this is a best-effort undo, not a crash-safe transaction.  On
// success the entry is consumed with the same cleanup convention the
// reinitialize path uses (`discardEmptyEntry`).
// ---------------------------------------------------------------------------

export function rollbackProductionBundle(options: RollbackBundleOptions): BundleRollbackResult {
  let stateDir: string;
  try {
    stateDir = normaliseStateDir(options.stateDir);
  } catch {
    return rollbackError(2, "refusing unsafe state root");
  }

  if (!existsSync(stateDir)) return rollbackError(2, "state root is missing");
  try {
    const stat = lstatSync(stateDir);
    if (stat.isSymbolicLink()) return rollbackError(2, "refusing symlink state root");
    if (!stat.isDirectory()) return rollbackError(2, "state root is not a directory");
  } catch {
    return rollbackError(2, "cannot inspect state root");
  }

  // Reuse the existing opaque-id validator from the development rollback
  // path; do not invent a new one.
  if (!QUARANTINE_ID_PATTERN.test(options.quarantineId)) {
    return rollbackError(2, ROLLBACK_OPAQUE);
  }

  const entry = resolve(join(stateDir, QUARANTINE_RELATIVE_DIR, options.quarantineId));
  const stateAbs = resolve(stateDir);
  const containment = relative(stateAbs, entry);
  if (
    containment.startsWith("..") ||
    isAbsolute(containment) ||
    containment.split(sep).includes("..")
  ) {
    return rollbackError(2, ROLLBACK_OPAQUE);
  }

  // Exclusive ownership for the whole mutation, mirroring reinitialize.
  const release = tryAcquireLock(stateDir);
  if (!release) {
    return rollbackError(2, "state directory is currently locked by another process");
  }
  try {
    return restoreBundleEntry(stateDir, entry, options.quarantineId);
  } finally {
    try {
      release();
    } catch {
      /* the in-process record is the source of truth; best-effort release */
    }
  }
}

function restoreBundleEntry(
  stateDir: string,
  entry: string,
  quarantineId: string,
): BundleRollbackResult {
  let stat;
  try {
    stat = lstatSync(entry);
  } catch {
    return rollbackError(2, ROLLBACK_UNKNOWN);
  }
  if (!stat.isDirectory()) return rollbackError(2, ROLLBACK_UNKNOWN);

  const manifest = readRollbackManifest(entry, quarantineId);
  if (manifest === undefined) return rollbackError(2, ROLLBACK_INCOMPLETE);

  // Every artefact the manifest names must be present in the entry as a
  // regular file; a missing member (or sidecar) is an incomplete entry.
  for (const item of manifest.items) {
    if (!isRegularFile(join(entry, item.name))) {
      return rollbackError(2, ROLLBACK_INCOMPLETE);
    }
  }

  const plan = restorePlan(manifest);

  // Refuse before any mutation if a destination is already occupied.  The
  // existing file is never displaced.
  for (const name of plan) {
    if (pathEntryExists(join(stateDir, name))) {
      return rollbackError(2, ROLLBACK_OCCUPIED);
    }
  }

  // Move every planned file.  On a forward failure, undo the completed moves
  // in reverse.  If any undo also fails, members are split between the state
  // root and the entry; report that explicitly so the operator recovers by hand.
  const completed: string[] = [];
  for (const name of plan) {
    if (!moveNoReplace(join(entry, name), join(stateDir, name))) {
      let undoFailures = 0;
      for (const done of [...completed].reverse()) {
        if (!moveNoReplace(join(stateDir, done), join(entry, done))) undoFailures += 1;
      }
      return rollbackError(3, undoFailures === 0 ? ROLLBACK_RESTORE_FAILED : ROLLBACK_PARTIAL);
    }
    completed.push(name);
  }

  // Consume the entry using the bundle cleanup convention.
  discardEmptyEntry(entry);
  return { kind: "rolled-back", quarantineId };
}

/** The three members followed by every extra artefact the manifest lists. */
function restorePlan(manifest: BundleManifest): string[] {
  const plan = [...PRODUCTION_BUNDLE_MEMBERS];
  for (const item of manifest.items) {
    if (!plan.includes(item.name)) plan.push(item.name);
  }
  return plan;
}

/**
 * Read a manifest for rollback.  Unlike the reinitialize reader this accepts
 * a `complete` status as well as `incomplete`; it rejects missing, malformed,
 * misidentified, or member-incomplete manifests.
 */
function readRollbackManifest(entry: string, expectedId: string): BundleManifest | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(entry, BUNDLE_MANIFEST_FILENAME), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== BUNDLE_MANIFEST_VERSION) return undefined;
  if (candidate.id !== expectedId) return undefined;
  const status = candidate.status;
  if (status !== "incomplete" && status !== "complete") return undefined;
  if (!Array.isArray(candidate.items)) return undefined;

  const seen = new Set<string>();
  const items: BundleManifestItem[] = [];
  const membersCovered = new Set<string>();
  for (const entryItem of candidate.items) {
    if (typeof entryItem !== "object" || entryItem === null || Array.isArray(entryItem)) {
      return undefined;
    }
    const record = entryItem as Record<string, unknown>;
    const name = record.name;
    const state = record.state;
    if (typeof name !== "string" || !isBundleArtifactName(name)) return undefined;
    if (state !== "pending" && state !== "moved") return undefined;
    if (seen.has(name)) return undefined;
    seen.add(name);
    if (PRODUCTION_BUNDLE_MEMBERS.includes(name)) membersCovered.add(name);
    items.push({ name, state });
  }
  if (items.length === 0) return undefined;
  if (membersCovered.size !== PRODUCTION_BUNDLE_MEMBERS.length) return undefined;

  return { version: BUNDLE_MANIFEST_VERSION, id: expectedId, status, items };
}

function rollbackError(exitCode: 2 | 3, message: string): BundleRollbackResult {
  return { kind: "error", exitCode, message };
}

// ---------------------------------------------------------------------------
// Planning.
// ---------------------------------------------------------------------------

/** The members plus any present sidecars, in deterministic order. */
function planBundleItems(stateDir: string): string[] {
  const names: string[] = [];
  for (const member of PRODUCTION_BUNDLE_MEMBERS) {
    names.push(member);
    for (const suffix of BUNDLE_SIDECAR_SUFFIXES) {
      if (pathEntryExists(join(stateDir, `${member}${suffix}`))) names.push(`${member}${suffix}`);
    }
  }
  return names;
}

function isBundleArtifactName(name: string): boolean {
  for (const member of PRODUCTION_BUNDLE_MEMBERS) {
    if (name === member) return true;
    for (const suffix of BUNDLE_SIDECAR_SUFFIXES) {
      if (name === `${member}${suffix}`) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Quarantine scan / resume.
// ---------------------------------------------------------------------------

type ScanResult =
  | Readonly<{ kind: "fresh" }>
  | Readonly<{ kind: "resume"; id: string; manifest: BundleManifest }>
  | Readonly<{ kind: "error"; error: BundleReinitializeResult }>;

/** A scan that has been classified and carries no refusal. */
type ResolvedQuarantineScan =
  | Readonly<{ kind: "fresh" }>
  | Readonly<{ kind: "resume"; id: string; manifest: BundleManifest }>;

/**
 * Remove a bundle quarantine entry recursively and report whether it is
 * gone.
 *
 * The production bundle needs recursive removal: a leftover entry directory
 * (for example from a failed move) must be cleared so it cannot block the
 * next run.  The shared development helper
 * (`safeRmQuarantineEntry`) deliberately keeps its non-recursive upstream
 * semantics, so the bundle owns this recursive variant.  This is the ONLY
 * place the bundle deletes a quarantine path.
 */
export function removeBundleQuarantineEntry(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* fall through to the authoritative existence check */
  }
  return !existsSync(path);
}

function scanQuarantine(quarantineDir: string): ScanResult {
  if (!existsSync(quarantineDir)) return { kind: "fresh" };

  let initial: string[];
  try {
    initial = readdirSync(quarantineDir);
  } catch {
    return { kind: "error", error: error(2, "refusing quarantine collision") };
  }

  // Remove empty leftover entry directories (e.g. from a failed move) so
  // they cannot block later runs.  A directory that still preserves state
  // is never touched.  This runs under the exclusive lock.
  for (const name of initial) {
    const candidate = join(quarantineDir, name);
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      return { kind: "error", error: error(2, "refusing quarantine collision") };
    }
    if (!stat.isDirectory()) continue;
    let contents: string[];
    try {
      contents = readdirSync(candidate);
    } catch {
      return { kind: "error", error: error(2, "refusing quarantine collision") };
    }
    if (contents.length === 0) removeBundleQuarantineEntry(candidate);
  }

  let remaining: string[];
  try {
    remaining = readdirSync(quarantineDir);
  } catch {
    return { kind: "error", error: error(2, "refusing quarantine collision") };
  }
  if (remaining.length === 0) return { kind: "fresh" };
  if (remaining.length !== 1) {
    return { kind: "error", error: error(2, "refusing quarantine collision") };
  }

  const id = remaining[0]!;
  const entry = join(quarantineDir, id);
  try {
    if (!lstatSync(entry).isDirectory()) {
      return { kind: "error", error: error(2, "refusing quarantine collision") };
    }
  } catch {
    return { kind: "error", error: error(2, "refusing quarantine collision") };
  }

  const manifest = readIncompleteManifest(entry, id);
  if (manifest === undefined) {
    return { kind: "error", error: error(2, "refusing quarantine collision") };
  }
  return { kind: "resume", id, manifest };
}

// ---------------------------------------------------------------------------
// Manifest I/O + validation.
// ---------------------------------------------------------------------------

function writeManifest(entry: string, manifest: BundleManifest): boolean {
  const target = join(entry, BUNDLE_MANIFEST_FILENAME);
  const temporary = `${target}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    return true;
  } catch {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      /* best-effort */
    }
    return false;
  }
}

function readIncompleteManifest(entry: string, expectedId: string): BundleManifest | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(entry, BUNDLE_MANIFEST_FILENAME), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const candidate = parsed as Record<string, unknown>;
  if (candidate.version !== BUNDLE_MANIFEST_VERSION) return undefined;
  if (candidate.id !== expectedId) return undefined;
  if (candidate.status !== "incomplete") return undefined;
  if (!Array.isArray(candidate.items)) return undefined;

  const seen = new Set<string>();
  const items: BundleManifestItem[] = [];
  const membersCovered = new Set<string>();
  for (const entryItem of candidate.items) {
    if (typeof entryItem !== "object" || entryItem === null || Array.isArray(entryItem)) {
      return undefined;
    }
    const record = entryItem as Record<string, unknown>;
    const name = record.name;
    const state = record.state;
    if (typeof name !== "string" || !isBundleArtifactName(name)) return undefined;
    if (state !== "pending" && state !== "moved") return undefined;
    if (seen.has(name)) return undefined;
    seen.add(name);
    if (PRODUCTION_BUNDLE_MEMBERS.includes(name)) membersCovered.add(name);
    items.push({ name, state });
  }
  if (items.length === 0) return undefined;
  if (membersCovered.size !== PRODUCTION_BUNDLE_MEMBERS.length) return undefined;

  return {
    version: BUNDLE_MANIFEST_VERSION,
    id: expectedId,
    status: "incomplete",
    items,
  };
}

function withItemState(
  manifest: BundleManifest,
  name: string,
  state: "pending" | "moved",
): BundleManifest {
  return {
    ...manifest,
    items: manifest.items.map((item) => (item.name === name ? { name, state } : item)),
  };
}

// ---------------------------------------------------------------------------
// Reconcile helpers.
// ---------------------------------------------------------------------------

type ReconcileVerdict = "move" | "moved" | "inconsistent";

function reconcileItem(
  source: string,
  destination: string,
  recordedState: "pending" | "moved",
): ReconcileVerdict {
  const sourceExists = isRegularFile(source);
  const destinationExists = isRegularFile(destination);

  if (recordedState === "moved") {
    if (destinationExists && !sourceExists) return "moved";
    if (sourceExists && destinationExists && sameInode(source, destination)) {
      return completeInterruptedMove(source);
    }
    return "inconsistent";
  }

  if (sourceExists && !destinationExists) return "move";
  if (!sourceExists && destinationExists) return "moved";
  if (sourceExists && destinationExists) {
    if (sameInode(source, destination)) return completeInterruptedMove(source);
    return "inconsistent";
  }
  return "inconsistent";
}

/**
 * A crash between `linkSync` and `unlinkSync` leaves two hard links to the
 * same inode.  Removing the source link completes the move; because the two
 * paths share an inode, no bytes are at risk.
 */
function completeInterruptedMove(source: string): ReconcileVerdict {
  try {
    unlinkSync(source);
    return "moved";
  } catch {
    return "inconsistent";
  }
}

function sameInode(a: string, b: string): boolean {
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.ino === right.ino && left.dev === right.dev;
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Remove an entry only when it preserves nothing.  If any member/sidecar was
 * already moved into it, the preserved bytes are left in place for a resume.
 *
 * Called on a fresh-run manifest-write failure and on a first-move failure:
 * in both cases the entry holds at most the recovery manifest, so it must not
 * be left behind.  Exported so the branch can be tested directly; a
 * deterministic end-to-end move failure cannot be provoked from a temp
 * fixture (the only reliable link(2) failure, a non-writable entry, also
 * blocks the recursive removal).
 */
export function discardEmptyEntry(entry: string): void {
  try {
    const contents = readdirSync(entry).filter((name) => name !== BUNDLE_MANIFEST_FILENAME);
    if (contents.length === 0) removeBundleQuarantineEntry(entry);
  } catch {
    /* best-effort */
  }
}

function error(exitCode: 2 | 3, message: string): BundleReinitializeResult {
  return { kind: "error", exitCode, message };
}
