/**
 * Admission for the single raw-body assembly buffer owned by a daemon process.
 *
 * The daemon constructs one budget and shares it across connections. Tests and
 * embedders construct their own instances: there is deliberately no exported
 * singleton whose state could leak between tests or independent servers.
 */

export interface LargeBodyLease {
  readonly kind: "acquired";
  /** Declared body size; the caller uses it to size the one assembly buffer. */
  readonly bytes: number;
  /** Return the slot. Repeated calls are harmless and release no newer lease. */
  release(): void;
}

export interface LargeBodyRefusal {
  /** Another declared body is in flight; the RPC caller reports this as `busy`. */
  readonly kind: "busy";
}

export type LargeBodyAcquisition = LargeBodyLease | LargeBodyRefusal;

export interface LargeBodyBudget {
  tryAcquire(bytes: number): LargeBodyAcquisition;
}

/**
 * Construct an independent one-slot body budget.
 *
 * A lease owns its own released flag rather than clearing whichever slot is
 * current. A double release therefore cannot release a lease acquired later.
 */
export function createLargeBodyBudget(): LargeBodyBudget {
  let held = false;
  const busy: LargeBodyRefusal = Object.freeze({ kind: "busy" });

  return Object.freeze({
    tryAcquire(bytes: number): LargeBodyAcquisition {
      if (!Number.isSafeInteger(bytes) || bytes < 1) {
        throw new TypeError("declared body bytes must be a positive safe integer");
      }
      if (held) return busy;
      held = true;
      let released = false;
      return Object.freeze({
        kind: "acquired" as const,
        bytes,
        release(): void {
          if (released) return;
          released = true;
          held = false;
        },
      });
    },
  });
}
