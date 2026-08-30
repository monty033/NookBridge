/**
 * Stage 4 — encrypted restart-safe coordinator metadata.
 *
 * The coordinator only needs synchronous load/save semantics while recording a
 * local commit. This adapter keeps that seam narrow and stores one JSON payload
 * under one fixed namespaced key in PersistentStorage's encrypted SQLite KV
 * table. It never creates a plaintext state file and never accepts an
 * arbitrary storage key from a caller.
 */

import type { PersistentStorage } from "../storage/persistent-storage.js";
import type { SyncCoordinatorState, SyncMetadataStateStore } from "./notesnook-sync-coordinator.js";

/** Fixed, versioned namespace for the metadata-only queue state. */
export const SYNC_COORDINATOR_STATE_KEY = "nookbridge:sync-coordinator-state:v1" as const;

const MAX_PENDING_MARKERS = 64;
const MAX_NOTE_ID_LENGTH = 128;
const NOTE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

type SynchronousStorage = Pick<PersistentStorage, "readSync" | "writeSync">;

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOwnData(record: object, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    throw new Error("invalid sync metadata");
  }
  return descriptor.value;
}

function hasExactlyKeys(record: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key)) &&
    keys.every((key) => typeof key === "string")
  );
}

function normalizeState(value: unknown): SyncCoordinatorState {
  if (!isRecord(value) || !hasExactlyKeys(value, ["pending"])) {
    throw new Error("invalid sync metadata");
  }
  const rawPending = readOwnData(value, "pending");
  if (!Array.isArray(rawPending) || rawPending.length > MAX_PENDING_MARKERS) {
    throw new Error("invalid sync metadata");
  }

  const pending = rawPending.map((rawMarker, index) => {
    if (!isRecord(rawMarker) || !hasExactlyKeys(rawMarker, ["operation", "noteId", "sequence"])) {
      throw new Error(`invalid sync metadata marker ${index}`);
    }
    const operation = readOwnData(rawMarker, "operation");
    const noteId = readOwnData(rawMarker, "noteId");
    const sequence = readOwnData(rawMarker, "sequence");
    if (
      (operation !== "create" && operation !== "append" && operation !== "update") ||
      typeof noteId !== "string" ||
      noteId.length === 0 ||
      noteId.length > MAX_NOTE_ID_LENGTH ||
      !NOTE_ID_PATTERN.test(noteId) ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    ) {
      throw new Error(`invalid sync metadata marker ${index}`);
    }
    return Object.freeze({ operation, noteId, sequence });
  });

  return Object.freeze({ pending: Object.freeze(pending) });
}

/** PersistentStorage-backed implementation of the coordinator's sync store. */
export class PersistentSyncMetadataStateStore implements SyncMetadataStateStore {
  readonly #readSync: SynchronousStorage["readSync"];
  readonly #writeSync: SynchronousStorage["writeSync"];

  constructor(storage: SynchronousStorage) {
    try {
      if (!isRecord(storage)) throw new Error("invalid sync metadata storage");
      const readSync = Reflect.get(storage, "readSync", storage);
      const writeSync = Reflect.get(storage, "writeSync", storage);
      if (typeof readSync !== "function" || typeof writeSync !== "function") {
        throw new Error("invalid sync metadata storage");
      }
      this.#readSync = readSync.bind(storage);
      this.#writeSync = writeSync.bind(storage);
      Object.freeze(this);
    } catch {
      throw new Error("invalid sync metadata storage");
    }
  }

  load(): unknown {
    try {
      const encoded = this.#readSync(SYNC_COORDINATOR_STATE_KEY);
      if (encoded === undefined) return undefined;
      if (typeof encoded !== "string") throw new Error("invalid persisted sync metadata");
      return normalizeState(JSON.parse(encoded) as unknown);
    } catch {
      throw new Error("invalid persisted sync metadata");
    }
  }

  save(state: SyncCoordinatorState): void {
    try {
      const normalized = normalizeState(state);
      const encoded = JSON.stringify(normalized);
      if (typeof encoded !== "string") throw new Error("invalid sync metadata");
      this.#writeSync(SYNC_COORDINATOR_STATE_KEY, encoded);
    } catch {
      throw new Error("failed to persist sync metadata");
    }
  }
}

export function createPersistentSyncMetadataStateStore(
  storage: SynchronousStorage,
): PersistentSyncMetadataStateStore {
  return new PersistentSyncMetadataStateStore(storage);
}
