/**
 * Stage 4 — metadata-only synchronization coordinator.
 *
 * This module deliberately sits between a local mutation adapter and an
 * injected synchronization policy. It does not know how synchronization is
 * performed and it has no Notesnook, transport, credential, Vault, or raw
 * record dependency.
 *
 * A local receipt is recorded as a bounded queue marker. Only a separately
 * injected executor may confirm that marker remotely. The state store is
 * likewise metadata-only: note operation, bounded note id, and a sequence
 * marker are the complete durable shape.
 */

import {
  NotesnookWriteContractError,
  isNotesnookWriteContractError,
  type NotesnookWriteErrorCode,
} from "./notesnook-write-contract.js";

export { NotesnookWriteContractError };

const MAX_PENDING_MARKERS = 64;
const MAX_NOTE_ID_LENGTH = 128;
const MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_RETRY_AFTER_CAP_MS = 30_000;

/** The only local mutation categories the coordinator can queue. */
export type SyncOperation = "create" | "append" | "update";

/**
 * The small result shared by the local mutation adapter and this coordinator.
 * Extra adapter fields (including bodies) are intentionally not consumed.
 */
export type SyncLocalCommit = Readonly<{
  readonly operation: SyncOperation;
  readonly id: string;
  readonly localCommitted: true;
  readonly remoteSynced: false;
  readonly pendingSync: true;
}>;

/** Durable queue marker. It contains no body, record, credential, or path. */
export type SyncPendingMarker = Readonly<{
  readonly operation: SyncOperation;
  readonly noteId: string;
  readonly sequence: number;
}>;

/** The complete metadata-only state accepted by an injected store. */
export type SyncCoordinatorState = Readonly<{
  readonly pending: readonly SyncPendingMarker[];
}>;

/** Narrow restart-safe persistence seam. Implementations must be synchronous. */
export interface SyncMetadataStateStore {
  readonly load: () => unknown;
  readonly save: (state: SyncCoordinatorState) => unknown;
}

/** Request sent to the injected synchronization policy. */
export type SyncExecutorRequest = Readonly<{
  readonly pending: readonly SyncPendingMarker[];
}>;

/**
 * Executor result. `confirmed` is the only remote-success assertion. A
 * `failed` result is permanent for this attempt; `retry` is transient and may
 * carry a bounded Retry-After hint.
 */
export type SyncExecutorResult =
  | Readonly<{ readonly status: "confirmed" }>
  | Readonly<{ readonly status: "retry"; readonly retryAfterMs?: number }>
  | Readonly<{ readonly status: "failed" }>;

/** Injected executor seam; the coordinator never performs remote I/O itself. */
export type SyncExecutor = (
  request: SyncExecutorRequest,
) => SyncExecutorResult | PromiseLike<SyncExecutorResult>;

/** Deterministic delay seam used between bounded attempts. */
export type SyncSleep = (delayMs: number) => PromiseLike<void>;

/** Coordinator construction options. */
export type SyncCoordinatorOptions = Readonly<{
  readonly executor: SyncExecutor;
  readonly stateStore?: SyncMetadataStateStore;
  readonly sleep?: SyncSleep;
  readonly now?: () => number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly retryAfterCapMs?: number;
}>;

/** Result returned when a local receipt is accepted into the queue. */
export type SyncLocalCommitResult = Readonly<{
  readonly operation: SyncOperation;
  readonly id: string;
  readonly localCommitted: true;
  readonly remoteSynced: false;
  readonly pendingSync: true;
}>;

/** Result of a single-flight drain request. */
export type SyncCoordinatorResult =
  | Readonly<{
      readonly status: "idle";
      readonly localCommitted: false;
      readonly remoteSynced: false;
      readonly pendingSync: false;
      readonly attempts: 0;
      readonly startedAt: number;
    }>
  | Readonly<{
      readonly status: "synced";
      readonly localCommitted: true;
      readonly remoteSynced: true;
      readonly pendingSync: false;
      readonly attempts: number;
      readonly startedAt: number;
    }>
  | Readonly<{
      readonly status: "failed";
      readonly errorCode: "sync_failed";
      readonly localCommitted: true;
      readonly remoteSynced: false;
      readonly pendingSync: true;
      readonly attempts: number;
      readonly startedAt: number;
    }>;

const DEFAULT_SLEEP: SyncSleep = async () => undefined;
const DEFAULT_NOW = (): number => Date.now();

/**
 * Closed, single-flight synchronization coordinator.
 *
 * `recordLocalCommit` is synchronous and only records a local pending marker.
 * `requestSync` returns one shared promise for concurrent callers. A remote
 * confirmation removes only the exact marker batch that was executed, so a
 * new local mutation arriving during an in-flight request remains pending.
 */
export class SyncCoordinator {
  readonly #executor: SyncExecutor;
  readonly #store: SyncMetadataStateStore;
  readonly #sleep: SyncSleep;
  readonly #now: () => number;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #retryAfterCapMs: number;
  #pending: SyncPendingMarker[];
  #nextSequence: number;
  #inFlight: Promise<SyncCoordinatorResult> | undefined;

  constructor(options: SyncCoordinatorOptions) {
    const record = requireRecord(options, "coordinator options");
    const executor = readProperty(record, "executor");
    if (typeof executor !== "function") {
      fail("invalid_input");
    }

    const stateStoreRaw = readProperty(record, "stateStore");
    const store = stateStoreRaw === undefined ? createMemoryStore() : validateStore(stateStoreRaw);
    const sleepRaw = readProperty(record, "sleep");
    const nowRaw = readProperty(record, "now");
    const sleep = sleepRaw === undefined ? DEFAULT_SLEEP : requireFunction<SyncSleep>(sleepRaw);
    const now = nowRaw === undefined ? DEFAULT_NOW : requireFunction<() => number>(nowRaw);

    const maxAttempts = boundedOption(
      readProperty(record, "maxAttempts"),
      DEFAULT_MAX_ATTEMPTS,
      1,
      8,
    );
    const baseDelayMs = boundedOption(
      readProperty(record, "baseDelayMs"),
      DEFAULT_BASE_DELAY_MS,
      0,
      MAX_DELAY_MS,
    );
    const retryAfterCapMs = boundedOption(
      readProperty(record, "retryAfterCapMs"),
      DEFAULT_RETRY_AFTER_CAP_MS,
      0,
      MAX_DELAY_MS,
    );

    const loaded = callStoreLoad(store);
    const state = loaded === undefined ? emptyState() : validateState(loaded);

    this.#executor = executor as SyncExecutor;
    this.#store = store;
    this.#sleep = sleep;
    this.#now = now;
    this.#maxAttempts = maxAttempts;
    this.#baseDelayMs = baseDelayMs;
    this.#retryAfterCapMs = retryAfterCapMs;
    this.#pending = state.pending.map(copyMarker);
    this.#nextSequence = nextSequence(this.#pending);
    Object.freeze(this);
  }

  /**
   * Record a successful local mutation as pending. This method never claims
   * remote synchronization and never reads or stores fields outside the
   * bounded receipt metadata.
   */
  recordLocalCommit(receipt: SyncLocalCommit): SyncLocalCommitResult {
    const record = requireRecord(receipt, "local commit");
    const operation = readProperty(record, "operation");
    const id = readProperty(record, "id");
    const localCommitted = readProperty(record, "localCommitted");
    const remoteSynced = readProperty(record, "remoteSynced");
    const pendingSync = readProperty(record, "pendingSync");

    if (!isOperation(operation) || typeof id !== "string" || !validNoteId(id)) {
      fail("invalid_input");
    }
    if (localCommitted !== true || remoteSynced !== false || pendingSync !== true) {
      fail("invalid_input");
    }

    const marker = freezeMarker({
      operation,
      noteId: id,
      sequence: this.#nextSequence,
    });
    const nextPending = [
      ...this.#pending.filter(
        (existing) => existing.operation !== operation || existing.noteId !== id,
      ),
      marker,
    ];
    if (nextPending.length > MAX_PENDING_MARKERS) {
      fail("invalid_input");
    }

    const nextState = freezeState(nextPending);
    persist(this.#store, nextState);
    this.#pending = [...nextPending];
    this.#nextSequence++;

    return Object.freeze({
      operation,
      id,
      localCommitted: true as const,
      remoteSynced: false as const,
      pendingSync: true as const,
    });
  }

  /** Return a defensive, frozen copy of the bounded queue markers. */
  snapshot(): SyncCoordinatorState {
    return freezeState(this.#pending);
  }

  /**
   * Start one drain, or return the exact existing promise for a concurrent
   * request. No request amplification occurs while a drain is in flight.
   */
  requestSync(): Promise<SyncCoordinatorResult> {
    const inFlight = this.#inFlight;
    if (inFlight !== undefined) return inFlight;

    const flight = this.#drain();
    this.#inFlight = flight;
    void flight.then(
      () => this.#clearFlight(flight),
      () => this.#clearFlight(flight),
    );
    return flight;
  }

  async #drain(): Promise<SyncCoordinatorResult> {
    const startedAt = safeNow(this.#now);
    if (this.#pending.length === 0) {
      return Object.freeze({
        status: "idle" as const,
        localCommitted: false as const,
        remoteSynced: false as const,
        pendingSync: false as const,
        attempts: 0 as const,
        startedAt,
      });
    }

    const batch = Object.freeze(this.#pending.map(copyMarker));
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      let response: SyncExecutorResult;
      try {
        const raw = Reflect.apply(this.#executor, undefined, [
          Object.freeze({ pending: batch }),
        ]) as unknown;
        response = (await raw) as SyncExecutorResult;
      } catch {
        if (attempt === this.#maxAttempts) return failedResult(attempt, startedAt);
        const slept = await this.#wait(backoffDelay(this.#baseDelayMs, attempt));
        if (!slept) return failedResult(attempt, startedAt);
        continue;
      }

      const parsed = parseExecutorResult(response);
      if (parsed.status === "failed") return failedResult(attempt, startedAt);
      if (parsed.status === "retry") {
        if (attempt === this.#maxAttempts) return failedResult(attempt, startedAt);
        const delay =
          parsed.retryAfterMs === undefined
            ? backoffDelay(this.#baseDelayMs, attempt)
            : Math.min(parsed.retryAfterMs, this.#retryAfterCapMs);
        const slept = await this.#wait(delay);
        if (!slept) return failedResult(attempt, startedAt);
        continue;
      }

      try {
        this.#removeBatch(batch);
      } catch {
        return failedResult(attempt, startedAt);
      }
      return Object.freeze({
        status: "synced" as const,
        localCommitted: true as const,
        remoteSynced: true as const,
        pendingSync: false as const,
        attempts: attempt,
        startedAt,
      });
    }

    // The loop is bounded by #maxAttempts; this is only a type-level guard.
    return failedResult(this.#maxAttempts, startedAt);
  }

  async #wait(delayMs: number): Promise<boolean> {
    try {
      const result = Reflect.apply(this.#sleep, undefined, [delayMs]);
      await result;
      return true;
    } catch {
      return false;
    }
  }

  #removeBatch(batch: readonly SyncPendingMarker[]): void {
    const sequences = new Set(batch.map((marker) => marker.sequence));
    const nextPending = this.#pending.filter((marker) => !sequences.has(marker.sequence));
    persist(this.#store, freezeState(nextPending));
    this.#pending = [...nextPending];
  }

  #clearFlight(flight: Promise<SyncCoordinatorResult>): void {
    if (this.#inFlight === flight) this.#inFlight = undefined;
  }
}

function createMemoryStore(): SyncMetadataStateStore {
  let state: SyncCoordinatorState | undefined;
  return {
    load: () => state,
    save: (nextState) => {
      state = nextState;
    },
  };
}

function requireRecord(value: unknown, _label: string): Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail("invalid_input");
    }
  } catch (error) {
    if (isNotesnookWriteContractError(error)) throw error;
    fail("invalid_input");
  }
  return value as Record<string, unknown>;
}

function readProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    return Reflect.get(record, key);
  } catch {
    fail("invalid_input");
  }
}

function requireFunction<T>(value: unknown): T {
  if (typeof value !== "function") fail("invalid_input");
  return value as T;
}

function isOperation(value: unknown): value is SyncOperation {
  return value === "create" || value === "append" || value === "update";
}

function validNoteId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_NOTE_ID_LENGTH && !value.includes("\u0000");
}

function boundedOption(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    fail("invalid_input");
  }
  return value;
}

function validateStore(value: unknown): SyncMetadataStateStore {
  const record = requireRecord(value, "state store");
  const load = readProperty(record, "load");
  const save = readProperty(record, "save");
  if (typeof load !== "function" || typeof save !== "function") fail("invalid_input");
  return Object.freeze({
    load: () => Reflect.apply(load, value, []),
    save: (state: SyncCoordinatorState) => Reflect.apply(save, value, [state]),
  });
}

function callStoreLoad(store: SyncMetadataStateStore): unknown {
  try {
    const value = store.load();
    if (isThenable(value)) fail("invalid_input");
    return value;
  } catch (error) {
    if (isNotesnookWriteContractError(error))
      throw new NotesnookWriteContractError("invalid_input");
    fail("invalid_input");
  }
}

function persist(store: SyncMetadataStateStore, state: SyncCoordinatorState): void {
  try {
    const result = store.save(state);
    if (isThenable(result)) fail("sync_failed");
  } catch (error) {
    if (isNotesnookWriteContractError(error)) {
      throw new NotesnookWriteContractError("sync_failed");
    }
    fail("sync_failed");
  }
}

function validateState(value: unknown): SyncCoordinatorState {
  const record = requireRecord(value, "stored state");
  const rawPending = readProperty(record, "pending");
  let pendingLength: number;
  try {
    if (!Array.isArray(rawPending)) fail("invalid_input");
    pendingLength = rawPending.length;
  } catch (error) {
    if (isNotesnookWriteContractError(error)) throw error;
    fail("invalid_input");
  }
  if (!Number.isSafeInteger(pendingLength) || pendingLength > MAX_PENDING_MARKERS) {
    fail("invalid_input");
  }
  const pending: SyncPendingMarker[] = [];
  for (let index = 0; index < pendingLength; index++) {
    const rawMarker = readArrayIndex(rawPending as readonly unknown[], index);
    const markerRecord = requireRecord(rawMarker, "pending marker");
    const operation = readProperty(markerRecord, "operation");
    const noteId = readProperty(markerRecord, "noteId");
    const sequence = readProperty(markerRecord, "sequence");
    if (
      !isOperation(operation) ||
      typeof noteId !== "string" ||
      !validNoteId(noteId) ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    ) {
      fail("invalid_input");
    }
    pending.push(freezeMarker({ operation, noteId, sequence }));
  }
  return freezeState(pending);
}

function emptyState(): SyncCoordinatorState {
  return freezeState([]);
}

function copyMarker(marker: SyncPendingMarker): SyncPendingMarker {
  return freezeMarker({
    operation: marker.operation,
    noteId: marker.noteId,
    sequence: marker.sequence,
  });
}

function freezeMarker(marker: SyncPendingMarker): SyncPendingMarker {
  return Object.freeze(marker);
}

function freezeState(pending: readonly SyncPendingMarker[]): SyncCoordinatorState {
  return Object.freeze({
    pending: Object.freeze(pending.map(copyMarker)),
  });
}

function nextSequence(pending: readonly SyncPendingMarker[]): number {
  const greatest = pending.reduce((current, marker) => Math.max(current, marker.sequence), 0);
  if (greatest >= Number.MAX_SAFE_INTEGER) fail("invalid_input");
  return greatest + 1;
}

function parseExecutorResult(value: unknown): SyncExecutorResult {
  try {
    const record = requireRecord(value, "executor result");
    const status = readProperty(record, "status");
    if (status === "confirmed" || status === "failed") {
      return Object.freeze({ status });
    }
    if (status === "retry") {
      const retryAfterMs = readProperty(record, "retryAfterMs");
      if (retryAfterMs !== undefined) {
        if (
          typeof retryAfterMs !== "number" ||
          !Number.isInteger(retryAfterMs) ||
          retryAfterMs < 0 ||
          retryAfterMs > Number.MAX_SAFE_INTEGER
        ) {
          fail("sync_failed");
        }
        return Object.freeze({ status: "retry" as const, retryAfterMs });
      }
      return Object.freeze({ status: "retry" as const });
    }
    fail("sync_failed");
  } catch {
    fail("sync_failed");
  }
}

function backoffDelay(baseDelayMs: number, attempt: number): number {
  return Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** (attempt - 1));
}

function failedResult(attempts: number, startedAt: number): SyncCoordinatorResult {
  return Object.freeze({
    status: "failed" as const,
    errorCode: "sync_failed" as const,
    localCommitted: true as const,
    remoteSynced: false as const,
    pendingSync: true as const,
    attempts,
    startedAt,
  });
}

function safeNow(now: () => number): number {
  try {
    const value = Reflect.apply(now, undefined, []);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      fail("sync_failed");
    }
    return value;
  } catch (error) {
    if (isNotesnookWriteContractError(error)) throw error;
    fail("sync_failed");
  }
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    fail("invalid_input");
  }
}

function readArrayIndex(value: readonly unknown[], index: number): unknown {
  try {
    return Reflect.get(value, String(index));
  } catch {
    fail("invalid_input");
  }
}

function fail(code: NotesnookWriteErrorCode): never {
  throw new NotesnookWriteContractError(code);
}
