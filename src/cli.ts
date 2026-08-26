#!/usr/bin/env node
/**
 * NookBridge Stage 1 — `nookctl` CLI entry point.
 *
 * Stage 1 ships exactly one subcommand: `doctor`.  Auth, sync, and
 * note access are Stage 2+.
 *
 * Usage:
 *
 *   nookctl doctor [--state-dir <path>] [--endpoint <url>]
 *
 * Exit codes:
 *   0  doctor probe all `pass` (warnings allowed)
 *   1  doctor probe had any `fail`
 *   2  CLI invocation error (unknown subcommand, bad args)
 */

import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { runDoctor } from "./doctor/doctor.js";
import { createLogger, DEFAULT_REDACT_FIELDS } from "./logging/logger.js";
import { ensureStateDir } from "./config/state-dir.js";
import { createDevelopmentFileKeyStore } from "./keystore/file-keystore.js";
import { loadConfig } from "./config/config.js";

type Args = {
  stateDir?: string;
  endpoint?: string;
};

function parseArgs(argv: string[]): { subcommand: string; args: Args } {
  const [, , subcommand, ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const cur = rest[i];
    const next = rest[i + 1];
    if (cur === "--state-dir" && next) {
      args.stateDir = next;
      i++;
    } else if (cur === "--endpoint" && next) {
      args.endpoint = next;
      i++;
    }
  }
  return { subcommand: subcommand ?? "help", args };
}

export async function run(argv: string[]): Promise<number> {
  const { subcommand, args } = parseArgs(argv);
  const logger = createLogger({ level: "info", redactFields: DEFAULT_REDACT_FIELDS });

  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return 0;
  }
  if (subcommand !== "doctor") {
    process.stderr.write(`nookctl: unknown subcommand "${subcommand}"\n`);
    printHelp();
    return 2;
  }

  // State directory: CLI override > $NOOKBRIDGE_STATE_DIR > ./var/state.
  const stateDir = resolve(
    args.stateDir ?? process.env["NOOKBRIDGE_STATE_DIR"] ?? join(process.cwd(), "var/state"),
  );
  ensureStateDir(stateDir);

  const cfg = loadConfig(
    args.endpoint !== undefined ? { stateDir, endpoint: args.endpoint } : { stateDir },
  );
  const keyFile = cfg.keyStore.devKeyFile
    ? resolve(cfg.keyStore.devKeyFile)
    : resolve(join(stateDir, ".d/db.key"));
  const keys = createDevelopmentFileKeyStore({ keyPath: keyFile });
  const key = keys.getDatabaseKey();

  const doctorOpts: Parameters<typeof runDoctor>[0] = {
    stateDir: cfg.stateDir,
    dbPath: cfg.db.path,
    logger,
  };
  if (key !== undefined) {
    doctorOpts.dbKey = key;
  }
  if (cfg.endpoint !== undefined) {
    doctorOpts.endpoint = cfg.endpoint;
  }
  const report = await runDoctor(doctorOpts);

  process.stdout.write(report.human + "\n");
  if (!report.ok) return 1;
  return 0;
}

function printHelp(): void {
  process.stdout.write(
    [
      "nookctl — NookBridge Stage 1 administrative CLI",
      "",
      "Usage:",
      "  nookctl doctor [--state-dir <path>] [--endpoint <url>]",
      "",
      "Options:",
      "  --state-dir <path>    where encrypted state lives",
      "  --endpoint <url>      optional network reachability probe",
      "",
      "Subcommands:",
      "  doctor                run the Stage 1 diagnostics",
      "  help                  show this help",
      "",
    ].join("\n"),
  );
}

// CLI entry-point.
if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv).then((code) => {
    process.exit(code);
  });
}

// Convenience re-export for tests that exercise the CLI in-process
// without spawning a child process.
export const _internal = { dirname, join };
