/**
 * Why the operator surface said no.
 *
 * Every refusal the operator socket can return collapses to a handful of reply
 * codes, and `service_unavailable` is the one that carries the most different
 * meanings: the daemon never built the runtime, or it built it and the call
 * threw. That code alone cannot separate the two, so the daemon records the
 * distinction here and the wire stays exactly as it is.
 *
 * Nothing in this module reads the error's message, params, handle, title or
 * path. The error class is reduced to a fixed allow-list so a log line cannot
 * become a channel for upstream internals.
 */
import type { RpcErrorCode } from "./rpc-protocol.js";
import { RPC_ERROR_MESSAGES } from "./rpc-protocol.js";
import { isNotesnookReadOnlyProjectionError } from "../core/notesnook-readonly-projection.js";
import { OperatorWriteError } from "./notes-operator-write-runtime.js";

/** The closed set of reasons a refusal can be attributed to. */
export type OperatorRefusalSource =
  | "not_wired"
  | "categorized"
  | "uncaught_throw"
  | "authorize_threw"
  | "serialize_failed";

/**
 * A fixed allow-list of error classes. An unlisted constructor reports as
 * `other`, so the vocabulary stays closed even when a dependency adds a class.
 */
export type OperatorErrorClass =
  | "OperatorWriteError"
  | "ProjectionError"
  | "TypeError"
  | "RangeError"
  | "SyntaxError"
  | "Error"
  | "other";

const ERROR_CLASSES: ReadonlySet<string> = new Set([
  "OperatorWriteError",
  "ProjectionError",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "Error",
]);

/** The record emitted for one refusal. Every field is from a closed vocabulary. */
export type OperatorRefusal = Readonly<{
  method: string;
  /** `no_reply` when the connection was closed without an envelope. */
  code: RpcErrorCode | "no_reply";
  source: OperatorRefusalSource;
  errorClass: OperatorErrorClass;
}>;

/**
 * The line a closed window writes when it had to drop refusals. It is not a
 * refusal itself, so it carries the count instead of a reply code.
 */
export type OperatorRefusalSuppressed = Readonly<{
  method: "operator.request.refused.suppressed";
  source: OperatorRefusalSource;
  dropped: number;
}>;

/** Sink for refusal records; the daemon passes one that writes a log line. */
export type OperatorRefusalSink = (refusal: OperatorRefusal) => void;

/** Sink that also receives the closed-window summary. */
export type OperatorRefusalLogSink = (record: OperatorRefusal | OperatorRefusalSuppressed) => void;

function operatorErrorClass(error: unknown): OperatorErrorClass {
  // Reading `instanceof`, `constructor` or `name` can itself throw on an
  // exotic thrown value (a proxy trap, a getter). A diagnostic must never be
  // the reason a reply is lost, so anything unreadable reports as `other`.
  try {
    if (!(error instanceof Error)) return "other";
    const constructorName = error.constructor?.name;
    if (typeof constructorName !== "string") return "other";
    if (constructorName === "NotesnookReadOnlyProjectionError") return "ProjectionError";
    return ERROR_CLASSES.has(constructorName) ? (constructorName as OperatorErrorClass) : "other";
  } catch {
    return "other";
  }
}

/**
 * Map a thrown error onto the reply code the operator receives, and say where
 * that mapping came from.
 *
 * Trust comes from identity, not from a field. Accepting any thrown object
 * whose `code` matched the vocabulary let an unrelated upstream error carrying
 * `code: "vault_locked"` be reported to the operator as that category.
 */
export function classifyOperatorError(error: unknown): Readonly<{
  code: RpcErrorCode;
  source: Exclude<OperatorRefusalSource, "not_wired" | "authorize_threw" | "serialize_failed">;
  errorClass: OperatorErrorClass;
}> {
  try {
    return classifyOperatorErrorUnsafe(error);
  } catch {
    // Even the identity checks can throw on a hostile thrown value.
    return { code: "service_unavailable", source: "uncaught_throw", errorClass: "other" };
  }
}

function classifyOperatorErrorUnsafe(error: unknown): Readonly<{
  code: RpcErrorCode;
  source: Exclude<OperatorRefusalSource, "not_wired" | "authorize_threw" | "serialize_failed">;
  errorClass: OperatorErrorClass;
}> {
  if (error instanceof OperatorWriteError) {
    return { code: error.code, source: "categorized", errorClass: "OperatorWriteError" };
  }
  if (error !== null && typeof error === "object" && isNotesnookReadOnlyProjectionError(error)) {
    // A projection refusal carries the vocabulary name as its MESSAGE rather
    // than as a `code` property. Only a class-identity-checked projection error
    // may be read that way.
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string" && Object.hasOwn(RPC_ERROR_MESSAGES, message)) {
      return {
        code: message as RpcErrorCode,
        source: "categorized",
        errorClass: "ProjectionError",
      };
    }
  }
  return {
    code: "service_unavailable",
    source: "uncaught_throw",
    errorClass: operatorErrorClass(error),
  };
}

/** The refusal for a method whose runtime the daemon never built. */
export function notWiredRefusal(method: string): OperatorRefusal {
  return { method, code: "service_unavailable", source: "not_wired", errorClass: "other" };
}

export type OperatorRefusalLogOptions = Readonly<{
  /** Writes one line. The daemon passes its logger; tests pass a spy. */
  emit: OperatorRefusalLogSink;
  /** Lines allowed per window. Defaults to the daemon's 60 per minute. */
  limitPerWindow?: number;
  /** Window length in milliseconds. Defaults to one minute. */
  windowMs?: number;
  /** Clock, injectable so a test does not sleep. */
  now?: () => number;
}>;

export type OperatorRefusalLog = OperatorRefusalSink &
  Readonly<{
    /** Emit a suppressed-count line if the last window dropped any. */
    flush: () => void;
    /** How many records the current window has dropped, in total or per source. */
    dropped: (source?: OperatorRefusalSource) => number;
  }>;

const DEFAULT_LIMIT_PER_WINDOW = 60;
const DEFAULT_WINDOW_MS = 60_000;

/**
 * A fixed-window limiter in front of the refusal log.
 *
 * The point of the log is to make a rare refusal attributable, so this never
 * samples — sampling would drop exactly the `not_wired` line an operator is
 * looking for. Instead the window is capped and the drops are counted, so a
 * client that hammers the socket cannot turn the journal into a flush of
 * identical lines.
 */
export function createOperatorRefusalLog(options: OperatorRefusalLogOptions): OperatorRefusalLog {
  const limit = options.limitPerWindow ?? DEFAULT_LIMIT_PER_WINDOW;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  // A monotonic clock: if wall time steps backwards the window would never
  // close and the bucket would count drops instead of logging them.
  const now = options.now ?? (() => performance.now());
  // One bucket per source. The source vocabulary is closed, so this map cannot
  // grow with traffic, and a flood of one kind cannot starve the line an
  // operator is actually looking for.
  const buckets = new Map<
    OperatorRefusalSource,
    { windowStart: number; remaining: number; dropped: number }
  >();
  // The log is a diagnostic: a logger that throws must not turn a refusal into
  // a different reply, and must not skip the accounting below.
  const emitSafely = (record: OperatorRefusal | OperatorRefusalSuppressed): void => {
    try {
      options.emit(record);
    } catch {
      // Nothing to do: the reply the operator receives is not this call's business.
    }
  };

  const bucketFor = (source: OperatorRefusalSource) => {
    const existing = buckets.get(source);
    if (existing !== undefined) return existing;
    const created = { windowStart: now(), remaining: limit, dropped: 0 };
    buckets.set(source, created);
    return created;
  };

  const closeWindow = (
    source: OperatorRefusalSource,
    bucket: { windowStart: number; remaining: number; dropped: number },
    at: number,
  ): void => {
    if (at - bucket.windowStart < windowMs) return;
    if (bucket.dropped > 0) {
      emitSafely({
        method: "operator.request.refused.suppressed",
        source,
        dropped: bucket.dropped,
      });
    }
    bucket.windowStart = at;
    bucket.remaining = limit;
    bucket.dropped = 0;
  };

  const sink = (refusal: OperatorRefusal): void => {
    const bucket = bucketFor(refusal.source);
    closeWindow(refusal.source, bucket, now());
    if (bucket.remaining <= 0) {
      bucket.dropped += 1;
      return;
    }
    bucket.remaining -= 1;
    emitSafely(refusal);
  };

  return Object.assign(sink, {
    flush: (): void => {
      const at = now();
      for (const [source, bucket] of buckets) {
        if (bucket.dropped === 0) continue;
        emitSafely({
          method: "operator.request.refused.suppressed",
          source,
          dropped: bucket.dropped,
        });
        bucket.windowStart = at;
        bucket.remaining = limit;
        bucket.dropped = 0;
      }
    },
    dropped: (source?: OperatorRefusalSource): number =>
      source === undefined
        ? [...buckets.values()].reduce((total, bucket) => total + bucket.dropped, 0)
        : (buckets.get(source)?.dropped ?? 0),
  });
}
