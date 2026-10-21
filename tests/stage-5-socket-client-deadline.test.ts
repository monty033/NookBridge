/**
 * STEP R9a — the MCP socket client deadline covers the whole request.
 *
 * The defect at a4d548e timed only `readFramedResponse`, after the
 * connect and write had already completed. A stalled connect or an
 * unwritable socket therefore bypassed the timeout entirely, and the
 * 5 s default was shorter than the daemon's own 10 s request deadline.
 *
 * These tests drive the client through its `connect` seam with fake
 * timers so no real socket is ever opened.
 */

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NookdSocketClient } from "../src/mcp/socket-client.js";
import { DEFAULT_SERVICE_ABUSE_BOUNDS } from "../src/service/service-abuse-bounds.js";

type WriteCallback = (error?: Error | null) => void;

class FakeSocket extends EventEmitter {
  destroyCount = 0;
  writeCount = 0;
  readonly #onWrite: (frame: Buffer, done: WriteCallback) => void;

  constructor(onWrite: (frame: Buffer, done: WriteCallback) => void) {
    super();
    this.#onWrite = onWrite;
  }

  write(frame: Uint8Array, callback: WriteCallback): boolean {
    this.writeCount += 1;
    this.#onWrite(Buffer.from(frame), callback);
    return true;
  }

  destroy(): this {
    this.destroyCount += 1;
    return this;
  }
}

function idOfRequest(frame: Buffer): string {
  const parsed = JSON.parse(frame.subarray(4).toString("utf8")) as { id: string };
  return parsed.id;
}

function statusFrame(id: string): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      id,
      ok: true,
      result: { kind: "status", lastSynced: 0, hasUnsyncedChanges: false },
    }),
    "utf8",
  );
  const frame = Buffer.alloc(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

function asSocket(socket: FakeSocket): Socket {
  return socket as unknown as Socket;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("R9a — whole-operation deadline", () => {
  it("times out a connect that never settles and aborts the pending connect", async () => {
    vi.useFakeTimers();
    const fake = new FakeSocket(() => {
      throw new Error("write must not be reached");
    });
    const client = new NookdSocketClient({
      socketPath: "/tmp/r9a-never-connect.sock",
      ioTimeoutMs: 1000,
      connect: (_path, signal) =>
        new Promise<Socket>(() => {
          signal?.addEventListener(
            "abort",
            () => {
              fake.destroy();
            },
            { once: true },
          );
        }),
    });

    let settled = false;
    const pending = client.status();
    pending
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, code: "service_unavailable" });
    expect(fake.destroyCount).toBeGreaterThan(0);
    expect(fake.writeCount).toBe(0);
  });

  it("times out a write whose callback never fires", async () => {
    vi.useFakeTimers();
    const fake = new FakeSocket(() => {
      // The write is accepted but never acknowledges.
    });
    const client = new NookdSocketClient({
      socketPath: "/tmp/r9a-stalled-write.sock",
      ioTimeoutMs: 1000,
      connect: async () => asSocket(fake),
    });

    let settled = false;
    const pending = client.status();
    pending
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);

    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, code: "service_unavailable" });
    expect(fake.writeCount).toBe(1);
    expect(fake.destroyCount).toBeGreaterThan(0);
  });

  it("does not extend the deadline when connect itself consumes part of it", async () => {
    vi.useFakeTimers();
    const fake = new FakeSocket((frame, done) => {
      const id = idOfRequest(frame);
      done();
      globalThis.setTimeout(() => {
        fake.emit("data", statusFrame(id));
      }, 600);
    });
    const client = new NookdSocketClient({
      socketPath: "/tmp/r9a-partial-connect.sock",
      ioTimeoutMs: 1000,
      connect: async () =>
        await new Promise<Socket>((resolve) => {
          globalThis.setTimeout(() => resolve(asSocket(fake)), 600);
        }),
    });

    let settled = false;
    const pending = client.status();
    pending
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, code: "service_unavailable" });
    expect(fake.destroyCount).toBeGreaterThan(0);
    expect(fake.listenerCount("data")).toBe(0);

    // The late response arrives after the deadline and must be ignored.
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toEqual({ ok: false, code: "service_unavailable" });
  });

  it("succeeds when connect, write and read finish inside the deadline", async () => {
    vi.useFakeTimers();
    const fake = new FakeSocket((frame, done) => {
      const id = idOfRequest(frame);
      done();
      globalThis.setTimeout(() => {
        fake.emit("data", statusFrame(id));
      }, 500);
    });
    const client = new NookdSocketClient({
      socketPath: "/tmp/r9a-in-budget.sock",
      ioTimeoutMs: 1000,
      connect: async () =>
        await new Promise<Socket>((resolve) => {
          globalThis.setTimeout(() => resolve(asSocket(fake)), 100);
        }),
    });

    const pending = client.status();
    await vi.advanceTimersByTimeAsync(900);
    await expect(pending).resolves.toEqual({
      ok: true,
      envelope: {
        id: expect.any(String),
        ok: true,
        result: { kind: "status", lastSynced: 0, hasUnsyncedChanges: false },
      },
    });
    expect(fake.destroyCount).toBeGreaterThan(0);
  });

  it("defaults to a deadline longer than the daemon request timeout", async () => {
    vi.useFakeTimers();
    const fake = new FakeSocket(() => {
      throw new Error("write must not be reached");
    });
    const client = new NookdSocketClient({
      socketPath: "/tmp/r9a-default-deadline.sock",
      connect: (_path, signal) =>
        new Promise<Socket>(() => {
          signal?.addEventListener(
            "abort",
            () => {
              fake.destroy();
            },
            { once: true },
          );
        }),
    });

    let settled = false;
    const pending = client.status();
    pending
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);

    await vi.advanceTimersByTimeAsync(10_001);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_998);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, code: "service_unavailable" });
    expect(12_000).toBeGreaterThan(DEFAULT_SERVICE_ABUSE_BOUNDS.requestTimeoutMs);
    expect(fake.destroyCount).toBeGreaterThan(0);
  });
});
