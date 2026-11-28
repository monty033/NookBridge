/**
 * Issue #327, the return trip, client side: the MCP socket client offers
 * `accept` on a note read only to a daemon known to speak protocol 2, reads
 * the declared body after the header, and verifies its length, SHA-256 and
 * UTF-8 before returning the Markdown exactly as a single-frame read does.
 *
 * The fakes answer at the byte level through the client's `connect` seam, so
 * a test can send a header with a body that is short, long, misdigested or
 * not UTF-8. The real daemon is driven in `nookd-response-body.test.ts`.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { WIRE_BODY_BYTES } from "../src/core/size-limits.js";
import { NookdSocketClient, type SocketConnect } from "../src/mcp/socket-client.js";

const SOCKET_PATH = "/tmp/nookbridge-327-response-client.sock";
const REV = "rev_0123456789abcdef0123456789abcdef";
const NOTE = { id: "note-1", title: "Big", revision: REV };

type Envelope = {
  id: string;
  method: string;
  params: Record<string, unknown>;
  accept?: { bodyBytes: number };
};

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

/** One accepted connection: records the request and lets the test answer in raw bytes. */
class FakeConnection extends EventEmitter {
  readonly writes: Buffer[] = [];
  destroyed = false;

  constructor(private readonly onRequest: (connection: FakeConnection, request: Envelope) => void) {
    super();
  }

  get request(): Envelope {
    return parseFrame(this.writes[0] as Buffer);
  }

  write(bytes: Uint8Array, callback: (error?: Error | null) => void): boolean {
    const copy = Buffer.from(bytes);
    this.writes.push(copy);
    callback();
    this.onRequest(this, parseFrame(copy));
    return true;
  }

  /** Emit each chunk on its own turn, as a socket delivers reads. */
  send(...chunks: Buffer[]): void {
    let index = 0;
    const next = (): void => {
      if (this.destroyed || index >= chunks.length) return;
      this.emit("data", chunks[index]);
      index += 1;
      globalThis.setImmediate(next);
    };
    globalThis.setImmediate(next);
  }

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

type Answer = (connection: FakeConnection, request: Envelope) => void;

function fakeDaemon(answer: Answer): { connect: SocketConnect; connections: FakeConnection[] } {
  const connections: FakeConnection[] = [];
  return {
    connections,
    connect: async () => {
      const connection = new FakeConnection(answer);
      connections.push(connection);
      return connection as unknown as Socket;
    },
  };
}

function client(connect: SocketConnect): NookdSocketClient {
  return new NookdSocketClient({ socketPath: SOCKET_PATH, connect });
}

const ok = (id: string, result: unknown) => ({ id, ok: true, result });
const STATUS = { kind: "status", lastSynced: 0, hasUnsyncedChanges: false };
const OVERSIZE = { kind: "note", note: NOTE, contentStatus: "oversize" };

/** A header declaring `markdown` as `body.length` bytes, digest of `digestOf`. */
function bodyHeader(
  id: string,
  body: Buffer,
  overrides: { bytes?: number; markdownBytes?: number; digestOf?: Buffer } = {},
): Buffer {
  return frame({
    id,
    ok: true,
    result: {
      kind: "note",
      note: NOTE,
      contentStatus: "ok",
      markdownBytes: overrides.markdownBytes ?? body.length,
    },
    body: {
      field: "markdown",
      bytes: overrides.bytes ?? body.length,
      sha256: sha256(overrides.digestOf ?? body),
    },
  });
}

/**
 * A protocol-2 daemon whose content is too large for one frame: a read
 * without `accept` is `oversize`, a read with it is answered by `onAccepted`.
 */
function protocol2(onAccepted: Answer): Answer {
  return (connection, request) => {
    if (request.method === "notes.capabilities") {
      connection.send(frame(ok(request.id, { kind: "capabilities", protocol: 2 })));
    } else if (request.method === "notes.get" && request.accept !== undefined) {
      onAccepted(connection, request);
    } else if (request.method === "notes.get") {
      connection.send(frame(ok(request.id, OVERSIZE)));
    } else {
      connection.send(frame(ok(request.id, STATUS)));
    }
  };
}

/** A protocol-1 daemon: it closes on a method or a field it does not know. */
const protocol1: Answer = (connection, request) => {
  if (request.method === "notes.capabilities" || "accept" in request) {
    connection.hangUp();
  } else if (request.method === "notes.get") {
    connection.send(frame(ok(request.id, OVERSIZE)));
  } else {
    connection.send(frame(ok(request.id, STATUS)));
  }
};

const MARKDOWN = `---\nnookbridge-format: 1\n---\n\n${"Grüße 漢字 😀 ".repeat(6_000)}end\n`;
const MARKDOWN_BYTES = Buffer.from(MARKDOWN, "utf8");

const sendsBody: Answer = (connection, request) => {
  connection.send(bodyHeader(request.id, MARKDOWN_BYTES), MARKDOWN_BYTES);
};

function hasAccept(connection: FakeConnection): boolean {
  return connection.writes.some((bytes) => "accept" in parseFrame(bytes));
}

describe("client fallback", () => {
  it("sends a read to a fresh client's daemon as one frame with no probe and no accept", async () => {
    const daemon = fakeDaemon((connection, request) =>
      connection.send(
        frame(
          ok(request.id, { ...OVERSIZE, contentStatus: "ok", markdown: "hi", markdownBytes: 2 }),
        ),
      ),
    );
    const result = await client(daemon.connect).getNote("note-1");
    expect(result).toMatchObject({ ok: true, envelope: { result: { markdown: "hi" } } });
    expect(daemon.connections).toHaveLength(1);
    const written = (daemon.connections[0] as FakeConnection).writes;
    expect(written).toHaveLength(1);
    expect(Object.keys(parseFrame(written[0] as Buffer))).toEqual(["id", "method", "params"]);
  });

  it("never sends accept to a protocol-1 daemon, and a large read still returns oversize", async () => {
    const daemon = fakeDaemon(protocol1);
    const c = client(daemon.connect);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await c.getNote("note-1");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Exactly the result a pre-change client returned for this reply.
      expect(result.envelope.result).toEqual(OVERSIZE);
    }
    expect(daemon.connections.map((connection) => connection.request.method)).toEqual([
      "notes.get",
      "notes.capabilities",
      "notes.status",
      "notes.get",
      "notes.capabilities",
      "notes.status",
    ]);
    expect(daemon.connections.some(hasAccept)).toBe(false);
  });

  it("returns the oversize already received when the probe fails outright", async () => {
    const daemon = fakeDaemon((connection, request) => {
      if (request.method === "notes.get") connection.send(frame(ok(request.id, OVERSIZE)));
      else connection.hangUp();
    });
    const result = await client(daemon.connect).getNote("note-1");
    expect(result).toMatchObject({ ok: true, envelope: { result: OVERSIZE } });
    expect(daemon.connections.some(hasAccept)).toBe(false);
  });

  it("never offers accept on a request that does not read note content", async () => {
    const daemon = fakeDaemon(protocol2(sendsBody));
    const c = client(daemon.connect);
    await c.getNote("note-1");
    const before = daemon.connections.length;
    await c.status();
    await c.search({ query: "q" });
    await c.listNotebooks();
    await c.lockedNoteProof({ path: "A/B" });
    await c.pathDiagnostic({ path: "A/B" });
    await c.deleteNote({ path: "A/B" });
    await c.createNote({ title: "t", content: "c" });
    const later = daemon.connections.slice(before);
    expect(later).toHaveLength(7);
    expect(later.some(hasAccept)).toBe(false);
  });
});

describe("reading a declared body", () => {
  it("probes after an oversize read and repeats it with accept at the wire bound", async () => {
    const daemon = fakeDaemon(protocol2(sendsBody));
    const result = await client(daemon.connect).getNote("note-1");
    expect(daemon.connections.map((connection) => connection.request.method)).toEqual([
      "notes.get",
      "notes.capabilities",
      "notes.get",
    ]);
    const accepted = (daemon.connections[2] as FakeConnection).request;
    expect(accepted.accept).toEqual({ bodyBytes: WIRE_BODY_BYTES });
    expect(accepted.params).toEqual({ id: "note-1" });
    expect(result).toEqual({
      ok: true,
      envelope: {
        id: accepted.id,
        ok: true,
        result: {
          kind: "note",
          note: NOTE,
          contentStatus: "ok",
          markdown: MARKDOWN,
          markdownBytes: MARKDOWN_BYTES.length,
        },
      },
    });
  });

  it("offers accept on the first and only connection once protocol 2 is kept", async () => {
    const daemon = fakeDaemon(protocol2(sendsBody));
    const c = client(daemon.connect);
    await c.getNote("note-1");
    const before = daemon.connections.length;
    const result = await c.getNote({ path: "Inbox/Big" });
    const later = daemon.connections.slice(before);
    expect(later).toHaveLength(1);
    expect(later[0]?.request).toMatchObject({
      method: "notes.get",
      params: { path: "Inbox/Big" },
      accept: { bodyBytes: WIRE_BODY_BYTES },
    });
    expect(
      result.ok && result.envelope.result.kind === "note" && result.envelope.result.markdown,
    ).toBe(MARKDOWN);
  });

  it("reassembles a body split anywhere, including inside a multi-byte character", async () => {
    const splitAt = MARKDOWN_BYTES.indexOf(Buffer.from("😀")) + 1;
    for (const chunks of [
      (header: Buffer) => [Buffer.concat([header, MARKDOWN_BYTES])],
      (header: Buffer) => [header.subarray(0, 3), header.subarray(3), MARKDOWN_BYTES],
      (header: Buffer) => [
        Buffer.concat([header, MARKDOWN_BYTES.subarray(0, splitAt)]),
        MARKDOWN_BYTES.subarray(splitAt),
      ],
    ]) {
      const daemon = fakeDaemon(
        protocol2((connection, request) =>
          connection.send(...chunks(bodyHeader(request.id, MARKDOWN_BYTES))),
        ),
      );
      const result = await client(daemon.connect).getNote("note-1");
      expect(
        result.ok && result.envelope.result.kind === "note" && result.envelope.result.markdown,
      ).toBe(MARKDOWN);
    }
  });

  it("accepts a single-frame reply to an accepted read unchanged", async () => {
    const locked = { kind: "note", note: { ...NOTE, locked: true }, contentStatus: "locked" };
    const daemon = fakeDaemon(
      protocol2((connection, request) => connection.send(frame(ok(request.id, locked)))),
    );
    const result = await client(daemon.connect).getNote("note-1");
    expect(result).toMatchObject({ ok: true, envelope: { result: locked } });
  });
});

describe("a body that does not verify fails categorically", () => {
  const invalidUtf8 = Buffer.concat([MARKDOWN_BYTES.subarray(0, 1_000), Buffer.from([0xff, 0xfe])]);
  const CASES: ReadonlyArray<readonly [string, Answer]> = [
    [
      "a wrong digest",
      (connection, request) =>
        connection.send(
          bodyHeader(request.id, MARKDOWN_BYTES, { digestOf: Buffer.from("other") }),
          MARKDOWN_BYTES,
        ),
    ],
    [
      "fewer bytes than declared, then a close",
      (connection, request) => {
        connection.send(
          bodyHeader(request.id, MARKDOWN_BYTES),
          MARKDOWN_BYTES.subarray(0, MARKDOWN_BYTES.length - 1),
        );
        globalThis.setTimeout(() => connection.emit("close"), 20);
      },
    ],
    [
      // The count says one byte fewer than the daemon digested and sends. The
      // extra byte arrives in a chunk read while the body is still incomplete,
      // so the overflow check refuses it before any digest is computed. (Were
      // the count's last byte to end a chunk exactly, the prefix would fail
      // the digest instead; either way the read fails.)
      "a byte count one short of the body sent",
      (connection, request) =>
        connection.send(
          bodyHeader(request.id, MARKDOWN_BYTES, {
            bytes: MARKDOWN_BYTES.length - 1,
            markdownBytes: MARKDOWN_BYTES.length - 1,
          }),
          MARKDOWN_BYTES,
        ),
    ],
    [
      "more bytes than declared, coalesced with the header",
      (connection, request) =>
        connection.send(
          Buffer.concat([bodyHeader(request.id, MARKDOWN_BYTES), MARKDOWN_BYTES, Buffer.from("x")]),
        ),
    ],
    [
      "bytes that are not UTF-8, with a matching digest",
      (connection, request) => connection.send(bodyHeader(request.id, invalidUtf8), invalidUtf8),
    ],
    [
      "a declaration that disagrees with markdownBytes",
      (connection, request) =>
        connection.send(
          bodyHeader(request.id, MARKDOWN_BYTES, { markdownBytes: MARKDOWN_BYTES.length - 1 }),
          MARKDOWN_BYTES,
        ),
    ],
    [
      "a declaration over the wire bound",
      (connection, request) => {
        const huge = Buffer.alloc(WIRE_BODY_BYTES + 1, 0x61);
        connection.send(bodyHeader(request.id, huge), huge);
      },
    ],
    [
      "a body declared on a result that is not ok",
      (connection, request) =>
        connection.send(
          frame({
            id: request.id,
            ok: true,
            result: OVERSIZE,
            body: { field: "markdown", bytes: 1, sha256: sha256(Buffer.from("a")) },
          }),
          Buffer.from("a"),
        ),
    ],
    [
      "inline markdown alongside a declared body",
      (connection, request) =>
        connection.send(
          frame({
            id: request.id,
            ok: true,
            result: {
              kind: "note",
              note: NOTE,
              contentStatus: "ok",
              markdown: "a",
              markdownBytes: 1,
            },
            body: { field: "markdown", bytes: 1, sha256: sha256(Buffer.from("a")) },
          }),
          Buffer.from("a"),
        ),
    ],
  ];

  it.each(CASES)("refuses %s with service_unavailable and no content", async (_name, answer) => {
    const daemon = fakeDaemon(protocol2(answer));
    const result = await client(daemon.connect).getNote("note-1");
    // An error, never a successful result carrying a shorter string.
    expect(result).toEqual({ ok: false, code: "service_unavailable" });
  });

  it("refuses a daemon that closes part-way through the body, never returning the part", async () => {
    const half = MARKDOWN_BYTES.subarray(0, MARKDOWN_BYTES.length >> 1);
    const daemon = fakeDaemon(
      protocol2((connection, request) => {
        connection.send(bodyHeader(request.id, MARKDOWN_BYTES), half);
        globalThis.setTimeout(() => connection.emit("close"), 20);
      }),
    );
    const result = await client(daemon.connect).getNote("note-1");
    expect(result).toEqual({ ok: false, code: "service_unavailable" });
  });
});
