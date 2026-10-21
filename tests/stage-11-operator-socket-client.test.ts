import process from "node:process";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { setTimeout as scheduleTimeout } from "node:timers";
import type * as NodeTimers from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startOperatorSocketServer } from "../src/service/operator-socket-server.js";
import {
  OperatorSocketClient,
  type OperatorSocketConnect,
  type OperatorSocketResult,
} from "../src/operator/operator-socket-client.js";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";
import { OperatorWriteError } from "../src/service/notes-operator-write-runtime.js";

/**
 * `vi.useFakeTimers()` replaces `globalThis.setTimeout`, but an ESM
 * `import { setTimeout } from "node:timers"` binds the builtin namespace and
 * keeps the real timer. Route the module's timer imports through the global
 * implementation so the R9b deadline tests can drive time deterministically;
 * outside those tests the wrapper is a passthrough to the real timers.
 */
vi.mock("node:timers", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeTimers>();
  return {
    ...actual,
    setTimeout: (
      handler: () => void,
      timeoutMs?: number,
    ): ReturnType<typeof globalThis.setTimeout> => globalThis.setTimeout(handler, timeoutMs),
    clearTimeout: (handle?: Parameters<typeof globalThis.clearTimeout>[0]): void =>
      globalThis.clearTimeout(handle),
  };
});

const socketPath = () =>
  `/tmp/operator-client-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;

const HANDLE = `not_${"A".repeat(16)}`;
const PREIMAGE = {
  kind: "preimage" as const,
  id: HANDLE,
  revision: `rev_${"a".repeat(32)}`,
  markdown: "# Title\n\nbody\n",
  contentBytes: 14,
};

async function withServer(
  handle: Parameters<typeof createOperatorDiscoveryHandler>[0],
  run: (client: OperatorSocketClient) => Promise<void>,
): Promise<void> {
  const path = socketPath();
  const server = await startOperatorSocketServer({
    socketPath: path,
    socketPathRoot: "/tmp",
    resolvePeer: () => ({ uid: 1, gid: 2, groups: ["nookbridge-operators"] }),
    authorize: (method) => ({ allowed: true, method }),
    handle: createOperatorDiscoveryHandler(handle),
  });
  try {
    await run(new OperatorSocketClient({ socketPath: path }));
  } finally {
    await server.close();
  }
}

describe("operator socket client", () => {
  it("round-trips a protected discovery request", async () => {
    const path = socketPath();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: () => ({ uid: 1, gid: 2, groups: ["nookbridge-operators"] }),
      authorize: (method) => ({ allowed: true, method }),
      handle: createOperatorDiscoveryHandler({
        browse: async () => ({ notes: [{ handle: "h_one", label: "One", bytes: 3 }], next: null }),
        search: async () => ({ notes: [], next: null }),
      }),
    });
    try {
      const client = new OperatorSocketClient({ socketPath: path });
      const result = await client.request("notes.browse", { limit: 1 });
      expect(result).toEqual({
        ok: true,
        result: {
          kind: "operator-page",
          notes: [{ handle: "h_one", label: "One", bytes: 3 }],
          next: null,
        },
      });
    } finally {
      await server.close();
    }
  });

  /**
   * The daemon answers a losing optimistic-concurrency check with a
   * categorical `stale_revision` or `conflict` envelope.  The client must
   * forward those categories: collapsing them to `service_unavailable`
   * would tell the operator "runtime unavailable" when the real answer is
   * "someone else changed this note".
   */
  it.each(["conflict", "stale_revision", "vault_locked", "sync_failed"] as const)(
    "forwards a %s envelope as its own category",
    async (code) => {
      await withServer(
        {
          browse: async () => ({ notes: [], next: null }),
          search: async () => ({ notes: [], next: null }),
          editPreimage: async () => PREIMAGE,
          applyEdit: async () => {
            // Use the real categorical failure type: a plain Error with a
            // fabricated `code` field is exactly the shape the handler must not
            // trust, so a stub that threw one would be testing the loose
            // contract rather than the one the runtime actually provides.
            throw new OperatorWriteError(code);
          },
        },
        async (client) => {
          const result = await client.request("notes.apply-edit", {
            id: HANDLE,
            expectedRevision: `rev_${"a".repeat(32)}`,
            markdown: "# Title\n\nbody\n",
          });
          expect(result).toEqual({ ok: false, code });
        },
      );
    },
  );

  it("collapses a category outside the daemon vocabulary to service_unavailable", async () => {
    await withServer(
      {
        browse: async () => ({ notes: [], next: null }),
        search: async () => ({ notes: [], next: null }),
        editPreimage: async () => PREIMAGE,
        applyEdit: async () => {
          const error = new Error("categorical") as Error & { code: string };
          error.code = "mystery_category";
          throw error;
        },
      },
      async (client) => {
        const result = await client.request("notes.apply-edit", {
          id: HANDLE,
          expectedRevision: `rev_${"a".repeat(32)}`,
          markdown: "# Title\n\nbody\n",
        });
        expect(result).toEqual({ ok: false, code: "service_unavailable" });
      },
    );
  });
});

/**
 * R9b — the operator client must spend one deadline on the whole request.
 *
 * These tests replace the transport with the `connect` seam so the timing is
 * deterministic under fake timers: no live socket, no daemon, no filesystem.
 */

const PAGE_RESULT = { kind: "operator-page", notes: [], next: null } as const;

function requestIdOf(frame: Buffer): string {
  const length = frame.readUInt32BE(0);
  return (JSON.parse(frame.subarray(4, 4 + length).toString("utf8")) as { id: string }).id;
}

function responseFrame(id: string, result: unknown): Buffer {
  const body = Buffer.from(JSON.stringify({ id, ok: true, result }), "utf8");
  const frame = Buffer.alloc(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

interface FakeSocketOptions {
  /** Emit one framed reply this many milliseconds after the request write. */
  readonly respondAfterMs?: number;
  /** Never call the write callback, modelling a stalled kernel buffer. */
  readonly stallWriteCallback?: boolean;
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly #options: FakeSocketOptions;

  constructor(options: FakeSocketOptions = {}) {
    super();
    this.#options = options;
  }

  write(frame: Buffer, callback?: (error?: Error | null) => void): boolean {
    if (this.#options.respondAfterMs !== undefined) {
      const id = requestIdOf(frame);
      scheduleTimeout(() => {
        this.emit("data", responseFrame(id, PAGE_RESULT));
      }, this.#options.respondAfterMs);
    }
    if (this.#options.stallWriteCallback !== true) callback?.(null);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
    this.removeAllListeners();
  }

  asSocket(): Socket {
    return this as unknown as Socket;
  }
}

function connectNow(socket: FakeSocket): OperatorSocketConnect {
  return () => Promise.resolve(socket.asSocket());
}

function connectAfter(ms: number, socket: FakeSocket): OperatorSocketConnect {
  return () =>
    new Promise<Socket>((resolveSocket) => {
      scheduleTimeout(() => resolveSocket(socket.asSocket()), ms);
    });
}

function stalledConnect(): OperatorSocketConnect {
  return () => new Promise<Socket>(() => undefined);
}

interface ObservedRequest {
  settled: boolean;
  result?: OperatorSocketResult;
}

function observe(promise: Promise<OperatorSocketResult>): ObservedRequest {
  const state: ObservedRequest = { settled: false };
  void promise.then((result) => {
    state.settled = true;
    state.result = result;
  });
  return state;
}

describe("R9b — whole-operation deadline", () => {
  const path = `/tmp/operator-client-deadline-${process.pid}.sock`;
  const timeoutMs = 1_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out a connect that never settles", async () => {
    const client = new OperatorSocketClient({
      socketPath: path,
      timeoutMs,
      connect: stalledConnect(),
    });
    const state = observe(client.request("notes.browse", { limit: 1 }));

    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(state.result).toEqual({ ok: false, code: "service_unavailable" });
  });

  it("times out when connect and the reply together exceed the deadline", async () => {
    const socket = new FakeSocket({ respondAfterMs: 600 });
    const client = new OperatorSocketClient({
      socketPath: path,
      timeoutMs,
      connect: connectAfter(600, socket),
    });
    const state = observe(client.request("notes.browse", { limit: 1 }));

    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(state.result).toEqual({ ok: false, code: "service_unavailable" });

    // The late reply must not revive the request.
    await vi.advanceTimersByTimeAsync(600);
    expect(state.result).toEqual({ ok: false, code: "service_unavailable" });
    expect(socket.destroyed).toBe(true);
  });

  it("times out when the write callback never fires", async () => {
    const socket = new FakeSocket({ stallWriteCallback: true });
    const client = new OperatorSocketClient({
      socketPath: path,
      timeoutMs,
      connect: connectNow(socket),
    });
    const state = observe(client.request("notes.browse", { limit: 1 }));

    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(state.result).toEqual({ ok: false, code: "service_unavailable" });
  });

  it("completes a reply that arrives inside the deadline", async () => {
    const socket = new FakeSocket({ respondAfterMs: 900 });
    const client = new OperatorSocketClient({
      socketPath: path,
      timeoutMs,
      connect: connectNow(socket),
    });
    const state = observe(client.request("notes.browse", { limit: 1 }));

    await vi.advanceTimersByTimeAsync(900);
    expect(state.result).toEqual({ ok: true, result: PAGE_RESULT });
  });

  it("applies the twelve-second default deadline to connect as well as read", async () => {
    const client = new OperatorSocketClient({
      socketPath: path,
      connect: stalledConnect(),
    });
    const state = observe(client.request("notes.browse", { limit: 1 }));

    await vi.advanceTimersByTimeAsync(10_001);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(state.result).toEqual({ ok: false, code: "service_unavailable" });
  });

  it("destroys a socket that connects after the deadline", async () => {
    const socket = new FakeSocket();
    const client = new OperatorSocketClient({
      socketPath: path,
      timeoutMs,
      connect: connectAfter(1_500, socket),
    });
    const state = observe(client.request("notes.browse", { limit: 1 }));

    await vi.advanceTimersByTimeAsync(timeoutMs);
    expect(state.result).toEqual({ ok: false, code: "service_unavailable" });

    await vi.advanceTimersByTimeAsync(500);
    expect(socket.destroyed).toBe(true);
    expect(state.result).toEqual({ ok: false, code: "service_unavailable" });
  });
});
