/**
 * Stage 3 — operator-only `nookctl sync <subcommand>` plumbing.
 *
 * This module is the sibling of `src/auth/admin-command.ts` for the
 * read-only sync surface.  It mirrors the same shape:
 *
 *   - Parse `nookctl sync status | sync read-only` plus its flags
 *     into a typed result.
 *   - Reject any forbidden argv flag and any forbidden environment
 *     variable in the same way the auth parser does — a credential
 *     carrier (email, password, MFA, token) is NEVER allowed to flow
 *     through argv / env into the sync runner, even though this slice
 *     never reads one.
 *   - Run the operator-only sync command under the
 *     `NOOKBRIDGE_ENABLE_LIVE_SYNC=1` gate.  When the gate is unset
 *     the runner returns a structured categorical error with exit
 *     code 2 — the command never reaches the offline proof runner.
 *   - Drive the offline proof runner (`notesnook-sync-proof.ts`)
 *     through an injected factory seam so production callers wire
 *     the live flattened handle and offline tests wire a fake.
 *
 * The ordinary `nookctl sync <unknown>` path is intentionally
 * preserved as a structured categorical error so the CLI never
 * reaches for an undefined subcommand silently.
 *
 * Deliberate non-goals
 * ---------------------
 *
 *   - This module does NOT authenticate.  Authentication is the
 *     Stage 2B-live runner's job; the sync runner assumes the
 *     injected source handle is already opened.
 *   - This module does NOT call `nookctl auth live-login`.  The two
 *     subcommand trees are siblings: an operator runs `auth
 *     live-login` first to obtain a session, then `sync status` /
 *     `sync read-only` to exercise the read-only surface.
 *   - This module does NOT expose note bodies, encrypted content, or
 *     any write-side surface.  The proof runner is the boundary.
 *   - This module does NOT touch `process.argv` / `process.env` on
 *     its own — it accepts injected `argv` and `env` snapshots so
 *     tests are deterministic.
 */

import {
  isOfflineSyncProofError,
  runOfflineSyncProof,
  formatOfflineSyncProofReport,
  type OfflineSyncProofReport,
  type RunOfflineSyncProofOptions,
} from "./notesnook-sync-proof.js";

// ---------------------------------------------------------------------------
// Subcommand types.
// ---------------------------------------------------------------------------

/**
 * The `sync` subcommands we recognise in this slice.  The set is
 * intentionally narrow: only `status` and `read-only` are wired;
 * everything else is a structured error.
 */
export type SyncSubcommand = "status" | "read-only" | "help";

export type ParsedSyncCommand =
  | Readonly<{
      kind: "status";
      subcommand: "status";
    }>
  | Readonly<{
      kind: "read-only";
      subcommand: "read-only";
      /** Title-only search query (optional). */
      query?: string;
      /** Optional categorical assertion against the search hit ids. */
      expectedSearchId?: string;
      /** Optional note id to read metadata for. */
      noteMetadataId?: string;
      /** Optional note id whose upstream conflict marker must be visible. */
      expectedConflictId?: string;
      /** Optional note id whose body access must fail as vault_locked. */
      expectedVaultLockedId?: string;
    }>
  | Readonly<{
      kind: "help";
      subcommand: "help";
    }>;

// ---------------------------------------------------------------------------
// Parsed result and runner outcome.
// ---------------------------------------------------------------------------

export type ParseSyncCommandResult =
  | Readonly<{ kind: "parsed"; command: ParsedSyncCommand }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 }>;

/**
 * Result returned by {@link runSyncCommand}.  Every entry carries a
 * categorical, redacted message that never contains token bytes,
 * note body text, paths to the state directory, or upstream error
 * message bodies.
 */
export type RunSyncCommandResult =
  | Readonly<{
      kind: "report";
      subcommand: "status" | "read-only";
      report: OfflineSyncProofReport;
    }>
  | Readonly<{
      kind: "help";
      text: string;
    }>
  | Readonly<{
      kind: "error";
      message: string;
      exitCode: 2 | 3;
    }>;

// ---------------------------------------------------------------------------
// Forbidden carriers — shared with the auth boundary.
//
// These are the same names the auth parser forbids; we keep them in
// lock-step so the credential-carrier policy is uniform across the
// operator-only boundary.  A credential is NEVER allowed to flow
// through argv / env into the sync runner.
// ---------------------------------------------------------------------------

const FORBIDDEN_ARG_FLAGS: readonly string[] = [
  "--email",
  "--username",
  "--password",
  "--passwd",
  "--mfa",
  "--totp",
  "--secret",
  "--stdin-secret",
  "--token",
  "--access-token",
  "--refresh-token",
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
];

/**
 * The exact non-secret gate.  Mirrors `LIVE_AUTH_ENABLE_ENV` from
 * `src/auth/admin-command.ts` so the operator-only boundary is
 * uniformly named.
 */
export const LIVE_SYNC_ENABLE_ENV = "NOOKBRIDGE_ENABLE_LIVE_SYNC" as const;

/**
 * Parse `argv` (the part of `process.argv` AFTER the `sync` token)
 * into a {@link ParsedSyncCommand}.  Mirrors the auth parser's
 * credential-carrier policy.
 */
export function parseSyncCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseSyncCommandResult {
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

    for (const name of FORBIDDEN_ENV_VARS) {
      const value = (env as Record<string, unknown>)[name];
      if (value !== undefined && typeof value !== "string") return invalidParseInput();
      if (name in env) {
        return {
          kind: "error",
          exitCode: 2,
          message: `refusing to read credentials from environment variable ${name}; use an interactive TTY prompt`,
        };
      }
    }

    for (const argument of stringArgv) {
      const flag = FORBIDDEN_ARG_FLAGS.find(
        (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
      );
      if (flag !== undefined) {
        return {
          kind: "error",
          exitCode: 2,
          message: `refusing to read credentials from CLI flag ${flag}; use an interactive TTY prompt`,
        };
      }
    }

    const subcommand = stringArgv[0] ?? "help";
    switch (subcommand) {
      case "status":
        if (stringArgv.length !== 1) return invalidParseInput();
        return { kind: "parsed", command: { kind: "status", subcommand: "status" } };
      case "read-only": {
        // The `read-only` subcommand accepts optional `--query`,
        // `--expect-search-id`, `--note-id`, `--expect-conflict-id`,
        // and `--expect-vault-locked-id` flags.  We
        // do NOT accept any credential carrier.  All flags are
        // optional; the proof runner treats them as no-ops when
        // omitted.
        let query: string | undefined;
        let expectedSearchId: string | undefined;
        let noteMetadataId: string | undefined;
        let expectedConflictId: string | undefined;
        let expectedVaultLockedId: string | undefined;
        for (let i = 1; i < stringArgv.length; i++) {
          const cur = stringArgv[i];
          if (cur === undefined) return invalidParseInput();
          if (cur === "--query") {
            const next = stringArgv[i + 1];
            if (typeof next !== "string" || next.length === 0) return invalidParseInput();
            query = next;
            i++;
          } else if (cur === "--note-id") {
            const next = stringArgv[i + 1];
            if (typeof next !== "string" || next.length === 0) return invalidParseInput();
            noteMetadataId = next;
            i++;
          } else if (cur === "--expect-search-id") {
            const next = stringArgv[i + 1];
            if (expectedSearchId !== undefined || typeof next !== "string" || next.length === 0) {
              return invalidParseInput();
            }
            expectedSearchId = next;
            i++;
          } else if (cur === "--expect-conflict-id") {
            const next = stringArgv[i + 1];
            if (expectedConflictId !== undefined || typeof next !== "string" || next.length === 0) {
              return invalidParseInput();
            }
            expectedConflictId = next;
            i++;
          } else if (cur === "--expect-vault-locked-id") {
            const next = stringArgv[i + 1];
            if (
              expectedVaultLockedId !== undefined ||
              typeof next !== "string" ||
              next.length === 0
            ) {
              return invalidParseInput();
            }
            expectedVaultLockedId = next;
            i++;
          } else if (cur.startsWith("--query=")) {
            const next = cur.slice("--query=".length);
            if (next.length === 0) return invalidParseInput();
            query = next;
          } else if (cur.startsWith("--note-id=")) {
            const next = cur.slice("--note-id=".length);
            if (next.length === 0) return invalidParseInput();
            noteMetadataId = next;
          } else if (cur.startsWith("--expect-search-id=")) {
            const next = cur.slice("--expect-search-id=".length);
            if (expectedSearchId !== undefined || next.length === 0) return invalidParseInput();
            expectedSearchId = next;
          } else if (cur.startsWith("--expect-conflict-id=")) {
            const next = cur.slice("--expect-conflict-id=".length);
            if (expectedConflictId !== undefined || next.length === 0) return invalidParseInput();
            expectedConflictId = next;
          } else if (cur.startsWith("--expect-vault-locked-id=")) {
            const next = cur.slice("--expect-vault-locked-id=".length);
            if (expectedVaultLockedId !== undefined || next.length === 0) {
              return invalidParseInput();
            }
            expectedVaultLockedId = next;
          } else {
            return invalidParseInput();
          }
        }
        if (expectedSearchId !== undefined && query === undefined) return invalidParseInput();
        return {
          kind: "parsed",
          command: {
            kind: "read-only",
            subcommand: "read-only",
            ...(query !== undefined ? { query } : {}),
            ...(expectedSearchId !== undefined ? { expectedSearchId } : {}),
            ...(noteMetadataId !== undefined ? { noteMetadataId } : {}),
            ...(expectedConflictId !== undefined ? { expectedConflictId } : {}),
            ...(expectedVaultLockedId !== undefined ? { expectedVaultLockedId } : {}),
          },
        };
      }
      case "help":
      case "--help":
      case "-h":
        return { kind: "parsed", command: { kind: "help", subcommand: "help" } };
      default:
        return {
          kind: "error",
          exitCode: 2,
          message: "nookctl sync: unknown subcommand; use `nookctl sync help`",
        };
    }
  } catch {
    return invalidParseInput();
  }
}

function invalidParseInput(): ParseSyncCommandResult {
  return { kind: "error", exitCode: 2, message: "nookctl sync: invalid command input" };
}

/**
 * Render the human-readable help text for `nookctl sync`.  The text
 * is deliberately explicit about the credential boundary so an
 * operator who reaches for `--password` is steered back to the
 * interactive prompt.
 */
export function formatSyncHelp(): string {
  return [
    "nookctl sync — Stage 3 operator-only read-only sync command",
    "",
    "Usage:",
    "  nookctl sync status                categorical read-only proof of life",
    "  nookctl sync read-only             run the offline proof against an opened handle",
    "  nookctl sync help                  show this help",
    "",
    "Options (sync read-only only):",
    "  --query <text>             optional title-only search query",
    "  --expect-search-id <id>    require a categorical matching search hit",
    "  --note-id <id>             optional note id to read metadata for",
    "  --expect-conflict-id <id>  require a categorical conflict marker",
    "  --expect-vault-locked-id <id>  require a vault_locked body refusal",
    "",
    "Credential boundary:",
    "  Password, MFA, and token bytes are read only from an interactive TTY",
    "  (see `nookctl auth live-login`). They cannot be supplied through argv",
    "  or environment variables. Live commands require",
    "  NOOKBRIDGE_ENABLE_LIVE_SYNC=1.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link runSyncCommand}.  The injection seam is
 * narrow: an optional argv / env snapshot, an optional logger, and
 * an optional source factory.  The source factory is the single
 * seam a CLI caller (or offline test) uses to wire the read-only
 * adapter source — production callers wire the live flattened
 * handle; offline tests wire a deterministic fake.
 */
export type RunSyncCommandOptions = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Offline proof source factory.  Required for `status` and
   * `read-only`.  May be omitted for `help`.
   */
  createProofSource?: () => RunOfflineSyncProofOptions["source"];
  /** Production runtime seam; cleanup is always awaited by the command. */
  createProofRuntime?: () => Promise<
    Readonly<{
      source: RunOfflineSyncProofOptions["source"];
      cleanup: () => void | Promise<void>;
    }>
  >;
}>;

/**
 * Run the `nookctl sync <subcommand>` plumbing.
 *
 * Returns a structured categorical result.  The CLI prints the
 * report; the runner keeps every credential / note-body / token byte
 * behind the proof boundary.
 */
export async function runSyncCommand(
  options: RunSyncCommandOptions,
): Promise<RunSyncCommandResult> {
  let normalized: {
    argv: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
    createProofSource?: RunOfflineSyncProofOptions["source"] | (() => never);
    createProofRuntime?: () => Promise<
      Readonly<{
        source: RunOfflineSyncProofOptions["source"];
        cleanup: () => void | Promise<void>;
      }>
    >;
  };
  try {
    normalized = normalizeRunSyncOptions(options);
  } catch {
    return { kind: "error", exitCode: 2, message: "nookctl sync: invalid command input" };
  }

  const parsed = parseSyncCommand(normalized.argv, normalized.env);
  if (parsed.kind === "error") {
    return { kind: "error", exitCode: parsed.exitCode, message: parsed.message };
  }
  const command = parsed.command;
  if (command.kind === "help") {
    return { kind: "help", text: formatSyncHelp() };
  }

  // The live gate is required for both `status` and `read-only`.
  // When unset, the runner returns a structured error rather than
  // silently degrading to a no-op.  The CLI prints the error with
  // exit code 2.
  const enabled =
    Object.prototype.hasOwnProperty.call(normalized.env, LIVE_SYNC_ENABLE_ENV) &&
    normalized.env[LIVE_SYNC_ENABLE_ENV] === "1";
  if (!enabled) {
    return {
      kind: "error",
      exitCode: 2,
      message: `nookctl sync ${command.subcommand} is disabled; set ${LIVE_SYNC_ENABLE_ENV}=1`,
    };
  }

  if (
    typeof normalized.createProofSource !== "function" &&
    typeof normalized.createProofRuntime !== "function"
  ) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl sync: read-only proof source is unavailable",
    };
  }

  let source: RunOfflineSyncProofOptions["source"];
  let cleanup: (() => void | Promise<void>) | undefined;
  try {
    if (typeof normalized.createProofRuntime === "function") {
      const runtime = await normalized.createProofRuntime();
      source = runtime.source;
      cleanup = runtime.cleanup;
    } else {
      source = (normalized.createProofSource as () => RunOfflineSyncProofOptions["source"])();
    }
  } catch {
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl sync: read-only proof source could not be constructed",
    };
  }

  // Build the proof options.  The runner treats optional `query`
  // and `noteMetadataId` as no-ops when omitted.
  const proofOptions: {
    source: RunOfflineSyncProofOptions["source"];
    query?: string;
    expectedSearchId?: string;
    noteMetadataId?: string;
    expectedConflictId?: string;
    expectedVaultLockedId?: string;
    performSync?: boolean;
  } = {
    source,
    ...(command.kind === "status" ? { performSync: false } : {}),
  };
  if (command.kind === "read-only") {
    if (command.query !== undefined) proofOptions.query = command.query;
    if (command.expectedSearchId !== undefined) {
      proofOptions.expectedSearchId = command.expectedSearchId;
    }
    if (command.noteMetadataId !== undefined) proofOptions.noteMetadataId = command.noteMetadataId;
    if (command.expectedConflictId !== undefined) {
      proofOptions.expectedConflictId = command.expectedConflictId;
    }
    if (command.expectedVaultLockedId !== undefined) {
      proofOptions.expectedVaultLockedId = command.expectedVaultLockedId;
    }
  }

  let reportResult: RunSyncCommandResult;
  let cleanupFailed = false;
  try {
    const report = await runOfflineSyncProof(proofOptions);
    reportResult = { kind: "report", subcommand: command.subcommand, report };
  } catch (error) {
    if (isOfflineSyncProofError(error)) {
      reportResult = {
        kind: "error",
        exitCode: 2,
        message: "nookctl sync: read-only proof failed",
      };
    } else {
      reportResult = {
        kind: "error",
        exitCode: 2,
        message: "nookctl sync: read-only proof failed",
      };
    }
  } finally {
    if (cleanup !== undefined) {
      try {
        await cleanup();
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed) {
    return { kind: "error", exitCode: 3, message: "nookctl sync: read-only proof teardown failed" };
  }
  return reportResult;
}

function normalizeRunSyncOptions(options: unknown): {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  createProofSource?: RunOfflineSyncProofOptions["source"] | (() => never);
  createProofRuntime?: () => Promise<
    Readonly<{
      source: RunOfflineSyncProofOptions["source"];
      cleanup: () => void | Promise<void>;
    }>
  >;
} {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("invalid sync options");
  }
  const candidate = options as Record<string, unknown>;
  const argv = candidate.argv;
  if (!Array.isArray(argv)) throw new Error("invalid sync argv");
  const safeArgv = Array.from(argv as readonly unknown[]);
  if (!safeArgv.every((argument): argument is string => typeof argument === "string")) {
    throw new Error("invalid sync argv");
  }
  const env = candidate.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error("invalid sync env");
  }
  const sourceEnv = env as Record<string, unknown>;
  const snapshot: Record<string, string | undefined> = Object.create(null);
  for (const name of Object.getOwnPropertyNames(sourceEnv)) {
    const entry = sourceEnv[name];
    if (entry !== undefined && typeof entry !== "string") {
      throw new Error("invalid sync env");
    }
    Object.defineProperty(snapshot, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: entry,
    });
  }
  // Preserve inherited forbidden-carrier presence without reading
  // inherited values.  Only an own, snapshotted property can enable
  // live-sync.
  for (const name of FORBIDDEN_ENV_VARS) {
    if (!(name in sourceEnv) || Object.prototype.hasOwnProperty.call(snapshot, name)) continue;
    Object.defineProperty(snapshot, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: undefined,
    });
  }
  const createProofSource = candidate.createProofSource;
  const createProofRuntime = candidate.createProofRuntime;
  if (createProofSource !== undefined && typeof createProofSource !== "function") {
    throw new Error("invalid sync proof source factory");
  }
  if (createProofRuntime !== undefined && typeof createProofRuntime !== "function") {
    throw new Error("invalid sync proof runtime factory");
  }
  return {
    argv: Object.freeze(safeArgv),
    env: Object.freeze(snapshot),
    ...(createProofSource === undefined
      ? {}
      : { createProofSource: createProofSource as () => never }),
    ...(createProofRuntime === undefined
      ? {}
      : {
          createProofRuntime: createProofRuntime as () => Promise<
            Readonly<{
              source: RunOfflineSyncProofOptions["source"];
              cleanup: () => void | Promise<void>;
            }>
          >,
        }),
  };
}

/**
 * Render a {@link RunSyncCommandResult} as a multi-line, redacted
 * string suitable for `process.stdout` / `process.stderr`.  Note
 * bodies, error message bodies, and credential bytes are NEVER
 * surfaced — the underlying report is already categorical.
 */
export function formatSyncCommandResult(result: RunSyncCommandResult): string {
  switch (result.kind) {
    case "help":
      return result.text;
    case "report":
      return formatOfflineSyncProofReport(result.report);
    case "error":
      return result.message;
  }
}
