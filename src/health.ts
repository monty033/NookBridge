/**
 * Production `nookbridge-health` CLI entrypoint.
 *
 * `nookbridge-health` is the categorical liveness probe the Stage 5
 * installer contract polls after switching `current`.  It accepts
 * exactly one positional argument (`--socket <absolute-path>`),
 * validates that path against the same closed gate the
 * `NookdSocketClient` constructor enforces, opens a bounded
 * Stage 5 framed-RPC connection to the daemon, calls
 * `notes.status`, and exits with:
 *
 *   * `0` — categorical OK; the daemon returned a well-formed
 *     `RpcStatusResult` whose `kind` is exactly `"status"`.
 *   * `1` — every other categorical failure (invalid socket
 *     argument, refused connection, malformed envelope,
 *     `service_unavailable`, etc.).
 *
 * Hard rules:
 *
 *   - Output is strictly categorical.  No socket path, no
 *     daemon-side error message, no errno, no upstream cause, no
 *     note id, no note title, no revision token, no lastSynced
 *     timestamp, no notebook metadata may reach stdout or stderr.
 *   - The probe only talks to the daemon through the existing
 *     bounded `NookdSocketClient`.  Tests substitute a fake
 *     `createClient` seam so no real socket is ever opened.
 *   - The probe never reads, writes, or references the host
 *     filesystem, environment variables, Notesnook vault contents,
 *     daemon state directory, or live network.  It accepts only
 *     one absolute socket path and never inspects a second one.
 */

import { isAbsolute, resolve } from "node:path";
import process from "node:process";

import { NookdSocketClient } from "./mcp/socket-client.js";

/**
 * Closed set of categorical output lines this entrypoint may emit.
 *
 * `HEALTH_CHECK_OK_LINE` is written to stderr on success (the
 * daemon-side stdout is intentionally reserved so the probe can be
 * composed with future verbose modes); `HEALTH_CHECK_FAILURE_LINE`
 * is written to stderr on every other code path.  Both lines are
 * deliberately short, lowercase, hyphen-delimited, and carry no
 * socket path, error message, note id, or upstream cause.
 */
export const HEALTH_CHECK_OK_LINE = "nookbridge-health ok";
export const HEALTH_CHECK_FAILURE_LINE = "nookbridge-health failed";

/**
 * The factory seam used by `runHealthCheck` to construct a socket
 * client.  Production callers default to `NookdSocketClient`;
 * tests substitute a fake that records the path and returns a
 * canned response.
 */
export type HealthCheckClientFactory = (socketPath: string) => NookdSocketClient;

/**
 * The injectable seams for {@link runHealthCheck}.
 */
export interface HealthCheckOptions {
  /** The argv slice to parse.  Must contain exactly `--socket <path>`. */
  readonly argv: readonly string[];
  /** Override for the socket-client factory; defaults to
   *  `NookdSocketClient`.  Tests substitute a fake client here. */
  readonly createClient?: HealthCheckClientFactory;
  /** Override for stdout sink.  Defaults to `process.stdout.write`. */
  readonly writeOut?: (text: string) => void;
  /** Override for stderr sink.  Defaults to `process.stderr.write`. */
  readonly writeErr?: (text: string) => void;
}

/**
 * Validate that `value` contains no ASCII control byte.  The
 * socket path is a single opaque token from the caller's argv;
 * control characters can only be smuggled by a hostile caller,
 * and the gate refuses them before any socket attempt.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate the absolute socket path against the same gate the
 * `NookdSocketClient` constructor enforces:
 *
 *   - Must be a string.
 *   - Must be non-empty.
 *   - Must be an absolute path.
 *   - Must be canonical (`resolve(path) === path`).
 *   - Must not contain ASCII control bytes.
 *
 * Any deviation collapses to a categorical failure; the path is
 * never echoed.
 */
function isValidSocketPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    isAbsolute(value) &&
    resolve(value) === value &&
    !hasControlCharacter(value)
  );
}

/**
 * Parse the argv slice into a single validated socket path.
 *
 * The only accepted shape is exactly two tokens:
 * `--socket <absolute-path>`.  Anything else — including
 * repeated flags, missing values, unknown options, or empty
 * values — is rejected categorically.
 */
function parseSocketArg(argv: readonly string[]): string | null {
  if (argv.length !== 2) return null;
  if (argv[0] !== "--socket") return null;
  if (typeof argv[1] !== "string") return null;
  const candidate = argv[1] as unknown;
  if (!isValidSocketPath(candidate)) return null;
  return candidate;
}

/**
 * Run one health-check attempt and write the categorical result.
 *
 * Returns `0` only when the daemon returned a well-formed status
 * envelope.  Every other path — invalid argv, refused connection,
 * malformed envelope, or upstream categorical failure — returns
 * `1` and prints the categorical failure line.
 */
export async function runHealthCheck(options: HealthCheckOptions): Promise<number> {
  const writeErr = options.writeErr ?? defaultWriteErr;
  const createClient = options.createClient ?? defaultCreateClient;

  const socketPath = parseSocketArg(options.argv);
  if (socketPath === null) {
    writeErr(`${HEALTH_CHECK_FAILURE_LINE}\n`);
    return 1;
  }

  try {
    const client = createClient(socketPath);
    const response = await client.status();

    if (
      response.ok &&
      response.envelope.ok &&
      response.envelope.result !== undefined &&
      response.envelope.result !== null &&
      typeof response.envelope.result === "object" &&
      "kind" in response.envelope.result &&
      response.envelope.result.kind === "status"
    ) {
      writeErr(`${HEALTH_CHECK_OK_LINE}\n`);
      return 0;
    }
  } catch {
    // Collapse constructor and transport exceptions to the same
    // categorical failure as every other health-check failure.
  }

  writeErr(`${HEALTH_CHECK_FAILURE_LINE}\n`);
  return 1;
}

/**
 * Default stderr sink — only reached when the entrypoint is invoked
 * as a CLI.  Production callers use the injectable `writeErr` seam.
 */
function defaultWriteErr(text: string): void {
  process.stderr.write(text);
}

/**
 * Default client factory — the existing bounded `NookdSocketClient`.
 * Tests substitute a fake implementation here.
 */
function defaultCreateClient(socketPath: string): NookdSocketClient {
  return new NookdSocketClient({ socketPath });
}

/**
 * CLI dispatch.  When this module is invoked as
 * `node dist/health.js --socket <path>`, the bottom-of-file
 * branch parses argv from `process.argv.slice(2)`, runs
 * `runHealthCheck` with the default sinks, and exits with the
 * categorical code.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  runHealthCheck({ argv: process.argv.slice(2) }).then((code) => {
    process.exit(code);
  });
}
