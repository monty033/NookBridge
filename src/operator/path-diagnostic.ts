import { Buffer } from "node:buffer";

import { NookdSocketClient } from "../mcp/socket-client.js";
import type { RpcNotesPathDiagnosticResult } from "../service/rpc-protocol.js";
import { readSafeOperatorEnvironment } from "./production-runtime.js";

export type PathDiagnosticReport = Readonly<Omit<RpcNotesPathDiagnosticResult, "kind">>;

export type PathDiagnosticRuntime = Readonly<{
  readonly pathDiagnostic: (path: string) => Promise<RpcNotesPathDiagnosticResult>;
}>;

const SOCKET_PATH = "/run/nookbridge/nookbridge.sock";
const MAX_PATH_BYTES = 512;

function unavailable(pathBytes: number): PathDiagnosticReport {
  return Object.freeze({
    pathBytes,
    title: "unavailable",
    notebook: "unavailable",
    directMembership: "unavailable",
    recursiveMembership: "unavailable",
    revision: "unavailable",
  });
}

export async function runPathDiagnostic(
  path: unknown,
  runtime: PathDiagnosticRuntime,
): Promise<PathDiagnosticReport> {
  if (typeof path !== "string") return unavailable(0);
  const pathBytes = Buffer.byteLength(path, "utf8");
  if (path.length === 0 || pathBytes > MAX_PATH_BYTES || hasControlCharacter(path)) {
    return unavailable(pathBytes);
  }
  try {
    const result = await runtime.pathDiagnostic(path);
    if (
      result.kind !== "path_diagnostic" ||
      result.pathBytes !== pathBytes ||
      !isTitle(result.title) ||
      !isStage(result.notebook) ||
      !isStage(result.directMembership) ||
      !isStage(result.recursiveMembership) ||
      !isRevision(result.revision)
    ) {
      return unavailable(pathBytes);
    }
    return Object.freeze({
      pathBytes,
      title: result.title,
      notebook: result.notebook,
      directMembership: result.directMembership,
      recursiveMembership: result.recursiveMembership,
      revision: result.revision,
    });
  } catch {
    return unavailable(pathBytes);
  }
}

export function formatPathDiagnostic(report: PathDiagnosticReport): string {
  return JSON.stringify(report);
}

export async function createProductionPathDiagnosticRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<{ runtime: PathDiagnosticRuntime; cleanup: () => void }>> {
  readSafeOperatorEnvironment(environment);
  const client = new NookdSocketClient({ socketPath: SOCKET_PATH });
  return {
    runtime: Object.freeze({
      pathDiagnostic: async (path: string): Promise<RpcNotesPathDiagnosticResult> => {
        const response = await client.pathDiagnostic({ path });
        if (!response.ok) throw new Error("diagnostic response unavailable");
        const result = response.envelope.result;
        if (result.kind !== "path_diagnostic") throw new Error("diagnostic response unavailable");
        return result;
      },
    }),
    cleanup: () => undefined,
  };
}

function isTitle(value: unknown): value is PathDiagnosticReport["title"] {
  return value === "none" || value === "one" || value === "multiple" || value === "unavailable";
}

function isStage(value: unknown): value is PathDiagnosticReport["notebook"] {
  return (
    value === "present" ||
    value === "absent" ||
    value === "unavailable" ||
    value === "not_applicable"
  );
}

function isRevision(value: unknown): value is PathDiagnosticReport["revision"] {
  return (
    value === "valid" ||
    value === "invalid" ||
    value === "unavailable" ||
    value === "not_applicable"
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
