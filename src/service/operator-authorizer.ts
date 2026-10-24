/**
 * The daemon's operator authorizer.
 *
 * This is the production decision function: `nookd` builds it once and hands it
 * to the operator socket, so the tests that exercise it are testing the code the
 * daemon actually runs rather than a helper beside it.
 *
 * Three gates, in order:
 *
 *   1. Admission — the peer must be in one of the two admitted groups.
 *   2. Capability — a mutating method requires the operator group.  The two
 *      groups are a privilege boundary, not decoration: membership of the
 *      read-only group must not be enough to call `apply-edit`.
 *   3. Target — a locked note refuses mutation categorically, and a notebook
 *      whose policy forbids the operation refuses it.  A target-addressed
 *      mutation whose target does not resolve for the calling peer is refused.
 *
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
import { peerToAuthorizationContext, type OperatorPeer } from "./operator-server.js";
import type { OperatorMethod } from "./operator-methods.js";
import type { RpcRequest } from "./rpc-protocol.js";
import type { SettingsOperation } from "../settings/settings-types.js";

/** Groups admitted to the operator socket at all. */
export const OPERATOR_ADMITTED_GROUPS: ReadonlyArray<string> = Object.freeze([
  "nookbridge-clients",
  "nookbridge-operators",
]);

/** The capability group required for any mutating operator method. */
export const OPERATOR_MUTATION_GROUP = "nookbridge-operators";

export interface OperatorAuthorizerDependencies {
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
  readonly resolveNotebookPath?:
    | ((notebookId: string) => string | undefined | Promise<string | undefined>)
    | undefined;
  /** The settings evaluator that decides per-notebook overrides. */
  readonly evaluateNotebookPolicy?:
    | ((operation: SettingsOperation, notebookPath: string) => boolean)
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
]);

export function createOperatorAuthorizer(deps: OperatorAuthorizerDependencies): OperatorAuthorizer {
  const decide: OperatorAuthorizer = async (method, peer, request) => {
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
      resolveNotebookPath: deps.resolveNotebookPath,
      evaluateNotebookPolicy: deps.evaluateNotebookPolicy,
    });
    if (notebookPolicy !== undefined) context.notebookPolicy = notebookPolicy;
    if (OPERATOR_MUTATING_METHODS.includes(method)) {
      // A target-addressed mutation must name a target this peer can resolve.
      // A handle minted for another peer, a forged or malformed one, or no
      // target at all yields no lock or notebook context, which the evaluator
      // would read as "nothing to refuse"; deny instead.
      if (method !== "notes.create") {
        if (!(await requestTargetKnown(deps, request, peer, method))) {
          return { allowed: false, reason: "permission_denied" };
        }
        if (deps.readNoteLockState === undefined) {
          return { allowed: false, reason: "permission_denied" };
        }
      }
      if (notebookPolicy === undefined) {
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
    return authorizeOperatorMethod(createOperatorPolicy(evaluateOperatorRequest), method, context);
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

/**
 * The evaluator.  Denials are categorical and carry no target detail: the
 * operator learns that it was refused, not what exists.
 */
function evaluateOperatorRequest(
  candidate: OperatorMethod,
  context: OperatorAuthorizationContext,
): OperatorPolicyDecision {
  const groups = context.operatorGroupMembership ?? [];
  const isOperator = groups.includes(OPERATOR_MUTATION_GROUP);
  const isAdmitted = groups.some((group) => OPERATOR_ADMITTED_GROUPS.includes(group));
  if (!isAdmitted) return { allowed: false, reason: "permission_denied" };

  const mutating = OPERATOR_MUTATING_METHODS.includes(candidate);
  if (mutating && !isOperator) return { allowed: false, reason: "permission_denied" };

  if (mutating && context.noteLockState?.locked === true) {
    return { allowed: false, reason: "vault_locked" };
  }

  // Only an explicit refusal denies: an absent policy means the daemon is not
  // enforcing notebook policy at this seam.
  if (context.notebookPolicy?.allow === false) {
    return { allowed: false, reason: "permission_denied" };
  }

  return { allowed: true, method: candidate };
}
