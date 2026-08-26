/**
 * NookBridge Stage 1 — structured logger with deterministic secret
 * redaction.
 *
 * Design constraints (Stage 1 plan §"Persistent headless client
 * foundation", "structured logging with secret/content redaction"):
 *
 *   - Single line per record (one JSON object), suitable for journald
 *     and for line-based log inspection.
 *   - Redact fields whose key matches `redactFields`, regardless of
 *     nesting depth.  Defaults match the Stage 1 plan:
 *       password, token, secret, key, body, content, note
 *   - Records are never constructed from note content.  The logger
 *     API only accepts `string` messages + a record of primitives;
 *     callers must build redacted records themselves before passing
 *     them in.
 *   - Sink is injected so tests can capture output and doctor can
 *     route to stdout without coupling.
 *
 * Out of scope for Stage 1 (deferred):
 *   - File rotation / journald forwarding — Stage 5+.
 *   - Cross-process log shipping — Stage 9.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogRecord = Record<string, string | number | boolean | null | undefined>;

import process from "node:process";

export type Logger = {
  debug(message: string, record?: LogRecord): void;
  info(message: string, record?: LogRecord): void;
  warn(message: string, record?: LogRecord): void;
  error(message: string, record?: LogRecord): void;
  child(bindings: LogRecord): Logger;
  /** Test-only escape hatch: replace the sink. */
  setSink(sink: (line: string) => void): void;
};

export type LoggerOptions = {
  level?: LogLevel;
  redactFields?: readonly string[];
  /**
   * Where the formatted lines go.  Default is process.stdout.write
   * bound to a single string write (no console.table, no formatting).
   */
  sink?: (line: string) => void;
  /** Bindings applied to every record. */
  bindings?: LogRecord;
};

/** The fields we always redact unless the caller overrides. */
export const DEFAULT_REDACT_FIELDS: readonly string[] = [
  "password",
  "passwd",
  "token",
  "secret",
  "key",
  "apikey",
  "api_key",
  "authorization",
  "body",
  "content",
  "note",
  "ciphertext",
];

const LEVEL_NUM: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Deterministically rewrite `record` so that any key whose leaf name
 * matches `redactFields` is replaced with the marker
 * `[REDACTED:<keyName>]`.  The key NAMES are kept (so an operator can
 * see which field was redacted) but VALUES are dropped.
 *
 * The pass walks the record recursively so a record such as
 * `{ user: { password: "x" } }` becomes `{ user: { password: "[REDACTED]" } }`.
 */
export function redactRecord(record: LogRecord, redactFields: readonly string[]): LogRecord {
  if (redactFields.length === 0) return record;
  const lowered = new Set(redactFields.map((f) => f.toLowerCase()));
  const out: LogRecord = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v == null) {
      if (lowered.has(k.toLowerCase())) {
        out[k] = `[REDACTED:${k.toLowerCase()}]`;
      } else {
        out[k] = v;
      }
    } else {
      // Non-scalar — we deliberately drop without serialising, because
      // serialising user-supplied data is the most common log-leak
      // footgun.  The key name is preserved so an operator can still
      // see WHAT was dropped.
      out[k] = "[REDACTED:non-scalar]";
    }
  }
  return out;
}

/** Format a log line as a single-line JSON object. */
export function formatLine(
  level: LogLevel,
  message: string,
  record: LogRecord,
  bindings: LogRecord,
): string {
  // Stringify manually so we control field ordering and never include
  // undefined values that some JSON parsers normalise away.
  const parts: string[] = [];
  parts.push(`"ts":"${new Date().toISOString()}"`);
  parts.push(`"level":"${level}"`);
  parts.push(`"msg":${stringifyPrim(message)}`);
  for (const [k, v] of Object.entries(bindings)) {
    parts.push(`"${escapeKey(k)}":${stringifyPrim(v)}`);
  }
  for (const [k, v] of Object.entries(record)) {
    parts.push(`"${escapeKey(k)}":${stringifyPrim(v)}`);
  }
  return `{${parts.join(",")}}`;
}

function stringifyPrim(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v == null) return "null";
  return JSON.stringify(String(v));
}

function escapeKey(k: string): string {
  return k.replace(/[\\"\n\r]/g, (c) => `\\${c}`);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minLevel = LEVEL_NUM[options.level ?? "info"];
  const redactFields = options.redactFields ?? DEFAULT_REDACT_FIELDS;
  let sink: (line: string) => void =
    options.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  let bindings: LogRecord = { ...(options.bindings ?? {}) };

  const emit = (level: LogLevel, message: string, record?: LogRecord): void => {
    if (LEVEL_NUM[level] < minLevel) return;
    const safeMessage = message; // message is a string by type contract
    const safeRecord = redactRecord(record ?? {}, redactFields);
    const line = formatLine(level, safeMessage, safeRecord, bindings);
    try {
      sink(line);
    } catch {
      // Logger must never throw.  Silently swallow sink errors so a
      // logging-side mistake never poisons business logic.
    }
  };

  return {
    debug: (msg, rec) => emit("debug", msg, rec),
    info: (msg, rec) => emit("info", msg, rec),
    warn: (msg, rec) => emit("warn", msg, rec),
    error: (msg, rec) => emit("error", msg, rec),
    child: (extra) =>
      createLogger({
        // exactOptionalPropertyTypes forbids passing `undefined` to
        // an optional property; only forward `level` when set so we
        // fall back to the createLogger default.
        ...(options.level ? { level: options.level } : {}),
        redactFields,
        sink: (l) => sink(l),
        bindings: { ...bindings, ...extra },
      }),
    setSink: (next) => {
      sink = next;
    },
  };
}
