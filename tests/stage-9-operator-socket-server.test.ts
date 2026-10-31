import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import net from "node:net";
import { setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  startOperatorSocketServer,
  type OperatorSocketPeerResolver,
} from "../src/service/operator-socket-server.js";
import { createOperatorDiscoveryHandler } from "../src/service/operator-discovery-handler.js";

const socketPath = (): string =>
  `/tmp/operator-test-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;

function requestFrame(method: string, params: Record<string, unknown> = {}): Buffer {
  const payload = Buffer.from(JSON.stringify({ id: "request-1", method, params }), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
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

const allowPeer: OperatorSocketPeerResolver = () => ({
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
  groups: ["nookbridge-clients"],
});

describe("daemon-owned operator socket", () => {
  it("returns the categorical reason the policy denied with", async () => {
    // Review finding 7: authorization had no request context and could only
    // express `permission_denied`, so a locked target was indistinguishable
    // from a permission problem.  The reason the policy returns is the code the
    // operator receives.
    const path = socketPath();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: () => ({ allowed: false, reason: "vault_locked" }),
      handle: async (request) => ({
        id: request.id,
        ok: true,
        result: { kind: "operation-list", handles: [] },
      }),
    });
    try {
      const response = await roundTrip(path, requestFrame("notes.operation-list"));
      expect(response).toMatchObject({
        ok: false,
        error: { code: "vault_locked", message: "Vault locked" },
      });
    } finally {
      await server.close();
    }
  });

  it("hands the parsed request to the authorization seam", async () => {
    // The evaluator cannot judge a target it never sees: the request travels
    // with the method so notebook and lock context can be resolved.
    const path = socketPath();
    const seen: Array<{ method: string; params: unknown }> = [];
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method, _peer, request) => {
        seen.push({ method, params: request?.params });
        return { allowed: true, method };
      },
      handle: async (request) => ({
        id: request.id,
        ok: true,
        result: { kind: "operation-list", handles: [] },
      }),
    });
    try {
      await roundTrip(path, requestFrame("notes.operation-list"));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: "notes.operation-list" });
    } finally {
      await server.close();
    }
  });

  it("binds a separate restrictive socket and dispatches canonical methods", async () => {
    const path = socketPath();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method) => ({ allowed: true, method }),
      handle: async (request) => ({
        id: request.id,
        ok: true,
        result: { kind: "operation-list", handles: [] },
      }),
    });
    try {
      const details = await lstat(path);
      expect(details.isSocket()).toBe(true);
      expect(details.mode & 0o777).toBe(0o660);
      const response = await roundTrip(path, requestFrame("notes.operation-list"));
      expect(response).toMatchObject({ ok: true, result: { kind: "operation-list" } });
    } finally {
      await server.close();
    }
  });

  it("resolves peer credentials through the packaged helper", async () => {
    const path = socketPath();
    const dir = mkdtempSync("/tmp/nookbridge-peer-helper-");
    const helper = `${dir}/peer-helper.mjs`;
    writeFileSync(
      helper,
      '#!/usr/bin/env node\nprocess.stdout.write("123 456 789 456 999\\n");\n',
      "utf8",
    );
    chmodSync(helper, 0o700);
    let observed: unknown;
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      peerCredentialHelperPath: helper,
      authorize: (method, peer) => {
        observed = peer;
        return { allowed: true, method };
      },
      handle: async (request) => ({
        id: request.id,
        ok: true,
        result: { kind: "operation-list", handles: [] },
      }),
    });
    try {
      await roundTrip(path, requestFrame("notes.operation-list"));
      expect(observed).toEqual({ uid: 123, gid: 456, groups: ["456", "999"] });
    } finally {
      await server.close();
      expect(lstatSync(helper).isFile()).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("uses the native peer-credential helper on the default resolver path", async () => {
    const path = socketPath();
    const dir = mkdtempSync("/tmp/nookbridge-native-peer-helper-");
    const helper = `${dir}/operator-peercred-helper`;
    const compiled = spawnSync(
      "cc",
      [
        "-O2",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-ffreestanding",
        "-fno-builtin",
        "-fno-stack-protector",
        "-fno-asynchronous-unwind-tables",
        "-fno-unwind-tables",
        "-fno-pie",
        "-no-pie",
        "-nostdlib",
        "-static",
        "-Wl,-e,_start",
        "-Wl,--build-id=none",
        fileURLToPath(new URL("../native/operator-peercred.c", import.meta.url)),
        "-o",
        helper,
      ],
      { encoding: "utf8" },
    );
    expect(compiled.status, compiled.stderr).toBe(0);
    let observed: { uid: number; gid: number; groups: readonly string[] } | undefined;
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      peerCredentialHelperPath: helper,
      authorize: (method, peer) => {
        observed = peer;
        return { allowed: true, method };
      },
      handle: async (request) => ({
        id: request.id,
        ok: true,
        result: { kind: "operation-list", handles: [] },
      }),
    });
    try {
      await roundTrip(path, requestFrame("notes.operation-list"));
      expect(observed?.uid).toBe(process.getuid?.() ?? 0);
      expect(observed?.gid).toBe(process.getgid?.() ?? 0);
      expect(observed?.groups.length).toBeGreaterThan(0);
      expect(observed?.groups.every((group) => /^[A-Za-z0-9_.+-]{1,64}$/u.test(group))).toBe(true);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries resolved group names through to the authorizer", async () => {
    // The production helper resolves the peer's numeric groups to POSIX group
    // names, because the authorization policy matches on names. Emitting bare
    // numbers here left every real peer denied while name-injecting fixtures
    // stayed green.
    const path = socketPath();
    const dir = mkdtempSync("/tmp/nookbridge-peer-helper-");
    const helper = `${dir}/peer-helper.mjs`;
    writeFileSync(
      helper,
      '#!/usr/bin/env node\nprocess.stdout.write("123 456 789 nookbridge-clients users\\n");\n',
      "utf8",
    );
    chmodSync(helper, 0o700);
    let observed: unknown;
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      peerCredentialHelperPath: helper,
      authorize: (method, peer) => {
        observed = peer;
        return { allowed: true, method };
      },
      handle: async (request) => ({
        id: request.id,
        ok: true,
        result: { kind: "operation-list", handles: [] },
      }),
    });
    try {
      await roundTrip(path, requestFrame("notes.operation-list"));
      expect(observed).toEqual({
        uid: 123,
        gid: 456,
        groups: ["nookbridge-clients", "users"],
      });
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("fails closed when the helper emits an unsafe group token", async () => {
    const path = socketPath();
    const dir = mkdtempSync("/tmp/nookbridge-peer-helper-");
    const helper = `${dir}/peer-helper.mjs`;
    writeFileSync(
      helper,
      '#!/usr/bin/env node\nprocess.stdout.write("123 456 789 bad/token\\n");\n',
      "utf8",
    );
    chmodSync(helper, 0o700);
    let dispatched = false;
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      peerCredentialHelperPath: helper,
      authorize: (method) => ({ allowed: true, method }),
      handle: async () => {
        dispatched = true;
        return { id: "request-1", ok: true, result: { kind: "operation-list", handles: [] } };
      },
    });
    try {
      const socket = net.createConnection(path);
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
      expect(dispatched).toBe(false);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects a denied peer before dispatching the request", async () => {
    const path = socketPath();
    let dispatched = false;
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: () => undefined,
      authorize: (method) => ({ allowed: true, method }),
      handle: async () => {
        dispatched = true;
        return { id: "request-1", ok: true, result: { kind: "operation-list", handles: [] } };
      },
    });
    try {
      const socket = net.createConnection(path);
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
      expect(dispatched).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("answers a failing mutation with a categorical envelope instead of dropping the socket", async () => {
    const path = socketPath();
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method) => ({ allowed: true, method }),
      handle: createOperatorDiscoveryHandler({
        browse: async () => ({ notes: [], next: null }),
        search: async () => ({ notes: [], next: null }),
        editPreimage: async () => {
          throw new Error("trusted read failed");
        },
      }),
    });
    try {
      const response = (await roundTrip(
        path,
        requestFrame("notes.edit-preimage", { id: "h_one" }),
      )) as {
        readonly ok: boolean;
        readonly error?: { readonly code: string; readonly message: string };
      };
      expect(response.ok).toBe(false);
      expect(response.error).toEqual({
        code: "service_unavailable",
        message: "Service unavailable",
      });
    } finally {
      await server.close();
    }
  });

  it("rejects MCP and alias methods before handler dispatch", async () => {
    const path = socketPath();
    let dispatched = false;
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method) => ({ allowed: true, method }),
      handle: async () => {
        dispatched = true;
        return { id: "request-1", ok: true, result: { kind: "operation-list", handles: [] } };
      },
    });
    try {
      const socket = net.createConnection(path);
      socket.write(requestFrame("notes.search", { query: "secret" }));
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
      expect(dispatched).toBe(false);
    } finally {
      await server.close();
    }
  });
  it("serves exactly one request per connection even when frames are pipelined", async () => {
    // Review finding 14: `completed` was only set after the first dispatch
    // finished, so a second frame already in the buffer, or arriving while the
    // first was in flight, reached the handler too.
    const path = socketPath();
    let handled = 0;
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: allowPeer,
      authorize: (method) => ({ allowed: true, method }),
      handle: async (request) => {
        handled += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { id: request.id, ok: true, result: { kind: "operation-list", handles: [] } };
      },
    });
    try {
      const socket = net.createConnection(path);
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      // Two complete frames in a single write, then a third after a delay.
      socket.write(
        Buffer.concat([requestFrame("notes.operation-list"), requestFrame("notes.operation-list")]),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      socket.write(requestFrame("notes.operation-list"));
      const frames: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => frames.push(chunk));
      socket.on("error", () => undefined);
      // Allow every dispatch the server would perform to finish.
      await new Promise((resolve) => setTimeout(resolve, 300));
      socket.destroy();
      expect({ handled, responses: Buffer.concat(frames).length > 0 }).toEqual({
        handled: 1,
        responses: true,
      });
    } finally {
      await server.close();
    }
  });

  it("aborts a pending peer lookup when the client disconnects", async () => {
    // Peer resolution is asynchronous (finding 14), so a client that leaves
    // before it finishes must not leave the helper running.
    const path = socketPath();
    let aborted = false;
    let handled = false;
    const server = await startOperatorSocketServer({
      socketPath: path,
      socketPathRoot: "/tmp",
      resolvePeer: (_socket, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(undefined);
          });
        }),
      authorize: (method) => ({ allowed: true, method }),
      handle: async (request) => {
        handled = true;
        return { id: request.id, ok: true, result: { kind: "operation-list", handles: [] } };
      },
    });
    try {
      const socket = net.createConnection(path);
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      socket.write(requestFrame("notes.operation-list"));
      socket.destroy();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect({ aborted, handled }).toEqual({ aborted: true, handled: false });
    } finally {
      await server.close();
    }
  });
});
