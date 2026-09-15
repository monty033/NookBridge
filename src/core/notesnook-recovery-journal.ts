/**
 * Bounded encrypted metadata for local-write compensation failures.
 *
 * This journal is deliberately separate from the remote-sync queue. A recovery
 * marker means a local mutation may need operator/runtime reconciliation; it
 * must never be interpreted as proof that a remote sync is safe to run.
 */

import type { PersistentStorage } from "../storage/persistent-storage.js";
import type { SyncOperation } from "./notesnook-sync-coordinator.js";

export const NOTESNOOK_RECOVERY_JOURNAL_KEY = "nookbridge:recovery-journal:v1" as const;

export type NotesnookRecoveryStage =
  | "create-notebook-attach"
  | "create-tag-relation"
  | "update-metadata"
  | "update-content"
  | "update-tags";

export type NotesnookRecoveryMarker = Readonly<{
  readonly operation: SyncOperation;
  readonly noteId: string;
  readonly stage: NotesnookRecoveryStage;
}>;

export interface NotesnookRecoveryJournal {
  readonly record: (marker: NotesnookRecoveryMarker) => void;
  readonly snapshot: () => readonly NotesnookRecoveryMarker[];
}

const MAX_PENDING_MARKERS = 64;
const MAX_NOTE_ID_LENGTH = 128;
const NOTE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperation(value: unknown): value is SyncOperation {
  return value === "create" || value === "append" || value === "update" || value === "delete";
}

function isStage(value: unknown): value is NotesnookRecoveryStage {
  return (
    value === "create-notebook-attach" ||
    value === "create-tag-relation" ||
    value === "update-metadata" ||
    value === "update-content" ||
    value === "update-tags"
  );
}

function normalizeMarker(value: unknown): NotesnookRecoveryMarker {
  if (!isRecord(value)) throw new Error("invalid recovery marker");
  const operation = value.operation;
  const noteId = value.noteId;
  const stage = value.stage;
  if (
    !isOperation(operation) ||
    typeof noteId !== "string" ||
    noteId.length === 0 ||
    noteId.length > MAX_NOTE_ID_LENGTH ||
    !NOTE_ID_PATTERN.test(noteId) ||
    !isStage(stage)
  ) {
    throw new Error("invalid recovery marker");
  }
  return Object.freeze({ operation, noteId, stage });
}

function normalizeMarkers(value: unknown): NotesnookRecoveryMarker[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PENDING_MARKERS) {
    throw new Error("invalid recovery journal");
  }
  return value.map(normalizeMarker);
}

/** In-memory journal used by tests and by callers that provide their own store. */
export class MemoryNotesnookRecoveryJournal implements NotesnookRecoveryJournal {
  readonly #markers: NotesnookRecoveryMarker[] = [];

  record(marker: NotesnookRecoveryMarker): void {
    const normalized = normalizeMarker(marker);
    const duplicate = this.#markers.some(
      (existing) =>
        existing.operation === normalized.operation &&
        existing.noteId === normalized.noteId &&
        existing.stage === normalized.stage,
    );
    if (duplicate) return;
    if (this.#markers.length >= MAX_PENDING_MARKERS) throw new Error("recovery journal full");
    this.#markers.push(normalized);
  }

  snapshot(): readonly NotesnookRecoveryMarker[] {
    return Object.freeze(this.#markers.map((marker) => Object.freeze({ ...marker })));
  }
}

/** PersistentStorage-backed recovery journal with one fixed encrypted key. */
export class PersistentNotesnookRecoveryJournal implements NotesnookRecoveryJournal {
  readonly #readSync: PersistentStorage["readSync"];
  readonly #writeSync: PersistentStorage["writeSync"];

  constructor(storage: Pick<PersistentStorage, "readSync" | "writeSync">) {
    if (typeof storage !== "object" || storage === null)
      throw new Error("invalid recovery storage");
    const readSync = Reflect.get(storage, "readSync", storage);
    const writeSync = Reflect.get(storage, "writeSync", storage);
    if (typeof readSync !== "function" || typeof writeSync !== "function") {
      throw new Error("invalid recovery storage");
    }
    this.#readSync = readSync.bind(storage);
    this.#writeSync = writeSync.bind(storage);
    Object.freeze(this);
  }

  record(marker: NotesnookRecoveryMarker): void {
    const normalized = normalizeMarker(marker);
    let current: NotesnookRecoveryMarker[];
    try {
      const encoded = this.#readSync<string>(NOTESNOOK_RECOVERY_JOURNAL_KEY);
      current = encoded === undefined ? [] : normalizeMarkers(JSON.parse(encoded) as unknown);
    } catch {
      throw new Error("recovery journal unavailable");
    }
    const duplicate = current.some(
      (existing) =>
        existing.operation === normalized.operation &&
        existing.noteId === normalized.noteId &&
        existing.stage === normalized.stage,
    );
    if (duplicate) return;
    if (current.length >= MAX_PENDING_MARKERS) throw new Error("recovery journal full");
    current.push(normalized);
    try {
      this.#writeSync(NOTESNOOK_RECOVERY_JOURNAL_KEY, JSON.stringify(current));
    } catch {
      throw new Error("recovery journal unavailable");
    }
  }

  snapshot(): readonly NotesnookRecoveryMarker[] {
    try {
      const encoded = this.#readSync<string>(NOTESNOOK_RECOVERY_JOURNAL_KEY);
      return Object.freeze(
        normalizeMarkers(encoded === undefined ? undefined : JSON.parse(encoded)).map((marker) =>
          Object.freeze({ ...marker }),
        ),
      );
    } catch {
      return Object.freeze([]);
    }
  }
}

export function createNotesnookRecoveryMarker(
  operation: SyncOperation,
  noteId: string,
  stage: NotesnookRecoveryStage,
): NotesnookRecoveryMarker {
  return normalizeMarker({ operation, noteId, stage });
}
