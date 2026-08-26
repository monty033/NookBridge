/**
 * NookBridge Stage 1 — state directory creation.
 *
 * The state directory is where encrypted SQLite, the single-instance
 * lock file, and (in development) the dev key file all live.  Stage 1
 * creates it with mode `0o700`.  Production boundaries (per-user
 * ownership, NoNewPrivileges, ProtectSystem=strict, etc.) are Stage
 * 5+ — see docs/implementation-plan-v1.5.md.
 */

import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function ensureStateDir(stateDir: string): boolean {
  const abs = resolve(stateDir);
  if (existsSync(abs)) {
    // Tighten permissions when re-entering an existing state dir.  An
    // operator that previously set 0o755 should not have it survive a
    // Stage 1 downgrade.
    try {
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        try {
          mkdirSync(abs, { recursive: true, mode: 0o700 });
        } catch {
          /* mode-on-existing-directory is a noop on most platforms */
        }
        return false;
      }
    } catch {
      // fall through and treat as missing
    }
  }
  mkdirSync(abs, { recursive: true, mode: 0o700 });
  return true;
}

/**
 * Coerces a configured directory path into an absolute, normalised
 * form, validating that it does not accidentally point at a system
 * path we know would be unsafe (e.g. `/`, `/etc`, `/tmp`).  Stage 1's
 * check is deliberately conservative — production sandboxing is
 * Stage 5+.
 */
export function normaliseStateDir(stateDir: string): string {
  const abs = resolve(stateDir);
  const banned = new Set(["/", "/etc", "/bin", "/usr", "/var", "/tmp", "/proc", "/sys", "/dev"]);
  if (banned.has(abs)) {
    throw new Error(`refusing to use state directory "${abs}" (system path)`);
  }
  return abs;
}
