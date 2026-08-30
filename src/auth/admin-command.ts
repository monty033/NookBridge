/**
 * Stage 2B — administrative `nookctl auth` command plumbing.
 *
 * Scope of this slice:
 *
 *   - Parse `nookctl auth <login|live-login|status|logout|reset-local-client>` plus
 *     its flags into a typed result.
 *   - Reject any attempt to supply a password, MFA/TOTP code, or other
 *     credential via argv, ordinary environment variables, or any
 *     other non-secret channel.  The Stage 2 plan requires interactive
 *     secret input through an echo-disabled TTY seam — that input is
 *     collected by `secret-input.ts`, not by this module.
 *   - Provide a runner whose ordinary `login` remains deferred, while the
 *     explicitly gated live commands delegate to the runtime-only core seam.
 *
 * The ordinary runner deliberately fails closed: `login` remains deferred.
 * `live-login` and credential-free local session commands require the exact
 * operator gate before the core runtime is constructed.
 *
 * Stage 1 / Stage 2A behaviour, exports, and CLI shape remain
 * backward-compatible: `doctor` still works exactly as before, and
 * parsing errors are reported with the same exit-code semantics as the
 * Stage 1 CLI (exit code 2 for invocation errors).
 */

import {
  collectEmail,
  collectMfaCode,
  collectPassword,
  isSecretInputEof,
  isSecretInputPromptFailure,
  type CollectedSecret,
  type SecretPrompt,
} from "./secret-input.js";
import { runLiveAuthCommand, type LiveProviderFactory } from "./live-auth-runner.js";
import type { NotesnookReadOnlyDatabase } from "../core/notesnook-readonly-adapter.js";
import type { NotesnookLiveWriteCapability } from "../core/notesnook-write-admin.js";
import type { NotesnookLiveRemoteSyncCapability } from "../core/notesnook-live-remote-sync.js";
import type { AuthSession } from "./types.js";

/**
 * The `auth` subcommands we recognise in this slice.  The set is a
 * superset of the Stage 2 plan's admin commands (lines 542-546 of the
 * implementation plan). Ordinary login remains deferred; the local session
 * commands are explicitly gated because they open persisted client state.
 */
export type AuthSubcommand =
  | "login"
  | "live-login"
  | "status"
  | "logout"
  | "reset-local-client"
  | "help";

export type ParsedAuthCommand =
  | Readonly<{
      kind: "login";
      subcommand: "login";
    }>
  | Readonly<{
      kind: "live-login";
      subcommand: "live-login";
    }>
  | Readonly<{
      kind: "status";
      subcommand: "status";
      forceRefresh: boolean;
    }>
  | Readonly<{
      kind: "logout";
      subcommand: "logout";
    }>
  | Readonly<{
      kind: "reset-local-client";
      subcommand: "reset-local-client";
    }>
  | Readonly<{
      kind: "help";
      subcommand: "help";
    }>;

/**
 * Result returned by the deferred auth runner.
 *
 * Every entry explicitly states that no credential was processed and
 * no persistent state was written.  This makes it impossible for a
 * caller (or a downstream test) to mistake a Stage 2B deferred run for
 * a successful login.
 */
export type DeferredAuthOutcome = Readonly<{
  subcommand: AuthSubcommand;
  status: "deferred";
  message: string;
}>;

/**
 * Parse `argv` (the part of `process.argv` AFTER the `auth` token)
 * into a {@link ParsedAuthCommand}.
 *
 * The parser:
 *
 *   - Recognises exactly the five subcommands listed above.  Anything
 *     else returns `{ kind: "error", ... }`.
 *   - Rejects any `--password`, `--mfa`, `--totp`, `--secret`, or
 *     `--stdin-secret` flag with a clear error.  Even though those
 *     flags would never produce a real session, accepting them would
 *     teach users to pass credentials through argv — which is exactly
 *     what the Stage 2 plan forbids.
 *   - Rejects any environment override that would smuggle a password
 *     or MFA code (`NOOKBRIDGE_PASSWORD`, `NOOKBRIDGE_MFA`,
 *     `NOOKBRIDGE_TOTP`, `NOOKCTL_PASSWORD`).  The presence of any of
 *     those variables is an error, not a silent ignore, because
 *     silently ignoring them lets the secret leak somewhere the
 *     runner cannot see it.
 *   - Does NOT read `process.env` itself.  The caller passes an
 *     explicit `env` snapshot so tests are deterministic and so the
 *     parser does not become a process-global reader.
 */
export type ParseAuthCommandResult =
  | Readonly<{ kind: "parsed"; command: ParsedAuthCommand }>
  | Readonly<{ kind: "error"; message: string; exitCode: 2 }>;

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

export const LIVE_AUTH_ENABLE_ENV = "NOOKBRIDGE_ENABLE_LIVE_AUTH" as const;

export function parseAuthCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParseAuthCommandResult {
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

    // Copy both roots inside the protective boundary.  This validates array
    // element types and also exercises hostile proxy iterators/getters without
    // ever interpolating their values into a diagnostic.
    const safeArgv = Array.from(argv as readonly unknown[]);
    if (!safeArgv.every((argument): argument is string => typeof argument === "string")) {
      return invalidParseInput();
    }
    const stringArgv = safeArgv as string[];

    // Read every own environment value inside the same boundary.  The parser
    // does not use the values, but reading them makes hostile getters fail
    // closed rather than silently converting a malformed snapshot to success.
    for (const name of Object.keys(env)) {
      const value = (env as Record<string, unknown>)[name];
      if (value !== undefined && typeof value !== "string") return invalidParseInput();
    }

    // Env-var check first: a forbidden variable means a caller tried to
    // hand us a secret, and we must not pretend the command is valid.  The
    // `in` check deliberately keeps presence semantics (including undefined)
    // and is protected against a hostile Proxy `has` trap.
    for (const name of FORBIDDEN_ENV_VARS) {
      // Read through the same protected boundary as ordinary environment
      // values so hostile getters fail closed.  Presence is still checked
      // separately with `in`, which includes inherited carriers and keeps
      // undefined-valued carriers forbidden.
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

    // Argv check: any forbidden flag, including an equals-form flag with an
    // attached value, is an error. Report only the categorical flag name.
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
      case "login":
        return { kind: "parsed", command: { kind: "login", subcommand: "login" } };
      case "live-login":
        if (stringArgv.length !== 1) return invalidParseInput();
        return {
          kind: "parsed",
          command: { kind: "live-login", subcommand: "live-login" },
        };
      case "status":
        if (
          stringArgv.length !== 1 &&
          !(stringArgv.length === 2 && stringArgv[1] === "--refresh")
        ) {
          return invalidParseInput();
        }
        return {
          kind: "parsed",
          command: {
            kind: "status",
            subcommand: "status",
            forceRefresh: stringArgv[1] === "--refresh",
          },
        };
      case "logout":
        return {
          kind: "parsed",
          command: { kind: "logout", subcommand: "logout" },
        };
      case "reset-local-client":
        return {
          kind: "parsed",
          command: {
            kind: "reset-local-client",
            subcommand: "reset-local-client",
          },
        };
      case "help":
      case "--help":
      case "-h":
        return {
          kind: "parsed",
          command: { kind: "help", subcommand: "help" },
        };
      default:
        return {
          kind: "error",
          exitCode: 2,
          message: "nookctl auth: unknown subcommand; use `nookctl auth help`",
        };
    }
  } catch {
    return invalidParseInput();
  }
}

function invalidParseInput(): ParseAuthCommandResult {
  return { kind: "error", exitCode: 2, message: "nookctl auth: invalid command input" };
}

/**
 * Render the human-readable help text for `nookctl auth`.  The text is
 * deliberately explicit about the credential boundary so that an
 * operator who reaches for `--password` is steered back to the
 * interactive prompt.
 */
export function formatAuthHelp(): string {
  return [
    "nookctl auth — Stage 2B administrative auth command",
    "",
    "Usage:",
    "  nookctl auth login           collect credentials interactively (deferred)",
    "  nookctl auth live-login      gated live account login via an echo-disabled TTY",
    "  nookctl auth status [--refresh]  show or explicitly refresh gated local auth state",
    "  nookctl auth logout          clear gated local auth state",
    "  nookctl auth reset-local-client  clear gated local auth state",
    "  nookctl auth help            show this help",
    "",
    "Credential boundary:",
    "  Password and MFA codes are read from an echo-disabled TTY.",
    "  They cannot be supplied via --password/--mfa flags or via",
    "  NOOKBRIDGE_PASSWORD/NOOKBRIDGE_MFA environment variables.",
    "  Live commands require NOOKBRIDGE_ENABLE_LIVE_AUTH=1.",
    "",
  ].join("\n");
}

/**
 * Options accepted by {@link runAuthCommand}.  The injection seam is
 * narrow: an optional prompt, an env snapshot, an argv snapshot,
 * and (opt-in) a live provider factory.
 *
 * The prompt is OPTIONAL because the only subcommand that ever
 * reaches for it is `login` when `exerciseLoginPipeline` or
 * `exerciseLiveLogin` is true — and even then only when the caller
 * explicitly opts in (production CLI runs never opt in).
 * `auth help`, `auth status`, `auth logout`, `auth
 * reset-local-client`, and the deferred `auth login` branch must
 * all run without ever constructing a real TTY prompt.  That keeps
 * them usable in non-TTY contexts (CI, scripts, containers) and
 * prevents accidental stdin probing on commands that don't need
 * credentials.
 *
 * The runner does not read `process.argv`/`process.env` on its own.
 */
export type RunAuthCommandOptions = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Optional prompt/TTY seam.  Only consulted when the runner is
   * asked to exercise the secret-collection pipeline.  In all other
   * branches the runner MUST NOT touch `prompt`.
   */
  prompt?: SecretPrompt;
  /**
   * Maximum number of attempts for any single secret prompt.  Defaults
   * to 3.  Empty input is retried up to this many times; EOF or a
   * malformed stream raises immediately.  Only consulted when
   * `exerciseLoginPipeline` or `exerciseLiveLogin` is true.
   */
  maxAttempts?: number;
  /**
   * Test hook.  When true, `login` exercises the secret-input
   * collection pipeline (so the test can verify that passwords and
   * MFA codes are actually collected and zeroized) but still stops
   * short of any account-side network call.  Defaults to false so
   * production CLI runs that hit `login` never reach for the prompt
   * unless a future slice wires the real login API in.  When this is
   * true and `prompt` is omitted the runner throws a clear error.
   */
  exerciseLoginPipeline?: boolean;
  /**
   * Opt-in flag for the explicit live runner.  When true AND
   * `liveProviderFactory` is supplied, `login` delegates to
   * {@link runLiveAuthCommand}, which collects credentials through
   * the prompt, drives the {@link LiveNotesnookAuthProvider}, and
   * zeroizes every captured buffer.  Defaults to false so the
   * production CLI default (deferred) remains unchanged.
   */
  exerciseLiveLogin?: boolean;
  /**
   * Provider factory used by the explicit live runner.  Required
   * when `exerciseLiveLogin` is true.  The runner constructs a
   * fresh provider per invocation so each prompt cycle owns its
   * supplier closures and its buffers.
   */
  liveProviderFactory?: LiveProviderFactory;
  /** Runtime-only production wiring for the explicitly gated live-login command. */
  liveLogin?: LiveLoginRuntimeOptions;
}>;

export type LiveLoginRuntime = Readonly<{
  providerFactory: LiveProviderFactory;
  cleanup: () => void | Promise<void>;
  /** Flattened Stage 3 read-only surface when the runtime is production-backed. */
  readOnly?: NotesnookReadOnlyDatabase;
  /**
   * Separately named Stage 4 local write capability when the runtime is
   * production-backed.  Distinct from `readOnly`; the auth tree never uses
   * it, and no read-only caller can reach a write path through it.
   */
  localWrite?: NotesnookLiveWriteCapability;
  /** Separately named explicit Stage 4 remote synchronization capability. */
  remoteSync?: NotesnookLiveRemoteSyncCapability;
}>;

export type LiveLoginRuntimeOptions = Readonly<{
  stateDir: string;
  createPrompt: () => SecretPrompt;
  createRuntime: (options: { stateDir: string }) => Promise<LiveLoginRuntime>;
}>;

export type RunAuthCommandResult =
  | Readonly<{
      kind: "deferred";
      outcome: DeferredAuthOutcome;
    }>
  | Readonly<{
      kind: "exercised-login";
      outcome: DeferredAuthOutcome;
      /**
       * The captured credentials in the order they were read: email,
       * password, then optional MFA code.  Each entry is the raw
       * `CollectedSecret` returned by the secret-input module so the
       * caller (or the test) can assert on its bytes and call
       * `.zero()` to wipe them.  Production callers must `zero()` all
       * three; tests do so explicitly.
       */
      captured: ReadonlyArray<CollectedSecret | string>;
    }>
  | Readonly<{
      /**
       * Live login result.  Returned when `exerciseLiveLogin` is
       * true and `liveProviderFactory` is supplied.  The session is
       * the refresh-token-free `AuthSession` returned by the live
       * provider.  The runner has already zeroized every captured
       * buffer by the time this branch returns.
       */
      kind: "live-login";
      outcome: Readonly<{
        subcommand: "live-login";
        status: "authenticated";
        message: string;
      }>;
      session: AuthSession;
    }>
  | Readonly<{
      kind: "help";
      text: string;
    }>
  | Readonly<{
      kind: "auth-state";
      outcome: Readonly<{
        subcommand: "status" | "logout" | "reset-local-client";
        status: "authenticated" | "signed-out";
        message: string;
      }>;
    }>
  | Readonly<{
      kind: "error";
      message: string;
      exitCode: 2 | 3;
    }>;

type NormalizedRunAuthOptions = Readonly<{
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  prompt: unknown;
  maxAttempts: unknown;
  exerciseLoginPipeline: unknown;
  exerciseLiveLogin: unknown;
  liveProviderFactory: unknown;
  liveLogin: unknown;
}>;

function normalizeRunAuthOptions(options: unknown): NormalizedRunAuthOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("invalid auth options");
  }
  const candidate = options as Record<string, unknown>;
  return {
    argv: snapshotAuthArgv(candidate.argv),
    env: snapshotAuthEnv(candidate.env),
    prompt: candidate.prompt,
    maxAttempts: candidate.maxAttempts,
    exerciseLoginPipeline: candidate.exerciseLoginPipeline,
    exerciseLiveLogin: candidate.exerciseLiveLogin,
    liveProviderFactory: candidate.liveProviderFactory,
    liveLogin: candidate.liveLogin,
  };
}

function snapshotAuthArgv(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("invalid auth argv");
  const argv = Array.from(value as readonly unknown[]);
  if (!argv.every((argument): argument is string => typeof argument === "string")) {
    throw new Error("invalid auth argv");
  }
  return Object.freeze(argv);
}

function snapshotAuthEnv(value: unknown): Readonly<Record<string, string | undefined>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid auth environment");
  }
  const source = value as Record<string, unknown>;
  const out = Object.create(null) as Record<string, string | undefined>;
  for (const name of Object.getOwnPropertyNames(source)) {
    const entry = source[name];
    if (entry !== undefined && typeof entry !== "string") {
      throw new Error("invalid auth environment");
    }
    Object.defineProperty(out, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: entry,
    });
  }
  // Preserve inherited forbidden-carrier presence without reading inherited
  // values. Only an own, snapshotted property can enable live-login.
  for (const name of FORBIDDEN_ENV_VARS) {
    if (!(name in source) || Object.prototype.hasOwnProperty.call(out, name)) continue;
    Object.defineProperty(out, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: undefined,
    });
  }
  return Object.freeze(out);
}

function invalidRunAuthInput(): RunAuthCommandResult {
  return { kind: "error", exitCode: 2, message: "nookctl auth: invalid command input" };
}

/**
 * Run the `nookctl auth <subcommand>` plumbing.
 *
 * Ordinary commands resolve to structured deferred outcomes. The explicit
 * `live-login` command is enabled only by its exact non-secret gate and uses
 * the supplied prompt/runtime seams; no other command opens local state.
 */
export async function runAuthCommand(
  options: RunAuthCommandOptions,
): Promise<RunAuthCommandResult> {
  // Options are caller-controlled runtime data.  Normalize the root and all
  // properties before any field access can escape the protective boundary.
  // In particular, a Proxy/getter must not be able to expose its error text.
  let normalized: NormalizedRunAuthOptions;
  try {
    normalized = normalizeRunAuthOptions(options);
  } catch {
    return invalidRunAuthInput();
  }

  const parsed = parseAuthCommand(normalized.argv, normalized.env);
  if (parsed.kind === "error") {
    return { kind: "error", exitCode: 2, message: parsed.message };
  }
  const command = parsed.command;

  if (command.kind === "live-login") {
    return runOperatorLiveLogin(normalized);
  }

  if (
    command.kind === "status" ||
    command.kind === "logout" ||
    command.kind === "reset-local-client"
  ) {
    return runOperatorSessionCommand(
      normalized,
      command.kind,
      command.kind === "status" && command.forceRefresh,
    );
  }

  if (command.kind === "help") {
    return { kind: "help", text: formatAuthHelp() };
  }

  // `login` is the only subcommand that ever reaches for the secret
  // prompt in this slice.  When the operator opts in via
  // `exerciseLoginPipeline`, the runner collects a full email +
  // password + MFA triplet and zeroizes each secret before
  // returning.  When the operator opts in via `exerciseLiveLogin`,
  // the runner delegates to {@link runLiveAuthCommand}, which
  // drives the explicit live provider.  The default behaviour is
  // the production one: refuse to do anything until the upstream
  // Notesnook core login API is wired in by a future reviewed
  // slice.
  if (command.kind === "login") {
    if (normalized.exerciseLiveLogin === true) {
      // exerciseLiveLogin is opt-in and requires both an injected
      // prompt and an injected provider factory.  The production
      // CLI never sets this flag, so a missing factory is a
      // programmer error — fail loudly rather than silently
      // reaching for `process.stdin` or building a real handle.
      if (normalized.prompt === undefined) {
        throw categoricalAuthError(
          "runAuthCommand: exerciseLiveLogin=true requires an injected prompt; refusing to read secrets from a global stdin",
        );
      }
      if (typeof normalized.liveProviderFactory !== "function") {
        throw categoricalAuthError(
          "runAuthCommand: exerciseLiveLogin=true requires an injected liveProviderFactory",
        );
      }
      const liveOpts: {
        command: "login" | "logout" | "status" | "noop";
        prompt: SecretPrompt;
        providerFactory: LiveProviderFactory;
        maxAttempts?: number;
      } = {
        command: "login",
        prompt: normalized.prompt as SecretPrompt,
        providerFactory: normalized.liveProviderFactory as LiveProviderFactory,
      };
      if (normalized.maxAttempts !== undefined) {
        liveOpts.maxAttempts = normalized.maxAttempts as number;
      }
      try {
        const live = await runLiveAuthCommand(liveOpts);
        if (live.kind !== "authenticated") {
          return {
            kind: "error",
            exitCode: 2,
            message:
              live.kind === "error"
                ? live.message
                : "live notesnook runner did not produce an authenticated session",
          };
        }
        return {
          kind: "live-login",
          outcome: {
            subcommand: "live-login",
            status: "authenticated",
            message: "live Notesnook login pipeline exercised; credentials were not retained",
          },
          session: live.session,
        };
      } catch (error) {
        if (isSecretInputPromptFailure(error)) {
          throw categoricalAuthError("nookctl auth: credential input failed");
        }
        throw error;
      }
    }
    if (normalized.exerciseLoginPipeline !== true) {
      return {
        kind: "deferred",
        outcome: {
          subcommand: "login",
          status: "deferred",
          message:
            "interactive account login is deferred until the upstream Notesnook core login API is reviewed and wired in",
        },
      };
    }
    // exerciseLoginPipeline is opt-in and requires an injected
    // prompt.  The production CLI never sets this flag, so a missing
    // prompt here is a programmer error — fail loudly rather than
    // silently reaching for `process.stdin`.
    if (normalized.prompt === undefined) {
      throw categoricalAuthError(
        "runAuthCommand: exerciseLoginPipeline=true requires an injected prompt; refusing to read secrets from a global stdin",
      );
    }
    const pipelineOpts: { prompt: SecretPrompt; maxAttempts?: number } = {
      prompt: normalized.prompt as SecretPrompt,
    };
    if (normalized.maxAttempts !== undefined) {
      pipelineOpts.maxAttempts = normalized.maxAttempts as number;
    }
    try {
      return await exerciseLoginPipeline(pipelineOpts);
    } catch (error) {
      if (isSecretInputPromptFailure(error)) {
        throw categoricalAuthError("nookctl auth: credential input failed");
      }
      throw error;
    }
  }

  throw categoricalAuthError("runAuthCommand: unreachable auth subcommand");
}

async function runOperatorSessionCommand(
  options: NormalizedRunAuthOptions,
  command: "status" | "logout" | "reset-local-client",
  forceRefresh: boolean,
): Promise<RunAuthCommandResult> {
  const enabled =
    Object.prototype.hasOwnProperty.call(options.env, LIVE_AUTH_ENABLE_ENV) &&
    options.env[LIVE_AUTH_ENABLE_ENV] === "1";
  if (!enabled) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl auth state commands are disabled; set NOOKBRIDGE_ENABLE_LIVE_AUTH=1",
    };
  }
  const candidate = options.liveLogin;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { kind: "error", exitCode: 2, message: "nookctl auth state runtime is unavailable" };
  }
  const runtimeOptions = candidate as LiveLoginRuntimeOptions;
  if (
    typeof runtimeOptions.stateDir !== "string" ||
    typeof runtimeOptions.createRuntime !== "function"
  ) {
    return { kind: "error", exitCode: 2, message: "nookctl auth state runtime is unavailable" };
  }
  let runtime: LiveLoginRuntime | undefined;
  try {
    runtime = await runtimeOptions.createRuntime({ stateDir: runtimeOptions.stateDir });
    const live = await runLiveAuthCommand({
      command: command === "status" ? (forceRefresh ? "refresh" : "status") : "logout",
      // Status/logout never read this prompt; retain the runner's closed
      // interface without opening stdin in a non-interactive command.
      prompt: { readSecretLine: async () => null, writeLine: () => undefined },
      providerFactory: runtime.providerFactory,
    });
    if (live.kind === "error" || live.kind === "noop") {
      return {
        kind: "error",
        exitCode: 2,
        message: live.kind === "error" ? live.message : "nookctl auth state operation failed",
      };
    }
    return {
      kind: "auth-state",
      outcome: {
        subcommand: command,
        status: live.kind === "authenticated" ? "authenticated" : "signed-out",
        message:
          command === "status"
            ? "local authenticated state inspected; no credentials were read"
            : live.kind === "signed-out" && live.warning !== undefined
              ? `${live.warning}; no credentials were read`
              : "local authenticated state cleared; no credentials were read",
      },
    };
  } catch {
    return { kind: "error", exitCode: 2, message: "nookctl auth state operation failed" };
  } finally {
    try {
      await runtime?.cleanup();
    } catch {
      /* result is already categorical */
    }
  }
}

function runOperatorLiveLogin(options: NormalizedRunAuthOptions): Promise<RunAuthCommandResult> {
  return runOperatorLiveLoginAsync(options);
}

async function runOperatorLiveLoginAsync(
  options: NormalizedRunAuthOptions,
): Promise<RunAuthCommandResult> {
  let enabled = false;
  try {
    const env = options.env;
    enabled =
      Object.prototype.hasOwnProperty.call(env, LIVE_AUTH_ENABLE_ENV) &&
      env[LIVE_AUTH_ENABLE_ENV] === "1";
  } catch {
    return { kind: "error", exitCode: 2, message: "nookctl auth: invalid command input" };
  }
  if (!enabled) {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl auth live-login is disabled; set NOOKBRIDGE_ENABLE_LIVE_AUTH=1",
    };
  }

  let runtimeOptions: LiveLoginRuntimeOptions;
  try {
    const candidate = options.liveLogin;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return {
        kind: "error",
        exitCode: 2,
        message: "nookctl auth live-login runtime is unavailable",
      };
    }
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.stateDir !== "string" ||
      typeof record.createPrompt !== "function" ||
      typeof record.createRuntime !== "function"
    ) {
      return {
        kind: "error",
        exitCode: 2,
        message: "nookctl auth live-login runtime is unavailable",
      };
    }
    runtimeOptions = {
      stateDir: record.stateDir,
      createPrompt: record.createPrompt as () => SecretPrompt,
      createRuntime: record.createRuntime as LiveLoginRuntimeOptions["createRuntime"],
    };
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl auth live-login runtime is unavailable",
    };
  }

  let prompt: SecretPrompt;
  try {
    prompt = runtimeOptions.createPrompt();
  } catch {
    return {
      kind: "error",
      exitCode: 3,
      message: "nookctl auth live-login requires an interactive TTY",
    };
  }

  let runtime: LiveLoginRuntime;
  try {
    runtime = await runtimeOptions.createRuntime({ stateDir: runtimeOptions.stateDir });
  } catch {
    return {
      kind: "error",
      exitCode: 2,
      message: "nookctl auth live-login could not initialize local state",
    };
  }

  let result: RunAuthCommandResult;
  try {
    const live = await runLiveAuthCommand({
      command: "login",
      prompt,
      providerFactory: runtime.providerFactory,
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts as number }),
    });
    if (live.kind !== "authenticated") {
      result = {
        kind: "error",
        exitCode: live.kind === "error" ? 2 : 3,
        message: live.kind === "error" ? live.message : "live notesnook login did not authenticate",
      };
    } else {
      result = {
        kind: "live-login",
        outcome: {
          subcommand: "live-login",
          status: "authenticated",
          message: "live Notesnook login authenticated; credentials were not retained",
        },
        session: live.session,
      };
    }
  } catch {
    result = {
      kind: "error",
      exitCode: 2,
      message: "nookctl auth live-login failed",
    };
  }

  try {
    await runtime.cleanup();
  } catch {
    if (result.kind === "live-login") {
      return {
        kind: "error",
        exitCode: 2,
        message: "nookctl auth live-login local cleanup failed",
      };
    }
  }
  return result;
}

/**
 * Internal helper that drives the secret-input pipeline end-to-end and
 * zeroizes every captured secret before returning.  Extracted so it can
 * be unit-tested independently of the runner's deferred branches.
 */
async function exerciseLoginPipeline(options: {
  prompt: SecretPrompt;
  maxAttempts?: number;
}): Promise<Extract<RunAuthCommandResult, { kind: "exercised-login" }>> {
  const prompt = options.prompt;
  const maxAttempts = options.maxAttempts;
  const collectOpts: { prompt: SecretPrompt; maxAttempts?: number } = { prompt };
  if (maxAttempts !== undefined) collectOpts.maxAttempts = maxAttempts;

  const email = await collectEmail(collectOpts);

  const password = await collectPassword(collectOpts);
  let mfa: CollectedSecret | undefined;
  try {
    mfa = await collectMfaCode(collectOpts);
  } catch (error) {
    // MFA is optional; if the prompt closes before a code is entered
    // we report the credential pipeline as completed without an MFA
    // step.  The error must not contain the password bytes.
    if (!isSecretInputEof(error)) {
      password.zero();
      throw error;
    }
    mfa = undefined;
  }

  // Zeroize in reverse order so we never leave the password in memory
  // longer than necessary while still wiping every secret the
  // pipeline touched.
  if (mfa) mfa.zero();
  password.zero();

  const captured: Array<CollectedSecret | string> = [email, password];
  if (mfa) captured.push(mfa);
  return {
    kind: "exercised-login",
    outcome: {
      subcommand: "login",
      status: "deferred",
      message: "credential-input pipeline exercised; no real account login was attempted",
    },
    captured,
  };
}

/** Create a public auth-command error with no injected chain or raw details. */
function categoricalAuthError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  return error;
}
