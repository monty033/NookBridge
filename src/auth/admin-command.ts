/**
 * Stage 2B — administrative `nookctl auth` command plumbing.
 *
 * Scope of this slice:
 *
 *   - Parse `nookctl auth <login|status|logout|reset-local-client>` plus
 *     its flags into a typed result.
 *   - Reject any attempt to supply a password, MFA/TOTP code, or other
 *     credential via argv, ordinary environment variables, or any
 *     other non-secret channel.  The Stage 2 plan requires interactive
 *     secret input through an echo-disabled TTY seam — that input is
 *     collected by `secret-input.ts`, not by this module.
 *   - Provide a runner that, given a parsed command, returns a stable
 *     "deferred" outcome with NO credential handling.  Real account
 *     login (Notesnook core login API, MFA verification, token
 *     persistence) is deliberately deferred to a later reviewed task
 *     that wires in the upstream reconnaissance.
 *
 * The runner deliberately fails closed: even `login` (the command that
 * a future slice will implement) returns a `DeferredAuthOutcome` so the
 * CLI surface exists today, can be documented, and can be tested for
 * credential hygiene, but never pretends to authenticate.
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
import type { AuthSession } from "./types.js";

/**
 * The `auth` subcommands we recognise in this slice.  The set is a
 * superset of the Stage 2 plan's admin commands (lines 542-546 of the
 * implementation plan) but every entry currently resolves to the same
 * deferred outcome — the upstream login API is not wired in yet.
 */
export type AuthSubcommand = "login" | "status" | "logout" | "reset-local-client" | "help";

export type ParsedAuthCommand =
  | Readonly<{
      kind: "login";
      subcommand: "login";
    }>
  | Readonly<{
      kind: "status";
      subcommand: "status";
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
  "--password",
  "--passwd",
  "--mfa",
  "--totp",
  "--secret",
  "--stdin-secret",
  "--token",
];

const FORBIDDEN_ENV_VARS: readonly string[] = [
  "NOOKBRIDGE_PASSWORD",
  "NOOKBRIDGE_PASSWD",
  "NOOKBRIDGE_MFA",
  "NOOKBRIDGE_TOTP",
  "NOOKBRIDGE_SECRET",
  "NOOKCTL_PASSWORD",
  "NOOKCTL_MFA",
];

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
      case "status":
        return {
          kind: "parsed",
          command: { kind: "status", subcommand: "status" },
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
    "  nookctl auth status          show local auth state (deferred)",
    "  nookctl auth logout          clear local auth state (deferred)",
    "  nookctl auth reset-local-client  wipe local auth state (deferred)",
    "  nookctl auth help            show this help",
    "",
    "Credential boundary:",
    "  Password and MFA codes are read from an echo-disabled TTY.",
    "  They cannot be supplied via --password/--mfa flags or via",
    "  NOOKBRIDGE_PASSWORD/NOOKBRIDGE_MFA environment variables.",
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
      outcome: DeferredAuthOutcome;
      session: AuthSession;
    }>
  | Readonly<{
      kind: "help";
      text: string;
    }>
  | Readonly<{
      kind: "error";
      message: string;
      exitCode: 2;
    }>;

type NormalizedRunAuthOptions = Readonly<{
  argv: unknown;
  env: unknown;
  prompt: unknown;
  maxAttempts: unknown;
  exerciseLoginPipeline: unknown;
  exerciseLiveLogin: unknown;
  liveProviderFactory: unknown;
}>;

function normalizeRunAuthOptions(options: unknown): NormalizedRunAuthOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error("invalid auth options");
  }
  const candidate = options as Record<string, unknown>;
  return {
    argv: candidate.argv,
    env: candidate.env,
    prompt: candidate.prompt,
    maxAttempts: candidate.maxAttempts,
    exerciseLoginPipeline: candidate.exerciseLoginPipeline,
    exerciseLiveLogin: candidate.exerciseLiveLogin,
    liveProviderFactory: candidate.liveProviderFactory,
  };
}

function invalidRunAuthInput(): RunAuthCommandResult {
  return { kind: "error", exitCode: 2, message: "nookctl auth: invalid command input" };
}

/**
 * Run the `nookctl auth <subcommand>` plumbing.
 *
 * In this slice every command resolves to either a structured
 * "deferred" outcome (no work performed) or, when the caller opts in
 * with `exerciseLoginPipeline: true`, to a fully-collected
 * email + password + optional MFA triplet that is then zeroized.
 * The runner never calls into a provider, never opens
 * PersistentStorage, and never talks to the network.
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

  const parsed = parseAuthCommand(
    normalized.argv as readonly string[],
    normalized.env as Readonly<Record<string, string | undefined>>,
  );
  if (parsed.kind === "error") {
    return { kind: "error", exitCode: 2, message: parsed.message };
  }
  const command = parsed.command;

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
            subcommand: "login",
            status: "deferred",
            message:
              "live notesnook login pipeline exercised; no real account session was committed to persistent storage",
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

  // `status`, `logout`, and `reset-local-client` all return the same
  // structured deferred outcome — none of them touches a real session
  // or persistent storage in this slice.
  const message = deferredMessageFor(command.kind);
  return {
    kind: "deferred",
    outcome: {
      subcommand: command.kind,
      status: "deferred",
      message,
    },
  };
}

function deferredMessageFor(subcommand: AuthSubcommand): string {
  switch (subcommand) {
    case "status":
      return "local auth status reporting is deferred until PersistentStorage-backed session records are wired in";
    case "logout":
      return "local auth logout is deferred until PersistentStorage-backed session records are wired in";
    case "reset-local-client":
      return "reset-local-client is deferred until PersistentStorage-backed session records are wired in";
    case "login":
    case "help":
      // Both are handled above; reaching here is a programmer error.
      throw new Error(`deferredMessageFor called for non-deferred subcommand ${subcommand}`);
  }
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
