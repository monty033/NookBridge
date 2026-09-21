/**
 * Finding 7 — request-aware operator authorization.
 *
 * The authorization seam used to receive only the method and the peer, so the
 * evaluator could not judge a target it never saw and the only denial it could
 * express was `permission_denied`.  This module resolves the lock context of
 * the target a mutating request names, so the evaluator can refuse a locked
 * note categorically.
 *
 * It is dependency-injected and pure with respect to the daemon: the handle
 * registry and the lock reader are supplied, which keeps the seam testable
 * without a live database.
 */

import type { RpcRequest } from "./rpc-protocol.js";
import type { OperatorMethod } from "./operator-methods.js";
import type { OperatorNoteLockState } from "./operator-policy.js";

/**
 * The operator methods that mutate a note.  Reads (`notes.get-view`,
 * `notes.edit-preimage`, `notes.operation-list`, `notes.operation-status`,
 * `notes.browse`, `notes.search-operator`) deliberately stay out: a locked note
 * can still be read and listed, and only mutation is refused.
 */
export const OPERATOR_MUTATING_METHODS: ReadonlySet<OperatorMethod> = new Set<OperatorMethod>([
  "notes.apply-edit",
  "notes.apply-undo",
] satisfies OperatorMethod[]);

/** The published operation-handle shape; matches the write runtime's own token. */
const OPERATION_HANDLE = /^op_[a-f0-9]{64}$/;

/** The handle field a request carries, or `undefined`. */
function requestStringField(
  request: RpcRequest,
  field: "id" | "operationHandle",
): string | undefined {
  const params = request.params;
  if (params === null || typeof params !== "object") return undefined;
  const value = (params as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The note this request targets, or `undefined` when the request names none.
 *
 * A bare `notes.apply-undo` carries only an opaque operation handle — the note
 * identity lives in the daemon's own committed record — so it is resolved
 * through the operation store rather than skipped.  The handle is matched
 * against the published shape before the store is consulted, so a malformed or
 * forged value never drives a lookup.
 */
function targetNoteId(input: {
  readonly method: OperatorMethod;
  readonly request: RpcRequest;
  readonly resolveHandle: (handle: string) => string | undefined;
  readonly resolveOperationNoteId?:
    | ((operationHandle: string) => string | undefined | Promise<string | undefined>)
    | undefined;
}): string | undefined | Promise<string | undefined> {
  const handle = requestStringField(input.request, "id");
  if (handle !== undefined) return input.resolveHandle(handle);
  if (input.method !== "notes.apply-undo") return undefined;
  const operationHandle = requestStringField(input.request, "operationHandle");
  if (operationHandle === undefined || !OPERATION_HANDLE.test(operationHandle)) {
    return undefined;
  }
  if (input.resolveOperationNoteId === undefined) return undefined;
  return input.resolveOperationNoteId(operationHandle);
}

/**
 * Resolve the lock state the evaluator should see for this request.
 *
 * Returns `undefined` — "no lock context" — unless the method mutates a note and
 * the request names a target that resolves.  A target that does not resolve
 * yields no context: authorization is not the place to report a forged handle,
 * and the dispatch path already answers `not_found` for it.
 */
export async function resolveOperatorRequestLockState(input: {
  readonly method: OperatorMethod;
  readonly request: RpcRequest | undefined;
  readonly resolveHandle: (handle: string) => string | undefined;
  readonly resolveOperationNoteId?:
    | ((operationHandle: string) => string | undefined | Promise<string | undefined>)
    | undefined;
  readonly readNoteLockState: ((id: string) => Promise<"locked" | "unlocked">) | undefined;
}): Promise<OperatorNoteLockState | undefined> {
  if (input.request === undefined) return undefined;
  if (!OPERATOR_MUTATING_METHODS.has(input.method)) return undefined;
  if (input.readNoteLockState === undefined) return undefined;
  const noteId = await targetNoteId({
    method: input.method,
    request: input.request,
    resolveHandle: input.resolveHandle,
    resolveOperationNoteId: input.resolveOperationNoteId,
  });
  if (noteId === undefined) return undefined;
  const state = await input.readNoteLockState(noteId);
  return { id: noteId, locked: state === "locked" };
}
