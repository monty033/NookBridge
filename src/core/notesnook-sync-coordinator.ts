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
/** Shared bound with the startup reconciliation inventory cap (see notesnook-live-factory.ts). */
const MAX_KNOWN_NOTE_IDS = 100_000;

/**
 * Merge a new id into the known-id set and enforce {@link MAX_KNOWN_NOTE_IDS}.
 *
 * If the bound would be exceeded, the lexicographically smallest ids are
 * dropped first. Losing a "known" id is always a safe, bounded false
 * negative: the next startup reconciliation pass simply treats that note as
 * newly seen and re-queues it for a redundant confirmation sync. It can
 * never cause a note to be silently skipped, because dropping only ever
 * shrinks the known set, never removes a note's actual pending marker.
 */
function boundedKnownNoteIds(ids: Iterable<string>): string[] {
  const sorted = [...new Set(ids)].sort();
  return sorted.length > MAX_KNOWN_NOTE_IDS
    ? sorted.slice(sorted.length - MAX_KNOWN_NOTE_IDS)
    : sorted;
}
const MAX_NOTE_ID_LENGTH = 128;
const MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_RETRY_AFTER_CAP_MS = 30_000;

/** The only local mutation categories the coordinator can queue. */
export type SyncOperation = "create" | "append" | "update" | "delete";

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

/** Durable pre-mutation intent for an existing note. */
export type SyncWriteIntent = Readonly<{
  readonly operation: "append" | "update" | "delete";
  readonly id: string;
}>;

/** Bounded acknowledgement that a write-ahead intent is durable. */
export type SyncWriteIntentResult = Readonly<{
  readonly operation: SyncWriteIntent["operation"];
  readonly id: string;
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
  /** Metadata-only inventory last durably observed/reconciled. */
  readonly knownNoteIds: readonly string[];
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
  /**
   * Optional jitter source.  Returns a number in `[0, 1)`.  Production
   * defaults to `Math.random`; tests inject a deterministic source so
   * the exponential backoff can be asserted exactly.
   */
  readonly jitter?: () => number;
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

/**
 * Pre-flight capacity check used by the composition before invoking a
 * local mutation.  When the queue is below the bound, the composition
 * proceeds; when at the bound, the composition refuses the mutation
 * so the local commit cannot land without a durable marker.
 */
export type SyncCapacityResult =
  | Readonly<{ readonly kind: "accept" }>
  | Readonly<{ readonly kind: "full"; readonly capacity: number }>;

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
      readonly localCommitted: boolean;
      readonly remoteSynced: true;
      readonly pendingSync: boolean;
      readonly attempts: number;
      readonly startedAt: number;
    }>
  | Readonly<{
      readonly status: "failed";
      readonly errorCode: "sync_failed";
      readonly localCommitted: boolean;
      readonly remoteSynced: false;
      readonly pendingSync: boolean;
      readonly attempts: number;
      readonly startedAt: number;
    }>;

const DEFAULT_JITTER = (): number => Math.random();

const DEFAULT_SLEEP_IMPL: SyncSleep = (delayMs: number) =>
  new Promise<void>((resolve) => {
    globalThis.setTimeout(() => resolve(), Math.max(0, Math.floor(delayMs)));
  });

const DEFAULT_SLEEP: SyncSleep = DEFAULT_SLEEP_IMPL;

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
  readonly #jitter: () => number;
  readonly #now: () => number;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #retryAfterCapMs: number;
  #pending: SyncPendingMarker[];
  #knownNoteIds: string[];
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
    const jitterRaw = readProperty(record, "jitter");
    const jitter =
      jitterRaw === undefined ? DEFAULT_JITTER : requireFunction<() => number>(jitterRaw);

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
    this.#jitter = jitter;
    this.#now = now;
    this.#maxAttempts = maxAttempts;
    this.#baseDelayMs = baseDelayMs;
    this.#retryAfterCapMs = retryAfterCapMs;
    this.#pending = state.pending.map(copyMarker);
    this.#knownNoteIds = [...state.knownNoteIds];
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

    const knownNoteIds = boundedKnownNoteIds([...this.#knownNoteIds, id]);
    const nextState = freezeState(nextPending, knownNoteIds);
    persistLocalCommit(this.#store, nextState);
    this.#pending = [...nextPending];
    this.#knownNoteIds = knownNoteIds;
    this.#nextSequence++;

    return Object.freeze({
      operation,
      id,
      localCommitted: true as const,
      remoteSynced: false as const,
      pendingSync: true as const,
    });
  }

  /**
   * Persist a sync intent before mutating an existing note. If storage fails,
   * this method throws `sync_failed` and the caller must not invoke the local
   * mutator. A durable intent left behind by a later failed mutation is a safe
   * false positive: explicit full sync may do redundant work, but cannot lose
   * a successful mutation from the queue.
   */
  recordSyncIntent(intent: SyncWriteIntent): SyncWriteIntentResult {
    const record = requireRecord(intent, "sync intent");
    const operation = readProperty(record, "operation");
    const id = readProperty(record, "id");
    if (
      (operation !== "append" && operation !== "update" && operation !== "delete") ||
      typeof id !== "string" ||
      !validNoteId(id)
    ) {
      fail("invalid_input");
    }

    const marker = freezeMarker({ operation, noteId: id, sequence: this.#nextSequence });
    const nextPending = [
      ...this.#pending.filter(
        (existing) => existing.operation !== operation || existing.noteId !== id,
      ),
      marker,
    ];
    if (nextPending.length > MAX_PENDING_MARKERS) fail("invalid_input");

    const knownNoteIds = boundedKnownNoteIds([...this.#knownNoteIds, id]);
    try {
      persist(this.#store, freezeState(nextPending, knownNoteIds));
    } catch {
      // The local mutation has not started yet, so this is a normal
      // fail-closed write refusal, not a post-commit missing-marker outcome.
      throw new NotesnookWriteContractError("sync_failed");
    }
    this.#pending = nextPending;
    this.#knownNoteIds = knownNoteIds;
    this.#nextSequence++;

    return Object.freeze({ operation, id, pendingSync: true as const });
  }

  /**
   * Reject `requestSync` while the queue is at the published maximum.
   *
   * The composition refuses to start a new local mutation if the
   * pending queue is full, so a mutation that would commit without a
   * durable marker is impossible (P1-3).  When the queue is below the
   * bound, this method returns `accept`; the caller proceeds.
   *
   * The capacity check is purely metadata and does not consult the
   * remote service.
   */
  checkCapacity(): SyncCapacityResult {
    if (this.#pending.length >= MAX_PENDING_MARKERS) {
      return Object.freeze({ kind: "full" as const, capacity: MAX_PENDING_MARKERS });
    }
    return Object.freeze({ kind: "accept" as const });
  }

  /** Return a defensive, frozen copy of the bounded queue markers. */
  snapshot(): SyncCoordinatorState {
    return freezeState(this.#pending, this.#knownNoteIds);
  }

  /** Reconcile an enumerated metadata-only note inventory against the last durable snapshot. */
  reconcilePendingFromSnapshot(noteIds: readonly string[]): void {
    if (!Array.isArray(noteIds) || noteIds.length > 100_000) fail("invalid_input");
    const current = new Set<string>();
    for (const id of noteIds) {
      if (typeof id !== "string" || !validNoteId(id)) fail("invalid_input");
      current.add(id);
    }
    const known = new Set(this.#knownNoteIds);
    const pendingIds = new Set(this.#pending.map((marker) => marker.noteId));
    const nextPending = [...this.#pending];
    let sequence = this.#nextSequence;
    // The pending queue has a hard bound shared with every normal write.
    // Queue as many orphans as fit, but keep scanning after capacity is
    // reached so IDs already known or pending later in sort order remain in
    // the durable snapshot. Unqueued new IDs stay absent from that snapshot
    // and therefore remain eligible for the next reconciliation pass.
    const reconciledThisPass = new Set<string>();
    for (const id of [...current].sort()) {
      if (known.has(id) || pendingIds.has(id)) {
        reconciledThisPass.add(id);
        continue;
      }
      if (nextPending.length >= MAX_PENDING_MARKERS) continue;
      nextPending.push(freezeMarker({ operation: "update", noteId: id, sequence: sequence++ }));
      reconciledThisPass.add(id);
    }
    const knownNoteIds = [...reconciledThisPass].sort();
    if (
      knownNoteIds.length === this.#knownNoteIds.length &&
      knownNoteIds.every((id, i) => id === this.#knownNoteIds[i]) &&
      nextPending.length === this.#pending.length
    )
      return;
    persist(this.#store, freezeState(nextPending, knownNoteIds));
    this.#pending = nextPending;
    this.#knownNoteIds = knownNoteIds;
    this.#nextSequence = sequence;
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
    const batch = Object.freeze(this.#pending.map(copyMarker));
    const localCommitted = batch.length > 0;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      let response: SyncExecutorResult;
      try {
        const raw = Reflect.apply(this.#executor, undefined, [
          Object.freeze({ pending: batch }),
        ]) as unknown;
        response = (await raw) as SyncExecutorResult;
      } catch {
        if (attempt === this.#maxAttempts) {
          return failedResult(attempt, startedAt, localCommitted, this.#pending.length > 0);
        }
        const slept = await this.#wait(backoffDelay(this.#baseDelayMs, attempt, this.#jitter));
        if (!slept)
          return failedResult(attempt, startedAt, localCommitted, this.#pending.length > 0);
        continue;
      }

      const parsed = parseExecutorResult(response);
      if (parsed.status === "failed") {
        return failedResult(attempt, startedAt, localCommitted, this.#pending.length > 0);
      }
      if (parsed.status === "retry") {
        if (attempt === this.#maxAttempts) {
          return failedResult(attempt, startedAt, localCommitted, this.#pending.length > 0);
        }
        const delay =
          parsed.retryAfterMs === undefined
            ? backoffDelay(this.#baseDelayMs, attempt, this.#jitter)
            : Math.min(parsed.retryAfterMs, this.#retryAfterCapMs);
        const slept = await this.#wait(delay);
        if (!slept)
          return failedResult(attempt, startedAt, localCommitted, this.#pending.length > 0);
        continue;
      }

      try {
        this.#removeBatch(batch);
      } catch {
        return failedResult(attempt, startedAt, localCommitted, this.#pending.length > 0);
      }
      return Object.freeze({
        status: "synced" as const,
        localCommitted,
        remoteSynced: true as const,
        pendingSync: this.#pending.length > 0,
        attempts: attempt,
        startedAt,
      });
    }

    // The loop is bounded by #maxAttempts; this is only a type-level guard.
    return failedResult(this.#maxAttempts, startedAt, localCommitted, this.#pending.length > 0);
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
    persist(this.#store, freezeState(nextPending, this.#knownNoteIds));
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
  return value === "create" || value === "append" || value === "update" || value === "delete";
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
  const rawKnownNoteIds = readProperty(record, "knownNoteIds");
  const knownNoteIds = rawKnownNoteIds === undefined ? [] : rawKnownNoteIds;
  if (
    !Array.isArray(knownNoteIds) ||
    knownNoteIds.length > 100_000 ||
    knownNoteIds.some((id) => typeof id !== "string" || !validNoteId(id))
  )
    fail("invalid_input");
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
  return freezeState(pending, [...new Set(knownNoteIds as string[])].sort());
}

function emptyState(): SyncCoordinatorState {
  return freezeState([], []);
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

function freezeState(
  pending: readonly SyncPendingMarker[],
  knownNoteIds: readonly string[] = [],
): SyncCoordinatorState {
  return Object.freeze({
    pending: Object.freeze(pending.map(copyMarker)),
    knownNoteIds: Object.freeze([...knownNoteIds]),
  });
}

function persistLocalCommit(store: SyncMetadataStateStore, state: SyncCoordinatorState): void {
  try {
    persist(store, state);
  } catch {
    throw new NotesnookWriteContractError("local_sync_marker_failed");
  }
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

function backoffDelay(baseDelayMs: number, attempt: number, jitter: () => number): number {
  // Exponential growth: base * 2^(attempt-1).  The minimum is the
  // base delay itself (PR-65 P1-4) so a retry is never a zero-second
  // wait.  The maximum is the published cap.
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** exponent);
  // Multiplicative jitter: 0.75× to 1.25× of the raw delay.  The
  // jitter source is injected so tests can run deterministically;
  // production supplies the helper that draws from `[0, 1)`.
  const jitterFactor = 0.75 + jitter() * 0.5;
  const withJitter = Math.floor(raw * jitterFactor);
  return Math.max(baseDelayMs, Math.min(MAX_DELAY_MS, withJitter));
}

function failedResult(
  attempts: number,
  startedAt: number,
  localCommitted: boolean,
  pendingSync: boolean,
): SyncCoordinatorResult {
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
