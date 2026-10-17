/**
 * NookBridge Stage 9.5 (PR-66) — shared quarantine primitives.
 *
 * The recovery slice (single development database and the production
 * database bundle) shares the same on-disk quarantine contract:
 *
 *   - a fixed, application-owned `.recovery-quarantine/` directory under
 *     the state root, mode `0o700`;
 *   - each accepted quarantine is `<quarantineDir>/<opaque-id>/`, mode
 *     `0o700`, where the opaque id is the only handle the operator ever
 *     receives (`<8-hex>-<base36>`);
 *   - the original artefacts move into the entry by a same-filesystem
 *     hard link followed by an unlink, so the move never copies bytes and
 *     never replaces an existing destination;
 *   - no path, key, or body is ever echoed.
 *
 * Keeping these primitives in one module means the single-database path
 * and the production-bundle path cannot drift on the security-relevant
 * details (mode, no-clobber semantics, identifier shape, cleanup).
 */

import { randomBytes } from "node:crypto";
import { linkSync, rmSync, unlinkSync } from "node:fs";

export const QUARANTINE_RELATIVE_DIR = ".recovery-quarantine" as const;
export const QUARANTINE_DIR_MODE = 0o700;
export const QUARANTINE_ENTRY_MODE = 0o700;
export const QUARANTINE_ID_PATTERN = /^[a-f0-9]{8}-[a-z0-9]{12,13}$/;

/**
 * Opaque, non-path, non-carrier quarantine identifier.
 *
 * 8 hex characters plus a 12–13 character base36 sequence.  It carries no
 * user data, no path component, and no credential shape; it exists only to
 * name the quarantine entry inside the fixed state root.
 */
export function makeQuarantineId(): string {
  const hex = randomBytes(4).toString("hex");
  const seq = randomBytes(8).readBigUInt64BE(0).toString(36).padStart(12, "0");
  return `${hex}-${seq}`;
}

/**
 * Move a regular file without copying and without replacing an existing
 * destination.  `linkSync` + `unlinkSync` is the portable same-filesystem
 * no-clobber move: `linkSync` fails with `EEXIST` if the destination is
 * occupied, unlike `renameSync`, which would silently replace it.
 *
 * On any failure the two links are reconciled so data is never lost: if the
 * destination link was created but the source unlink failed, the destination
 * link is removed and the call reports failure.  A crash between the two
 * calls leaves two hard links to the same inode; callers must treat that as
 * "moved" only when the two paths resolve to the same inode.
 */
export function moveNoReplace(source: string, destination: string): boolean {
  let linked = false;
  try {
    linkSync(source, destination);
    linked = true;
    unlinkSync(source);
    return true;
  } catch {
    if (linked) {
      try {
        unlinkSync(destination);
      } catch {
        /* preserve both links rather than risking data loss */
      }
    }
    return false;
  }
}

/**
 * Remove a quarantine entry, best effort.
 *
 * This is the shared baseline used by the development single-database
 * recovery path; its semantics match upstream/main exactly
 * (`rmSync(path, { force: true })` with the throw swallowed).  It is
 * deliberately NOT recursive, so a directory at `path` is left in place —
 * the same behaviour the development path has always had.  The production
 * bundle path clears a leftover entry directory with its own recursive
 * remover (`removeBundleQuarantineEntry` in `recover-bundle.ts`).
 */
export function safeRmQuarantineEntry(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}
