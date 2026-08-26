/**
 * NookBridge Stage 1 — minimal configuration loader.
 *
 * Stage 1 reads ONLY command-line / programmatic overrides; the file
 * loader for production-format configs is a Stage 5+ deliverable.
 *
 * The config surface here mirrors the Stage 1 plan: state directory,
 * SQLite DB path, key-store backend selection, logging level, log
 * redaction fields, and the (optional) endpoint URL used by doctor.
 *
 * `loadConfig` is fail-closed: a path the loader recognises as a
 * system path (see `state-dir.normaliseStateDir`) is rejected with a
 * clear error so a misconfigured deployment cannot end up writing
 * encrypted notes under `/etc`.
 */

import { join, resolve } from "node:path";

import { normaliseStateDir } from "./state-dir.js";

export type LoggerConfig = {
  level: "debug" | "info" | "warn" | "error";
  redactFields: readonly string[];
};

export type DbConfig = {
  path: string;
};

export type KeyStoreConfig = {
  backend: "development-file";
  /**
   * Path used by the development-file backend.  Optional in the type
   * because Stage 5 production backends won't need it.
   */
  devKeyFile?: string;
};

export type NookBridgeConfig = {
  stateDir: string;
  db: DbConfig;
  keyStore: KeyStoreConfig;
  logging: LoggerConfig;
  /**
   * Optional endpoint URL for the doctor network probe.  Non-secret;
   * if absent, the probe is reported as `warn` rather than `pass`.
   */
  endpoint?: string;
};

export type LoadConfigInput = {
  stateDir: string;
  dbPath?: string;
  logging?: Partial<LoggerConfig>;
  endpoint?: string;
  redactFields?: readonly string[];
};

export const DEFAULT_REDACT_FIELDS: readonly string[] = [
  "password",
  "token",
  "secret",
  "key",
  "apikey",
  "body",
  "content",
  "note",
];

export function loadConfig(input: LoadConfigInput): NookBridgeConfig {
  const stateDir = normaliseStateDir(input.stateDir);
  const dbPath = resolve(input.dbPath ?? join(stateDir, "nookbridge.db"));

  // Fail-closed: refuse to use a state dir that resolves outside the
  // configured prefix.  We compare against the actual stateDir the
  // caller requested rather than a blanket-system-list so a
  // legitimate `/tmp/nookbridge-stage1-XXX` test directory is still
  // accepted as the normaliser already vetted it.
  if (!dbPath.startsWith(stateDir)) {
    throw new Error(
      `refusing to use database path "${dbPath}" outside state directory "${stateDir}"`,
    );
  }

  const out: NookBridgeConfig = {
    stateDir,
    db: { path: dbPath },
    keyStore: {
      backend: "development-file",
      devKeyFile: join(stateDir, ".d/db.key"),
    },
    logging: {
      level: input.logging?.level ?? "info",
      redactFields: input.redactFields ?? DEFAULT_REDACT_FIELDS,
    },
  };
  if (input.endpoint !== undefined) {
    out.endpoint = input.endpoint;
  }
  return out;
}
