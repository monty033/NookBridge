/** Stage 5 service-boundary integration tests for the nookd Unix socket server. */

import { once } from "node:events";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { lchown, lstat, mkdtemp, readdir, rm, stat } from "node:fs/promises";
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
import { createLogger, type Logger, type LogRecord } from "../src/logging/logger.js";
import { DEFAULT_SERVICE_ABUSE_BOUNDS } from "../src/service/service-abuse-bounds.js";
import type { ServiceAuditRecord } from "../src/service/service-audit.js";
import type { OperatorPeer } from "../src/service/operator-server.js";
import { runNookdCli } from "../src/nookd.js";
import {
  startOperatorSocketServer,
  UNIX_SOCKET_PATH_MAX_BYTES,
} from "../src/service/operator-socket-server.js";

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
  const directory = await mkdtemp(path.join("/tmp", "nbk-"));
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
  it("applies the restricted client-group socket mode by default", async () => {
    const { socketPath } = await fixture(async () => []);
    const socketStat = await stat(socketPath);

    expect(socketStat.mode & 0o777).toBe(0o770);
  });

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

    const directory = await mkdtemp(path.join("/tmp", "nbk-existing-"));
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

  it("rejects a socket path longer than the Unix socket limit without creating a socket", async () => {
    const directory = await mkdtemp(path.join("/tmp", "nbk-limit-"));
    tempDirectories.push(directory);
    const stem = "s".repeat(UNIX_SOCKET_PATH_MAX_BYTES + 1 - Buffer.byteLength(directory) - 1);
    const socketPath = path.join(directory, stem);
    expect(Buffer.byteLength(socketPath)).toBe(UNIX_SOCKET_PATH_MAX_BYTES + 1);
    const runtime: NookdServerRuntime = Object.freeze({
      search: async () => [],
      cleanup: async () => undefined,
    });

    await expect(
      startNookdServer({ socketPath, runtime, installSignalHandlers: false }),
    ).rejects.toThrow("nookd socket path is too long");
    expect(await readdir(directory)).toEqual([]);
  });

  it("starts and accepts a connection at exactly the Unix socket path limit", async () => {
    const directory = await mkdtemp(path.join("/tmp", "nbk-limit-"));
    tempDirectories.push(directory);
    const stem = "s".repeat(UNIX_SOCKET_PATH_MAX_BYTES - Buffer.byteLength(directory) - 1);
    const socketPath = path.join(directory, stem);
    expect(Buffer.byteLength(socketPath)).toBe(UNIX_SOCKET_PATH_MAX_BYTES);
    const runtime: NookdServerRuntime = Object.freeze({
      search: async (query: string) => [{ title: `hit:${query}` }],
      cleanup: async () => undefined,
    });

    const handle = await startNookdServer({ socketPath, runtime, installSignalHandlers: false });
    handles.push(handle);

    const socket = await connect(socketPath);
    socket.write(requestBytes("limit", "needle"));
    const response = await readFrame(socket);

    expect(response).toMatchObject({ id: "limit", ok: true });
    socket.destroy();
  });

  it("rejects an operator socket path longer than the Unix socket limit", async () => {
    const directory = await mkdtemp(path.join("/tmp", "nbk-op-limit-"));
    tempDirectories.push(directory);
    const stem = "o".repeat(UNIX_SOCKET_PATH_MAX_BYTES + 1 - Buffer.byteLength(directory) - 1);
    const socketPath = path.join(directory, stem);
    expect(Buffer.byteLength(socketPath)).toBe(UNIX_SOCKET_PATH_MAX_BYTES + 1);

    await expect(
      startOperatorSocketServer({
        socketPath,
        socketPathRoot: directory,
        authorize: (method) => ({ allowed: true, method }),
        handle: async (request) => ({
          id: request.id,
          ok: true,
          result: { kind: "operation-list", handles: [] },
        }),
      }),
    ).rejects.toThrow("operator socket path is too long");
    expect(await readdir(directory)).toEqual([]);
  });

  /**
   * Regression: `validateOptions` builds its normalized result as a
   * hand-written whitelist. When `operator` was omitted from that list the
   * daemon started with no operator endpoint at all - no socket, no error -
   * leaving the whole operator notes CLI surface unreachable in production.
   * Nothing caught it because the operator socket was only ever exercised by
   * calling `startOperatorSocketServer` directly, bypassing `validateOptions`.
   */
  it("starts the configured operator endpoint alongside the service socket", async () => {
    const directory = await mkdtemp(path.join("/tmp", "nbk-operator-"));
    tempDirectories.push(directory);
    const socketPath = path.join(directory, "nookbridge.sock");
    const operatorSocketPath = path.join(directory, "operator.sock");
    const runtime: NookdServerRuntime = Object.freeze({
      search: vi.fn(async () => []),
      cleanup: vi.fn(async () => undefined),
    });

    const handle = await startNookdServer({
      socketPath,
      runtime,
      installSignalHandlers: false,
      operator: {
        socketPath: operatorSocketPath,
        socketPathRoot: directory,
        resolvePeer: () => ({
          uid: process.getuid?.() ?? 0,
          gid: process.getgid?.() ?? 0,
          groups: ["nookbridge-clients"],
        }),
        authorize: (method) => ({ allowed: true, method }),
        handle: async (request) => ({
          id: request.id,
          ok: true,
          result: { kind: "operation-list", handles: [] },
        }),
      },
    });
    handles.push(handle);

    const details = await stat(operatorSocketPath);
    expect(details.isSocket()).toBe(true);
    expect(handle.operatorSocketPath).toBe(operatorSocketPath);
  });

  it("rejects a malformed operator option rather than ignoring it", async () => {
    const runtime: NookdServerRuntime = Object.freeze({
      search: vi.fn(async () => []),
      cleanup: vi.fn(async () => undefined),
    });

    await expect(
      startNookdServer({
        socketPath: "/tmp/nookbridge-operator-validation.sock",
        runtime,
        installSignalHandlers: false,
        operator: "not-an-object" as unknown as NonNullable<
          Parameters<typeof startNookdServer>[0]["operator"]
        >,
      }),
    ).rejects.toThrow("operator");
  });
});

describe("R4 — runtime ownership outlives the transport", () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function deferred<T = void>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  async function ownershipFixture(
    options: { shutdownTimeoutMs?: number; maxConnections?: number } = {},
  ): Promise<{
    handle: NookdServerHandle;
    socketPath: string;
    events: string[];
    records: ServiceAuditRecord[];
    cleanup: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    gate: ReturnType<typeof deferred<{ title: string }[]>>;
  }> {
    const directory = await mkdtemp(path.join("/tmp", "nbk-r4-"));
    tempDirectories.push(directory);
    const socketPath = path.join(directory, "nookbridge.sock");
    const events: string[] = [];
    const records: ServiceAuditRecord[] = [];
    const gate = deferred<{ title: string }[]>();
    const search = vi.fn(() => gate.promise);
    const cleanup = vi.fn(async () => {
      events.push("cleanup");
    });
    const handle = await startNookdServer({
      socketPath,
      runtime: Object.freeze({ search, cleanup }) as NookdServerRuntime,
      installSignalHandlers: false,
      abuseBounds: {
        ...DEFAULT_SERVICE_ABUSE_BOUNDS,
        perProcessBurstSize: 100,
        requestTimeoutMs: 30,
      },
      auditLogger: createLogger({
        sink: (line) => {
          const parsed = JSON.parse(line) as ServiceAuditRecord & { component?: string };
          if (parsed.component === "service_audit") records.push(parsed);
        },
      }),
      ...options,
    });
    handles.push(handle);
    return { handle, socketPath, events, records, cleanup, search, gate };
  }

  it("does not clean the runtime while timed-out work is still running", async () => {
    const { handle, socketPath, events, records, cleanup, search, gate } = await ownershipFixture({
      shutdownTimeoutMs: 50,
    });
    const socket = await connect(socketPath);
    socket.write(requestBytes("t1", "needle"));
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(records.map((record) => record.event)).toContain("rpc.request.timeout"),
    );

    try {
      let shutdownSettled = false;
      const shutdown = handle.shutdown().then(() => {
        shutdownSettled = true;
      });
      await sleep(100);
      expect(cleanup).not.toHaveBeenCalled();
      expect(shutdownSettled).toBe(false);

      events.push("settled");
      gate.resolve([{ title: "late" }]);
      await shutdown;
      expect(events).toEqual(["settled", "cleanup"]);
    } finally {
      gate.resolve([]);
      socket.destroy();
    }
  });

  it("does not clean the runtime while work abandoned by a client disconnect is running", async () => {
    const { handle, socketPath, events, cleanup, search, gate } = await ownershipFixture({
      shutdownTimeoutMs: 50,
    });
    const socket = await connect(socketPath);
    socket.write(requestBytes("t2", "needle"));
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    socket.destroy();
    await waitForClose(socket);

    try {
      const shutdown = handle.shutdown();
      await sleep(100);
      expect(cleanup).not.toHaveBeenCalled();

      events.push("settled");
      gate.resolve([{ title: "late" }]);
      await shutdown;
      expect(events).toEqual(["settled", "cleanup"]);
    } finally {
      gate.resolve([]);
    }
  });

  it("does not let shutdownTimeoutMs let cleanup overtake running runtime work", async () => {
    const { handle, socketPath, events, cleanup, search, gate } = await ownershipFixture({
      shutdownTimeoutMs: 20,
    });
    const socket = await connect(socketPath);
    socket.write(requestBytes("t3", "needle"));
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));

    try {
      const shutdown = handle.shutdown();
      await sleep(200);
      expect(cleanup).not.toHaveBeenCalled();

      events.push("settled");
      gate.resolve([{ title: "late" }]);
      await shutdown;
      expect(events).toEqual(["settled", "cleanup"]);
    } finally {
      gate.resolve([]);
      socket.destroy();
    }
  });

  it("keeps the connection slot occupied until detached runtime work settles", async () => {
    const { socketPath, records, search, gate } = await ownershipFixture({ maxConnections: 1 });
    const a = await connect(socketPath);
    a.write(requestBytes("a", "needle"));
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    await waitForClose(a);

    try {
      const rejectedBefore = records.filter(
        (record) => record.event === "rpc.connection.admission_rejected",
      ).length;
      const b = await connect(socketPath);
      const bData: Buffer[] = [];
      b.on("data", (chunk: Buffer) => bData.push(chunk));
      b.on("error", () => undefined);
      await waitForClose(b);
      expect(bData).toHaveLength(0);
      expect(
        records.filter((record) => record.event === "rpc.connection.admission_rejected").length,
      ).toBe(rejectedBefore + 1);

      gate.resolve([{ title: "done" }]);
      await sleep(20);
      search.mockImplementation(async () => [{ title: "c" }]);
      const c = await connect(socketPath);
      c.write(requestBytes("c", "needle"));
      expect(await readFrame(c)).toMatchObject({ id: "c", ok: true });
      c.destroy();
    } finally {
      gate.resolve([]);
    }
  });

  it("regression: a normal request then shutdown answers and cleans up once without added wait", async () => {
    const { handle, socketPath, events, cleanup, search, gate } = await ownershipFixture({
      shutdownTimeoutMs: 50,
    });
    gate.resolve([{ title: "fast" }]);
    const socket = await connect(socketPath);
    socket.write(requestBytes("n", "needle"));
    expect(await readFrame(socket)).toMatchObject({ id: "n", ok: true });
    expect(search).toHaveBeenCalledTimes(1);

    const startedMs = Date.now();
    socket.destroy();
    await handle.shutdown();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["cleanup"]);
    expect(Date.now() - startedMs).toBeLessThan(1_000);
  });
});

describe("R10b — socket group is applied and verified", () => {
  const GROUP_MESSAGE = "nookd socket group could not be applied";
  const SOCKET_MODE = 0o770;

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  async function groupSocketPath(): Promise<string> {
    const directory = await mkdtemp(path.join("/tmp", "nbk-r10b-"));
    tempDirectories.push(directory);
    return path.join(directory, "nookbridge.sock");
  }

  function startGrouped(
    socketPath: string,
    options: {
      socketGroup?: string;
      resolveGroupId?: (name: string) => Promise<number | undefined>;
      applySocketGroup?: (socketPath: string, gid: number) => Promise<void>;
    },
  ): Promise<NookdServerHandle> {
    const runtime: NookdServerRuntime = Object.freeze({
      search: async () => [{ title: "served" }],
      cleanup: vi.fn(async () => undefined),
    });
    const started = startNookdServer({
      socketPath,
      runtime,
      installSignalHandlers: false,
      socketMode: SOCKET_MODE,
      ...options,
    } as Parameters<typeof startNookdServer>[0]);
    // Track a (wrongly) successful start so a RED run does not leak the server.
    started.then(
      (handle) => handles.push(handle),
      () => undefined,
    );
    return started;
  }

  const supplementaryGid = (): number => {
    const egid = process.getegid?.() ?? -1;
    const gid = (process.getgroups?.() ?? []).find((candidate) => candidate !== egid);
    if (gid === undefined) throw new Error("test process has no supplementary group");
    return gid;
  };

  async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("condition not reached");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  it("fails closed and unlinks the socket when the group name does not resolve", async () => {
    const socketPath = await groupSocketPath();
    const resolveGroupId = vi.fn(async () => undefined);
    const applySocketGroup = vi.fn(async () => undefined);

    await expect(
      startGrouped(socketPath, { socketGroup: "nbk-clients", resolveGroupId, applySocketGroup }),
    ).rejects.toThrow(GROUP_MESSAGE);

    expect(resolveGroupId).toHaveBeenCalledWith("nbk-clients");
    expect(applySocketGroup).not.toHaveBeenCalled();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("fails closed and unlinks the socket when the resolver throws", async () => {
    const socketPath = await groupSocketPath();
    const resolveGroupId = vi.fn(async (): Promise<number | undefined> => {
      throw new Error("/etc/group exploded with a secret path");
    });
    const applySocketGroup = vi.fn(async () => undefined);

    const failure = await startGrouped(socketPath, {
      socketGroup: "nbk-clients",
      resolveGroupId,
      applySocketGroup,
    }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toBe(GROUP_MESSAGE);
    expect(String(failure?.message)).not.toContain("secret");
    expect(applySocketGroup).not.toHaveBeenCalled();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("does not chown when the socket already has the resolved group", async () => {
    const socketPath = await groupSocketPath();
    const egid = process.getegid?.() ?? -1;
    const applySocketGroup = vi.fn(async () => undefined);

    await startGrouped(socketPath, {
      socketGroup: "nbk-clients",
      resolveGroupId: async () => egid,
      applySocketGroup,
    });

    const socketStat = await lstat(socketPath);
    expect(socketStat.gid).toBe(egid);
    expect(socketStat.mode & 0o777).toBe(SOCKET_MODE);
    expect(applySocketGroup).toHaveBeenCalledTimes(0);
  });

  it("applies a supplementary group and verifies the result", async () => {
    const socketPath = await groupSocketPath();
    const gid = supplementaryGid();
    const applySocketGroup = vi.fn((target: string, group: number) => lchown(target, -1, group));

    await startGrouped(socketPath, {
      socketGroup: "nbk-clients",
      resolveGroupId: async () => gid,
      applySocketGroup,
    });

    const socketStat = await lstat(socketPath);
    expect(applySocketGroup).toHaveBeenCalledTimes(1);
    expect(applySocketGroup).toHaveBeenCalledWith(socketPath, gid);
    expect(socketStat.gid).toBe(gid);
    expect(socketStat.mode & 0o777).toBe(SOCKET_MODE);
  });

  it("fails closed and unlinks the socket when the chown throws", async () => {
    const socketPath = await groupSocketPath();
    const applySocketGroup = vi.fn(async (): Promise<void> => {
      throw new Error("EPERM with a secret path");
    });

    const failure = await startGrouped(socketPath, {
      socketGroup: "nbk-clients",
      resolveGroupId: async () => supplementaryGid(),
      applySocketGroup,
    }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toBe(GROUP_MESSAGE);
    expect(applySocketGroup).toHaveBeenCalledTimes(1);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("fails closed when the chown reports success but the group did not change", async () => {
    const socketPath = await groupSocketPath();
    const applySocketGroup = vi.fn(async () => undefined);

    await expect(
      startGrouped(socketPath, {
        socketGroup: "nbk-clients",
        resolveGroupId: async () => supplementaryGid(),
        applySocketGroup,
      }),
    ).rejects.toThrow(GROUP_MESSAGE);

    expect(applySocketGroup).toHaveBeenCalledTimes(1);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("destroys a connection that arrives before the group is verified", async () => {
    const socketPath = await groupSocketPath();
    const gate = deferred<number | undefined>();
    const resolveGroupId = vi.fn(() => gate.promise);
    const applySocketGroup = vi.fn(async () => undefined);
    const started = startGrouped(socketPath, {
      socketGroup: "nbk-clients",
      resolveGroupId,
      applySocketGroup,
    });

    await waitUntil(() => resolveGroupId.mock.calls.length > 0);
    const early = net.createConnection(socketPath);
    const earlyData: Buffer[] = [];
    early.on("data", (chunk: Buffer) => earlyData.push(chunk));
    // The server may reset the peer before or after the connect completes.
    const earlyClosed = new Promise<void>((resolve) => early.on("close", () => resolve()));
    early.on("error", () => undefined);
    early.write(requestBytes("early", "needle"));
    await earlyClosed;
    expect(earlyData).toHaveLength(0);

    gate.resolve(process.getegid?.() ?? -1);
    const handle = await started;
    expect(handle.socketPath).toBe(socketPath);

    const later = await connect(socketPath);
    later.write(requestBytes("later", "needle"));
    const response = await readFrame(later);
    expect(response).toMatchObject({ id: "later", ok: true });
    later.destroy();
  });

  it("neither resolves nor applies a group when none is configured", async () => {
    const socketPath = await groupSocketPath();
    const resolveGroupId = vi.fn(async () => undefined);
    const applySocketGroup = vi.fn(async () => undefined);

    await startGrouped(socketPath, { resolveGroupId, applySocketGroup });

    const socket = await connect(socketPath);
    socket.write(requestBytes("plain", "needle"));
    const response = await readFrame(socket);
    expect(response).toMatchObject({ id: "plain", ok: true });
    expect(applySocketGroup).not.toHaveBeenCalled();
    expect(resolveGroupId).not.toHaveBeenCalled();
    socket.destroy();
  });
});

describe("R11 — audit records real peer credentials", () => {
  type ResolvePeer = (socket: net.Socket, signal: AbortSignal) => Promise<OperatorPeer | undefined>;
  type StartOptions = Parameters<typeof startNookdServer>[0];

  const allRecords: ServiceAuditRecord[] = [];
  const PER_CONNECTION_EVENTS = [
    "rpc.request.parsed",
    "rpc.request.received",
    "rpc.request.dispatched",
    "rpc.response.sent",
    "rpc.connection.closed",
  ] as const;

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function auditSink(records: ServiceAuditRecord[]): Logger {
    const capture = (record?: LogRecord): void => {
      if (record === undefined || record.component !== "service_audit") return;
      const captured = record as unknown as ServiceAuditRecord;
      records.push(captured);
      allRecords.push(captured);
    };
    return {
      debug: (_message, record) => capture(record),
      info: (_message, record) => capture(record),
      warn: (_message, record) => capture(record),
      error: (_message, record) => capture(record),
      child: () => auditSink(records),
      setSink: () => undefined,
    };
  }

  async function r11Fixture(
    options: {
      search?: NookdServerRuntime["search"];
      resolvePeer?: ResolvePeer;
      maxConnections?: number;
      abuseBounds?: StartOptions["abuseBounds"];
    } = {},
  ): Promise<{
    handle: NookdServerHandle;
    socketPath: string;
    records: ServiceAuditRecord[];
    search: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
  }> {
    const directory = await mkdtemp(path.join("/tmp", "nbk-r11-"));
    tempDirectories.push(directory);
    const socketPath = path.join(directory, "nookbridge.sock");
    const records: ServiceAuditRecord[] = [];
    const search = vi.fn(options.search ?? (async () => [{ title: "r11" }]));
    const cleanup = vi.fn(async () => undefined);
    const handle = await startNookdServer({
      socketPath,
      runtime: Object.freeze({ search, cleanup }) as NookdServerRuntime,
      installSignalHandlers: false,
      auditLogger: auditSink(records),
      ...(options.resolvePeer === undefined ? {} : { resolvePeer: options.resolvePeer }),
      ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
      ...(options.abuseBounds === undefined ? {} : { abuseBounds: options.abuseBounds }),
    });
    handles.push(handle);
    return { handle, socketPath, records, search, cleanup };
  }

  async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("condition not reached");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  async function waitForClosedRecord(records: ServiceAuditRecord[]): Promise<void> {
    await vi.waitFor(() =>
      expect(records.some((record) => record.event === "rpc.connection.closed")).toBe(true),
    );
  }

  function expectConnectionCategories(
    records: ServiceAuditRecord[],
    category: ServiceAuditRecord["peerCredentials"],
  ): void {
    const observed = records.filter((record) =>
      (PER_CONNECTION_EVENTS as readonly string[]).includes(record.event),
    );
    expect(observed).toHaveLength(PER_CONNECTION_EVENTS.length);
    for (const record of observed) {
      expect(record.peerCredentials).toBe(category);
    }
  }

  const selfPeer = (): OperatorPeer => ({
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    groups: ["x"],
  });

  it("A1 audits a same-uid peer as self on every per-connection record", async () => {
    const resolvePeer = vi.fn<ResolvePeer>(async () => selfPeer());
    const { socketPath, records } = await r11Fixture({
      resolvePeer,
      search: async (query) => [{ title: `hit:${query}` }],
    });
    const socket = await connect(socketPath);
    socket.write(requestBytes("r11-a1", "needle"));

    expect(await readFrame(socket)).toMatchObject({ id: "r11-a1", ok: true });
    socket.destroy();
    await waitForClose(socket);
    await waitForClosedRecord(records);

    expectConnectionCategories(records, "self");
  });

  it("A2 audits a different uid as verified", async () => {
    const resolvePeer = vi.fn<ResolvePeer>(async () => ({
      ...selfPeer(),
      uid: (process.getuid?.() ?? 0) + 1,
    }));
    const { socketPath, records } = await r11Fixture({ resolvePeer });
    const socket = await connect(socketPath);
    socket.write(requestBytes("r11-a2", "needle"));

    expect(await readFrame(socket)).toMatchObject({ id: "r11-a2", ok: true });
    socket.destroy();
    await waitForClose(socket);
    await waitForClosedRecord(records);

    expectConnectionCategories(records, "verified");
  });

  it("A3 locks the unresolved-peer path: audit unknown but still serve", async () => {
    const resolvePeer = vi.fn<ResolvePeer>(async () => undefined);
    const { socketPath, records } = await r11Fixture({ resolvePeer });
    const socket = await connect(socketPath);
    socket.write(requestBytes("r11-a3", "needle"));

    expect(await readFrame(socket)).toMatchObject({ id: "r11-a3", ok: true });
    socket.destroy();
    await waitForClose(socket);
    await waitForClosedRecord(records);

    expectConnectionCategories(records, "unknown");
  });

  it("A4 maps a rejected resolver to unknown without an unhandled rejection", async () => {
    const resolvePeer = vi.fn<ResolvePeer>(async () => {
      throw new Error("helper exploded with a credential canary");
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { socketPath, records } = await r11Fixture({ resolvePeer });
      const socket = await connect(socketPath);
      socket.write(requestBytes("r11-a4", "needle"));

      expect(await readFrame(socket)).toMatchObject({ id: "r11-a4", ok: true });
      socket.destroy();
      await waitForClose(socket);
      await waitForClosedRecord(records);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(resolvePeer).toHaveBeenCalledTimes(1);
      expectConnectionCategories(records, "unknown");
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("A5 resolves the peer once per connection", async () => {
    const resolvePeer = vi.fn<ResolvePeer>(async () => selfPeer());
    const { socketPath } = await r11Fixture({ resolvePeer });
    const socket = await connect(socketPath);
    socket.write(requestBytes("r11-a5-one", "one"));
    expect(await readFrame(socket)).toMatchObject({ id: "r11-a5-one", ok: true });
    socket.write(requestBytes("r11-a5-two", "two"));
    expect(await readFrame(socket)).toMatchObject({ id: "r11-a5-two", ok: true });

    expect(resolvePeer).toHaveBeenCalledTimes(1);
    socket.destroy();
  });

  it("A6 audits an over-cap connection as rejected and resolves only the admitted peer", async () => {
    const resolvePeer = vi.fn<ResolvePeer>(async () => selfPeer());
    const { socketPath, records } = await r11Fixture({ resolvePeer, maxConnections: 1 });
    const first = await connect(socketPath);
    const second = await connect(socketPath);
    second.on("error", () => undefined);
    await waitForClose(second);

    const rejected = records.filter(
      (record) => record.event === "rpc.connection.admission_rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.peerCredentials).toBe("rejected");
    expect(resolvePeer).toHaveBeenCalledTimes(1);
    first.destroy();
  });

  it("A7 audits pre-gate connections as rejected and never starts their resolver", async () => {
    const directory = await mkdtemp(path.join("/tmp", "nbk-r11-group-"));
    tempDirectories.push(directory);
    const socketPath = path.join(directory, "nookbridge.sock");
    const records: ServiceAuditRecord[] = [];
    const gate = deferred<number | undefined>();
    const resolveGroupId = vi.fn(() => gate.promise);
    const resolvePeer = vi.fn<ResolvePeer>(async () => selfPeer());
    const search = vi.fn(async () => [{ title: "served" }]);
    const cleanup = vi.fn(async () => undefined);
    const started = startNookdServer({
      socketPath,
      runtime: Object.freeze({ search, cleanup }) as NookdServerRuntime,
      installSignalHandlers: false,
      socketMode: 0o770,
      socketGroup: "g",
      resolveGroupId,
      auditLogger: auditSink(records),
      resolvePeer,
    });
    started.then(
      (handle) => handles.push(handle),
      () => undefined,
    );

    await waitUntil(() => resolveGroupId.mock.calls.length > 0);
    const early = net.createConnection(socketPath);
    early.on("error", () => undefined);
    const earlyClosed = new Promise<void>((resolve) => early.on("close", () => resolve()));
    early.write(requestBytes("r11-a7-early", "needle"));
    await earlyClosed;

    const earlyRejected = records.filter(
      (record) => record.event === "rpc.connection.admission_rejected",
    );
    expect(earlyRejected).toHaveLength(1);
    expect(earlyRejected[0]?.peerCredentials).toBe("rejected");
    expect(resolvePeer).not.toHaveBeenCalled();

    gate.resolve(process.getegid?.() ?? -1);
    const handle = await started;
    expect(handle.socketPath).toBe(socketPath);

    const later = await connect(socketPath);
    later.write(requestBytes("r11-a7-later", "needle"));
    expect(await readFrame(later)).toMatchObject({ id: "r11-a7-later", ok: true });
    later.destroy();
    await waitForClose(later);
    await waitForClosedRecord(records);

    expect(resolvePeer).toHaveBeenCalledTimes(1);
    expectConnectionCategories(records, "self");
  });

  it("A8 aborts a pending peer lookup on shutdown before the runtime is touched", async () => {
    let seenSignal: AbortSignal | undefined;
    const resolvePeer = vi.fn<ResolvePeer>((_socket, signal) => {
      seenSignal = signal;
      return new Promise<OperatorPeer | undefined>(() => undefined);
    });
    const { handle, socketPath, records, search, cleanup } = await r11Fixture({
      resolvePeer,
    });
    const socket = await connect(socketPath);
    socket.on("error", () => undefined);
    socket.write(requestBytes("r11-a8", "needle"));

    await vi.waitFor(() => expect(resolvePeer).toHaveBeenCalledTimes(1));
    await handle.shutdown();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(seenSignal?.aborted).toBe(true);
    expect(search).not.toHaveBeenCalled();
    expect(records.some((record) => record.event === "rpc.request.received")).toBe(false);
    socket.destroy();
  });

  it("A9 bounds the peer wait at 1000 ms and audits unknown", async () => {
    vi.useFakeTimers();
    try {
      const resolvePeer = vi.fn<ResolvePeer>(
        () =>
          new Promise<OperatorPeer | undefined>((resolve) => {
            setTimeout(() => resolve(selfPeer()), 1_500);
          }),
      );
      const search = vi.fn(async () => [{ title: "bounded" }]);
      const { socketPath, records } = await r11Fixture({ resolvePeer, search });
      const socket = await connect(socketPath);
      const responsePromise = readFrame(socket);
      socket.write(requestBytes("r11-a9", "needle"));

      await vi.advanceTimersByTimeAsync(1_000);
      expect(await responsePromise).toMatchObject({ id: "r11-a9", ok: true });
      expect(resolvePeer).toHaveBeenCalledTimes(1);
      expect(search).toHaveBeenCalledTimes(1);

      const observed = records.filter((record) =>
        (PER_CONNECTION_EVENTS as readonly string[]).includes(record.event),
      );
      expect(observed.length).toBeGreaterThanOrEqual(4);
      for (const record of observed) {
        expect(record.peerCredentials).toBe("unknown");
      }
      socket.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("A10 keeps the six-field record shape and never records numeric peer ids", () => {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    expect(allRecords.length).toBeGreaterThan(0);
    for (const record of allRecords) {
      expect(Object.keys(record).filter((key) => key !== "component")).toEqual([
        "event",
        "outcome",
        "method",
        "requestIdEcho",
        "latencyMs",
        "peerCredentials",
      ]);
      for (const value of Object.values(record)) {
        expect(value).not.toBe(uid);
        expect(value).not.toBe(gid);
      }
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
