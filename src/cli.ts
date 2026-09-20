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
 *   nookctl write create|append|update|sync|help
 *   nookctl conflicts list|observe|help
 *
 * Exit codes:
 *   0  doctor probe all `pass` (warnings allowed); auth deferred or
 *      explicitly gated live-login success
 *   1  doctor probe had any `fail`
 *   2  CLI invocation error (unknown subcommand, bad args)
 *   3  auth credential-collection failure (EOF, malformed, etc.)
 */

import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { runDoctor } from "./doctor/doctor.js";
import { createLogger, DEFAULT_REDACT_FIELDS } from "./logging/logger.js";
import { ensureStateDir } from "./config/state-dir.js";
import { createDevelopmentFileKeyStore } from "./keystore/file-keystore.js";
import { loadConfig } from "./config/config.js";
import { formatAuthHelp, parseAuthCommand, runAuthCommand } from "./auth/admin-command.js";
import {
  formatSyncCommandResult,
  formatSyncHelp,
  parseSyncCommand,
  runSyncCommand,
} from "./core/notesnook-sync-admin.js";
import {
  formatWriteCommandResult,
  formatWriteHelp,
  parseWriteCommand,
  runWriteCommand,
} from "./core/notesnook-write-admin.js";
import {
  formatConflictCommandResult,
  formatConflictHelp,
  parseConflictCommand,
  runConflictCommand,
} from "./core/notesnook-conflict-admin.js";
import { createStdioPrompt } from "./auth/secret-input.js";
import {
  formatRecoverCommandResult,
  formatRecoverLocalStateHelp,
  parseRecoverLocalStateCommand,
  runRecoverLocalState,
} from "./operator/recover-local-state.js";
import {
  formatNotesHelp,
  formatNotesResult,
  parseNotesCommand,
  runNotesCommand,
  MAX_NOTES_QUERY_BYTES,
  type NotesCommandRuntime,
} from "./operator/notes-cli.js";
import {
  createProductionLockedNoteProofRuntime,
  formatLockedNoteProof,
  runLockedNoteProof,
} from "./operator/locked-note-proof.js";
import { createNotesUndoSelection } from "./operator/notes-undo-prompt.js";
import {
  createProductionPathDiagnosticRuntime,
  formatPathDiagnostic,
  runPathDiagnostic,
} from "./operator/path-diagnostic.js";
import { runSettingsCommand } from "./operator/settings-cli.js";
import {
  formatTreeHelp,
  formatTreeResult,
  parseTreeCommand,
  runTreeCommand,
  type TreeCommandRuntime,
} from "./operator/tree-cli.js";

type Args = {
  stateDir?: string;
  endpoint?: string;
  authArgs?: readonly string[];
  syncArgs?: readonly string[];
  writeArgs?: readonly string[];
  conflictsArgs?: readonly string[];
  recoverArgs?: readonly string[];
  notesArgs?: readonly string[];
  settingsArgs?: readonly string[];
  treeArgs?: readonly string[];
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
  // `auth`, `sync`, `write`, `conflicts`, and `recover-local-state`
  // are sealed subcommand trees: their options are parsed by the
  // per-subcommand parser, not the top-level one.  Pass `rest`
  // through verbatim so that forbidden flags (e.g. `--password`)
  // reach the subcommand parser and surface as a parse error rather
  // than being silently consumed.
  if (subcommand === "auth") {
    args.authArgs = rest.slice();
    return { subcommand, args };
  }
  if (subcommand === "sync") {
    args.syncArgs = rest.slice();
    return { subcommand, args };
  }
  if (subcommand === "write") {
    args.writeArgs = rest.slice();
    return { subcommand, args };
  }
  if (subcommand === "conflicts") {
    args.conflictsArgs = rest.slice();
    return { subcommand, args };
  }
  if (subcommand === "recover-local-state") {
    args.recoverArgs = rest.slice();
    return { subcommand, args };
  }
  if (subcommand === "notes") {
    args.notesArgs = rest.slice();
    return { subcommand, args };
  }
  if (subcommand === "settings") {
    args.settingsArgs = rest.slice();
    return { subcommand, args };
  }
  if (subcommand === "tree") {
    args.treeArgs = rest.slice();
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
  if (subcommand === "sync") {
    return runSync(args, logger);
  }
  if (subcommand === "write") {
    return runWrite(args, logger);
  }
  if (subcommand === "conflicts") {
    return runConflicts(args);
  }
  if (subcommand === "recover-local-state") {
    return runRecover(args);
  }
  if (subcommand === "notes") {
    return runNotes(args);
  }
  if (subcommand === "settings") {
    return runSettings(args);
  }
  if (subcommand === "tree") {
    return runTree(args);
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

/** Dispatch the settings inspection/editing command tree. */
async function runSettings(args: Args): Promise<number> {
  let environment: Record<string, string | undefined>;
  try {
    environment = readSafeEnvSnapshot();
  } catch {
    process.stderr.write("nookctl settings: invalid command environment\n");
    return 2;
  }
  const result = await runSettingsCommand({ argv: args.settingsArgs ?? [], env: environment });
  if (result.kind === "error") {
    process.stderr.write(`${result.message}\n`);
    return result.exitCode;
  }
  process.stdout.write(result.message.endsWith("\n") ? result.message : `${result.message}\n`);
  return 0;
}

/**
 * Dispatch the bounded operator-only tree without creating state or opening
 * Notesnook. Help and parse failures are runtime-free; list receives the
 * resolved state directory through a per-call factory closure.
 */
async function runTree(args: Args): Promise<number> {
  const rawArgs = args.treeArgs ?? [];
  const commandArgs: string[] = [];
  let stateDir: string | undefined;
  for (let i = 0; i < rawArgs.length; i += 1) {
    const current = rawArgs[i];
    if (current === undefined) {
      process.stderr.write("nookctl tree: invalid command input\n");
      return 2;
    }
    if (current === "--state-dir") {
      const value = rawArgs[i + 1];
      if (value === undefined || value.startsWith("-") || stateDir !== undefined) {
        process.stderr.write("nookctl tree: invalid command input\n");
        return 2;
      }
      stateDir = value;
      i += 1;
      continue;
    }
    commandArgs.push(current);
  }
  let environment: Record<string, string | undefined>;
  try {
    environment = readSafeEnvSnapshot();
  } catch {
    process.stderr.write("nookctl tree: invalid command environment\n");
    return 2;
  }
  const parsed = parseTreeCommand(commandArgs, environment);
  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.message}\n`);
    return parsed.exitCode;
  }
  if (parsed.command.kind === "help") {
    process.stdout.write(formatTreeHelp());
    return 0;
  }
  const effectiveStateDir =
    stateDir ?? environment["NOOKBRIDGE_STATE_DIR"] ?? join(process.cwd(), "var/state");
  const result = await runTreeCommand({
    argv: commandArgs,
    env: environment,
    stateDir: effectiveStateDir,
    createRuntime: async (runtimeStateDir) => {
      const injected = _internal.treeRuntimeFactory;
      if (injected !== undefined) return injected(runtimeStateDir);
      const { createTreeRuntime } = await import("./operator/tree-runtime.js");
      return createTreeRuntime();
    },
  });
  process.stdout.write(formatTreeResult(result));
  return result.kind === "error" ? result.exitCode : 0;
}

/**
 * Run the operator-only locked-note acceptance proof. This command is
 * intentionally outside the public notes parser and never becomes an MCP
 * method. It requires the same non-secret live-sync gate as the existing
 * production operator commands.
 */
async function runLockedNoteProofCommand(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "--path" || typeof argv[1] !== "string") {
    process.stderr.write("nookctl notes locked-note-proof: invalid command input\n");
    return 2;
  }
  if (environment["NOOKBRIDGE_ENABLE_LIVE_SYNC"] !== "1") {
    process.stderr.write(
      "nookctl notes locked-note-proof is disabled; set NOOKBRIDGE_ENABLE_LIVE_SYNC=1\n",
    );
    return 2;
  }

  let cleanup: (() => void | Promise<void>) | undefined;
  try {
    const production = await createProductionLockedNoteProofRuntime(environment);
    cleanup = production.cleanup;
    const report = await runLockedNoteProof(argv[1], production.runtime);
    process.stdout.write(`${formatLockedNoteProof(report)}\n`);
    return report.read === "vault_locked" &&
      report.update === "vault_locked" &&
      report.delete === "vault_locked"
      ? 0
      : 1;
  } catch {
    process.stderr.write("nookctl notes locked-note-proof: service unavailable\n");
    return 3;
  } finally {
    if (cleanup !== undefined) {
      try {
        await cleanup();
      } catch {
        // Keep the operator boundary categorical.
      }
    }
  }
}

async function runPathDiagnosticCommand(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "--path" || argv[1] === undefined) {
    process.stderr.write("nookctl notes path-diagnostic: expected --path <exact path>\n");
    return 2;
  }
  let cleanup: (() => void | Promise<void>) | undefined;
  try {
    const production = await createProductionPathDiagnosticRuntime(environment);
    cleanup = production.cleanup;
    const report = await runPathDiagnostic(argv[1], production.runtime);
    process.stdout.write(`${formatPathDiagnostic(report)}\\n`);
    return report.title === "unavailable" ? 1 : 0;
  } catch {
    process.stderr.write("nookctl notes path-diagnostic: service unavailable\\n");
    return 3;
  } finally {
    if (cleanup !== undefined) {
      try {
        await cleanup();
      } catch {
        // Keep the operator boundary categorical.
      }
    }
  }
}

/**
 * Dispatch the bounded operator notes tree. Help and bare invocation remain
 * runtime-free; valid read-only commands construct the production Notesnook
 * capability only after parsing and bounded stdin validation.
 */
async function runNotes(args: Args): Promise<number> {
  let environment: Record<string, string | undefined>;
  try {
    environment = readSafeEnvSnapshot();
  } catch {
    process.stderr.write("nookctl: invalid command input\n");
    return 2;
  }

  const argv = args.notesArgs ?? [];
  if (argv[0] === "locked-note-proof") {
    return runLockedNoteProofCommand(argv.slice(1), environment);
  }
  if (argv[0] === "path-diagnostic") {
    return runPathDiagnosticCommand(argv.slice(1), environment);
  }
  const parsed = parseNotesCommand(argv, environment);
  if (parsed.kind === "error") {
    process.stderr.write(`nookctl: ${parsed.message}\n`);
    return parsed.exitCode;
  }
  if (parsed.command.kind === "help") {
    process.stdout.write(formatNotesHelp());
    return 0;
  }

  const searchQuery =
    parsed.command.kind === "search" ? readBoundedNotesStdin(MAX_NOTES_QUERY_BYTES) : undefined;
  // `edit` and `undo` deliberately read NOTHING from stdin: the edit body
  // is produced by the operator's editor against a daemon-captured
  // preimage, and an undo is selected by daemon-minted opaque handle.  A
  // stdin read here would both block the command and reintroduce the
  // forbidden body/token transport.
  let cleanup: (() => void | Promise<void>) | undefined;
  const result = await runNotesCommand({
    argv,
    env: environment,
    ...(searchQuery === undefined ? {} : { searchQuery }),
    // A bare `notes undo` selects a daemon-minted operation handle over
    // an interactive terminal.  When either stream is not a TTY the seam
    // reports `{ tty: false }` and the command fails categorical rather
    // than reversing an operation nobody chose.
    interactive: createNotesUndoSelection({
      input: process.stdin,
      output: process.stdout,
    }),
    createRuntime: async () => {
      const injected = _internal.notesRuntimeFactory;
      if (injected !== undefined) return injected();
      const stateDir = resolve(
        environment["NOOKBRIDGE_STATE_DIR"] ?? join(process.cwd(), "var/state"),
      );
      const injectedProduction = _internal.notesProductionRuntimeFactory;
      const production =
        injectedProduction === undefined
          ? await (async () => {
              const { createProductionNotesRuntime } = await import(
                "./operator/notes-production-runtime.js"
              );
              return createProductionNotesRuntime({ environment });
            })()
          : await injectedProduction(stateDir);
      cleanup = production.cleanup;
      return production.runtime;
    },
  });
  try {
    process.stdout.write(formatNotesResult(result));
    if (result.kind === "error") return result.exitCode;
    return result.kind === "invalid-input" ? 2 : 0;
  } finally {
    if (cleanup !== undefined) {
      try {
        await cleanup();
      } catch {
        // Cleanup is deliberately categorical and never changes command output.
      }
    }
  }
}

function readBoundedNotesStdin(maxBytes: number): string | undefined {
  let stat;
  try {
    stat = fstatSync(0);
    if (stat.isCharacterDevice() && process.stdin.isTTY) return undefined;
  } catch {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const remaining = maxBytes - total;
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const read = readSync(0, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      chunks.push(chunk.subarray(0, read));
    }
    if (total === maxBytes) {
      const extra = Buffer.alloc(1);
      if (readSync(0, extra, 0, 1, null) > 0) return undefined;
    }
    if (total === 0) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    return undefined;
  }
}

/**
 * Dispatch the bounded local-state recovery tree without constructing the
 * normal live runtime or creating a missing state directory.
 */
async function runRecover(args: Args): Promise<number> {
  const rawArgs = args.recoverArgs ?? [];
  const commandArgs: string[] = [];
  let stateDir: string | undefined;
  for (let i = 0; i < rawArgs.length; i += 1) {
    const current = rawArgs[i];
    if (current === undefined) {
      process.stderr.write("nookctl: recover-local-state: invalid command input\n");
      return 2;
    }
    if (current === "--state-dir") {
      const value = rawArgs[i + 1];
      if (value === undefined || value.startsWith("-") || stateDir !== undefined) {
        process.stderr.write("nookctl: recover-local-state: invalid command input\n");
        return 2;
      }
      stateDir = value;
      i += 1;
      continue;
    }
    commandArgs.push(current);
  }

  let environment: Record<string, string | undefined>;
  try {
    environment = readSafeEnvSnapshot();
  } catch {
    process.stderr.write("nookctl: recover-local-state: invalid command environment\n");
    return 2;
  }
  const parsed = parseRecoverLocalStateCommand(commandArgs, environment);
  if (parsed.kind === "error") {
    process.stderr.write(`nookctl: ${parsed.message}\n`);
    return parsed.exitCode;
  }
  if (parsed.command.kind === "help") {
    process.stdout.write(formatRecoverLocalStateHelp());
    return 0;
  }

  const effectiveStateDir = resolve(
    stateDir ?? environment["NOOKBRIDGE_STATE_DIR"] ?? join(process.cwd(), "var/state"),
  );
  const dbPath = resolve(join(effectiveStateDir, "nookbridge.db"));
  const dbKey =
    parsed.command.kind === "inspect" || parsed.command.kind === "reinitialize"
      ? readExistingKeyWithoutMutation(resolve(join(effectiveStateDir, ".d/db.key")))
      : undefined;
  const result = await runRecoverLocalState({
    argv: commandArgs,
    env: environment,
    stateDir: effectiveStateDir,
    dbPath,
    ...(dbKey === undefined ? {} : { dbKey }),
  });
  process.stdout.write(`${formatRecoverCommandResult(result)}\n`);
  return result.kind === "error" ? result.exitCode : 0;
}

/** Read an existing development key without mkdir/chmod or following links. */
function readExistingKeyWithoutMutation(keyPath: string): string | undefined {
  let fd = -1;
  try {
    fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 4096) return undefined;
    const bytes = Buffer.alloc(stat.size);
    const read = readSync(fd, bytes, 0, stat.size, 0);
    if (read !== stat.size) return undefined;
    const key = bytes.toString("utf8").trim();
    return key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== -1) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Dispatch the `nookctl conflicts <subcommand>` plumbing.
 *
 * This is a separately named, read-only local-marker observer.  Help and
 * parse failures return before the live runtime is imported.  Observation
 * commands are gated by the exact non-secret opt-in and receive only the
 * narrow observer capability from the production runtime.
 */
async function runConflicts(args: Args): Promise<number> {
  const argv = args.conflictsArgs ?? [];
  let environment: Record<string, string | undefined>;
  try {
    environment = readSafeEnvSnapshot();
  } catch {
    process.stderr.write("nookctl: invalid command input\n");
    return 2;
  }
  if (argv.length === 0) {
    process.stdout.write(formatConflictHelp());
    return 0;
  }
  const parsedForHelp = parseConflictCommand(argv, environment);
  if (parsedForHelp.kind === "parsed" && parsedForHelp.command.kind === "help") {
    process.stdout.write(formatConflictHelp());
    return 0;
  }
  const result = await runConflictCommand({
    argv,
    env: environment,
    createObserverRuntime: async () => {
      const stateDir = resolve(
        environment["NOOKBRIDGE_STATE_DIR"] ?? join(process.cwd(), "var/state"),
      );
      const { createProductionLiveLoginRuntime } = await import("./auth/live-login-runtime.js");
      const runtime = await createProductionLiveLoginRuntime({ stateDir });
      if (runtime.localConflictObserver === undefined) {
        await runtime.cleanup();
        throw new Error("local conflict observer is unavailable");
      }
      return {
        observer: runtime.localConflictObserver,
        cleanup: runtime.cleanup,
      };
    },
  });
  switch (result.kind) {
    case "error":
      process.stderr.write(`nookctl: ${result.message}\n`);
      return result.exitCode;
    case "help":
      process.stdout.write(result.text);
      return 0;
    case "report":
      process.stdout.write(`${formatConflictCommandResult(result)}\n`);
      return 0;
  }
}

/**
 * Dispatch the `nookctl sync <subcommand>` plumbing.
 *
 * The Stage 3 sync tree is gated on `NOOKBRIDGE_ENABLE_LIVE_SYNC=1`.
 * The CLI constructs the production runtime lazily only after the
 * parser and explicit sync gate have passed.  The runtime exposes a
 * flattened read-only handle and owns teardown; the command runner
 * awaits that teardown on every path.
 *
 * The runner itself is the boundary: it never accepts argv / env
 * values for credentials (the parser rejects forbidden carriers
 * before they reach the runner), and the report it returns is
 * already redacted to categorical step outcomes.
 */
async function runSync(args: Args, logger: ReturnType<typeof createLogger>): Promise<number> {
  void logger;
  const argv = args.syncArgs ?? [];
  let environment: Record<string, string | undefined>;
  try {
    environment = readSafeEnvSnapshot();
  } catch {
    process.stderr.write("nookctl: invalid command input\n");
    return 2;
  }
  // Honour `nookctl sync help` so the operator can render the help
  // text without needing the live-sync gate.  We do this BEFORE the
  // parser so an operator who only wants the help text never trips
  // the gate.
  if (argv.length === 0) {
    process.stdout.write(formatSyncHelp());
    return 0;
  }
  // Parse-only path: when the operator asks for `help`, render it
  // without requiring the gate.  This avoids a confusing "sync
  // help is disabled" message when the operator only wants the
  // help text.
  const parsedForHelp = parseSyncCommand(argv, environment);
  if (parsedForHelp.kind === "parsed" && parsedForHelp.command.kind === "help") {
    process.stdout.write(formatSyncHelp());
    return 0;
  }
  const stateDir = resolve(environment["NOOKBRIDGE_STATE_DIR"] ?? join(process.cwd(), "var/state"));
  const result = await runSyncCommand({
    argv,
    env: environment,
    createProofRuntime: async () => {
      const { createProductionLiveLoginRuntime } = await import("./auth/live-login-runtime.js");
      const runtime = await createProductionLiveLoginRuntime({ stateDir, logger });
      if (runtime.readOnly === undefined) {
        await runtime.cleanup();
        throw new Error("read-only runtime surface is unavailable");
      }
      return { source: runtime.readOnly, cleanup: runtime.cleanup };
    },
  });
  switch (result.kind) {
    case "error":
      process.stderr.write(`nookctl: ${result.message}\n`);
      return result.exitCode;
    case "help":
      process.stdout.write(result.text);
      return 0;
    case "report":
      process.stdout.write(`${formatSyncCommandResult(result)}\n`);
      return result.report.kind === "pass" ? 0 : 1;
  }
}

/**
 * Dispatch the `nookctl write <subcommand>` plumbing.
 *
 * This is a SEPARATE subcommand tree from `sync`; the Stage 3 `sync
 * read-only` path is unchanged and remains fetch-only.
 *
 * The write tree is gated on `NOOKBRIDGE_ENABLE_LIVE_SYNC=1`.  The
 * production write runtime is constructed lazily and ONLY after the
 * parser, the credential-carrier policy, and the gate have all
 * passed — the runner owns that ordering, so the dynamic import
 * below never runs for a disabled or malformed invocation.
 *
 * The runtime exposes a separately named `localWrite` capability and
 * owns its own teardown; the runner awaits that teardown on every
 * path.  A successful write is reported as local-committed and
 * remote-pending; local write dispatch never triggers remote synchronization.
 */
async function runWrite(args: Args, _logger: ReturnType<typeof createLogger>): Promise<number> {
  const argv = args.writeArgs ?? [];
  let environment: Record<string, string | undefined>;
  try {
    environment = readSafeEnvSnapshot();
  } catch {
    process.stderr.write("nookctl: invalid command input\n");
    return 2;
  }
  // Honour `nookctl write` / `nookctl write help` without the gate so an
  // operator who only wants the help text never trips it.
  if (argv.length === 0) {
    process.stdout.write(formatWriteHelp());
    return 0;
  }
  const parsedForHelp = parseWriteCommand(argv, environment);
  if (parsedForHelp.kind === "parsed" && parsedForHelp.command.kind === "help") {
    process.stdout.write(formatWriteHelp());
    return 0;
  }
  const stateDir = resolve(environment["NOOKBRIDGE_STATE_DIR"] ?? join(process.cwd(), "var/state"));
  const result = await runWriteCommand({
    argv,
    env: environment,
    createWriteRuntime: async () => {
      const { createProductionLiveLoginRuntime } = await import("./auth/live-login-runtime.js");
      const runtime = await createProductionLiveLoginRuntime({ stateDir });
      if (runtime.localWrite === undefined) {
        await runtime.cleanup();
        throw new Error("local write capability is unavailable");
      }
      return {
        capability: runtime.localWrite,
        ...(runtime.remoteSync === undefined ? {} : { remoteSync: runtime.remoteSync }),
        cleanup: runtime.cleanup,
      };
    },
  });
  switch (result.kind) {
    case "error":
      process.stderr.write(`nookctl: ${result.message}\n`);
      return result.exitCode;
    case "help":
      process.stdout.write(result.text);
      return 0;
    case "report":
      process.stdout.write(`${formatWriteCommandResult(result)}\n`);
      return 0;
    case "sync-report":
      process.stdout.write(`${formatWriteCommandResult(result)}\n`);
      return result.report.status === "failed" ? 1 : 0;
  }
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
    case "auth-state":
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
      "  nookctl sync <status|read-only|help>",
      "  nookctl write <create|append|update|sync|help>",
      "  nookctl conflicts <list|observe|help>",
      "  nookctl notes <help|browse|search|get|edit|undo>",
      "  nookctl settings <show|validate|edit|reset|help>",
      "  nookctl tree <help|list>",
      "",
      "Options:",
      "  --state-dir <path>    where encrypted state lives",
      "  --endpoint <url>      optional network reachability probe",
      "",
      "Subcommands:",
      "  doctor                run the Stage 1 diagnostics",
      "  auth                  Stage 2B admin auth; live-login is explicitly gated",
      "  sync                  Stage 3 read-only sync; live commands are explicitly gated",
      "  write                 Stage 4 local write acceptance; explicitly gated, local-only",
      "  conflicts             Stage 5 local conflict-marker observation; explicitly gated, read-only",
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
export const _internal: {
  readonly dirname: typeof dirname;
  readonly join: typeof join;
  notesRuntimeFactory?: () => NotesCommandRuntime | Promise<NotesCommandRuntime>;
  notesProductionRuntimeFactory?: (stateDir: string) => Promise<{
    runtime: NotesCommandRuntime;
    cleanup: () => void | Promise<void>;
  }>;
  treeRuntimeFactory?: (stateDir: string) => TreeCommandRuntime | Promise<TreeCommandRuntime>;
} = { dirname, join };
export { formatAuthHelp, parseAuthCommand };
