import type {
  RpcAnyResponseEnvelope,
  RpcCreatedNoteResult,
  RpcErrorCode,
  RpcNotesApplyEditResult,
  RpcNotesApplyUndoResult,
  RpcNotesEditPreimageResult,
  RpcNotesOperationListResult,
  RpcNotesOperationStatusResult,
  RpcRequest,
} from "./rpc-protocol.js";
import { RPC_ERROR_MESSAGES } from "./rpc-protocol.js";
import { isNotesnookReadOnlyProjectionError } from "../core/notesnook-readonly-projection.js";
import { OperatorWriteError } from "./notes-operator-write-runtime.js";
import type { NotesnookListKind } from "../core/notesnook-write-list-intent.js";
import type { OperatorSocketHandler } from "./operator-socket-server.js";
import type { OperatorPeer } from "./operator-server.js";

export interface OperatorDiscoveryPage {
  readonly notes: ReadonlyArray<Readonly<{ handle: string; label: string; bytes: number }>>;
  readonly next: string | null;
}

export interface OperatorNoteView {
  readonly id: string;
  readonly revision: string;
  readonly markdown: string;
  readonly contentBytes: number;
}

export interface OperatorDiscoveryRuntime {
  readonly browse: (
    params: Readonly<{ cursor?: string; limit?: number }>,
    peer?: OperatorPeer,
  ) => Promise<OperatorDiscoveryPage>;
  readonly search: (
    params: Readonly<{ query: string; cursor?: string; limit?: number }>,
    peer?: OperatorPeer,
  ) => Promise<OperatorDiscoveryPage>;
  readonly view?: (
    params: Readonly<{ id: string }>,
    peer?: OperatorPeer,
  ) => Promise<OperatorNoteView>;
  readonly editPreimage?: (
    params: Readonly<{ id: string }>,
    peer?: OperatorPeer,
  ) => Promise<RpcNotesEditPreimageResult>;
  readonly applyEdit?: (
    params: Readonly<{ id: string; expectedRevision: string; markdown: string }>,
    peer?: OperatorPeer,
  ) => Promise<RpcNotesApplyEditResult>;
  readonly applyUndo?: (
    params: Readonly<{ id?: string; operationHandle: string; expectedRevision?: string }>,
    peer?: OperatorPeer,
  ) => Promise<RpcNotesApplyUndoResult>;
  readonly operationStatus?: (
    params: Readonly<{ operationHandle: string }>,
    peer?: OperatorPeer,
  ) => Promise<RpcNotesOperationStatusResult>;
  readonly operationList?: (peer?: OperatorPeer) => Promise<RpcNotesOperationListResult>;
  readonly create?: (
    params: Readonly<{
      title: string;
      content: string;
      notebookId?: string;
      listKind?: NotesnookListKind;
    }>,
    peer?: OperatorPeer,
  ) => Promise<RpcCreatedNoteResult>;
}

/** Build the bounded discovery portion of the daemon operator handler. */
export function createOperatorDiscoveryHandler(
  runtime: OperatorDiscoveryRuntime,
): OperatorSocketHandler {
  return async (request: RpcRequest, peer: OperatorPeer): Promise<RpcAnyResponseEnvelope> => {
    try {
      if (request.method === "notes.browse") {
        const result = await runtime.browse(request.params, peer);
        return success(request.id, result);
      }
      if (request.method === "notes.search-operator") {
        const result = await runtime.search(request.params, peer);
        return success(request.id, result);
      }
      if (request.method === "notes.get-view") {
        if (runtime.view === undefined) return failure(request.id, "service_unavailable");
        return viewSuccess(request.id, await runtime.view(request.params, peer));
      }
      if (request.method === "notes.edit-preimage") {
        if (runtime.editPreimage === undefined) return failure(request.id, "service_unavailable");
        return mutationSuccess(request.id, await runtime.editPreimage(request.params, peer));
      }
      if (request.method === "notes.apply-edit") {
        if (runtime.applyEdit === undefined) return failure(request.id, "service_unavailable");
        return mutationSuccess(request.id, await runtime.applyEdit(request.params, peer));
      }
      if (request.method === "notes.apply-undo") {
        if (runtime.applyUndo === undefined) return failure(request.id, "service_unavailable");
        return mutationSuccess(request.id, await runtime.applyUndo(request.params, peer));
      }
      if (request.method === "notes.operation-status") {
        if (runtime.operationStatus === undefined)
          return failure(request.id, "service_unavailable");
        return mutationSuccess(request.id, await runtime.operationStatus(request.params, peer));
      }
      if (request.method === "notes.operation-list") {
        if (runtime.operationList === undefined) return failure(request.id, "service_unavailable");
        return mutationSuccess(request.id, await runtime.operationList(peer));
      }
      if (request.method === "notes.create") {
        if (runtime.create === undefined) return failure(request.id, "service_unavailable");
        return mutationSuccess(request.id, await runtime.create(request.params, peer));
      }
      return failure(request.id, "invalid_request");
    } catch (error) {
      return failure(request.id, categoricalCode(error));
    }
  };
}

function success(id: string, page: OperatorDiscoveryPage): RpcAnyResponseEnvelope {
  return {
    id,
    ok: true,
    result: {
      kind: "operator-page",
      notes: page.notes,
      next: page.next,
    },
  } as RpcAnyResponseEnvelope;
}

function viewSuccess(id: string, view: OperatorNoteView): RpcAnyResponseEnvelope {
  return {
    id,
    ok: true,
    result: { kind: "view", ...view },
  } as RpcAnyResponseEnvelope;
}

function mutationSuccess(
  id: string,
  result:
    | RpcNotesEditPreimageResult
    | RpcNotesApplyEditResult
    | RpcNotesApplyUndoResult
    | RpcNotesOperationStatusResult
    | RpcNotesOperationListResult
    | RpcCreatedNoteResult,
): RpcAnyResponseEnvelope {
  return { id, ok: true, result } as RpcAnyResponseEnvelope;
}

/**
 * Map a thrown runtime failure onto the closed RPC error vocabulary.
 *
 * `serializeRpcResponse` only accepts the fixed message for each code,
 * so producers must never invent an error string.  A runtime that wants
 * a specific category throws an error carrying a `code` property from
 * the closed set; anything else collapses to `service_unavailable`.
 */
function categoricalCode(error: unknown): RpcErrorCode {
  // Trust must come from identity, not from a field.  Accepting any thrown
  // object whose `code` matched the vocabulary let an unrelated upstream error
  // carrying `code: "vault_locked"` (or any other category) be reported to the
  // operator as that category.
  if (error instanceof OperatorWriteError) return error.code;
  if (error !== null && typeof error === "object") {
    // A projection refusal carries the vocabulary name as its MESSAGE rather
    // than as a `code` property.  Only a class-identity-checked projection error
    // may be read that way: accepting any thrown object whose message happened
    // to equal a vocabulary word let an unrelated upstream error be reported to
    // the operator as `not_found` or `permission_denied`.
    if (isNotesnookReadOnlyProjectionError(error)) {
      const message = (error as { readonly message?: unknown }).message;
      if (typeof message === "string" && Object.hasOwn(RPC_ERROR_MESSAGES, message)) {
        return message as RpcErrorCode;
      }
    }
  }
  return "service_unavailable";
}

function failure(id: string, code: RpcErrorCode): RpcAnyResponseEnvelope {
  return {
    id,
    ok: false,
    error: { code, message: RPC_ERROR_MESSAGES[code] },
  } as RpcAnyResponseEnvelope;
}
