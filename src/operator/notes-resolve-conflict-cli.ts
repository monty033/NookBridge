/**
 * Stage 5 slice C — operator-only `nookctl notes resolve-conflict --handle <h>`.
 *
 * The command is a confirmation-gated client of `notes.resolve-conflict`:
 *
 *   1. it inspects the conflicted note and PRINTS the side facts and the
 *      binding the operator is about to keep both of;
 *   2. it requires the exact typed phrase `KEEP BOTH` on an interactive
 *      terminal.  No flag skips this, and a non-interactive invocation is
 *      refused before anything is read or sent;
 *   3. it sends the opaque handle and the printed binding, and prints the
 *      closed categorical outcome.  Titles are printed only for `resolved`.
 *
 * It never syncs, never uploads, and never prints a note id, body, path, or
 * digest other than the binding.  Every output is built from fixed text plus
 * the categorical fields below; the daemon's free text is never echoed.
 *
 * Inspection source: the daemon's read-only `notes.inspect-conflict`, over the
 * operator socket.  This command never opens the database.
 */

import process from "node:process";
import { createInterface } from "node:readline";
import { TextEncoder } from "node:util";

import { OperatorSocketClient } from "./operator-socket-client.js";
import { isBoundedOpaqueValue } from "./notes-cli.js";
import { isInteractiveTty, type NotesUndoPromptStreams } from "./notes-undo-prompt.js";
import { CONFLICT_RESOLVE_CLOSED_OUTCOMES, STAGE5_RPC_LIMITS } from "../service/rpc-protocol.js";

/** The exact phrase the operator must type.  Anything else cancels. */
export const RESOLVE_CONFLICT_CONFIRMATION = "KEEP BOTH" as const;

export const RESOLVE_CONFLICT_PROMPT = `Type ${RESOLVE_CONFLICT_CONFIRMATION} to keep both, or press Enter to cancel: `;

const SOCKET_PATH = "/run/nookbridge/operator.sock";
const BINDING_PATTERN = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex -- rejecting C0 control characters is the intent here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const NO_SKIP_MESSAGE =
  "nookctl notes resolve-conflict: unsupported option; there is no flag that skips confirmation";
const INVALID_MESSAGE = "nookctl notes resolve-conflict: invalid command input";

/**
 * Daemon socket refusals that map to a categorical name.  Anything else is an
 * unavailable service: a failure we cannot classify is never reported as a
 * refusal.
 */
const SOCKET_REFUSAL_NAMES: ReadonlyMap<string, string> = new Map([
  ["permission_denied", "denied"],
  ["invalid_request", "invalid-input"],
  ["not_found", "missing"],
  ["vault_locked", "locked"],
  ["stale_revision", "stale_revision"],
  ["conflict", "conflict"],
]);

export type ResolveConflictParseResult =
  | Readonly<{ kind: "parsed"; handle: string }>
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "error"; message: string }>;

export interface ResolveConflictWriter {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface ResolveConflictParams {
  readonly id: string;
  readonly binding: string;
}

/**
 * Injected seams.  `inspect` and `confirm` are optional so a missing seam
 * refuses instead of assuming yes; `resolve` is always present.  Values are
 * returned unvalidated and validated here, so a hostile seam cannot push
 * unexpected text into the output.
 */
export interface ResolveConflictPorts {
  readonly interactive: boolean;
  readonly inspect?: ((handle: string) => Promise<unknown>) | undefined;
  readonly confirm?: ((prompt: string) => Promise<string | undefined>) | undefined;
  readonly resolve: (params: ResolveConflictParams) => Promise<unknown>;
}

export function parseResolveConflictArgs(argv: readonly string[]): ResolveConflictParseResult {
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
  if (handle === undefined) {
    return {
      kind: "error",
      message: "nookctl notes resolve-conflict: requires --handle <opaque-handle>",
    };
  }
  return { kind: "parsed", handle };
}

export function formatResolveConflictHelp(): string {
  return [
    "nookctl notes resolve-conflict — keep both sides of a conflicted note (operator-only)",
    "",
    "Usage:",
    "  nookctl notes resolve-conflict --handle <opaque-handle>",
    "  nookctl notes resolve-conflict help",
    "",
    "What it does:",
    "  1. Inspects the conflicted note and prints the side facts and binding.",
    `  2. Asks you to type ${RESOLVE_CONFLICT_CONFIRMATION}. Any other answer cancels with no change.`,
    "  3. The original note adopts the remote side. One copy keeps the bridge-local side.",
    "",
    "Notes:",
    "  - It requires an interactive terminal. A pipe or script is refused, and no",
    "    flag skips the typed confirmation.",
    "  - It does not sync or upload anything. Both notes stay in place on this device,",
    "    and the copy is pending locally.",
    "  - To upload, run `nookctl notes approve-upload` and then the explicit sync path,",
    "    after checking both notes. Nothing else uploads the change.",
    "  - It prints no note id, body, path, or digest other than the binding.",
    "",
  ].join("\n");
}

/**
 * Run the command.  Returns the process exit code and writes every line
 * through `writer`:
 *
 *   0  resolved
 *   1  refused, cancelled, or the note is not in a resolvable state
 *   2  usage, or no interactive terminal (nothing was read or sent)
 *   3  inspection or service unavailable, or an invalid response
 */
export async function runResolveConflict(
  argv: readonly string[],
  ports: ResolveConflictPorts,
  writer: ResolveConflictWriter,
): Promise<number> {
  const parsed = parseResolveConflictArgs(argv);
  if (parsed.kind === "help") {
    writer.stdout(formatResolveConflictHelp());
    return 0;
  }
  if (parsed.kind === "error") {
    writer.stderr(`${parsed.message}\n`);
    return 2;
  }

  // Refuse before any read or socket call when a human cannot confirm.
  if (ports.interactive !== true || typeof ports.confirm !== "function") {
    writer.stderr(
      "nookctl notes resolve-conflict: requires an interactive terminal; nothing was changed\n",
    );
    return 2;
  }
  if (typeof ports.inspect !== "function") {
    writer.stderr("nookctl notes resolve-conflict: inspection unavailable; nothing was changed\n");
    return 3;
  }

  let inspectionRaw: unknown;
  try {
    inspectionRaw = await ports.inspect(parsed.handle);
  } catch {
    writer.stderr("nookctl notes resolve-conflict: inspection unavailable; nothing was changed\n");
    return 3;
  }
  const inspection = readInspection(inspectionRaw);
  if (inspection.kind === "invalid") {
    writer.stderr("nookctl notes resolve-conflict: invalid_response; nothing was changed\n");
    return 3;
  }
  if (inspection.kind === "socket") {
    const name = SOCKET_REFUSAL_NAMES.get(inspection.code);
    if (name === undefined) {
      writer.stderr("nookctl notes resolve-conflict: service_unavailable; nothing was changed\n");
      return 3;
    }
    writer.stdout(`nookctl notes resolve-conflict: ${name}\n`);
    return 1;
  }
  if (inspection.kind === "unreadable") {
    writer.stdout(
      [
        "nookctl notes resolve-conflict: unreadable",
        ...sideLines(inspection.local, inspection.remote),
        "",
      ].join("\n"),
    );
    return 1;
  }
  if (inspection.kind !== "inspected") {
    writer.stdout(`nookctl notes resolve-conflict: ${inspection.kind}\n`);
    return 1;
  }

  writer.stdout(formatInspected(inspection));

  let answer: string | undefined;
  try {
    answer = await ports.confirm(RESOLVE_CONFLICT_PROMPT);
  } catch {
    answer = undefined;
  }
  if (answer !== RESOLVE_CONFLICT_CONFIRMATION) {
    writer.stdout("nookctl notes resolve-conflict: cancelled\n");
    return 1;
  }

  let resolveRaw: unknown;
  try {
    resolveRaw = await ports.resolve({ id: parsed.handle, binding: inspection.binding });
  } catch {
    writer.stdout("nookctl notes resolve-conflict: service_unavailable\n");
    return 3;
  }
  const report = describeResolve(resolveRaw);
  writer.stdout(report.text);
  return report.exitCode;
}

/** Production entry: the operator's terminal plus the operator socket. */
export async function runResolveConflictFromTerminal(argv: readonly string[]): Promise<number> {
  const streams = { input: process.stdin, output: process.stdout };
  return runResolveConflict(argv, createProductionResolveConflictPorts(streams), {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  });
}

/**
 * Production ports.  `inspect` and `resolve` both go over the operator socket.
 * The client is injectable so a test can stand in for the socket.
 */
export function createProductionResolveConflictPorts(
  streams: NotesUndoPromptStreams,
  client: Pick<OperatorSocketClient, "request"> = new OperatorSocketClient({
    socketPath: SOCKET_PATH,
  }),
): ResolveConflictPorts {
  return Object.freeze({
    interactive: isInteractiveTty(streams),
    confirm: (prompt: string) => askLine(streams, prompt),
    inspect: (handle: string) => client.request("notes.inspect-conflict", { id: handle }),
    resolve: (params: ResolveConflictParams) =>
      client.request("notes.resolve-conflict", { id: params.id, binding: params.binding }),
  });
}

async function askLine(
  streams: NotesUndoPromptStreams,
  prompt: string,
): Promise<string | undefined> {
  let readline: ReturnType<typeof createInterface>;
  try {
    readline = createInterface({ input: streams.input, output: streams.output, terminal: false });
  } catch {
    return undefined;
  }
  try {
    // Settle on `close` as well as on the answer, so EOF cannot hang the operator.
    return await new Promise<string | undefined>((settle) => {
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        settle(value);
      };
      readline.once("close", () => finish(undefined));
      readline.question(prompt, (answer: string) => finish(answer));
    });
  } catch {
    return undefined;
  } finally {
    readline.close();
  }
}

// ---------------------------------------------------------------------------
// Verdict readers.  Each returns a closed shape; nothing else is kept.
// ---------------------------------------------------------------------------

/** One conflict side's categorical facts. Never a body, id, or path. */
interface SideFacts {
  readonly present: boolean;
  readonly unlocked: boolean;
  readonly tiptap: boolean;
  readonly byteSize: number | null;
}

type InspectionVerdict =
  | Readonly<{
      kind: "inspected";
      local: SideFacts;
      remote: SideFacts;
      sidesEqual: boolean;
      remoteHasAttachments: boolean;
      binding: string;
    }>
  | Readonly<{ kind: "unreadable"; local: SideFacts; remote: SideFacts }>
  | Readonly<{ kind: "not-found" | "not-conflicted" }>
  | Readonly<{ kind: "socket"; code: string }>
  | Readonly<{ kind: "invalid" }>;

/**
 * Read the socket envelope and keep only the categorical fields.  The
 * inspector's sides are rebuilt from their four facts, so nothing else from the
 * daemon's response is printed.
 */
function readInspection(raw: unknown): InspectionVerdict {
  try {
    if (!isRecord(raw)) return { kind: "invalid" };
    if (raw.ok === false) {
      return { kind: "socket", code: typeof raw.code === "string" ? raw.code : "" };
    }
    if (raw.ok !== true || !isRecord(raw.result) || raw.result.kind !== "conflict-inspection") {
      return { kind: "invalid" };
    }
    const result = raw.result;
    if (result.outcome === "not-found" || result.outcome === "not-conflicted") {
      return { kind: result.outcome };
    }
    const local = readSide(result.local);
    const remote = readSide(result.remote);
    if (local === undefined || remote === undefined) return { kind: "invalid" };
    if (result.outcome === "unreadable") return { kind: "unreadable", local, remote };
    if (result.outcome !== "inspected") return { kind: "invalid" };
    const { sidesEqual, remoteHasAttachments, binding } = result;
    if (
      typeof sidesEqual !== "boolean" ||
      typeof remoteHasAttachments !== "boolean" ||
      typeof binding !== "string" ||
      !BINDING_PATTERN.test(binding)
    ) {
      return { kind: "invalid" };
    }
    return { kind: "inspected", local, remote, sidesEqual, remoteHasAttachments, binding };
  } catch {
    return { kind: "invalid" };
  }
}

function readSide(value: unknown): SideFacts | undefined {
  if (!isRecord(value)) return undefined;
  const { present, unlocked, tiptap, byteSize } = value;
  if (typeof present !== "boolean" || typeof unlocked !== "boolean") return undefined;
  if (typeof tiptap !== "boolean") return undefined;
  const size =
    byteSize === null
      ? null
      : typeof byteSize === "number" && Number.isSafeInteger(byteSize) && byteSize >= 0
        ? byteSize
        : undefined;
  if (size === undefined) return undefined;
  return { present, unlocked, tiptap, byteSize: size };
}

function formatInspected(inspection: Extract<InspectionVerdict, { kind: "inspected" }>): string {
  return [
    "nookctl notes resolve-conflict: inspected",
    ...sideLines(inspection.local, inspection.remote),
    `sides-equal: ${yesNo(inspection.sidesEqual)}`,
    `remote-has-attachments: ${yesNo(inspection.remoteHasAttachments)}`,
    `binding: ${inspection.binding}`,
    "plan: the original adopts the remote side; a copy keeps the bridge-local side",
    "",
  ].join("\n");
}

function sideLines(local: SideFacts, remote: SideFacts): string[] {
  return [`local-side: ${describeSide(local)}`, `remote-side: ${describeSide(remote)}`];
}

/** `state, tiptap|other, N bytes|no text`.  Only categorical facts, never a body. */
function describeSide(side: SideFacts): string {
  const state = side.present ? (side.unlocked ? "unlocked" : "locked") : "absent";
  const format = side.tiptap ? "tiptap" : "other";
  const size = side.byteSize === null ? "no text" : `${side.byteSize} bytes`;
  return `${state}, ${format}, ${size}`;
}

type ResolveVerdict =
  | Readonly<{ kind: "resolved"; originalTitle: unknown; copyTitle: unknown }>
  | Readonly<{ kind: "stale_revision"; copyCreated: boolean }>
  | Readonly<{ kind: "refused"; outcome: string }>
  | Readonly<{ kind: "socket"; code: string }>
  | Readonly<{ kind: "invalid" }>;

function readResolve(raw: unknown): ResolveVerdict {
  try {
    if (!isRecord(raw)) return { kind: "invalid" };
    if (raw.ok === false) {
      return { kind: "socket", code: typeof raw.code === "string" ? raw.code : "" };
    }
    if (raw.ok !== true || !isRecord(raw.result) || raw.result.kind !== "conflict-resolve") {
      return { kind: "invalid" };
    }
    const result = raw.result;
    if (result.outcome === "resolved") {
      return { kind: "resolved", originalTitle: result.originalTitle, copyTitle: result.copyTitle };
    }
    if (result.outcome === "stale_revision") {
      return typeof result.copyCreated === "boolean"
        ? { kind: "stale_revision", copyCreated: result.copyCreated }
        : { kind: "invalid" };
    }
    if (
      typeof result.outcome === "string" &&
      CONFLICT_RESOLVE_CLOSED_OUTCOMES.includes(result.outcome)
    ) {
      return { kind: "refused", outcome: result.outcome };
    }
    return { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

interface ResolveReport {
  readonly exitCode: 0 | 1 | 3;
  readonly text: string;
}

function describeResolve(raw: unknown): ResolveReport {
  const verdict = readResolve(raw);
  switch (verdict.kind) {
    case "resolved": {
      // The write has happened, so the exit stays 0.  A title that is not
      // safe to print is withheld rather than shown.
      if (!displayableTitle(verdict.originalTitle) || !displayableTitle(verdict.copyTitle)) {
        return {
          exitCode: 0,
          text: "nookctl notes resolve-conflict: resolved\ntitles: withheld\nuploaded: no\n",
        };
      }
      return {
        exitCode: 0,
        text: [
          "nookctl notes resolve-conflict: resolved",
          `original: ${verdict.originalTitle}`,
          `copy: ${verdict.copyTitle}`,
          "uploaded: no",
          "",
        ].join("\n"),
      };
    }
    case "stale_revision":
      return {
        exitCode: 1,
        text: `nookctl notes resolve-conflict: stale_revision\ncopy-created: ${yesNo(verdict.copyCreated)}\n`,
      };
    case "refused":
      return { exitCode: 1, text: `nookctl notes resolve-conflict: ${verdict.outcome}\n` };
    case "socket": {
      const name = SOCKET_REFUSAL_NAMES.get(verdict.code);
      if (name !== undefined) {
        return { exitCode: 1, text: `nookctl notes resolve-conflict: ${name}\n` };
      }
      return { exitCode: 3, text: "nookctl notes resolve-conflict: service_unavailable\n" };
    }
    case "invalid":
      return { exitCode: 3, text: "nookctl notes resolve-conflict: invalid_response\n" };
  }
}

function displayableTitle(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (CONTROL_CHARACTERS.test(value)) return false;
  return new TextEncoder().encode(value).byteLength <= STAGE5_RPC_LIMITS.maxTitleBytes;
}

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
