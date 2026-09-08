/**
 * Single-owner database mutex.
 *
 * Astra finding P1-1: the per-composition `localDepth` counter only serializes
 * operations on the same composition instance. Two distinct composition
 * instances, or two distinct remote-sync capabilities, can race against the
 * same underlying Notesnook database. Sync can interleave with mutation;
 * two append requests can read the same revision and overwrite one another.
 *
 * This module provides a per-`Database` mutex keyed on the database identity
 * itself, so every local mutation AND every remote-sync drain funnels through
 * the same gate regardless of which surface invoked it.
 *
 * The mutex is intentionally not a global registry: it is a WeakMap keyed on
 * the exact database object passed to the factory. The runtime owns the
 * database; closing or discarding it releases the gate without ceremony.
 *
 * Two operations are exposed:
 *
 *   - `withMutex(database, label, fn)` — acquire, run, release. Failures
 *     release deterministically. Reentrant calls on the same gate wait
 *     (this is desirable for atomic preflight → mutation flows).
 *
 *   - `peekMutex(database)` — diagnostic, returns current depth without
 *     mutating.
 *
 * The mutex does not know about Notesnook. It is a generic gate; the
 * composition and remote-sync capability add their own failure-mode wrappers.
 */

const MAX_DEPTH = 64;

interface MutexState {
  depth: number;
  waiters: Array<() => void>;
}

const STATES = new WeakMap<object, MutexState>();

function requireState(database: object): MutexState {
  const existing = STATES.get(database);
  if (existing !== undefined) return existing;
  const created: MutexState = { depth: 0, waiters: [] };
  STATES.set(database, created);
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failInvalidInput(): never {
  throw new TypeError("invalid_input");
}

function rejectInvalid(): Promise<never> {
  return Promise.reject(new TypeError("invalid_input"));
}

/**
 * Run `fn` under the mutex bound to `database`.
 *
 * The label is a short, human-readable identifier (e.g. `local:create`,
 * `remote:sync`). It is used only for diagnostics and must be a bounded
 * string. The label is never logged; the caller may log it if it chooses.
 *
 * The returned promise resolves with `fn`'s resolution, rejects with `fn`'s
 * rejection. Any throw or reject from `fn` releases the gate before
 * propagating.
 *
 * If `database` is not an object, the function returns a rejected promise.
 * If `label` is not a bounded string, the function returns a rejected
 * promise. If `fn` is not a function, the function returns a rejected
 * promise. Callers always receive a `Promise<T>` and never need to handle
 * a synchronous throw from the seam.
 *
 * Depth overflow is bounded — reentrant use above MAX_DEPTH rejects
 * asynchronously rather than queueing forever. This is a fail-closed
 * guard, not a normal operation.
 */
export function withMutex<T>(
  database: unknown,
  label: string,
  fn: () => T | PromiseLike<T>,
): Promise<T> {
  if (!isRecord(database)) return rejectInvalid();
  if (typeof label !== "string" || label.length === 0 || label.length > 64) {
    return rejectInvalid();
  }
  if (typeof fn !== "function") return rejectInvalid();

  const state = requireState(database);

  // Build the gate promise. Every caller waits on this single resolved
  // promise before incrementing depth and running `fn`.
  const gate = acquire(state);
  const run = async (): Promise<T> => {
    try {
      const value = await fn();
      return value;
    } finally {
      release(state);
    }
  };

  return gate.then(run, (error: unknown) => {
    // The acquire promise rejected before this caller owned the gate.
    // Do not release the current holder; only an owner may release.
    throw error;
  });
}

/**
 * Acquire the gate for `state`. Returns a promise that resolves when the
 * caller holds the gate. If the gate is currently idle, the caller is the
 * next holder; otherwise the caller queues behind the current holder.
 *
 * The acquired promise is shared among every waiter, so every queued
 * caller observes the same resolution event.
 */
function acquire(state: MutexState): Promise<void> {
  // Reject synchronously if reentrant depth has reached MAX_DEPTH — this
  // is a fail-closed guard against runaway recursion.
  if (state.waiters.length >= MAX_DEPTH) {
    return Promise.reject(
      new Error(`database mutex queue depth exceeded (${state.waiters.length})`),
    );
  }
  // The first waiter holds the gate immediately (depth 0 → 1); subsequent
  // waiters wait for the current holder to release.
  if (state.depth === 0) {
    state.depth = 1;
    return resolvedVoid();
  }
  return new Promise<void>((resolve) => {
    state.waiters.push(() => {
      state.depth = 1;
      resolve();
    });
  });
}

/**
 * Release the gate for `state`. Decrements depth and hands it to the next
 * queued waiter, if any.
 */
function release(state: MutexState): void {
  if (state.depth <= 0) return;
  state.depth = 0;
  const next = state.waiters.shift();
  if (next !== undefined) {
    next();
  }
}

function resolvedVoid(): Promise<void> {
  return Promise.resolve();
}

/**
 * Diagnostic snapshot of the mutex state for `database`.
 *
 * Returns `{ depth, queued }`. `depth` is the current holder count;
 * `queued` is the number of pending waiters. The function does not mutate
 * the mutex.
 *
 * Returns `{ depth: 0, queued: 0 }` if the database has never been gated.
 */
export function peekMutex(database: unknown): { depth: number; queued: number } {
  if (!isRecord(database)) failInvalidInput();
  const state = STATES.get(database);
  if (state === undefined) return { depth: 0, queued: 0 };
  return { depth: state.depth, queued: state.waiters.length };
}

/**
 * Test-only: drop the gate for `database`. Returns true if a state entry
 * existed. Production callers must not invoke this; the WeakMap entry
 * vanishes when the database is GC'd.
 */
export function __resetMutexForTesting(database: unknown): boolean {
  if (!isRecord(database)) failInvalidInput();
  return STATES.delete(database);
}
