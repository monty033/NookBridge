/**
 * Stage 5 §6 — operator-only `nookctl conflicts <subcommand>` plumbing.
 *
 * This module is a *separately named* read-only observation tree: it
 * is the sibling of `notesnook-write-admin.ts` for conflict-marker
 * inspection.  It NEVER mutates, NEVER resolves, NEVER triggers sync
 * (send / full / fetch / force), and NEVER exposes the raw Notesnook
 * database, the generic transport, the user/token/kv surfaces, note
 * bodies, revision tokens, or raw IDs to the operator-facing output. The
 * underlying projection retains bounded IDs internally for title resolution
 * and identity binding; this module never emits those IDs. Its only job is to
 * render the categorical "did this device see a conflict marker?" outcome of
 * the Stage 5 local-conflict projection.
 *
 * Shape
 * -----
 *
 *   nookctl conflicts help
 *   nookctl conflicts list
 *   nookctl conflicts observe --title <exact-title>
 *
 * Boundaries enforced here
 * ------------------------
 *
 *   - **Gate.**  Every observation subcommand requires the exact non-secret
 *     opt-in `NOOKBRIDGE_ENABLE_LIVE_SYNC=1`.  Without it the runner returns
 *     a categorical error with exit code 2 and the live runtime is NEVER
 *     constructed.  `help` and the empty-argv path render without the gate.
 *   - **Ordering.**  Parse → credential-carrier rejection → body / file /
 *     stdin / id / revision / database / force / sync-mode rejection →
 *     gate → runtime construction → observer dispatch → cleanup.  The
 *     injected `createObserverRuntime` factory is not called on any earlier
 *     failure path, so a disabled or malformed invocation cannot open a
 *     database or touch upstream.
 *   - **Credential carriers.**  The same forbidden argv flags and environment
 *     variables the auth/sync/write parsers reject are rejected here.
 *     Passwords, MFA codes, and tokens are TTY-only and are NEVER read by
 *     this module.
 *   - **No bodies in argv.**  The observation commands NEVER accept a
 *     note body, Markdown fragment, content file, or stdin payload from
 *     the command line.  The only target identifier accepted is a bounded
 *     exact note title, which is used to resolve the local conflict marker
 *     against the existing read-only projection's metadata surface.
 *   - **No IDs, no revision tokens, no force / sync / send / full flags.**
 *     An operator who reaches for `--note-id`, `--expect-revision`,
 *     `--rev`, `--id`, `--database`, `--raw`, `--force`, `--send`, or
 *     `--full` is steered back to the categorical error path before any
 *     runtime call.
 *   - **Title validation.**  Titles are validated for length (1..512),
 *     bounded characters (no control bytes, no leading `--`), non-empty
 *     trim, and an explicit "ID-shape" rejection (`[A-Za-z0-9_-]{20,}`)
 *     so an operator cannot accidentally pass a note id in the title
 *     slot.  Rejection messages NEVER echo the supplied title.
 *   - **Categorical output only.**  The formatted report contains the
 *     observation category (`observed` / `not-observed`) and a bounded
 *     count when applicable.  It never contains the supplied title, the
 *     internal id, the note body, a revision token, the state path, the
 *     upstream message, the cause, or the stack.  Failures are mapped to
 *     a fixed small label set.
 *   - **Cleanup.**  When the runtime factory supplies a `cleanup`, it is
 *     awaited on every path (success, categorical failure, unexpected
 *     throw).  A cleanup failure is itself categorical (exit code 3).
 */

import type { NotesnookLocalConflictObserver } from "./notesnook-local-conflict-projection.js";

// ---------------------------------------------------------------------------
// Public gate name — deliberately the SAME non-secret opt-in the Stage 3
// sync tree and the Stage 4 write tree use.  The capability itself is
// separately named; the operator opt-in is one switch.
// ---------------------------------------------------------------------------

export const LIVE_CONFLICT_ENABLE_ENV = "NOOKBRIDGE_ENABLE_LIVE_SYNC" as const;

// ---------------------------------------------------------------------------
// Forbidden carriers — kept in lock-step with the auth / sync / write parsers.
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

/**
 * Identifier-like / revision-like / sync-mode flags the operator might reach
 * for.  Rejected EXPLICITLY (rather than falling through to "unknown flag")
 * so the error steers the operator back to the read-only observation
 * surface instead of inviting a retry with a different spelling.  The
 * rejection message names only the flag, never a value.
 */
const FORBIDDEN_IDENTIFIER_FLAGS: readonly string[] = [
  "--note-id",
  "--id",
  "--revision",
  "--rev",
  "--expect-revision",
  "--database",
  "--raw",
  "--db",
];

const FORBIDDEN_SYNC_FLAGS: readonly string[] = [
  "--force",
  "--send",
  "--full",
  "--sync",
  "--resolve",
  "--commit",
  "--apply",
  "--push",
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

// ---------------------------------------------------------------------------
// Title validation policy.
// ---------------------------------------------------------------------------

const MAX_TITLE_LENGTH = 512;
const MIN_TITLE_LENGTH = 1;
const ID_LIKE_SHAPE_MIN = 20;
const ID_LIKE_SHAPE_PATTERN = /^[A-Za-z0-9_-]+$/;

function isBoundedExactTitle(value: string): boolean {
  if (value.length < MIN_TITLE_LENGTH) return false;
  if (value.length > MAX_TITLE_LENGTH) return false;
  if (value.trim().length === 0) return false;
  if (value.startsWith("--")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.length >= ID_LIKE_SHAPE_MIN && ID_LIKE_SHAPE_PATTERN.test(value)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Parsed command shapes.
// ---------------------------------------------------------------------------

export type ConflictSubcommand = "help" | "list" | "observe";

export type ParsedConflictCommand =
  | Readonly<{ kind: "help"; subcommand: "help" }>
  | Readonly<{ kind: "list"; subcommand: "list" }>
  | Readonly<{
      kind: "observe";
      subcommand: "observe";
      title: string;
    }>;

export type ParseConflictCommandResult =
  | Readonly<{ kind: "parsed"; command: ParsedConflictCommand }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 }>;

/**
 * Bounded categorical report.  This is the ONLY data the CLI prints for a
 * successful observation.  No id, token, title, path, upstream string,
 * cause, or stack appears here.
 */
export type ConflictObservationReport =
  | Readonly<{ kind: "observed"; count?: undefined }>
  | Readonly<{ kind: "observed"; count: number }>
  | Readonly<{ kind: "not-observed"; count?: undefined }>
  | Readonly<{ kind: "not-observed"; count: number }>;

export type RunConflictCommandResult =
  | Readonly<{
      kind: "report";
      subcommand: "list" | "observe";
      report: ConflictObservationReport;
    }>
  | Readonly<{ kind: "help"; text: string }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 | 3 }>;

// ---------------------------------------------------------------------------
// The separately named local-conflict runtime seam.
//
// This is the ONLY capability the operator path consumes.  It is a distinct
// structural type from `NotesnookReadOnlyDatabase` and from
// `NotesnookLiveWriteCapability`: an existing read-only caller cannot
// acquire a conflict-observation path by accident, and the conflict
// observer cannot acquire a write path or a sync path.
// ---------------------------------------------------------------------------

export type NotesnookLocalConflictRuntime = Readonly<{
  observer: NotesnookLocalConflictObserver;
  cleanup?: () => void | Promise<void>;
}>;

export type RunConflictCommandOptions = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Constructed ONLY after the parser, the credential-carrier policy,
   * the body / id / revision / sync-mode policy, and the explicit gate
   * have all passed.
   */
  createObserverRuntime?: () =>
    | Promise<NotesnookLocalConflictRuntime>
    | NotesnookLocalConflictRuntime;
}>;

// ---------------------------------------------------------------------------
// Parser.
// ---------------------------------------------------------------------------

function invalidParseInput(): ParseConflictCommandResult {
  return { kind: "error", exitCode: 2, message: "nookctl conflicts: invalid command input" };
}

/**
 * Parse `argv` (the part of `process.argv` AFTER the `conflicts` token).
 *
 * The parser is total: it returns either a validated command or a
 * categorical error.  It reads nothing outside `argv` / `env`,
 * constructs nothing, and touches no filesystem or database.
 */
export function parseConflictCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseConflictCommandResult {
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
      const credFlag = FORBIDDEN_ARG_FLAGS.find(
        (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
      );
      if (credFlag !== undefined) {
        return {
          kind: "error",
          exitCode: 2,
          message: "refusing to read credentials from a CLI flag; use an interactive TTY prompt",
        };
      }
      const bodyFlag = FORBIDDEN_BODY_FLAGS.find(
        (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
      );
      if (bodyFlag !== undefined) {
        return {
          kind: "error",
          exitCode: 2,
          message: "refusing to read note content from a CLI flag; observation is read-only",
        };
      }
      const idFlag = FORBIDDEN_IDENTIFIER_FLAGS.find(
        (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
      );
      if (idFlag !== undefined) {
        return {
          kind: "error",
          exitCode: 2,
          message:
            "refusing to read identifiers from a CLI flag; use --title for an exact title lookup",
        };
      }
      const syncFlag = FORBIDDEN_SYNC_FLAGS.find(
        (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
      );
      if (syncFlag !== undefined) {
        return {
          kind: "error",
          exitCode: 2,
          message: "refusing to read a sync-mode flag; observation is read-only and non-mutating",
        };
      }
    }

    const subcommand = stringArgv[0] ?? "help";
    switch (subcommand) {
      case "help":
      case "--help":
      case "-h":
        return { kind: "parsed", command: { kind: "help", subcommand: "help" } };
      case "list":
        if (stringArgv.length !== 1) return invalidParseInput();
        return { kind: "parsed", command: { kind: "list", subcommand: "list" } };
      case "observe":
        return parseObserve(stringArgv);
      default:
        return {
          kind: "error",
          exitCode: 2,
          message: "nookctl conflicts: unknown subcommand; use `nookctl conflicts help`",
        };
    }
  } catch {
    return invalidParseInput();
  }
}

function matchesFlag(argument: string, flag: string): boolean {
  return argument === flag || argument.startsWith(`${flag}=`);
}

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

function parseObserve(argv: readonly string[]): ParseConflictCommandResult {
  let title: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === undefined) return invalidParseInput();
    if (matchesFlag(current, "--title")) {
      if (title !== undefined) return invalidParseInput();
      const read = readFlagValue(argv, index, "--title");
      if (read === undefined || !isBoundedExactTitle(read.value)) return invalidParseInput();
      title = read.value;
      index = read.next;
    } else {
      return invalidParseInput();
    }
  }
  if (title === undefined) return invalidParseInput();
  return { kind: "parsed", command: { kind: "observe", subcommand: "observe", title } };
}

// ---------------------------------------------------------------------------
// Help.
// ---------------------------------------------------------------------------

export function formatConflictHelp(): string {
  return [
    "nookctl conflicts — Stage 5 operator-only local conflict observation",
    "",
    "Usage:",
    "  nookctl conflicts list                  observe the local conflict marker list",
    "  nookctl conflicts observe --title <title>",
    "                                        observe the marker for an exact note title",
    "  nookctl conflicts help                  show this help",
    "",
    "Read-only observation only:",
    "  This command NEVER mutates, NEVER resolves, and NEVER triggers",
    "  remote synchronization (send / full / fetch / force).  It inspects",
    "  only the device-local conflict marker the Stage 5 projection exposes.",
    "",
    "Credential boundary:",
    "  Password, MFA, and token bytes are read only from an interactive TTY",
    "  (see `nookctl auth live-login`). They cannot be supplied through argv",
    "  or environment variables. Observation commands require",
    `  ${LIVE_CONFLICT_ENABLE_ENV}=1.`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

type NormalizedRunOptions = {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  createObserverRuntime?: () =>
    | Promise<NotesnookLocalConflictRuntime>
    | NotesnookLocalConflictRuntime;
};

function normalizeRunConflictOptions(options: unknown): NormalizedRunOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("invalid conflict options");
  }
  const candidate = options as Record<string, unknown>;
  const argv = candidate.argv;
  if (!Array.isArray(argv)) throw new Error("invalid conflict argv");
  const safeArgv = Array.from(argv as readonly unknown[]);
  if (!safeArgv.every((argument): argument is string => typeof argument === "string")) {
    throw new Error("invalid conflict argv");
  }
  const env = candidate.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error("invalid conflict env");
  }
  const sourceEnv = env as Record<string, unknown>;
  const snapshot: Record<string, string | undefined> = Object.create(null);
  for (const name of Object.getOwnPropertyNames(sourceEnv)) {
    const entry = sourceEnv[name];
    if (entry !== undefined && typeof entry !== "string") throw new Error("invalid conflict env");
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
  const createObserverRuntime = candidate.createObserverRuntime;
  if (createObserverRuntime !== undefined && typeof createObserverRuntime !== "function") {
    throw new Error("invalid conflict runtime factory");
  }
  return {
    argv: Object.freeze(safeArgv),
    env: Object.freeze(snapshot),
    ...(createObserverRuntime === undefined
      ? {}
      : {
          createObserverRuntime: createObserverRuntime as () =>
            | Promise<NotesnookLocalConflictRuntime>
            | NotesnookLocalConflictRuntime,
        }),
  };
}

/**
 * Run `nookctl conflicts <subcommand>`.
 *
 * Ordering is load-bearing and asserted by the offline tests:
 *
 *   1. normalize options;
 *   2. parse argv + reject credential / body / id / revision / sync-mode
 *      carriers;
 *   3. `help` short-circuits with no gate and no runtime;
 *   4. gate check — a missing or non-`1` opt-in returns exit code 2 and
 *      NEVER calls `createObserverRuntime`;
 *   5. construct the runtime;
 *   6. dispatch exactly one list / observe call against the
 *      separately-named `NotesnookLocalConflictObserver`;
 *   7. project the result into a bounded categorical report;
 *   8. always await cleanup exactly once.
 */
export async function runConflictCommand(
  options: RunConflictCommandOptions,
): Promise<RunConflictCommandResult> {
  let normalized: NormalizedRunOptions;
  try {
    normalized = normalizeRunConflictOptions(options);
  } catch {
    return { kind: "error", exitCode: 2, message: "nookctl conflicts: invalid command input" };
  }

  const parsed = parseConflictCommand(normalized.argv, normalized.env);
  if (parsed.kind === "error") {
    return { kind: "error", exitCode: parsed.exitCode, message: parsed.message };
  }
  const command = parsed.command;
  if (command.kind === "help") {
    return { kind: "help", text: formatConflictHelp() };
  }

  const enabled =
    Object.prototype.hasOwnProperty.call(normalized.env, LIVE_CONFLICT_ENABLE_ENV) &&
    normalized.env[LIVE_CONFLICT_ENABLE_ENV] === "1";
  if (!enabled) {
    return {
      kind: "error",
      exitCode: 2,
      message: `nookctl conflicts ${command.subcommand} is disabled; set ${LIVE_CONFLICT_ENABLE_ENV}=1`,
    };
  }

  if (typeof normalized.createObserverRuntime !== "function") {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl conflicts: local conflict observer is unavailable",
    };
  }

  let runtime: NotesnookLocalConflictRuntime;
  try {
    runtime = await normalized.createObserverRuntime();
  } catch {
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl conflicts: local conflict observer could not be constructed",
    };
  }

  let outcome: RunConflictCommandResult;
  let cleanupFailed = false;
  try {
    outcome = await dispatchObservation(runtime.observer, command);
  } catch {
    outcome = {
      kind: "error",
      exitCode: 2,
      message: `nookctl conflicts ${command.subcommand}: local conflict observation failed`,
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
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl conflicts: observation teardown failed",
    };
  }
  return outcome;
}

const MAX_CONFLICT_RECORDS = 256;
const INTERNAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Dispatch exactly one bounded observer operation. */
async function dispatchObservation(
  observer: NotesnookLocalConflictObserver,
  command: Exclude<ParsedConflictCommand, { kind: "help" }>,
): Promise<RunConflictCommandResult> {
  if (command.kind === "list") return dispatchList(observer);
  return dispatchObserve(observer, command.title);
}

async function dispatchList(
  observer: NotesnookLocalConflictObserver,
): Promise<RunConflictCommandResult> {
  try {
    const conflicts = await observer.listLocalConflicts();
    if (!Array.isArray(conflicts)) throw new Error("invalid result");
    const count = conflicts.length;
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_CONFLICT_RECORDS) {
      throw new Error("invalid result");
    }
    return {
      kind: "report",
      subcommand: "list",
      report: { kind: count > 0 ? "observed" : "not-observed", count },
    };
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl conflicts list: local conflict observation failed",
    };
  }
}

async function dispatchObserve(
  observer: NotesnookLocalConflictObserver,
  title: string,
): Promise<RunConflictCommandResult> {
  // Resolve the exact title into a candidate id from the conflict-marked
  // metadata, then ask the observer to prove the marker on that exact id.
  // This keeps the operator input title-only while retaining the projection's
  // request-identity binding and explicit `conflicted === true` proof.
  try {
    const conflicts = await observer.listLocalConflicts();
    if (!Array.isArray(conflicts)) throw new Error("invalid result");
    const count = conflicts.length;
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_CONFLICT_RECORDS) {
      throw new Error("invalid result");
    }
    for (let index = 0; index < count; index += 1) {
      const metadata = conflicts[index];
      if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error("invalid result");
      }
      const id = readOwnString(metadata, "id");
      const candidateTitle = readOwnString(metadata, "title");
      if (id === undefined || candidateTitle === undefined || !isInternalIdentifier(id)) {
        throw new Error("invalid result");
      }
      if (candidateTitle !== title) continue;

      const observation = await observer.observeNoteConflict(id);
      if (observation === false) {
        return { kind: "report", subcommand: "observe", report: { kind: "not-observed" } };
      }
      if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
        throw new Error("invalid result");
      }
      const observedId = readOwnString(observation, "id");
      const observedTitle = readOwnString(observation, "title");
      const marker = Reflect.getOwnPropertyDescriptor(observation, "conflicted");
      if (
        observedId !== id ||
        observedTitle !== title ||
        marker === undefined ||
        !Object.prototype.hasOwnProperty.call(marker, "value") ||
        marker.value !== true
      ) {
        throw new Error("invalid result");
      }
      return { kind: "report", subcommand: "observe", report: { kind: "observed" } };
    }
    return { kind: "report", subcommand: "observe", report: { kind: "not-observed" } };
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl conflicts observe: local conflict observation failed",
    };
  }
}

function readOwnString(value: object, key: "id" | "title"): string | undefined {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    return undefined;
  }
  return typeof descriptor.value === "string" ? descriptor.value : undefined;
}

function isInternalIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && INTERNAL_ID_PATTERN.test(value);
}

/**
 * Render a {@link RunConflictCommandResult} as a single-line,
 * redacted, fixed-categorical text.  Title, id, body, revision, path,
 * cause, and stack are NEVER printed.
 */
export function formatConflictCommandResult(result: RunConflictCommandResult): string {
  switch (result.kind) {
    case "help":
      return result.text;
    case "error":
      return result.message;
    case "report": {
      const category = result.report.kind;
      if (result.subcommand === "list") {
        const count = result.report.count ?? 0;
        return `nookctl conflicts ${result.subcommand}: ${category} (count=${count})`;
      }
      return `nookctl conflicts ${result.subcommand}: ${category}`;
    }
  }
}
