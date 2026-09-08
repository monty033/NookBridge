import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";

import { createProductionLiveLoginRuntime } from "../auth/live-login-runtime.js";
import type { LiveLoginRuntime } from "../auth/admin-command.js";
import {
  createProductionOperatorKeyStore,
  PRODUCTION_STATE_DIR,
  readSafeOperatorEnvironment,
} from "./production-runtime.js";
import type { Logger } from "../logging/logger.js";
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
  };
  return Object.freeze(runtime);
}

/** Open the real local read-only runtime lazily for one CLI command. */
export async function createProductionNotesRuntime(options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly logger?: Logger;
}): Promise<NotesProductionRuntime> {
  const environment = readSafeOperatorEnvironment(options.environment);
  const keys = createProductionOperatorKeyStore(environment);
  let live: LiveLoginRuntime | undefined;
  try {
    live = await createProductionLiveLoginRuntime({
      stateDir: PRODUCTION_STATE_DIR,
      keys,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    const readOnly = live.readOnly;
    const keyMaterial = keys.getDatabaseKey();
    if (readOnly === undefined || keyMaterial === undefined) {
      throw new Error("notes read-only runtime unavailable");
    }
    const runtime = createNotesCommandRuntimeFromReadOnly(
      createNotesReadSource(readOnly),
      createNotesOpaqueHandleCodec(keyMaterial),
    );
    return { runtime, cleanup: live.cleanup };
  } catch (error) {
    if (live !== undefined) await live.cleanup();
    throw error;
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
