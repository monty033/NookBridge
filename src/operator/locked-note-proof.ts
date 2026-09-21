import { Buffer } from "node:buffer";

import { NookdSocketClient } from "../mcp/socket-client.js";
import type { RpcLockedNoteProofResult } from "../service/rpc-protocol.js";
import { readSafeOperatorEnvironment } from "./production-runtime.js";

export type LockedNoteProofCode = RpcLockedNoteProofResult["read"];
export type LockedNoteProofReport = Readonly<{
  readonly pathBytes: number;
  readonly read: LockedNoteProofCode;
  readonly update: LockedNoteProofCode;
  readonly delete: LockedNoteProofCode;
}>;

export type LockedNoteProofRuntime = Readonly<{
  readonly lockedNoteProof: (path: string) => Promise<RpcLockedNoteProofResult>;
}>;

const SOCKET_PATH = "/run/nookbridge/nookbridge.sock";
const MAX_PATH_BYTES = 512;
const SERVICE_UNAVAILABLE: LockedNoteProofReport = Object.freeze({
  pathBytes: 0,
  read: "service_unavailable",
  update: "service_unavailable",
  delete: "service_unavailable",
});

/**
 * Run the categorical acceptance proof without opening Notesnook locally.
 * The only production capability is the closed daemon RPC.
 */
export async function runLockedNoteProof(
  path: unknown,
  runtime: LockedNoteProofRuntime,
): Promise<LockedNoteProofReport> {
  if (typeof path !== "string") return SERVICE_UNAVAILABLE;
  const pathBytes = Buffer.byteLength(path, "utf8");
  if (path.length === 0 || pathBytes > MAX_PATH_BYTES || hasControlCharacter(path)) {
    return Object.freeze({
      pathBytes,
      read: "service_unavailable",
      update: "service_unavailable",
      delete: "service_unavailable",
    });
  }

  try {
    const result = await runtime.lockedNoteProof(path);
    if (
      result.kind !== "locked_note_proof" ||
      result.pathBytes !== pathBytes ||
      !isProofCode(result.read) ||
      !isProofCode(result.update) ||
      !isProofCode(result.delete)
    ) {
      return Object.freeze({
        pathBytes,
        read: "service_unavailable",
        update: "service_unavailable",
        delete: "service_unavailable",
      });
    }
    return Object.freeze({
      pathBytes,
      read: result.read,
      update: result.update,
      delete: result.delete,
    });
  } catch {
    return Object.freeze({
      pathBytes,
      read: "service_unavailable",
      update: "service_unavailable",
      delete: "service_unavailable",
    });
  }
}

export function formatLockedNoteProof(report: LockedNoteProofReport): string {
  return JSON.stringify(report);
}

/**
 * Map a closed daemon error code onto a categorical proof code.
 *
 * Only `not_found` used to survive this mapping.  Every other code — including
 * a categorical `vault_locked` — collapsed to `service_unavailable`, so a lock
 * refusal was indistinguishable from a broken daemon and the acceptance proof
 * could never demonstrate that the lock was actually enforced.  Codes that
 * carry no categorical meaning still report as unavailable.
 */
export function lockedNoteProofCodeForError(code: unknown): LockedNoteProofCode {
  switch (code) {
    case "vault_locked":
      return "vault_locked";
    case "not_found":
      return "not_found";
    case "permission_denied":
      return "permission_denied";
    default:
      return "service_unavailable";
  }
}

/** Construct the operator facade over the already-running nookd daemon. */
export async function createProductionLockedNoteProofRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<{ runtime: LockedNoteProofRuntime; cleanup: () => void }>> {
  readSafeOperatorEnvironment(environment);
  const client = new NookdSocketClient({ socketPath: SOCKET_PATH });
  return {
    runtime: Object.freeze({
      lockedNoteProof: async (path: string): Promise<RpcLockedNoteProofResult> => {
        const response = await client.lockedNoteProof({ path });
        if (!response.ok) {
          const code = lockedNoteProofCodeForError(response.code);
          return Object.freeze({
            kind: "locked_note_proof",
            pathBytes: Buffer.byteLength(path, "utf8"),
            read: code,
            update: code,
            delete: code,
          });
        }
        const result = response.envelope.result;
        if (result.kind !== "locked_note_proof") {
          throw new Error("proof response unavailable");
        }
        return result;
      },
    }),
    cleanup: () => undefined,
  };
}

function isProofCode(value: unknown): value is LockedNoteProofCode {
  return (
    value === "vault_locked" ||
    value === "ok" ||
    value === "not_found" ||
    value === "permission_denied" ||
    value === "service_unavailable"
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
