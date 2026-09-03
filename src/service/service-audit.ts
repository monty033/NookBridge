/**
 * Stage 7 Slice 2 — categorical, bounded service audit records.
 *
 * The method field uses the existing four-value RpcMethod union.  Connection
 * watchdog events use `notes.search` as a typed sentinel because no parsed
 * method exists; the event itself disambiguates that case.  No request id,
 * query, title, body, path, credential, token, upstream message, cause, or
 * arbitrary caller data crosses this module.
 */

import type { LogRecord, Logger } from "../logging/logger.js";
import type { RpcMethod } from "./rpc-protocol.js";

const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectDefineProperty = Object.defineProperty;
const reflectOwnKeys = Reflect.ownKeys;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const arrayIsArray = Array.isArray;

export const MAX_AUDIT_LATENCY_MS = 10_000;

export type ServiceAuditEvent =
  | "rpc.request.received"
  | "rpc.request.dispatched"
  | "rpc.response.sent"
  | "rpc.request.timeout"
  | "rpc.connection.idle_timeout"
  | "rpc.connection.budget_exceeded"
  | "rpc.connection.admission_rejected"
  | "rpc.connection.closed";

export type ServiceAuditOutcome =
  | "ok"
  | "invalid_request"
  | "permission_denied"
  | "service_unavailable"
  | "stale_revision"
  | "conflict"
  | "sync_failed"
  | "vault_locked"
  | "not_found"
  | "timeout"
  | "admission_rejected"
  | "budget_exceeded";

export type ServiceAuditPeerCredentials = "self" | "unknown" | "rejected";

export interface ServiceAuditRecord {
  readonly event: ServiceAuditEvent;
  readonly outcome: ServiceAuditOutcome;
  readonly method: RpcMethod;
  readonly requestIdEcho: boolean;
  readonly latencyMs: number;
  readonly peerCredentials: ServiceAuditPeerCredentials;
}

export const SERVICE_AUDIT_EVENTS = objectFreeze([
  "rpc.request.received",
  "rpc.request.dispatched",
  "rpc.response.sent",
  "rpc.request.timeout",
  "rpc.connection.idle_timeout",
  "rpc.connection.budget_exceeded",
  "rpc.connection.admission_rejected",
  "rpc.connection.closed",
] as const);

export const SERVICE_AUDIT_OUTCOMES = objectFreeze([
  "ok",
  "invalid_request",
  "permission_denied",
  "service_unavailable",
  "stale_revision",
  "conflict",
  "sync_failed",
  "vault_locked",
  "not_found",
  "timeout",
  "admission_rejected",
  "budget_exceeded",
] as const);

export function buildServiceAuditRecord(input: ServiceAuditRecord): ServiceAuditRecord {
  if (typeof input !== "object" || input === null || arrayIsArray(input)) {
    throw new Error("invalid service audit record");
  }
  const keys = ownKeys(input);
  if (keys.length !== 6) throw new Error("invalid service audit record");
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      (key !== "event" &&
        key !== "outcome" &&
        key !== "method" &&
        key !== "requestIdEcho" &&
        key !== "latencyMs" &&
        key !== "peerCredentials")
    ) {
      throw new Error("invalid service audit record");
    }
  }
  const event = readOwn(input, "event");
  const outcome = readOwn(input, "outcome");
  const method = readOwn(input, "method");
  const requestIdEcho = readOwn(input, "requestIdEcho");
  const latencyMs = readOwn(input, "latencyMs");
  const peerCredentials = readOwn(input, "peerCredentials");
  if (!isEvent(event) || !isOutcome(outcome) || !isMethod(method)) {
    throw new Error("invalid service audit record");
  }
  if (typeof requestIdEcho !== "boolean") throw new Error("invalid service audit record");
  if (
    typeof latencyMs !== "number" ||
    !Number.isInteger(latencyMs) ||
    !Number.isFinite(latencyMs)
  ) {
    throw new Error("invalid service audit record");
  }
  if (!isPeerCredentials(peerCredentials)) throw new Error("invalid service audit record");
  const clampedLatency = Math.max(0, Math.min(MAX_AUDIT_LATENCY_MS, latencyMs));
  const record = objectCreate(null) as Record<string, unknown>;
  for (const [key, value] of [
    ["event", event],
    ["outcome", outcome],
    ["method", method],
    ["requestIdEcho", requestIdEcho],
    ["latencyMs", clampedLatency],
    ["peerCredentials", peerCredentials],
  ] as const) {
    objectDefineProperty(record, key, {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return objectFreeze(record) as unknown as ServiceAuditRecord;
}

export function emitServiceAudit(logger: Logger | undefined, record: ServiceAuditRecord): void {
  if (logger === undefined) return;
  let safe: ServiceAuditRecord;
  try {
    safe = buildServiceAuditRecord(record);
  } catch {
    return;
  }
  const logRecord = objectCreate(null) as LogRecord;
  for (const [key, value] of [
    ["component", "service_audit"],
    ["event", safe.event],
    ["outcome", safe.outcome],
    ["method", safe.method],
    ["requestIdEcho", safe.requestIdEcho],
    ["latencyMs", safe.latencyMs],
    ["peerCredentials", safe.peerCredentials],
  ] as const) {
    objectDefineProperty(logRecord, key, { value, enumerable: true, writable: false });
  }
  try {
    if (safe.outcome === "ok") logger.info("service_audit", logRecord);
    else if (
      safe.outcome === "timeout" ||
      safe.outcome === "admission_rejected" ||
      safe.outcome === "budget_exceeded"
    ) {
      logger.error("service_audit", logRecord);
    } else {
      logger.warn("service_audit", logRecord);
    }
  } catch {
    // Audit is best effort and cannot alter service behaviour.
  }
}

function ownKeys(value: object): string[] {
  let keys: (string | symbol)[];
  try {
    keys = reflectOwnKeys(value);
  } catch {
    throw new Error("invalid service audit record");
  }
  return keys.map((key) => (typeof key === "string" ? key : "@symbol"));
}

function readOwn(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = objectGetOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error("invalid service audit record");
  }
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new Error("invalid service audit record");
  }
  return descriptor.value;
}

function isEvent(value: unknown): value is ServiceAuditEvent {
  return typeof value === "string" && (SERVICE_AUDIT_EVENTS as readonly string[]).includes(value);
}
function isOutcome(value: unknown): value is ServiceAuditOutcome {
  return typeof value === "string" && (SERVICE_AUDIT_OUTCOMES as readonly string[]).includes(value);
}
function isMethod(value: unknown): value is RpcMethod {
  return (
    value === "notes.search" ||
    value === "notes.status" ||
    value === "notes.list_notebooks" ||
    value === "notes.get" ||
    value === "notes.create" ||
    value === "notes.append" ||
    value === "notes.update"
  );
}
function isPeerCredentials(value: unknown): value is ServiceAuditPeerCredentials {
  return value === "self" || value === "unknown" || value === "rejected";
}
