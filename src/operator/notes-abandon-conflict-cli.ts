/**
 * #316 — operator-only `nookctl notes abandon-conflict --handle <h>`.
 *
 * Closes the one unresolved keep-both attempt for a note. It is a confirmation-gated
 * client of `notes.abandon-resolve`: it sends the opaque handle and the exact phrase
 * `ABANDON`, and prints the closed outcome.
 *
 * It never sends a binding, never syncs, never uploads, and prints no note id, body,
 * path or digest. The daemon writes nothing to the note; the owner inspects both notes
 * before approving any upload.
 */

import process from "node:process";
import { TextEncoder } from "node:util";

import { isBoundedOpaqueValue } from "./notes-cli.js";
import { askLine } from "./notes-resolve-conflict-cli.js";
import { OperatorSocketClient } from "./operator-socket-client.js";
import { isInteractiveTty, type NotesUndoPromptStreams } from "./notes-undo-prompt.js";
import { CONFLICT_ABANDON_CONFIRMATION, STAGE5_RPC_LIMITS } from "../service/rpc-protocol.js";

export const ABANDON_CONFLICT_CONFIRMATION = CONFLICT_ABANDON_CONFIRMATION;

export const ABANDON_CONFLICT_PROMPT = `Type ${ABANDON_CONFLICT_CONFIRMATION} to close this attempt, or press Enter to cancel: `;

const SOCKET_PATH = "/run/nookbridge/operator.sock";
// eslint-disable-next-line no-control-regex -- rejecting C0 control characters is the intent here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const NO_SKIP_MESSAGE =
  "nookctl notes abandon-conflict: unsupported option; there is no flag that skips confirmation";
const INVALID_MESSAGE = "nookctl notes abandon-conflict: invalid command input";
const REQUIRES_HANDLE = "nookctl notes abandon-conflict: requires --handle <opaque-handle>";

/** Daemon refusals with a categorical name. Anything else is an unavailable service. */
const SOCKET_REFUSAL_NAMES: ReadonlyMap<string, string> = new Map([
  ["permission_denied", "denied"],
  ["invalid_request", "invalid-input"],
  ["not_found", "missing"],
]);

export type AbandonConflictParseResult =
  | Readonly<{ kind: "parsed"; handle: string }>
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "error"; message: string }>;

export interface AbandonConflictWriter {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface AbandonConflictParams {
  readonly id: string;
  readonly confirmation: typeof ABANDON_CONFLICT_CONFIRMATION;
}

/**
 * Injected seams. `confirm` is optional so a missing seam refuses instead of assuming
 * yes. Values come back unvalidated and are validated here, so the daemon's free text
 * never reaches the output.
 */
export interface AbandonConflictPorts {
  readonly interactive: boolean;
  readonly confirm?: ((prompt: string) => Promise<string | undefined>) | undefined;
  readonly abandon: (params: AbandonConflictParams) => Promise<unknown>;
}

export function parseAbandonConflictArgs(argv: readonly string[]): AbandonConflictParseResult {
  if (!Array.isArray(argv)) return { kind: "error", message: INVALID_MESSAGE };
  if (argv.length === 1 && (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h")) {
    return { kind: "help" };
  }
  let handle: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--handle") {
      const value = argv[index + 1];
      if (handle !== undefined || typeof value !== "string") {
        return { kind: "error", message: INVALID_MESSAGE };
      }
      if (value.startsWith("--") || !isBoundedOpaqueValue(value)) {
        return { kind: "error", message: INVALID_MESSAGE };
      }
      handle = value;
      index += 1;
      continue;
    }
    if (typeof token === "string" && token.startsWith("--")) {
      return { kind: "error", message: NO_SKIP_MESSAGE };
    }
    return { kind: "error", message: INVALID_MESSAGE };
  }
  if (handle === undefined) return { kind: "error", message: REQUIRES_HANDLE };
  return { kind: "parsed", handle };
}

export function formatAbandonConflictHelp(): string {
  return [
    "usage:",
    "  nookctl notes abandon-conflict --handle <opaque-handle>",
    "",
    "Closes the unresolved keep-both attempt for a note (TTY, typed confirmation).",
    "Writes nothing to the note and deletes nothing. The original is queued for upload",
    "approval when its content may have been overwritten. Inspect both notes before",
    "approving any upload.",
    "",
  ].join("\n");
}

export async function runAbandonConflict(
  argv: readonly string[],
  ports: AbandonConflictPorts,
  writer: AbandonConflictWriter,
): Promise<number> {
  const parsed = parseAbandonConflictArgs(argv);
  if (parsed.kind === "help") {
    writer.stdout(formatAbandonConflictHelp());
    return 0;
  }
  if (parsed.kind === "error") {
    writer.stderr(`${parsed.message}\n`);
    return 2;
  }

  // Refuse before any socket call when a human cannot confirm.
  if (ports.interactive !== true || typeof ports.confirm !== "function") {
    writer.stderr(
      "nookctl notes abandon-conflict: requires an interactive terminal; nothing was changed\n",
    );
    return 2;
  }

  let answer: string | undefined;
  try {
    answer = await ports.confirm(ABANDON_CONFLICT_PROMPT);
  } catch {
    answer = undefined;
  }
  if (answer !== ABANDON_CONFLICT_CONFIRMATION) {
    writer.stdout("nookctl notes abandon-conflict: cancelled\n");
    return 1;
  }

  let raw: unknown;
  try {
    raw = await ports.abandon({ id: parsed.handle, confirmation: ABANDON_CONFLICT_CONFIRMATION });
  } catch {
    writer.stdout("nookctl notes abandon-conflict: service_unavailable\n");
    return 3;
  }
  const report = describeAbandon(raw);
  writer.stdout(report.text);
  return report.exitCode;
}

/** Production entry: the operator's terminal plus the operator socket. */
export async function runAbandonConflictFromTerminal(argv: readonly string[]): Promise<number> {
  const streams = { input: process.stdin, output: process.stdout };
  return runAbandonConflict(argv, createProductionAbandonConflictPorts(streams), {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  });
}

/** Production ports. The client is injectable so a test can stand in for the socket. */
export function createProductionAbandonConflictPorts(
  streams: NotesUndoPromptStreams,
  client: Pick<OperatorSocketClient, "request"> = new OperatorSocketClient({
    socketPath: SOCKET_PATH,
  }),
): AbandonConflictPorts {
  return Object.freeze({
    interactive: isInteractiveTty(streams),
    confirm: (prompt: string) => askLine(streams, prompt),
    abandon: (params: AbandonConflictParams) =>
      client.request("notes.abandon-resolve", {
        id: params.id,
        confirmation: params.confirmation,
      }),
  });
}

// ---------------------------------------------------------------------------
// Verdict reader. Only the closed fields are kept.
// ---------------------------------------------------------------------------

type AbandonVerdict =
  | Readonly<{ kind: "abandoned"; originalTitle: unknown; copyTitle: unknown }>
  | Readonly<{ kind: "socket"; code: string }>
  | Readonly<{ kind: "invalid" }>;

function readAbandon(raw: unknown): AbandonVerdict {
  try {
    if (!isRecord(raw)) return { kind: "invalid" };
    if (raw.ok === false) {
      return { kind: "socket", code: typeof raw.code === "string" ? raw.code : "" };
    }
    if (
      raw.ok !== true ||
      !isRecord(raw.result) ||
      raw.result.kind !== "conflict-abandon" ||
      raw.result.outcome !== "abandoned"
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "abandoned",
      originalTitle: raw.result.originalTitle,
      copyTitle: raw.result.copyTitle,
    };
  } catch {
    return { kind: "invalid" };
  }
}

interface AbandonReport {
  readonly exitCode: 0 | 1 | 3;
  readonly text: string;
}

function describeAbandon(raw: unknown): AbandonReport {
  const verdict = readAbandon(raw);
  switch (verdict.kind) {
    case "abandoned": {
      if (!displayableTitle(verdict.originalTitle) || !displayableTitle(verdict.copyTitle)) {
        return {
          exitCode: 0,
          text: [
            "nookctl notes abandon-conflict: abandoned",
            "titles: withheld",
            "uploaded: no",
            "next: inspect both notes before approving any upload",
            "",
          ].join("\n"),
        };
      }
      return {
        exitCode: 0,
        text: [
          "nookctl notes abandon-conflict: abandoned",
          `original: ${verdict.originalTitle}`,
          `copy: ${verdict.copyTitle}`,
          "uploaded: no",
          "next: inspect both notes before approving any upload",
          "",
        ].join("\n"),
      };
    }
    case "socket": {
      const name = SOCKET_REFUSAL_NAMES.get(verdict.code);
      if (name !== undefined) {
        return { exitCode: 1, text: `nookctl notes abandon-conflict: ${name}\n` };
      }
      return {
        exitCode: 3,
        text: "nookctl notes abandon-conflict: service_unavailable\n",
      };
    }
    case "invalid":
      return { exitCode: 3, text: "nookctl notes abandon-conflict: invalid_response\n" };
  }
}

function displayableTitle(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (CONTROL_CHARACTERS.test(value)) return false;
  return new TextEncoder().encode(value).byteLength <= STAGE5_RPC_LIMITS.maxTitleBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
