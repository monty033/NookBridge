#!/usr/bin/env node
/**
 * NookBridge Stage 1+ — `nookctl` CLI entry point.
 *
 * Stage 1 ships exactly one subcommand: `doctor`.  Auth, sync, and
 * note access are Stage 2+.
 *
 * Stage 2B layers the `auth <subcommand>` plumbing on top of Stage 1.
 * Ordinary `auth login` remains deferred.  The separate operator-only
 * `auth live-login` path is explicitly gated and uses an echo-disabled TTY.
 *
 * Usage:
 *
 *   nookctl doctor [--state-dir <path>] [--endpoint <url>]
 *   nookctl auth login|live-login|status|logout|reset-local-client|help
 *
 * Exit codes:
 *   0  doctor probe all `pass` (warnings allowed); auth deferred or
 *      explicitly gated live-login success
 *   1  doctor probe had any `fail`
 *   2  CLI invocation error (unknown subcommand, bad args)
 *   3  auth credential-collection failure (EOF, malformed, etc.)
 */

import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { runDoctor } from "./doctor/doctor.js";
import { createLogger, DEFAULT_REDACT_FIELDS } from "./logging/logger.js";
import { ensureStateDir } from "./config/state-dir.js";
import { createDevelopmentFileKeyStore } from "./keystore/file-keystore.js";
import { loadConfig } from "./config/config.js";
import { formatAuthHelp, parseAuthCommand, runAuthCommand } from "./auth/admin-command.js";
import { createStdioPrompt } from "./auth/secret-input.js";

type Args = {
  stateDir?: string;
  endpoint?: string;
  authArgs?: readonly string[];
};

function normalizeCliArgv(argv: unknown): string[] {
  if (typeof argv !== "object" || argv === null || !Array.isArray(argv)) {
    throw new Error("invalid CLI input");
  }
  const copied = Array.from(argv as readonly unknown[]);
  if (!copied.every((argument): argument is string => typeof argument === "string")) {
    throw new Error("invalid CLI input");
  }
  return copied;
}

function parseArgs(argv: string[]): { subcommand: string; args: Args } {
  const [, , subcommand, ...rest] = argv;
  const args: Args = {};
  // `auth` is a sealed subcommand tree: its options are parsed by the
  // auth parser, not the top-level one.  Pass `rest` through verbatim
  // so that forbidden flags (e.g. `--password`) reach the auth parser
  // and surface as a parse error rather than being silently consumed.
  if (subcommand === "auth") {
    args.authArgs = rest.slice();
    return { subcommand, args };
  }
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
  let safeArgv: string[];
  try {
    safeArgv = normalizeCliArgv(argv);
  } catch {
    process.stderr.write("nookctl: invalid command input\n");
    return 2;
  }

  let parsed: { subcommand: string; args: Args };
  try {
    parsed = parseArgs(safeArgv);
  } catch {
    process.stderr.write("nookctl: invalid command input\n");
    return 2;
  }
  const { subcommand, args } = parsed;
  const logger = createLogger({ level: "info", redactFields: DEFAULT_REDACT_FIELDS });

  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return 0;
  }
  if (subcommand === "auth") {
    return runAuth(args, logger);
  }
  if (subcommand !== "doctor") {
    process.stderr.write("nookctl: unknown subcommand; use `nookctl help`\n");
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

/**
 * Dispatch the `nookctl auth <subcommand>` plumbing.
 *
 * Ordinary `auth login` is intentionally conservative and resolves to a
 * "deferred" outcome.  `auth live-login` is the sole production exception:
 * it is enabled only by the explicit non-secret environment gate and the
 * exact subcommand, then constructs the local runtime after TTY validation.
 *
 * The prompt and runtime seams are constructed lazily.  This keeps `auth
 * help`, `auth status`, `auth logout`, and ordinary `auth login` usable in
 * non-TTY contexts and ensures forbidden credential carriers are rejected
 * before prompt, state, or core initialization.
 */
async function runAuth(args: Args, logger: ReturnType<typeof createLogger>): Promise<number> {
  const argv = args.authArgs ?? [];
  void logger; // logger retained for future slices that wire persistent state.
  let environment: Record<string, string | undefined>;
  try {
    environment = readSafeEnvSnapshot();
  } catch {
    process.stderr.write("nookctl: invalid command input\n");
    return 2;
  }
  const stateDir = resolve(
    args.stateDir ?? environment["NOOKBRIDGE_STATE_DIR"] ?? join(process.cwd(), "var/state"),
  );
  const result = await runAuthCommand({
    argv,
    env: environment,
    liveLogin: {
      stateDir,
      createPrompt: () => createStdioPrompt(),
      createRuntime: async ({ stateDir: runtimeStateDir }) => {
        const { createProductionLiveLoginRuntime } = await import("./auth/live-login-runtime.js");
        return createProductionLiveLoginRuntime({ stateDir: runtimeStateDir, logger });
      },
    },
  });

  switch (result.kind) {
    case "error":
      process.stderr.write(`nookctl: ${result.message}\n`);
      return result.exitCode;
    case "help":
      process.stdout.write(result.text);
      return 0;
    case "deferred":
      process.stdout.write(
        [
          `nookctl auth ${result.outcome.subcommand}: ${result.outcome.status}`,
          `  ${result.outcome.message}`,
          "",
        ].join("\n"),
      );
      return 0;
    case "exercised-login":
      process.stdout.write(
        [
          `nookctl auth ${result.outcome.subcommand}: ${result.outcome.status}`,
          `  ${result.outcome.message}`,
          "",
        ].join("\n"),
      );
      return 0;
    case "live-login":
      process.stdout.write(
        [
          `nookctl auth ${result.outcome.subcommand}: ${result.outcome.status}`,
          `  ${result.outcome.message}`,
          "",
        ].join("\n"),
      );
      return 0;
  }
}

/**
 * Snapshot the process environment without interpreting or printing any
 * values.  Credential-carrier presence must remain visible to the auth
 * parser so the public CLI rejects it instead of silently dropping it.
 * This is the only path the auth runner uses to read `process.env`; tests
 * can pass their own snapshot.
 *
 * The parser owns the credential-carrier policy.  Keeping this snapshot
 * lossless for names and presence is part of the public CLI boundary:
 * forbidden carriers are rejected with exit code 2, while unrelated
 * variables remain available to future non-secret configuration paths.
 */
const FORBIDDEN_ENV_CARRIERS = new Set([
  "NOOKBRIDGE_EMAIL",
  "NOOKBRIDGE_USERNAME",
  "NOOKBRIDGE_PASSWORD",
  "NOOKBRIDGE_PASSWD",
  "NOOKBRIDGE_MFA",
  "NOOKBRIDGE_TOTP",
  "NOOKBRIDGE_SECRET",
  "NOOKBRIDGE_TOKEN",
  "NOOKBRIDGE_ACCESS_TOKEN",
  "NOOKBRIDGE_REFRESH_TOKEN",
  "NOOKCTL_EMAIL",
  "NOOKCTL_USERNAME",
  "NOOKCTL_PASSWORD",
  "NOOKCTL_MFA",
  "NOOKCTL_TOKEN",
]);

function readSafeEnvSnapshot(): Record<string, string | undefined> {
  try {
    const environment = process.env;
    const out: Record<string, string | undefined> = {};

    // Probe presence before projecting own entries.  `in` intentionally
    // includes inherited carriers; their values are never read or copied.
    for (const name of FORBIDDEN_ENV_CARRIERS) {
      if (name in environment) out[name] = undefined;
    }
    for (const [name, value] of Object.entries(environment)) {
      if (!FORBIDDEN_ENV_CARRIERS.has(name)) out[name] = value;
    }
    return out;
  } catch {
    // The public CLI boundary must not expose process.env proxy/getter
    // failures or their values/cause chains.
    throw new Error("invalid command environment");
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "nookctl — NookBridge Stage 1+ administrative CLI",
      "",
      "Usage:",
      "  nookctl doctor [--state-dir <path>] [--endpoint <url>]",
      "  nookctl auth <login|live-login|status|logout|reset-local-client|help>",
      "",
      "Options:",
      "  --state-dir <path>    where encrypted state lives",
      "  --endpoint <url>      optional network reachability probe",
      "",
      "Subcommands:",
      "  doctor                run the Stage 1 diagnostics",
      "  auth                  Stage 2B admin auth; live-login is explicitly gated",
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
export { formatAuthHelp, parseAuthCommand };
