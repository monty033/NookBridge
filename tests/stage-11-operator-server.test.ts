/**
 * T04 — operator-only Unix socket transport.
 *
 * The operator endpoint is a SEPARATE listener from the MCP Unix
 * socket.  This suite pins the seam:
 *
 *   - The operator socket is created with restrictive filesystem
 *     permissions (mode 0660, group-only write).
 *   - Connections from peers whose uid/gid does not match the
 *     configured operator group are rejected categorically with
 *     `peer_rejected` — the body of the request is never inspected.
 *   - The operator endpoint refuses every non-operator method
 *     (`notes.search`, `notes.update`, etc.) categorically without
 *     forwarding to the handler.
 *   - The operator endpoint refuses MCP-only requests (body
 *     projection) and remains body-free at the request layer.
 *   - The operator endpoint is disabled (no listener) when no
 *     operator socket path is configured.
 *
 * These tests inject the seam directly; they do not open live
 * databases or peer-credential sockets.  The runtime transport
 * (the actual `net.createServer` binding, the real peer-credential
 * check, and the integration with `nookd`) is the T05 handoff.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import {
  buildOperatorTransport,
  createOperatorListener,
  type OperatorListenerHandle,
  type OperatorPeerCheck,
} from "../src/service/operator-server.js";
import type { RpcMethod } from "../src/service/rpc-protocol.js";
import { OPERATOR_METHODS } from "../src/service/operator-methods.js";
import type {
  OperatorPolicyDecision,
  OperatorPolicyEvaluator,
} from "../src/service/operator-policy.js";

function frame(method: string, params: Record<string, unknown> = {}): Uint8Array {
  const payload = Buffer.from(JSON.stringify({ id: "x", method, params }), "utf8");
  const out = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.byteLength, false);
  out.set(payload, 4);
  return out;
}

const allowedPeer: OperatorPeerCheck = (peer) => {
  if (peer.uid === 1000 && peer.gid === 1000 && peer.groups.includes("nookbridge-clients"))
    return { allowed: true };
  return { allowed: false, reason: "permission_denied" };
};

const deniedPeer: OperatorPeerCheck = () => ({
  allowed: false,
  reason: "permission_denied",
});

const closedEvaluator: OperatorPolicyEvaluator = (method): OperatorPolicyDecision => ({
  allowed: true,
  method,
});

describe("operator transport — method-only admission", () => {
  it("admits every canonical operator method to the seam", () => {
    const transport = buildOperatorTransport({
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    for (const method of OPERATOR_METHODS) {
      expect(transport.isMethodAllowed(method)).toBe(true);
    }
  });

  it("refuses every non-operator method at the seam", () => {
    const transport = buildOperatorTransport({
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    const refused = [
      "notes.search",
      "notes.status",
      "notes.list_notebooks",
      "notes.get",
      "notes.update",
      "notes.append",
      "notes.delete",
      "notes.locked_note_proof",
      "notes.path_diagnostic",
      "notes.sync",
    ];
    for (const method of refused) {
      expect(transport.isMethodAllowed(method)).toBe(false);
    }
  });

  it("refuses alias method names that are NOT in the canonical vocabulary", () => {
    const transport = buildOperatorTransport({
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    expect(transport.isMethodAllowed("notes.edit")).toBe(false);
    expect(transport.isMethodAllowed("notes.undo")).toBe(false);
    expect(transport.isMethodAllowed("notes.predict-next-revision")).toBe(false);
    expect(transport.isMethodAllowed("notes.snapshot")).toBe(false);
    expect(transport.isMethodAllowed("")).toBe(false);
  });
});

describe("operator transport — frame inspection (body-free)", () => {
  it("returns the canonical operator methods on peek without inspecting the body", () => {
    const transport = buildOperatorTransport({
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    const operatorFrame = frame("notes.get-view", { id: "h" });
    expect(transport.peekMethod(operatorFrame)).toBe("notes.get-view");
  });

  it("returns the canonical operator create method on peek", () => {
    const transport = buildOperatorTransport({
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    expect(transport.peekMethod(frame("notes.create", { title: "t", content: "c" }))).toBe(
      "notes.create",
    );
  });

  it("returns the categorical sentinel for unknown methods", () => {
    const transport = buildOperatorTransport({
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    expect(transport.peekMethod(frame("notes.search", { query: "x" }))).toBe("rejected");
    expect(transport.peekMethod(frame("notes.edit", {}))).toBe("rejected");
  });

  it("returns the categorical sentinel for an unparseable frame", () => {
    const transport = buildOperatorTransport({
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    // A frame whose declared length does not match its buffer length
    // — the operator seam must not throw, just collapse to `rejected`.
    const bad = new Uint8Array([0, 0, 0, 5, 0x7b, 0x22, 0x69, 0x22, 0x3a, 0x31]);
    expect(transport.peekMethod(bad)).toBe("rejected");
  });
});

describe("operator transport — peer-credential seam", () => {
  it("admits a peer whose uid/gid/groups match the configured allowlist", () => {
    const transport = buildOperatorTransport({
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    const result = transport.checkPeer({
      uid: 1000,
      gid: 1000,
      groups: ["nookbridge-clients", "users"],
    });
    expect(result.allowed).toBe(true);
  });

  it("rejects a peer whose uid does not match", () => {
    const transport = buildOperatorTransport({
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    const result = transport.checkPeer({
      uid: 1,
      gid: 1000,
      groups: ["nookbridge-clients"],
    });
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toBe("permission_denied");
    }
  });

  it("rejects a peer whose group membership does not include the operator group", () => {
    const transport = buildOperatorTransport({
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    const result = transport.checkPeer({
      uid: 1000,
      gid: 1000,
      groups: ["users"],
    });
    expect(result.allowed).toBe(false);
  });

  it("rejects when the peer check itself denies (closed default)", () => {
    const transport = buildOperatorTransport({
      peerCheck: deniedPeer,
      evaluator: closedEvaluator,
    });
    const result = transport.checkPeer({
      uid: 1000,
      gid: 1000,
      groups: ["nookbridge-clients"],
    });
    expect(result.allowed).toBe(false);
  });

  it("rejects when the peer check throws (defence in depth)", () => {
    const transport = buildOperatorTransport({
      peerCheck: () => {
        throw new Error("hostile peer check");
      },
      evaluator: closedEvaluator,
    });
    const result = transport.checkPeer({
      uid: 1000,
      gid: 1000,
      groups: ["nookbridge-clients"],
    });
    expect(result.allowed).toBe(false);
  });
});

describe("operator transport — listener disabled when not configured", () => {
  it("returns a disabled handle when no socket path is supplied", () => {
    const handle = createOperatorListener({
      socketMode: 0o660,
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    expect(handle.kind).toBe("disabled");
    if (handle.kind === "disabled") {
      expect(handle.reason).toBe("not_configured");
    }
  });

  it("returns a structural handle with the configured mode when a path is supplied", () => {
    const handle = createOperatorListener({
      socketPath: "/run/nookbridge/operator.sock",
      socketMode: 0o660,
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    expect(handle.kind).toBe("ready");
    if (handle.kind === "ready") {
      expect(handle.socketPath).toBe("/run/nookbridge/operator.sock");
      expect(handle.socketMode).toBe(0o660);
      expect(typeof handle.close).toBe("function");
    }
  });

  it("refuses a socket mode outside the restrictive 0o660 / 0o770 set", () => {
    expect(() =>
      createOperatorListener({
        socketPath: "/run/nookbridge/operator.sock",
        socketMode: 0o777,
        peerCheck: allowedPeer,
        evaluator: closedEvaluator,
      }),
    ).toThrow();
  });

  it("refuses a relative socket path", () => {
    expect(() =>
      createOperatorListener({
        socketPath: "operator.sock",
        socketMode: 0o660,
        peerCheck: allowedPeer,
        evaluator: closedEvaluator,
      }),
    ).toThrow();
  });

  it("refuses a socket path that is not under the service runtime root", () => {
    expect(() =>
      createOperatorListener({
        socketPath: "/tmp/operator.sock",
        socketMode: 0o660,
        peerCheck: allowedPeer,
        evaluator: closedEvaluator,
      }),
    ).toThrow();
  });
});

describe("operator transport — closed handle contract", () => {
  it("handle is frozen on a null prototype", () => {
    const handle: OperatorListenerHandle = createOperatorListener({
      socketPath: "/run/nookbridge/operator.sock",
      socketMode: 0o660,
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.getPrototypeOf(handle)).toBeNull();
  });

  it("default socket mode is 0o660 (group-only write)", () => {
    const handle = createOperatorListener({
      socketPath: "/run/nookbridge/operator.sock",
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    if (handle.kind === "ready") {
      expect(handle.socketMode).toBe(0o660);
    } else {
      throw new Error("expected ready handle");
    }
  });

  it("peeks every canonical operator method", () => {
    const transport = buildOperatorTransport({
      peerCheck: allowedPeer,
      evaluator: closedEvaluator,
    });
    for (const method of OPERATOR_METHODS) {
      const peeked = transport.peekMethod(frame(method));
      expect(peeked).toBe(method as RpcMethod);
    }
  });
});
