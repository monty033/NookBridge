import { Buffer } from "node:buffer";
import net from "node:net";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import {
  startOperatorSocketServer,
  type StartOperatorSocketServerOptions,
} from "../src/service/operator-socket-server.js";

const PEER = { uid: 1, gid: 2, groups: ["nookbridge-operators"] };
const RESPONSE = {
  id: "r1",
  ok: false as const,
  error: { code: "service_unavailable" as const, message: "Service unavailable" },
};

type Client = {
  socket: net.Socket;
  closed: Promise<number>;
  chunks: Buffer[];
};

async function withSocket(
  limits: Partial<StartOperatorSocketServerOptions>,
  run: (connect: () => Promise<Client>) => Promise<void>,
): Promise<void> {
  const socketPath = `/tmp/operator-limits-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;
  const clients: Client[] = [];
  const server = await startOperatorSocketServer({
    socketPath,
    socketPathRoot: "/tmp",
    resolvePeer: () => PEER,
    authorize: () => ({ allowed: true, method: "notes.browse" }),
    handle: async () => RESPONSE,
    idleTimeoutMs: 2_000,
    maxConnectionLifetimeMs: 4_000,
    ...limits,
  });
  const connect = async (): Promise<Client> => {
    const started = performance.now();
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => undefined);
    const closed = new Promise<number>((resolve) => {
      socket.once("close", () => resolve(performance.now() - started));
    });
    const client = { socket, closed, chunks };
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return client;
  };
  try {
    await run(connect);
  } finally {
    for (const client of clients) client.socket.destroy();
    await Promise.all(clients.map((client) => client.closed));
    await server.close();
  }
}

async function closedWithin(client: Client, maximumMs: number): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("socket did not close in time")), maximumMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sendRequest(client: Client): void {
  const payload = Buffer.from(JSON.stringify({ id: "r1", method: "notes.browse", params: {} }));
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  client.socket.write(frame);
}

function expectResponse(client: Client): void {
  const frame = Buffer.concat(client.chunks);
  expect(frame.length).toBeGreaterThan(4);
  expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
  expect(JSON.parse(frame.subarray(4).toString("utf8"))).toEqual(RESPONSE);
}

describe("operator socket connection limits", () => {
  it("silently rejects excess connections before peer resolution and releases slots", async () => {
    let aborted = 0;
    const resolvePeer = vi.fn((_socket: net.Socket, signal: AbortSignal) => {
      signal.addEventListener("abort", () => aborted++);
      return PEER;
    });
    await withSocket({ maxConnections: 2, resolvePeer }, async (connect) => {
      const first = await connect();
      const second = await connect();
      await vi.waitFor(() => expect(resolvePeer).toHaveBeenCalledTimes(2));
      const third = await connect();
      expect(await closedWithin(third, 1_000)).toBeLessThan(1_000);
      expect(third.chunks).toHaveLength(0);
      expect(resolvePeer).toHaveBeenCalledTimes(2);
      expect(first.socket.destroyed).toBe(false);
      expect(second.socket.destroyed).toBe(false);

      first.socket.destroy();
      second.socket.destroy();
      await vi.waitFor(() => expect(aborted).toBe(2));
      const next = await connect();
      sendRequest(next);
      await closedWithin(next, 1_000);
      expectResponse(next);
      expect(resolvePeer).toHaveBeenCalledTimes(3);
    });
  });

  it("silently closes an idle connection after the idle window", async () => {
    await withSocket({ idleTimeoutMs: 200 }, async (connect) => {
      const client = await connect();
      const elapsed = await closedWithin(client, 1_500);
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(1_500);
      expect(client.chunks).toHaveLength(0);
    });
  });

  it("closes a stalled partial prefix after the idle window", async () => {
    await withSocket({ idleTimeoutMs: 200 }, async (connect) => {
      const client = await connect();
      client.socket.write(Buffer.from([0]));
      const elapsed = await closedWithin(client, 1_500);
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(1_500);
      expect(client.chunks).toHaveLength(0);
    });
  });

  it("caps lifetime even when a partial frame keeps the connection active", async () => {
    await withSocket({ idleTimeoutMs: 300, maxConnectionLifetimeMs: 1_200 }, async (connect) => {
      const client = await connect();
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(65_532, 0);
      client.socket.write(prefix);
      const drip = setInterval(() => client.socket.write(Buffer.from([0])), 50);
      try {
        await delay(650);
        expect(client.socket.destroyed).toBe(false);
        const elapsed = await closedWithin(client, 2_500);
        expect(elapsed).toBeGreaterThanOrEqual(1_000);
        expect(elapsed).toBeLessThan(3_000);
        expect(client.chunks).toHaveLength(0);
      } finally {
        clearInterval(drip);
      }
    });
  });

  it("serves a normal single-frame request with small limits", async () => {
    await withSocket(
      { maxConnections: 1, idleTimeoutMs: 300, maxConnectionLifetimeMs: 1_000 },
      async (connect) => {
        const client = await connect();
        sendRequest(client);
        await closedWithin(client, 1_500);
        expectResponse(client);
      },
    );
  });

  it("lets a served request outlast the idle window", async () => {
    // The idle window guards a peer that has produced no request. A handler
    // that is slow to answer — a sync or an upload — must not be dropped as if
    // the connection were idle.
    await withSocket(
      {
        idleTimeoutMs: 200,
        handle: async () => {
          await delay(500);
          return RESPONSE;
        },
      },
      async (connect) => {
        const client = await connect();
        sendRequest(client);
        await closedWithin(client, 1_500);
        expectResponse(client);
      },
    );
  });

  it("closes the server without waiting for an open connection", async () => {
    const socketPath = `/tmp/operator-limits-close-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;
    const server = await startOperatorSocketServer({
      socketPath,
      socketPathRoot: "/tmp",
      resolvePeer: () => PEER,
      authorize: () => ({ allowed: true, method: "notes.browse" }),
      handle: async () => RESPONSE,
      idleTimeoutMs: 5_000,
      maxConnectionLifetimeMs: 5_000,
    });
    const socket = net.createConnection(socketPath);
    socket.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const started = performance.now();
    await server.close();
    expect(performance.now() - started).toBeLessThan(1_000);
    socket.destroy();
  });

  it("waits for in-flight work that outlives the connection", async () => {
    const socketPath = `/tmp/operator-limits-outlive-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const server = await startOperatorSocketServer({
      socketPath,
      socketPathRoot: "/tmp",
      resolvePeer: () => PEER,
      authorize: () => ({ allowed: true, method: "notes.browse" }),
      handle: async () => {
        markStarted?.();
        await delay(500);
        return RESPONSE;
      },
      idleTimeoutMs: 5_000,
      // The connection dies before the handler does.
      maxConnectionLifetimeMs: 200,
    });
    const client = net.createConnection(socketPath);
    client.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    sendRequest({ socket: client, chunks: [] } as unknown as Client);
    await started;
    const startedAt = performance.now();
    await server.close();
    // The socket is gone at ~200 ms; close must still wait for the handler.
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(400);
    client.destroy();
  });

  it("lets a request already in flight finish during close", async () => {
    const socketPath = `/tmp/operator-limits-inflight-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const server = await startOperatorSocketServer({
      socketPath,
      socketPathRoot: "/tmp",
      resolvePeer: () => PEER,
      authorize: () => ({ allowed: true, method: "notes.browse" }),
      handle: async () => {
        markStarted?.();
        await delay(300);
        return RESPONSE;
      },
      idleTimeoutMs: 100,
      maxConnectionLifetimeMs: 5_000,
    });
    const client = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    client.on("data", (chunk: Buffer) => chunks.push(chunk));
    client.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    sendRequest({ socket: client, chunks } as Client);
    // Wait until the request is genuinely in flight before closing.
    await started;
    await server.close();
    await vi.waitFor(() => expect(Buffer.concat(chunks).length).toBeGreaterThan(4));
    expectResponse({ socket: client, chunks } as Client);
    client.destroy();
  });

  for (const field of ["maxConnections", "idleTimeoutMs", "maxConnectionLifetimeMs"] as const) {
    for (const value of [
      0,
      -1,
      1.5,
      Infinity,
      NaN,
      field === "maxConnections" ? 1_025 : 3_600_001,
    ]) {
      it(`rejects ${field}=${value} before binding`, async () => {
        await expect(
          startOperatorSocketServer({
            socketPath: "/tmp/operator-limits-invalid.sock",
            socketPathRoot: "/tmp",
            authorize: () => ({ allowed: true, method: "notes.browse" }),
            handle: async () => RESPONSE,
            [field]: value,
          }),
        ).rejects.toThrow("operator socket connection limit is invalid");
      });
    }
  }
});
