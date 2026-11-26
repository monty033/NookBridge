import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RPC_FRAME_BYTES, WIRE_BODY_BYTES } from "../src/core/size-limits.js";
import { createLogger } from "../src/logging/logger.js";
import { createLargeBodyBudget, type LargeBodyBudget } from "../src/service/large-body-budget.js";
import {
  startNookdServer,
  type NookdServerHandle,
  type NookdServerRuntime,
} from "../src/service/nookd-server.js";
import { serializeRpcResponse, type RpcAnyResponseEnvelope } from "../src/service/rpc-protocol.js";
import {
  DEFAULT_SERVICE_ABUSE_BOUNDS,
  type ServiceAbuseBounds,
} from "../src/service/service-abuse-bounds.js";
import type { ServiceAuditRecord } from "../src/service/service-audit.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";

const handles: NookdServerHandle[] = [];
const sockets: net.Socket[] = [];
const directories: string[] = [];

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const result = Buffer.allocUnsafe(4 + payload.length);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

function searchFrame(id: string, query: string): Buffer {
  return frame({ id, method: "notes.search", params: { query } });
}

function createBodyHeader(id: string, body: Buffer, declaredBytes = body.length): Buffer {
  return frame({
    id,
    method: "notes.create",
    params: { title: "Body framing" },
    body: {
      field: "content",
      bytes: declaredBytes,
      sha256: createHash("sha256").update(body).digest("hex"),
    },
  });
}

function capabilitiesFrame(id: string): Buffer {
  return frame({ id, method: "notes.capabilities", params: {} });
}

async function connect(socketPath: string): Promise<net.Socket> {
  const socket = net.createConnection(socketPath);
  sockets.push(socket);
  socket.on("error", () => undefined);
  await once(socket, "connect");
  return socket;
}

async function readFrameBytes(socket: net.Socket): Promise<Buffer> {
  let bytes = Buffer.alloc(0);
  for (;;) {
    const [chunk] = (await once(socket, "data")) as [Buffer];
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length < 4) continue;
    const size = bytes.readUInt32BE(0);
    if (bytes.length < size + 4) continue;
    return bytes.subarray(0, size + 4);
  }
}

async function readFrame(socket: net.Socket): Promise<RpcAnyResponseEnvelope> {
  const bytes = await readFrameBytes(socket);
  return JSON.parse(bytes.subarray(4).toString("utf8")) as RpcAnyResponseEnvelope;
}

async function waitForClose(socket: net.Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => socket.once("close", resolve));
}

async function writeBytewise(socket: net.Socket, bytes: Buffer): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += 1) {
    await new Promise<void>((resolve, reject) => {
      socket.write(bytes.subarray(offset, offset + 1), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

type CreateNote = NonNullable<NookdServerRuntime["createNote"]>;

interface FixtureOptions {
  readonly budget?: LargeBodyBudget;
  readonly createNote?: CreateNote;
  readonly maxRequestsPerConnection?: number;
  readonly abuseBounds?: Partial<ServiceAbuseBounds>;
}

async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(path.join("/tmp", "nbk-body-"));
  directories.push(directory);
  const socketPath = path.join(directory, "nookd.sock");
  const records: ServiceAuditRecord[] = [];
  const createNote = vi.fn<CreateNote>(
    options.createNote ??
      (async (command) => ({
        operation: "create" as const,
        id: "note-1",
        titleBytes: Buffer.byteLength(command.title),
        contentBytes: Buffer.byteLength(command.content),
        localCommitted: true as const,
        remoteSynced: false as const,
        pendingSync: true as const,
      })),
  );
  const search = vi.fn(async () => [{ title: "legacy" }]);
  const cleanup = vi.fn(async () => undefined);
  const budget = options.budget ?? createLargeBodyBudget();
  const handle = await startNookdServer({
    socketPath,
    runtime: Object.freeze({ search, createNote, cleanup }) as NookdServerRuntime,
    policy: createReadWriteNoDeleteServicePolicy(),
    bodyBudget: budget,
    installSignalHandlers: false,
    resolvePeer: async () => ({
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
      groups: ["test"],
    }),
    abuseBounds: {
      ...DEFAULT_SERVICE_ABUSE_BOUNDS,
      perProcessBurstSize: 100,
      ...options.abuseBounds,
    },
    auditLogger: createLogger({
      sink: (line) => {
        const record = JSON.parse(line) as ServiceAuditRecord & { component?: string };
        if (record.component === "service_audit") records.push(record);
      },
    }),
    ...(options.maxRequestsPerConnection === undefined
      ? {}
      : { maxRequestsPerConnection: options.maxRequestsPerConnection }),
  });
  handles.push(handle);
  return { socketPath, records, createNote, search, cleanup, budget };
}

async function expectLeaseReleased(budget: LargeBodyBudget): Promise<void> {
  await vi.waitFor(() => {
    const probe = budget.tryAcquire(1);
    expect(probe.kind).toBe("acquired");
    if (probe.kind === "acquired") probe.release();
  });
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(handles.splice(0).map((handle) => handle.shutdown()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("nookd protocol-2 negotiation and legacy compatibility", () => {
  it("answers notes.capabilities without touching the runtime", async () => {
    const { socketPath, search, createNote } = await fixture();
    const socket = await connect(socketPath);
    socket.write(capabilitiesFrame("probe"));

    await expect(readFrame(socket)).resolves.toEqual({
      id: "probe",
      ok: true,
      result: { kind: "capabilities", protocol: 2 },
    });
    expect(search).not.toHaveBeenCalled();
    expect(createNote).not.toHaveBeenCalled();
  });

  it("keeps a small single-frame request and response byte-identical", async () => {
    const { socketPath } = await fixture();
    const socket = await connect(socketPath);
    const request = searchFrame("legacy", "needle");
    expect(request.length).toBeLessThanOrEqual(RPC_FRAME_BYTES);
    socket.write(request);

    const response = await readFrameBytes(socket);
    expect(response).toEqual(
      Buffer.from(
        serializeRpcResponse({
          id: "legacy",
          ok: true,
          result: { kind: "search", notes: [{ title: "legacy" }] },
        }),
      ),
    );
  });
});

describe("nookd request bodies", () => {
  it("accepts and dispatches exactly WIRE_BODY_BYTES", async () => {
    const { socketPath, createNote, records, budget } = await fixture();
    const body = Buffer.alloc(WIRE_BODY_BYTES, "x".charCodeAt(0));
    const socket = await connect(socketPath);
    socket.write(createBodyHeader("at-limit", body));

    await expect(readFrame(socket)).resolves.toMatchObject({
      id: "at-limit",
      ok: true,
      result: { kind: "body_continue", bytes: WIRE_BODY_BYTES },
    });
    socket.write(body);
    await expect(readFrame(socket)).resolves.toMatchObject({
      id: "at-limit",
      ok: true,
      result: { kind: "create", contentBytes: WIRE_BODY_BYTES },
    });
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(createNote.mock.calls[0]?.[0].content).toHaveLength(WIRE_BODY_BYTES);
    expect(records.filter((record) => record.event === "rpc.request.dispatched")).toHaveLength(1);
    await expectLeaseReleased(budget);
  });

  it("refuses one byte over the wire bound without continue or budget acquisition", async () => {
    const inner = createLargeBodyBudget();
    const tryAcquire = vi.fn((bytes: number) => inner.tryAcquire(bytes));
    const budget: LargeBodyBudget = { tryAcquire };
    const { socketPath, createNote, records } = await fixture({ budget });
    const body = Buffer.alloc(WIRE_BODY_BYTES + 1, 120);
    const socket = await connect(socketPath);
    socket.write(createBodyHeader("over-limit", body));

    await expect(readFrame(socket)).resolves.toMatchObject({
      id: "over-limit",
      ok: false,
      error: { code: "too_large" },
    });
    await waitForClose(socket);
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(createNote).not.toHaveBeenCalled();
    expect(records).toContainEqual(
      expect.objectContaining({ outcome: "too_large", phase: "wire" }),
    );
  });

  it("accepts one-byte writes split inside a multi-byte UTF-8 character", async () => {
    const { socketPath, createNote } = await fixture();
    const text = "start 😀 é end\n";
    const body = Buffer.from(text, "utf8");
    const socket = await connect(socketPath);
    socket.write(createBodyHeader("bytewise", body));
    await readFrame(socket);
    await writeBytewise(socket, body);

    await expect(readFrame(socket)).resolves.toMatchObject({ id: "bytewise", ok: true });
    expect(createNote.mock.calls[0]?.[0].content).toBe(text);
  });

  it("counts the header and body as one request against the connection limit", async () => {
    const { socketPath, createNote } = await fixture({ maxRequestsPerConnection: 1 });
    const body = Buffer.from("one request");
    const socket = await connect(socketPath);
    socket.write(createBodyHeader("one-logical", body));
    await readFrame(socket);
    socket.write(body);

    await expect(readFrame(socket)).resolves.toMatchObject({ id: "one-logical", ok: true });
    expect(createNote).toHaveBeenCalledTimes(1);
    await waitForClose(socket);
  });

  it("marks an admission too_large refusal without auditing body content", async () => {
    const canary = "BODY_CANARY_NEVER_AUDIT";
    const { socketPath, records } = await fixture({
      createNote: async () => {
        throw Object.assign(new Error("admission refused"), { code: "too_large" });
      },
    });
    const body = Buffer.from(canary);
    const socket = await connect(socketPath);
    socket.write(createBodyHeader("admission", body));
    await readFrame(socket);
    socket.write(body);

    await expect(readFrame(socket)).resolves.toMatchObject({
      id: "admission",
      ok: false,
      error: { code: "too_large" },
    });
    expect(records).toContainEqual(
      expect.objectContaining({ outcome: "too_large", phase: "admission" }),
    );
    expect(JSON.stringify(records)).not.toContain(canary);
  });
});

describe("nookd body failure containment", () => {
  it.each(["sha", "utf8", "overrun", "early"] as const)(
    "fails closed and releases the lease for %s",
    async (kind) => {
      const { socketPath, createNote, budget } = await fixture();
      const socket = await connect(socketPath);
      const valid = Buffer.from("valid body");
      if (kind === "early") {
        socket.write(Buffer.concat([createBodyHeader("early", valid), valid]));
        await waitForClose(socket);
      } else {
        const body = kind === "utf8" ? Buffer.from([0xf0, 0x28, 0x8c, 0x28]) : Buffer.from("four");
        const header = createBodyHeader(kind, body, kind === "overrun" ? 3 : body.length);
        if (kind === "sha") {
          const parsed = JSON.parse(header.subarray(4).toString("utf8")) as {
            body: { sha256: string };
          };
          parsed.body.sha256 = "0".repeat(64);
          socket.write(frame(parsed));
        } else {
          socket.write(header);
        }
        await readFrame(socket);
        socket.write(kind === "overrun" ? Buffer.from("four") : body);
        await waitForClose(socket);
      }
      expect(createNote).not.toHaveBeenCalled();
      await expectLeaseReleased(budget);
    },
  );

  it("enforces an absolute deadline despite regular chunks and releases the lease", async () => {
    const { socketPath, createNote, budget } = await fixture({
      abuseBounds: { bodyReceiveTimeoutMs: 40, connectionIdleTimeoutMs: 1_000 },
    });
    const body = Buffer.alloc(100, 120);
    const socket = await connect(socketPath);
    socket.write(createBodyHeader("deadline", body));
    await readFrame(socket);

    const closed = waitForClose(socket);
    for (let index = 0; index < 3 && !socket.destroyed; index += 1) {
      try {
        socket.write(body.subarray(index, index + 1), () => undefined);
      } catch {
        break;
      }
      await delay(20);
    }
    await closed;
    expect(createNote).not.toHaveBeenCalled();
    await expectLeaseReleased(budget);
  });

  it("releases the lease after a disconnect mid-body", async () => {
    const { socketPath, createNote, budget } = await fixture();
    const body = Buffer.from("disconnect me");
    const socket = await connect(socketPath);
    socket.write(createBodyHeader("disconnect", body));
    await readFrame(socket);
    socket.write(body.subarray(0, 3));
    socket.destroy();
    await waitForClose(socket);

    expect(createNote).not.toHaveBeenCalled();
    await expectLeaseReleased(budget);
  });

  it("holds the lease after disconnect until an admitted runtime operation settles", async () => {
    let finishCreate: (() => void) | undefined;
    const createNote: CreateNote = async (command) =>
      new Promise((resolve) => {
        finishCreate = () =>
          resolve({
            operation: "create",
            id: "note-1",
            titleBytes: Buffer.byteLength(command.title),
            contentBytes: Buffer.byteLength(command.content),
            localCommitted: true,
            remoteSynced: false,
            pendingSync: true,
          });
      });
    const { socketPath, createNote: createSpy, budget } = await fixture({ createNote });
    const body = Buffer.from("runtime still running");
    const socket = await connect(socketPath);
    socket.write(createBodyHeader("detached-runtime", body));
    await readFrame(socket);
    socket.write(body);
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    socket.destroy();
    await waitForClose(socket);

    expect(budget.tryAcquire(1).kind).toBe("busy");
    finishCreate?.();
    await expectLeaseReleased(budget);
  });

  it("allows only one concurrent body and answers the second with busy", async () => {
    const inner = createLargeBodyBudget();
    let active = 0;
    let maximumActive = 0;
    const budget: LargeBodyBudget = {
      tryAcquire(bytes) {
        const acquisition = inner.tryAcquire(bytes);
        if (acquisition.kind === "busy") return acquisition;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        let released = false;
        return Object.freeze({
          kind: "acquired" as const,
          bytes,
          release() {
            if (released) return;
            released = true;
            active -= 1;
            acquisition.release();
          },
        });
      },
    };
    const { socketPath } = await fixture({ budget });
    const first = await connect(socketPath);
    const second = await connect(socketPath);
    const firstBody = Buffer.from("first");
    first.write(createBodyHeader("first", firstBody));
    await expect(readFrame(first)).resolves.toMatchObject({
      id: "first",
      result: { kind: "body_continue" },
    });

    second.write(createBodyHeader("second", Buffer.from("second")));
    await expect(readFrame(second)).resolves.toMatchObject({
      id: "second",
      ok: false,
      error: { code: "busy" },
    });
    await waitForClose(second);
    expect(maximumActive).toBe(1);
    expect(active).toBe(1);
    expect(first.destroyed).toBe(false);

    first.destroy();
    await waitForClose(first);
    await expectLeaseReleased(budget);
  });
});
