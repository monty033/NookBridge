/**
 * The daemon's operator authorizer.
 *
 * This is the production decision function: `nookd` builds it once and hands it
 * to the operator socket, so the tests that exercise it are testing the code the
 * daemon actually runs rather than a helper beside it.
 *
 * Two gates, in order:
 *
 *   1. Principal — the method's capability family must be granted to the peer
 *      by the `operatorAccess` policy (see `operator-capabilities.ts`).  With no
 *      `operatorAccess` block the policy is one implicit principal, the base
 *      group `nookbridge-operators`, holding every family, which is the old
 *      all-or-nothing behaviour.  An ungranted peer is refused before any
 *      handle is resolved and before lock state or notebook policy is read.
 *   2. Target — a locked note refuses mutation categorically, and a notebook
 *      whose policy forbids the operation refuses it.  A target-addressed
 *      mutation whose target does not resolve for the calling peer is refused.
 *
 * Step 2 can only deny: a grant never overrides a lock or a notebook refusal.
 * Resolution happens before the synchronous policy seam runs, so the evaluator
 * sees the target it is judging.
 */

import {
  OPERATOR_MUTATING_METHODS,
  resolveOperatorRequestLockState,
  resolveOperatorRequestNotebookPolicy,
  targetNoteId,
} from "./operator-authorization-context.js";
import {
  authorizeOperatorMethod,
  createOperatorPolicy,
  type OperatorNotebookPolicy,
  type OperatorNoteLockState,
  type OperatorPolicyDecision,
  type OperatorAuthorizationContext,
} from "./operator-policy.js";
import {
  OPERATOR_BASE_GROUP,
  createDefaultOperatorAccessPolicy,
  operatorMethodFamily,
  type OperatorAccessAuditRecord,
  type OperatorAccessGrant,
  type OperatorAccessPolicy,
} from "./operator-capabilities.js";
import { peerToAuthorizationContext, type OperatorPeer } from "./operator-server.js";
import type { OperatorMethod } from "./operator-methods.js";
import type { RpcRequest } from "./rpc-protocol.js";
import type { SettingsOperation } from "../settings/settings-types.js";

/**
 * The group the implicit (no `operatorAccess`) policy admits.  `nookbridge-clients`
 * is deliberately absent, so a peer holding only that group cannot reach the
 * operator listener.
 *
 * Kept as the documented default.  The evaluator no longer reads it: the
 * principal gate is the single source of truth for admission.
 *
 * This is not an MCP boundary.  The MCP server is launched by the MCP client
 * and runs as the same identity used for operator CLI work, which holds
 * `nookbridge-operators`, so an MCP-launched process is still admitted.  A
 * dedicated non-operator identity for the MCP server is tracked as SR-9.
 */
export const OPERATOR_ADMITTED_GROUPS: ReadonlyArray<string> = Object.freeze([OPERATOR_BASE_GROUP]);

/** The base operator group; the only principal that may hold `admin`. */
export const OPERATOR_MUTATION_GROUP = OPERATOR_BASE_GROUP;

export interface OperatorAuthorizerDependencies {
  /**
   * The compiled `operatorAccess` policy.  Omitted means the implicit default:
   * the base group holding every family, which is the pre-`operatorAccess`
   * behaviour exactly.
   */
  readonly access?: OperatorAccessPolicy | undefined;
  /** One record per principal-gate decision: the matched index and the family. */
  readonly audit?: ((record: OperatorAccessAuditRecord) => void) | undefined;
  /** Resolve a note handle to a note id, per peer. */
  readonly resolveHandle: (handle: string, peer: OperatorPeer) => string | undefined;
  /** Resolve an operation handle to its note, scoped to its owner. */
  readonly resolveOperationNoteId?:
    | ((
        operationHandle: string,
        peer: OperatorPeer,
      ) => string | undefined | Promise<string | undefined>)
    | undefined;
  /** Trusted lock-state reader. */
  readonly readNoteLockState?: ((id: string) => Promise<"locked" | "unlocked">) | undefined;
  /** Resolve a note id to its notebook path. */
  readonly readNoteNotebookPath?: ((noteId: string) => Promise<string | undefined>) | undefined;
  /** Every notebook path the note is attached to; see the context helper. */
  readonly readNoteNotebookPaths?:
    | ((noteId: string) => Promise<readonly string[] | undefined>)
    | undefined;
  readonly resolveNotebookPath?:
    | ((notebookId: string) => string | undefined | Promise<string | undefined>)
    | undefined;
  /** The settings evaluator that decides per-notebook overrides. */
  readonly evaluateNotebookPolicy?:
    | ((operation: SettingsOperation, notebookPath: string | undefined) => boolean)
    | undefined;
}

export type OperatorAuthorizer = (
  method: OperatorMethod,
  peer: OperatorPeer,
  request?: RpcRequest,
) => Promise<OperatorPolicyDecision>;

/**
 * Reads that return or preview a specific note's content.  Like mutations they
 * must name a target that resolves for the peer and sits in a notebook whose
 * policy explicitly allows the read; a root-level note has no notebook and is
 * always refused.  Reads never consult lock state.
 */
export const OPERATOR_TARGET_READ_METHODS: ReadonlyArray<OperatorMethod> = Object.freeze([
  "notes.get-view",
  "notes.edit-preimage",
  "notes.inspect-conflict",
]);

export function createOperatorAuthorizer(deps: OperatorAuthorizerDependencies): OperatorAuthorizer {
  const access = deps.access ?? createDefaultOperatorAccessPolicy();
  const decide: OperatorAuthorizer = async (method, peer, request) => {
    // Principal gate.  It runs before anything below touches the request: no
    // handle is resolved and no lock state or notebook policy is read for a peer
    // that holds no grant, so a refusal here does no work an unauthorised caller
    // could time or probe.
    const family = operatorMethodFamily(method);
    const grant: OperatorAccessGrant =
      family === undefined
        ? { granted: false, principalIndex: undefined, viaBaseGroup: false }
        : access.evaluate(peer, family);
    emitAudit(deps.audit, grant, family);
    if (!grant.granted) return { allowed: false, reason: "permission_denied" };

    const context = peerToAuthorizationContext(peer) as OperatorAuthorizationContext & {
      noteLockState?: OperatorNoteLockState;
      notebookPolicy?: OperatorNotebookPolicy;
    };
    const lockState = await resolveOperatorRequestLockState({
      method,
      request,
      peer,
      resolveHandle: deps.resolveHandle,
      resolveOperationNoteId: deps.resolveOperationNoteId,
      readNoteLockState: deps.readNoteLockState,
    });
    if (lockState !== undefined) context.noteLockState = lockState;
    const notebookPolicy = await resolveOperatorRequestNotebookPolicy({
      method,
      request,
      peer,
      resolveHandle: deps.resolveHandle,
      resolveOperationNoteId: deps.resolveOperationNoteId,
      readNoteNotebookPath: deps.readNoteNotebookPath,
      readNoteNotebookPaths: deps.readNoteNotebookPaths,
      resolveNotebookPath: deps.resolveNotebookPath,
      evaluateNotebookPolicy: deps.evaluateNotebookPolicy,
    });
    if (notebookPolicy !== undefined) context.notebookPolicy = notebookPolicy;
    if (OPERATOR_MUTATING_METHODS.includes(method)) {
      // A target-addressed mutation must name a target this peer can resolve.
      // A handle minted for another peer, a forged or malformed one, or no
      // target at all yields no lock or notebook context, which the evaluator
      // would read as "nothing to refuse"; deny instead.
      if (method !== "notes.create" && method !== "notes.approve-upload") {
        if (!(await requestTargetKnown(deps, request, peer, method))) {
          return { allowed: false, reason: "permission_denied" };
        }
        if (deps.readNoteLockState === undefined) {
          return { allowed: false, reason: "permission_denied" };
        }
      }
      if (method !== "notes.approve-upload" && notebookPolicy === undefined) {
        return { allowed: false, reason: "permission_denied" };
      }
    }
    if (OPERATOR_TARGET_READ_METHODS.includes(method)) {
      if (!(await requestTargetKnown(deps, request, peer, method))) {
        return { allowed: false, reason: "permission_denied" };
      }
      if (notebookPolicy === undefined) {
        return { allowed: false, reason: "permission_denied" };
      }
    }
    return authorizeOperatorMethod(
      createOperatorPolicy((candidate, evaluated) =>
        evaluateOperatorRequest(candidate, evaluated, grant),
      ),
      method,
      context,
    );
  };
  return async (method, peer, request) => {
    try {
      return await decide(method, peer, request);
    } catch {
      // A dependency that throws or rejects is a refusal, never a rejection.
      return { allowed: false, reason: "permission_denied" };
    }
  };
}

/**
 * Whether the request names a target that resolves for this peer.  This is the
 * same resolution the lock and notebook-policy contexts use, so the gate and
 * the contexts cannot disagree about what the request targets.
 */
async function requestTargetKnown(
  deps: OperatorAuthorizerDependencies,
  request: RpcRequest | undefined,
  peer: OperatorPeer,
  method: OperatorMethod,
): Promise<boolean> {
  if (request === undefined) return false;
  const noteId = await targetNoteId({
    method,
    request,
    peer,
    resolveHandle: deps.resolveHandle,
    resolveOperationNoteId: deps.resolveOperationNoteId,
  });
  return noteId !== undefined;
}

/** Record the principal-gate decision.  A broken sink never changes the decision. */
function emitAudit(
  audit: OperatorAuthorizerDependencies["audit"],
  grant: OperatorAccessGrant,
  family: OperatorAccessAuditRecord["family"] | undefined,
): void {
  if (audit === undefined) return;
  try {
    audit({ principalIndex: grant.principalIndex ?? null, family: family ?? null });
  } catch {
    // Auditing must not turn an authorization decision into a failure.
  }
}

/**
 * The evaluator.  Denials are categorical and carry no target detail: the
 * operator learns that it was refused, not what exists.
 *
 * Admission is not decided here: the principal gate already granted the family,
 * and `grant` is that result.  This step can only deny.
 */
function evaluateOperatorRequest(
  candidate: OperatorMethod,
  context: OperatorAuthorizationContext,
  grant: OperatorAccessGrant,
): OperatorPolicyDecision {
  const mutating = OPERATOR_MUTATING_METHODS.includes(candidate);

  if (mutating && context.noteLockState?.locked === true) {
    // `vault_locked` tells the caller the target is a locked note.  Only a peer
    // granted through the base operator group is told; a delegated principal
    // gets the same refusal as an unknown handle, so it cannot probe lock state.
    return { allowed: false, reason: grant.viaBaseGroup ? "vault_locked" : "permission_denied" };
  }

  // Only an explicit refusal denies: an absent policy means the daemon is not
  // enforcing notebook policy at this seam.
  if (context.notebookPolicy?.allow === false) {
    return { allowed: false, reason: "permission_denied" };
  }

  return { allowed: true, method: candidate };
}
