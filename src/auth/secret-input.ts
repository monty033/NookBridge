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
  return collectSecret({ ...options, kind: "password" });
}

/**
 * Collect an MFA / TOTP code interactively.
 *
 * Same contract as {@link collectPassword}; only the label and
 * `kind` differ.  Callers MUST NOT pre-fill the code from any other
 * source.
 */
export async function collectMfaCode(options: CollectSecretOptions): Promise<CollectedSecret> {
  return collectSecret({ ...options, kind: "mfa" });
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
  const maxAttempts = resolveMaxAttempts(options);
  const prompt = options.prompt;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    prompt.writeLine("Notesnook email:");
    const line = await prompt.readSecretLine({ prompt: "email" });
    if (line === null) {
      throw new Error("email input ended before a value was entered");
    }
    const trimmed = line.toString("utf8").trim();
    // Wipe the temporary buffer on every non-return path BEFORE we
    // continue or throw, so the bytes never linger after the loop
    // iteration ends.
    line.fill(0);
    if (trimmed.length === 0) {
      lastError = new Error(`email attempt ${attempt} of ${maxAttempts} was empty`);
      continue;
    }
    if (!looksLikeEmail(trimmed)) {
      lastError = new Error(`email attempt ${attempt} of ${maxAttempts} is malformed`);
      continue;
    }
    return trimmed;
  }

  throw lastError ?? new Error(`email input failed after ${maxAttempts} attempts`);
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
    prompt.writeLine(label);
    const line = await prompt.readSecretLine({ prompt: fieldLabel });
    if (line === null) {
      // EOF before any input.  Distinguish from "empty line".
      throw new Error(`${options.kind} input ended before a value was entered`);
    }
    if (line.length === 0) {
      lastError = new Error(`${options.kind} attempt ${attempt} of ${maxAttempts} was empty`);
      continue;
    }
    return wrap(options.kind, line);
  }

  throw lastError ?? new Error(`${options.kind} input failed after ${maxAttempts} attempts`);
}

function resolveMaxAttempts(options: CollectSecretOptions): number {
  const raw = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error("collectSecret maxAttempts must be a positive integer");
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
export function createStdioPrompt(options: CreateStdioPromptOptions = {}): SecretPrompt {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const platform = options.platform ?? process.platform;
  const spawn: SpawnSyncFn = options.spawn ?? resolveSpawnSync();

  if (!stdin || !stdout) {
    throw new Error(
      "createStdioPrompt requires a Node-style process.stdin/stdout (or injected equivalents)",
    );
  }
  if (stdin.isTTY !== true) {
    throw new Error(
      "secure secret input requires an interactive TTY on stdin; refusing to read secrets from a non-TTY stream",
    );
  }

  // Capture every piece of process-global state the prompt needs so
  // it never has to consult `process` again after construction.
  const stdinFd = stdin.fd;
  const writeOut: (text: string) => void = (text) => {
    stdout.write(`${text}\n`);
  };

  return {
    writeLine(text) {
      writeOut(text);
    },
    async readSecretLine({ prompt: _prompt }) {
      // _prompt is unused by the production implementation — it
      // exists on the seam so tests can verify which label was
      // requested without leaking the secret text into a thrown
      // error.
      return readLineWithEchoControl({ stdin, stdinFd, platform, spawn });
    },
  };
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

/**
 * Capture the current echo state, disable echo, run the read, and
 * restore the original state on every exit path.
 *
 * Fail-closed invariants:
 *   - The captured restore token must be non-empty; if `stty -g`
 *     fails (e.g. the fd is detached) we throw immediately without
 *     attempting the read.
 *   - The `stty -echo` invocation must exit 0; a non-zero status
 *     throws immediately without attempting the read.
 *   - Restoration runs unconditionally in a finally block.
 *   - All three `stty` invocations receive an explicit `stdio`
 *     tuple that pins child stdin to the captured fd, so the
 *     shell-out operates on the controlling terminal.
 *
 * The helper is the only place in this file that performs POSIX
 * `stty` shell-outs.
 */
async function readLineWithEchoControl(input: {
  stdin: CapturedStdin;
  stdinFd: number;
  platform: PlatformLiteral;
  spawn: SpawnSyncFn;
}): Promise<Buffer | null> {
  const { stdin, stdinFd, platform, spawn } = input;
  if (platform !== "linux" && platform !== "darwin" && platform !== "freebsd") {
    throw new Error(
      `secure secret input is only supported on POSIX terminals; refusing to run on platform "${platform}"`,
    );
  }

  // Every stty invocation binds child stdin to the captured fd so the
  // child operates on the same controlling terminal the helper reads
  // from.  `stty` writes to stdout/stderr ("ioctl failed" et al.) —
  // we capture them into the result so any leak would surface in
  // tests, and we never re-emit them.
  const stdio: SttySpawnOptions["stdio"] = [stdinFd, "pipe", "pipe"];

  // 1. Capture the current echo state as a restore token.  An empty
  //    token means the terminal is detached or `stty` is unavailable;
  //    either way we MUST NOT proceed to read a secret.
  const captureResult = spawn("stty", ["-g"], { stdio });
  if (captureResult.error) {
    throw new Error(
      "failed to capture terminal echo state (stty -g failed): refusing to read a secret",
    );
  }
  if (captureResult.status !== 0) {
    throw new Error(
      `failed to capture terminal echo state (stty -g exited with status ${captureResult.status}): refusing to read a secret`,
    );
  }
  const restoreToken = captureResult.stdout.trim();
  if (restoreToken.length === 0) {
    throw new Error(
      "empty stty restore token: refusing to read a secret from a terminal whose state we cannot restore",
    );
  }

  // 2. Disable echo.  Throw on failure — we MUST NOT read a secret
  //    while echo is on.
  const disableResult = spawn("stty", ["-echo"], { stdio });
  if (disableResult.error || disableResult.status !== 0) {
    throw new Error(
      `failed to disable terminal echo (stty -echo exited with status ${disableResult.status ?? "spawn-error"}): refusing to read a secret`,
    );
  }

  try {
    return await readOneLineFromStream(stdin);
  } finally {
    // 3. Restore the original state.  Failure is swallowed but
    //    surfaced through the audit sink — we are already in a
    //    finally and must not mask any original error.
    try {
      const restoreResult = spawn("stty", [restoreToken], { stdio });
      if (restoreResult.error || restoreResult.status !== 0) {
        echoAuditSink(
          `echo restoration failed: stty exited with status ${restoreResult.status ?? "spawn-error"}`,
        );
      }
    } catch {
      echoAuditSink("echo restoration threw an unexpected error");
    }
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
  if (stdin.isTTY !== true) {
    // Belt-and-braces: the constructor already checked, but a later
    // close() could leave us here.  Fail closed.
    return Promise.reject(new Error("stdin is no longer a TTY; refusing to read a secret"));
  }
  return new Promise((resolve, reject) => {
    const buffer: Buffer[] = [];
    let settled = false;
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
    };
    const settleOnce = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      // Only act on the first newline-terminated chunk; the prompt
      // contract is exactly one line per secret.
      const newlineAt = bytes.indexOf(0x0a);
      if (newlineAt === -1) {
        buffer.push(bytes);
        return;
      }
      const head = bytes.subarray(0, newlineAt);
      const combined =
        buffer.length === 0
          ? head
          : Buffer.concat(
              [...buffer, head],
              buffer.reduce((n, b) => n + b.length, 0) + head.length,
            );
      const trimmed = stripTrailingCarriage(combined);
      settleOnce(() => resolve(trimmed));
    };
    const onEnd = (): void => {
      const combined =
        buffer.length === 0
          ? Buffer.alloc(0)
          : Buffer.concat(
              buffer,
              buffer.reduce((n, b) => n + b.length, 0),
            );
      const trimmed = stripTrailingCarriage(combined);
      if (trimmed.length === 0) {
        settleOnce(() => resolve(null));
        return;
      }
      settleOnce(() => resolve(trimmed));
    };
    const onError = (err: Error): void => {
      settleOnce(() => reject(err));
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
  });
}

function stripTrailingCarriage(buf: Buffer): Buffer {
  if (buf.length > 0 && buf[buf.length - 1] === 0x0d) {
    return buf.subarray(0, buf.length - 1);
  }
  return buf;
}
