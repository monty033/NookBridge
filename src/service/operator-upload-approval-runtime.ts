/**
 * S7a-6 — daemon-side operator upload approval.
 *
 * This is deliberately a narrow adapter over the already-owned coordinator.
 * It receives no note identity, title, path, or pending-marker snapshot; the
 * coordinator supplies the bounded count result and persists the approval.
 */

import {
  isNotesnookWriteContractError,
} from "../core/notesnook-write-contract.js";
import type {
  SyncApproveResult,
  SyncBlockingSummary,
  SyncCoordinator,
} from "../core/notesnook-sync-coordinator.js";
import type {
  RpcOperatorApproveUploadParams,
  RpcNotesApproveUploadPreviewResult,
  RpcNotesApproveUploadResponse,
  RpcNotesApproveUploadResult,
} from "./rpc-protocol.js";
import { OperatorWriteError } from "./notes-operator-write-runtime.js";
import type { OperatorPeer } from "./operator-server.js";

export type OperatorUploadApprovalCoordinator = Pick<
  SyncCoordinator,
  "approvePending" | "blockingSummary"
>;

export interface OperatorUploadApprovalRuntime {
  readonly blockingSummary: (peer: OperatorPeer) => Promise<SyncBlockingSummary>;
  readonly approveUpload: (
    params: RpcOperatorApproveUploadParams,
    peer: OperatorPeer,
  ) => Promise<RpcNotesApproveUploadResponse>;
}

/** Build the operator-only approval capability over the shared coordinator. */
export function createOperatorUploadApprovalRuntime(
  coordinator: OperatorUploadApprovalCoordinator,
): OperatorUploadApprovalRuntime {
  if (
    coordinator === null ||
    typeof coordinator !== "object" ||
    typeof coordinator.approvePending !== "function" ||
    typeof coordinator.blockingSummary !== "function"
  ) {
    throw new TypeError("upload approval coordinator is unavailable");
  }

  return Object.freeze({
    blockingSummary: async (peer: OperatorPeer): Promise<SyncBlockingSummary> => {
      requirePeer(peer);
      try {
        return coordinator.blockingSummary();
      } catch {
        throw new OperatorWriteError("service_unavailable");
      }
    },
    approveUpload: async (
      params: RpcOperatorApproveUploadParams,
      peer: OperatorPeer,
    ): Promise<RpcNotesApproveUploadResponse> => {
      requirePeer(peer);
      try {
        if (params === null || typeof params !== "object" || Array.isArray(params)) {
          throw new OperatorWriteError("invalid_request");
        }
        if (!Object.prototype.hasOwnProperty.call(params, "throughSequence")) {
          return toPreviewResult(coordinator.blockingSummary());
        }
        const throughSequence = params.throughSequence;
        if (
          typeof throughSequence !== "number" ||
          !Number.isSafeInteger(throughSequence) ||
          throughSequence < 1
        ) {
          throw new OperatorWriteError("invalid_request");
        }
        const result = coordinator.approvePending({ throughSequence });
        return toResult(result);
      } catch (error) {
        if (error instanceof OperatorWriteError) throw error;
        if (isNotesnookWriteContractError(error)) {
          throw new OperatorWriteError(error.code === "sync_failed" ? "sync_failed" : "invalid_request");
        }
        throw new OperatorWriteError("service_unavailable");
      }
    },
  });
}

function toResult(result: SyncApproveResult): RpcNotesApproveUploadResult {
  if (
    result === null ||
    typeof result !== "object" ||
    !Number.isSafeInteger(result.approved) ||
    result.approved < 0 ||
    !Number.isSafeInteger(result.throughSequence) ||
    result.throughSequence < 1
  ) {
    throw new OperatorWriteError("service_unavailable");
  }
  return Object.freeze({
    kind: "approve-upload" as const,
    approved: result.approved,
    throughSequence: result.throughSequence,
  });
}

function toPreviewResult(result: SyncBlockingSummary): RpcNotesApproveUploadPreviewResult {
  if (
    result === null ||
    typeof result !== "object" ||
    !Number.isSafeInteger(result.total) ||
    result.total < 0 ||
    result.highestSequence !== null &&
      (!Number.isSafeInteger(result.highestSequence) || result.highestSequence < 1)
  ) {
    throw new OperatorWriteError("service_unavailable");
  }
  const byOperation = result.byOperation;
  const byOrigin = result.byOrigin;
  if (
    byOperation === null ||
    typeof byOperation !== "object" ||
    byOrigin === null ||
    typeof byOrigin !== "object" ||
    !isNonNegativeCount(byOperation.create) ||
    !isNonNegativeCount(byOperation.append) ||
    !isNonNegativeCount(byOperation.update) ||
    !isNonNegativeCount(byOperation.delete) ||
    !isNonNegativeCount(byOrigin.operator) ||
    !isNonNegativeCount(byOrigin.unknown)
  ) {
    throw new OperatorWriteError("service_unavailable");
  }
  return Object.freeze({
    kind: "approve-upload-preview" as const,
    total: result.total,
    byOperation: Object.freeze({
      create: byOperation.create,
      append: byOperation.append,
      update: byOperation.update,
      delete: byOperation.delete,
    }),
    byOrigin: Object.freeze({
      operator: byOrigin.operator,
      unknown: byOrigin.unknown,
    }),
    highestSequence: result.highestSequence,
  });
}

function isNonNegativeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requirePeer(peer: OperatorPeer): asserts peer is OperatorPeer {
  if (
    peer === null ||
    typeof peer !== "object" ||
    !Number.isSafeInteger(peer.uid) ||
    peer.uid < 0 ||
    !Number.isSafeInteger(peer.gid) ||
    peer.gid < 0 ||
    !Array.isArray(peer.groups) ||
    !peer.groups.every((group) => typeof group === "string")
  ) {
    throw new OperatorWriteError("permission_denied");
  }
}
