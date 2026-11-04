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
 * The gate has two modes:
 *
 *   - exclusive, `withMutex(database, label, fn)` — acquire, run, release.
 *     One holder at a time, alongside no shared holder. Failures release
 *     deterministically. Reentrant calls on the same gate wait (this is
 *     desirable for atomic preflight → mutation flows).
 *
 *   - shared, `withSharedMutex(database, label, fn)` — any number of shared
 *     holders run together, never alongside an exclusive holder. Readers use
 *     it to observe a note between writes: a mutation that takes several
 *     steps (an append advances the note, then replaces its content) is never
 *     seen half-done by a shared holder.
 *
 * Requests are granted in arrival order, so writers are preferred: a shared
 * request that arrives while an exclusive request is queued waits behind it,
 * and a steady stream of readers cannot starve a writer. The converse holds
 * too, since a reader queued ahead of a writer is not overtaken.
 *
 * Queue depth is capped per mode. `MAX_DEPTH` counts exclusive waiters only
 * and `MAX_SHARED_DEPTH` counts shared waiters only, so read traffic can
 * never make a write fail admission.
 *
 * The lock cannot be re-entered. A holder, in either mode, that asks for the
 * gate again waits behind itself; a shared holder that queues behind a
 * waiting writer deadlocks the pair. No code that runs under the gate may call
 * back into a surface that takes it.
 *
 *   - `peekMutex(database)` — diagnostic, returns current depth without
 *     mutating.
 *
 * The mutex does not know about Notesnook. It is a generic gate; the
 * composition and remote-sync capability add their own failure-mode wrappers.
 */

const MAX_DEPTH = 64;
// Read traffic is far more frequent than writes, so its queue is wider. It is
// counted separately: it can fill without ever touching the exclusive budget.
const MAX_SHARED_DEPTH = 192;

type Mode = "exclusive" | "shared";

interface Waiter {
  readonly mode: Mode;
  readonly grant: () => void;
}

interface MutexState {
  /** An exclusive holder is running. */
  exclusive: boolean;
  /** Shared holders currently running. */
  shared: number;
  /** Pending requests of both modes, in arrival order. */
  waiters: Waiter[];
  exclusiveWaiting: number;
  sharedWaiting: number;
}

const STATES = new WeakMap<object, MutexState>();

function requireState(database: object): MutexState {
  const existing = STATES.get(database);
  if (existing !== undefined) return existing;
  const created: MutexState = {
    exclusive: false,
    shared: 0,
    waiters: [],
    exclusiveWaiting: 0,
    sharedWaiting: 0,
  };
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
  return runUnderGate("exclusive", database, label, fn);
}

/**
 * Run `fn` under the shared side of the mutex bound to `database`.
 *
 * Shared holders run concurrently with each other and never alongside an
 * exclusive holder. Validation, release-on-failure, and the rejected promise
 * for a bad argument all match `withMutex`.
 *
 * A shared request queues behind any exclusive request that is already
 * waiting, so a writer is never starved by readers. Shared waiters are capped
 * separately from exclusive ones (`MAX_SHARED_DEPTH`); a shared request over
 * the cap rejects the same way the exclusive gate does, and does not consume
 * any of the exclusive budget.
 *
 * `fn` must not call `withMutex` or `withSharedMutex` on the same database.
 */
export function withSharedMutex<T>(
  database: unknown,
  label: string,
  fn: () => T | PromiseLike<T>,
): Promise<T> {
  return runUnderGate("shared", database, label, fn);
}

function runUnderGate<T>(
  mode: Mode,
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
  // promise before running `fn`.
  const gate = acquire(state, mode);
  const run = async (): Promise<T> => {
    try {
      const value = await fn();
      return value;
    } finally {
      release(state, mode);
    }
  };

  return gate.then(run, (error: unknown) => {
    // The acquire promise rejected before this caller owned the gate.
    // Do not release the current holder; only an owner may release.
    throw error;
  });
}

/**
 * Acquire the gate for `state` in `mode`. Returns a promise that resolves
 * when the caller holds the gate. If the gate is currently free for that
 * mode and nobody is queued, the caller is the next holder; otherwise the
 * caller queues in arrival order.
 */
function acquire(state: MutexState, mode: Mode): Promise<void> {
  // Reject synchronously if the queue for this mode has reached its cap — this
  // is a fail-closed guard against runaway recursion.
  const waiting = mode === "exclusive" ? state.exclusiveWaiting : state.sharedWaiting;
  const cap = mode === "exclusive" ? MAX_DEPTH : MAX_SHARED_DEPTH;
  if (waiting >= cap) {
    return Promise.reject(new Error(`database mutex queue depth exceeded (${waiting})`));
  }
  // Nothing queued and the gate admits this mode: take it immediately. A
  // non-empty queue always means someone is waiting on a holder, so an
  // arriving request never jumps ahead of it.
  if (state.waiters.length === 0 && admits(state, mode)) {
    take(state, mode);
    return resolvedVoid();
  }
  return new Promise<void>((resolve) => {
    state.waiters.push({
      mode,
      grant: () => {
        take(state, mode);
        resolve();
      },
    });
    if (mode === "exclusive") state.exclusiveWaiting += 1;
    else state.sharedWaiting += 1;
  });
}

function admits(state: MutexState, mode: Mode): boolean {
  if (state.exclusive) return false;
  return mode === "shared" || state.shared === 0;
}

function take(state: MutexState, mode: Mode): void {
  if (mode === "exclusive") state.exclusive = true;
  else state.shared += 1;
}

/**
 * Release the gate for `state`. Drops this holder, then hands the gate to the
 * queue head: one exclusive waiter, or every shared waiter at the front up to
 * the next exclusive one.
 */
function release(state: MutexState, mode: Mode): void {
  if (mode === "exclusive") {
    if (!state.exclusive) return;
    state.exclusive = false;
  } else {
    if (state.shared <= 0) return;
    state.shared -= 1;
  }
  while (state.waiters.length > 0) {
    const head = state.waiters[0]!;
    if (!admits(state, head.mode)) return;
    state.waiters.shift();
    if (head.mode === "exclusive") state.exclusiveWaiting -= 1;
    else state.sharedWaiting -= 1;
    head.grant();
  }
}

function resolvedVoid(): Promise<void> {
  return Promise.resolve();
}

/**
 * Diagnostic snapshot of the mutex state for `database`.
 *
 * Returns `{ depth, queued }`. `depth` is the current holder count (one
 * for an exclusive holder, the running count for shared holders); `queued`
 * is the number of pending waiters of either mode. The function does not
 * mutate the mutex.
 *
 * Returns `{ depth: 0, queued: 0 }` if the database has never been gated.
 */
export function peekMutex(database: unknown): { depth: number; queued: number } {
  if (!isRecord(database)) failInvalidInput();
  const state = STATES.get(database);
  if (state === undefined) return { depth: 0, queued: 0 };
  return { depth: state.exclusive ? 1 : state.shared, queued: state.waiters.length };
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
