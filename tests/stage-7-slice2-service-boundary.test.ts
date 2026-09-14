/** Stage 7 Slice 2 service-boundary timeout, audit, and abuse controls. */

import { once } from "node:events";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { RpcResponseEnvelope } from "../src/service/rpc-protocol.js";
import {
  MAX_AUDIT_LATENCY_MS,
  SERVICE_AUDIT_EVENTS,
  SERVICE_AUDIT_OUTCOMES,
  buildServiceAuditRecord,
  emitServiceAudit,
  type ServiceAuditRecord,
} from "../src/service/service-audit.js";
import {
  DEFAULT_SERVICE_ABUSE_BOUNDS,
  normalizeServiceAbuseBounds,
  type ServiceAbuseBounds,
} from "../src/service/service-abuse-bounds.js";
import { createLogger, type Logger } from "../src/logging/logger.js";
import {
  startNookdServer,
  type NookdServerHandle,
  type NookdServerRuntime,
} from "../src/service/nookd-server.js";

const handles: NookdServerHandle[] = [];
const directories: string[] = [];

function auditLogger(records: ServiceAuditRecord[]): Logger {
  return createLogger({
    sink: (line) => {
      const parsed = JSON.parse(line) as ServiceAuditRecord & { component?: string };
      if (parsed.component === "service_audit") records.push(parsed);
    },
  });
}

function abuseBounds(overrides: Partial<ServiceAbuseBounds> = {}): ServiceAbuseBounds {
  return { ...DEFAULT_SERVICE_ABUSE_BOUNDS, perProcessBurstSize: 100, ...overrides };
}

function emitWithThrowingLogger(record: ServiceAuditRecord): void {
  const throwingLogger = {
    debug: () => undefined,
    info: () => {
      throw new Error("secret logger failure");
    },
    warn: () => {
      throw new Error("secret logger failure");
    },
    error: () => {
      throw new Error("secret logger failure");
    },
    child: () => throwingLogger,
    setSink: () => undefined,
  } as Logger;
  emitServiceAudit(throwingLogger, record);
}

function requestFrame(id: string, query: string): Buffer {
  const payload = Buffer.from(JSON.stringify({ id, method: "notes.search", params: { query } }));
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function pathDiagnosticFrame(id: string): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      id,
      method: "notes.path_diagnostic",
      params: { path: "General/Task list for Bernie" },
    }),
  );
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

async function fixture(
  search: NookdServerRuntime["search"],
  options: Omit<Parameters<typeof startNookdServer>[0], "socketPath" | "runtime"> = {},
): Promise<{ handle: NookdServerHandle; socketPath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nookd-stage7-slice2-"));
  directories.push(directory);
  const socketPath = path.join(directory, "nookbridge.sock");
  const runtime: NookdServerRuntime = Object.freeze({ search, cleanup: async () => undefined });
  const handle = await startNookdServer({
    socketPath,
    runtime,
    installSignalHandlers: false,
    abuseBounds: abuseBounds(),
    ...options,
  });
  handles.push(handle);
  return { handle, socketPath };
}

async function connect(socketPath: string): Promise<net.Socket> {
  const socket = net.createConnection(socketPath);
  await once(socket, "connect");
  return socket;
}

async function closeOf(socket: net.Socket): Promise<void> {
  if (!socket.destroyed) await once(socket, "close");
}

async function readFrame(socket: net.Socket): Promise<RpcResponseEnvelope> {
  let data = Buffer.alloc(0);
  while (data.length < 4) {
    const [chunk] = (await once(socket, "data")) as [Buffer];
    data = Buffer.concat([data, chunk]);
  }
  const length = data.readUInt32BE(0);
  while (data.length < length + 4) {
    const [chunk] = (await once(socket, "data")) as [Buffer];
    data = Buffer.concat([data, chunk]);
  }
  return JSON.parse(data.subarray(4, length + 4).toString("utf8")) as RpcResponseEnvelope;
}

async function invalidOption(
  option: Omit<Parameters<typeof startNookdServer>[0], "socketPath" | "runtime">,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nookd-stage7-invalid-"));
  directories.push(directory);
  const runtime: NookdServerRuntime = Object.freeze({
    search: async () => [],
    cleanup: async () => undefined,
  });
  await expect(
    startNookdServer({
      socketPath: path.join(directory, "nookbridge.sock"),
      runtime,
      installSignalHandlers: false,
      ...option,
    }),
  ).rejects.toThrow();
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.shutdown()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("hostile input validators", () => {
  it("rejects accessors and symbol properties in abuse bounds", () => {
    const accessor = { ...DEFAULT_SERVICE_ABUSE_BOUNDS } as Record<string, unknown>;
    Object.defineProperty(accessor, "requestTimeoutMs", {
      configurable: true,
      enumerable: true,
      get: () => 10_000,
    });
    expect(() => normalizeServiceAbuseBounds(accessor)).toThrow();

    const symbol = {
      ...DEFAULT_SERVICE_ABUSE_BOUNDS,
      [Symbol("hostile")]: 1,
    } as Record<string | symbol, unknown>;
    expect(() => normalizeServiceAbuseBounds(symbol)).toThrow();
  });

  it("captures stateful startup getters once before validation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "nookd-stage7-capture-"));
    directories.push(directory);
    const socketPath = path.join(directory, "nookbridge.sock");
    let socketPathReads = 0;
    let runtimeReads = 0;
    const runtime: NookdServerRuntime = Object.freeze({
      search: async () => [],
      cleanup: async () => undefined,
    });
    const options = {
      get socketPath() {
        socketPathReads += 1;
        return socketPathReads === 1 ? socketPath : "/tmp/hostile-replacement.sock";
      },
      get runtime() {
        runtimeReads += 1;
        return runtimeReads === 1 ? runtime : (null as unknown as NookdServerRuntime);
      },
      installSignalHandlers: false,
      abuseBounds: abuseBounds(),
    } as unknown as Parameters<typeof startNookdServer>[0];
    const handle = await startNookdServer(options);
    handles.push(handle);
    expect(socketPathReads).toBe(1);
    expect(runtimeReads).toBe(1);
  });
});

describe("service audit records", () => {
  it("records a complete frame before parsing it", async () => {
    const records: ServiceAuditRecord[] = [];
    const { socketPath } = await fixture(async () => [], {
      auditLogger: auditLogger(records),
    });
    const socket = await connect(socketPath);
    socket.write(requestFrame("frame-marker", "marker"));
    const response = await readFrame(socket);
    expect(response.ok).toBe(true);
    socket.destroy();
    await closeOf(socket);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "rpc.frame.extracted",
        outcome: "ok",
        method: "notes.search",
        requestIdEcho: false,
      }),
    );
  });

  it("records protocol rejection before closing an unparseable frame", async () => {
    const records: ServiceAuditRecord[] = [];
    const { socketPath } = await fixture(async () => [], {
      auditLogger: auditLogger(records),
    });
    const socket = await connect(socketPath);
    socket.write(Buffer.from([0, 0, 0, 1, 0]));
    await closeOf(socket);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "rpc.protocol.rejected",
        outcome: "invalid_request",
        method: "notes.search",
        requestIdEcho: false,
      }),
    );
  });

  it("peeks the allowlisted method before full parsing", async () => {
    const records: ServiceAuditRecord[] = [];
    const { socketPath } = await fixture(async () => [], {
      auditLogger: auditLogger(records),
    });
    const socket = await connect(socketPath);
    socket.write(pathDiagnosticFrame("method-peek-marker"));
    const response = await readFrame(socket);
    expect(response.ok).toBe(false);
    socket.destroy();
    await closeOf(socket);
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "rpc.frame.method_peek",
        outcome: "ok",
        method: "notes.path_diagnostic",
        requestIdEcho: false,
      }),
    );
  });

  it("exposes the closed vocabulary and frozen null-prototype six-field records", () => {
    expect(Object.isFrozen(SERVICE_AUDIT_EVENTS)).toBe(true);
    expect(SERVICE_AUDIT_EVENTS).toEqual([
      "rpc.protocol.rejected",
      "rpc.frame.extracted",
      "rpc.request.parsed",
      "rpc.frame.method_peek",
      "rpc.request.received",
      "rpc.request.dispatched",
      "rpc.response.sent",
      "rpc.request.timeout",
      "rpc.connection.idle_timeout",
      "rpc.connection.budget_exceeded",
      "rpc.connection.admission_rejected",
      "rpc.connection.closed",
    ]);
    expect(SERVICE_AUDIT_OUTCOMES).toHaveLength(12);
    for (const event of SERVICE_AUDIT_EVENTS) {
      const record = buildServiceAuditRecord({
        event,
        outcome: "ok",
        method: "notes.search",
        requestIdEcho: true,
        latencyMs: MAX_AUDIT_LATENCY_MS + 1,
        peerCredentials: "unknown",
      });
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.getPrototypeOf(record)).toBeNull();
      expect(Object.keys(record).sort()).toEqual([
        "event",
        "latencyMs",
        "method",
        "outcome",
        "peerCredentials",
        "requestIdEcho",
      ]);
      expect(record.event).toBe(event);
      expect(record.latencyMs).toBe(MAX_AUDIT_LATENCY_MS);
    }
  });

  it("rejects extra fields and preserves the redacted categorical shape", () => {
    const record = buildServiceAuditRecord({
      event: "rpc.response.sent",
      outcome: "ok",
      method: "notes.search",
      requestIdEcho: false,
      latencyMs: 0,
      peerCredentials: "unknown",
    });
    expect(() => Object.defineProperty(record, "secret", { value: "canary" })).toThrow();
    expect(JSON.stringify(record)).not.toContain("canary");
    expect(() =>
      buildServiceAuditRecord({
        ...record,
        secret: "secret=/var/key",
      } as ServiceAuditRecord & { secret: string }),
    ).toThrow();
  });

  it("swallows hostile logger failures", () => {
    expect(() =>
      emitWithThrowingLogger({
        event: "rpc.request.timeout",
        outcome: "timeout",
        method: "notes.search",
        requestIdEcho: false,
        latencyMs: 1,
        peerCredentials: "unknown",
      }),
    ).not.toThrow();
  });
});

describe("service boundary abuse controls", () => {
  it("rejects invalid abuse bounds", async () => {
    await invalidOption({ abuseBounds: abuseBounds({ requestTimeoutMs: 0 }) });
    await invalidOption({ abuseBounds: abuseBounds({ requestTimeoutMs: 60_001 }) });
    await invalidOption({ abuseBounds: abuseBounds({ requestTimeoutMs: 1.5 }) });
    await invalidOption({ abuseBounds: abuseBounds({ connectionIdleTimeoutMs: 0 }) });
    await invalidOption({ abuseBounds: abuseBounds({ connectionIdleTimeoutMs: 300_001 }) });
    await invalidOption({ abuseBounds: abuseBounds({ connectionIdleTimeoutMs: 1.5 }) });
    await invalidOption({ abuseBounds: abuseBounds({ perConnectionBudgetMs: 600_001 }) });
    await invalidOption({ abuseBounds: abuseBounds({ perProcessRequestsPerSecond: 101 }) });
  });

  it("closes an idle partial frame and audits the closure", async () => {
    const records: ServiceAuditRecord[] = [];
    const { socketPath } = await fixture(async () => [], {
      abuseBounds: abuseBounds({ connectionIdleTimeoutMs: 30 }),
      auditLogger: auditLogger(records),
    });
    const socket = await connect(socketPath);
    socket.write(Buffer.from([0, 0]));
    await closeOf(socket);
    expect(records.map((record) => record.event)).toContain("rpc.connection.idle_timeout");
  });

  it("closes a stuck request at the deadline and drops its late result", async () => {
    const records: ServiceAuditRecord[] = [];
    let release: (() => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const search: NookdServerRuntime["search"] = () =>
      new Promise((resolve) => {
        startedResolve?.();
        release = () => resolve([{ title: "late" }]);
      });
    const { socketPath } = await fixture(search, {
      abuseBounds: abuseBounds({ requestTimeoutMs: 30 }),
      auditLogger: auditLogger(records),
    });
    const socket = await connect(socketPath);
    const lateData: Buffer[] = [];
    socket.on("data", (chunk) => lateData.push(chunk));
    socket.write(requestFrame("id-canary", "query-canary"));
    await started;
    await closeOf(socket);
    release?.();
    await delay(20);
    expect(lateData).toHaveLength(0);
    expect(records.map((record) => record.event)).toContain("rpc.request.timeout");
  });

  it("detaches a runtime promise when the client disconnects", async () => {
    const records: ServiceAuditRecord[] = [];
    let release: (() => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const search: NookdServerRuntime["search"] = () =>
      new Promise((finish) => {
        release = () => finish([]);
        startedResolve?.();
      });
    const { socketPath } = await fixture(search, {
      auditLogger: auditLogger(records),
    });
    const socket = await connect(socketPath);
    socket.write(requestFrame("disconnect", "query"));
    await started;
    socket.destroy();
    await closeOf(socket);
    await delay(30);
    release?.();
    await delay(20);
    expect(records.map((record) => record.event)).toContain("rpc.connection.closed");
  });

  it("detaches a runtime promise when the daemon shuts down", async () => {
    const records: ServiceAuditRecord[] = [];
    let release: (() => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const search: NookdServerRuntime["search"] = () =>
      new Promise((finish) => {
        release = () => finish([]);
        startedResolve?.();
      });
    const { handle, socketPath } = await fixture(search, {
      shutdownTimeoutMs: 100,
      auditLogger: auditLogger(records),
    });
    const socket = await connect(socketPath);
    socket.write(requestFrame("shutdown", "query"));
    await started;
    await handle.shutdown();
    release?.();
    await delay(20);
    expect(records.map((record) => record.event)).toContain("rpc.connection.closed");
  });

  it("audits connection-cap rejection and request-budget exhaustion", async () => {
    const records: ServiceAuditRecord[] = [];
    const { socketPath } = await fixture(async () => [], {
      maxConnections: 1,
      maxRequestsPerConnection: 1,
      auditLogger: auditLogger(records),
    });
    const first = await connect(socketPath);
    const second = await connect(socketPath);
    await closeOf(second);
    first.write(Buffer.concat([requestFrame("one", "one"), requestFrame("two", "two")]));
    await readFrame(first);
    await closeOf(first);
    expect(records.map((record) => record.event)).toContain("rpc.connection.admission_rejected");
    expect(records.map((record) => record.event)).toContain("rpc.connection.budget_exceeded");
  });

  it("enforces the process admission token bucket", async () => {
    const records: ServiceAuditRecord[] = [];
    const { socketPath } = await fixture(async () => [], {
      abuseBounds: abuseBounds({ perProcessRequestsPerSecond: 1, perProcessBurstSize: 1 }),
      auditLogger: auditLogger(records),
    });
    const first = await connect(socketPath);
    const second = await connect(socketPath);
    await closeOf(second);
    expect(records.map((record) => record.event)).toContain("rpc.connection.admission_rejected");
    first.destroy();
  });

  it("enforces the per-connection aggregate elapsed-time budget", async () => {
    const records: ServiceAuditRecord[] = [];
    const { socketPath } = await fixture(
      async () => {
        await delay(25);
        return [];
      },
      {
        abuseBounds: abuseBounds({ perConnectionBudgetMs: 20, requestTimeoutMs: 100 }),
        auditLogger: auditLogger(records),
      },
    );
    const socket = await connect(socketPath);
    const data: Buffer[] = [];
    socket.on("data", (chunk) => data.push(chunk));
    socket.write(requestFrame("budget", "query"));
    await closeOf(socket);
    expect(data).toHaveLength(0);
    expect(records.map((record) => record.event)).toContain("rpc.connection.budget_exceeded");
  });

  it("keeps fast requests working and audits categorical failures", async () => {
    const records: ServiceAuditRecord[] = [];
    const { socketPath } = await fixture(
      async () => {
        throw new Error("secret=/var/notesnook.key");
      },
      {
        abuseBounds: abuseBounds({ requestTimeoutMs: 100 }),
        auditLogger: auditLogger(records),
      },
    );
    const socket = await connect(socketPath);
    socket.write(requestFrame("failed", "query"));
    const response = await readFrame(socket);
    expect(response).toMatchObject({ id: "failed", ok: false });
    await delay(10);
    expect(records.map((record) => record.event)).toContain("rpc.request.dispatched");
    expect(records.find((record) => record.event === "rpc.request.dispatched")?.outcome).toBe(
      "service_unavailable",
    );
    socket.destroy();
  });
});
