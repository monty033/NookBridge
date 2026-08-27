/**
 * Stage 2B-live — explicit live auth runner.
 *
 * This module is the only place that drives the live
 * {@link LiveNotesnookAuthProvider} from the CLI boundary.  It is
 * intentionally narrow and pure:
 *
 *   - It accepts the {@link SecretPrompt}, a provider factory
 *     closure, and a parsed {@link LiveAuthCommandKind}.
 *   - It collects credentials ONLY through the prompt; it never
 *     reads `process.argv`, `process.env`, or `process.stdin`
 *     directly.
 *   - It converts the captured `Buffer` bytes to a string ONLY for
 *     the immediate provider call or supplier call, and zeroizes
 *     every collected buffer in a `finally` block before returning.
 *   - It returns a REDACTED result — no `refresh_token`, no
 *     password, no MFA code, no email.  The public surface is a
 *     status string plus, for `login`, a refresh-token-free
 *     `AuthSession`.
 *   - It is OPT-IN.  Production CLI runs do not reach for this
 *     module; the existing `runAuthCommand` in `admin-command.ts`
 *     preserves its deferred default and only consults this
 *     runner when the caller wires in the
 *     `liveProviderFactory` / `exerciseLiveLogin` seam.
 *
 * The runner performs no live account call itself: every
 * credential it collects is passed straight to the provider's
 * `login` method, which is what actually performs the upstream
 * `core.user.authenticate*` rounds through the narrow live handle.
 * In offline tests the factory closure injects a fake handle, so
 * no real network call happens.
 */

import type { Buffer } from "node:buffer";

import {
  collectEmail,
  collectMfaCode,
  collectPassword,
  isSecretInputEof,
  isSecretInputPromptFailure,
  type CollectedSecret,
  type SecretPrompt,
} from "./secret-input.js";
import type { AuthSession } from "./types.js";
import type { LiveMfaSupplier, LivePasswordSupplier } from "./live-notesnook-auth-provider.js";
import type { AuthProvider } from "./types.js";

/**
 * The narrow public surface the runner exposes.  Each result kind
 * is intentionally categorical and never carries a refresh token,
 * password, MFA code, or email body.
 */
export type RunLiveAuthResult =
  | Readonly<{
      kind: "authenticated";
      /**
       * Redacted auth session.  `refresh_token` is NEVER present
       * here even though the upstream envelope carries one; the
       * provider is the boundary that drops it.
       */
      session: AuthSession;
    }>
  | Readonly<{
      kind: "signed-out";
      status: "signed-out";
    }>
  | Readonly<{
      kind: "noop";
      message: string;
    }>
  | Readonly<{
      kind: "error";
      message: string;
    }>;

/**
 * A factory closure that produces a fresh provider instance given
 * the runner's one-shot password and MFA suppliers.  The factory
 * owns the lifetime of the underlying narrow live handle; the
 * runner only sees the provider it produces.
 */
export type LiveProviderFactory = (options: {
  passwordSupplier: LivePasswordSupplier;
  mfaSupplier: LiveMfaSupplier;
}) => AuthProvider;

/**
 * Options for {@link runLiveAuthCommand}.  The runner never reads
 * process globals; the caller passes the parsed command, the
 * prompt, the provider factory, and an optional max-attempts cap.
 */
export type RunLiveAuthCommandOptions = Readonly<{
  /**
   * The pre-parsed CLI command.  The runner only honors `login`,
   * `logout`, and `status` / `noop`; other subcommands resolve to
   * a `noop` outcome.
   */
  command: LiveAuthCommandKind;
  /** The injected prompt/TTY seam. */
  prompt: SecretPrompt;
  /**
   * Factory closure that produces a fresh provider instance given
   * the runner's suppliers.  The runner constructs a fresh
   * provider per `login` invocation so each prompt cycle gets its
   * own buffer-bound suppliers.
   */
  providerFactory: LiveProviderFactory;
  /** Maximum secret-input attempts.  Defaults to 3. */
  maxAttempts?: number;
}>;

/**
 * The narrow set of subcommands the live runner honors.
 */
export type LiveAuthCommandKind = "login" | "logout" | "status" | "noop";

/**
 * Drive a single explicit live auth command end-to-end.
 *
 * Hard invariants:
 *
 *   - The runner collects credentials ONLY through the injected
 *     {@link SecretPrompt}.  It NEVER reads `process.argv`,
 *     `process.env`, `process.stdin`, or any other global.
 *   - Every captured `Buffer` is zeroized in a `finally` block.
 *     The runner returns a redacted outcome that never carries the
 *     password, MFA code, email, or refresh_token bytes.
 *   - The runner does NOT cache credentials.  Each call creates
 *     its own prompt collection.
 *   - `login` constructs a fresh provider via the supplied
 *     `providerFactory` and calls `provider.login({ username, password })`
 *     directly.  The supplier closures yielded by the runner
 *     consume each captured buffer exactly once and then yield
 *     `null`, after which the provider's retry loop terminates.
 *   - `logout` constructs a fresh provider with no-op suppliers
 *     (because the runner is the only path that owns credentials,
 *     and logout never needs them) and calls `provider.logout(...)`.
 *   - `status` and unrecognized subcommands return `noop` without
 *     touching the provider.
 */
export async function runLiveAuthCommand(
  options: RunLiveAuthCommandOptions,
): Promise<RunLiveAuthResult> {
  const normalized = normalizeOptions(options);

  switch (normalized.command) {
    case "login":
      return runLogin(normalized);
    case "logout":
      return runLogout(normalized);
    case "status":
      return {
        kind: "noop",
        message: "live notesnook status reporting is not wired in this slice",
      };
    case "noop":
      return {
        kind: "noop",
        message: "live notesnook runner: unsupported subcommand",
      };
  }
}

type NormalizedRunnerOptions = Readonly<{
  command: LiveAuthCommandKind;
  prompt: SecretPrompt;
  providerFactory: LiveProviderFactory;
  maxAttempts: number;
}>;

function normalizeOptions(options: unknown): NormalizedRunnerOptions {
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw runnerError("invalid runLiveAuthCommand options");
    }
    const candidate = options as Record<string, unknown>;
    const command = candidate.command;
    if (command !== "login" && command !== "logout" && command !== "status" && command !== "noop") {
      throw runnerError("invalid runLiveAuthCommand command");
    }
    const prompt = candidate.prompt;
    if (typeof prompt !== "object" || prompt === null) {
      throw runnerError("runLiveAuthCommand prompt is required");
    }
    const promptRecord = prompt as Record<string, unknown>;
    const readSecretLine = promptRecord.readSecretLine;
    const writeLine = promptRecord.writeLine;
    if (typeof readSecretLine !== "function" || typeof writeLine !== "function") {
      throw runnerError("runLiveAuthCommand prompt is invalid");
    }
    const providerFactory = candidate.providerFactory;
    if (typeof providerFactory !== "function") {
      throw runnerError("runLiveAuthCommand providerFactory is required");
    }
    const rawMaxAttempts = candidate.maxAttempts ?? 3;
    if (
      typeof rawMaxAttempts !== "number" ||
      !Number.isInteger(rawMaxAttempts) ||
      rawMaxAttempts <= 0
    ) {
      throw runnerError("runLiveAuthCommand maxAttempts must be a positive integer");
    }
    // Bind the prompt methods once so a hostile proxy swap after this point
    // cannot change the captured behavior.
    const capturedPrompt = prompt as SecretPrompt;
    const boundRead = readSecretLine as (arg: { prompt: string }) => Promise<Buffer | null>;
    const boundWrite = writeLine as (text: string) => void;
    return {
      command,
      prompt: {
        readSecretLine(arg) {
          return boundRead.call(capturedPrompt, arg);
        },
        writeLine(text) {
          return boundWrite.call(capturedPrompt, text);
        },
      },
      providerFactory: providerFactory as LiveProviderFactory,
      maxAttempts: rawMaxAttempts,
    };
  } catch (error) {
    if (isRunnerError(error)) throw error;
    throw runnerError("invalid runLiveAuthCommand options");
  }
}

async function runLogin(options: NormalizedRunnerOptions): Promise<RunLiveAuthResult> {
  const collectOpts = { prompt: options.prompt, maxAttempts: options.maxAttempts };
  let email: string | undefined;
  let password: CollectedSecret | undefined;
  let mfa: CollectedSecret | undefined;

  try {
    email = await collectEmail(collectOpts);
    password = await collectPassword(collectOpts);
    try {
      mfa = await collectMfaCode(collectOpts);
    } catch (error) {
      // MFA is optional; an EOF is treated as "no MFA round".
      if (!isSecretInputEof(error)) {
        throw error;
      }
      mfa = undefined;
    }

    // Build one-shot suppliers that consume each buffer exactly once.
    // The suppliers convert the buffer to a UTF-8 string on the
    // immediate call and zeroize the buffer before yielding, so the
    // provider never observes a buffer whose contents can outlive the
    // supplier closure.
    const passwordSupplier = makeOneShotSupplier(password);
    const mfaSupplier = makeOneShotSupplier(mfa);

    const provider = options.providerFactory({
      passwordSupplier,
      mfaSupplier,
    });

    // Build the credentials object.  The password buffer is converted
    // to a string here and the resulting string lives only in this
    // local; the buffer is zeroized by `makeOneShotSupplier` when the
    // supplier fires (or in the finally block if the supplier is never
    // called).
    const credentials = {
      username: email,
      password: password.bytes.toString("utf8"),
    };

    const session = await provider.login(credentials);

    return { kind: "authenticated", session };
  } catch (error) {
    if (isSecretInputPromptFailure(error)) {
      return { kind: "error", message: "live notesnook runner: credential input failed" };
    }
    if (isSecretInputEof(error)) {
      return { kind: "error", message: "live notesnook runner: credential input ended" };
    }
    return {
      kind: "error",
      message: "live notesnook runner: login failed",
    };
  } finally {
    // Zeroize in reverse-collection order so the password bytes never
    // linger after the runner has finished using them.  The email is
    // a plain string (not a Buffer); the runner does not attempt to
    // wipe it because JavaScript strings are immutable.
    if (mfa) mfa.zero();
    if (password) password.zero();
    email = undefined;
  }
}

/**
 * Build a one-shot supplier closure that consumes a captured buffer
 * exactly once.  The supplier:
 *
 *   1. Converts the buffer to a UTF-8 string on the immediate call.
 *   2. Zeroizes the buffer BEFORE returning so the provider cannot
 *      observe stale bytes from a re-read.
 *   3. Yields `null` on every subsequent call so the provider's
 *      retry loop terminates deterministically.
 */
function makeOneShotSupplier(
  captured: CollectedSecret | undefined,
): LivePasswordSupplier & LiveMfaSupplier {
  let consumed = false;
  const supplier = async (): Promise<string | null> => {
    if (consumed || !captured) {
      if (captured) captured.zero();
      return null;
    }
    consumed = true;
    const view = captured.bytes.toString("utf8");
    captured.zero();
    return view;
  };
  return supplier as LivePasswordSupplier & LiveMfaSupplier;
}

async function runLogout(options: NormalizedRunnerOptions): Promise<RunLiveAuthResult> {
  // Logout does not need credentials, so the suppliers are no-ops.
  const noopSupplier: LivePasswordSupplier & LiveMfaSupplier = async () => null;
  const provider = options.providerFactory({
    passwordSupplier: noopSupplier,
    mfaSupplier: noopSupplier,
  });
  // The runner does not persist a session reference across calls.
  // Logout is invoked with a synthetic empty session — the provider
  // ignores the session argument and operates against its own
  // operation epoch / active-session flag, so this is safe.
  await provider.logout({
    userId: "",
    accessToken: "",
    issuedAt: 0,
    expiresAt: 0,
  });
  return { kind: "signed-out", status: "signed-out" };
}

/**
 * Create a chain-free runner error.  Mirrors the categorical error
 * pattern used elsewhere in the auth boundary.
 */
const RUNNER_ERROR_MARKER = Symbol("nookbridge.runnerError");

function runnerError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  Object.defineProperty(error, RUNNER_ERROR_MARKER, { configurable: false, value: true });
  return error;
}

function isRunnerError(value: unknown): value is Error {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { [RUNNER_ERROR_MARKER]?: unknown })[RUNNER_ERROR_MARKER] === true
    );
  } catch {
    return false;
  }
}
