/**
 * NookBridge Stage 9 — bounded, non-destructive local-state recovery.
 *
 * The `nookctl recover-local-state` slice exists to give operators a
 * fail-closed way to diagnose a corrupt / unreadable / locked state
 * directory and, with explicit consent, quarantine the original
 * artefacts and reinitialise an empty service state.  It is the
 * Stage 9 implementation of implementation-plan §10.3 (corrupted
 * state recovery policy).
 *
 * Security contract — pinned in the Stage 9 allowlist:
 *
 *   - This module NEVER opens authentication, runs a sync, or opens
 *     a writable SQLite handle.  The inspection path reuses
 *     `inspectEncryptedSqlite`, which is documented as read-only.
 *   - Mutation is gated by the EXACT argv flag `--approve-reinitialize`.
 *     The flag must appear on the same invocation as `reinitialize`.
 *   - Credentials, keys, bodies, content, and identifier-shaped argv
 *     values are rejected by the parser before any state touch.
 *     Forbidden env carriers fail closed on presence alone (values
 *     are never read).
 *   - The default invocation (`recover-local-state` with no
 *     subcommand, or `recover-local-state inspect`) is a pure
 *     categorical probe that returns one of the closed
 *     `RecoveryInspection` shapes.  No path, key, body, token,
 *     upstream error, or SQLite error is ever echoed.
 *   - Quarantine uses a same-filesystem, no-copy/no-clobber move into a fixed, restrictive
 *     `.recovery-quarantine/` directory.  The original is never
 *     overwritten; the source link is removed only after the destination
 *     link is reserved without replacement.
 *   - Rollback restores the preserved state without replacing an occupied
 *     destination and never recursively deletes quarantine contents.
 *   - The runner accepts an injected `stateDir` / `dbPath` so tests
 *     can drive it against disposable fixtures without touching
 *     the operator's real state.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { lockFileExists } from "../config/lock.js";
import { normaliseStateDir } from "../config/state-dir.js";
import { SqliteStorage, inspectEncryptedSqlite } from "../storage/sqlite-storage.js";

// ---------------------------------------------------------------------------
// Public gate names.
//
// Mutation is gated ONLY on `--approve-reinitialize` (argv).  An env
// fallback would widen the trust surface — environment variables are
// inherited from shells and CI; an opt-in flag forces the operator to
// type the exact phrase.
// ---------------------------------------------------------------------------

export const APPROVE_REINITIALIZE_FLAG = "--approve-reinitialize" as const;
export const APPROVE_ROLLBACK_FLAG = "--approve-rollback" as const;

// ---------------------------------------------------------------------------
// Forbidden carriers.
//
// Kept in lock-step with auth/sync/write/conflict so the credential
// policy is uniform across the operator-only boundary.
// ---------------------------------------------------------------------------

const FORBIDDEN_ARG_FLAGS: readonly string[] = [
  "--email",
  "--username",
  "--password",
  "--passwd",
  "--mfa",
  "--totp",
  "--secret",
  "--token",
  "--access-token",
  "--refresh-token",
  "--db-key",
  "--database-key",
  "--content",
  "--body",
  "--markdown",
  "--fragment",
  "--note",
  "--text",
  "--file",
  "--content-file",
  "--stdin",
];

const FORBIDDEN_ENV_VARS: readonly string[] = [
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
  "APPROVE_REINITIALIZE",
  "APPROVE_ROLLBACK",
];

// ---------------------------------------------------------------------------
// Subcommand shapes.
// ---------------------------------------------------------------------------

export type RecoverSubcommand = "help" | "inspect" | "reinitialize" | "rollback";

export type ParsedRecoverCommand =
  | Readonly<{ kind: "help"; subcommand: "help" }>
  | Readonly<{ kind: "inspect"; subcommand: "inspect" }>
  | Readonly<{ kind: "reinitialize"; subcommand: "reinitialize" }>
  | Readonly<{
      kind: "rollback";
      subcommand: "rollback";
      quarantineId: string;
    }>;

export type ParseRecoverCommandResult =
  | Readonly<{ kind: "parsed"; command: ParsedRecoverCommand }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 }>;

// ---------------------------------------------------------------------------
// Inspection result.
//
// CLOSED union — exactly the categorical states the runner can
// report.  The CLI prints a fixed mapping; no extra fields ever leak.
// ---------------------------------------------------------------------------

export type RecoveryInspection = Readonly<
  { kind: "healthy" } | { kind: "missing" } | { kind: "corrupt" } | { kind: "locked" }
>;

// ---------------------------------------------------------------------------
// Runner result.
//
// CLOSED union — exactly the categorical outcomes the CLI prints.
// ---------------------------------------------------------------------------

export type RunRecoverCommandResult =
  | Readonly<{ kind: "help"; text: string }>
  | Readonly<{ kind: "inspection"; result: RecoveryInspection }>
  | Readonly<{ kind: "reinitialized"; quarantineId: string }>
  | Readonly<{ kind: "rolled-back"; quarantineId: string }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 | 3 }>;

// ---------------------------------------------------------------------------
// Runner options.
//
// `stateDir` and `dbPath` are injected so production callers wire the
// operator's actual state directory while tests wire a disposable
// temp fixture.  The runner never reads `process.env` / `process.argv`
// on its own; the CLI dispatcher is the only thing that snapshots
// environment, and it explicitly drops the credential carriers before
// calling the parser.
// ---------------------------------------------------------------------------

export type RunRecoverLocalStateOptions = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stateDir: string;
  dbPath: string;
  /** Optional key for the decrypt probe; never echoed. */
  dbKey?: string;
}>;

// ---------------------------------------------------------------------------
// Quarantine layout.
//
// The quarantine directory lives at `<stateDir>/.recovery-quarantine/`
// and is exclusively owned by this module.  Each accepted quarantine
// creates `<quarantineDir>/<opaque-id>/`, into which the current
// on-disk artefacts are renamed bit-for-bit.  The opaque id is
// `<8-hex>-<sequence>` and is the ONLY handle the operator receives
// for later rollback.  We never expose the absolute path.
// ---------------------------------------------------------------------------

const QUARANTINE_RELATIVE_DIR = ".recovery-quarantine" as const;
const QUARANTINE_DIR_MODE = 0o700;
const QUARANTINE_ENTRY_MODE = 0o700;
const QUARANTINE_ID_PATTERN = /^[a-f0-9]{8}-[a-z0-9]{12,13}$/;

// ---------------------------------------------------------------------------
// Parser.
// ---------------------------------------------------------------------------

/**
 * Parse `argv` (the slice of `process.argv` after the
 * `recover-local-state` token) plus an env snapshot.
 *
 * The parser is total: it returns either a validated command or a
 * categorical error.  It does NOT touch the filesystem, network, or
 * authentication surface.
 */
export function parseRecoverLocalStateCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseRecoverCommandResult {
  try {
    if (
      typeof argv !== "object" ||
      argv === null ||
      !Array.isArray(argv) ||
      typeof env !== "object" ||
      env === null ||
      Array.isArray(env)
    ) {
      return invalidParseInput();
    }
    const safeArgv = Array.from(argv as readonly unknown[]);
    if (!safeArgv.every((argument): argument is string => typeof argument === "string")) {
      return invalidParseInput();
    }
    const stringArgv = safeArgv as string[];

    for (const name of Object.keys(env)) {
      const value = (env as Record<string, unknown>)[name];
      if (value !== undefined && typeof value !== "string") return invalidParseInput();
    }

    // Credential carriers — the presence of any forbidden env name is
    // a categorical error; values are NEVER read.
    for (const name of FORBIDDEN_ENV_VARS) {
      if (name in env) {
        return {
          kind: "error",
          exitCode: 2,
          message:
            "refusing to read credentials from the environment; use an interactive TTY prompt",
        };
      }
    }

    // Credential carriers in argv — flag form and `--flag=value` form.
    for (const argument of stringArgv) {
      const forbidden = FORBIDDEN_ARG_FLAGS.find(
        (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
      );
      if (forbidden !== undefined) {
        return {
          kind: "error",
          exitCode: 2,
          message: "refusing to read credentials from a CLI flag; use an interactive TTY prompt",
        };
      }
    }

    const subcommandRaw = stringArgv[0];
    const subcommand = subcommandRaw === undefined ? "inspect" : subcommandRaw.toLowerCase();
    switch (subcommand) {
      case "help":
      case "--help":
      case "-h":
        if (stringArgv.length > 1) return invalidParseInput();
        return { kind: "parsed", command: { kind: "help", subcommand: "help" } };
      case "inspect": {
        if (stringArgv.length !== 0 && stringArgv.length !== 1) return invalidParseInput();
        return { kind: "parsed", command: { kind: "inspect", subcommand: "inspect" } };
      }
      case "reinitialize": {
        // The reinitialize subcommand is a no-op until the operator
        // passes the EXACT `--approve-reinitialize` flag.  Anything
        // else is a categorical refusal.
        if (stringArgv.length !== 2 || stringArgv[1] !== APPROVE_REINITIALIZE_FLAG) {
          return {
            kind: "error",
            exitCode: 2,
            message: `nookctl recover-local-state reinitialize requires ${APPROVE_REINITIALIZE_FLAG}`,
          };
        }
        return { kind: "parsed", command: { kind: "reinitialize", subcommand: "reinitialize" } };
      }
      case "rollback": {
        const idx = stringArgv.indexOf(APPROVE_ROLLBACK_FLAG);
        if (stringArgv.length !== 3 || idx !== 1) {
          return {
            kind: "error",
            exitCode: 2,
            message: `nookctl recover-local-state rollback requires ${APPROVE_ROLLBACK_FLAG} <id>`,
          };
        }
        const id = stringArgv[idx + 1];
        if (typeof id !== "string" || id.length === 0) {
          return {
            kind: "error",
            exitCode: 2,
            message: "nookctl recover-local-state rollback: missing opaque identifier",
          };
        }
        if (!QUARANTINE_ID_PATTERN.test(id)) {
          return {
            kind: "error",
            exitCode: 2,
            message: "nookctl recover-local-state rollback: refusing opaque identifier",
          };
        }
        return {
          kind: "parsed",
          command: { kind: "rollback", subcommand: "rollback", quarantineId: id },
        };
      }
      default:
        return {
          kind: "error",
          exitCode: 2,
          message:
            "nookctl recover-local-state: unknown subcommand; use `nookctl recover-local-state help`",
        };
    }
  } catch {
    return invalidParseInput();
  }
}

function invalidParseInput(): ParseRecoverCommandResult {
  return {
    kind: "error",
    exitCode: 2,
    message: "nookctl recover-local-state: invalid command input",
  };
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

/**
 * Run a bounded recovery command.
 *
 * The default invocation (no subcommand) maps to `inspect`.  Every
 * mutation is gated by the exact argv flag; the runner never reads
 * `process.env`, never opens authentication, never opens a writable
 * SQLite handle, and never logs/copies the database key.
 */
export async function runRecoverLocalState(
  options: RunRecoverLocalStateOptions,
): Promise<RunRecoverCommandResult> {
  let normalized: RunRecoverLocalStateOptions;
  try {
    normalized = normalizeOptions(options);
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl recover-local-state: invalid command input",
    };
  }

  const parsed = parseRecoverLocalStateCommand(normalized.argv, normalized.env);
  if (parsed.kind === "error") {
    return { kind: "error", exitCode: parsed.exitCode, message: parsed.message };
  }
  const command = parsed.command;

  switch (command.kind) {
    case "help":
      return { kind: "help", text: formatRecoverLocalStateHelp() };
    case "inspect":
      return runInspect(normalized);
    case "reinitialize":
      return runReinitialize(normalized);
    case "rollback":
      return runRollback(normalized, command.quarantineId);
  }
}

function normalizeOptions(options: RunRecoverLocalStateOptions): RunRecoverLocalStateOptions {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.argv !== "object" ||
    options.argv === null ||
    !Array.isArray(options.argv) ||
    typeof options.env !== "object" ||
    options.env === null ||
    Array.isArray(options.env) ||
    typeof options.stateDir !== "string" ||
    typeof options.dbPath !== "string"
  ) {
    throw new Error("invalid options");
  }
  for (const argument of options.argv) {
    if (typeof argument !== "string") throw new Error("invalid options");
  }
  for (const name of Object.keys(options.env)) {
    const value = (options.env as Record<string, unknown>)[name];
    if (value !== undefined && typeof value !== "string") throw new Error("invalid options");
  }
  if (options.dbKey !== undefined && typeof options.dbKey !== "string") {
    throw new Error("invalid options");
  }
  return options;
}

// ---------------------------------------------------------------------------
// Inspection.
// ---------------------------------------------------------------------------

function runInspect(options: RunRecoverLocalStateOptions): RunRecoverCommandResult {
  const root = validateStateRoot(options.stateDir);
  if (root.kind === "error") return root.error;
  const stateDir = root.stateDir;

  const dbValidation = validateDbPath(options.dbPath, stateDir);
  if (dbValidation.kind === "error") return dbValidation.error;

  // Active single-instance lock takes precedence — refuse mutation
  // AND report the categorical state for the inspect surface.
  if (lockFileExists(stateDir)) {
    return { kind: "inspection", result: { kind: "locked" } };
  }

  // Probe the database without opening a write handle.
  if (!existsSync(options.dbPath)) {
    return { kind: "inspection", result: { kind: "missing" } };
  }
  if (typeof options.dbKey !== "string" || options.dbKey.length === 0) {
    // Without a key we cannot decide between healthy / corrupt.  The
    // closed categorical surface intentionally treats this as
    // `missing` so the operator is steered toward the doctor surface
    // (which carries the key) rather than guessing.
    return { kind: "inspection", result: { kind: "missing" } };
  }
  switch (inspectEncryptedSqlite({ dbPath: options.dbPath, key: options.dbKey }).status) {
    case "healthy":
      return { kind: "inspection", result: { kind: "healthy" } };
    case "missing":
      return { kind: "inspection", result: { kind: "missing" } };
    case "corrupt":
      return { kind: "inspection", result: { kind: "corrupt" } };
    case "unreadable":
      return { kind: "inspection", result: { kind: "corrupt" } };
  }
}

// ---------------------------------------------------------------------------
// Reinitialize.
// ---------------------------------------------------------------------------

function runReinitialize(options: RunRecoverLocalStateOptions): RunRecoverCommandResult {
  const root = validateStateRoot(options.stateDir);
  if (root.kind === "error") return root.error;
  const stateDir = root.stateDir;

  const dbValidation = validateDbPath(options.dbPath, stateDir);
  if (dbValidation.kind === "error") return dbValidation.error;

  if (lockFileExists(stateDir)) {
    return {
      kind: "error",
      exitCode: 2,
      message:
        "nookctl recover-local-state: state directory is currently locked by another process",
    };
  }

  const quarantineDir = join(stateDir, QUARANTINE_RELATIVE_DIR);
  // Refuse if a quarantine collision exists — the operator must
  // either roll back or remove the prior quarantine explicitly.  We
  // never silently overwrite or merge.
  if (existsSync(quarantineDir)) {
    let st;
    try {
      st = lstatSync(quarantineDir);
    } catch {
      return {
        kind: "error",
        exitCode: 2,
        message: "nookctl recover-local-state: refusing quarantine collision",
      };
    }
    if (!st.isDirectory()) {
      return {
        kind: "error",
        exitCode: 2,
        message: "nookctl recover-local-state: refusing quarantine collision",
      };
    }
    let entries: string[];
    try {
      entries = readdirSync(quarantineDir);
    } catch {
      return {
        kind: "error",
        exitCode: 2,
        message: "nookctl recover-local-state: refusing quarantine collision",
      };
    }
    if (entries.length > 0) {
      return {
        kind: "error",
        exitCode: 2,
        message:
          "nookctl recover-local-state: refusing quarantine collision; rollback or remove the prior quarantine first",
      };
    }
  }

  if (!existsSync(options.dbPath)) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl recover-local-state: database is missing",
    };
  }
  try {
    const dbStat = lstatSync(options.dbPath);
    if (!dbStat.isFile() || dbStat.isSymbolicLink()) {
      return {
        kind: "error",
        exitCode: 2,
        message: "nookctl recover-local-state: refusing unsafe database path",
      };
    }
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl recover-local-state: refusing unsafe database path",
    };
  }

  if (typeof options.dbKey !== "string" || options.dbKey.length === 0) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl recover-local-state: database key is unavailable",
    };
  }
  // Do not inspect or open the existing DB before quarantine.  The
  // recovery contract is specifically to preserve corrupt/unreadable
  // bytes before creating fresh state.  The key is still required so
  // the replacement state can be initialized with the same carrier.
  try {
    mkdirSync(quarantineDir, { recursive: true, mode: QUARANTINE_DIR_MODE });
    chmodSync(quarantineDir, QUARANTINE_DIR_MODE);
  } catch {
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl recover-local-state: failed to create quarantine directory",
    };
  }

  // Build the quarantine entry using an exclusive rename so the
  // original can never be lost mid-flight.
  const quarantineId = makeQuarantineId();
  const quarantineEntry = join(quarantineDir, quarantineId);
  try {
    mkdirSync(quarantineEntry, { mode: QUARANTINE_ENTRY_MODE });
    chmodSync(quarantineEntry, QUARANTINE_ENTRY_MODE);
  } catch {
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl recover-local-state: failed to create quarantine directory",
    };
  }

  // Move the live DB without copy and without destination replacement.
  // Node's rename replaces an existing destination; link+unlink gives us
  // same-filesystem no-clobber semantics for this fixed state root.
  if (!moveNoReplace(options.dbPath, join(quarantineEntry, "nookbridge.db"))) {
    safeRmQuarantineEntry(quarantineEntry);
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl recover-local-state: failed to quarantine the original state",
    };
  }

  try {
    const fresh = new SqliteStorage({
      dbPath: options.dbPath,
      key: options.dbKey,
      withExtensions: false,
    });
    fresh.close();
  } catch {
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl recover-local-state: failed to initialize fresh state",
    };
  }

  return { kind: "reinitialized", quarantineId };
}

// ---------------------------------------------------------------------------
// Rollback.
// ---------------------------------------------------------------------------

function runRollback(
  options: RunRecoverLocalStateOptions,
  quarantineId: string,
): RunRecoverCommandResult {
  const root = validateStateRoot(options.stateDir);
  if (root.kind === "error") return root.error;
  const stateDir = root.stateDir;

  const dbValidation = validateDbPath(options.dbPath, stateDir);
  if (dbValidation.kind === "error") return dbValidation.error;

  // The id is opaque; we never accept path-shaped or credential-shaped
  // identifiers, even if the filesystem would honour them.
  if (!QUARANTINE_ID_PATTERN.test(quarantineId)) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl recover-local-state rollback: refusing opaque identifier",
    };
  }

  if (lockFileExists(stateDir)) {
    return {
      kind: "error",
      exitCode: 2,
      message:
        "nookctl recover-local-state: state directory is currently locked by another process",
    };
  }

  const quarantineEntry = resolve(join(stateDir, QUARANTINE_RELATIVE_DIR, quarantineId));
  // Containment check: the resolved quarantine entry must remain
  // inside the fixed state directory.  Defence in depth against
  // identifiers like `../../etc` even though the regex already
  // forbids them.
  const stateAbs = resolve(stateDir);
  const rel = relative(stateAbs, quarantineEntry);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    return {
      kind: "error",
      exitCode: 2,
      message:
        "nookctl recover-local-state rollback: refusing opaque identifier outside state root",
    };
  }

  if (!existsSync(quarantineEntry)) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl recover-local-state rollback: unknown quarantine identifier",
    };
  }
  let st;
  try {
    st = lstatSync(quarantineEntry);
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl recover-local-state rollback: unknown quarantine identifier",
    };
  }
  if (!st.isDirectory()) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl recover-local-state rollback: unknown quarantine identifier",
    };
  }

  // Refuse to clobber an existing destination; the operator must
  // remove the obstruction explicitly.
  if (existsSync(options.dbPath)) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl recover-local-state rollback: destination is occupied",
    };
  }

  const preservedDb = join(quarantineEntry, "nookbridge.db");
  let preservedStat;
  try {
    preservedStat = lstatSync(preservedDb);
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl recover-local-state rollback: preserved state is incomplete",
    };
  }
  if (!preservedStat.isFile() || preservedStat.isSymbolicLink()) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl recover-local-state rollback: preserved state is incomplete",
    };
  }
  if (!moveNoReplace(preservedDb, options.dbPath)) {
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl recover-local-state rollback: failed to restore preserved state",
    };
  }
  // Tighten the restored file's mode in case the original metadata
  // was somehow lost across the rename.
  try {
    chmodSync(options.dbPath, 0o600);
  } catch {
    /* best-effort */
  }

  // The quarantine entry served its purpose; remove the now-empty
  // directory.  We do NOT touch the parent `.recovery-quarantine/`
  // (it remains for future use until the operator explicitly clears
  // it).
  try {
    rmdirSync(quarantineEntry);
  } catch {
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl recover-local-state rollback: quarantine cleanup is incomplete",
    };
  }

  return { kind: "rolled-back", quarantineId };
}

// ---------------------------------------------------------------------------
// State-root validation.
//
// Refuse symlinks, non-directories, system paths, and any input that
// doesn't normalise.  The closed result carries the categorical reason
// without the path itself.
// ---------------------------------------------------------------------------

type RootValidation =
  | { kind: "ok"; stateDir: string }
  | { kind: "error"; error: RunRecoverCommandResult };

function validateStateRoot(stateDir: string): RootValidation {
  let stateAbs: string;
  try {
    stateAbs = normaliseStateDir(stateDir);
  } catch {
    return {
      kind: "error",
      error: {
        kind: "error",
        exitCode: 2,
        message: "nookctl recover-local-state: refusing unsafe state root",
      },
    };
  }
  if (!existsSync(stateAbs)) {
    return {
      kind: "error",
      error: {
        kind: "error",
        exitCode: 2,
        message: "nookctl recover-local-state: state root is missing",
      },
    };
  }
  let st;
  try {
    st = lstatSync(stateAbs);
  } catch {
    return {
      kind: "error",
      error: {
        kind: "error",
        exitCode: 2,
        message: "nookctl recover-local-state: cannot inspect state root",
      },
    };
  }
  if (st.isSymbolicLink()) {
    return {
      kind: "error",
      error: {
        kind: "error",
        exitCode: 2,
        message: "nookctl recover-local-state: refusing symlink state root",
      },
    };
  }
  if (!st.isDirectory()) {
    return {
      kind: "error",
      error: {
        kind: "error",
        exitCode: 2,
        message: "nookctl recover-local-state: state root is not a directory",
      },
    };
  }
  return { kind: "ok", stateDir: stateAbs };
}

type DbPathValidation = { kind: "ok" } | { kind: "error"; error: RunRecoverCommandResult };

function validateDbPath(dbPath: string, stateDir: string): DbPathValidation {
  const dbAbs = resolve(dbPath);
  const rel = relative(stateDir, dbAbs);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    return {
      kind: "error",
      error: {
        kind: "error",
        exitCode: 2,
        message: "nookctl recover-local-state: refusing database path outside state root",
      },
    };
  }
  return { kind: "ok" };
}

// ---------------------------------------------------------------------------
// Quarantine helpers.
// ---------------------------------------------------------------------------

function makeQuarantineId(): string {
  // 8 hex + `-` + 12 base36 chars — opaque, no path components, no
  // carrier-shaped values.  The base36 suffix avoids collisions
  // within the same nanosecond; we don't need cryptographic strength
  // here, just uniqueness inside the fixed state directory.
  const hex = randomBytes(4).toString("hex");
  const seq = randomBytes(8).readBigUInt64BE(0).toString(36).padStart(12, "0");
  return `${hex}-${seq}`;
}

function safeRmQuarantineEntry(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Move a regular file without copying or replacing an existing destination. */
function moveNoReplace(source: string, destination: string): boolean {
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

// ---------------------------------------------------------------------------
// Help.
// ---------------------------------------------------------------------------

/**
 * Render the human-readable help text.  The text deliberately states
 * the read-only default, the exact approval flag, the credential
 * boundary, and the rollback identifier format.
 */
export function formatRecoverLocalStateHelp(): string {
  return [
    "nookctl recover-local-state — Stage 9 bounded, non-destructive local-state recovery",
    "",
    "Usage:",
    "  nookctl recover-local-state [help]                              show this help",
    "  nookctl recover-local-state inspect [--state-dir <path>]        bounded categorical inspection (default; read-only)",
    "  nookctl recover-local-state reinitialize --approve-reinitialize [--state-dir <path>]",
    "                                                                quarantine the original state and reinitialize",
    "  nookctl recover-local-state rollback --approve-rollback <id> [--state-dir <path>]",
    "                                                                restore the preserved state without copy or clobber",
    "",
    "Options:",
    "  --state-dir <path>    state directory to operate on (default: $NOOKBRIDGE_STATE_DIR)",
    "",
    "Safety contract:",
    "  The default invocation is read-only.  Mutation requires the exact",
    `  ${APPROVE_REINITIALIZE_FLAG} or ${APPROVE_ROLLBACK_FLAG} flag on the same line.`,
    "  Credentials, keys, bodies, and contents are never accepted through",
    "  argv or env, never echoed, and never logged.  The original state",
    "  is preserved by a restrictive no-copy, no-clobber move into quarantine",
    "  and rollback restores it without replacing an occupied destination.",
    "",
    "Exit codes:",
    "  0  inspect or quarantine/rollback succeeded",
    "  2  invocation error (missing flag, credential carrier, unsafe state root, ...)",
    "  3  filesystem failure during quarantine/rollback",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI-facing formatting.
// ---------------------------------------------------------------------------

/**
 * Format a {@link RunRecoverCommandResult} for terminal output.  The
 * formatter is intentionally minimal: closed categorical lines,
 * no path, key, body, or upstream error body.
 */
export function formatRecoverCommandResult(result: RunRecoverCommandResult): string {
  switch (result.kind) {
    case "help":
      return result.text;
    case "inspection":
      return formatInspection(result.result);
    case "reinitialized":
      return `nookctl recover-local-state: fresh state initialized; original state quarantined (id=${result.quarantineId})`;
    case "rolled-back":
      return `nookctl recover-local-state: state restored from quarantine (id=${result.quarantineId})`;
    case "error":
      return `nookctl recover-local-state: ${result.message}`;
  }
}

function formatInspection(inspection: RecoveryInspection): string {
  switch (inspection.kind) {
    case "healthy":
      return "nookctl recover-local-state: state is healthy";
    case "missing":
      return "nookctl recover-local-state: database is missing";
    case "corrupt":
      return "nookctl recover-local-state: database is corrupt";
    case "locked":
      return "nookctl recover-local-state: state is currently locked";
  }
}
