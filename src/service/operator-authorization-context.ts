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

/** The handle field a mutating request carries, or `undefined`. */
function requestHandle(request: RpcRequest): string | undefined {
  const params = request.params;
  if (params === null || typeof params !== "object") return undefined;
  const id = (params as { readonly id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Resolve the lock state the evaluator should see for this request.
 *
 * Returns `undefined` — "no lock context" — unless the method mutates a note and
 * the request names a handle the registry can resolve.  A handle that does not
 * resolve yields no context: authorization is not the place to report a forged
 * handle, and the dispatch path already answers `not_found` for it.
 */
export async function resolveOperatorRequestLockState(input: {
  readonly method: OperatorMethod;
  readonly request: RpcRequest | undefined;
  readonly resolveHandle: (handle: string) => string | undefined;
  readonly readNoteLockState: ((id: string) => Promise<"locked" | "unlocked">) | undefined;
}): Promise<OperatorNoteLockState | undefined> {
  if (input.request === undefined) return undefined;
  if (!OPERATOR_MUTATING_METHODS.has(input.method)) return undefined;
  const handle = requestHandle(input.request);
  if (handle === undefined) return undefined;
  const noteId = input.resolveHandle(handle);
  if (noteId === undefined) return undefined;
  if (input.readNoteLockState === undefined) return undefined;
  const state = await input.readNoteLockState(noteId);
  return { id: noteId, locked: state === "locked" };
}
