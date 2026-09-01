#!/usr/bin/env node
/**
 * `nook-mcp` command-line entrypoint.
 *
 * The proxy is deliberately explicit: a socket path must be supplied with
 * `--socket`; there is no implicit default and no Notesnook credential path.
 * MCP protocol bytes use stdout. Fixed diagnostics use stderr only.
 */

import { pathToFileURL } from "node:url";
import process from "node:process";
import { Buffer } from "node:buffer";
import { isAbsolute, resolve } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildNookMcpServer } from "./nook-mcp-server.js";
import { NookdSocketClient } from "./socket-client.js";

export const NOOK_MCP_MAX_QUERY_BYTES = 512;

const HELP_TEXT =
  "Usage: nook-mcp --socket /run/nookbridge/nookbridge.sock\n" +
  "Exposes four read-only Notesnook metadata/search tools over MCP stdio.\n";

export type CliParseResult =
  | { readonly kind: "ok"; readonly socketPath: string }
  | { readonly kind: "help" }
  | { readonly kind: "invalid" };

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  if (argv.length === 1 && argv[0] === "--help") return { kind: "help" };
  if (argv.length !== 2 || argv[0] !== "--socket" || typeof argv[1] !== "string") {
    return { kind: "invalid" };
  }
  const socketPath = validateSocketPath(argv[1]);
  return socketPath === undefined ? { kind: "invalid" } : { kind: "ok", socketPath };
}

type SocketCarrier =
  | { readonly kind: "ok"; readonly socketPath: string }
  | { readonly kind: "env" };

type SocketResolution =
  | { readonly kind: "ok"; readonly socketPath: string }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" };

/* eslint-disable no-redeclare */
export function resolveSocketPath(carrier: {
  readonly kind: "ok";
  readonly socketPath: string;
}): string;
export function resolveSocketPath(
  carrier: { readonly kind: "env" },
  source?: { readonly env?: Record<string, string | undefined> },
  options?: { readonly allowEnv?: boolean },
): SocketResolution;
export function resolveSocketPath(
  carrier: SocketCarrier,
  source: { readonly env?: Record<string, string | undefined> } = {},
  options: { readonly allowEnv?: boolean } = {},
): string | SocketResolution {
  if (carrier.kind === "ok") {
    const validated = validateSocketPath(carrier.socketPath);
    if (validated === undefined) throw new TypeError("nook-mcp: invalid socket path");
    return validated;
  }
  if (options.allowEnv !== true) return { kind: "missing" };
  const value = source.env?.NOOK_MCP_SOCKET;
  if (value === undefined) return { kind: "missing" };
  const validated = validateSocketPath(value);
  return validated === undefined ? { kind: "invalid" } : { kind: "ok", socketPath: validated };
}
/* eslint-enable no-redeclare */

function validateSocketPath(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || hasControlCharacter(value)) {
    return undefined;
  }
  if (!isAbsolute(value) || resolve(value) !== value) return undefined;
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0 && code <= 0x1f) || code === 0x7f) return true;
  }
  return false;
}

/** Decode newline-delimited JSON messages for bounded diagnostics/tests. */
export function decodeMcpJsonRpcMessages(input: Uint8Array): unknown[] {
  if (input.byteLength > 65_536) throw new TypeError("nook-mcp: message input too large");
  const text = Buffer.from(input).toString("utf8");
  const messages: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (Buffer.byteLength(trimmed, "utf8") > 65_536)
      throw new TypeError("nook-mcp: message too large");
    messages.push(JSON.parse(trimmed) as unknown);
  }
  return messages;
}

export async function runNookMcpCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.kind === "help") {
    process.stderr.write(HELP_TEXT);
    return 0;
  }
  if (parsed.kind !== "ok") {
    process.stderr.write("nook-mcp: invalid arguments; use --help\n");
    return 64;
  }

  try {
    const client = new NookdSocketClient({ socketPath: parsed.socketPath });
    const handle = buildNookMcpServer({ client });
    const transport = new StdioServerTransport();
    await handle.server.connect(transport);
    return 0;
  } catch {
    process.stderr.write("nook-mcp: service_unavailable\n");
    return 1;
  }
}

const mainArg = process.argv[1];
if (mainArg !== undefined && import.meta.url === pathToFileURL(mainArg).href) {
  void runNookMcpCli().then((status) => {
    if (status !== 0) process.exitCode = status;
  });
}
