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
import {
  createCustomServicePolicy,
  createReadOnlyServicePolicy,
  createReadWriteNoDeleteServicePolicy,
  type ServicePolicy,
} from "../src/service/service-policy.js";

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

const NOTE_ID = "0123456789abcdef0123456789abcdef";
const REVISION = "rev_00000000000000000000000000000000";

type BodyMethod = "notes.create" | "notes.append" | "notes.update";

/** A well-formed body header for each daemon body method, optionally with the
 * declared field also present in params. */
function bodyMethodHeader(
  method: BodyMethod,
  id: string,
  body: Buffer,
  options: { readonly duplicateInParams?: boolean } = {},
): Buffer {
  const duplicate = options.duplicateInParams === true;
  const text = body.toString("utf8");
  const declaration = (field: string) => ({
    field,
    bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  if (method === "notes.create") {
    return frame({
      id,
      method,
      params: { title: "Body framing", ...(duplicate ? { content: text } : {}) },
      body: declaration("content"),
    });
  }
  if (method === "notes.append") {
    return frame({
      id,
      method,
      params: {
        id: NOTE_ID,
        expectedRevision: REVISION,
        ...(duplicate ? { markdownFragment: text } : {}),
      },
      body: declaration("markdownFragment"),
    });
  }
  return frame({
    id,
    method,
    params: {
      id: NOTE_ID,
      expectedRevision: REVISION,
      patch: duplicate ? { content: text } : {},
    },
    body: declaration("content"),
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

/** The next frame, or "closed" if the peer closes first. Never hangs on a close. */
async function readFrameOrClose(socket: net.Socket): Promise<RpcAnyResponseEnvelope | "closed"> {
  return new Promise((resolve) => {
    let bytes = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const size = bytes.readUInt32BE(0);
      if (bytes.length < size + 4) return;
      finish(JSON.parse(bytes.subarray(4, size + 4).toString("utf8")) as RpcAnyResponseEnvelope);
    };
    const onClose = (): void => finish("closed");
    const finish = (value: RpcAnyResponseEnvelope | "closed"): void => {
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      resolve(value);
    };
    if (socket.destroyed) {
      resolve("closed");
      return;
    }
    socket.on("data", onData);
    socket.once("close", onClose);
  });
}

/** Count every byte the daemon writes from now until the socket closes. */
function collectUntilClose(socket: net.Socket): Promise<number> {
  return new Promise((resolve) => {
    let received = 0;
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    if (socket.destroyed) resolve(received);
    else socket.once("close", () => resolve(received));
  });
}

/** Resolves `true` if the socket closes within `ms`, `false` otherwise. */
async function closesWithin(socket: net.Socket, ms: number): Promise<boolean> {
  const bound = delay(ms).then(() => false);
  return Promise.race([waitForClose(socket).then(() => true), bound]);
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
  readonly policy?: ServicePolicy;
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
    policy: options.policy ?? createReadWriteNoDeleteServicePolicy(),
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

  it("answers notes.capabilities under a deny-all policy", async () => {
    const { socketPath, search } = await fixture({ policy: createCustomServicePolicy([]) });
    const socket = await connect(socketPath);
    // The same policy refuses an ordinary read, so the probe below is not
    // answered by a policy that happens to allow it.
    socket.write(searchFrame("denied", "needle"));
    await expect(readFrame(socket)).resolves.toMatchObject({
      id: "denied",
      ok: false,
      error: { code: "permission_denied" },
    });

    const probe = await connect(socketPath);
    probe.write(capabilitiesFrame("probe"));
    await expect(readFrame(probe)).resolves.toEqual({
      id: "probe",
      ok: true,
      result: { kind: "capabilities", protocol: 2 },
    });
    expect(search).not.toHaveBeenCalled();
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
    const { socketPath, createNote, search } = await fixture({ maxRequestsPerConnection: 2 });
    const body = Buffer.from("one request");
    const socket = await connect(socketPath);
    socket.write(createBodyHeader("one-logical", body));
    await readFrame(socket);
    socket.write(body);

    await expect(readFrame(socket)).resolves.toMatchObject({ id: "one-logical", ok: true });
    expect(createNote).toHaveBeenCalledTimes(1);

    // Counted twice, the body exchange would exhaust a limit of two and this
    // request would be closed unanswered.
    socket.write(searchFrame("second", "needle"));
    await expect(readFrameOrClose(socket)).resolves.toMatchObject({
      id: "second",
      ok: true,
      result: { kind: "search" },
    });
    expect(search).toHaveBeenCalledTimes(1);
    await waitForClose(socket);
  });

  it.each(["notes.create", "notes.append", "notes.update"] as const)(
    "refuses %s at the header when the policy does not name it",
    async (method) => {
      const inner = createLargeBodyBudget();
      const tryAcquire = vi.fn((bytes: number) => inner.tryAcquire(bytes));
      const { socketPath, createNote, records } = await fixture({
        budget: { tryAcquire },
        policy: createReadOnlyServicePolicy(),
      });
      const socket = await connect(socketPath);
      socket.write(bodyMethodHeader(method, "denied", Buffer.from("never invited")));

      // Inviting the body first would make this frame a body_continue.
      await expect(readFrameOrClose(socket)).resolves.toMatchObject({
        id: "denied",
        ok: false,
        error: { code: "permission_denied" },
      });
      await waitForClose(socket);
      expect(tryAcquire).not.toHaveBeenCalled();
      expect(createNote).not.toHaveBeenCalled();
      expect(records).toContainEqual(
        expect.objectContaining({
          event: "rpc.protocol.rejected",
          outcome: "permission_denied",
          method,
        }),
      );
      expect(records.filter((record) => record.event === "rpc.request.dispatched")).toEqual([]);
    },
  );

  it.each(["notes.create", "notes.append", "notes.update"] as const)(
    "closes %s unanswered when the declared field also appears in params",
    async (method) => {
      const inner = createLargeBodyBudget();
      const tryAcquire = vi.fn((bytes: number) => inner.tryAcquire(bytes));
      const { socketPath, createNote } = await fixture({ budget: { tryAcquire } });
      const socket = await connect(socketPath);
      const received = collectUntilClose(socket);
      socket.write(
        bodyMethodHeader(method, "duplicate", Buffer.from("twice"), { duplicateInParams: true }),
      );

      await expect(closesWithin(socket, 2_000)).resolves.toBe(true);
      await expect(received).resolves.toBe(0);
      expect(tryAcquire).not.toHaveBeenCalled();
      expect(createNote).not.toHaveBeenCalled();
    },
  );

  it("closes an oversize operator-only declaration unanswered", async () => {
    const inner = createLargeBodyBudget();
    const tryAcquire = vi.fn((bytes: number) => inner.tryAcquire(bytes));
    const { socketPath, records } = await fixture({ budget: { tryAcquire } });
    const socket = await connect(socketPath);
    const received = collectUntilClose(socket);
    socket.write(
      frame({
        id: "operator",
        method: "notes.apply-edit",
        params: {},
        body: { field: "markdown", bytes: WIRE_BODY_BYTES + 1, sha256: "0".repeat(64) },
      }),
    );

    // An unknown method gets exactly this: no envelope, closed.
    await expect(closesWithin(socket, 2_000)).resolves.toBe(true);
    await expect(received).resolves.toBe(0);
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(records.some((record) => record.outcome === "too_large")).toBe(false);
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
  it.each(["sha", "utf8"] as const)(
    "fails closed and releases the lease for %s",
    async (kind) => {
      const { socketPath, createNote, budget } = await fixture();
      const socket = await connect(socketPath);
      const body = kind === "utf8" ? Buffer.from([0xf0, 0x28, 0x8c, 0x28]) : Buffer.from("four");
      const header = createBodyHeader(kind, body);
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
      socket.write(body);
      await waitForClose(socket);
      expect(createNote).not.toHaveBeenCalled();
      await expectLeaseReleased(budget);
    },
  );

  it("fails closed on a byte beyond the declared length in the same chunk", async () => {
    // Long deadlines, so only the overrun refusal can close this promptly.
    const { socketPath, createNote, budget } = await fixture({
      abuseBounds: { bodyReceiveTimeoutMs: 20_000, connectionIdleTimeoutMs: 20_000 },
    });
    const declared = Buffer.from("fou");
    const socket = await connect(socketPath);
    // The digest is correct for the declared bytes: it cannot be what refuses.
    socket.write(createBodyHeader("overrun", declared));
    await expect(readFrame(socket)).resolves.toMatchObject({
      result: { kind: "body_continue", bytes: 3 },
    });
    const received = collectUntilClose(socket);
    socket.write(Buffer.concat([declared, Buffer.from("r")]));

    await expect(closesWithin(socket, 2_000)).resolves.toBe(true);
    await expect(received).resolves.toBe(0);
    expect(createNote).not.toHaveBeenCalled();
    await expectLeaseReleased(budget);
  });

  it("fails closed on a byte beyond the declared length in a later chunk", async () => {
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
    const {
      socketPath,
      createNote: createSpy,
      search,
      budget,
    } = await fixture({ createNote, maxRequestsPerConnection: 8 });
    const body = Buffer.from("exact");
    const socket = await connect(socketPath);
    socket.write(createBodyHeader("later-overrun", body));
    await readFrame(socket);
    socket.write(body);
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));

    // A whole, valid request sent before the create's response is written is
    // still beyond the declared length; it must not be served.
    const received = collectUntilClose(socket);
    socket.write(searchFrame("smuggled", "needle"));
    const closedPromptly = await closesWithin(socket, 2_000);
    finishCreate?.();
    expect(closedPromptly).toBe(true);
    await expect(received).resolves.toBe(0);
    expect(search).not.toHaveBeenCalled();
    await expectLeaseReleased(budget);
  });

  it("closes on body bytes coalesced with the header without inviting them", async () => {
    const inner = createLargeBodyBudget();
    const tryAcquire = vi.fn((bytes: number) => inner.tryAcquire(bytes));
    const { socketPath, createNote } = await fixture({ budget: { tryAcquire } });
    const socket = await connect(socketPath);
    const received = collectUntilClose(socket);
    const valid = Buffer.from("valid body");
    socket.write(Buffer.concat([createBodyHeader("early", valid), valid]));

    // No body_continue, nor any other frame, was written.
    await expect(closesWithin(socket, 2_000)).resolves.toBe(true);
    await expect(received).resolves.toBe(0);
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(createNote).not.toHaveBeenCalled();
  });

  it("enforces an absolute deadline despite regular chunks and releases the lease", async () => {
    const bodyReceiveTimeoutMs = 200;
    const connectionIdleTimeoutMs = 20_000;
    const { socketPath, createNote, budget, records } = await fixture({
      abuseBounds: { bodyReceiveTimeoutMs, connectionIdleTimeoutMs },
    });
    const body = Buffer.alloc(1_000, 120);
    const socket = await connect(socketPath);
    const startedMs = Date.now();
    socket.write(createBodyHeader("deadline", body));
    await readFrame(socket);

    // Keep the connection active well past the deadline, so neither the idle
    // timeout nor a stall can be what closes it.
    const closedAt = waitForClose(socket).then(() => Date.now());
    const sender = (async () => {
      for (let index = 0; index < body.length - 1 && !socket.destroyed; index += 1) {
        socket.write(body.subarray(index, index + 1), () => undefined);
        await delay(10);
      }
    })();
    const boundMs = bodyReceiveTimeoutMs * 5;
    const closedMs = await Promise.race([closedAt, delay(boundMs).then(() => undefined)]);
    expect(closedMs, "the body deadline did not close the connection").toBeDefined();
    await sender;
    const elapsedMs = (closedMs ?? Number.POSITIVE_INFINITY) - startedMs;
    expect(elapsedMs).toBeGreaterThanOrEqual(bodyReceiveTimeoutMs - 20);
    expect(elapsedMs).toBeLessThan(boundMs);
    expect(boundMs).toBeLessThan(connectionIdleTimeoutMs);

    expect(records).toContainEqual(
      expect.objectContaining({
        event: "rpc.request.timeout",
        outcome: "timeout",
        method: "notes.create",
        latencyMs: bodyReceiveTimeoutMs,
      }),
    );
    expect(records.filter((record) => record.event === "rpc.request.dispatched")).toEqual([]);
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
    const { socketPath, records } = await fixture({ budget });
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
    expect(records).toContainEqual(
      expect.objectContaining({ event: "rpc.protocol.rejected", outcome: "busy" }),
    );
    expect(records.filter((record) => record.event === "rpc.request.dispatched")).toEqual([]);
    expect(maximumActive).toBe(1);
    expect(active).toBe(1);
    expect(first.destroyed).toBe(false);

    first.destroy();
    await waitForClose(first);
    await expectLeaseReleased(budget);
  });
});
