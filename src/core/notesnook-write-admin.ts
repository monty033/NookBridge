/**
 * Stage 4 §6 — operator-only `nookctl write <subcommand>` acceptance path.
 *
 * This module is the write-side sibling of `notesnook-sync-admin.ts`.  It is
 * a *separately named* command tree: nothing here is reachable from
 * `nookctl sync`, and `nookctl sync read-only` remains fetch-only and
 * unchanged.
 *
 * Shape
 * -----
 *
 *   nookctl write help
 *   nookctl write create --title <title> [--notebook-id <id>]
 *   nookctl write append --note-id <id> --expect-revision <token>
 *   nookctl write update --note-id <id> --expect-revision <token>
 *                        (--set-pinned <true|false> | --set-favorite <true|false>)
 *
 * Boundaries enforced here
 * ------------------------
 *
 *   - **Gate.**  Every acceptance subcommand requires the exact non-secret
 *     opt-in `NOOKBRIDGE_ENABLE_LIVE_SYNC=1`.  Without it the runner returns
 *     a categorical error with exit code 2 and the write runtime is never
 *     constructed.  `help` renders without the gate.
 *   - **Ordering.**  Parse → credential-carrier rejection → gate → runtime
 *     construction.  The injected `createWriteRuntime` factory is not called
 *     on any earlier failure path, so a disabled or malformed invocation
 *     cannot open a database or touch upstream.
 *   - **Credential carriers.**  The same forbidden argv flags and environment
 *     variables the auth/sync parsers reject are rejected here.  Passwords,
 *     MFA codes, and tokens are TTY-only and are never read by this module.
 *   - **No bodies in argv.**  The acceptance commands never accept a note
 *     body or Markdown fragment from the command line.  `create` and
 *     `append` use fixed, non-secret acceptance content owned by this module,
 *     so an operator canary cannot smuggle a corpus through argv or a shell
 *     history file.
 *   - **Categorical output only.**  The formatted report contains the
 *     operation category and the bounded outcome booleans plus a pending
 *     count.  It never contains a note id, revision token, title, body,
 *     path, upstream message, or cause.
 *   - **No auto-sync.**  The local write dispatch never calls `requestSync()`.
 *     A successful local write is reported as `remote: pending`, never as
 *     remotely synchronised.  Remote execution stays a separate explicit
 *     step through the `remoteSync` capability.
 *   - **Cleanup.**  When the runtime factory supplies a `cleanup`, it is
 *     awaited on every path (success, categorical failure, unexpected
 *     throw).  A cleanup failure is itself categorical (exit code 3).
 */

import {
  isNotesnookWriteContractError,
  STAGE4_WRITE_LIMITS,
  type NotesnookRevisionToken,
  type NotesnookWriteErrorCode,
} from "./notesnook-write-contract.js";
import type { NotesnookLocalWriteResult } from "./notesnook-write-composition.js";
import type { NotesnookLiveRemoteSyncCapability } from "./notesnook-live-remote-sync.js";

// ---------------------------------------------------------------------------
// Public gate name — deliberately the SAME non-secret opt-in the Stage 3
// sync tree uses, as specified for this slice.  The capability itself is
// separately named; the operator opt-in is one switch.
// ---------------------------------------------------------------------------

export const LIVE_WRITE_ENABLE_ENV = "NOOKBRIDGE_ENABLE_LIVE_SYNC" as const;

/** Fixed acceptance content.  Never operator-supplied, never printed. */
const ACCEPTANCE_CREATE_BODY = "NookBridge Stage 4 acceptance note.";
const ACCEPTANCE_APPEND_FRAGMENT = "NookBridge Stage 4 acceptance append.";

// ---------------------------------------------------------------------------
// Forbidden carriers — kept in lock-step with the auth and sync parsers.
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
 * Body-carrying flags an operator might reach for.  They are rejected
 * explicitly (rather than falling through to "unknown flag") so the error
 * steers the operator to the fixed acceptance content instead of inviting a
 * retry with a different spelling.  The rejection message names only the
 * flag, never a value.
 */
const FORBIDDEN_BODY_FLAGS: readonly string[] = [
  "--content",
  "--body",
  "--markdown",
  "--fragment",
  "--text",
  "--file",
  "--content-file",
  "--stdin",
];

// ---------------------------------------------------------------------------
// Parsed command shapes.
// ---------------------------------------------------------------------------

export type WriteSubcommand = "help" | "create" | "append" | "update" | "sync";

export type ParsedWriteCommand =
  | Readonly<{ kind: "help"; subcommand: "help" }>
  | Readonly<{
      kind: "create";
      subcommand: "create";
      title: string;
      notebookId?: string;
    }>
  | Readonly<{
      kind: "append";
      subcommand: "append";
      noteId: string;
      expectedRevision: string;
    }>
  | Readonly<{
      kind: "update";
      subcommand: "update";
      noteId: string;
      expectedRevision: string;
      /** Exactly one allowlisted boolean metadata field. */
      field: "pinned" | "favorite";
      value: boolean;
    }>
  | Readonly<{ kind: "sync"; subcommand: "sync" }>;

export type ParseWriteCommandResult =
  | Readonly<{ kind: "parsed"; command: ParsedWriteCommand }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 }>;

/**
 * Bounded categorical report.  This is the ONLY data the CLI prints for a
 * successful acceptance write.  No id, token, title, byte count that could
 * act as an oracle on a body, path, or upstream string appears here.
 */
export type WriteAcceptanceReport = Readonly<{
  readonly operation: "create" | "append" | "update";
  readonly localCommitted: true;
  readonly remoteSynced: false;
  readonly pendingSync: true;
  /** Number of pending queue markers observed after the local write. */
  readonly pendingCount: number;
}>;

/** Bounded categorical result for the explicit remote-sync command. */
export type WriteSyncReport = Readonly<{
  readonly status: "idle" | "synced" | "failed";
  readonly pendingSync: boolean;
  readonly attempts: number;
}>;

export type RunWriteCommandResult =
  | Readonly<{
      kind: "report";
      subcommand: "create" | "append" | "update";
      report: WriteAcceptanceReport;
    }>
  | Readonly<{
      kind: "sync-report";
      subcommand: "sync";
      report: WriteSyncReport;
    }>
  | Readonly<{ kind: "help"; text: string }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 | 3 }>;

// ---------------------------------------------------------------------------
// The separately named live write capability.
//
// This is the ONLY capability the operator path consumes.  It is a distinct
// structural type from `NotesnookReadOnlyDatabase` and from the auth
// runtime's `readOnly` surface: an existing read-only caller cannot acquire
// a write path by accident, because nothing projects one type into the other.
//
// `requestSync` is deliberately ABSENT from the local-write capability.
// Remote execution is exposed only through the separately named `remoteSync`
// capability, so local-write results cannot claim a remote outcome.
// ---------------------------------------------------------------------------

export interface NotesnookLiveWriteCapability {
  readonly createNote: (command: {
    readonly title: string;
    readonly content: string;
    readonly notebookId?: string;
  }) => Promise<NotesnookLocalWriteResult>;
  readonly appendNote: (command: {
    readonly id: string;
    readonly markdownFragment: string;
    readonly expectedRevision: NotesnookRevisionToken;
  }) => Promise<NotesnookLocalWriteResult>;
  readonly updateNote: (command: {
    readonly id: string;
    readonly patch: Readonly<Record<string, unknown>>;
    readonly expectedRevision: NotesnookRevisionToken;
  }) => Promise<NotesnookLocalWriteResult>;
  readonly pendingSnapshot: () => { readonly pending: readonly unknown[] };
}

/** Runtime seam: the capability plus its owned teardown. */
export type NotesnookLiveWriteRuntime = Readonly<{
  capability: NotesnookLiveWriteCapability;
  remoteSync?: NotesnookLiveRemoteSyncCapability;
  cleanup?: () => void | Promise<void>;
}>;

export type RunWriteCommandOptions = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Constructed ONLY after the parser, the credential-carrier policy, and
   * the explicit gate have all passed.
   */
  createWriteRuntime?: () => Promise<NotesnookLiveWriteRuntime> | NotesnookLiveWriteRuntime;
}>;

// ---------------------------------------------------------------------------
// Parser.
// ---------------------------------------------------------------------------

function invalidParseInput(): ParseWriteCommandResult {
  return { kind: "error", exitCode: 2, message: "nookctl write: invalid command input" };
}

/** Strict bounded identifier rule, matching the write wiring boundary. */
function isBoundedIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= STAGE4_WRITE_LIMITS.maxIdLength &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isRevisionTokenShape(value: string): boolean {
  return /^rev_[0-9a-f]{32}$/.test(value);
}

function isBoundedTitle(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= STAGE4_WRITE_LIMITS.maxTitleLength &&
    value.trim().length > 0 &&
    !value.startsWith("--") &&
    // Reject control characters so a title can never carry a terminal
    // escape sequence into an operator's console.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * Parse `argv` (the part of `process.argv` AFTER the `write` token).
 *
 * The parser is total: it returns either a validated command or a
 * categorical error.  It reads nothing outside `argv` / `env`, constructs
 * nothing, and touches no filesystem or database.
 */
export function parseWriteCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseWriteCommandResult {
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
      const bodyFlag = FORBIDDEN_BODY_FLAGS.find(
        (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
      );
      if (bodyFlag !== undefined) {
        return {
          kind: "error",
          exitCode: 2,
          message: `refusing to read note content from CLI flag ${bodyFlag}; acceptance content is fixed`,
        };
      }
    }

    const subcommand = stringArgv[0] ?? "help";
    switch (subcommand) {
      case "help":
      case "--help":
      case "-h":
        return { kind: "parsed", command: { kind: "help", subcommand: "help" } };
      case "create":
        return parseCreate(stringArgv);
      case "append":
        return parseAppend(stringArgv);
      case "update":
        return parseUpdate(stringArgv);
      case "sync":
        return stringArgv.length === 1
          ? { kind: "parsed", command: { kind: "sync", subcommand: "sync" } }
          : invalidParseInput();
      default:
        return {
          kind: "error",
          exitCode: 2,
          message: "nookctl write: unknown subcommand; use `nookctl write help`",
        };
    }
  } catch {
    return invalidParseInput();
  }
}

/** Read `--flag value` or `--flag=value`; returns the value and next index. */
function readFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { value: string; next: number } | undefined {
  const current = argv[index];
  if (current === undefined) return undefined;
  if (current === flag) {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0) return undefined;
    return { value, next: index + 1 };
  }
  if (current.startsWith(`${flag}=`)) {
    const value = current.slice(flag.length + 1);
    if (value.length === 0) return undefined;
    return { value, next: index };
  }
  return undefined;
}

function matchesFlag(argument: string, flag: string): boolean {
  return argument === flag || argument.startsWith(`${flag}=`);
}

function parseCreate(argv: readonly string[]): ParseWriteCommandResult {
  let title: string | undefined;
  let notebookId: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === undefined) return invalidParseInput();
    if (matchesFlag(current, "--title")) {
      if (title !== undefined) return invalidParseInput();
      const read = readFlagValue(argv, index, "--title");
      if (read === undefined || !isBoundedTitle(read.value)) return invalidParseInput();
      title = read.value;
      index = read.next;
    } else if (matchesFlag(current, "--notebook-id")) {
      if (notebookId !== undefined) return invalidParseInput();
      const read = readFlagValue(argv, index, "--notebook-id");
      if (read === undefined || !isBoundedIdentifier(read.value)) return invalidParseInput();
      notebookId = read.value;
      index = read.next;
    } else {
      return invalidParseInput();
    }
  }
  if (title === undefined) return invalidParseInput();
  return {
    kind: "parsed",
    command: {
      kind: "create",
      subcommand: "create",
      title,
      ...(notebookId === undefined ? {} : { notebookId }),
    },
  };
}

function parseAppend(argv: readonly string[]): ParseWriteCommandResult {
  let noteId: string | undefined;
  let expectedRevision: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === undefined) return invalidParseInput();
    if (matchesFlag(current, "--note-id")) {
      if (noteId !== undefined) return invalidParseInput();
      const read = readFlagValue(argv, index, "--note-id");
      if (read === undefined || !isBoundedIdentifier(read.value)) return invalidParseInput();
      noteId = read.value;
      index = read.next;
    } else if (matchesFlag(current, "--expect-revision")) {
      if (expectedRevision !== undefined) return invalidParseInput();
      const read = readFlagValue(argv, index, "--expect-revision");
      if (read === undefined || !isRevisionTokenShape(read.value)) return invalidParseInput();
      expectedRevision = read.value;
      index = read.next;
    } else {
      return invalidParseInput();
    }
  }
  if (noteId === undefined || expectedRevision === undefined) return invalidParseInput();
  return {
    kind: "parsed",
    command: { kind: "append", subcommand: "append", noteId, expectedRevision },
  };
}

function parseBoolean(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseUpdate(argv: readonly string[]): ParseWriteCommandResult {
  let noteId: string | undefined;
  let expectedRevision: string | undefined;
  let field: "pinned" | "favorite" | undefined;
  let value: boolean | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === undefined) return invalidParseInput();
    if (matchesFlag(current, "--note-id")) {
      if (noteId !== undefined) return invalidParseInput();
      const read = readFlagValue(argv, index, "--note-id");
      if (read === undefined || !isBoundedIdentifier(read.value)) return invalidParseInput();
      noteId = read.value;
      index = read.next;
    } else if (matchesFlag(current, "--expect-revision")) {
      if (expectedRevision !== undefined) return invalidParseInput();
      const read = readFlagValue(argv, index, "--expect-revision");
      if (read === undefined || !isRevisionTokenShape(read.value)) return invalidParseInput();
      expectedRevision = read.value;
      index = read.next;
    } else if (matchesFlag(current, "--set-pinned") || matchesFlag(current, "--set-favorite")) {
      if (field !== undefined) return invalidParseInput();
      const flag = matchesFlag(current, "--set-pinned") ? "--set-pinned" : "--set-favorite";
      const read = readFlagValue(argv, index, flag);
      if (read === undefined) return invalidParseInput();
      const parsedValue = parseBoolean(read.value);
      if (parsedValue === undefined) return invalidParseInput();
      field = flag === "--set-pinned" ? "pinned" : "favorite";
      value = parsedValue;
      index = read.next;
    } else {
      return invalidParseInput();
    }
  }
  if (
    noteId === undefined ||
    expectedRevision === undefined ||
    field === undefined ||
    value === undefined
  ) {
    return invalidParseInput();
  }
  return {
    kind: "parsed",
    command: { kind: "update", subcommand: "update", noteId, expectedRevision, field, value },
  };
}

// ---------------------------------------------------------------------------
// Help.
// ---------------------------------------------------------------------------

export function formatWriteHelp(): string {
  return [
    "nookctl write — Stage 4 operator-only local write acceptance command",
    "",
    "Usage:",
    "  nookctl write create --title <title> [--notebook-id <id>]",
    "  nookctl write append --note-id <id> --expect-revision <token>",
    "  nookctl write update --note-id <id> --expect-revision <token>",
    "                       (--set-pinned <true|false> | --set-favorite <true|false>)",
    "  nookctl write sync                   request explicit remote synchronization",
    "  nookctl write help                 show this help",
    "",
    "Acceptance content:",
    "  Note bodies and Markdown fragments are FIXED and owned by the command.",
    "  They cannot be supplied through argv, a file, or stdin.",
    "",
    "Local vs remote:",
    "  A successful write is committed LOCALLY and reported as remote: pending.",
    "  This command never triggers remote synchronization; that remains a",
    "  separate explicit step.",
    "",
    "Credential boundary:",
    "  Password, MFA, and token bytes are read only from an interactive TTY",
    "  (see `nookctl auth live-login`). They cannot be supplied through argv",
    "  or environment variables. Write commands require",
    `  ${LIVE_WRITE_ENABLE_ENV}=1.`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

type NormalizedWriteOptions = {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  createWriteRuntime?: () => Promise<NotesnookLiveWriteRuntime> | NotesnookLiveWriteRuntime;
};

function normalizeRunWriteOptions(options: unknown): NormalizedWriteOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("invalid write options");
  }
  const candidate = options as Record<string, unknown>;
  const argv = candidate.argv;
  if (!Array.isArray(argv)) throw new Error("invalid write argv");
  const safeArgv = Array.from(argv as readonly unknown[]);
  if (!safeArgv.every((argument): argument is string => typeof argument === "string")) {
    throw new Error("invalid write argv");
  }
  const env = candidate.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error("invalid write env");
  }
  const sourceEnv = env as Record<string, unknown>;
  const snapshot: Record<string, string | undefined> = Object.create(null);
  for (const name of Object.getOwnPropertyNames(sourceEnv)) {
    const entry = sourceEnv[name];
    if (entry !== undefined && typeof entry !== "string") throw new Error("invalid write env");
    Object.defineProperty(snapshot, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: entry,
    });
  }
  // Preserve inherited forbidden-carrier presence without reading inherited
  // values.  Only an own, snapshotted property can enable the gate.
  for (const name of FORBIDDEN_ENV_VARS) {
    if (!(name in sourceEnv) || Object.prototype.hasOwnProperty.call(snapshot, name)) continue;
    Object.defineProperty(snapshot, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: undefined,
    });
  }
  const createWriteRuntime = candidate.createWriteRuntime;
  if (createWriteRuntime !== undefined && typeof createWriteRuntime !== "function") {
    throw new Error("invalid write runtime factory");
  }
  return {
    argv: Object.freeze(safeArgv),
    env: Object.freeze(snapshot),
    ...(createWriteRuntime === undefined
      ? {}
      : {
          createWriteRuntime: createWriteRuntime as () =>
            | Promise<NotesnookLiveWriteRuntime>
            | NotesnookLiveWriteRuntime,
        }),
  };
}

/**
 * Run `nookctl write <subcommand>`.
 *
 * Ordering is load-bearing and asserted by the offline tests:
 *
 *   1. normalize options;
 *   2. parse argv + reject credential / body carriers;
 *   3. `help` short-circuits with no gate and no runtime;
 *   4. gate check — a missing or non-`1` opt-in returns exit code 2 and
 *      NEVER calls `createWriteRuntime`;
 *   5. construct the runtime;
 *   6. dispatch exactly one local write or explicit remote sync;
 *   7. read bounded outcome metadata;
 *   8. always await cleanup.
 */
export async function runWriteCommand(
  options: RunWriteCommandOptions,
): Promise<RunWriteCommandResult> {
  let normalized: NormalizedWriteOptions;
  try {
    normalized = normalizeRunWriteOptions(options);
  } catch {
    return { kind: "error", exitCode: 2, message: "nookctl write: invalid command input" };
  }

  const parsed = parseWriteCommand(normalized.argv, normalized.env);
  if (parsed.kind === "error") {
    return { kind: "error", exitCode: parsed.exitCode, message: parsed.message };
  }
  const command = parsed.command;
  if (command.kind === "help") {
    return { kind: "help", text: formatWriteHelp() };
  }

  const enabled =
    Object.prototype.hasOwnProperty.call(normalized.env, LIVE_WRITE_ENABLE_ENV) &&
    normalized.env[LIVE_WRITE_ENABLE_ENV] === "1";
  if (!enabled) {
    return {
      kind: "error",
      exitCode: 2,
      message: `nookctl write ${command.subcommand} is disabled; set ${LIVE_WRITE_ENABLE_ENV}=1`,
    };
  }

  if (typeof normalized.createWriteRuntime !== "function") {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl write: local write capability is unavailable",
    };
  }

  let runtime: NotesnookLiveWriteRuntime;
  try {
    runtime = await normalized.createWriteRuntime();
  } catch {
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl write: local write capability could not be constructed",
    };
  }

  let outcome: RunWriteCommandResult;
  let cleanupFailed = false;
  try {
    if (command.kind === "sync") {
      if (runtime.remoteSync === undefined) {
        outcome = {
          kind: "error",
          exitCode: 2,
          message: "nookctl write sync: remote synchronization capability is unavailable",
        };
      } else {
        outcome = await dispatchSync(runtime.remoteSync);
      }
    } else {
      outcome = await dispatchWrite(runtime.capability, command);
    }
  } catch {
    outcome = {
      kind: "error",
      exitCode: 2,
      message: `nookctl write ${command.subcommand}: local write failed`,
    };
  } finally {
    let cleanup: (() => void | Promise<void>) | undefined;
    try {
      cleanup = runtime.cleanup;
    } catch {
      cleanupFailed = true;
    }
    if (!cleanupFailed && typeof cleanup === "function") {
      try {
        await cleanup();
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed) {
    return { kind: "error", exitCode: 3, message: "nookctl write: local write teardown failed" };
  }
  return outcome;
}

/**
 * Dispatch exactly one local write and project its bounded result.
 *
 * Every categorical failure is mapped to a fixed message keyed only on the
 * contract's closed code table.  The upstream message, cause, stack, note
 * id, revision token, and any body are all discarded here.
 */
async function dispatchWrite(
  capability: NotesnookLiveWriteCapability,
  command: Exclude<ParsedWriteCommand, { kind: "help" | "sync" }>,
): Promise<RunWriteCommandResult> {
  let result: NotesnookLocalWriteResult;
  try {
    switch (command.kind) {
      case "create":
        result = await capability.createNote({
          title: command.title,
          content: ACCEPTANCE_CREATE_BODY,
          ...(command.notebookId === undefined ? {} : { notebookId: command.notebookId }),
        });
        break;
      case "append":
        result = await capability.appendNote({
          id: command.noteId,
          markdownFragment: ACCEPTANCE_APPEND_FRAGMENT,
          expectedRevision: command.expectedRevision as NotesnookRevisionToken,
        });
        break;
      case "update":
        result = await capability.updateNote({
          id: command.noteId,
          patch: Object.freeze({ [command.field]: command.value }),
          expectedRevision: command.expectedRevision as NotesnookRevisionToken,
        });
        break;
    }
  } catch (error) {
    return {
      kind: "error",
      exitCode: 2,
      message: `nookctl write ${command.subcommand}: ${categoricalFailureLabel(error)}`,
    };
  }

  // Validate the relayed outcome flags rather than trusting them.  A
  // capability that claims a remote sync is rejected: local write dispatch
  // must never report `remoteSynced: true`; explicit remote execution is
  // handled by the separately named `remoteSync` capability.
  if (
    !isPlainRecord(result) ||
    readOwn(result, "operation") !== command.subcommand ||
    readOwn(result, "localCommitted") !== true ||
    readOwn(result, "remoteSynced") !== false ||
    readOwn(result, "pendingSync") !== true
  ) {
    return {
      kind: "error",
      exitCode: 2,
      message: `nookctl write ${command.subcommand}: local write outcome was not recognised`,
    };
  }

  let pendingCount: number;
  try {
    const snapshot = capability.pendingSnapshot();
    // The composition returns a sealed, null-prototype array-LIKE object
    // (own indices plus a non-enumerable own `length`), not a real `Array`,
    // so `Array.isArray` is deliberately not used here.  Only a bounded own
    // numeric `length` is accepted.
    const pending = isPlainRecord(snapshot) ? readOwn(snapshot, "pending") : undefined;
    const length =
      typeof pending === "object" && pending !== null
        ? readOwn(pending as object, "length")
        : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 64) {
      return {
        kind: "error",
        exitCode: 2,
        message: `nookctl write ${command.subcommand}: pending state was not recognised`,
      };
    }
    pendingCount = length;
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: `nookctl write ${command.subcommand}: pending state was not recognised`,
    };
  }

  return {
    kind: "report",
    subcommand: command.subcommand,
    report: Object.freeze({
      operation: command.subcommand,
      localCommitted: true as const,
      remoteSynced: false as const,
      pendingSync: true as const,
      pendingCount,
    }),
  };
}

/** Dispatch only the separately named explicit remote-sync capability. */
async function dispatchSync(
  capability: NotesnookLiveRemoteSyncCapability,
): Promise<RunWriteCommandResult> {
  let result: unknown;
  try {
    result = await capability.requestSync();
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl write sync: synchronization failed",
    };
  }
  if (!isPlainRecord(result)) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl write sync: synchronization result was not recognised",
    };
  }
  const status = readOwn(result, "status");
  const pendingSync = readOwn(result, "pendingSync");
  const attempts = readOwn(result, "attempts");
  if (
    (status !== "idle" && status !== "synced" && status !== "failed") ||
    typeof pendingSync !== "boolean" ||
    typeof attempts !== "number" ||
    !Number.isSafeInteger(attempts) ||
    attempts < 0 ||
    attempts > 8
  ) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl write sync: synchronization result was not recognised",
    };
  }
  return {
    kind: "sync-report",
    subcommand: "sync",
    report: Object.freeze({ status, pendingSync, attempts }),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read an own property without invoking a prototype-chain accessor. */
function readOwn(record: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(record, key);
  } catch {
    return undefined;
  }
  if (!descriptor) return undefined;
  if (Object.prototype.hasOwnProperty.call(descriptor, "value")) return descriptor.value;
  const getter = descriptor.get;
  if (typeof getter !== "function") return undefined;
  try {
    return Reflect.apply(getter, record, []);
  } catch {
    return undefined;
  }
}

/**
 * Map a thrown value to a fixed categorical label.
 *
 * Only the closed contract code table is consulted, and only when the thrown
 * value is a recognised contract/composition error by object identity.  Any
 * other throw becomes the generic label, so a foreign error's message can
 * never reach the operator's console.
 */
function categoricalFailureLabel(error: unknown): string {
  if (isNotesnookWriteContractError(error)) {
    const code = readOwn(error as object, "code");
    switch (code as NotesnookWriteErrorCode) {
      case "invalid_input":
        return "rejected: invalid input";
      case "unsupported_content":
        return "rejected: unsupported content";
      case "unsupported_patch_field":
        return "rejected: unsupported patch field";
      case "stale_revision":
        return "rejected: stale revision";
      case "conflict":
        return "rejected: conflict";
      case "vault_locked":
        return "rejected: vault locked";
      case "sync_failed":
        return "rejected: local write failed";
      default:
        return "rejected: local write failed";
    }
  }
  return "rejected: local write failed";
}

/**
 * Render a {@link RunWriteCommandResult}.  Only categorical fields appear;
 * `remote: pending` is stated explicitly so an operator can never read the
 * output as a remote-sync receipt.
 */
export function formatWriteCommandResult(result: RunWriteCommandResult): string {
  switch (result.kind) {
    case "help":
      return result.text;
    case "error":
      return result.message;
    case "report":
      return [
        `nookctl write ${result.report.operation}: local-committed`,
        "  local:   committed",
        "  remote:  pending (explicit synchronization required)",
        `  pending: ${result.report.pendingCount}`,
      ].join("\n");
    case "sync-report":
      return [
        `nookctl write sync: ${result.report.status}`,
        `  remote:  ${result.report.status}`,
        `  pending: ${result.report.pendingSync ? "yes" : "no"}`,
        `  attempts: ${result.report.attempts}`,
      ].join("\n");
  }
}
