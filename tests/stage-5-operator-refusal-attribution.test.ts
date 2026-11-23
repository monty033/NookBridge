import { Buffer } from "node:buffer";
import process from "node:process";
import net from "node:net";
import { setTimeout } from "node:timers";
import { describe, expect, it } from "vitest";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";
import type { OperatorDiscoveryRuntime } from "../src/service/operator-discovery-handler.js";
import {
  UNATTRIBUTED_METHOD,
  classifyOperatorError,
  createOperatorRefusalLog,
  notWiredRefusal,
} from "../src/service/operator-refusal.js";
import type {
  OperatorRefusal,
  OperatorRefusalSuppressed,
} from "../src/service/operator-refusal.js";
import { startOperatorSocketServer } from "../src/service/operator-socket-server.js";
import type { OperatorSocketPeerResolver } from "../src/service/operator-socket-server.js";
import { OperatorWriteError } from "../src/service/notes-operator-write-runtime.js";
import type { OperatorPeer } from "../src/service/operator-server.js";

const peer: OperatorPeer = {
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
  groups: ["nookbridge-clients"],
};

const emptyPage = { notes: [], next: null };

function runtimeWith(overrides: Partial<OperatorDiscoveryRuntime> = {}): OperatorDiscoveryRuntime {
  return {
    browse: async () => emptyPage,
    search: async () => emptyPage,
    ...overrides,
  } as OperatorDiscoveryRuntime;
}

type Recorded = OperatorRefusal | OperatorRefusalSuppressed;

function collect(): {
  records: Recorded[];
  refusals: () => OperatorRefusal[];
  sink: (record: Recorded) => void;
} {
  const records: Recorded[] = [];
  return {
    records,
    refusals: () => records.filter((record): record is OperatorRefusal => "source" in record),
    sink: (record) => records.push(record),
  };
}

const socketPath = (): string =>
  `/tmp/operator-refusal-test-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;

const allowPeer: OperatorSocketPeerResolver = () => peer;

function requestFrame(method: string, params: Record<string, unknown> = {}): Buffer {
  const payload = Buffer.from(JSON.stringify({ id: "request-1", method, params }), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Connect, send a frame, and resolve once the daemon closes without replying. */
async function expectClosure(path: string, frame: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(path);
    let bytes = 0;
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      bytes += chunk.length;
    });
    socket.on("close", () => {
      if (bytes === 0) resolve();
      else reject(new Error(`expected a silent close, received ${bytes} bytes`));
    });
    // A reset is how a refused over-size frame ends; only a reply is a failure.
    socket.on("error", () => undefined);
  });
}

/** Wait until a predicate holds, so a record written after the close is seen. */
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function roundTrip(path: string, frame: Buffer): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let pending = Buffer.alloc(0);
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const length = pending.readUInt32BE(0);
      if (pending.length < length + 4) return;
      const response = JSON.parse(pending.subarray(4, length + 4).toString("utf8")) as unknown;
      socket.destroy();
      resolve(response);
    });
    socket.on("error", reject);
    socket.on("close", () => {
      if (pending.length === 0) reject(new Error("operator socket closed without response"));
    });
  });
}

describe("classifyOperatorError", () => {
  it("keeps the code an operator write error already carries", () => {
    const classified = classifyOperatorError(new OperatorWriteError("not_found", "handle"));
    expect(classified).toEqual({
      code: "not_found",
      source: "categorized",
      errorClass: "OperatorWriteError",
    });
  });

  it("flattens an unrecognised throw to service_unavailable but says it was a throw", () => {
    // This is the defect the record exists for: the code alone cannot tell
    // "never built" from "built and threw".
    expect(classifyOperatorError(new TypeError("bad params"))).toEqual({
      code: "service_unavailable",
      source: "uncaught_throw",
      errorClass: "TypeError",
    });
  });

  it("reports an unlisted error class as other, keeping the vocabulary closed", () => {
    class UpstreamLeak extends Error {}
    expect(classifyOperatorError(new UpstreamLeak("internal detail")).errorClass).toBe("other");
  });

  it("does not read a code off an arbitrary thrown object", () => {
    // Trust must come from identity: an unrelated upstream error carrying a
    // vocabulary word must not be reported as that category.
    const classified = classifyOperatorError({ code: "vault_locked", message: "nope" });
    expect(classified.code).toBe("service_unavailable");
    expect(classified.source).toBe("uncaught_throw");
  });
});

describe("operator discovery refusals", () => {
  it("records not_wired when the daemon built no runtime for the method", async () => {
    const { refusals, sink } = collect();
    const handler = createOperatorDiscoveryHandler(runtimeWith(), { onRefusal: sink });
    const response = await handler(
      { id: "r1", method: "notes.get-view", params: {} } as never,
      peer,
    );
    expect(response).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
    expect(refusals()).toEqual([
      {
        method: "notes.get-view",
        code: "service_unavailable",
        source: "not_wired",
        errorClass: "other",
      },
    ]);
  });

  it("records uncaught_throw, and returns the same bytes as the not_wired case", async () => {
    const { refusals, sink } = collect();
    const throwing = createOperatorDiscoveryHandler(
      runtimeWith({
        view: async () => {
          throw new TypeError("bad params");
        },
      }),
      { onRefusal: sink },
    );
    const missing = createOperatorDiscoveryHandler(runtimeWith(), { onRefusal: sink });

    const thrown = await throwing(
      { id: "r1", method: "notes.get-view", params: {} } as never,
      peer,
    );
    const absent = await missing({ id: "r1", method: "notes.get-view", params: {} } as never, peer);

    // Same reply, different record: that is the whole point.
    expect(JSON.stringify(thrown)).toBe(JSON.stringify(absent));
    expect(refusals().map((record) => record.source)).toEqual(["uncaught_throw", "not_wired"]);
    expect(refusals()[0]?.errorClass).toBe("TypeError");
  });

  it("records categorized when the runtime refuses with a vocabulary code", async () => {
    const { refusals, sink } = collect();
    const handler = createOperatorDiscoveryHandler(
      runtimeWith({
        view: async () => {
          throw new OperatorWriteError("permission_denied", "handle");
        },
      }),
      { onRefusal: sink },
    );
    const response = await handler(
      { id: "r1", method: "notes.get-view", params: {} } as never,
      peer,
    );
    expect(response).toMatchObject({ ok: false, error: { code: "permission_denied" } });
    expect(refusals()[0]).toMatchObject({ source: "categorized", code: "permission_denied" });
  });

  it("keeps the catch path's reply when the sink throws there too", async () => {
    const handler = createOperatorDiscoveryHandler(
      runtimeWith({
        view: async () => {
          throw new TypeError("bad params");
        },
      }),
      {
        onRefusal: () => {
          throw new Error("logger exploded");
        },
      },
    );
    const response = await handler(
      { id: "r1", method: "notes.get-view", params: {} } as never,
      peer,
    );
    expect(response).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
  });

  it("leaks nothing the caller supplied into the record", async () => {
    // A canary in params and in the error message must never reach the log.
    const { records, sink } = collect();
    const handler = createOperatorDiscoveryHandler(
      runtimeWith({
        view: async () => {
          throw new Error("CANARY-in-message");
        },
      }),
      { onRefusal: sink },
    );
    await handler(
      { id: "CANARY-in-id", method: "notes.get-view", params: { id: "CANARY-in-params" } } as never,
      peer,
    );
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("CANARY");
  });
});

describe("refusal log bounding", () => {
  it("caps a window and reports the drops once instead of sampling them away", () => {
    const { records, refusals, sink } = collect();
    let clock = 0;
    const log = createOperatorRefusalLog({
      emit: sink,
      limitPerWindow: 3,
      windowMs: 1_000,
      now: () => clock,
    });

    for (let index = 0; index < 10; index += 1) log(notWiredRefusal("notes.get-view"));
    expect(refusals()).toHaveLength(3);
    expect(log.dropped()).toBe(7);

    clock = 1_001;
    log(notWiredRefusal("notes.get-view"));
    // One suppressed line for the closed window, then the new record.
    expect(records.map((record) => record.method)).toEqual([
      "notes.get-view",
      "notes.get-view",
      "notes.get-view",
      "operator.request.refused.suppressed",
      "notes.get-view",
    ]);
    // The suppressed line counts what the window dropped, so an operator can
    // tell a quiet socket from a throttled one.
    expect(records[3]).toEqual({
      method: "operator.request.refused.suppressed",
      source: "not_wired",
      dropped: 7,
    });
    expect(log.dropped()).toBe(0);
  });

  it("flushes the suppressed count without waiting for the window to roll", () => {
    const { records, sink } = collect();
    const log = createOperatorRefusalLog({
      emit: sink,
      limitPerWindow: 1,
      windowMs: 60_000,
      now: () => 0,
    });
    log(notWiredRefusal("notes.create"));
    log(notWiredRefusal("notes.create"));
    log.flush();
    expect(records.at(-1)).toEqual({
      method: "operator.request.refused.suppressed",
      source: "not_wired",
      dropped: 1,
    });
    expect(records).toHaveLength(2);
  });

  it("keeps the drop accounting when the emit itself throws", () => {
    // emitSafely is what makes the diagnostic safe; without it a throwing
    // logger would abort the limiter mid-window and lose the count.
    const seen: number[] = [];
    const log = createOperatorRefusalLog({
      emit: (record) => {
        seen.push(1);
        if ("dropped" in record) throw new Error("logger exploded on the summary");
        if (seen.length > 1) throw new Error("logger exploded");
      },
      limitPerWindow: 2,
      windowMs: 1_000,
      now: () => 0,
    });
    for (let index = 0; index < 5; index += 1) log(notWiredRefusal("notes.get-view"));
    expect(log.dropped("not_wired")).toBe(3);
    expect(() => log.flush()).not.toThrow();
  });

  it("does not let a flood of one kind starve the refusal an operator is looking for", () => {
    // Each source has its own budget, so 100 throws cannot consume the line
    // that says a runtime is missing.
    const { refusals, sink } = collect();
    const log = createOperatorRefusalLog({
      emit: sink,
      limitPerWindow: 2,
      windowMs: 60_000,
      now: () => 0,
    });
    for (let index = 0; index < 100; index += 1) {
      log({
        method: "notes.create",
        code: "service_unavailable",
        source: "uncaught_throw",
        errorClass: "TypeError",
      });
    }
    log(notWiredRefusal("notes.approve-upload"));

    expect(refusals().filter((record) => record.source === "not_wired")).toHaveLength(1);
    expect(log.dropped("uncaught_throw")).toBe(98);
    expect(log.dropped("not_wired")).toBe(0);
  });
});

describe("operator socket refusals", () => {
  it("records an uncaught handler throw with the method that was refused", async () => {
    const { refusals, sink } = collect();
    const path = socketPath();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method) => ({ allowed: true, method }),
      handle: async () => {
        throw new RangeError("boom");
      },
      refusalLog: sink,
    });
    try {
      const response = await roundTrip(path, requestFrame("notes.operation-list"));
      expect(response).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
      expect(refusals()).toEqual([
        {
          method: "notes.operation-list",
          code: "service_unavailable",
          source: "uncaught_throw",
          errorClass: "RangeError",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("records an authorization failure that otherwise closes the socket silently", async () => {
    const { refusals, sink } = collect();
    const path = socketPath();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: () => {
        throw new TypeError("authorizer blew up");
      },
      handle: async () => {
        throw new Error("handler must not run");
      },
      refusalLog: sink,
    });
    try {
      await expect(roundTrip(path, requestFrame("notes.operation-list"))).rejects.toThrow();
      expect(refusals()).toEqual([
        {
          method: "notes.operation-list",
          code: "no_reply",
          source: "authorize_threw",
          errorClass: "TypeError",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("records a reply that cannot be serialized, which used to close the socket silently", async () => {
    // The handler's own envelope is the reply most likely to fail serialization,
    // so the main path has to carry the sink too.
    const { refusals, sink } = collect();
    const path = socketPath();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method) => ({ allowed: true, method }),
      handle: async (request) =>
        ({
          id: request.id,
          ok: true,
          result: { kind: "operation-list", handles: [], bad: 1n },
        }) as never,
      refusalLog: sink,
    });
    try {
      await expect(roundTrip(path, requestFrame("notes.operation-list"))).rejects.toThrow();
      expect(refusals()).toEqual([
        {
          method: "notes.operation-list",
          code: "no_reply",
          source: "serialize_failed",
          // The serializer raises its own Error rather than passing the
          // JSON failure through, so the class is the generic one.
          errorClass: "Error",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("returns the same reply when the sink itself throws", async () => {
    // The log is a diagnostic: a broken logger must not turn a refusal into a
    // different answer, or into no answer at all.
    const handler = createOperatorDiscoveryHandler(runtimeWith(), {
      onRefusal: () => {
        throw new Error("logger exploded");
      },
    });
    const response = await handler(
      { id: "r1", method: "notes.get-view", params: {} } as never,
      peer,
    );
    expect(response).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
  });

  it("still answers when the sink throws on the socket path", async () => {
    const path = socketPath();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method) => ({ allowed: true, method }),
      handle: async () => {
        throw new RangeError("boom");
      },
      refusalLog: () => {
        throw new Error("logger exploded");
      },
    });
    try {
      const response = await roundTrip(path, requestFrame("notes.operation-list"));
      expect(response).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
    } finally {
      await server.close();
    }
  });

  it("records an unparseable frame without repeating a byte of it", async () => {
    // A frame the daemon cannot parse is closed without a reply, which from the
    // client side is indistinguishable from a dead daemon. The record names the
    // event and nothing the caller sent.
    const path = socketPath();
    const { refusals, sink } = collect();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method) => ({ allowed: true, method }),
      handle: async () => ({ id: "request-1", ok: true, result: {} }) as never,
      refusalLog: sink,
    });
    try {
      const canary = "CANARY-9f1c-not-a-handle";
      // `notes.resolve-conflict` requires `id`, `binding` and `confirmation`.
      await expectClosure(path, requestFrame("notes.resolve-conflict", { handle: canary }));
      expect(refusals()).toHaveLength(1);
      expect(refusals()[0]).toMatchObject({
        method: UNATTRIBUTED_METHOD,
        code: "no_reply",
        source: "unparseable",
      });
      expect(JSON.stringify(refusals())).not.toContain(canary);
    } finally {
      await server.close();
    }
  });

  it("records a method the operator socket does not carry", async () => {
    const path = socketPath();
    const { refusals, sink } = collect();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method) => ({ allowed: true, method }),
      handle: async () => ({ id: "request-1", ok: true, result: {} }) as never,
      refusalLog: sink,
    });
    try {
      // `notes.sync` is a bridge method: it parses, but this socket does not
      // carry it, so the frame is dropped before dispatch.
      await expectClosure(path, requestFrame("notes.sync"));
      expect(refusals()).toHaveLength(1);
      expect(refusals()[0]).toMatchObject({
        method: UNATTRIBUTED_METHOD,
        code: "no_reply",
        source: "not_operator_method",
      });
      // The caller chose this method name, so it must not be copied into the log.
      expect(JSON.stringify(refusals())).not.toContain("notes.sync");
    } finally {
      await server.close();
    }
  });

  it("records a frame whose declared length is unusable", async () => {
    const path = socketPath();
    const { refusals, sink } = collect();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method) => ({ allowed: true, method }),
      handle: async () => ({ id: "request-1", ok: true, result: {} }) as never,
      refusalLog: sink,
    });
    try {
      const zeroLength = Buffer.alloc(4);
      zeroLength.writeUInt32BE(0, 0);
      await expectClosure(path, zeroLength);
      await until(() => refusals().length >= 1);
      expect(refusals()).toHaveLength(1);
      expect(refusals()[0]).toMatchObject({
        method: UNATTRIBUTED_METHOD,
        code: "no_reply",
        source: "unparseable",
      });
    } finally {
      await server.close();
    }
  });

  it("records a peer the daemon cannot identify while the caller waits", async () => {
    const path = socketPath();
    const { refusals, sink } = collect();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: () => undefined,
      authorize: (method) => ({ allowed: true, method }),
      handle: async () => ({ id: "request-1", ok: true, result: {} }) as never,
      refusalLog: sink,
    });
    try {
      await expectClosure(path, requestFrame("notes.browse", { limit: 1 }));
      await until(() => refusals().length === 1);
      expect(refusals()[0]).toMatchObject({
        method: UNATTRIBUTED_METHOD,
        code: "no_reply",
        source: "peer_unresolved",
      });
    } finally {
      await server.close();
    }
  });

  it("does not record a client that leaves before it is identified", async () => {
    // A probe that connects and hangs up is not an unidentifiable peer:
    // recording it would make the peer line mean nothing.
    const path = socketPath();
    const { refusals, sink } = collect();
    let release: ((peer: undefined) => void) | undefined;
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
      authorize: (method) => ({ allowed: true, method }),
      handle: async () => ({ id: "request-1", ok: true, result: {} }) as never,
      refusalLog: sink,
    });
    try {
      await new Promise<void>((resolve) => {
        const socket = net.createConnection(path);
        socket.on("connect", () => {
          socket.destroy();
          resolve();
        });
      });
      // Let the daemon see the client go before the lookup finishes.
      await new Promise((resolve) => setTimeout(resolve, 100));
      release?.(undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(refusals()).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("records an over-size frame", async () => {
    const path = socketPath();
    const { refusals, sink } = collect();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method) => ({ allowed: true, method }),
      handle: async () => ({ id: "request-1", ok: true, result: {} }) as never,
      refusalLog: sink,
    });
    try {
      // A legal declared length, then more bytes than the cap allows to
      // accumulate: only the overflow site can refuse this.
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(65_532, 0);
      await new Promise<void>((resolve) => {
        const socket = net.createConnection(path);
        socket.on("connect", () => {
          socket.write(prefix);
          setTimeout(() => {
            socket.write(Buffer.alloc(65_533, 0x41));
            resolve();
          }, 25);
        });
        socket.on("error", () => undefined);
      });
      await until(() => refusals().length >= 1);
      expect(refusals()).toHaveLength(1);
      expect(refusals()[0]).toMatchObject({
        method: UNATTRIBUTED_METHOD,
        code: "no_reply",
        source: "unparseable",
      });
    } finally {
      await server.close();
    }
  });

  it("serves refusals unchanged when no refusal log is passed", async () => {
    // The sink is optional: an embedder that does not want the log keeps the
    // endpoint's behaviour exactly as it was.
    const path = socketPath();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method) => ({ allowed: true, method }),
      handle: async () => {
        throw new Error("boom");
      },
    });
    try {
      const response = await roundTrip(path, requestFrame("notes.operation-list"));
      expect(response).toMatchObject({ ok: false, error: { code: "service_unavailable" } });
    } finally {
      await server.close();
    }
  });
});
