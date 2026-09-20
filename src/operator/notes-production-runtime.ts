import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

import type { Logger } from "../logging/logger.js";
import { OperatorSocketClient, type OperatorSocketResult } from "./operator-socket-client.js";
import { runNotesEditor } from "./notes-editor-runner.js";
import { readSafeOperatorEnvironment } from "./production-runtime.js";
import {
  isBoundedOpaqueValue,
  type NotesCategoricalResult,
  type NotesCommandRuntime,
} from "./notes-cli.js";
import {
  createNotesReadRuntime,
  type NotesReadRuntimeHandleCodec,
  type NotesReadRuntimeResult,
  type NotesReadRuntimeSource,
  type NotesReadRuntimeSourceNote,
  type NotesReadRuntimeSourceSearchHit,
} from "./notes-read-runtime.js";
import type {
  NotesnookReadOnlyDatabase,
  NotesnookReadOnlyNoteMetadata,
  NotesnookReadOnlySearchHit,
} from "../core/notesnook-readonly-adapter.js";

const HANDLE_PREFIX = "not_";
const HANDLE_FRAME_PREFIX = Buffer.from("NBH1", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SOURCE_ID_MAX_BYTES = 100;
const HANDLE_PAYLOAD_MAX_BYTES = 124;
const UNAVAILABLE_RESULT = Object.freeze({
  kind: "error" as const,
  exitCode: 3 as const,
  message: "nookctl notes: runtime unavailable",
});

/** The editor could not be run or was refused; nothing was applied. */
const EDITOR_UNAVAILABLE_RESULT = Object.freeze({
  kind: "error" as const,
  exitCode: 3 as const,
  message: "nookctl notes: editor unavailable",
});

/** Outcome of running the operator's editor over the preimage. */
type NotesEditorOutcome =
  | Readonly<{ kind: "edited"; markdown: string }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "refused" }>;

export interface NotesOperatorWriteOptions {
  /**
   * Editor seam.  Defaults to `runNotesEditor` (the reviewed T08 runner).
   * Tests inject a deterministic body; production must never substitute a
   * seam that reads a body from argv, env or stdin.
   */
  readonly editBody?: (markdown: string) => Promise<NotesEditorOutcome>;
}

type NotesReadOnlySurface = Pick<
  NotesnookReadOnlyDatabase,
  "listNotes" | "search" | "noteMetadata"
>;

type NotesProductionRuntime = Readonly<{
  runtime: NotesCommandRuntime;
  cleanup: () => void | Promise<void>;
}>;

/** Convert the closed production projection into the narrower operator source. */
export function createNotesReadSource(readOnly: NotesReadOnlySurface): NotesReadRuntimeSource {
  if (
    readOnly === null ||
    typeof readOnly !== "object" ||
    typeof readOnly.listNotes !== "function" ||
    typeof readOnly.search !== "function" ||
    typeof readOnly.noteMetadata !== "function"
  ) {
    throw new Error("notes read-only source unavailable");
  }

  const source = {
    list: async (): Promise<readonly NotesReadRuntimeSourceNote[]> => {
      const notes = await readOnly.listNotes();
      return notes.map(toSourceNote).filter(isDefined);
    },
    search: async (query: string): Promise<readonly NotesReadRuntimeSourceSearchHit[]> => {
      const hits = await readOnly.search(query);
      return hits
        .filter((hit) => hit.source === "note")
        .map(toSourceSearchHit)
        .filter(isDefined);
    },
    note: async (id: string): Promise<NotesReadRuntimeSourceNote | undefined> => {
      const note = await readOnly.noteMetadata(id);
      return note === undefined ? undefined : toSourceNote(note);
    },
  } satisfies NotesReadRuntimeSource;

  return Object.freeze(source);
}

/**
 * Authenticated opaque handles. The read adapter remains codec-driven; it
 * never performs this encoding itself. The encrypted payload is self-contained
 * so a handle survives a separate browse/get CLI process without persisting a
 * plaintext source-id map.
 */
export function createNotesOpaqueHandleCodec(keyMaterial: string): NotesReadRuntimeHandleCodec {
  const key = createHash("sha256").update(keyMaterial, "utf8").digest();

  const encode = (sourceId: string): string => {
    if (typeof sourceId !== "string" || sourceId.length === 0) throw new Error("invalid source id");
    const sourceBytes = Buffer.from(sourceId, "utf8");
    if (sourceBytes.byteLength > SOURCE_ID_MAX_BYTES) throw new Error("source id too long");
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(sourceBytes), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([HANDLE_FRAME_PREFIX, nonce, tag, ciphertext]);
    const token = payload.toString("base64url");
    const handle = `${HANDLE_PREFIX}${token}`;
    if (token.length > HANDLE_PAYLOAD_MAX_BYTES || !isBoundedOpaqueValue(handle)) {
      throw new Error("opaque handle exceeds bound");
    }
    return handle;
  };

  const decode = (handle: string): { kind: "ok"; sourceId: string } | { kind: "invalid" } => {
    try {
      if (!isBoundedOpaqueValue(handle) || !handle.startsWith(HANDLE_PREFIX)) {
        return { kind: "invalid" };
      }
      const token = handle.slice(HANDLE_PREFIX.length);
      if (!/^[A-Za-z0-9_-]+$/.test(token)) return { kind: "invalid" };
      const payload = Buffer.from(token, "base64url");
      if (
        payload.length < HANDLE_FRAME_PREFIX.length + NONCE_BYTES + TAG_BYTES + 1 ||
        !payload.subarray(0, HANDLE_FRAME_PREFIX.length).equals(HANDLE_FRAME_PREFIX)
      ) {
        return { kind: "invalid" };
      }
      const nonceStart = HANDLE_FRAME_PREFIX.length;
      const tagStart = nonceStart + NONCE_BYTES;
      const ciphertextStart = tagStart + TAG_BYTES;
      const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(nonceStart, tagStart));
      decipher.setAuthTag(payload.subarray(tagStart, ciphertextStart));
      const plaintext = Buffer.concat([
        decipher.update(payload.subarray(ciphertextStart)),
        decipher.final(),
      ]);
      if (plaintext.length === 0 || plaintext.length > SOURCE_ID_MAX_BYTES) {
        return { kind: "invalid" };
      }
      const sourceId = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      return sourceId.length > 0 ? { kind: "ok", sourceId } : { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
    }
  };

  return Object.freeze({ encode, decode });
}

/** Compose the bounded read adapter with the existing categorical CLI shape. */
export function createNotesCommandRuntimeFromReadOnly(
  source: NotesReadRuntimeSource,
  handleCodec: NotesReadRuntimeHandleCodec,
): NotesCommandRuntime {
  const readRuntime = createNotesReadRuntime({ source, handleCodec });
  const runtime: NotesCommandRuntime = {
    browse: async (command) => mapReadResult(await readRuntime.browse(command)),
    search: async (command) => mapReadResult(await readRuntime.search(command)),
    get: async (command) => mapReadResult(await readRuntime.get(command)),
    edit: async () => UNAVAILABLE_RESULT,
    undo: async () => UNAVAILABLE_RESULT,
    operations: async () => UNAVAILABLE_RESULT,
  };
  return Object.freeze(runtime);
}

/** Compose the CLI runtime over the daemon-owned operator socket. */
export function createNotesCommandRuntimeFromOperatorSocket(
  client: Pick<OperatorSocketClient, "request">,
  options: NotesOperatorWriteOptions = {},
): NotesCommandRuntime {
  const editBody = options.editBody ?? defaultEditBody;

  const runtime: NotesCommandRuntime = {
    browse: async (command: { readonly cursor?: string; readonly limit?: number }) =>
      mapOperatorPage(await client.request("notes.browse", command)),
    search: async (command: {
      readonly query: string;
      readonly cursor?: string;
      readonly limit?: number;
    }) => mapOperatorPage(await client.request("notes.search-operator", command)),
    get: async (command: { readonly handle: string }) =>
      mapOperatorView(await client.request("notes.get-view", { id: command.handle })),

    /**
     * Capture the trusted preimage, hand the Markdown to the operator's
     * editor, then apply.  The preimage is captured BEFORE the editor
     * opens, so a daemon-side undo record exists even if the editor is
     * killed mid-edit.  An unchanged save applies nothing.
     */
    edit: async (command: { readonly handle: string }) => {
      const pre = await client.request("notes.edit-preimage", { id: command.handle });
      if (!pre.ok) return mapOperatorError(pre);
      if (pre.result.kind !== "preimage") return UNAVAILABLE_RESULT;
      const { revision, markdown } = pre.result;

      let edited: NotesEditorOutcome;
      try {
        edited = await editBody(markdown);
      } catch {
        return EDITOR_UNAVAILABLE_RESULT;
      }
      if (edited.kind === "refused") return EDITOR_UNAVAILABLE_RESULT;
      if (edited.kind === "unchanged") return { kind: "unchanged" };

      const applied = await client.request("notes.apply-edit", {
        id: command.handle,
        expectedRevision: revision,
        markdown: edited.markdown,
      });
      if (!applied.ok) return mapOperatorError(applied);
      if (applied.result.kind !== "edit") return UNAVAILABLE_RESULT;
      return { kind: "updated" };
    },

    operations: async () => {
      const listed = await client.request("notes.operation-list", {});
      if (!listed.ok) return mapOperatorError(listed);
      if (listed.result.kind !== "operation-list") return UNAVAILABLE_RESULT;
      const handles = listed.result.handles.filter(
        (handle) => typeof handle === "string" && isBoundedOpaqueValue(handle),
      );
      return { kind: "operations", handles };
    },

    /**
     * Undo by opaque operation handle only.  The daemon resolves the note
     * and the guarding revision from its own committed record, so no note
     * id or revision is sent — and none is accepted back.
     */
    undo: async (command: { readonly operationHandle: string }) => {
      if (!isBoundedOpaqueValue(command.operationHandle)) return { kind: "invalid-input" };
      const undone = await client.request("notes.apply-undo", {
        operationHandle: command.operationHandle,
      });
      if (!undone.ok) return mapOperatorError(undone);
      if (undone.result.kind !== "undo") return UNAVAILABLE_RESULT;
      return { kind: "undone" };
    },
  };
  return Object.freeze(runtime);
}

/**
 * Run the operator's editor over the preimage Markdown.
 *
 * `runNotesEditor` already owns the security properties (mode-0600 temp
 * file in a mode-0700 scratch dir, argv carries only the file path, the
 * environment is filtered, bounded size and timeout).  This adapter only
 * turns its outcome into the closed categorical vocabulary and never
 * forwards a cause or path.
 */
async function defaultEditBody(markdown: string): Promise<NotesEditorOutcome> {
  try {
    const result = await runNotesEditor(markdown);
    if (!result.changed) return { kind: "unchanged" };
    return { kind: "edited", markdown: result.markdown };
  } catch {
    return { kind: "refused" };
  }
}

/**
 * Production notes runtime. The CLI is a client only: it never imports the
 * live-login runtime and never opens the encrypted Notesnook database.
 */
export async function createProductionNotesRuntime(options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly logger?: Logger;
}): Promise<NotesProductionRuntime> {
  readSafeOperatorEnvironment(options.environment);
  void options.logger;
  const client = new OperatorSocketClient({ socketPath: "/run/nookbridge/operator.sock" });
  return {
    runtime: createNotesCommandRuntimeFromOperatorSocket(client),
    cleanup: () => undefined,
  };
}

function mapOperatorPage(result: OperatorSocketResult): NotesCategoricalResult {
  if (!result.ok) return mapOperatorError(result);
  if (result.result.kind !== "operator-page") return UNAVAILABLE_RESULT;
  return {
    kind: result.result.notes.length === 0 ? "empty" : "page",
    ...(result.result.notes.length === 0
      ? {}
      : { notes: result.result.notes, next: result.result.next }),
  } as NotesCategoricalResult;
}

function mapOperatorView(result: OperatorSocketResult): NotesCategoricalResult {
  if (!result.ok) return mapOperatorError(result);
  if (result.result.kind !== "view") return UNAVAILABLE_RESULT;
  return {
    kind: "note",
    content: { label: "note", markdown: result.result.markdown, bytes: result.result.contentBytes },
  };
}

function mapOperatorError(
  result: Extract<OperatorSocketResult, { ok: false }>,
): NotesCategoricalResult {
  switch (result.code) {
    case "not_found":
      return { kind: "missing" };
    case "permission_denied":
      return { kind: "denied" };
    case "invalid_request":
      return { kind: "invalid-input" };
    case "vault_locked":
      return { kind: "locked" };
    // A losing optimistic-concurrency check is the operator's own retry
    // signal: the note changed under them, so the edit was not applied.
    case "stale_revision":
    case "conflict":
      return { kind: "conflict" };
    // Everything else (including `sync_failed`) stays categorical and
    // retryable: the caller cannot tell "not applied" from "unknown".
    case "service_unavailable":
    case "sync_failed":
      return UNAVAILABLE_RESULT;
  }
}

function mapReadResult(result: NotesReadRuntimeResult): NotesCategoricalResult {
  switch (result.kind) {
    case "page":
      return { kind: "page", notes: result.notes, next: result.next };
    case "note":
      return { kind: "note", content: result.content };
    case "empty":
      return { kind: "empty" };
    case "missing":
      return { kind: "missing" };
    case "error":
      return { kind: "error", exitCode: result.exitCode, message: result.message };
  }
}

function toSourceNote(note: NotesnookReadOnlyNoteMetadata): NotesReadRuntimeSourceNote | undefined {
  if (typeof note.id !== "string" || typeof note.title !== "string") return undefined;
  return {
    id: note.id,
    title: note.title,
    ...(note.dateModified === undefined ? {} : { dateModified: note.dateModified }),
  };
}

function toSourceSearchHit(
  hit: NotesnookReadOnlySearchHit,
): NotesReadRuntimeSourceSearchHit | undefined {
  if (typeof hit.id !== "string" || typeof hit.title !== "string") return undefined;
  return { id: hit.id, title: hit.title };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
