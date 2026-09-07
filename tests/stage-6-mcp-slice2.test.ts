/**
 * Stage 6 Slice 2 — read-only MCP tools.
 *
 * The slice adds status, notebook listing, and note-metadata reads while
 * preserving the title-only / no-body boundary. These tests exercise the
 * complete path: MCP tool -> framed socket client -> nookd RPC handler ->
 * bounded runtime seam.
 */

import { Buffer } from "node:buffer";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NOOK_MCP_ALLOWED_TOOL_NAMES, buildNookMcpServer } from "../src/mcp/nook-mcp-server.js";
import { NookdSocketClient } from "../src/mcp/socket-client.js";
import { startNookdServer } from "../src/service/nookd-server.js";
import type { NookdServerHandle } from "../src/service/nookd-server.js";
import { STAGE5_RPC_LIMITS } from "../src/service/rpc-protocol.js";

const temporaryDirectories: string[] = [];
const serverHandles: NookdServerHandle[] = [];
const fakeServers: Server[] = [];

function temporarySocketPath(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return join(directory, "nookd.sock");
}

function frame(envelope: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(envelope), "utf8");
  const result = Buffer.alloc(4 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

async function startFakeDaemon(
  respond: (request: {
    id: string;
    method: string;
    params: Record<string, unknown>;
  }) => Record<string, unknown>,
): Promise<string> {
  const socketPath = temporarySocketPath("nook-mcp-slice2-fake-");
  const server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const payloadLength = pending.readUInt32BE(0);
      if (pending.length < payloadLength + 4) return;
      const request = JSON.parse(pending.subarray(4, payloadLength + 4).toString("utf8")) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      socket.end(frame(respond(request)));
    });
  });
  fakeServers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

function textPayload(result: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const block = result.content[0];
  expect(block?.type).toBe("text");
  expect(typeof block?.text).toBe("string");
  return JSON.parse(block?.text ?? "null") as Record<string, unknown>;
}

afterEach(async () => {
  while (serverHandles.length > 0) {
    await serverHandles.pop()?.shutdown();
  }
  for (const server of fakeServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Stage 6 Slice 2 — MCP tool surface", () => {
  it("advertises the four read-only tools plus the three bounded writes", () => {
    const client = new NookdSocketClient({
      socketPath: "/tmp/nook-mcp-slice2-never-used.sock",
      connect: async () => {
        throw new Error("socket must not be touched during introspection");
      },
    });
    const handle = buildNookMcpServer({ client });
    expect(NOOK_MCP_ALLOWED_TOOL_NAMES).toEqual([
      "notesnook_search_notes",
      "notesnook_status",
      "notesnook_list_notebooks",
      "notesnook_get_note",
      "notesnook_create_note",
      "notesnook_append_note",
      "notesnook_update_note",
      "notesnook_sync",
    ]);
    expect(handle.tools.map((tool) => tool.name)).toEqual(NOOK_MCP_ALLOWED_TOOL_NAMES);
    expect(handle.tools.slice(0, 4).every((tool) => tool.annotations?.readOnlyHint === true)).toBe(
      true,
    );
    expect(handle.tools.slice(4).every((tool) => tool.annotations?.readOnlyHint === false)).toBe(
      true,
    );
    expect(handle.tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
  });

  it("maps status to notes.status without touching search", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const socketPath = await startFakeDaemon((request) => {
      requests.push({ method: request.method, params: request.params });
      return {
        id: request.id,
        ok: true,
        result: { kind: "status", lastSynced: 123, hasUnsyncedChanges: false },
      };
    });
    const client = new NookdSocketClient({ socketPath });
    const result = await buildNookMcpServer({ client }).callTool("notesnook_status", {});

    expect(result.isError).toBeFalsy();
    expect(requests).toEqual([{ method: "notes.status", params: {} }]);
    expect(textPayload(result)).toEqual({
      kind: "status",
      lastSynced: 123,
      hasUnsyncedChanges: false,
    });
  });

  it("maps notebook listing and strips unallowlisted fields", async () => {
    const socketPath = await startFakeDaemon((request) => ({
      id: request.id,
      ok: true,
      result: {
        kind: "notebooks",
        notebooks: [
          {
            id: "nb-1",
            title: "Projects",
            dateCreated: 10,
            dateModified: 20,
            body: "must-not-cross",
          },
        ],
      },
    }));
    const client = new NookdSocketClient({ socketPath });
    const result = await buildNookMcpServer({ client }).callTool("notesnook_list_notebooks", {});

    expect(result.isError).toBeFalsy();
    expect(textPayload(result)).toEqual({
      kind: "notebooks",
      notebooks: [{ id: "nb-1", title: "Projects", dateCreated: 10, dateModified: 20 }],
    });
  });

  it("maps get-note to metadata only and never returns body content", async () => {
    const observed: Array<{ method: string; params: Record<string, unknown> }> = [];
    const socketPath = await startFakeDaemon((request) => {
      observed.push({ method: request.method, params: request.params });
      return {
        id: request.id,
        ok: true,
        result: {
          kind: "note",
          note: {
            id: "note-1",
            title: "A note",
            notebookId: "nb-1",
            pinned: true,
            body: "secret-body",
          },
        },
      };
    });
    const client = new NookdSocketClient({ socketPath });
    const result = await buildNookMcpServer({ client }).callTool("notesnook_get_note", {
      id: "note-1",
    });

    expect(result.isError).toBeFalsy();
    expect(observed).toEqual([{ method: "notes.get", params: { id: "note-1" } }]);
    expect(textPayload(result)).toEqual({
      kind: "note",
      note: { id: "note-1", title: "A note", notebookId: "nb-1", pinned: true },
    });
    expect(JSON.stringify(result)).not.toContain("secret-body");
  });

  it("maps an absent note to not_found", async () => {
    const socketPath = await startFakeDaemon((request) => ({
      id: request.id,
      ok: false,
      error: { code: "not_found", message: "Not found" },
    }));
    const client = new NookdSocketClient({ socketPath });
    const result = await buildNookMcpServer({ client }).callTool("notesnook_get_note", {
      id: "missing",
    });

    expect(result.isError).toBe(true);
    expect(textPayload(result)).toEqual({ code: "not_found", message: "Not found" });
  });

  it("rejects malformed inputs before socket I/O", async () => {
    const connect = vi.fn(async () => {
      throw new Error("must not connect");
    });
    const client = new NookdSocketClient({
      socketPath: "/tmp/nook-mcp-slice2-never-used.sock",
      connect,
    });
    const handle = buildNookMcpServer({ client });

    for (const [name, args] of [
      ["notesnook_status", { extra: true }],
      ["notesnook_list_notebooks", { extra: true }],
      ["notesnook_get_note", {}],
      ["notesnook_get_note", { id: "  " }],
      ["notesnook_get_note", { id: `x${String.fromCharCode(0)}y` }],
      ["notesnook_get_note", { id: "x".repeat(STAGE5_RPC_LIMITS.maxTitleBytes + 1) }],
    ] as const) {
      const result = await handle.callTool(name, args);
      expect(result.isError).toBe(true);
      expect(textPayload(result)).toEqual({ code: "invalid_request", message: "Invalid request" });
    }
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("Stage 6 Slice 2 — vertical nookd RPC path", () => {
  it("serves status, notebooks, and note metadata through the real server", async () => {
    const socketPath = temporarySocketPath("nook-mcp-slice2-server-");
    const runtime = Object.freeze({
      search: async () => [],
      status: async () => ({ lastSynced: 7, hasUnsyncedChanges: true }),
      listNotebooks: async () => [{ id: "nb-1", title: "Home" }],
      noteMetadata: async (id: string) =>
        id === "note-1" ? { id, title: "Todo", notebookId: "nb-1" } : undefined,
      cleanup: async () => undefined,
    });
    const server = await startNookdServer({
      socketPath,
      runtime,
      installSignalHandlers: false,
    });
    serverHandles.push(server);
    const client = new NookdSocketClient({ socketPath });

    const status = await client.status();
    const notebooks = await client.listNotebooks();
    const note = await client.getNote("note-1");
    const missing = await client.getNote("missing");

    expect(status.ok).toBe(true);
    expect(notebooks.ok).toBe(true);
    expect(note.ok).toBe(true);
    expect(missing).toEqual({ ok: false, code: "not_found" });
    if (status.ok) expect(status.envelope.result.kind).toBe("status");
    if (notebooks.ok) expect(notebooks.envelope.result.kind).toBe("notebooks");
    if (note.ok) expect(note.envelope.result.kind).toBe("note");
  });
});
