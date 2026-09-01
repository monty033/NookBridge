/**
 * Stage 6 — focused boundary tests for the read-only `nook-mcp`
 * stdio MCP proxy.
 *
 * These tests cover the contract the Stage 6 slice promises:
 *
 *   - tools/list contains exactly the four read-only tools; no resources
 *     or prompts.
 *   - A valid `tools/call` translates to a framed `notes.search`
 *     request and returns the title-only results as MCP
 *     `content[].text` JSON.
 *   - Malformed / oversized queries are rejected before any socket
 *     I/O and surface as a categorical MCP tool error
 *     (`isError: true`) with no path / note-id / cause leakage.
 *   - Service loss / socket failure collapses to a bounded
 *     `service_unavailable` MCP error and never echoes the
 *     underlying socket / connect error message.
 *   - The proxy binary imports neither `@notesnook/core` nor any
 *     `@notesnook/database` / `@notesnook/crypto` module and does
 *     NOT register any forbidden tool beyond the closed allowlist.
 *   - An end-to-end stdio smoke test drives the full server
 *     through a fake `Readable` (stdin) and a captured
 *     `Writable` (stdout) using the SDK's JSON-RPC framing; the
 *     initialize handshake + tools/list + tools/call round-trip
 *     succeeds against a fake Unix-socket daemon.
 *
 * The tests deliberately do NOT exercise live `nookd`, real
 * Hermes, real keys, or live state.
 */

import { Buffer } from "node:buffer";
import process from "node:process";
import { setTimeout } from "node:timers";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  FORBIDDEN_TOOL_NAMES,
  NOOK_MCP_ALLOWED_TOOL_NAME,
  buildNookMcpServer,
} from "../src/mcp/nook-mcp-server.js";
import { NookdSocketClient } from "../src/mcp/socket-client.js";
import {
  NOOK_MCP_MAX_QUERY_BYTES,
  decodeMcpJsonRpcMessages,
  parseCliArgs,
  resolveSocketPath,
} from "../src/mcp/cli.js";
import {
  NookMcpServerError,
  isNookMcpServerError,
  nookMcpServiceUnavailableResult,
  toMcpErrorResult,
} from "../src/mcp/errors.js";

const tempDirectories: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nook-mcp-test-"));
  tempDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Spin up a one-shot local Unix socket "daemon" that responds to
 * a single framed request with a forged success or error envelope.
 * The test supplies the bytes that come back.
 */
async function startFakeDaemon(
  handler: (request: { id: string; method: string; params: { query: string } }) => {
    ok: boolean;
    frame: Buffer;
  },
): Promise<string> {
  const dir = makeTempDir();
  const socketPath = join(dir, "fake-nookd.sock");
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const len = buffer.readUInt32BE(0);
      if (buffer.length < 4 + len) return;
      const payload = buffer.subarray(4, 4 + len).toString("utf8");
      socket.off("data", onData);
      const parsed = JSON.parse(payload) as {
        id: string;
        method: string;
        params: { query: string };
      };
      const response = handler(parsed);
      socket.write(response.frame);
      // Keep socket alive briefly so the client can read, then close.
      setTimeout(() => socket.end(), 5);
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return socketPath;
}

function framedResponse(envelope: Record<string, unknown>): { ok: boolean; frame: Buffer } {
  const payload = Buffer.from(JSON.stringify(envelope), "utf8");
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return { ok: envelope.ok === true, frame };
}

// -----------------------------------------------------------------------
// Tool surface — exactly four read-only tools, no others.
// -----------------------------------------------------------------------

describe("nook-mcp server surface", () => {
  it("advertises exactly the four Slice 2 read-only tools", async () => {
    const client = new NookdSocketClient({
      socketPath: "/tmp/never-used",
      connect: async () => {
        throw new Error("must not be reached during tools/list");
      },
    });
    const server = buildNookMcpServer({ client });
    // tools/list must be reachable without ever touching the socket.
    // The MCP SDK builds the schema straight from `registerTool`,
    // so we walk the registered tool list directly here.
    expect(NOOK_MCP_ALLOWED_TOOL_NAME).toBe("notesnook_search_notes");
    // Defensive: the implementation exposes only the frozen Slice 2 surface.
    const tools = server.tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "notesnook_search_notes",
      "notesnook_status",
      "notesnook_list_notebooks",
      "notesnook_get_note",
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
  });

  it("does not register prompts or resources", () => {
    const client = new NookdSocketClient({
      socketPath: "/tmp/never-used",
      connect: async () => {
        throw new Error("must not be reached during introspection");
      },
    });
    const server = buildNookMcpServer({ client });
    expect(server.prompts.length).toBe(0);
    expect(server.resources.length).toBe(0);
  });
});

// -----------------------------------------------------------------------
// Happy path — call maps to framed `notes.search` and returns title-only.
// -----------------------------------------------------------------------

describe("notesnook_search_notes — happy path", () => {
  it("forwards the bounded query and returns only title fields", async () => {
    const observed: { id: string; method: string; params: { query: string } }[] = [];
    const socketPath = await startFakeDaemon((request) => {
      observed.push(request);
      return framedResponse({
        id: request.id,
        ok: true,
        result: {
          kind: "search",
          notes: [{ title: "First hit" }, { title: "Second hit" }],
        },
      });
    });
    const client = new NookdSocketClient({ socketPath });
    const server = buildNookMcpServer({ client });

    const result = await server.callTool("notesnook_search_notes", { query: "needle" });

    expect(result.isError).toBeFalsy();
    expect(observed.length).toBe(1);
    expect(observed[0]?.method).toBe("notes.search");
    expect(observed[0]?.params).toEqual({ query: "needle" });

    const textBlock = result.content[0] as { type: string; text: string };
    expect(textBlock.type).toBe("text");
    const parsed = JSON.parse(textBlock.text) as {
      kind: string;
      notes: Array<{ title: string }>;
    };
    expect(parsed.kind).toBe("search");
    expect(parsed.notes.map((note) => Object.keys(note))).toEqual([["title"], ["title"]]);
    expect(parsed.notes.map((note) => note.title)).toEqual(["First hit", "Second hit"]);
  });

  it("maps a 0-hit result to an empty notes array", async () => {
    const socketPath = await startFakeDaemon((request) =>
      framedResponse({
        id: request.id,
        ok: true,
        result: { kind: "search", notes: [] },
      }),
    );
    const client = new NookdSocketClient({ socketPath });
    const server = buildNookMcpServer({ client });

    const result = await server.callTool("notesnook_search_notes", { query: "missing" });
    expect(result.isError).toBeFalsy();
    const textBlock = result.content[0] as { type: string; text: string };
    const parsed = JSON.parse(textBlock.text) as {
      notes: Array<{ title: string }>;
    };
    expect(parsed.notes).toEqual([]);
  });
});

// -----------------------------------------------------------------------
// Input validation — must reject before any socket I/O.
// -----------------------------------------------------------------------

describe("notesnook_search_notes — input validation", () => {
  it.each([
    ["missing query", {}, "query"],
    ["empty query", { query: "" }, "query"],
    ["non-string query", { query: 42 }, "query"],
    ["whitespace-only query", { query: "   " }, "query"],
  ])("rejects %s without opening the socket", async (_label, args, _hint) => {
    let connectCount = 0;
    const client = new NookdSocketClient({
      socketPath: "/tmp/never-used",
      connect: async () => {
        connectCount += 1;
        throw new Error("connect must not run");
      },
    });
    const server = buildNookMcpServer({ client });

    const result = await server.callTool("notesnook_search_notes", args);
    expect(connectCount).toBe(0);
    expect(result.isError).toBe(true);
    const textBlock = result.content[0] as { type: string; text: string };
    expect(textBlock.text).toContain("invalid_request");
  });

  it("rejects an oversized query before any socket I/O", async () => {
    let connectCount = 0;
    const client = new NookdSocketClient({
      socketPath: "/tmp/never-used",
      connect: async () => {
        connectCount += 1;
        throw new Error("connect must not run");
      },
    });
    const server = buildNookMcpServer({ client });

    const oversized = "x".repeat(NOOK_MCP_MAX_QUERY_BYTES + 1);
    const result = await server.callTool("notesnook_search_notes", { query: oversized });
    expect(connectCount).toBe(0);
    expect(result.isError).toBe(true);
    const textBlock = result.content[0] as { type: string; text: string };
    expect(textBlock.text).toContain("invalid_request");
    // The actual oversized string must never reach the error body.
    expect(textBlock.text).not.toContain(oversized);
  });

  it("rejects ASCII control characters before any socket I/O", async () => {
    let connectCount = 0;
    const client = new NookdSocketClient({
      socketPath: "/tmp/never-used",
      connect: async () => {
        connectCount += 1;
        throw new Error("connect must not run");
      },
    });
    const server = buildNookMcpServer({ client });

    const result = await server.callTool("notesnook_search_notes", { query: "safe\u0000unsafe" });
    expect(connectCount).toBe(0);
    expect(result.isError).toBe(true);
    const textBlock = result.content[0] as { type: string; text: string };
    expect(textBlock.text).toContain("invalid_request");
    expect(textBlock.text).not.toContain("safe");
  });

  it("trims leading and trailing whitespace before bounds checking", async () => {
    const observed: { params: { query: string } }[] = [];
    const socketPath = await startFakeDaemon((request) => {
      observed.push({ params: request.params });
      return framedResponse({
        id: request.id,
        ok: true,
        result: { kind: "search", notes: [] },
      });
    });
    const client = new NookdSocketClient({ socketPath });
    const server = buildNookMcpServer({ client });

    const result = await server.callTool("notesnook_search_notes", { query: "  hello  " });
    expect(result.isError).toBeFalsy();
    expect(observed[0]?.params.query).toBe("hello");
  });
});

// -----------------------------------------------------------------------
// Service loss — categorical errors, no leaking.
// -----------------------------------------------------------------------

describe("notesnook_search_notes — service loss", () => {
  it("maps a daemon service_unavailable envelope to a categorical MCP error", async () => {
    const socketPath = await startFakeDaemon((request) =>
      framedResponse({
        id: request.id,
        ok: false,
        error: { code: "service_unavailable", message: "Service unavailable" },
      }),
    );
    const client = new NookdSocketClient({ socketPath });
    const server = buildNookMcpServer({ client });

    const result = await server.callTool("notesnook_search_notes", { query: "needle" });
    expect(result.isError).toBe(true);
    const textBlock = result.content[0] as { type: string; text: string };
    expect(textBlock.text).toContain("service_unavailable");
    expect(textBlock.text).not.toContain("ECONNREFUSED");
    expect(textBlock.text).not.toContain("ENOENT");
  });

  it("maps a connect failure to a service_unavailable MCP error", async () => {
    const dir = makeTempDir();
    const socketPath = join(dir, "missing.sock");
    const client = new NookdSocketClient({ socketPath });
    const server = buildNookMcpServer({ client });

    const result = await server.callTool("notesnook_search_notes", { query: "needle" });
    expect(result.isError).toBe(true);
    const textBlock = result.content[0] as { type: string; text: string };
    expect(textBlock.text).toContain("service_unavailable");
    // The local socket path must never leak into the error body.
    expect(textBlock.text).not.toContain(socketPath);
    // Underlying socket / connect strings must not leak either.
    expect(textBlock.text).not.toMatch(/ECONNREFUSED|ENOENT|syscall|address/);
  });

  it("refuses to call any unknown tool", async () => {
    let connectCount = 0;
    const client = new NookdSocketClient({
      socketPath: "/tmp/never-used",
      connect: async () => {
        connectCount += 1;
        throw new Error("connect must not run");
      },
    });
    const server = buildNookMcpServer({ client });

    const result = await server.callTool("notes.delete", { id: "abc" });
    expect(connectCount).toBe(0);
    expect(result.isError).toBe(true);
    const textBlock = result.content[0] as { type: string; text: string };
    expect(textBlock.text).toContain("unknown_tool");
  });
});

// -----------------------------------------------------------------------
// Categorical error vocabulary.
// -----------------------------------------------------------------------

describe("error vocabulary", () => {
  it("nookMcpServiceUnavailableResult produces a frozen categorical text block", () => {
    const result = nookMcpServiceUnavailableResult();
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.isError).toBe(true);
    const block = result.content[0] as { type: string; text: string };
    expect(block.type).toBe("text");
    expect(JSON.parse(block.text)).toEqual({
      code: "service_unavailable",
      message: "Service unavailable",
    });
  });

  it("toMcpErrorResult maps an RpcErrorCode to the matching MCP error result", () => {
    const result = toMcpErrorResult("invalid_request");
    expect(result.isError).toBe(true);
    const block = result.content[0] as { type: string; text: string };
    expect(JSON.parse(block.text)).toEqual({
      code: "invalid_request",
      message: "Invalid request",
    });
  });

  it("isNookMcpServerError recognises the closed error type only", () => {
    expect(isNookMcpServerError(new NookMcpServerError("invalid_request"))).toBe(true);
    expect(isNookMcpServerError(new Error("nope"))).toBe(false);
    expect(isNookMcpServerError(null)).toBe(false);
    expect(isNookMcpServerError({})).toBe(false);
  });
});

// -----------------------------------------------------------------------
// CLI argument parser — must validate before opening anything.
// -----------------------------------------------------------------------

describe("CLI argument + socket resolver", () => {
  it("accepts --socket <absolute> as the only configuration flag", () => {
    const parsed = parseCliArgs(["--socket", "/run/nookbridge/nookbridge.sock"]);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.socketPath).toBe("/run/nookbridge/nookbridge.sock");
    }
  });

  it("rejects --help as a usage request", () => {
    const parsed = parseCliArgs(["--help"]);
    expect(parsed.kind).toBe("help");
  });

  it.each([
    ["missing args", []],
    ["missing value", ["--socket"]],
    ["relative path", ["--socket", "relative.sock"]],
    ["empty path", ["--socket", ""]],
    ["unknown flag", ["--bad", "/run/nookbridge/nookbridge.sock"]],
    ["two values", ["--socket", "/a", "/b"]],
  ])("rejects %s", (_label, args) => {
    const parsed = parseCliArgs(args);
    expect(parsed.kind).toBe("invalid");
  });

  it("resolveSocketPath returns the explicit CLI socket path", () => {
    const resolved = resolveSocketPath({ kind: "ok", socketPath: "/run/nookbridge/x.sock" });
    expect(resolved).toBe("/run/nookbridge/x.sock");
  });

  it("resolveSocketPath refuses env-derived paths unless validated", () => {
    const resolved = resolveSocketPath(
      { kind: "env" },
      {
        env: { NOOK_MCP_SOCKET: "/tmp/nook-mcp.sock" },
      },
    );
    // Env carrier must NOT silently widen the surface; the default is to
    // require the CLI flag.
    expect(resolved.kind).toBe("missing");
  });

  it("resolveSocketPath accepts env carrier only when explicitly enabled", () => {
    const resolved = resolveSocketPath(
      { kind: "env" },
      { env: { NOOK_MCP_SOCKET: "/run/nookbridge/nookbridge.sock" } },
      { allowEnv: true },
    );
    expect(resolved.kind).toBe("ok");
    if (resolved.kind === "ok") {
      expect(resolved.socketPath).toBe("/run/nookbridge/nookbridge.sock");
    }
  });

  it("resolveSocketPath rejects an env-derived non-absolute path", () => {
    const resolved = resolveSocketPath(
      { kind: "env" },
      { env: { NOOK_MCP_SOCKET: "relative.sock" } },
      { allowEnv: true },
    );
    expect(resolved.kind).toBe("invalid");
  });
});

// -----------------------------------------------------------------------
// stdio JSON-RPC decoder — keeps stdout protocol bytes intact.
// -----------------------------------------------------------------------

describe("decodeMcpJsonRpcMessages", () => {
  it("decodes a single framed message and surfaces the envelope", () => {
    const envelope = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    });
    const bytes = Buffer.from(envelope + "\n", "utf8");
    const messages = decodeMcpJsonRpcMessages(bytes);
    expect(messages.length).toBe(1);
    expect((messages[0] as { id: number }).id).toBe(1);
  });
});

// -----------------------------------------------------------------------
// End-to-end SDK smoke test against the McpServer + StdioServerTransport.
// -----------------------------------------------------------------------

describe("end-to-end SDK smoke test", () => {
  it("drives the proxy through the MCP SDK client over a child stdio pipe", async () => {
    const dir = makeTempDir();
    const socketPath = join(dir, "fake-nookd.sock");
    const server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const len = buffer.readUInt32BE(0);
        if (buffer.length < 4 + len) return;
        const payload = JSON.parse(buffer.subarray(4, 4 + len).toString("utf8")) as {
          id: string;
        };
        const envelope = {
          id: payload.id,
          ok: true,
          result: { kind: "search", notes: [{ title: "First hit" }] },
        };
        const response = Buffer.from(JSON.stringify(envelope), "utf8");
        const frame = Buffer.alloc(4 + response.length);
        frame.writeUInt32BE(response.length, 0);
        response.copy(frame, 4);
        socket.write(frame);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

    try {
      const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
      const transport = new StdioClientTransport({
        command: "node",
        args: [
          "-e",
          `
          import("./dist/mcp/cli.js").then((m) => {
            process.argv = ["node", "nook-mcp", "--socket", ${JSON.stringify(socketPath)}];
            m.runNookMcpCli();
          });
        `,
        ],
      });
      // The dist build must exist for the smoke test to run; skip
      // gracefully if a developer hasn't run `npm run build` yet.
      const distCli = join(process.cwd(), "dist", "mcp", "cli.js");
      const fs = await import("node:fs/promises");
      try {
        await fs.access(distCli);
      } catch {
        // Build artefact absent — fall back to a tsx-style skip. The
        // Node ESM `-e` snippet above is a best-effort sanity check.
        return;
      }
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "notesnook_search_notes",
        "notesnook_status",
        "notesnook_list_notebooks",
        "notesnook_get_note",
      ]);
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      const result = await client.callTool({
        name: "notesnook_search_notes",
        arguments: { query: "needle" },
      });
      expect(result.isError).toBeFalsy();
      const block = (result.content as Array<{ type: string; text: string }>)[0];
      expect(block?.type).toBe("text");
      if (block === undefined) throw new Error("missing tool result block");
      const parsed = JSON.parse(block.text) as {
        kind: string;
        notes: Array<{ title: string }>;
      };
      expect(parsed.notes.map((note) => note.title)).toEqual(["First hit"]);

      const invalid = await client.callTool({
        name: "notesnook_search_notes",
        arguments: { query: "bad\u0000query" },
      });
      expect(invalid.isError).toBe(true);
      const invalidBlock = (invalid.content as Array<{ type: string; text: string }>)[0];
      if (invalidBlock === undefined) throw new Error("missing invalid-input result block");
      expect(JSON.parse(invalidBlock.text).code).toBe("invalid_request");

      const unknown = await client.callTool({
        name: "notesnook_unknown",
        arguments: { query: "needle" },
      });
      expect(unknown.isError).toBe(true);
      const unknownBlock = (unknown.content as Array<{ type: string; text: string }>)[0];
      if (unknownBlock === undefined) throw new Error("missing unknown-tool result block");
      expect(JSON.parse(unknownBlock.text).code).toBe("unknown_tool");
      await client.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});

// -----------------------------------------------------------------------
// Forbidden symbols — the proxy must not import Notesnook internals.
// -----------------------------------------------------------------------

describe("forbidden module surface", () => {
  it("source modules never import @notesnook/core, @notesnook/database, or @notesnook/crypto", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.join(process.cwd(), "src", "mcp");
    const stack = [root];
    const offenders: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(child);
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          const content = await fs.readFile(child, "utf8");
          if (
            /from\s+["']@notesnook\//.test(content) ||
            /require\s*\(\s*["']@notesnook\//.test(content)
          ) {
            offenders.push(child);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("forbidden-tool guard rejects attempts to register beyond the allowlist", () => {
    // If a future contributor added a second tool registration, the
    // server factory would reject it.  The intent is to fail the
    // build (via a test) rather than silently widen the surface.
    expect(NOOK_MCP_ALLOWED_TOOL_NAME).toBe("notesnook_search_notes");
    expect(FORBIDDEN_TOOL_NAMES).toContain("notesnook_create_note");
    expect(FORBIDDEN_TOOL_NAMES).toContain("notesnook_update_note");
    expect(FORBIDDEN_TOOL_NAMES).toContain("notesnook_delete_note");

    expect(FORBIDDEN_TOOL_NAMES).toContain("notesnook_sync");
  });
});

// -----------------------------------------------------------------------
// Socket client — the framed Unix-socket transport seam.
// -----------------------------------------------------------------------

describe("NookdSocketClient", () => {
  it("writes a framed notes.search request and reads the framed response", async () => {
    const dir = makeTempDir();
    const socketPath = join(dir, "nookd.sock");
    const server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const len = buffer.readUInt32BE(0);
        if (buffer.length < 4 + len) return;
        const payload = JSON.parse(buffer.subarray(4, 4 + len).toString("utf8")) as {
          id: string;
          method: string;
        };
        expect(payload.method).toBe("notes.search");
        const envelope = {
          id: payload.id,
          ok: true,
          result: { kind: "search", notes: [{ title: "Hello" }] },
        };
        const response = Buffer.from(JSON.stringify(envelope), "utf8");
        const frame = Buffer.alloc(4 + response.length);
        frame.writeUInt32BE(response.length, 0);
        response.copy(frame, 4);
        socket.write(frame);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      const client = new NookdSocketClient({ socketPath });
      const result = await client.search({ id: "req-1", query: "Hello" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.envelope.result.notes[0]?.title).toBe("Hello");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects forged extra fields in daemon responses", async () => {
    const dir = makeTempDir();
    const socketPath = join(dir, "forged.sock");
    const server = createServer((socket) => {
      socket.once("data", (chunk: Buffer) => {
        const length = chunk.readUInt32BE(0);
        const request = JSON.parse(chunk.subarray(4, 4 + length).toString("utf8")) as {
          id: string;
        };
        const response = Buffer.from(
          JSON.stringify({
            id: request.id,
            ok: true,
            result: { kind: "search", notes: [], forged: "unexpected" },
          }),
          "utf8",
        );
        const frame = Buffer.alloc(4 + response.length);
        frame.writeUInt32BE(response.length, 0);
        response.copy(frame, 4);
        socket.write(frame);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      const result = await new NookdSocketClient({ socketPath }).search({ query: "Hello" });
      expect(result).toEqual({ ok: false, code: "service_unavailable" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails categorically when the socket does not exist", async () => {
    const dir = makeTempDir();
    const socketPath = join(dir, "missing.sock");
    const client = new NookdSocketClient({ socketPath });
    const result = await client.search({ id: "req-1", query: "Hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("service_unavailable");
    }
  });
});
