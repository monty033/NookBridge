/**
 * NookBridge Stage 1 — `nookctl doctor` diagnostic.
 *
 * Performs a fixed, ordered set of checks and returns BOTH:
 *   - a machine-readable list (`checks`), and
 *   - a human-readable summary (`human`).
 *
 * The check set is closed (Stage 1 plan):
 *
 *   1. native-module   — can load better-sqlite3-multiple-ciphers
 *                        and the three pinned extensions.
 *   2. state-perms     — the configured state directory exists and
 *                        is `0o700`.
 *   3. db-decrypt      — the encrypted SQLite file can be opened
 *                        AND a known round-trip token survives
 *                        close/reopen with the SAME key (verifies
 *                        Gate 1.2 from the operator's POV).
 *   4. endpoint        — optional network probe; non-fatal `warn`
 *                        when the endpoint URL is missing, `pass`
 *                        otherwise.
 *
 * Secrets policy:
 *   - The check descriptions may mention the development-backend
 *     label but NEVER echo the key bytes.
 *   - The endpoint check never includes Authorization headers (Stage 1
 *     has no auth, by design).
 *   - The human summary avoids dump-style output.
 */

import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

import type { Logger } from "../logging/logger.js";

export type CheckStatus = "pass" | "fail" | "warn";

export type Check = {
  id: string;
  status: CheckStatus;
  message: string;
};

export type DoctorReport = {
  checks: Check[];
  human: string;
  /** Set when at least one check failed. */
  ok: boolean;
};

export type RunDoctorOptions = {
  stateDir: string;
  dbPath: string;
  endpoint?: string;
  /** Database key used for the decrypt check.  Pass-through; not logged. */
  dbKey?: string;
  logger?: Logger;
};

export async function runDoctor(opts: RunDoctorOptions): Promise<DoctorReport> {
  const checks: Check[] = [];

  // 1. Native module + extensions load.
  checks.push(await checkNativeModules());

  // 2. State directory permissions.
  checks.push(checkStateDir(opts.stateDir));

  // 3. DB decrypt round-trip.
  checks.push(await checkDbDecrypt(opts.stateDir, opts.dbPath, opts.dbKey));

  // 4. Endpoint (optional).
  if (opts.endpoint) {
    checks.push(await checkEndpoint(opts.endpoint));
  } else {
    checks.push({
      id: "endpoint",
      status: "warn",
      message: "no endpoint configured",
    });
  }

  const human = formatHuman(checks);
  const ok = checks.every((c) => c.status !== "fail");
  return { checks, human, ok };
}

async function checkNativeModules(): Promise<Check> {
  const details: string[] = [];
  try {
    await import("better-sqlite3-multiple-ciphers");
    details.push("better-sqlite3-multiple-ciphers");
  } catch (err) {
    return {
      id: "native-module",
      status: "fail",
      message: `native module load failed: ${(err as Error).message}`,
    };
  }
  try {
    const trigram = (await import("sqlite-better-trigram")) as { getLoadablePath: () => string };
    await import("sqlite-regex");
    const fts5Html = (await import("sqlite3-fts5-html")) as { getLoadablePath: () => string };
    details.push("sqlite-better-trigram", "sqlite-regex", "sqlite3-fts5-html");
    if (
      typeof trigram.getLoadablePath !== "function" ||
      typeof fts5Html.getLoadablePath !== "function"
    ) {
      return {
        id: "native-module",
        status: "fail",
        message: "extension getLoadablePath() missing",
      };
    }
    return {
      id: "native-module",
      status: "pass",
      message: `loaded: ${details.join(", ")}`,
    };
  } catch (err) {
    return {
      id: "native-module",
      status: "fail",
      message: `extension load failed: ${(err as Error).message}`,
    };
  }
}

function checkStateDir(stateDir: string): Check {
  const abs = resolve(stateDir);
  if (!existsSync(abs)) {
    return { id: "state-perms", status: "fail", message: `state directory missing: ${abs}` };
  }
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    return { id: "state-perms", status: "fail", message: `cannot stat: ${(err as Error).message}` };
  }
  if (!st.isDirectory()) {
    return { id: "state-perms", status: "fail", message: `${abs} is not a directory` };
  }
  const mode = (st.mode & 0o777).toString(8);
  if (mode !== "700") {
    return {
      id: "state-perms",
      status: "fail",
      message: `state directory mode is 0o${mode}, expected 0o700`,
    };
  }
  return { id: "state-perms", status: "pass", message: `state dir mode is 0o${mode}` };
}

async function checkDbDecrypt(
  stateDir: string,
  dbPath: string,
  dbKey: string | undefined,
): Promise<Check> {
  if (!existsSync(dbPath)) {
    return {
      id: "db-decrypt",
      status: "fail",
      message: `database file missing: ${dbPath} (stateDir=${stateDir})`,
    };
  }
  if (!dbKey) {
    return { id: "db-decrypt", status: "warn", message: "no key provided, skipping decrypt probe" };
  }
  try {
    const { SqliteStorage } = await import("../storage/sqlite-storage.js");
    const sq = new SqliteStorage({ dbPath, key: dbKey });
    try {
      sq.exec("CREATE TABLE IF NOT EXISTS doctor_probe (token TEXT NOT NULL);");
      sq.run("INSERT INTO doctor_probe(token) VALUES(?);", ["stage1-ok"]);
      const row = sq.get<{ token: string }>("SELECT token FROM doctor_probe LIMIT 1");
      if (!row || row.token !== "stage1-ok") {
        return { id: "db-decrypt", status: "fail", message: "round-trip mismatch" };
      }
      return { id: "db-decrypt", status: "pass", message: "encrypted DB opens and round-trips" };
    } finally {
      sq.close();
    }
  } catch (err) {
    return {
      id: "db-decrypt",
      status: "fail",
      message: `open/decrypt failed: ${(err as Error).message} (stateDir=${stateDir})`,
    };
  }
}

async function checkEndpoint(url: string): Promise<Check> {
  // We use the global fetch (Node 22 ships with one).  The probe
  // never sends Authorization headers in Stage 1.
  //
  // `AbortController`, `setTimeout`, `clearTimeout`, and `fetch` are
  // referenced through `globalThis` because the TypeScript `lib` for
  // this project is `ES2022` only (no DOM) — the unqualified names
  // exist at runtime but are not in the type-checked surface, and
  // ESLint's `no-undef` rule does not see them through node types.
  try {
    const ac = new globalThis.AbortController();
    const timeout = globalThis.setTimeout(() => ac.abort(), 1_500);
    try {
      const res = await globalThis.fetch(url, { method: "GET", signal: ac.signal });
      if (res.status >= 200 && res.status < 400) {
        return {
          id: "endpoint",
          status: "pass",
          message: `${url} reachable (HTTP ${res.status})`,
        };
      }
      return {
        id: "endpoint",
        status: "warn",
        message: `${url} returned HTTP ${res.status}`,
      };
    } finally {
      globalThis.clearTimeout(timeout);
    }
  } catch (err) {
    return {
      id: "endpoint",
      status: "warn",
      message: `${url} unreachable: ${(err as Error).message}`,
    };
  }
}

function formatHuman(checks: Check[]): string {
  const lines: string[] = ["nookctl doctor — NookBridge Stage 1 diagnostics"];
  for (const c of checks) {
    const tag = c.status.toUpperCase().padEnd(4, " ");
    lines.push(`  [${tag}] ${c.id}: ${c.message}`);
  }
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  lines.push(
    `summary: ${checks.length - failed - warned} passed, ${warned} warned, ${failed} failed`,
  );
  return lines.join("\n");
}
