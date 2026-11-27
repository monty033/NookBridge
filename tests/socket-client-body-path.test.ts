/**
 * Issue #327 step three — the MCP socket client's side of the body path.
 *
 * Every request that fits one frame must cross the wire exactly as it did
 * before this change, with no negotiation. Only a request the single frame
 * cannot carry probes the daemon, and only a protocol-2 daemon receives the
 * two-phase header-then-body exchange. The fakes drive the client through its
 * `connect` seam; the last block runs the client against the real daemon.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RPC_FRAME_BYTES, WIRE_BODY_BYTES } from "../src/core/size-limits.js";
import { NookdSocketClient, type SocketConnect } from "../src/mcp/socket-client.js";
import {
  startNookdServer,
  type NookdServerHandle,
  type NookdServerRuntime,
} from "../src/service/nookd-server.js";
import { STAGE5_RPC_LIMITS, type RpcNotesUpdateParams } from "../src/service/rpc-protocol.js";
import { DEFAULT_SERVICE_ABUSE_BOUNDS } from "../src/service/service-abuse-bounds.js";
import { createReadWriteNoDeleteServicePolicy } from "../src/service/service-policy.js";

const SOCKET_PATH = "/tmp/nookbridge-327-client.sock";
const REV = "rev_0123456789abcdef0123456789abcdef";
const INLINE_CONTENT_BYTES = STAGE5_RPC_LIMITS.maxContentBytes;

type WriteCallback = (error?: Error | null) => void;
type Envelope = { id: string; method: string; params: Record<string, unknown>; body?: BodyDecl };
type BodyDecl = { field: string; bytes: number; sha256: string };

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const out = Buffer.alloc(4 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

function parseFrame(bytes: Buffer): Envelope {
  expect(bytes.readUInt32BE(0)).toBe(bytes.length - 4);
  return JSON.parse(bytes.subarray(4).toString("utf8")) as Envelope;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One accepted connection: records every write and lets the test answer. */
class FakeConnection extends EventEmitter {
  readonly writes: Buffer[] = [];
  destroyed = false;
  readonly #onWrite: (connection: FakeConnection, bytes: Buffer, index: number) => void;

  constructor(onWrite: (connection: FakeConnection, bytes: Buffer, index: number) => void) {
    super();
    this.#onWrite = onWrite;
  }

  get request(): Envelope {
    return parseFrame(this.writes[0] as Buffer);
  }

  write(bytes: Uint8Array, callback: WriteCallback): boolean {
    const copy = Buffer.from(bytes);
    this.writes.push(copy);
    callback();
    this.#onWrite(this, copy, this.writes.length - 1);
    return true;
  }

  reply(value: unknown): void {
    const bytes = frame(value);
    globalThis.setImmediate(() => {
      if (!this.destroyed) this.emit("data", bytes);
    });
  }

  /** What a protocol-1 daemon does with a method it does not know. */
  hangUp(): void {
    globalThis.setImmediate(() => {
      if (!this.destroyed) this.emit("close");
    });
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

type Handler = (connection: FakeConnection, bytes: Buffer, index: number) => void;

function fakeDaemon(handler: Handler): {
  connect: SocketConnect;
  connections: FakeConnection[];
  setHandler: (next: Handler) => void;
} {
  const connections: FakeConnection[] = [];
  let current = handler;
  return {
    connections,
    setHandler: (next) => {
      current = next;
    },
    connect: async () => {
      const connection = new FakeConnection((c, bytes, index) => current(c, bytes, index));
      connections.push(connection);
      return connection as unknown as Socket;
    },
  };
}

function methodsOf(connections: readonly FakeConnection[]): string[] {
  return connections.map((connection) => connection.request.method);
}

const ok = (id: string, result: unknown) => ({ id, ok: true, result });
const fail = (id: string, code: string) => ({ id, ok: false, error: { code, message: "x" } });
const STATUS = { kind: "status", lastSynced: 0, hasUnsyncedChanges: false };

function resultFor(request: Envelope, bodyBytes?: number): unknown {
  switch (request.method) {
    case "notes.create":
      return {
        kind: "create",
        id: "note-1",
        titleBytes: 5,
        contentBytes: bodyBytes ?? Buffer.byteLength(String(request.params.content)),
      };
    case "notes.append":
      return { kind: "append", id: "note-1", fragmentBytes: bodyBytes ?? 1 };
    case "notes.update":
      return {
        kind: "update",
        id: "note-1",
        appliedFields: ["content"],
        contentBytes: bodyBytes ?? 1,
      };
    default:
      return STATUS;
  }
}

interface Protocol2Options {
  /** Answer a body header with this instead of continue. */
  readonly headerReply?: (request: Envelope) => unknown;
  /** Called instead of answering the header immediately. */
  readonly holdContinue?: (send: () => void, connection: FakeConnection) => void;
}

/** A protocol-2 daemon: answers the probe, invites declared bodies, then replies. */
function protocol2(options: Protocol2Options = {}): Handler {
  return (connection, bytes, index) => {
    if (index === 1) {
      const request = connection.request;
      connection.reply(ok(request.id, resultFor(request, bytes.length)));
      return;
    }
    const request = parseFrame(bytes);
    if (request.method === "notes.capabilities") {
      connection.reply(ok(request.id, { kind: "capabilities", protocol: 2 }));
      return;
    }
    if (request.body === undefined) {
      connection.reply(ok(request.id, resultFor(request)));
      return;
    }
    if (options.headerReply !== undefined) {
      connection.reply(options.headerReply(request));
      return;
    }
    const body = request.body;
    const send = (): void =>
      connection.reply(ok(request.id, { kind: "body_continue", bytes: body.bytes }));
    if (options.holdContinue !== undefined) options.holdContinue(send, connection);
    else send();
  };
}

/** A protocol-1 daemon: closes on `notes.capabilities`, serves the rest. */
const protocol1: Handler = (connection, bytes) => {
  const request = parseFrame(bytes);
  if (request.method === "notes.capabilities" || request.body !== undefined) {
    connection.hangUp();
    return;
  }
  connection.reply(ok(request.id, resultFor(request)));
};

const unreachable: Handler = (connection) => connection.hangUp();

function client(connect: SocketConnect, ioTimeoutMs?: number): NookdSocketClient {
  return new NookdSocketClient({
    socketPath: SOCKET_PATH,
    connect,
    ...(ioTimeoutMs === undefined ? {} : { ioTimeoutMs }),
  });
}

/** An update whose every field is at its single-frame maximum, with `"` doubling on escape. */
function maxEnvelopeUpdate(contentBytes: number): RpcNotesUpdateParams {
  return {
    id: "n".repeat(256),
    expectedRevision: REV,
    patch: {
      title: '"'.repeat(256),
      content: '"'.repeat(contentBytes),
      notebookId: "b".repeat(256),
      tags: Array.from({ length: 16 }, () => '"'.repeat(256)),
      pinned: true,
      favorite: false,
      listKind: "simple-checklist",
    },
  } as unknown as RpcNotesUpdateParams;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("compatibility, byte for byte", () => {
  /*
   * Recorded from the pre-change client (7c56dbd) through the same fake: the
   * clock pinned at 1_700_000_000_000 and a fresh module so request ids are
   * deterministic. Small frames are kept verbatim; large ones by length and
   * SHA-256 over the exact bytes written.
   */
  const ID = (n: number): string => `nook-mcp-18bcfe56800-${n.toString(16).padStart(8, "0")}`;
  const RECORDED: ReadonlyArray<{
    readonly name: string;
    readonly run: (c: NookdSocketClient) => Promise<unknown>;
    readonly reply: (id: string) => unknown;
    readonly bytes: number;
    readonly sha256: string;
    readonly json?: string;
    readonly result: unknown;
  }> = [
    {
      name: "status",
      run: (c) => c.status(),
      reply: (id) => ok(id, { kind: "status", lastSynced: 5, hasUnsyncedChanges: false }),
      bytes: 78,
      sha256: "6e192f50a05ebbdc0475bc4d78b2c631f41b914ef892f08a1d5fd950315f1d7d",
      json: `{"id":"${ID(1)}","method":"notes.status","params":{}}`,
      result: {
        ok: true,
        envelope: {
          id: ID(1),
          ok: true,
          result: { kind: "status", lastSynced: 5, hasUnsyncedChanges: false },
        },
      },
    },
    {
      name: "search",
      run: (c) => c.search({ query: "alpha", id: "compat-search-1" }),
      reply: (id) => ok(id, { kind: "search", notes: [{ title: "Alpha" }] }),
      bytes: 79,
      sha256: "d9e96c7dff64f1684b0fb67657445aa59fa37512f9db7ccb7b73a847f00f20ec",
      json: `{"id":"compat-search-1","method":"notes.search","params":{"query":"alpha"}}`,
      result: {
        ok: true,
        envelope: {
          id: "compat-search-1",
          ok: true,
          result: { kind: "search", notes: [{ title: "Alpha" }] },
        },
      },
    },
    {
      name: "create with multi-byte content, answered too_large",
      run: (c) =>
        c.createNote({
          title: "Compat",
          content: "hello ünïcødé\n",
          notebookId: "nb-1",
          listKind: "task-list",
        }),
      reply: (id) => fail(id, "too_large"),
      bytes: 169,
      sha256: "91ea712be430bbe180217a14a6b01be0f7eb5e7f12e68b4c43bba871fd784baa",
      json: `{"id":"${ID(2)}","method":"notes.create","params":{"title":"Compat","content":"hello ünïcødé\\n","notebookId":"nb-1","listKind":"task-list"}}`,
      result: { ok: false, code: "too_large" },
    },
    {
      name: "append of a full fragment of newlines, answered permission_denied",
      run: (c) =>
        c.appendNote({
          id: "note-1",
          markdownFragment: "\n".repeat(INLINE_CONTENT_BYTES),
          expectedRevision: REV,
        } as never),
      reply: (id) => fail(id, "permission_denied"),
      bytes: 54_171,
      sha256: "c6846c78d35e1fa188167214aba85023c0df78d3cc0d3f9c2e46e96ffe8c29e6",
      result: { ok: false, code: "permission_denied" },
    },
    {
      name: "the largest constructible single frame, answered stale_revision",
      run: (c) => c.updateNote(maxEnvelopeUpdate(INLINE_CONTENT_BYTES)),
      reply: (id) => fail(id, "stale_revision"),
      bytes: 63_527,
      sha256: "2ee8aba6e2233c6979c52d017fb6b8f04457633894ff2719525a8cc18710b91f",
      result: { ok: false, code: "stale_revision" },
    },
    {
      name: "create at the single-frame content cap",
      run: (c) => c.createNote({ title: "Cap", content: "a".repeat(INLINE_CONTENT_BYTES) }),
      reply: (id) => ok(id, { kind: "create", id: "note-2", titleBytes: 3, contentBytes: 27_000 }),
      bytes: 27_104,
      sha256: "8a62c981f374c41977a3aa5d2f0f9679639ac1641e697bb9fac78d9f27ccbd97",
      result: {
        ok: true,
        envelope: {
          id: ID(5),
          ok: true,
          result: { kind: "create", id: "note-2", titleBytes: 3, contentBytes: 27_000 },
        },
      },
    },
    {
      name: "status answered busy (a single-frame reply, so service_unavailable)",
      run: (c) => c.status(),
      reply: (id) => fail(id, "busy"),
      bytes: 78,
      sha256: "b859f57fefaf48e40dfe02649eef8662f115c8f4db6e9746d3e2c7c2d5295456",
      json: `{"id":"${ID(6)}","method":"notes.status","params":{}}`,
      result: { ok: false, code: "service_unavailable" },
    },
    {
      name: "status answered with a capabilities result",
      run: (c) => c.status(),
      reply: (id) => ok(id, { kind: "capabilities", protocol: 2 }),
      bytes: 78,
      sha256: "913e0e0822fccb6a786a31c0f2de6a95a7a30707c55ef93af449e4a83a725742",
      json: `{"id":"${ID(7)}","method":"notes.status","params":{}}`,
      result: { ok: false, code: "service_unavailable" },
    },
    {
      name: "delete answered not_found",
      run: (c) => c.deleteNote({ path: "Inbox/Compat" }),
      reply: (id) => fail(id, "not_found"),
      bytes: 99,
      sha256: "bbffe6e991ffc66c7f84144c3e57cbfcce6ae7dcdaeaa36bc10bdde0e0f4cd0e",
      json: `{"id":"${ID(8)}","method":"notes.delete","params":{"path":"Inbox/Compat"}}`,
      result: { ok: false, code: "not_found" },
    },
    {
      name: "get answered invalid_request",
      run: (c) => c.getNote("note-1"),
      reply: (id) => fail(id, "invalid_request"),
      bytes: 88,
      sha256: "799c3cc403b46fa5d132cfee260e9c1aafa0ba17e2ec1695b04d1be883da4226",
      json: `{"id":"${ID(9)}","method":"notes.get","params":{"id":"note-1"}}`,
      result: { ok: false, code: "invalid_request" },
    },
  ];

  it("writes exactly the pre-change frames and returns the pre-change results", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ["Date"] });
    vi.resetModules();
    const fresh = await import("../src/mcp/socket-client.js");
    const connections: FakeConnection[] = [];
    for (const recorded of RECORDED) {
      const daemon = fakeDaemon((connection, bytes) =>
        connection.reply(recorded.reply(parseFrame(bytes).id)),
      );
      const freshClient = new fresh.NookdSocketClient({
        socketPath: SOCKET_PATH,
        connect: daemon.connect,
      });
      const result = await recorded.run(freshClient as unknown as NookdSocketClient);
      expect(daemon.connections, recorded.name).toHaveLength(1);
      const connection = daemon.connections[0] as FakeConnection;
      connections.push(connection);
      expect(connection.writes, recorded.name).toHaveLength(1);
      const written = connection.writes[0] as Buffer;
      expect(written.length, recorded.name).toBe(recorded.bytes);
      expect(written.length, recorded.name).toBeLessThanOrEqual(RPC_FRAME_BYTES);
      expect(sha256(written), recorded.name).toBe(recorded.sha256);
      if (recorded.json !== undefined) {
        expect(written.subarray(4).toString("utf8"), recorded.name).toBe(recorded.json);
      }
      expect(result, recorded.name).toEqual(recorded.result);
    }
    expect(methodsOf(connections)).not.toContain("notes.capabilities");
  });
});

describe("path boundary", () => {
  it("sends the largest request that still fits one frame as a single frame with no probe", async () => {
    const daemon = fakeDaemon(protocol2());
    const result = await client(daemon.connect).updateNote(maxEnvelopeUpdate(INLINE_CONTENT_BYTES));
    expect(result.ok).toBe(true);
    expect(methodsOf(daemon.connections)).toEqual(["notes.update"]);
    const connection = daemon.connections[0] as FakeConnection;
    expect(connection.writes).toHaveLength(1);
    expect(connection.writes[0]?.length).toBe(63_527);
    expect(connection.request.body).toBeUndefined();
    expect(connection.request.params.patch).toHaveProperty("content");
  });

  it("takes the body path for one body byte more", async () => {
    const daemon = fakeDaemon(protocol2());
    const params = maxEnvelopeUpdate(INLINE_CONTENT_BYTES + 1);
    const result = await client(daemon.connect).updateNote(params);
    expect(result.ok).toBe(true);
    expect(methodsOf(daemon.connections)).toEqual(["notes.capabilities", "notes.update"]);
    const connection = daemon.connections[1] as FakeConnection;
    expect(connection.writes).toHaveLength(2);
    const header = connection.request;
    expect(header.body).toEqual({
      field: "content",
      bytes: INLINE_CONTENT_BYTES + 1,
      sha256: sha256(Buffer.from('"'.repeat(INLINE_CONTENT_BYTES + 1))),
    });
    expect(header.params.patch).not.toHaveProperty("content");
    expect(header.params.patch).toEqual({
      title: '"'.repeat(256),
      notebookId: "b".repeat(256),
      tags: Array.from({ length: 16 }, () => '"'.repeat(256)),
      pinned: true,
      favorite: false,
      listKind: "simple-checklist",
    });
    expect(connection.writes[1]?.toString("utf8")).toBe('"'.repeat(INLINE_CONTENT_BYTES + 1));
  });

  it("never sends the probe for any request that fits one frame", async () => {
    const daemon = fakeDaemon(protocol2());
    const c = client(daemon.connect);
    await c.status();
    await c.createNote({ title: "Small", content: "a".repeat(INLINE_CONTENT_BYTES) });
    await c.appendNote({ id: "note-1", markdownFragment: "x", expectedRevision: REV } as never);
    expect(methodsOf(daemon.connections)).toEqual(["notes.status", "notes.create", "notes.append"]);
  });
});

describe("negotiation fallback", () => {
  it("falls back to protocol 1 when the daemon closes on notes.capabilities and still serves a small request", async () => {
    const daemon = fakeDaemon(protocol1);
    const c = client(daemon.connect);
    await expect(
      c.createNote({ title: "Large", content: "a".repeat(INLINE_CONTENT_BYTES + 1) }),
    ).resolves.toEqual({ ok: false, code: "too_large" });
    const small = await c.status();
    expect(small.ok).toBe(true);
    expect(methodsOf(daemon.connections)).toEqual([
      "notes.capabilities",
      "notes.status",
      "notes.status",
    ]);
    // A protocol-1 answer is not kept: a second large request asks again, and
    // is refused again without the request or its body ever being sent.
    await expect(
      c.createNote({ title: "Large", content: "a".repeat(INLINE_CONTENT_BYTES + 1) }),
    ).resolves.toEqual({ ok: false, code: "too_large" });
    expect(methodsOf(daemon.connections)).toEqual([
      "notes.capabilities",
      "notes.status",
      "notes.status",
      "notes.capabilities",
      "notes.status",
    ]);
    for (const connection of daemon.connections) expect(connection.writes).toHaveLength(1);
  });

  it("does not keep a protocol-1 answer that was really an admission rejection of the probe", async () => {
    // Admission control (not yet accepting, connection limit, rate limit)
    // closes the probe connection with no reply, exactly as protocol 1 does.
    let rejectProbe = true;
    const accepting = protocol2();
    const daemon = fakeDaemon((connection, bytes, index) => {
      if (index === 0 && parseFrame(bytes).method === "notes.capabilities" && rejectProbe) {
        rejectProbe = false;
        connection.hangUp();
        return;
      }
      accepting(connection, bytes, index);
    });
    const c = client(daemon.connect);
    const large = { title: "Large", content: "a".repeat(INLINE_CONTENT_BYTES + 1) };
    await expect(c.createNote(large)).resolves.toEqual({ ok: false, code: "too_large" });
    expect(methodsOf(daemon.connections)).toEqual(["notes.capabilities", "notes.status"]);

    // The daemon now answers the probe. A kept protocol-1 answer would refuse
    // this client-side for the life of the process.
    const result = await c.createNote(large);
    expect(result).toMatchObject({ ok: true, envelope: { result: { kind: "create" } } });
    expect(methodsOf(daemon.connections)).toEqual([
      "notes.capabilities",
      "notes.status",
      "notes.capabilities",
      "notes.create",
    ]);
    const connection = daemon.connections[3] as FakeConnection;
    expect(connection.request.body?.bytes).toBe(INLINE_CONTENT_BYTES + 1);
    expect(connection.writes).toHaveLength(2);
  });

  it("reports unavailable when both probes fail", async () => {
    const daemon = fakeDaemon(unreachable);
    await expect(
      client(daemon.connect).createNote({
        title: "Large",
        content: "a".repeat(INLINE_CONTENT_BYTES + 1),
      }),
    ).resolves.toEqual({ ok: false, code: "service_unavailable" });
    expect(methodsOf(daemon.connections)).toEqual(["notes.capabilities", "notes.status"]);
  });

  it("probes once and reuses a protocol-2 answer", async () => {
    const daemon = fakeDaemon(protocol2());
    const c = client(daemon.connect);
    const large = { title: "Large", content: "a".repeat(INLINE_CONTENT_BYTES + 1) };
    expect((await c.createNote(large)).ok).toBe(true);
    expect((await c.createNote(large)).ok).toBe(true);
    expect(methodsOf(daemon.connections)).toEqual([
      "notes.capabilities",
      "notes.create",
      "notes.create",
    ]);
  });

  it("forgets a kept protocol-2 answer after a service_unavailable and re-probes the replaced daemon", async () => {
    const daemon = fakeDaemon(protocol2());
    const c = client(daemon.connect);
    const large = { title: "Large", content: "a".repeat(INLINE_CONTENT_BYTES + 1) };
    expect((await c.createNote(large)).ok).toBe(true);

    // The daemon goes away: any request now fails unavailable.
    daemon.setHandler(unreachable);
    await expect(c.status()).resolves.toEqual({ ok: false, code: "service_unavailable" });

    // It comes back as protocol 1. A kept protocol-2 answer would send it a body.
    daemon.setHandler(protocol1);
    await expect(c.createNote(large)).resolves.toEqual({ ok: false, code: "too_large" });
    expect(methodsOf(daemon.connections)).toEqual([
      "notes.capabilities",
      "notes.create",
      "notes.status",
      "notes.capabilities",
      "notes.status",
    ]);
    for (const connection of daemon.connections.slice(2)) {
      expect(connection.writes).toHaveLength(1);
      expect(connection.request.body).toBeUndefined();
    }
  });
});

describe("refusal against a protocol-1 daemon", () => {
  it("refuses a too-large request client-side with too_large and opens no connection for the body", async () => {
    const daemon = fakeDaemon(protocol1);
    const result = await client(daemon.connect).createNote({
      title: "Large",
      content: "a".repeat(INLINE_CONTENT_BYTES + 1),
    });
    expect(result).toEqual({ ok: false, code: "too_large" });
    // Only the two probes connected; neither carried the request or a body.
    expect(methodsOf(daemon.connections)).toEqual(["notes.capabilities", "notes.status"]);
    for (const connection of daemon.connections) {
      expect(connection.writes).toHaveLength(1);
      expect(connection.request.body).toBeUndefined();
      expect(connection.request.params).toEqual({});
    }
  });

  it("refuses a body over WIRE_BODY_BYTES as too_large without connecting at all", async () => {
    const daemon = fakeDaemon(protocol2());
    const result = await client(daemon.connect).createNote({
      title: "Huge",
      content: "a".repeat(WIRE_BODY_BYTES + 1),
    });
    expect(result).toEqual({ ok: false, code: "too_large" });
    expect(daemon.connections).toHaveLength(0);
  });

  it("keeps invalid_request, without connecting, for an oversize request that is also malformed", async () => {
    const daemon = fakeDaemon(protocol2());
    const result = await client(daemon.connect).createNote({
      title: "bad\u0001title",
      content: "a".repeat(INLINE_CONTENT_BYTES + 1),
    });
    expect(result).toEqual({ ok: false, code: "invalid_request" });
    expect(daemon.connections).toHaveLength(0);
  });

  it("refuses a body-path body that UTF-8 cannot carry exactly, without connecting", async () => {
    const daemon = fakeDaemon(protocol2());
    const result = await client(daemon.connect).createNote({
      title: "Surrogate",
      content: `${"a".repeat(INLINE_CONTENT_BYTES)}\ud800`,
    });
    expect(result).toEqual({ ok: false, code: "invalid_request" });
    expect(daemon.connections).toHaveLength(0);
  });
});

describe("two-phase write", () => {
  it("writes no body byte until the daemon's continue frame arrives", async () => {
    let release: (() => void) | undefined;
    const daemon = fakeDaemon(
      protocol2({
        holdContinue: (send) => {
          release = send;
        },
      }),
    );
    const content = "a".repeat(INLINE_CONTENT_BYTES + 1);
    const pending = client(daemon.connect).createNote({ title: "Large", content });
    await vi.waitFor(() => expect(release).toBeDefined());
    // Give the client every chance to write early.
    for (let turn = 0; turn < 20; turn += 1) await new Promise((r) => globalThis.setImmediate(r));
    const connection = daemon.connections[1] as FakeConnection;
    expect(connection.request.method).toBe("notes.create");
    expect(connection.writes).toHaveLength(1);
    release?.();
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(connection.writes).toHaveLength(2);
    // Raw bytes, no length prefix.
    expect(connection.writes[1]?.equals(Buffer.from(content, "utf8"))).toBe(true);
  });

  it.each([
    ["too_large", "too_large"],
    ["busy", "busy"],
    ["permission_denied", "permission_denied"],
    ["invalid_request", "invalid_request"],
  ] as const)(
    "returns a %s header reply and writes no body bytes at all",
    async (code, expected) => {
      const daemon = fakeDaemon(protocol2({ headerReply: (request) => fail(request.id, code) }));
      const result = await client(daemon.connect).createNote({
        title: "Large",
        content: "a".repeat(INLINE_CONTENT_BYTES + 1),
      });
      expect(result).toEqual({ ok: false, code: expected });
      const connection = daemon.connections[1] as FakeConnection;
      expect(connection.request.body).toBeDefined();
      expect(connection.writes).toHaveLength(1);
    },
  );

  it("refuses a continue for a different byte count and writes no body", async () => {
    const daemon = fakeDaemon(
      protocol2({
        headerReply: (request) =>
          ok(request.id, { kind: "body_continue", bytes: (request.body?.bytes ?? 0) - 1 }),
      }),
    );
    const result = await client(daemon.connect).createNote({
      title: "Large",
      content: "a".repeat(INLINE_CONTENT_BYTES + 1),
    });
    expect(result).toEqual({ ok: false, code: "service_unavailable" });
    expect(daemon.connections[1]?.writes).toHaveLength(1);
  });

  it("declares bytes and sha256 that match the bytes written for multi-byte text", async () => {
    const daemon = fakeDaemon(protocol2());
    // é is two bytes, 😀 is four bytes and two UTF-16 code units.
    const content = "é😀\n".repeat(4_000);
    expect(Buffer.byteLength(content)).toBeGreaterThan(INLINE_CONTENT_BYTES);
    expect(Buffer.byteLength(content)).not.toBe(content.length);
    const result = await client(daemon.connect).createNote({ title: "Wide", content });
    expect(result.ok).toBe(true);
    const connection = daemon.connections[1] as FakeConnection;
    const declared = connection.request.body as BodyDecl;
    const written = connection.writes[1] as Buffer;
    expect(declared.field).toBe("content");
    expect(declared.bytes).toBe(written.length);
    expect(declared.sha256).toBe(sha256(written));
    expect(written.toString("utf8")).toBe(content);
    expect(connection.request.params).toEqual({ title: "Wide" });
  });

  it("declares bytes and sha256 that match the bytes written for a body of exactly WIRE_BODY_BYTES", async () => {
    const daemon = fakeDaemon(protocol2());
    const content = "é".repeat(WIRE_BODY_BYTES / 2);
    expect(Buffer.byteLength(content)).toBe(WIRE_BODY_BYTES);
    const result = await client(daemon.connect).createNote({ title: "Edge", content });
    const connection = daemon.connections[1] as FakeConnection;
    const declared = connection.request.body as BodyDecl;
    const written = connection.writes[1] as Buffer;
    expect(declared.bytes).toBe(WIRE_BODY_BYTES);
    expect(written.length).toBe(WIRE_BODY_BYTES);
    expect(declared.sha256).toBe(sha256(written));
    expect(written.equals(Buffer.from(content, "utf8"))).toBe(true);
    // A body-path result may report more than the single-frame content cap.
    expect(result).toMatchObject({
      ok: true,
      envelope: { result: { kind: "create", contentBytes: WIRE_BODY_BYTES } },
    });
  });

  it("moves markdownFragment for append and patch.content for update out of params", async () => {
    const daemon = fakeDaemon(protocol2());
    const c = client(daemon.connect);
    const text = "z".repeat(INLINE_CONTENT_BYTES + 1);
    expect(
      (await c.appendNote({ id: "note-1", markdownFragment: text, expectedRevision: REV } as never))
        .ok,
    ).toBe(true);
    expect(
      (
        await c.updateNote({
          id: "note-1",
          expectedRevision: REV,
          patch: { content: text },
        } as unknown as RpcNotesUpdateParams)
      ).ok,
    ).toBe(true);
    const append = daemon.connections[1] as FakeConnection;
    const update = daemon.connections[2] as FakeConnection;
    expect(append.request.params).toEqual({ id: "note-1", expectedRevision: REV });
    expect(append.request.body?.field).toBe("markdownFragment");
    expect(update.request.params).toEqual({ id: "note-1", expectedRevision: REV, patch: {} });
    expect(update.request.body?.field).toBe("content");
    expect(append.writes[1]?.toString("utf8")).toBe(text);
    expect(update.writes[1]?.toString("utf8")).toBe(text);
  });

  it("rejects busy on a single-frame reply even after protocol 2 was negotiated", async () => {
    const daemon = fakeDaemon(protocol2());
    const c = client(daemon.connect);
    expect(
      (await c.createNote({ title: "Large", content: "a".repeat(INLINE_CONTENT_BYTES + 1) })).ok,
    ).toBe(true);
    daemon.setHandler((connection, bytes) => connection.reply(fail(parseFrame(bytes).id, "busy")));
    await expect(c.status()).resolves.toEqual({ ok: false, code: "service_unavailable" });
  });

  it.each([
    ["create", (c: NookdSocketClient) => c.createNote({ title: "Small", content: "x" })],
    [
      "append",
      (c: NookdSocketClient) =>
        c.appendNote({ id: "note-1", markdownFragment: "x", expectedRevision: REV } as never),
    ],
    [
      "update",
      (c: NookdSocketClient) =>
        c.updateNote({
          id: "note-1",
          expectedRevision: REV,
          patch: { content: "x" },
        } as unknown as RpcNotesUpdateParams),
    ],
  ] as const)(
    "bounds a single-frame %s reply's byte count by the inline cap, not WIRE_BODY_BYTES",
    async (_name, run) => {
      // A single frame carried at most the inline cap, so a larger count is not its answer.
      const daemon = fakeDaemon((connection, bytes) => {
        const request = parseFrame(bytes);
        connection.reply(ok(request.id, resultFor(request, INLINE_CONTENT_BYTES + 1)));
      });
      await expect(run(client(daemon.connect))).resolves.toEqual({
        ok: false,
        code: "service_unavailable",
      });
      expect(daemon.connections).toHaveLength(1);
      expect(daemon.connections[0]?.request.body).toBeUndefined();
    },
  );

  it.each([
    ["create", "content"],
    ["append", "markdownFragment"],
  ] as const)(
    "reads a %s body field once, so a getter cannot swap in an unvalidated body",
    async (method, field) => {
      const daemon = fakeDaemon(protocol2());
      const valid = "a".repeat(INLINE_CONTENT_BYTES + 1);
      // Every later read returns something no validation would pass.
      const hostile = "\u0000".repeat(WIRE_BODY_BYTES + 1);
      let reads = 0;
      const params: Record<string, unknown> =
        method === "create" ? { title: "Getter" } : { id: "note-1", expectedRevision: REV };
      Object.defineProperty(params, field, {
        enumerable: true,
        get: () => {
          reads += 1;
          return reads === 1 ? valid : hostile;
        },
      });
      const c = client(daemon.connect);
      const result =
        method === "create"
          ? await c.createNote(params as never)
          : await c.appendNote(params as never);
      expect(result.ok).toBe(true);
      expect(reads).toBe(1);
      const connection = daemon.connections[1] as FakeConnection;
      const written = connection.writes[1] as Buffer;
      expect(written.toString("utf8")).toBe(valid);
      expect(connection.request.body).toEqual({
        field,
        bytes: valid.length,
        sha256: sha256(Buffer.from(valid)),
      });
    },
  );
});

describe("deadline over the whole exchange", () => {
  it("times out when the daemon accepts the header and stalls, and never writes the body", async () => {
    vi.useFakeTimers();
    let headerSeen = false;
    const daemon = fakeDaemon(
      protocol2({
        holdContinue: () => {
          headerSeen = true;
        },
      }),
    );
    let settled = false;
    const pending = client(daemon.connect, 1_000).createNote({
      title: "Large",
      content: "a".repeat(INLINE_CONTENT_BYTES + 1),
    });
    pending
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(999);
    expect(headerSeen).toBe(true);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: false, code: "service_unavailable" });
    const connection = daemon.connections[1] as FakeConnection;
    expect(connection.writes).toHaveLength(1);
    expect(connection.destroyed).toBe(true);
  });

  it("counts the wait for continue and the wait for the reply against one deadline", async () => {
    vi.useFakeTimers();
    const daemon = fakeDaemon((connection, bytes, index) => {
      if (index === 1) {
        // The reply would land at 1,200 ms: inside a fresh per-phase
        // deadline, outside the whole-exchange one.
        const request = connection.request;
        globalThis.setTimeout(
          () => connection.reply(ok(request.id, resultFor(request, bytes.length))),
          600,
        );
        return;
      }
      const request = parseFrame(bytes);
      if (request.method === "notes.capabilities") {
        connection.reply(ok(request.id, { kind: "capabilities", protocol: 2 }));
        return;
      }
      globalThis.setTimeout(
        () =>
          connection.reply(
            ok(request.id, { kind: "body_continue", bytes: request.body?.bytes ?? 0 }),
          ),
        600,
      );
    });
    const pending = client(daemon.connect, 1_000).createNote({
      title: "Large",
      content: "a".repeat(INLINE_CONTENT_BYTES + 1),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({ ok: false, code: "service_unavailable" });
    expect(daemon.connections[1]?.writes).toHaveLength(2);
  });

  /** Reports whether the call has returned yet, so a test can watch the clock. */
  function track<T>(pending: Promise<T>): { readonly settled: () => boolean } {
    let done = false;
    pending
      .finally(() => {
        done = true;
      })
      .catch(() => undefined);
    return { settled: () => done };
  }

  it("fails within the configured deadline when the probe stalls, not a multiple of it", async () => {
    vi.useFakeTimers();
    // Neither probe is ever answered: separately timed, each would take the whole deadline.
    const daemon = fakeDaemon(() => undefined);
    const pending = client(daemon.connect, 1_000).createNote({
      title: "Large",
      content: "a".repeat(INLINE_CONTENT_BYTES + 1),
    });
    const watch = track(pending);
    await vi.advanceTimersByTimeAsync(999);
    expect(watch.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(watch.settled()).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, code: "service_unavailable" });
    // The expired deadline also stops the fallback probe from connecting.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(methodsOf(daemon.connections)).toEqual(["notes.capabilities"]);
    expect(daemon.connections[0]?.destroyed).toBe(true);
  });

  it("gives the body exchange only what the probe left of the deadline", async () => {
    vi.useFakeTimers();
    const daemon = fakeDaemon((connection, bytes) => {
      const request = parseFrame(bytes);
      // The probe answers at 600 ms and the continue 600 ms after the header:
      // inside a fresh deadline per phase, outside one for the whole request.
      const answer =
        request.method === "notes.capabilities"
          ? ok(request.id, { kind: "capabilities", protocol: 2 })
          : ok(request.id, { kind: "body_continue", bytes: request.body?.bytes ?? 0 });
      globalThis.setTimeout(() => connection.reply(answer), 600);
    });
    const pending = client(daemon.connect, 1_000).createNote({
      title: "Large",
      content: "a".repeat(INLINE_CONTENT_BYTES + 1),
    });
    const watch = track(pending);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watch.settled()).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, code: "service_unavailable" });
    expect(methodsOf(daemon.connections)).toEqual(["notes.capabilities", "notes.create"]);
    // The continue never arrived in time, so no body byte was written.
    expect(daemon.connections[1]?.writes).toHaveLength(1);
  });

  it("bounds a call waiting on a probe another call started", async () => {
    vi.useFakeTimers();
    const daemon = fakeDaemon(() => undefined);
    const c = client(daemon.connect, 1_000);
    const large = { title: "Large", content: "a".repeat(INLINE_CONTENT_BYTES + 1) };
    const first = c.createNote(large);
    await vi.advanceTimersByTimeAsync(500);
    const second = c.createNote(large);
    const watch = track(second);
    // The second call shares the first call's probe rather than starting its own.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(watch.settled()).toBe(true);
    await expect(first).resolves.toEqual({ ok: false, code: "service_unavailable" });
    await expect(second).resolves.toEqual({ ok: false, code: "service_unavailable" });
    expect(methodsOf(daemon.connections)).toEqual(["notes.capabilities"]);
  });
});

describe("against the real daemon", () => {
  const handles: NookdServerHandle[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function daemon() {
    const directory = await mkdtemp(path.join("/tmp", "nbk-client-"));
    directories.push(directory);
    const socketPath = path.join(directory, "nookd.sock");
    const createNote = vi.fn(async (command: { title: string; content: string }) => ({
      operation: "create" as const,
      id: "note-1",
      titleBytes: Buffer.byteLength(command.title),
      contentBytes: Buffer.byteLength(command.content),
      localCommitted: true as const,
      remoteSynced: false as const,
      pendingSync: true as const,
    }));
    const handle = await startNookdServer({
      socketPath,
      runtime: Object.freeze({
        search: async () => [],
        createNote,
        cleanup: async () => undefined,
      }) as unknown as NookdServerRuntime,
      policy: createReadWriteNoDeleteServicePolicy(),
      installSignalHandlers: false,
      resolvePeer: async () => ({
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        groups: ["test"],
      }),
      abuseBounds: { ...DEFAULT_SERVICE_ABUSE_BOUNDS, perProcessBurstSize: 100 },
    });
    handles.push(handle);
    return { socketPath, createNote };
  }

  it("negotiates protocol 2 and creates a note whose body does not fit one frame", async () => {
    const { socketPath, createNote } = await daemon();
    const c = new NookdSocketClient({ socketPath });
    await expect(c.capabilities()).resolves.toMatchObject({
      ok: true,
      envelope: { result: { kind: "capabilities", protocol: 2 } },
    });
    const content = "Ünïcødé 😀 line\n".repeat(6_000);
    const bytes = Buffer.byteLength(content);
    expect(bytes).toBeGreaterThan(RPC_FRAME_BYTES);
    const result = await c.createNote({ title: "Large", content });
    expect(result).toMatchObject({
      ok: true,
      envelope: { result: { kind: "create", id: "note-1", contentBytes: bytes } },
    });
    expect(createNote).toHaveBeenCalledTimes(1);
    expect(createNote.mock.calls[0]?.[0].content).toBe(content);
  });

  it("serves a small create in one frame", async () => {
    const { socketPath, createNote } = await daemon();
    const result = await new NookdSocketClient({ socketPath }).createNote({
      title: "Small",
      content: "hello",
    });
    expect(result.ok).toBe(true);
    expect(createNote.mock.calls[0]?.[0].content).toBe("hello");
  });
});
