/**
 * Stage 4 — narrow live remote-sync executor.
 *
 * The only live value this module captures from a Database is a bound
 * `syncer.start` method. Callers cannot provide upstream options or reach the
 * Database/syncer after construction. Every invocation supplies the pinned
 * literal `{ type: "full" }`; upstream truthy success is not accepted — only
 * the boolean `true` confirms the batch.
 */

import { NotesnookWriteContractError } from "./notesnook-write-contract.js";
import { withMutex } from "./notesnook-database-mutex.js";
import type {
  SyncCoordinatorResult,
  SyncExecutor,
  SyncExecutorResult,
} from "./notesnook-sync-coordinator.js";

export type LiveRemoteSyncEnsureOpen = () => void;

function failInvalidInput(): never {
  throw new NotesnookWriteContractError("invalid_input");
}

function failSync(): never {
  throw new NotesnookWriteContractError("sync_failed");
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOwnData(record: object, key: string): unknown {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function boundedTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function boundedAttempts(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8;
}

function normalizeCoordinatorResult(value: unknown): SyncCoordinatorResult {
  if (!isRecord(value)) failSync();
  const status = readOwnData(value, "status");
  const localCommitted = readOwnData(value, "localCommitted");
  const remoteSynced = readOwnData(value, "remoteSynced");
  const pendingSync = readOwnData(value, "pendingSync");
  const attempts = readOwnData(value, "attempts");
  const startedAt = readOwnData(value, "startedAt");
  if (!boundedAttempts(attempts) || !boundedTimestamp(startedAt)) failSync();

  if (
    status === "idle" &&
    localCommitted === false &&
    remoteSynced === false &&
    pendingSync === false &&
    attempts === 0
  ) {
    return Object.freeze({
      status: "idle" as const,
      localCommitted: false as const,
      remoteSynced: false as const,
      pendingSync: false as const,
      attempts: 0 as const,
      startedAt,
    });
  }

  if (
    status === "synced" &&
    typeof localCommitted === "boolean" &&
    remoteSynced === true &&
    typeof pendingSync === "boolean" &&
    attempts >= 1
  ) {
    return Object.freeze({
      status: "synced" as const,
      localCommitted,
      remoteSynced: true as const,
      pendingSync,
      attempts,
      startedAt,
    });
  }

  const errorCode = readOwnData(value, "errorCode");
  if (
    status === "failed" &&
    errorCode === "sync_failed" &&
    typeof localCommitted === "boolean" &&
    remoteSynced === false &&
    typeof pendingSync === "boolean" &&
    attempts >= 1
  ) {
    return Object.freeze({
      status: "failed" as const,
      errorCode: "sync_failed" as const,
      localCommitted,
      remoteSynced: false as const,
      pendingSync,
      attempts,
      startedAt,
    });
  }

  failSync();
}

/**
 * Capture the pinned upstream sync operation without retaining or exposing a
 * raw Database or syncer. Throws a categorical error for malformed surfaces.
 */
export function createLiveRemoteSyncExecutor(
  database: object,
  ensureOpen: LiveRemoteSyncEnsureOpen,
): SyncExecutor {
  if (typeof database !== "object" || database === null || typeof ensureOpen !== "function") {
    failInvalidInput();
  }

  let syncer: unknown;
  try {
    syncer = Reflect.get(database, "syncer", database);
  } catch {
    failInvalidInput();
  }
  if (!isRecord(syncer)) failInvalidInput();

  let start: unknown;
  try {
    start = Reflect.get(syncer, "start", syncer);
  } catch {
    failInvalidInput();
  }
  if (typeof start !== "function") failInvalidInput();

  let boundStart: (...args: readonly unknown[]) => unknown;
  try {
    boundStart = (start as (...args: readonly unknown[]) => unknown).bind(syncer);
  } catch {
    failInvalidInput();
  }

  return async (_request): Promise<SyncExecutorResult> => {
    try {
      ensureOpen();
      const result = boundStart({ type: "full" });
      const resolved = await result;
      if (resolved === true) return Object.freeze({ status: "confirmed" as const });
      if (resolved === false) return Object.freeze({ status: "failed" as const });
      return Object.freeze({ status: "failed" as const });
    } catch {
      return Object.freeze({ status: "retry" as const });
    }
  };
}

/** A separately named explicit remote-sync capability. */
export interface NotesnookLiveRemoteSyncCapability {
  readonly requestSync: () => Promise<SyncCoordinatorResult>;
}

/**
 * Wrap a coordinator as the explicit remote-sync capability. The caller gets
 * no executor, options, Database, or syncer; lifecycle validation happens
 * before the coordinator can invoke live code.
 *
 * When a database identity is supplied, every `requestSync()` call funnels
 * through the per-Database mutex so a remote drain can never interleave with
 * a local mutation (or with another remote-sync capability bound to the
 * same database).  Without a database identity the capability falls back to
 * the coordinator's own single-flight policy, which still gates against
 * concurrent remote drains but does not serialise against mutations.
 */
export function createLiveRemoteSyncCapability(
  requestSync: () => Promise<SyncCoordinatorResult>,
  ensureOpen: LiveRemoteSyncEnsureOpen,
  database?: object,
): NotesnookLiveRemoteSyncCapability {
  if (typeof requestSync !== "function" || typeof ensureOpen !== "function") {
    failInvalidInput();
  }
  if (
    database !== undefined &&
    (typeof database !== "object" || database === null || Array.isArray(database))
  ) {
    failInvalidInput();
  }
  return Object.freeze({
    requestSync: async () => {
      try {
        ensureOpen();
        const run = () => requestSync().then(normalizeCoordinatorResult);
        const result =
          database === undefined ? await run() : await withMutex(database, "remote:sync", run);
        return result;
      } catch {
        failSync();
      }
    },
  });
}
