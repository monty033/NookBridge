/**
 * Issue #327, the return trip: a `notes.get` whose Markdown does not fit one
 * frame comes back as a declared response body, and only for a request that
 * carried `accept`.
 *
 * Everything here runs against the real daemon over a real socket. The one
 * seam is the strict Markdown serializer, mocked to delegate to the real one
 * unless a test sets an exact output: no stored note can project to more than
 * `WIRE_BODY_BYTES` (the HTML input is bounded at half of it, and escaping at
 * most doubles it), so the wire bound itself can only be reached that way.
 * The bound check, header, body and client all stay real.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROJECTION_MARKDOWN_BYTES, WIRE_BODY_BYTES } from "../src/core/size-limits.js";
import { createLogger } from "../src/logging/logger.js";
import { NookdSocketClient } from "../src/mcp/socket-client.js";
import type * as NoteDocumentMarkdown from "../src/core/note-document-markdown.js";
import { createLargeBodyBudget, type LargeBodyBudget } from "../src/service/large-body-budget.js";
import { classifyNoteContentProjection } from "../src/service/note-content-projection.js";
import {
  createRpcFrameParser,
  isRpcProtocolError,
  parseRpcFrame,
} from "../src/service/rpc-protocol.js";
import type { ServiceAuditRecord } from "../src/service/service-audit.js";
import {
  NOTE_HTML,
  REVISION,
  getFrame,
  noteId,
  startResponseBodyDaemon,
  type ResponseBodyDaemon,
} from "./helpers/response-body-fixture.js";

const serializerOverride = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("../src/core/note-document-markdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof NoteDocumentMarkdown>();
  return {
    ...actual,
    serializeNoteDocumentMarkdown: (
      ...args: Parameters<typeof actual.serializeNoteDocumentMarkdown>
    ) => serializerOverride.value ?? actual.serializeNoteDocumentMarkdown(...args),
  };
});

const daemons: ResponseBodyDaemon[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  serializerOverride.value = undefined;
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
});

async function daemon(
  options: Parameters<typeof startResponseBodyDaemon>[0] = {},
): Promise<ResponseBodyDaemon> {
  const started = await startResponseBodyDaemon(options);
  daemons.push(started);
  return started;
}

async function connect(socketPath: string): Promise<net.Socket> {
  const socket = net.createConnection(socketPath);
  sockets.push(socket);
  socket.on("error", () => undefined);
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  return socket;
}

/**
 * Write one frame and collect every byte the daemon sends until it has been
 * quiet for `quietMs` after a complete header (or closes). Reports whether the
 * connection closed, so a test can tell "nothing more was sent" from "closed".
 */
async function exchange(
  socketPath: string,
  frame: Buffer,
  quietMs = 100,
): Promise<{ readonly bytes: Buffer; readonly closed: boolean }> {
  const socket = await connect(socketPath);
  const chunks: Buffer[] = [];
  let closed = false;
  let lastData = Date.now();
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    lastData = Date.now();
  });
  socket.once("close", () => {
    closed = true;
  });
  socket.write(frame);
  for (;;) {
    await delay(10);
    if (closed) break;
    const received = Buffer.concat(chunks);
    if (received.length >= 4 && Date.now() - lastData >= quietMs) break;
  }
  return { bytes: Buffer.concat(chunks), closed };
}

function splitHeader(bytes: Buffer): { readonly header: Record<string, unknown>; rest: Buffer } {
  const length = bytes.readUInt32BE(0);
  const header = JSON.parse(bytes.subarray(4, 4 + length).toString("utf8")) as Record<
    string,
    unknown
  >;
  return { header, rest: bytes.subarray(4 + length) };
}

/** Service-audit records, captured the way the daemon's logger emits them. */
function auditCapture(): {
  readonly records: ServiceAuditRecord[];
  readonly auditLogger: ReturnType<typeof createLogger>;
} {
  const records: ServiceAuditRecord[] = [];
  const auditLogger = createLogger({
    sink: (line) => {
      const record = JSON.parse(line) as ServiceAuditRecord & { component?: string };
      if (record.component === "service_audit") records.push(record);
    },
  });
  return { records, auditLogger };
}

/** True when the budget's one slot is held: a probe is refused busy. */
function slotHeld(budget: LargeBodyBudget): boolean {
  const probe = budget.tryAcquire(1);
  if (probe.kind === "busy") return true;
  probe.release();
  return false;
}

/** Wait, within `withinMs`, for the slot to come free; fails if it never does. */
async function expectSlotReleased(budget: LargeBodyBudget, withinMs = 2_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (slotHeld(budget)) {
    if (Date.now() > deadline) throw new Error("the response-body lease was never released");
    await delay(10);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The Markdown a read of `name` projects to, computed without any transport. */
function projectionOf(name: string): string {
  const classification = classifyNoteContentProjection({
    contentRefusal: undefined,
    envelope: { type: "html", data: NOTE_HTML[name] },
    noteId: noteId(name),
    note: { id: noteId(name), title: `Title ${name}`, revision: REVISION },
    requestId: "projection",
    bodyMarkdownBytes: WIRE_BODY_BYTES,
  });
  if (classification.markdown === undefined) throw new Error("fixture note does not project");
  return classification.markdown;
}

describe("compatibility: a read without accept", () => {
  /*
   * Recorded from the pre-change daemon (f5e1b39, the tree this branch starts
   * from): `git archive f5e1b39` extracted to a scratch directory with this
   * repository's node_modules, `tests/helpers/response-body-fixture.ts` copied
   * in unchanged, and each frame below sent to that daemon over a real socket.
   * The helper uses only APIs that existed there. The whole response frame —
   * length prefix, header and result — is compared, by SHA-256 and verbatim.
   * The same run showed that daemon closes, unanswered, a frame carrying
   * `accept`.
   */
  const RECORDED: ReadonlyArray<{ name: string; bytes: number; sha256: string; json: string }> = [
    {
      name: "small",
      bytes: 271,
      sha256: "5aa68911097636fe3c75252e61c534cfac5c349ca516a7024eacf5cc6f72aee8",
      json: '{"id":"compat-small","ok":true,"result":{"kind":"note","note":{"id":"note-small","title":"Title small","revision":"rev_0123456789abcdef0123456789abcdef"},"contentStatus":"ok","markdown":"---\\nnookbridge-format: 1\\n---\\n\\nHello ünïcødé 😀\\n","markdownBytes":53}}',
    },
    {
      name: "large",
      bytes: 186,
      sha256: "2b33b197abeb0709e1ed503f2f56570622bae0c691b454e38e0aef7605988b17",
      json: '{"id":"compat-large","ok":true,"result":{"kind":"note","note":{"id":"note-large","title":"Title large","revision":"rev_0123456789abcdef0123456789abcdef"},"contentStatus":"oversize"}}',
    },
    {
      name: "multibyte",
      bytes: 198,
      sha256: "3fe0876a20c73121dba6c62b51e56da0eed01615c414faa0395f55c78cdfd538",
      json: '{"id":"compat-multibyte","ok":true,"result":{"kind":"note","note":{"id":"note-multibyte","title":"Title multibyte","revision":"rev_0123456789abcdef0123456789abcdef"},"contentStatus":"oversize"}}',
    },
    {
      name: "oversize",
      bytes: 195,
      sha256: "892b28bf30dcea3df8eb1c03b3abc44b9a0d4963839fb72238faf5d7737592ce",
      json: '{"id":"compat-oversize","ok":true,"result":{"kind":"note","note":{"id":"note-oversize","title":"Title oversize","revision":"rev_0123456789abcdef0123456789abcdef"},"contentStatus":"oversize"}}',
    },
    {
      name: "empty",
      bytes: 212,
      sha256: "dd558f7afa598c1bc4ff3f8a53260e68fa0af74b590243f1afe323abe9139e73",
      json: '{"id":"compat-empty","ok":true,"result":{"kind":"note","note":{"id":"note-empty","title":"Title empty","revision":"rev_0123456789abcdef0123456789abcdef"},"contentStatus":"ok","markdown":"","markdownBytes":0}}',
    },
    {
      name: "locked",
      bytes: 201,
      sha256: "3dbf116149a47edf9e3618ca5cf4d0992ce9f40e9d692172148a0a0e07736895",
      json: '{"id":"compat-locked","ok":true,"result":{"kind":"note","note":{"id":"note-locked","title":"Title locked","revision":"rev_0123456789abcdef0123456789abcdef","locked":true},"contentStatus":"locked"}}',
    },
    {
      name: "unreadable",
      bytes: 234,
      sha256: "b4d670d44695fec39b7e3fa6113a502ccc63efea0bbbf435c0190fd7f3a3ce78",
      json: '{"id":"compat-unreadable","ok":true,"result":{"kind":"note","note":{"id":"note-unreadable","title":"Title unreadable","revision":"rev_0123456789abcdef0123456789abcdef"},"contentStatus":"unavailable","contentReason":"read_failed"}}',
    },
    {
      name: "missing",
      bytes: 89,
      sha256: "438d0e2036a7b48fb0600f1dcc9b3a9aca5dff1ef055fbdb24a59df4dae11695",
      json: '{"id":"compat-missing","ok":false,"error":{"code":"not_found","message":"Not found"}}',
    },
  ];

  it("returns the pre-change response bytes, including oversize above the single-frame bound", async () => {
    // The fixture's two over-bound notes really are over it, so `oversize`
    // here is the single-frame bound at work, not a note that was too small.
    expect(Buffer.byteLength(projectionOf("large"))).toBeGreaterThan(PROJECTION_MARKDOWN_BYTES);
    expect(Buffer.byteLength(projectionOf("oversize"))).toBeGreaterThan(PROJECTION_MARKDOWN_BYTES);
    const { socketPath } = await daemon();
    for (const recorded of RECORDED) {
      const { bytes, closed } = await exchange(
        socketPath,
        getFrame(`compat-${recorded.name}`, noteId(recorded.name)),
      );
      expect(closed, recorded.name).toBe(false);
      expect(bytes.length, recorded.name).toBe(recorded.bytes);
      expect(sha256(bytes), recorded.name).toBe(recorded.sha256);
      expect(bytes.subarray(4).toString("utf8"), recorded.name).toBe(recorded.json);
    }
  });
});

describe("codec: accept is a protocol-2 note-read field only", () => {
  const frameOf = (value: unknown): Buffer => {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    const out = Buffer.alloc(4 + payload.length);
    out.writeUInt32BE(payload.length, 0);
    payload.copy(out, 4);
    return out;
  };
  const parseBody = createRpcFrameParser({ allowBody: true });
  const parseSingleFrame = createRpcFrameParser();
  const refuses = (parse: (input: Uint8Array) => unknown, value: unknown): boolean => {
    try {
      parse(frameOf(value));
      return false;
    } catch (error) {
      return isRpcProtocolError(error);
    }
  };

  it("parses accept on notes.get for the protocol-2 parser", () => {
    const request = parseBody(getFrame("a", "note-1", WIRE_BODY_BYTES));
    expect(request).toMatchObject({
      id: "a",
      method: "notes.get",
      params: { id: "note-1" },
      accept: { bodyBytes: WIRE_BODY_BYTES },
    });
    expect(Object.isFrozen((request as { accept: object }).accept)).toBe(true);
    // An offer larger than the wire bound is a larger offer, not a refusal.
    expect(parseBody(getFrame("b", "note-1", 2 * WIRE_BODY_BYTES))).toHaveProperty(
      "accept.bodyBytes",
      2 * WIRE_BODY_BYTES,
    );
  });

  it("refuses accept on the legacy and single-frame-only parsers", () => {
    const value = {
      id: "a",
      method: "notes.get",
      params: { id: "note-1" },
      accept: { bodyBytes: 1 },
    };
    expect(refuses(parseRpcFrame, value)).toBe(true);
    expect(refuses(parseSingleFrame, value)).toBe(true);
    expect(refuses(parseBody, value)).toBe(false);
  });

  it("refuses accept on any method that does not read note content", () => {
    for (const [method, params] of [
      ["notes.search", { query: "q" }],
      ["notes.status", {}],
      ["notes.locked_note_proof", { path: "A/B" }],
      ["notes.create", { title: "t", content: "c" }],
    ] as const) {
      expect(
        refuses(parseBody, { id: "a", method, params, accept: { bodyBytes: 1 } }),
        method,
      ).toBe(true);
    }
  });

  it("refuses a malformed offer, and an offer alongside a body", () => {
    for (const accept of [
      {},
      { bodyBytes: 0 },
      { bodyBytes: -1 },
      { bodyBytes: 1.5 },
      { bodyBytes: "1" },
      { bodyBytes: Number.MAX_SAFE_INTEGER + 1 },
      { bodyBytes: 1, extra: true },
      null,
      [1],
      1,
    ]) {
      expect(
        refuses(parseBody, { id: "a", method: "notes.get", params: { id: "n" }, accept }),
        JSON.stringify(accept),
      ).toBe(true);
    }
    expect(
      refuses(parseBody, {
        id: "a",
        method: "notes.get",
        params: { id: "n" },
        accept: { bodyBytes: 1 },
        body: { field: "markdown", bytes: 1, sha256: "0".repeat(64) },
      }),
    ).toBe(true);
  });
});

describe("bound selection with accept", () => {
  it("delivers a projection between the single-frame and wire bounds as a declared body", async () => {
    const expected = Buffer.from(projectionOf("large"), "utf8");
    expect(expected.length).toBeGreaterThan(PROJECTION_MARKDOWN_BYTES);
    expect(expected.length).toBeLessThan(WIRE_BODY_BYTES);
    const { socketPath } = await daemon();
    const { bytes, closed } = await exchange(
      socketPath,
      getFrame("large", noteId("large"), WIRE_BODY_BYTES),
    );
    expect(closed).toBe(false);
    const { header, rest } = splitHeader(bytes);
    expect(header).toEqual({
      id: "large",
      ok: true,
      result: {
        kind: "note",
        note: { id: noteId("large"), title: "Title large", revision: REVISION },
        contentStatus: "ok",
        markdownBytes: expected.length,
      },
      body: { field: "markdown", bytes: expected.length, sha256: sha256(expected) },
    });
    // Exactly the declared bytes follow the header, and nothing after them.
    expect(rest.equals(expected)).toBe(true);
  });

  it("delivers a projection of exactly WIRE_BODY_BYTES and refuses one byte more single-frame", async () => {
    const { socketPath } = await daemon();
    serializerOverride.value = "z".repeat(WIRE_BODY_BYTES);
    const atBound = await exchange(socketPath, getFrame("at", noteId("small"), WIRE_BODY_BYTES));
    const at = splitHeader(atBound.bytes);
    expect(at.header).toMatchObject({
      result: { contentStatus: "ok", markdownBytes: WIRE_BODY_BYTES },
      body: { field: "markdown", bytes: WIRE_BODY_BYTES },
    });
    expect(at.rest.length).toBe(WIRE_BODY_BYTES);

    serializerOverride.value = "z".repeat(WIRE_BODY_BYTES + 1);
    // An offer above the wire bound does not raise it: the bound is the smaller.
    for (const offer of [WIRE_BODY_BYTES, WIRE_BODY_BYTES + 1, 4 * WIRE_BODY_BYTES]) {
      const over = await exchange(socketPath, getFrame("over", noteId("small"), offer));
      expect(over.closed, String(offer)).toBe(false);
      const { header, rest } = splitHeader(over.bytes);
      expect(header, String(offer)).toEqual({
        id: "over",
        ok: true,
        result: {
          kind: "note",
          note: { id: noteId("small"), title: "Title small", revision: REVISION },
          contentStatus: "oversize",
        },
      });
      // No body, no partial body: the header is the whole response.
      expect(rest.length, String(offer)).toBe(0);
    }
  });

  it("bounds by the offer when it is below the wire bound", async () => {
    const markdownBytes = Buffer.byteLength(projectionOf("large"));
    const { socketPath } = await daemon();
    const fits = await exchange(socketPath, getFrame("fits", noteId("large"), markdownBytes));
    expect(splitHeader(fits.bytes).rest.length).toBe(markdownBytes);
    const short = await exchange(socketPath, getFrame("short", noteId("large"), markdownBytes - 1));
    const { header, rest } = splitHeader(short.bytes);
    expect(header).toMatchObject({ result: { contentStatus: "oversize" } });
    expect(header).not.toHaveProperty("body");
    expect(rest.length).toBe(0);
  });

  it("bounds multibyte Markdown by its UTF-8 bytes, not its UTF-16 code units", async () => {
    // Four bytes and two code units per character: measured in code units,
    // the over-bound projection below would be half the bound, and delivered.
    const unit = "\u{1F600}";
    expect(Buffer.byteLength(unit)).toBe(4);
    expect(unit.length).toBe(2);
    expect(WIRE_BODY_BYTES % 4).toBe(0);
    const { socketPath } = await daemon();

    const atBound = unit.repeat(WIRE_BODY_BYTES / 4);
    serializerOverride.value = atBound;
    const at = splitHeader(
      (await exchange(socketPath, getFrame("at", noteId("small"), WIRE_BODY_BYTES))).bytes,
    );
    expect(at.header).toMatchObject({
      result: { contentStatus: "ok", markdownBytes: WIRE_BODY_BYTES },
      body: { field: "markdown", bytes: WIRE_BODY_BYTES },
    });
    expect(at.rest.equals(Buffer.from(atBound, "utf8"))).toBe(true);

    // One byte more than the wire bound, still far under it in code units.
    serializerOverride.value = `${unit.repeat(WIRE_BODY_BYTES / 4 - 1)}zzzzz`;
    expect(Buffer.byteLength(serializerOverride.value)).toBe(WIRE_BODY_BYTES + 1);
    expect(serializerOverride.value.length).toBeLessThan(WIRE_BODY_BYTES / 2 + 5);
    const over = splitHeader(
      (await exchange(socketPath, getFrame("over", noteId("small"), WIRE_BODY_BYTES))).bytes,
    );
    expect(over.header).toMatchObject({ result: { contentStatus: "oversize" } });
    expect(over.header).not.toHaveProperty("body");
    expect(over.rest.length).toBe(0);
  });

  it("bounds a real multibyte note by the offer in bytes, either side of it", async () => {
    const markdown = projectionOf("multibyte");
    const markdownBytes = Buffer.byteLength(markdown);
    // The note's code units are far fewer than its bytes, so an offer of one
    // byte short is still far more than its code units.
    expect(markdown.length).toBeLessThan(markdownBytes - 1);
    const { socketPath } = await daemon();
    const fits = await exchange(socketPath, getFrame("fits", noteId("multibyte"), markdownBytes));
    const delivered = splitHeader(fits.bytes);
    expect(delivered.header).toMatchObject({ body: { bytes: markdownBytes } });
    expect(delivered.rest.equals(Buffer.from(markdown, "utf8"))).toBe(true);
    const short = await exchange(
      socketPath,
      getFrame("short", noteId("multibyte"), markdownBytes - 1),
    );
    const refused = splitHeader(short.bytes);
    expect(refused.header).toMatchObject({ result: { contentStatus: "oversize" } });
    expect(refused.header).not.toHaveProperty("body");
    expect(refused.rest.length).toBe(0);
  });

  it("keeps an empty note in one frame, because a declared body is at least one byte", async () => {
    const { socketPath } = await daemon();
    const { bytes } = await exchange(
      socketPath,
      getFrame("empty", noteId("empty"), WIRE_BODY_BYTES),
    );
    const { header, rest } = splitHeader(bytes);
    expect(header).toMatchObject({
      result: { contentStatus: "ok", markdown: "", markdownBytes: 0 },
    });
    expect(header).not.toHaveProperty("body");
    expect(rest.length).toBe(0);
  });
});

describe("locked and failed reads with accept", () => {
  it("answers a locked note with locked in one frame, never sending the body the slot returned", async () => {
    // The slot ignores the lock and hands back the body, so only the daemon's
    // own check of the metadata flag can keep it off the wire.
    const started = await daemon({ readLockedContent: true });
    const accepted = await exchange(
      started.socketPath,
      getFrame("compat-locked", noteId("locked"), WIRE_BODY_BYTES),
    );
    const plain = await exchange(started.socketPath, getFrame("compat-locked", noteId("locked")));
    expect(started.contentReads).toContain(noteId("locked"));
    expect(accepted.closed).toBe(false);
    expect(accepted.bytes.includes(Buffer.from("locked secret"))).toBe(false);
    // The same bytes as the read without accept: one frame, no declaration.
    expect(accepted.bytes.equals(plain.bytes)).toBe(true);
    const { header, rest } = splitHeader(accepted.bytes);
    expect(header).toMatchObject({ result: { contentStatus: "locked" } });
    expect(header).not.toHaveProperty("body");
    expect(rest.length).toBe(0);
  });

  it("answers an unreadable note with unavailable in one frame", async () => {
    const { socketPath } = await daemon();
    const { bytes } = await exchange(
      socketPath,
      getFrame("u", noteId("unreadable"), WIRE_BODY_BYTES),
    );
    const { header, rest } = splitHeader(bytes);
    expect(header).toMatchObject({
      result: { contentStatus: "unavailable", contentReason: "read_failed" },
    });
    expect(header).not.toHaveProperty("body");
    expect(rest.length).toBe(0);
  });

  it("answers a lone surrogate exactly as the read without accept does", async () => {
    // No mock: a stored HTML note whose projection really is not well-formed.
    for (const name of ["surrogate", "surrogateLarge"]) {
      const markdown = projectionOf(name);
      expect(markdown, name).toContain("\uD83D");
      // Encoding replaces a lone surrogate, so the round trip differs.
      expect(Buffer.from(markdown, "utf8").toString("utf8"), name).not.toBe(markdown);
    }
    expect(Buffer.byteLength(projectionOf("surrogate"))).toBeLessThan(PROJECTION_MARKDOWN_BYTES);
    expect(Buffer.byteLength(projectionOf("surrogateLarge"))).toBeGreaterThan(
      PROJECTION_MARKDOWN_BYTES,
    );
    const { socketPath } = await daemon();
    for (const [name, status] of [
      ["surrogate", "ok"],
      ["surrogateLarge", "oversize"],
    ] as const) {
      const accepted = await exchange(socketPath, getFrame(name, noteId(name), WIRE_BODY_BYTES));
      const plain = await exchange(socketPath, getFrame(name, noteId(name)));
      expect(accepted.closed, name).toBe(false);
      // Byte for byte the single-frame reply: one frame, no declaration.
      expect(accepted.bytes.equals(plain.bytes), name).toBe(true);
      const { header, rest } = splitHeader(accepted.bytes);
      expect(header, name).toMatchObject({ result: { contentStatus: status } });
      expect(header, name).not.toHaveProperty("body");
      expect(rest.length, name).toBe(0);
    }
  });

  it("closes with nothing sent, rather than a body, for Markdown the single-frame path would refuse", async () => {
    const { socketPath } = await daemon();
    serializerOverride.value = `${"a".repeat(PROJECTION_MARKDOWN_BYTES)}\u0000tail`;
    const { bytes, closed } = await exchange(
      socketPath,
      getFrame("ctl", noteId("small"), WIRE_BODY_BYTES),
    );
    expect(closed).toBe(true);
    expect(bytes.length).toBe(0);
  });
});

describe("a peer that goes away mid-body", () => {
  it("leaves no state behind when the client closes after the header", async () => {
    const budget = createLargeBodyBudget();
    const started = await daemon({ bodyBudget: budget });
    serializerOverride.value = "q".repeat(WIRE_BODY_BYTES);
    const socket = await connect(started.socketPath);
    const firstChunk = new Promise<Buffer>((resolve) => socket.once("data", resolve));
    socket.write(getFrame("gone", noteId("small"), WIRE_BODY_BYTES));
    const chunk = await firstChunk;
    expect(chunk.length).toBeLessThan(4 + 300 + WIRE_BODY_BYTES);
    // Mid-body, the accepted read holds the one process-wide slot.
    expect(slotHeld(budget)).toBe(true);
    socket.destroy();

    // The daemon serves the next connection, the shared body slot comes free
    // well before any deadline, and shutdown does not wait on anything the
    // abandoned exchange held.
    serializerOverride.value = undefined;
    const next = await exchange(started.socketPath, getFrame("next", noteId("small")));
    expect(splitHeader(next.bytes).header).toMatchObject({ result: { contentStatus: "ok" } });
    await expectSlotReleased(budget);
    const shutdownStarted = Date.now();
    await started.handle.shutdown();
    expect(Date.now() - shutdownStarted).toBeLessThan(1_000);
  });

  it("closes a connection whose peer stops reading mid-body within the body deadline", async () => {
    const budget = createLargeBodyBudget();
    const { records, auditLogger } = auditCapture();
    const started = await daemon({ bodyReceiveTimeoutMs: 300, bodyBudget: budget, auditLogger });
    serializerOverride.value = "s".repeat(WIRE_BODY_BYTES);
    const socket = await connect(started.socketPath);
    let received = 0;
    const firstChunk = new Promise<void>((resolve) =>
      socket.once("data", () => {
        // Stop reading: the rest of the body backs up in the socket buffers.
        socket.pause();
        resolve();
      }),
    );
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write(getFrame("stall", noteId("small"), WIRE_BODY_BYTES));
    await firstChunk;
    // While the stalled body holds the slot, another accepted read is refused
    // busy in one frame, before any projection is computed for it.
    expect(slotHeld(budget)).toBe(true);
    const contentReadsBefore = started.contentReads.length;
    const refused = await exchange(
      started.socketPath,
      getFrame("second", noteId("small"), WIRE_BODY_BYTES),
    );
    expect(splitHeader(refused.bytes)).toEqual({
      header: { id: "second", ok: false, error: { code: "busy", message: "Service busy" } },
      rest: Buffer.alloc(0),
    });
    expect(started.contentReads.length).toBe(contentReadsBefore);
    // Well past the deadline, read again: whatever the kernel held arrives,
    // then the close the daemon issued when the deadline expired.
    await delay(1_000);
    socket.resume();
    const outcome = await Promise.race([
      closed.then(() => "closed"),
      delay(3_000).then(() => "open"),
    ]);
    expect(outcome).toBe("closed");
    // Fewer bytes than header plus body: the body was cut off, not completed.
    expect(received).toBeLessThan(4 + WIRE_BODY_BYTES);
    await expectSlotReleased(budget);
    // The expiry is audited like the receive side's: method and outcome, the
    // deadline as the latency, and nothing of the note, its size or the ids.
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "rpc.request.timeout",
        outcome: "timeout",
        method: "notes.get",
        latencyMs: 300,
      }),
    );
    const audited = JSON.stringify(records);
    for (const absent of ["stall", "second", noteId("small"), "ssss", String(WIRE_BODY_BYTES)]) {
      expect(audited, absent).not.toContain(absent);
    }
  });
});

describe("the MCP client against the real daemon", () => {
  /** A client that has already learned the daemon speaks protocol 2. */
  async function protocol2Client(socketPath: string): Promise<NookdSocketClient> {
    const c = new NookdSocketClient({ socketPath });
    // An oversize single-frame read is what makes the client ask.
    const first = await c.getNote(noteId("large"));
    expect(first).toMatchObject({ ok: true, envelope: { result: { contentStatus: "ok" } } });
    return c;
  }

  it.each(["large", "multibyte"])(
    "returns the %s note's Markdown byte for byte, its digest matching",
    async (name) => {
      const expected = projectionOf(name);
      const expectedBytes = Buffer.from(expected, "utf8");
      expect(expectedBytes.length).toBeGreaterThan(PROJECTION_MARKDOWN_BYTES);
      const { socketPath } = await daemon();
      const result = await new NookdSocketClient({ socketPath }).getNote(noteId(name));
      if (!result.ok || result.envelope.result.kind !== "note") throw new Error("read failed");
      expect(result.envelope.result).toEqual({
        kind: "note",
        note: { id: noteId(name), title: `Title ${name}`, revision: REVISION },
        contentStatus: "ok",
        markdown: expected,
        markdownBytes: expectedBytes.length,
      });
      const received = Buffer.from(result.envelope.result.markdown ?? "", "utf8");
      expect(received.equals(expectedBytes)).toBe(true);
      expect(sha256(received)).toBe(sha256(expectedBytes));
    },
  );

  it("returns a small note identically whether it came in one frame or as a body", async () => {
    const { socketPath } = await daemon();
    const single = await new NookdSocketClient({ socketPath }).getNote(noteId("small"));
    const bodied = await (await protocol2Client(socketPath)).getNote(noteId("small"));
    expect(single.ok && bodied.ok).toBe(true);
    if (!single.ok || !bodied.ok) return;
    expect(bodied.envelope.result).toEqual(single.envelope.result);
  });

  it("returns locked for a locked note, even when the slot hands back its body", async () => {
    const started = await daemon({ readLockedContent: true });
    const c = await protocol2Client(started.socketPath);
    const result = await c.getNote(noteId("locked"));
    expect(started.contentReads).toContain(noteId("locked"));
    expect(result).toMatchObject({ ok: true, envelope: { result: { contentStatus: "locked" } } });
    expect(result.ok && result.envelope.result).not.toHaveProperty("markdown");
  });

  it("returns a note whose projection holds a lone surrogate, once protocol 2 is known", async () => {
    const { socketPath } = await daemon();
    const single = await new NookdSocketClient({ socketPath }).getNote(noteId("surrogate"));
    const accepted = await (await protocol2Client(socketPath)).getNote(noteId("surrogate"));
    expect(accepted).toMatchObject({
      ok: true,
      envelope: { result: { contentStatus: "ok", markdown: projectionOf("surrogate") } },
    });
    expect(single.ok && accepted.ok).toBe(true);
    if (!single.ok || !accepted.ok) return;
    expect(accepted.envelope.result).toEqual(single.envelope.result);
  });

  it("returns busy, not a failure, while another large body holds the slot", async () => {
    const budget = createLargeBodyBudget();
    const { socketPath } = await daemon({ bodyBudget: budget });
    const c = await protocol2Client(socketPath);
    const held = budget.tryAcquire(1);
    if (held.kind !== "acquired") throw new Error("slot unexpectedly held");
    try {
      await expect(c.getNote(noteId("small"))).resolves.toEqual({ ok: false, code: "busy" });
    } finally {
      held.release();
    }
    await expect(c.getNote(noteId("small"))).resolves.toMatchObject({ ok: true });
  });

  it("never returns a shorter string: an over-bound projection is oversize, a refused one an error", async () => {
    const { socketPath } = await daemon();
    const c = await protocol2Client(socketPath);
    serializerOverride.value = "w".repeat(WIRE_BODY_BYTES + 1);
    const over = await c.getNote(noteId("small"));
    if (!over.ok || over.envelope.result.kind !== "note") throw new Error("read failed");
    expect(over.envelope.result.contentStatus).toBe("oversize");
    expect(over.envelope.result).not.toHaveProperty("markdown");

    serializerOverride.value = `${"w".repeat(PROJECTION_MARKDOWN_BYTES)}\u0000tail`;
    await expect(c.getNote(noteId("small"))).resolves.toEqual({
      ok: false,
      code: "service_unavailable",
    });
  });
});
