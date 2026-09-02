/** Stage 5 service-boundary integration tests for the nookd Unix socket server. */

import { once } from "node:events";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";

import { afterEach, describe, expect, it, vi } from "vitest";

import { STAGE5_RPC_LIMITS, type RpcResponseEnvelope } from "../src/service/rpc-protocol.js";
import {
  startNookdServer,
  type NookdServerHandle,
  type NookdServerRuntime,
} from "../src/service/nookd-server.js";
import { runNookdCli } from "../src/nookd.js";

const handles: NookdServerHandle[] = [];
const tempDirectories: string[] = [];

const requestBytes = (id: string, query: string): Buffer => {
  const payload = Buffer.from(JSON.stringify({ id, method: "notes.search", params: { query } }));
  const request = Buffer.allocUnsafe(4 + payload.length);
  request.writeUInt32BE(payload.length, 0);
  payload.copy(request, 4);
  return request;
};

async function fixture(
  search: NookdServerRuntime["search"],
  options: {
    maxConnections?: number;
    maxRequestsPerConnection?: number;
    shutdownTimeoutMs?: number;
  } = {},
): Promise<{ handle: NookdServerHandle; socketPath: string; cleanup: ReturnType<typeof vi.fn> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nookd-server-"));
  tempDirectories.push(directory);
  const socketPath = path.join(directory, "nookbridge.sock");
  const cleanup = vi.fn(async () => undefined);
  const runtime: NookdServerRuntime = Object.freeze({ search, cleanup });
  const handle = await startNookdServer({
    socketPath,
    runtime,
    installSignalHandlers: false,
    ...options,
  });
  handles.push(handle);
  return { handle, socketPath, cleanup };
}

async function connect(socketPath: string): Promise<net.Socket> {
  const socket = net.createConnection(socketPath);
  await once(socket, "connect");
  return socket;
}

async function readFrame(socket: net.Socket): Promise<RpcResponseEnvelope> {
  let bytes = Buffer.alloc(0);
  for (;;) {
    const [chunk] = (await once(socket, "data")) as [Buffer];
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length < 4) continue;
    const size = bytes.readUInt32BE(0);
    if (bytes.length < size + 4) continue;
    return parseRpcFrameResponse(bytes.subarray(0, size + 4));
  }
}

function parseRpcFrameResponse(frame: Uint8Array): RpcResponseEnvelope {
  const payload = Buffer.from(frame.subarray(4)).toString("utf8");
  const parsed: unknown = JSON.parse(payload);
  return parsed as RpcResponseEnvelope;
}

async function waitForClose(socket: net.Socket): Promise<void> {
  if (socket.destroyed) return;
  await once(socket, "close");
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.shutdown()));
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("nookd Unix socket server", () => {
  it("serves the allowed notes.search operation with a title-only response", async () => {
    const { socketPath } = await fixture(async (query) => [{ title: `hit:${query}` }]);
    const socket = await connect(socketPath);
    socket.write(requestBytes("one", "needle"));

    const response = await readFrame(socket);

    expect(response).toEqual({
      id: "one",
      ok: true,
      result: { kind: "search", notes: [{ title: "hit:needle" }] },
    });
    socket.destroy();
  });

  it("keeps a request split across stream chunks until the complete frame arrives", async () => {
    const { socketPath } = await fixture(async () => [{ title: "split" }]);
    const socket = await connect(socketPath);
    const request = requestBytes("split", "chunked");
    socket.write(request.subarray(0, 3));
    socket.write(request.subarray(3, 11));
    socket.write(request.subarray(11));

    const response = await readFrame(socket);

    expect(response).toMatchObject({ id: "split", ok: true });
    socket.destroy();
  });

  it("serializes multiple sequential requests without parallel runtime calls", async () => {
    let active = 0;
    let maximumActive = 0;
    const { socketPath } = await fixture(async (query) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, query === "first" ? 15 : 1));
      active -= 1;
      return [{ title: query }];
    });
    const socket = await connect(socketPath);
    socket.write(Buffer.concat([requestBytes("first", "first"), requestBytes("second", "second")]));

    const first = await readFrame(socket);
    const second = await readFrame(socket);

    expect(first).toMatchObject({ id: "first", ok: true });
    expect(second).toMatchObject({ id: "second", ok: true });
    expect(maximumActive).toBe(1);
    socket.destroy();
  });

  it("bounds accepted connections and closes connections above the configured cap", async () => {
    const { socketPath } = await fixture(async () => [], { maxConnections: 1 });
    const first = await connect(socketPath);
    const second = await connect(socketPath);

    await waitForClose(second);
    expect(first.destroyed).toBe(false);
    first.destroy();
  });

  it("bounds requests per connection and closes a connection after its request budget", async () => {
    const { socketPath } = await fixture(async () => [], { maxRequestsPerConnection: 1 });
    const socket = await connect(socketPath);
    socket.write(Buffer.concat([requestBytes("one", "one"), requestBytes("two", "two")]));

    const first = await readFrame(socket);
    expect(first).toMatchObject({ id: "one", ok: true });
    await waitForClose(socket);
  });

  it("normalizes runtime failures without exposing the upstream error", async () => {
    const { socketPath } = await fixture(async () => {
      throw new Error("secret state path, credential, and note body");
    });
    const socket = await connect(socketPath);
    socket.write(requestBytes("failure", "needle"));

    const response = await readFrame(socket);

    expect(response).toEqual({
      id: "failure",
      ok: false,
      error: { code: "service_unavailable", message: "Service unavailable" },
    });
    expect(JSON.stringify(response)).not.toContain("secret");
    socket.destroy();
  });

  it("closes malformed, unknown, and oversized requests without an untrusted id response", async () => {
    const { socketPath } = await fixture(async () => []);
    const cases = [
      Buffer.from("not-a-frame"),
      (() => {
        const payload = Buffer.from('{"id":"x","method":"notes.delete","params":{}}');
        const frame = Buffer.alloc(4 + payload.length);
        frame.writeUInt32BE(payload.length, 0);
        payload.copy(frame, 4);
        return frame;
      })(),
      (() => {
        const frame = Buffer.alloc(4);
        frame.writeUInt32BE(STAGE5_RPC_LIMITS.maxFrameBytes + 1, 0);
        return frame;
      })(),
    ];

    for (const request of cases) {
      const socket = await connect(socketPath);
      socket.write(request);
      await waitForClose(socket);
    }
  });

  it("closes a response that cannot satisfy the response byte bound", async () => {
    const { socketPath } = await fixture(async () => []);
    const socket = await connect(socketPath);
    const oversizedId = "x".repeat(50_000);
    socket.write(requestBytes(oversizedId, "needle"));

    await waitForClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it("does not invoke the runtime after a client disconnects before a request completes", async () => {
    let resolveSearch: (() => void) | undefined;
    const searchStarted = new Promise<void>((resolve) => {
      resolveSearch = resolve;
    });
    const search = vi.fn(async () => {
      resolveSearch?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return [{ title: "late" }];
    });
    const { socketPath } = await fixture(search);
    const socket = await connect(socketPath);
    socket.write(requestBytes("disconnect", "needle"));
    await searchStarted;
    socket.destroy();
    await waitForClose(socket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(search).toHaveBeenCalledTimes(1);
  });

  it("consumes a rejected work finalizer promise", async () => {
    let releaseSearch: (() => void) | undefined;
    const searchStarted = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    const search = vi.fn(async () => {
      await searchStarted;
      return [{ title: "finalizer" }];
    });
    const { socketPath } = await fixture(search);
    const socket = await connect(socketPath);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const originalWrite = net.Socket.prototype.write;
    let rejectWrites = false;
    const writeSpy = vi.spyOn(net.Socket.prototype, "write").mockImplementation(function (
      this: net.Socket,
      ...args: Parameters<net.Socket["write"]>
    ) {
      if (rejectWrites) throw new Error("WRITE_FINALIZER_CANARY");
      return originalWrite.apply(this, args);
    });

    try {
      socket.write(requestBytes("finalizer", "needle"));
      await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
      rejectWrites = true;
      releaseSearch?.();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      writeSpy.mockRestore();
      socket.destroy();
    }
  });

  it("stops accepting, unlinks only its socket, and cleans the runtime exactly once", async () => {
    const { handle, socketPath, cleanup } = await fixture(async () => []);
    expect((await stat(socketPath)).isSocket()).toBe(true);

    await Promise.all([handle.shutdown(), handle.shutdown()]);

    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects relative paths and refuses to replace an existing filesystem entry", async () => {
    const runtime: NookdServerRuntime = Object.freeze({
      search: async () => [],
      cleanup: async () => undefined,
    });
    await expect(
      startNookdServer({ socketPath: "relative.sock", runtime, installSignalHandlers: false }),
    ).rejects.toThrow("absolute");

    const directory = await mkdtemp(path.join(os.tmpdir(), "nookd-existing-"));
    tempDirectories.push(directory);
    const existing = path.join(directory, "existing");
    await (await import("node:fs/promises")).mkdir(existing);
    await expect(
      startNookdServer({ socketPath: existing, runtime, installSignalHandlers: false }),
    ).rejects.toThrow("existing");
  });

  it.each(["\u0000", "\u001f", "\u007f"])(
    "rejects a control-bearing socket path before creating a socket (U+%s)",
    async (control) => {
      const runtime: NookdServerRuntime = Object.freeze({
        search: async () => [],
        cleanup: async () => undefined,
      });
      const createServerSpy = vi.spyOn(net, "createServer");

      try {
        await expect(
          startNookdServer({
            socketPath: `${path.join(os.tmpdir(), "nookbridge.sock")}${control}canary`,
            runtime,
            installSignalHandlers: false,
          }),
        ).rejects.toThrow("absolute");
        expect(createServerSpy).not.toHaveBeenCalled();
      } finally {
        createServerSpy.mockRestore();
      }
    },
  );

  it("rejects a non-canonical socket path before creating a socket", async () => {
    const runtime: NookdServerRuntime = Object.freeze({
      search: async () => [],
      cleanup: async () => undefined,
    });
    const createServerSpy = vi.spyOn(net, "createServer");

    try {
      await expect(
        startNookdServer({
          socketPath: "/tmp/nookbridge/a/../nookbridge.sock",
          runtime,
          installSignalHandlers: false,
        }),
      ).rejects.toThrow("absolute");
      expect(createServerSpy).not.toHaveBeenCalled();
    } finally {
      createServerSpy.mockRestore();
    }
  });
});

describe("nookd entry point", () => {
  it("exports the server API and provides help without touching live state", () => {
    const output = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    expect(runNookdCli(["--help"], output)).toBe(0);
    expect(output.stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("Usage: nookd --help\n"),
    );
    expect(output.stderr.write).not.toHaveBeenCalled();
  });

  it("rejects implicit or unvalidated startup arguments", () => {
    const output = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } };

    expect(runNookdCli([], output)).toBe(64);
    expect(runNookdCli(["--socket-path", "/tmp/nookbridge.sock"], output)).toBe(64);
    expect(output.stderr.write).toHaveBeenCalledTimes(2);
  });
});
