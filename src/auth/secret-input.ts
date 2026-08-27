/**
 * Stage 2B — secure interactive secret-input boundary.
 *
 * This module is the only path through which a Stage 2B caller may obtain a
 * password or MFA/TOTP secret from a user.  It is intentionally small,
 * dependency-free, and easy to audit.
 *
 * Hard invariants (Stage 2 plan §"Stage 2 — Authentication and session
 * persistence", Security checkpoint S2, Gate 2 "credential hygiene"):
 *
 *   1. Passwords and MFA codes MUST come from an echo-disabled TTY (or an
 *      injected prompt/TTY seam in tests).  They MUST NOT be accepted via
 *      `process.argv`, ordinary environment variables, stdin pipes that
 *      echo characters back, the structured logger, or any Hermes prompt.
 *   2. Secrets leave the module only as a `Buffer` whose bytes can be
 *      overwritten by the caller.  JavaScript strings are immutable, so
 *      the module does not pretend to "erase" them — Buffer.zero() is a
 *      best-effort mitigation, not a cryptographic erasure.
 *   3. Errors raised by this module never include the captured secret
 *      bytes, the prompt text, or any line that was typed in echo mode.
 *      Error messages are categorical.
 *   4. The terminal echo state is ALWAYS restored — on success, on
 *      end-of-input (EOF), and on any thrown error — via try/finally.
 *      Restoration failure is swallowed rather than masking the original
 *      error, but is itself surfaced through the audit sink so an
 *      operator can see that restoration failed.
 *   5. Nothing in this module persists, transmits, logs, or caches a
 *      secret.  PersistentStorage is not touched here.
 *
 * Stage 2B ships this boundary and the CLI plumbing that calls it; the
 * real account login that consumes the collected credentials is deferred
 * to a later reviewed task that brings in the upstream Notesnook login
 * API.  See `docs/stage-2b.md`.
 */

import { Buffer } from "node:buffer";
import { spawnSync as defaultSpawnSync, type StdioPipe } from "node:child_process";
import process from "node:process";

/**
 * Narrow structural aliases for the Node global namespace types.
 *
 * The repo's ESLint config does not surface the `NodeJS` global to
 * the linter (only `Buffer`, `console`, and `process` are exposed),
 * so referencing `NodeJS.ReadStream` / `NodeJS.WriteStream` /
 * `NodeJS.Platform` directly is flagged as `no-undef`.  Deriving the
 * same types via `typeof` queries on the already-imported `process`
 * keeps the public seam narrow and avoids disabling lint rules or
 * mutating the eslint config.
 */
type StdinStream = typeof process.stdin;
type StdoutStream = typeof process.stdout;
type PlatformLiteral = typeof process.platform;

/** A single, typed secret collected from a user. */
export type SecretKind = "password" | "mfa";

/**
 * The narrow prompt/TTY seam this module depends on.
 *
 * The default production implementation is constructed lazily from the
 * real `process.stdin`/`process.stdout` (see {@link createStdioPrompt}),
 * but every public function in this file accepts an explicit instance so
 * tests can run deterministically without a real TTY, without spawning a
 * child process, and without leaking secrets into process state.
 *
 * The contract intentionally does NOT expose `process`, `process.env`,
 * or `process.argv`.  Callers must not smuggle credentials through any
 * of those channels; the seam is the only legitimate input source.
 */
export interface SecretPrompt {
  /**
   * Read one logical line of input WITHOUT echoing characters.
   *
   * The implementation MUST disable character echo on the underlying
   * stream before reading and MUST restore the original echo state on
   * every exit path — including EOF, throwing, and synchronous read
   * errors.
   *
   * Implementations MUST NOT include the captured bytes in any thrown
   * error, and MUST NOT log them.
   *
   * Returns `null` when the underlying stream reaches end-of-input
   * (EOF) before the user enters a non-empty line.  An empty trimmed
   * line is also reported as `null` so callers can distinguish
   * "user pressed enter with no input" from "stream ended".
   */
  readSecretLine(options: { prompt: string }): Promise<Buffer | null>;

  /**
   * Print a line of text that is NOT a secret.  Used to render prompts
   * (e.g. "Notesnook password:") before the echo is disabled.  Echo
   * state is owned by the implementation; callers do not toggle it
   * directly.
   */
  writeLine(text: string): void;
}

/** Options accepted by every credential-collection helper. */
export type CollectSecretOptions = Readonly<{
  /** The injected prompt/TTY seam. */
  prompt: SecretPrompt;
  /**
   * Maximum number of attempts before the helper throws.  Defaults to
   * 3.  The final attempt's result is the one that decides success
   * versus failure; an empty input on any attempt is a failure and is
   * retried up to `maxAttempts` times.
   */
  maxAttempts?: number;
}>;

/** A collected secret plus a single-use zeroizer. */
export type CollectedSecret = Readonly<{
  kind: SecretKind;
  /** The raw captured bytes.  Callers may pass it on, then call `zero`. */
  bytes: Buffer;
  /**
   * Overwrite the captured bytes with zeros so that the underlying
   * `Buffer` no longer contains the secret in memory.  The buffer
   * reference remains valid but its contents are wiped.  Safe to call
   * multiple times.  After `zero()` the `bytes` view still points at
   * the (now zeroed) memory region.
   *
   * Note: this is a best-effort mitigation, not a cryptographic
   * erasure.  The V8 garbage collector may have already copied the
   * bytes elsewhere, and JavaScript string representations cannot be
   * zeroed.  See `docs/stage-2b.md` §"Zeroization limitation".
   */
  zero(): void;
}>;

const DEFAULT_MAX_ATTEMPTS = 3;

type SecretInputErrorCode = "eof" | "prompt-read" | "prompt-write" | "validation";
const SECRET_INPUT_ERROR_CODE = Symbol("secret-input-error-code");

type SecretInputBoundaryError = Error & {
  [SECRET_INPUT_ERROR_CODE]?: SecretInputErrorCode;
};

function secretInputError(code: SecretInputErrorCode, message: string): Error {
  const error = new Error(message) as SecretInputBoundaryError;
  Object.defineProperty(error, SECRET_INPUT_ERROR_CODE, {
    configurable: false,
    enumerable: false,
    value: code,
  });
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  return error;
}

/** Identify the module-owned EOF control result; never match human text. */
export function isSecretInputEof(error: unknown): boolean {
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as SecretInputBoundaryError)[SECRET_INPUT_ERROR_CODE] === "eof"
    );
  } catch {
    return false;
  }
}

/** Identify prompt I/O failures for normalization at the command boundary. */
export function isSecretInputPromptFailure(error: unknown): boolean {
  try {
    const code =
      typeof error === "object" && error !== null
        ? (error as SecretInputBoundaryError)[SECRET_INPUT_ERROR_CODE]
        : undefined;
    return code === "prompt-read" || code === "prompt-write";
  } catch {
    return false;
  }
}

function writePrompt(prompt: SecretPrompt, text: string, kind: SecretKind | "email"): void {
  try {
    prompt.writeLine(text);
  } catch {
    throw secretInputError("prompt-write", `${kind} prompt write failed`);
  }
}

async function readPrompt(
  prompt: SecretPrompt,
  field: SecretKind | "email",
): Promise<Buffer | null> {
  try {
    const line = await prompt.readSecretLine({ prompt: field });
    if (line !== null && !Buffer.isBuffer(line)) {
      throw new Error("invalid prompt result");
    }
    return line;
  } catch {
    throw secretInputError("prompt-read", `${field} prompt read failed`);
  }
}

/**
 * Collect a password interactively.
 *
 * The prompt writes "Notesnook password:" (or the supplied label) to
 * the injected prompt's `writeLine` first, then reads one secret line
 * with echo disabled.  Empty input is retried up to `maxAttempts`
 * times.  After the final attempt the helper throws if no input was
 * captured.
 */
export async function collectPassword(options: CollectSecretOptions): Promise<CollectedSecret> {
  return collectSecret({ ...normalizeCollectOptions(options), kind: "password" });
}

/**
 * Collect an MFA / TOTP code interactively.
 *
 * Same contract as {@link collectPassword}; only the label and
 * `kind` differ.  Callers MUST NOT pre-fill the code from any other
 * source.
 */
export async function collectMfaCode(options: CollectSecretOptions): Promise<CollectedSecret> {
  return collectSecret({ ...normalizeCollectOptions(options), kind: "mfa" });
}

/**
 * Collect an email interactively.  Email is treated as an identifier
 * rather than a credential in this slice — it is returned as a plain
 * (non-zeroizable) string — so it does NOT exercise the echo-disabled
 * code path.  Collecting it through the same seam keeps the call
 * surface uniform and ensures the upstream Notesnook login flow can
 * later be invoked with an email + password pair without changing the
 * CLI plumbing.
 *
 * Empty input is retried up to `maxAttempts` times.  A minimal sanity
 * check rejects strings that contain whitespace or lack an `@`
 * character; the upstream server is the authority on validity, this
 * helper only filters clearly malformed input so the user gets a
 * friendlier prompt.
 */
export async function collectEmail(options: CollectSecretOptions): Promise<string> {
  const normalized = normalizeCollectOptions(options);
  const maxAttempts = normalized.maxAttempts;
  const prompt = normalized.prompt;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    writePrompt(prompt, "Notesnook email:", "email");
    const line = await readPrompt(prompt, "email");
    if (line === null) {
      throw secretInputError("eof", "email input ended before a value was entered");
    }
    const trimmed = line.toString("utf8").trim();
    // Wipe the temporary buffer on every non-return path BEFORE we
    // continue or throw, so the bytes never linger after the loop
    // iteration ends.
    line.fill(0);
    if (trimmed.length === 0) {
      lastError = secretInputError(
        "validation",
        `email attempt ${attempt} of ${maxAttempts} was empty`,
      );
      continue;
    }
    if (!looksLikeEmail(trimmed)) {
      lastError = secretInputError(
        "validation",
        `email attempt ${attempt} of ${maxAttempts} is malformed`,
      );
      continue;
    }
    return trimmed;
  }

  throw (
    lastError ?? secretInputError("validation", `email input failed after ${maxAttempts} attempts`)
  );
}

/**
 * Internal collection primitive shared by password and MFA prompts.
 *
 * The helper relies on the injected {@link SecretPrompt} to honour the
 * echo-restore contract — it does not assume anything about the
 * underlying stream.  The returned {@link CollectedSecret} wraps the
 * captured `Buffer` so the caller can zero it after use; the helper
 * itself does NOT zero the buffer because the caller may need to pass
 * it to a downstream API first.
 *
 * On every non-return path (EOF, empty line, malformed input) the
 * temporary `Buffer` is wiped in place before the iteration ends.
 * The caller therefore never observes a buffer that contains stale
 * bytes from a failed attempt.
 */
async function collectSecret(
  options: CollectSecretOptions & { kind: SecretKind },
): Promise<CollectedSecret> {
  const maxAttempts = resolveMaxAttempts(options);
  const prompt = options.prompt;
  const label = options.kind === "password" ? "Notesnook password:" : "Notesnook MFA code:";
  const fieldLabel = options.kind;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    writePrompt(prompt, label, options.kind);
    const line = await readPrompt(prompt, fieldLabel);
    if (line === null) {
      // EOF before any input.  Distinguish from "empty line".
      throw secretInputError("eof", `${options.kind} input ended before a value was entered`);
    }
    if (line.length === 0) {
      line.fill(0);
      lastError = secretInputError(
        "validation",
        `${options.kind} attempt ${attempt} of ${maxAttempts} was empty`,
      );
      continue;
    }
    return wrap(options.kind, line);
  }

  throw (
    lastError ??
    secretInputError("validation", `${options.kind} input failed after ${maxAttempts} attempts`)
  );
}

type NormalizedCollectOptions = Readonly<{
  prompt: SecretPrompt;
  maxAttempts: number;
}>;

function isSecretInputBoundaryError(error: unknown): boolean {
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as SecretInputBoundaryError)[SECRET_INPUT_ERROR_CODE] !== undefined
    );
  } catch {
    return false;
  }
}

function normalizeCollectOptions(options: unknown): NormalizedCollectOptions {
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new Error("invalid options");
    }
    const candidate = options as Record<string, unknown>;
    const rawPrompt = candidate.prompt;
    if (typeof rawPrompt !== "object" || rawPrompt === null || Array.isArray(rawPrompt)) {
      throw new Error("invalid prompt");
    }
    const promptRecord = rawPrompt as Record<string, unknown>;
    const readSecretLine = promptRecord.readSecretLine;
    const writeLine = promptRecord.writeLine;
    if (typeof readSecretLine !== "function" || typeof writeLine !== "function") {
      throw new Error("invalid prompt");
    }
    const rawMaxAttempts = candidate.maxAttempts;
    const maxAttempts = rawMaxAttempts === undefined ? DEFAULT_MAX_ATTEMPTS : rawMaxAttempts;
    if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw secretInputError("validation", "collectSecret maxAttempts must be a positive integer");
    }

    // Capture the prompt methods once. The adapter keeps the original
    // receiver while preventing later hostile getters from being re-read.
    const prompt: SecretPrompt = {
      writeLine(text) {
        return writeLine.call(rawPrompt, text);
      },
      readSecretLine(readOptions) {
        return readSecretLine.call(rawPrompt, readOptions);
      },
    };
    return { prompt, maxAttempts };
  } catch (error) {
    if (isSecretInputBoundaryError(error)) throw error;
    throw secretInputError("validation", "secret input options are invalid");
  }
}

function resolveMaxAttempts(options: CollectSecretOptions): number {
  const raw = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw secretInputError("validation", "collectSecret maxAttempts must be a positive integer");
  }
  return raw;
}

function looksLikeEmail(value: string): boolean {
  if (/\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  if (at === value.length - 1) return false;
  if (value.indexOf("@", at + 1) !== -1) return false;
  return true;
}

function wrap(kind: SecretKind, bytes: Buffer): CollectedSecret {
  let zeroed = false;
  return {
    kind,
    bytes,
    zero() {
      if (zeroed) return;
      bytes.fill(0);
      zeroed = true;
    },
  };
}

/**
 * Narrow structural type for the captured stdin stream.
 *
 * `NodeJS.ReadStream` is intentionally widened to add the runtime
 * `fd` property — `process.stdin` carries it but the type library
 * does not surface it on the generic interface.  Tests inject a
 * stream that satisfies this shape; production callers always pass
 * `process.stdin` (which carries `fd: 0`).
 */
export type CapturedStdin = StdinStream & Readonly<{ fd: number }>;

/**
 * Construction options for {@link createStdioPrompt}.
 *
 * Every field is optional.  Production callers omit all of them and
 * the prompt binds to the live `process.stdin` / `process.stdout` /
 * `process.platform` exactly once at construction time.  Tests pass
 * a complete seam so the prompt never reads `process` after
 * construction — that is the contract that makes the seam auditable.
 */
export type CreateStdioPromptOptions = Readonly<{
  /**
   * Override the stdin stream.  Defaults to `process.stdin`.  The
   * constructor captures the reference passed here and never reads
   * `process.stdin` after returning.
   */
  stdin?: CapturedStdin;
  /**
   * Override the stdout stream.  Defaults to `process.stdout`.
   * The constructor captures the reference passed here and never
   * reads `process.stdout` after returning.
   */
  stdout?: StdoutStream;
  /**
   * Override the platform check.  Defaults to `process.platform`.
   * The constructor captures the value passed here and never reads
   * `process.platform` after returning.
   */
  platform?: PlatformLiteral;
  /**
   * Override the `spawnSync` primitive used to shell out to `stty`.
   * Defaults to `node:child_process`'s `spawnSync`.  Tests inject a
   * deterministic stub via {@link __setSpawnSyncForTest} (which sets
   * a module-level override) or via this constructor option (which
   * binds it to a single returned prompt).
   */
  spawn?: SpawnSyncFn;
}>;

/**
 * Default production prompt backed by `process.stdin` and
 * `process.stdout`.
 *
 * Strategy (fail-closed):
 *
 *   1. The constructor verifies that the captured stdin stream is a
 *      real TTY (`isTTY === true`).  Reading a secret from a non-TTY
 *      pipe would either echo characters back to the terminal or
 *      rely on the caller having arranged something out-of-band; both
 *      are explicitly forbidden by the Stage 2 plan.  The constructor
 *      THROWS so callers fail fast at startup rather than at the
 *      first secret prompt.
 *   2. Each secret read captures the *current* echo state of the
 *      controlling terminal via POSIX `stty -g` (which writes a
 *      restore token such as `2505:5:bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0`).
 *      This is the *only* way to faithfully restore the prior echo
 *      state on POSIX — toggling `setRawMode(false)` is not a valid
 *      echo disable in Node (raw mode and echo are independent tty
 *      attributes), and the previous implementation's reliance on
 *      `setRawMode(false)` to disable echo is the Stage 2B bug this
 *      rewrite corrects.
 *   3. Echo is then disabled by invoking `stty -echo` against the
 *      captured stdin fd.  The command's exit status is checked; a
 *      non-zero status throws BEFORE any read is attempted, so a
 *      broken or detached tty never silently falls through to an
 *      echo-on read.
 *   4. After the read completes (success, EOF, or thrown error),
 *      echo is restored by passing the captured `-g` token to
 *      `stty` so the terminal returns to exactly its prior state.
 *      Restoration failure is swallowed (we are already in finally,
 *      and we must not mask the original error), but is exposed via
 *      {@link setEchoAuditSink} for operator diagnostics.
 *   5. The implementation never reads secrets from a non-TTY
 *      stream and never falls back to a no-op echo strategy.
 *
 * The constructor captures the four concrete values it needs (the
 * stdin stream, the stdout stream, the platform identifier, and the
 * spawnSync primitive) at construction time.  After returning, the
 * returned prompt NEVER reads `process.stdin`, `process.stdout`, or
 * `process.platform` again — the captured references and values are
 * the only legitimate source of state.  That is the seam.
 */
const PROMPT_BOUNDARY_ERROR = Symbol("secret-input-prompt-boundary-error");

type PromptBoundaryError = Error & {
  [PROMPT_BOUNDARY_ERROR]?: true;
};

function promptBoundaryError(message: string): Error {
  const error = new Error(message) as PromptBoundaryError;
  Object.defineProperty(error, PROMPT_BOUNDARY_ERROR, {
    configurable: false,
    enumerable: false,
    value: true,
  });
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  return error;
}

function isPromptBoundaryError(error: unknown): boolean {
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as PromptBoundaryError)[PROMPT_BOUNDARY_ERROR] === true
    );
  } catch {
    return false;
  }
}

/**
 * Construct a stdio prompt inside one categorical boundary.  The options,
 * process globals, stream properties, and stdout method are all caller/runtime
 * inputs at this point and may be proxies or throwing getters.
 */
export function createStdioPrompt(options: CreateStdioPromptOptions = {}): SecretPrompt {
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw promptBoundaryError("createStdioPrompt received invalid options");
    }
    const candidate = options as Record<string, unknown>;
    const stdinValue = candidate.stdin ?? process.stdin;
    const stdoutValue = candidate.stdout ?? process.stdout;
    const platformValue = candidate.platform ?? process.platform;
    const spawnValue = candidate.spawn ?? resolveSpawnSync();

    if (
      typeof stdinValue !== "object" ||
      stdinValue === null ||
      typeof stdoutValue !== "object" ||
      stdoutValue === null
    ) {
      throw promptBoundaryError("createStdioPrompt requires secure stdio streams");
    }
    const stdin = stdinValue as CapturedStdin;
    const stdout = stdoutValue as StdoutStream;
    if (stdin.isTTY !== true) {
      throw promptBoundaryError(
        "secure secret input requires an interactive TTY on stdin; refusing to read secrets from a non-TTY stream",
      );
    }
    const stdinFd = stdin.fd;
    if (!Number.isInteger(stdinFd) || stdinFd < 0) {
      throw promptBoundaryError("createStdioPrompt requires a valid stdin file descriptor");
    }
    if (typeof platformValue !== "string") {
      throw promptBoundaryError("createStdioPrompt received an invalid platform");
    }
    if (typeof spawnValue !== "function") {
      throw promptBoundaryError("createStdioPrompt received an invalid stty runner");
    }
    const stdoutWrite = stdout.write;
    if (typeof stdoutWrite !== "function") {
      throw promptBoundaryError("createStdioPrompt requires a writable stdout stream");
    }
    const platform = platformValue as PlatformLiteral;
    const spawn = spawnValue as SpawnSyncFn;
    const writeOut = (text: string): void => {
      try {
        if (typeof text !== "string") throw new Error("invalid prompt text");
        stdoutWrite.call(stdout, `${text}\n`);
      } catch {
        throw promptBoundaryError("secret prompt output failed");
      }
    };

    return {
      writeLine(text) {
        writeOut(text);
      },
      async readSecretLine(readOptions) {
        try {
          if (typeof readOptions !== "object" || readOptions === null) {
            throw promptBoundaryError("secret prompt received invalid options");
          }
          const prompt = (readOptions as { prompt?: unknown }).prompt;
          if (typeof prompt !== "string") {
            throw promptBoundaryError("secret prompt received invalid options");
          }
          void prompt;
          return await readLineWithEchoControl({ stdin, stdinFd, platform, spawn });
        } catch (error) {
          if (isPromptBoundaryError(error)) throw error;
          throw promptBoundaryError("secret prompt read failed");
        }
      },
    };
  } catch (error) {
    if (isPromptBoundaryError(error)) throw error;
    throw promptBoundaryError("createStdioPrompt could not initialize secure secret input");
  }
}

/**
 * Audit sink for echo-restore failures.  Tests and operators can
 * register a function to observe any swallow-then-swallow error
 * from the finally block.
 *
 * Default: a no-op.  Production should not log secrets; this is a
 * categorical ("echo restoration failed") diagnostic, not a
 * payload-carrying log.
 */
let echoAuditSink: (message: string) => void = () => {
  /* default no-op */
};

export function setEchoAuditSink(sink: (message: string) => void): void {
  echoAuditSink = sink;
}

export function resetEchoAuditSink(): void {
  echoAuditSink = () => {
    /* no-op */
  };
}

/**
 * Minimal shell-out result shape — declared as a structural
 * subset of `SpawnSyncReturns<string>` so we can substitute a
 * deterministic implementation in tests without depending on the
 * full node:child_process type.
 */
export type SttyResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
};

/**
 * Options the production shell-out wrapper passes to `spawnSync`.
 * The wrapper always sets `stdio` to `[inputFd, "pipe", "pipe"]`
 * so the child inherits the captured stdin fd and operates on the
 * controlling terminal — `stty` reads its terminal identity from
 * stdin, not from stdout/stderr.
 */
export type SttySpawnOptions = Readonly<{
  /** Child stdio tuple.  Index 0 is the captured stdin fd. */
  stdio: readonly [number | StdioPipe, StdioPipe, StdioPipe];
}>;

export type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: SttySpawnOptions,
) => SttyResult;

let spawnSyncOverride: SpawnSyncFn | undefined;

export function __setSpawnSyncForTest(fn: SpawnSyncFn | undefined): void {
  spawnSyncOverride = fn;
}

function resolveSpawnSync(): SpawnSyncFn {
  if (spawnSyncOverride !== undefined) {
    return spawnSyncOverride;
  }
  return (command, args, options) => {
    const result = defaultSpawnSync(command, [...args], {
      encoding: "utf8",
      stdio: [options.stdio[0], options.stdio[1], options.stdio[2]],
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
    };
  };
}

type NormalizedSttyResult = Readonly<{
  valid: boolean;
  status: number | null;
  stdout: string;
}>;

function invokeStty(
  spawn: SpawnSyncFn,
  args: readonly string[],
  stdio: SttySpawnOptions["stdio"],
): NormalizedSttyResult {
  try {
    const result: unknown = spawn("stty", args, { stdio });
    if (typeof result !== "object" || result === null) {
      return { valid: false, status: null, stdout: "" };
    }
    const candidate = result as Record<string, unknown>;
    const status = candidate.status;
    const stdout = candidate.stdout;
    const error = candidate.error;
    if (
      (status !== null && (typeof status !== "number" || !Number.isInteger(status))) ||
      typeof stdout !== "string" ||
      error !== undefined
    ) {
      return { valid: false, status: null, stdout: "" };
    }
    return { valid: true, status, stdout };
  } catch {
    return { valid: false, status: null, stdout: "" };
  }
}

/**
 * Capture the current echo state, disable echo, run the read, and
 * restore the original state on every exit path.
 */
async function readLineWithEchoControl(input: {
  stdin: CapturedStdin;
  stdinFd: number;
  platform: PlatformLiteral;
  spawn: SpawnSyncFn;
}): Promise<Buffer | null> {
  const { stdin, stdinFd, platform, spawn } = input;
  if (platform !== "linux" && platform !== "darwin" && platform !== "freebsd") {
    throw promptBoundaryError(
      "secure secret input is only supported on POSIX terminals; refusing to run on this platform",
    );
  }

  const stdio: SttySpawnOptions["stdio"] = [stdinFd, "pipe", "pipe"];
  const captureResult = invokeStty(spawn, ["-g"], stdio);
  if (!captureResult.valid || captureResult.status !== 0) {
    throw promptBoundaryError("failed to capture terminal echo state: refusing to read a secret");
  }
  const restoreToken = captureResult.stdout.trim();
  if (restoreToken.length === 0) {
    throw promptBoundaryError(
      "empty stty restore token: refusing to read a secret from a terminal whose state we cannot restore",
    );
  }

  try {
    const disableResult = invokeStty(spawn, ["-echo"], stdio);
    if (!disableResult.valid || disableResult.status !== 0) {
      throw promptBoundaryError("failed to disable terminal echo: refusing to read a secret");
    }
    return await readOneLineFromStream(stdin);
  } finally {
    const restoreResult = invokeStty(spawn, [restoreToken], stdio);
    if (!restoreResult.valid || restoreResult.status !== 0) {
      reportEchoAuditFailure();
    }
  }
}

function reportEchoAuditFailure(): void {
  try {
    echoAuditSink("echo restoration failed");
  } catch {
    // Auditing is deliberately best-effort and must never mask the
    // original prompt, terminal, or stream result.
  }
}

/**
 * Read one logical line from the captured stdin stream.
 *
 * Returns `null` on EOF before any data; returns the captured bytes
 * (without trailing newline) on success.  Resolves only once; throws
 * if the stream errors.  The returned Buffer is the caller's to
 * zero.
 *
 * The captured `stdin` is the seam.  Listeners are bound directly to
 * the supplied stream and torn down on every exit path; the helper
 * NEVER falls back to `process.stdin` or any other global.  The
 * underlying `isTTY === true` invariant is re-validated here as a
 * belt-and-braces guard against a stream that became non-TTY
 * between construction and the read.
 */
function readOneLineFromStream(stdin: CapturedStdin): Promise<Buffer | null> {
  let isTTY: unknown;
  try {
    isTTY = stdin.isTTY;
  } catch {
    return Promise.reject(promptBoundaryError("secret input stream could not be inspected"));
  }
  if (isTTY !== true) {
    return Promise.reject(
      promptBoundaryError("stdin is no longer a TTY; refusing to read a secret"),
    );
  }
  return new Promise((resolve, reject) => {
    const staging: Buffer[] = [];
    let settled = false;
    const zeroStaging = (): void => {
      for (const chunk of staging) chunk.fill(0);
      staging.length = 0;
    };
    const cleanup = (): void => {
      try {
        stdin.off("data", onData);
        stdin.off("end", onEnd);
        stdin.off("error", onError);
      } catch {
        // Listener cleanup is best-effort; staging bytes are still wiped.
      } finally {
        zeroStaging();
      }
    };
    const settleOnce = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const rejectRead = (): void => {
      settleOnce(() => reject(promptBoundaryError("secret input stream read failed")));
    };
    const onData = (chunk: Buffer | string): void => {
      let bytes: Buffer | undefined;
      try {
        bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
        const newlineAt = bytes.indexOf(0x0a);
        if (newlineAt === -1) {
          staging.push(bytes);
          return;
        }
        const head = bytes.subarray(0, newlineAt);
        const combined = Buffer.concat(
          [...staging, head],
          staging.reduce((n, b) => n + b.length, 0) + head.length,
        );
        // Copy the returned line before wiping both the accumulated chunks
        // and the current chunk (including any unread tail after the newline).
        const result = Buffer.from(stripTrailingCarriage(combined));
        combined.fill(0);
        bytes.fill(0);
        settleOnce(() => resolve(result));
      } catch {
        bytes?.fill(0);
        rejectRead();
      }
    };
    const onEnd = (): void => {
      try {
        const combined = Buffer.concat(
          staging,
          staging.reduce((n, b) => n + b.length, 0),
        );
        const result = Buffer.from(stripTrailingCarriage(combined));
        combined.fill(0);
        settleOnce(() => resolve(result.length === 0 ? null : result));
      } catch {
        rejectRead();
      }
    };
    const onError = (): void => {
      rejectRead();
    };
    try {
      stdin.on("data", onData);
      stdin.once("end", onEnd);
      stdin.once("error", onError);
    } catch {
      rejectRead();
    }
  });
}

function stripTrailingCarriage(buf: Buffer): Buffer {
  if (buf.length > 0 && buf[buf.length - 1] === 0x0d) {
    return buf.subarray(0, buf.length - 1);
  }
  return buf;
}
