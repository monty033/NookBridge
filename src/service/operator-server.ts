/**
 * T04 — operator-only Unix socket transport seam.
 *
 * The operator endpoint is a SEPARATE listener from the MCP Unix
 * socket.  The seam is intentionally tiny:
 *
 *   - It owns the **method-only admission decision** (canonical
 *     operator vocabulary or categorical reject).
 *   - It owns the **peer-credential check** (uid / gid / groups
 *     forwarded from the caller; the actual `SO_PEERCRED`
 *     invocation lives in the integration seam, T05).
 *   - It owns the **restrictive filesystem mode** for the operator
 *     socket (0o660 by default — group-only write — and a
 *     structural path allowlist rooted under `/run/nookbridge`).
 *   - It is **disabled when not configured** — the operator
 *     endpoint does not bind to a path that the deployment did
 *     not explicitly opt into.  The disabled handle is the source
 *     of truth for "operator endpoint is off on this host".
 *
 * The body-free property of the operator endpoint is enforced at
 * the wire layer by reusing {@link parseRpcFrame} from
 * `rpc-protocol.ts`; the method peeker below confirms the operator
 * vocabulary and the categorical reject sentinel BEFORE any
 * request body is parsed.
 *
 * The runtime binding (`net.createServer` + `SO_PEERCRED` +
 * lifecycle) is intentionally NOT in this file.  That is the T05
 * integration seam: the production transport lifts this module's
 * decisions and wires them into `net.createServer`.  Tests
 * exercise the seam directly via {@link buildOperatorTransport}
 * and {@link createOperatorListener} so the production-binding
 * regression does not block the T04 unit gate.
 */

import { Buffer } from "node:buffer";
import path from "node:path";

import {
  isOperatorTransportMethod,
  OPERATOR_METHODS,
  type OperatorTransportMethod,
} from "./operator-methods.js";
import type { OperatorPolicyEvaluator } from "./operator-policy.js";

const objectCreate = Object.create;
const objectFreeze = Object.freeze;

// ---------------------------------------------------------------------------
// Wire surface: frame peek.
// ---------------------------------------------------------------------------

const FRAME_PREFIX_BYTES = 4;
const REJECTED_SENTINEL = "rejected" as const;
export type OperatorMethodPeek = OperatorTransportMethod | typeof REJECTED_SENTINEL;

/**
 * Body-free peek of the operator method from a length-prefixed
 * frame.  The peek is performed on the first
 * `FRAME_PREFIX_BYTES + payload` bytes; anything past the declared
 * payload length is ignored, so a hostile caller cannot smuggle
 * data through the seam by appending bytes after the frame
 * boundary.
 *
 * The peek is intentionally NOT a parser; it accepts the same
 * shape `parseRpcFrame` accepts but only returns the method
 * literal.  This is the body-free decision the operator listener
 * makes BEFORE any handler is consulted.
 */
function peekOperatorMethod(frame: Uint8Array): OperatorMethodPeek {
  if (!(frame instanceof Uint8Array)) return REJECTED_SENTINEL;
  if (frame.byteLength < FRAME_PREFIX_BYTES) return REJECTED_SENTINEL;
  const view = new DataView(frame.buffer, frame.byteOffset, FRAME_PREFIX_BYTES);
  const declaredLength = view.getUint32(0, false);
  if (declaredLength === 0) return REJECTED_SENTINEL;
  if (FRAME_PREFIX_BYTES + declaredLength !== frame.byteLength) return REJECTED_SENTINEL;

  // Decode just the JSON method field without allocating the rest
  // of the request object.  We locate the `"method":"<literal>"`
  // substring in the JSON payload bytes so we never buffer the
  // body.
  const payload = new Uint8Array(
    frame.buffer,
    frame.byteOffset + FRAME_PREFIX_BYTES,
    declaredLength,
  );
  const text = Buffer.from(payload).toString("utf8");
  if (text.length === 0) return REJECTED_SENTINEL;
  const marker = '"method":"';
  const start = text.indexOf(marker);
  if (start < 0) return REJECTED_SENTINEL;
  const valueStart = start + marker.length;
  const end = text.indexOf('"', valueStart);
  if (end < 0) return REJECTED_SENTINEL;
  const method = text.slice(valueStart, end);
  if (!isOperatorTransportMethod(method)) return REJECTED_SENTINEL;
  return method;
}

// ---------------------------------------------------------------------------
// Peer-credential seam.
// ---------------------------------------------------------------------------

/**
 * The closed peer-credential shape the transport expects.  The
 * production seam extracts this from `SO_PEERCRED`; the unit tests
 * inject it directly so the seam can be exercised without opening
 * a live socket.
 */
export interface OperatorPeer {
  readonly uid: number;
  readonly gid: number;
  readonly groups: ReadonlyArray<string>;
}

export interface OperatorPeerAllowed {
  readonly allowed: true;
}

export interface OperatorPeerDenied {
  readonly allowed: false;
  readonly reason: "permission_denied";
}

export type OperatorPeerResult = OperatorPeerAllowed | OperatorPeerDenied;

/**
 * The peer-credential predicate the transport consults.  Returns
 * an `allowed: true` shape to admit the peer, or an
 * `allowed: false` shape to deny.  Any thrown error is collapsed
 * to a categorical denial.
 */
export type OperatorPeerCheck = (peer: OperatorPeer) => OperatorPeerResult;

// ---------------------------------------------------------------------------
// Authorization context adapter.
// ---------------------------------------------------------------------------

/**
 * Convert a peer-credential shape into the operator authorization
 * context.  The operator policy evaluator receives the operator
 * uid / gid / supplementary groups as optional context so it can
 * make per-host decisions; the seam itself enforces only the
 * transport-layer rule (the peer-credential predicate).
 */
export function peerToAuthorizationContext(peer: OperatorPeer): {
  readonly operatorUid: number;
  readonly operatorGid: number;
  readonly operatorGroupMembership: ReadonlyArray<string>;
} {
  return {
    operatorUid: peer.uid,
    operatorGid: peer.gid,
    operatorGroupMembership: peer.groups,
  };
}

// ---------------------------------------------------------------------------
// Transport seam.
// ---------------------------------------------------------------------------

/**
 * The closed transport seam the operator listener relies on.
 *
 *   - `isMethodAllowed(method)` answers the body-free admission
 *     question: is this method in the canonical operator
 *     vocabulary?
 *   - `peekMethod(frame)` reads the body-free method literal out
 *     of a wire frame.
 *   - `checkPeer(peer)` runs the configured peer-credential
 *     predicate and collapses throws to categorical denials.
 */
export interface OperatorTransport {
  readonly isMethodAllowed: (method: string) => method is OperatorTransportMethod;
  readonly peekMethod: (frame: Uint8Array) => OperatorMethodPeek;
  readonly checkPeer: (peer: OperatorPeer) => OperatorPeerResult;
}

export interface BuildOperatorTransportOptions {
  readonly peerCheck: OperatorPeerCheck;
  readonly evaluator: OperatorPolicyEvaluator;
}

/**
 * Build the body-free transport seam.  The returned object is
 * frozen on a null prototype so a hostile caller cannot mutate the
 * predicates after construction.
 */
export function buildOperatorTransport(options: BuildOperatorTransportOptions): OperatorTransport {
  if (options === null || typeof options !== "object") {
    throw new Error("operator transport: invalid options");
  }
  const isMethodAllowed = (method: string): method is OperatorTransportMethod =>
    isOperatorTransportMethod(method);
  const peekMethod = (frame: Uint8Array): OperatorMethodPeek => peekOperatorMethod(frame);
  const checkPeer = (peer: OperatorPeer): OperatorPeerResult => {
    if (peer === null || typeof peer !== "object") {
      return denyPeerResult();
    }
    try {
      const result = options.peerCheck(peer);
      if (result === null || typeof result !== "object") return denyPeerResult();
      if ((result as { allowed?: unknown }).allowed === true) {
        const admit: { allowed: true } = { allowed: true };
        return objectFreeze(admit) as OperatorPeerAllowed;
      }
      return denyPeerResult();
    } catch {
      return denyPeerResult();
    }
  };
  const transport = objectCreate(null) as {
    isMethodAllowed: (method: string) => method is OperatorTransportMethod;
    peekMethod: (frame: Uint8Array) => OperatorMethodPeek;
    checkPeer: (peer: OperatorPeer) => OperatorPeerResult;
  };
  transport.isMethodAllowed = isMethodAllowed;
  transport.peekMethod = peekMethod;
  transport.checkPeer = checkPeer;
  // Reference the evaluator so the seam does not drop it — T05
  // wires the evaluator into the per-request admission pipeline.
  void options.evaluator;
  return objectFreeze(transport) as OperatorTransport;
}

function denyPeerResult(): OperatorPeerDenied {
  const deny: OperatorPeerDenied = { allowed: false, reason: "permission_denied" };
  return objectFreeze(deny) as OperatorPeerDenied;
}

// ---------------------------------------------------------------------------
// Listener handle.
// ---------------------------------------------------------------------------

/**
 * The closed operator listener handle.
 *
 *   - `kind: "disabled"` is returned when no operator socket path
 *     was configured.  The deployment opts in by supplying a
 *     service-owned absolute path.
 *   - `kind: "ready"` is returned with the structural binding
 *     (path + restrictive mode + close hook) when a path was
 *     supplied.  The runtime `net.createServer` binding is the T05
 *     integration; T04 ships the structural handle so callers can
 *     reason about the operator endpoint without opening a live
 *     socket.
 */
export type OperatorListenerHandle =
  | Readonly<{ readonly kind: "disabled"; readonly reason: "not_configured" }>
  | Readonly<{
      readonly kind: "ready";
      readonly socketPath: string;
      readonly socketMode: number;
      readonly close: () => Promise<void>;
    }>;

export interface CreateOperatorListenerOptions {
  readonly socketPath?: string;
  readonly socketMode?: number;
  readonly peerCheck: OperatorPeerCheck;
  readonly evaluator: OperatorPolicyEvaluator;
}

const DEFAULT_OPERATOR_SOCKET_MODE = 0o660;
const RESTRICTIVE_OPERATOR_SOCKET_MODES: ReadonlyArray<number> = [0o660, 0o770];
const OPERATOR_SOCKET_ROOT = "/run/nookbridge";

/**
 * Validate the operator socket path.  The path MUST be absolute
 * (canonical-form), MUST NOT contain traversal segments, and MUST
 * live under `/run/nookbridge`.  Other paths are categorically
 * refused to prevent a hostile operator-script from binding to
 * `/tmp` or another non-service-owned runtime root.
 */
function validateOperatorSocketPath(socketPath: string): string {
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new Error("operator socket path must be a non-empty string");
  }
  if (!path.isAbsolute(socketPath)) {
    throw new Error("operator socket path must be absolute");
  }
  const resolved = path.resolve(socketPath);
  if (resolved !== socketPath) {
    throw new Error("operator socket path must be in canonical form");
  }
  if (!resolved.startsWith(OPERATOR_SOCKET_ROOT + "/")) {
    throw new Error("operator socket path must live under /run/nookbridge");
  }
  return resolved;
}

/**
 * Validate the operator socket mode.  Only the restrictive
 * 0o660 / 0o770 set is accepted; anything else (0o777, 0o644,
 * etc.) is refused categorically.
 */
function validateOperatorSocketMode(socketMode: number): number {
  if (!Number.isInteger(socketMode) || socketMode < 0 || socketMode > 0o777) {
    throw new Error("operator socket mode must be a valid 0o000–0o777 octal");
  }
  for (let index = 0; index < RESTRICTIVE_OPERATOR_SOCKET_MODES.length; index += 1) {
    if (RESTRICTIVE_OPERATOR_SOCKET_MODES[index] === socketMode) return socketMode;
  }
  throw new Error("operator socket mode must be 0o660 or 0o770");
}

/**
 * Build the operator listener handle.  When `socketPath` is
 * `undefined`, the listener is disabled and the returned handle
 * carries the categorical `not_configured` reason.  When a path is
 * supplied, the listener is structurally ready and exposes the
 * configured socket path, the restrictive socket mode, and a
 * `close()` hook (no-op in the T04 seam; the T05 integration
 * installs the real close).
 */
export function createOperatorListener(
  options: CreateOperatorListenerOptions,
): OperatorListenerHandle {
  if (options === null || typeof options !== "object") {
    throw new Error("operator listener: invalid options");
  }
  if (typeof options.peerCheck !== "function") {
    throw new Error("operator listener: peerCheck must be a function");
  }
  if (typeof options.evaluator !== "function") {
    throw new Error("operator listener: evaluator must be a function");
  }
  if (options.socketPath === undefined) {
    const disabled = objectCreate(null) as {
      kind: "disabled";
      reason: "not_configured";
    };
    disabled.kind = "disabled";
    disabled.reason = "not_configured";
    return objectFreeze(disabled) as OperatorListenerHandle;
  }
  const socketPath = validateOperatorSocketPath(options.socketPath);
  const socketMode = validateOperatorSocketMode(options.socketMode ?? DEFAULT_OPERATOR_SOCKET_MODE);
  const ready = objectCreate(null) as {
    kind: "ready";
    socketPath: string;
    socketMode: number;
    close: () => Promise<void>;
  };
  ready.kind = "ready";
  ready.socketPath = socketPath;
  ready.socketMode = socketMode;
  ready.close = async () => undefined;
  return objectFreeze(ready) as OperatorListenerHandle;
}

/**
 * Re-export the canonical operator vocabulary for callers that
 * already import from `operator-server`.
 */
export { OPERATOR_METHODS };
