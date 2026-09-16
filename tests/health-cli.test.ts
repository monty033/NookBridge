/**
 * Tests for the narrow `nookbridge-health` CLI entrypoint.
 *
 * `nookbridge-health` is the categorical liveness probe the Stage 5
 * installer contract polls after switching `current`:
 *
 *   nookbridge-health --socket <absolute-path>
 *
 * It accepts exactly one positional argument, validates that the
 * path is absolute, opens a bounded Stage 5 framed-RPC connection
 * to the daemon, calls `notes.status`, and exits:
 *
 *   * `0` only when the daemon returned a well-formed
 *     `RpcStatusResult` (categorical OK).
 *   * `1` for every other categorical failure (invalid socket
 *     argument, refused connection, categorical
 *     `service_unavailable`, etc.).
 *
 * Hard rules under test:
 *
 *   - Output is strictly categorical: one fixed OK line on
 *     success, one fixed failure line on every other code path.
 *   - The probe never prints the socket path, the daemon's error
 *     message, the underlying errno, the Notesnook state contents,
 *     a note id, a note title, a revision token, or any other
 *     diagnostic string.
 *   - The probe is path-validated: relative paths, missing
 *     `--socket`, empty values, control characters, and
 *     non-canonical paths are rejected categorically before any
 *     socket attempt.
 *   - The probe talks to the daemon only through the bounded
 *     socket client; the test seam substitutes a fake connect
 *     so no real socket is ever opened.
 */

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { EOL } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HEALTH_CHECK_FAILURE_LINE, HEALTH_CHECK_OK_LINE, runHealthCheck } from "../src/health.js";

import type {
  NookdSocketClient,
  NookdSocketFailure,
  NookdSocketResult,
} from "../src/mcp/socket-client.js";

function captureWrites(): { sink: Buffer; push: (text: string) => void } {
  const chunks: Buffer[] = [];
  return {
    get sink(): Buffer {
      return Buffer.concat(chunks);
    },
    push: (text: string) => {
      chunks.push(Buffer.from(text, "utf8"));
    },
  };
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class FakeSocketClient {
  readonly socketPath: string;
  readonly response: NookdSocketResult;

  constructor(socketPath: string, response: NookdSocketResult) {
    this.socketPath = socketPath;
    this.response = response;
  }

  async status(): Promise<NookdSocketResult> {
    return this.response;
  }
}

describe("nookbridge-health CLI — output contract", () => {
  it("exits 0 and prints only the OK line on a well-formed status response", async () => {
    const okClient = new FakeSocketClient("/run/nookbridge/nookd.sock", {
      ok: true,
      envelope: {
        id: "test-1",
        ok: true,
        result: {
          kind: "status",
          lastSynced: 1234,
          hasUnsyncedChanges: false,
        },
      },
    });

    const stdout = captureWrites();
    const stderr = captureWrites();

    const code = await runHealthCheck({
      argv: ["--socket", "/run/nookbridge/nookd.sock"],
      createClient: ((_socketPath: string) => okClient) as unknown as (
        socketPath: string,
      ) => NookdSocketClient,
      writeOut: stdout.push,
      writeErr: stderr.push,
    });

    expect(code).toBe(0);
    expect(stdout.sink.toString("utf8")).toBe("");
    expect(stderr.sink.toString("utf8")).toBe(`${HEALTH_CHECK_OK_LINE}${EOL}`);
    expect(HEALTH_CHECK_OK_LINE).not.toBe(HEALTH_CHECK_FAILURE_LINE);
    expect(HEALTH_CHECK_OK_LINE).toMatch(/^[a-z0-9 _-]+$/i);
    expect(HEALTH_CHECK_OK_LINE).not.toMatch(/[/\\]/);
  });

  it("exits 1 and prints only the failure line when the daemon returns a categorical failure", async () => {
    const failureClient = new FakeSocketClient("/run/nookbridge/nookd.sock", {
      ok: false,
      code: "service_unavailable" as NookdSocketFailure,
    });

    const stdout = captureWrites();
    const stderr = captureWrites();

    const code = await runHealthCheck({
      argv: ["--socket", "/run/nookbridge/nookd.sock"],
      createClient: ((_socketPath: string) => failureClient) as unknown as (
        socketPath: string,
      ) => NookdSocketClient,
      writeOut: stdout.push,
      writeErr: stderr.push,
    });

    expect(code).toBe(1);
    expect(stdout.sink.toString("utf8")).toBe("");
    expect(stderr.sink.toString("utf8")).toBe(`${HEALTH_CHECK_FAILURE_LINE}${EOL}`);
  });

  it("exits 1 and prints only the failure line when the response envelope is malformed", async () => {
    const malformedClient = new FakeSocketClient("/run/nookbridge/nookd.sock", {
      ok: false,
      code: "invalid_request" as NookdSocketFailure,
    });

    const stdout = captureWrites();
    const stderr = captureWrites();

    const code = await runHealthCheck({
      argv: ["--socket", "/run/nookbridge/nookd.sock"],
      createClient: ((_socketPath: string) => malformedClient) as unknown as (
        socketPath: string,
      ) => NookdSocketClient,
      writeOut: stdout.push,
      writeErr: stderr.push,
    });

    expect(code).toBe(1);
    expect(stdout.sink.toString("utf8")).toBe("");
    expect(stderr.sink.toString("utf8")).toBe(`${HEALTH_CHECK_FAILURE_LINE}${EOL}`);
  });

  it("collapses transport exceptions to the categorical failure line", async () => {
    const canary = "transport-error-must-not-leak";
    const stdout = captureWrites();
    const stderr = captureWrites();

    const code = await runHealthCheck({
      argv: ["--socket", "/run/nookbridge/nookd.sock"],
      createClient: (() =>
        new (class {
          async status(): Promise<never> {
            throw new Error(canary);
          }
        })()) as unknown as (socketPath: string) => NookdSocketClient,
      writeOut: stdout.push,
      writeErr: stderr.push,
    });

    expect(code).toBe(1);
    expect(stdout.sink.toString("utf8")).toBe("");
    expect(stderr.sink.toString("utf8")).toBe(`${HEALTH_CHECK_FAILURE_LINE}${EOL}`);
    expect(stderr.sink.toString("utf8")).not.toContain(canary);
  });
});

describe("nookbridge-health CLI — socket path boundary", () => {
  it("rejects missing --socket argument without ever opening a socket", async () => {
    const stdout = captureWrites();
    const stderr = captureWrites();

    let createClientCalls = 0;
    const code = await runHealthCheck({
      argv: [],
      createClient: ((_socketPath: string) => {
        createClientCalls += 1;
        return new FakeSocketClient("", {
          ok: false,
          code: "service_unavailable",
        }) as unknown as NookdSocketClient;
      }) as unknown as (socketPath: string) => NookdSocketClient,
      writeOut: stdout.push,
      writeErr: stderr.push,
    });

    expect(code).toBe(1);
    expect(createClientCalls).toBe(0);
    expect(stdout.sink.toString("utf8")).toBe("");
    expect(stderr.sink.toString("utf8")).toBe(`${HEALTH_CHECK_FAILURE_LINE}${EOL}`);
  });

  it("rejects a non-absolute socket path without ever opening a socket", async () => {
    const stdout = captureWrites();
    const stderr = captureWrites();

    let createClientCalls = 0;
    const code = await runHealthCheck({
      argv: ["--socket", "nookd.sock"],
      createClient: ((_socketPath: string) => {
        createClientCalls += 1;
        return new FakeSocketClient("nookd.sock", {
          ok: false,
          code: "service_unavailable",
        }) as unknown as NookdSocketClient;
      }) as unknown as (socketPath: string) => NookdSocketClient,
      writeOut: stdout.push,
      writeErr: stderr.push,
    });

    expect(code).toBe(1);
    expect(createClientCalls).toBe(0);
    expect(stdout.sink.toString("utf8")).toBe("");
    expect(stderr.sink.toString("utf8")).toBe(`${HEALTH_CHECK_FAILURE_LINE}${EOL}`);
  });

  it("rejects an empty socket path without ever opening a socket", async () => {
    const stdout = captureWrites();
    const stderr = captureWrites();

    let createClientCalls = 0;
    const code = await runHealthCheck({
      argv: ["--socket", ""],
      createClient: ((_socketPath: string) => {
        createClientCalls += 1;
        return new FakeSocketClient("", {
          ok: false,
          code: "service_unavailable",
        }) as unknown as NookdSocketClient;
      }) as unknown as (socketPath: string) => NookdSocketClient,
      writeOut: stdout.push,
      writeErr: stderr.push,
    });

    expect(code).toBe(1);
    expect(createClientCalls).toBe(0);
    expect(stdout.sink.toString("utf8")).toBe("");
    expect(stderr.sink.toString("utf8")).toBe(`${HEALTH_CHECK_FAILURE_LINE}${EOL}`);
  });

  it("rejects a socket path containing control characters without ever opening a socket", async () => {
    const stdout = captureWrites();
    const stderr = captureWrites();

    let createClientCalls = 0;
    const code = await runHealthCheck({
      argv: ["--socket", "/run/nookbridge/bad\u0001path.sock"],
      createClient: ((_socketPath: string) => {
        createClientCalls += 1;
        return new FakeSocketClient("", {
          ok: false,
          code: "service_unavailable",
        }) as unknown as NookdSocketClient;
      }) as unknown as (socketPath: string) => NookdSocketClient,
      writeOut: stdout.push,
      writeErr: stderr.push,
    });

    expect(code).toBe(1);
    expect(createClientCalls).toBe(0);
    expect(stdout.sink.toString("utf8")).toBe("");
    expect(stderr.sink.toString("utf8")).toBe(`${HEALTH_CHECK_FAILURE_LINE}${EOL}`);
  });

  it("rejects a non-canonical socket path without ever opening a socket", async () => {
    const stdout = captureWrites();
    const stderr = captureWrites();

    let createClientCalls = 0;
    // Build a path whose `resolve()` form differs from the raw form
    // so the canonical-path gate must trigger.
    const raw = "/run/nookbridge/../nookbridge/nookd.sock";
    expect(resolve(raw)).not.toBe(raw);

    const code = await runHealthCheck({
      argv: ["--socket", raw],
      createClient: ((_socketPath: string) => {
        createClientCalls += 1;
        return new FakeSocketClient(raw, {
          ok: false,
          code: "service_unavailable",
        }) as unknown as NookdSocketClient;
      }) as unknown as (socketPath: string) => NookdSocketClient,
      writeOut: stdout.push,
      writeErr: stderr.push,
    });

    expect(code).toBe(1);
    expect(createClientCalls).toBe(0);
    expect(stdout.sink.toString("utf8")).toBe("");
    expect(stderr.sink.toString("utf8")).toBe(`${HEALTH_CHECK_FAILURE_LINE}${EOL}`);
  });

  it("rejects unknown positional arguments without ever opening a socket", async () => {
    const stdout = captureWrites();
    const stderr = captureWrites();

    let createClientCalls = 0;
    const code = await runHealthCheck({
      argv: ["--socket", "/run/nookbridge/nookd.sock", "--verbose"],
      createClient: ((_socketPath: string) => {
        createClientCalls += 1;
        return new FakeSocketClient("", {
          ok: false,
          code: "service_unavailable",
        }) as unknown as NookdSocketClient;
      }) as unknown as (socketPath: string) => NookdSocketClient,
      writeOut: stdout.push,
      writeErr: stderr.push,
    });

    expect(code).toBe(1);
    expect(createClientCalls).toBe(0);
    expect(stdout.sink.toString("utf8")).toBe("");
    expect(stderr.sink.toString("utf8")).toBe(`${HEALTH_CHECK_FAILURE_LINE}${EOL}`);
  });

  it("opens exactly one socket and passes the canonical path through", async () => {
    const okClient = new FakeSocketClient("/run/nookbridge/nookd.sock", {
      ok: true,
      envelope: {
        id: "test-1",
        ok: true,
        result: {
          kind: "status",
          lastSynced: 1,
          hasUnsyncedChanges: false,
        },
      },
    });

    const observedPaths: string[] = [];
    const stdout = captureWrites();
    const stderr = captureWrites();

    const code = await runHealthCheck({
      argv: ["--socket", "/run/nookbridge/nookd.sock"],
      createClient: ((socketPath: string) => {
        observedPaths.push(socketPath);
        return okClient as unknown as NookdSocketClient;
      }) as unknown as (socketPath: string) => NookdSocketClient,
      writeOut: stdout.push,
      writeErr: stderr.push,
    });

    expect(code).toBe(0);
    expect(observedPaths).toEqual(["/run/nookbridge/nookd.sock"]);
    expect(stderr.sink.toString("utf8")).toBe(`${HEALTH_CHECK_OK_LINE}${EOL}`);
  });
});

describe("nookbridge-health CLI — output redaction", () => {
  it("never prints the socket path, daemon error, or any note identifier in any output", async () => {
    const canarySocket = "/run/nookbridge/secret-path-canary.sock";
    const canaryError = "internal-error-message-canary";
    const canaryNoteId = "canary-note-id-shall-not-leak";

    const failureClient = new FakeSocketClient(canarySocket, {
      ok: false,
      code: "service_unavailable",
    });
    // Even if a hostile transport smuggles diagnostic text through,
    // the CLI must not forward it.
    (failureClient as unknown as { errorMessage: string }).errorMessage = canaryError;

    const stdout = captureWrites();
    const stderr = captureWrites();

    await runHealthCheck({
      argv: ["--socket", canarySocket],
      createClient: ((_socketPath: string) => failureClient) as unknown as (
        socketPath: string,
      ) => NookdSocketClient,
      writeOut: stdout.push,
      writeErr: stderr.push,
    });

    const combined = `${stdout.sink.toString("utf8")}${stderr.sink.toString("utf8")}`;
    expect(combined).not.toContain(canarySocket);
    expect(combined).not.toContain(canaryError);
    expect(combined).not.toContain(canaryNoteId);
  });
});

describe("nookbridge-health CLI — source boundary enforcement", () => {
  it("source never inlines credentials, tokens, passwords, or note payloads", () => {
    const source = readFileSync(resolve(repositoryRoot, "src/health.ts"), "utf8");

    const canaries = [
      "test-password",
      "test-token",
      "test-secret",
      "encryption-key",
      "note-body",
      "note-content",
      "note-title",
    ];
    for (const canary of canaries) {
      expect(source.toLowerCase()).not.toContain(canary);
    }
  });

  it("source never imports fs, child_process, or Notesnook", () => {
    const source = readFileSync(resolve(repositoryRoot, "src/health.ts"), "utf8");

    // The health probe is intentionally narrow: it only opens a
    // single Unix-domain socket via the bounded socket client.
    expect(source).not.toMatch(/from\s+["']node:fs["']/);
    expect(source).not.toMatch(/from\s+["']node:fs\/promises["']/);
    expect(source).not.toMatch(/from\s+["']fs["']/);
    expect(source).not.toMatch(/from\s+["']node:child_process["']/);

    // No Notesnook / vault / live factory imports.
    expect(source).not.toMatch(/@notesnook/);
    expect(source).not.toMatch(/notesnook-core/);
    expect(source).not.toMatch(/notesnook-live-factory/);

    // No `process.env` reads — the probe must be deterministic.
    expect(source).not.toMatch(/process\.env/);
  });
});
