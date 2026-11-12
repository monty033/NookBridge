/**
 * Stage 5 slice D — the operator-only, read-only `notes.inspect-conflict`.
 *
 * Inspection writes nothing. It resolves the opaque handle, refuses a locked
 * note before any content row is read, then projects the Stage 0 inspector's
 * outcome onto the closed RPC result. Bodies, note ids, and content ids never
 * leave this module.
 *
 * It takes no database mutex. A read that lands during a resolve can only
 * yield a binding that the resolve re-checks under the mutex, so the worst
 * case is a stale binding, which the resolve refuses before any write.
 */

import type {
  NotesnookConflictInspection,
  NotesnookConflictSideFacts,
  NotesnookLocalConflictInspector,
} from "../core/notesnook-local-conflict-projection.js";
import type { RpcConflictSideFacts, RpcNotesConflictInspectResult } from "./rpc-protocol.js";
import type { OperatorPeer } from "./operator-server.js";
import { OperatorWriteError } from "./notes-operator-write-runtime.js";

export interface OperatorConflictInspectRuntimeOptions {
  readonly inspector: NotesnookLocalConflictInspector;
  /** Checked before the inspector runs, so a locked note's content is never read. */
  readonly readNoteLockState: (id: string) => Promise<"locked" | "unlocked">;
  /** Daemon-side opaque handle resolution; raw note ids never cross the socket. */
  readonly resolveHandle: (handle: string, peer: OperatorPeer) => string | undefined;
}

export interface OperatorConflictInspectRuntime {
  readonly inspectConflict: (
    params: Readonly<{ id: string }>,
    peer: OperatorPeer,
  ) => Promise<RpcNotesConflictInspectResult>;
}

export function createOperatorConflictInspectRuntime(
  options: OperatorConflictInspectRuntimeOptions,
): OperatorConflictInspectRuntime {
  async function inspectConflict(
    params: Readonly<{ id: string }>,
    peer: OperatorPeer,
  ): Promise<RpcNotesConflictInspectResult> {
    const noteId = resolveNote(params?.id, peer, options.resolveHandle);

    let lock: "locked" | "unlocked";
    try {
      lock = await options.readNoteLockState(noteId);
    } catch {
      return fail("service_unavailable");
    }
    if (lock === "locked") return fail("vault_locked");
    if (lock !== "unlocked") return fail("service_unavailable");

    let inspection: NotesnookConflictInspection;
    try {
      inspection = await options.inspector.inspectConflict(noteId);
    } catch {
      return fail("service_unavailable");
    }
    return project(inspection);
  }

  return Object.freeze({ inspectConflict });
}

function project(inspection: NotesnookConflictInspection): RpcNotesConflictInspectResult {
  switch (inspection.outcome) {
    case "not-conflicted":
    case "not-found":
      return Object.freeze({ kind: "conflict-inspection", outcome: inspection.outcome });
    case "unreadable":
      return Object.freeze({
        kind: "conflict-inspection",
        outcome: "unreadable",
        local: sideFacts(inspection.local),
        remote: sideFacts(inspection.remote),
      });
    case "inspected":
      return Object.freeze({
        kind: "conflict-inspection",
        outcome: "inspected",
        local: sideFacts(inspection.local),
        remote: sideFacts(inspection.remote),
        sidesEqual: inspection.sidesEqual,
        remoteHasAttachments: inspection.remoteHasAttachments,
        binding: inspection.binding,
      });
    default:
      return fail("service_unavailable");
  }
}

/** Copy the four categorical fields only. Nothing else from the side is forwarded. */
function sideFacts(side: NotesnookConflictSideFacts): RpcConflictSideFacts {
  return Object.freeze({
    present: side.present,
    unlocked: side.unlocked,
    tiptap: side.tiptap,
    byteSize: side.byteSize,
  });
}

function resolveNote(
  id: unknown,
  peer: OperatorPeer,
  resolveHandle: (handle: string, peer: OperatorPeer) => string | undefined,
): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) fail("invalid_request");
  const noteId = resolveHandle(id, peer);
  if (typeof noteId !== "string" || noteId.length === 0) fail("not_found");
  return noteId;
}

function fail(
  code: "invalid_request" | "not_found" | "vault_locked" | "service_unavailable",
): never {
  throw new OperatorWriteError(code);
}
