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
import type { OperatorNoteLockState, OperatorNotebookPolicy } from "./operator-policy.js";
import type { SettingsOperation } from "../settings/settings-types.js";
import type { OperatorPeer } from "./operator-server.js";

/**
 * The operator methods that mutate a note.  Reads (`notes.get-view`,
 * `notes.edit-preimage`, `notes.operation-list`, `notes.operation-status`,
 * `notes.browse`, `notes.search-operator`) deliberately stay out: a locked note
 * can still be read and listed, and only mutation is refused.
 *
 * `notes.create` is included: it writes a note, so it needs the operator
 * capability even though it has no existing target to be locked.
 */
export const OPERATOR_MUTATING_METHODS: ReadonlySet<OperatorMethod> = new Set<OperatorMethod>([
  "notes.apply-edit",
  "notes.apply-undo",
  "notes.create",
] satisfies OperatorMethod[]);

/** The published operation-handle shape; matches the write runtime's own token. */
const OPERATION_HANDLE = /^op_[a-f0-9]{64}$/;

/** The handle field a request carries, or `undefined`. */
function requestStringField(
  request: RpcRequest,
  field: "id" | "operationHandle" | "notebookId",
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
  readonly peer: OperatorPeer | undefined;
  readonly resolveHandle: (handle: string, peer?: OperatorPeer) => string | undefined;
  readonly resolveOperationNoteId?:
    | ((
        operationHandle: string,
        peer?: OperatorPeer,
      ) => string | undefined | Promise<string | undefined>)
    | undefined;
}): string | undefined | Promise<string | undefined> {
  const handle = requestStringField(input.request, "id");
  if (handle !== undefined) return input.resolveHandle(handle, input.peer);
  if (input.method !== "notes.apply-undo") return undefined;
  const operationHandle = requestStringField(input.request, "operationHandle");
  if (operationHandle === undefined || !OPERATION_HANDLE.test(operationHandle)) {
    return undefined;
  }
  if (input.resolveOperationNoteId === undefined) return undefined;
  return input.resolveOperationNoteId(operationHandle, input.peer);
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
  readonly peer?: OperatorPeer;
  readonly resolveHandle: (handle: string, peer?: OperatorPeer) => string | undefined;
  readonly resolveOperationNoteId?:
    | ((
        operationHandle: string,
        peer?: OperatorPeer,
      ) => string | undefined | Promise<string | undefined>)
    | undefined;
  readonly readNoteLockState: ((id: string) => Promise<"locked" | "unlocked">) | undefined;
}): Promise<OperatorNoteLockState | undefined> {
  if (input.request === undefined) return undefined;
  if (!OPERATOR_MUTATING_METHODS.has(input.method)) return undefined;
  if (input.readNoteLockState === undefined) return undefined;
  const noteId = await targetNoteId({
    method: input.method,
    request: input.request,
    peer: input.peer,
    resolveHandle: input.resolveHandle,
    resolveOperationNoteId: input.resolveOperationNoteId,
  });
  if (noteId === undefined) return undefined;
  const state = await input.readNoteLockState(noteId);
  return { id: noteId, locked: state === "locked" };
}

/**
 * The settings operation an operator method performs.
 *
 * `read` covers every method that does not change a note — including
 * `edit-preimage`, which only reads the content an edit would replace.  The
 * settings vocabulary is closed at read/edit/create/delete, and the operator
 * surface has no delete verb.
 */
export function settingsOperationForMethod(method: OperatorMethod): SettingsOperation {
  switch (method) {
    case "notes.apply-edit":
    case "notes.apply-undo":
      return "edit";
    case "notes.create":
      return "create";
    default:
      return "read";
  }
}

/**
 * Resolve the notebook policy the evaluator should see for this request.
 *
 * The settings evaluator that already backs the service policy is the source of
 * truth for per-notebook overrides, so the operator seam consults the same
 * engine rather than inventing a second model.
 *
 * Returns `undefined` when there is no notebook context to decide — no target, no
 * path for that target, or a daemon that supplied no source.  A missing context
 * is not an allow decision: the evaluator only refuses on an explicit
 * `allow: false`, and no policy source means the daemon is not enforcing
 * notebook policy at this seam at all.
 */
export async function resolveOperatorRequestNotebookPolicy(input: {
  readonly method: OperatorMethod;
  readonly request: RpcRequest | undefined;
  readonly peer?: OperatorPeer;
  readonly resolveHandle: (handle: string, peer?: OperatorPeer) => string | undefined;
  readonly resolveOperationNoteId?:
    | ((
        operationHandle: string,
        peer?: OperatorPeer,
      ) => string | undefined | Promise<string | undefined>)
    | undefined;
  readonly readNoteNotebookPath: ((noteId: string) => Promise<string | undefined>) | undefined;
  readonly resolveNotebookPath?:
    | ((notebookId: string) => string | undefined | Promise<string | undefined>)
    | undefined;
  readonly evaluateNotebookPolicy:
    | ((operation: SettingsOperation, notebookPath: string) => boolean)
    | undefined;
}): Promise<OperatorNotebookPolicy | undefined> {
  if (input.request === undefined) return undefined;
  if (input.evaluateNotebookPolicy === undefined) return undefined;
  if (input.method === "notes.create") {
    const notebookId = requestStringField(input.request, "notebookId");
    if (notebookId === undefined) {
      return {
        notebookPath: "",
        allow: input.evaluateNotebookPolicy("create", ""),
      };
    }
    if (input.resolveNotebookPath === undefined) return undefined;
    const notebookPath = await input.resolveNotebookPath(notebookId);
    if (notebookPath === undefined) return undefined;
    return {
      notebookPath,
      allow: input.evaluateNotebookPolicy("create", notebookPath),
    };
  }
  if (input.readNoteNotebookPath === undefined) return undefined;
  const noteId = await targetNoteId({
    method: input.method,
    request: input.request,
    peer: input.peer,
    resolveHandle: input.resolveHandle,
    resolveOperationNoteId: input.resolveOperationNoteId,
  });
  if (noteId === undefined) return undefined;
  const notebookPath = await input.readNoteNotebookPath(noteId);
  if (notebookPath === undefined) return undefined;
  return {
    notebookPath,
    allow: input.evaluateNotebookPolicy(settingsOperationForMethod(input.method), notebookPath),
  };
}
