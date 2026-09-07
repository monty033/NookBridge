/**
 * NookBridge Stage 5 — strict `nookd` service configuration + diagnostics.
 *
 * The daemon is configured only through a small, root-owned, non-secret
 * configuration file.  This module owns that loader and the
 * `nookd --check-config <absolute-config-path>` diagnostic surface.
 *
 * Why a separate loader:
 *
 *   - The existing {@link loadConfig} (Stage 1) is intentionally wide:
 *     it owns the dev backend selection, the database path, the
 *     redaction list, and the doctor endpoint.  Wiring `nookd` through
 *     it would re-introduce the development-file backend and the
 *     generic-merge ergonomics the Stage 5 service-boundary decision
 *     record explicitly forbids.
 *   - The service-side schema is the *smallest* root-owned policy: an
 *     absolute service state directory, an absolute socket path, a
 *     non-empty safe socket-group token, the fixed
 *     `systemd-credential` backend id, the literal
 *     `nookbridge-db-key` credential label, and the read-policy
 *     allowlist. The legacy read-only tuple remains valid; the deployed
 *     outbound-sync policy also admits `notes.sync` from the closed method
 *     universe. Anything else — credential paths, env overrides, dev
 *     backends, generic merge behavior — is categorically refused.
 *   - Every loader / diagnostic error is a frozen
 *     {@link ServiceConfigError} whose `category` is a closed string
 *     vocabulary.  Path, value, file contents, credential label, and
 *     raw parser messages are never echoed through the public surface.
 *
 * Why a stat seam:
 *
 *   - In production the loader will assert that the config file is
 *     owned by `uid === 0` and is not group/world writable.  Tests
 *     may need to exercise either branch without root or chmod
 *     elevation; the seam lets the caller substitute a deterministic
 *     stat-shaped value without touching the production code path.
 *
 * Why the implementation does NOT read the file contents as text and
 * then reparse them with a generic merge helper:
 *
 *   - "Generic merge" is exactly the behavior that lets an operator
 *     (or a hostile operator-script) silently widen the schema.  The
 *     loader reads the file, parses JSON strictly, and walks the
 *     parsed object itself; duplicate keys, unknown fields, and
 *     unexpected types are rejected before any field is even copied.
 */

import { constants as fsConstants, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { RpcMethod } from "../service/rpc-protocol.js";

/**
 * The fixed canonical backend id from the Stage 5 service-boundary
 * decision record.  The daemon MUST NOT select any other backend.
 */
export const SERVICE_CONFIG_BACKEND = "systemd-credential" as const;

/**
 * The public credential label the deployment will inject under
 * `$CREDENTIALS_DIRECTORY`.  Mirrors {@link NOOKBRIDGE_DB_KEY_LABEL}
 * so the loader can enforce equality without importing the keystore
 * module (which would create a coupling the loader should not have).
 */
export const SERVICE_CONFIG_CREDENTIAL_NAME = "nookbridge-db-key" as const;

/**
 * The closed read-policy allowlist.  Anything other than this exact
 * tuple is rejected.
 */
export const SERVICE_CONFIG_READ_POLICY = Object.freeze([
  "notes.search",
  "notes.status",
  "notes.list_notebooks",
  "notes.get",
] as const);

/**
 * Closed service-policy method universe. This mirrors the published
 * RpcMethod union and deliberately excludes `notes.delete`.
 */
export const SERVICE_CONFIG_ALLOWED_METHODS: ReadonlyArray<RpcMethod> = Object.freeze([
  "notes.search",
  "notes.status",
  "notes.list_notebooks",
  "notes.get",
  "notes.create",
  "notes.append",
  "notes.update",
  "notes.sync",
]);

/**
 * Closed category vocabulary for {@link ServiceConfigError}.
 */
export const SERVICE_CONFIG_ERROR_CATEGORIES = Object.freeze([
  "unknown_field",
  "duplicate_field",
  "invalid_type",
  "unsafe_state_dir",
  "invalid_socket_path",
  "invalid_socket_group",
  "invalid_backend",
  "invalid_credential_name",
  "invalid_read_policy",
  "forbidden_credential_path",
  "forbidden_env_override",
  "unsafe_config_owner",
  "unsafe_config_mode",
  "unsafe_config_type",
  "config_unreadable",
  "config_malformed_json",
] as const);

export type ServiceConfigErrorCategory = (typeof SERVICE_CONFIG_ERROR_CATEGORIES)[number];

/**
 * Categorical config error.  Carries ONLY the category — never the
 * raw path, the offending value, the parser message, or any
 * credential label.  The `message` is a short, redacted description.
 */
export class ServiceConfigError extends Error {
  readonly category: ServiceConfigErrorCategory;
  constructor(category: ServiceConfigErrorCategory, message: string) {
    super(message);
    this.name = "ServiceConfigError";
    this.category = category;
    Object.defineProperty(this, "cause", { configurable: true, value: undefined });
    Object.defineProperty(this, "__context__", { configurable: true, value: undefined });
    Object.freeze(this);
  }
}

/**
 * Type guard for {@link ServiceConfigError}.
 */
export function isServiceConfigError(value: unknown): value is ServiceConfigError {
  return value instanceof ServiceConfigError;
}

/**
 * The frozen service config.  All fields are required.
 */
export interface ServiceConfig {
  readonly stateDir: string;
  readonly socketPath: string;
  readonly socketGroup: string;
  readonly backend: typeof SERVICE_CONFIG_BACKEND;
  readonly credentialName: typeof SERVICE_CONFIG_CREDENTIAL_NAME;
  /** A non-empty, duplicate-free subset of the closed RpcMethod universe. */
  readonly readPolicy: ReadonlyArray<RpcMethod>;
}

/**
 * Result of loading a service config.  Either the validated
 * {@link ServiceConfig} or a categorical {@link ServiceConfigError}.
 */
export type LoadServiceConfigResult =
  | { readonly ok: true; readonly config: ServiceConfig }
  | { readonly ok: false; readonly error: ServiceConfigError };

/**
 * Stat-shaped value the loader depends on.  Only `uid` and `mode`
 * are read by the loader; `dev`/`ino` are accepted for seam parity
 * with `fs.Stats` but not consulted.
 */
export interface ServiceConfigStat {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly dev: number;
  readonly ino: number;
}

/**
 * Options for {@link loadServiceConfig} and {@link checkServiceConfig}.
 *
 *   - `stat` substitutes the underlying `fs.lstatSync` so tests can
 *     model a non-root owner or a permissive mode without actually
 *     chmod'ing the test fixture.
 * The owner assertion is fixed to `uid === 0`. Tests use the `stat` seam
 * rather than weakening the production contract.
 */
export interface LoadServiceConfigOptions {
  readonly stat?: (path: string) => ServiceConfigStat;
}

/**
 * Read, parse, and validate a service config file at `path`.
 *
 * Every refusal path returns `{ ok: false, error }` with a frozen
 * categorical error; never throws.
 */
export function loadServiceConfig(
  path: string,
  options: LoadServiceConfigOptions = {},
): LoadServiceConfigResult {
  // Reject runtime-invalid `path` arguments BEFORE any filesystem access.
  // A hostile operator-script that wires a non-string, empty, relative, or
  // control-bearing path through the loader must never reach `readFileSync`
  // and must be turned into a categorical `config_unreadable` result so the
  // error surface stays closed.
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    hasControlCharacter(path)
  ) {
    return {
      ok: false,
      error: new ServiceConfigError("config_unreadable", "service config path is invalid"),
    };
  }

  const stat = options.stat ?? defaultStat;

  let raw: string;
  try {
    raw = readFileSync(path, { encoding: "utf8" });
  } catch {
    return {
      ok: false,
      error: new ServiceConfigError("config_unreadable", "service config is unreadable"),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: new ServiceConfigError("config_malformed_json", "service config is malformed json"),
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: new ServiceConfigError("invalid_type", "service config must be a json object"),
    };
  }

  // Field-level validation.  We walk the object directly so the
  // implementation never relies on a generic merge helper and so we
  // can pin duplicate-key detection against the raw JSON text below.
  if (hasDuplicateTopLevelKeys(raw)) {
    return {
      ok: false,
      error: new ServiceConfigError("duplicate_field", "service config contains a duplicate field"),
    };
  }

  const result = validateFields(parsed, path, stat);
  if (!result.ok) return result;
  return { ok: true, config: result.config };
}

/**
 * Walk the parsed object, validate each field, and return either the
 * frozen {@link ServiceConfig} or the first categorical error.
 *
 * The implementation deliberately checks:
 *
 *   - the JSON contains exactly one occurrence of every required key
 *     and no unknown keys;
 *   - every value has the expected primitive type;
 *   - `stateDir` is absolute, lives under an intended service root,
 *     and is NOT one of the broad system roots the deployment would
 *     never legitimately target;
 *   - `socketPath` is absolute and lives under `/run/nookbridge`;
 *   - `socketGroup` is a non-empty safe group token (POSIX group
 *     name grammar);
 *   - `backend` is the literal `systemd-credential`;
 *   - `credentialName` is the literal `nookbridge-db-key`;
 *   - `readPolicy` is a non-empty, duplicate-free subset of the
 *     closed RpcMethod universe.  The legacy four-method tuple remains
 *     valid; write methods are accepted only from that same universe.
 *   - no credential-path, env-override, dev-backend, or generic
 *     passthrough field slipped through the strict walk.
 */
function validateFields(
  parsed: Record<string, unknown>,
  path: string,
  stat: (p: string) => ServiceConfigStat,
): LoadServiceConfigResult {
  // Strict duplicate-key detection.  `JSON.parse` collapses
  // duplicates silently, so the only way to catch them is to scan the
  // raw text before parsing.  We do that scan at the loader entry
  // point above; here we already trust the parsed shape and verify
  // field-by-field presence / absence / type.

  const allowedKeys: ReadonlySet<string> = new Set([
    "stateDir",
    "socketPath",
    "socketGroup",
    "backend",
    "credentialName",
    "readPolicy",
  ]);

  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) {
      // Special-case the forbidden fields so the categorical error
      // names the *kind* of leak (credential path, env override) the
      // operator accidentally introduced.
      if (
        key === "credentialPath" ||
        key === "credentialPathFile" ||
        key === "keyPath" ||
        key === "keyFile"
      ) {
        return {
          ok: false,
          error: new ServiceConfigError(
            "forbidden_credential_path",
            "service config must not reference a credential path",
          ),
        };
      }
      if (key === "envOverrides" || key === "env" || key === "environment") {
        return {
          ok: false,
          error: new ServiceConfigError(
            "forbidden_env_override",
            "service config must not declare env overrides",
          ),
        };
      }
      return {
        ok: false,
        error: new ServiceConfigError("unknown_field", "service config contains an unknown field"),
      };
    }
  }

  const stateDir = parsed.stateDir;
  if (typeof stateDir !== "string" || stateDir.length === 0) {
    return {
      ok: false,
      error: new ServiceConfigError("invalid_type", "service config stateDir is invalid"),
    };
  }
  if (hasControlCharacter(stateDir)) {
    return {
      ok: false,
      error: new ServiceConfigError("unsafe_state_dir", "service config stateDir is unsafe"),
    };
  }
  if (!isAbsolute(stateDir)) {
    return {
      ok: false,
      error: new ServiceConfigError("unsafe_state_dir", "service config stateDir must be absolute"),
    };
  }
  // After the absolute check we know the stateDir is anchored at
  // `/`.  Reject broad system roots; allow the intended
  // service-owned roots.
  if (!isSafeServiceRoot(stateDir)) {
    return {
      ok: false,
      error: new ServiceConfigError(
        "unsafe_state_dir",
        "service config stateDir is not a service-owned root",
      ),
    };
  }

  const socketPath = parsed.socketPath;
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    return {
      ok: false,
      error: new ServiceConfigError("invalid_type", "service config socketPath is invalid"),
    };
  }
  if (hasControlCharacter(socketPath)) {
    return {
      ok: false,
      error: new ServiceConfigError("invalid_socket_path", "service config socketPath is unsafe"),
    };
  }
  if (!isAbsolute(socketPath)) {
    return {
      ok: false,
      error: new ServiceConfigError(
        "invalid_socket_path",
        "service config socketPath must be absolute",
      ),
    };
  }
  if (!isSafeSocketPath(socketPath)) {
    return {
      ok: false,
      error: new ServiceConfigError(
        "invalid_socket_path",
        "service config socketPath is not a service-owned path",
      ),
    };
  }

  const socketGroup = parsed.socketGroup;
  if (
    typeof socketGroup !== "string" ||
    socketGroup.length === 0 ||
    !isSafeGroupToken(socketGroup)
  ) {
    return {
      ok: false,
      error: new ServiceConfigError(
        "invalid_socket_group",
        "service config socketGroup must be a safe group token",
      ),
    };
  }

  const backend = parsed.backend;
  if (backend !== SERVICE_CONFIG_BACKEND) {
    return {
      ok: false,
      error: new ServiceConfigError(
        "invalid_backend",
        "service config backend must be the production-safe backend",
      ),
    };
  }

  const credentialName = parsed.credentialName;
  if (credentialName !== SERVICE_CONFIG_CREDENTIAL_NAME) {
    return {
      ok: false,
      error: new ServiceConfigError(
        "invalid_credential_name",
        "service config credentialName must be the public credential label",
      ),
    };
  }

  const readPolicy = parsed.readPolicy;
  if (!Array.isArray(readPolicy) || !isValidReadPolicy(readPolicy)) {
    return {
      ok: false,
      error: new ServiceConfigError(
        "invalid_read_policy",
        "service config readPolicy must be a closed non-empty allowlist",
      ),
    };
  }

  // Ownership / mode verification.  Tests may inject a non-root
  // owner to exercise the rejection branch.
  let statResult: ServiceConfigStat;
  try {
    statResult = stat(path);
  } catch {
    return {
      ok: false,
      error: new ServiceConfigError("config_unreadable", "service config could not be inspected"),
    };
  }
  let uid: number;
  let mode: number;
  try {
    uid = statResult.uid;
    mode = statResult.mode;
  } catch {
    return {
      ok: false,
      error: new ServiceConfigError("config_unreadable", "service config could not be inspected"),
    };
  }
  if (uid !== 0) {
    return {
      ok: false,
      error: new ServiceConfigError(
        "unsafe_config_owner",
        "service config owner is not the deployment owner",
      ),
    };
  }
  if ((mode & fsConstants.S_IFMT) !== fsConstants.S_IFREG) {
    return {
      ok: false,
      error: new ServiceConfigError("unsafe_config_type", "service config must be a regular file"),
    };
  }
  // Group or world writable is categorically refused.
  // Mask to the file permission bits and check the
  // group/world write bits.
  const permBits = mode & 0o777;
  if ((permBits & fsConstants.S_IWGRP) !== 0 || (permBits & fsConstants.S_IWOTH) !== 0) {
    return {
      ok: false,
      error: new ServiceConfigError(
        "unsafe_config_mode",
        "service config must not be group or world writable",
      ),
    };
  }

  const configReadPolicy =
    readPolicy.length === SERVICE_CONFIG_READ_POLICY.length &&
    readPolicy.every((value, index) => value === SERVICE_CONFIG_READ_POLICY[index])
      ? SERVICE_CONFIG_READ_POLICY
      : Object.freeze(readPolicy.slice() as RpcMethod[]);
  const config: ServiceConfig = Object.freeze({
    stateDir,
    socketPath,
    socketGroup,
    backend,
    credentialName,
    readPolicy: configReadPolicy,
  });
  return { ok: true, config };
}

function isValidReadPolicy(value: readonly unknown[]): value is readonly RpcMethod[] {
  if (value.length === 0 || value.length > SERVICE_CONFIG_ALLOWED_METHODS.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    const method = value[index];
    if (typeof method !== "string" || !isAllowedServiceMethod(method)) return false;
    for (let previous = 0; previous < index; previous += 1) {
      if (value[previous] === method) return false;
    }
  }
  return true;
}

function isAllowedServiceMethod(value: string): value is RpcMethod {
  for (let index = 0; index < SERVICE_CONFIG_ALLOWED_METHODS.length; index += 1) {
    if (SERVICE_CONFIG_ALLOWED_METHODS[index] === value) return true;
  }
  return false;
}

/**
 * Type guard: a non-null, non-array plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Service-owned state root allowlist.
 *
 * We accept absolute paths that live under an intended service root
 * and reject everything else.  The deployment records the canonical
 * roots; the loader enforces them.
 */
function isSafeServiceRoot(path: string): boolean {
  const normalized = resolve(path);
  if (normalized !== path) return false;
  return normalized === "/var/lib/nookbridge" || normalized.startsWith("/var/lib/nookbridge/");
}

/**
 * Service-owned socket path allowlist.
 *
 * Mirrors {@link isSafeServiceRoot} but for the IPC endpoint.  The
 * deployment binds the daemon to a known service-owned runtime root.
 */
function isSafeSocketPath(path: string): boolean {
  // The deployment contract places the daemon socket under
  // `/run/nookbridge`.  Other absolute roots under /run are also
  // legitimate runtime locations but the canonical contract here is
  // `/run/nookbridge` — broader acceptance would over-claim the
  // deployment path that is not yet wired.
  if (!path.startsWith("/run/nookbridge/")) return false;
  if (path === "/run/nookbridge/") return false;
  // Canonical-text requirement: the literal path must already be in
  // resolved form (no `.` or `..` segments).  Without this check a hostile
  // operator-script could submit `/run/nookbridge/a/../b.sock` — textually
  // inside the allowlist — and slip past the prefix test.  `resolve()`
  // normalizes those segments away, so `resolve(path) === path` is the
  // canonical-form invariant the loader enforces.
  const normalized = resolve(path);
  if (normalized !== path) return false;
  if (!normalized.startsWith("/run/nookbridge/")) return false;
  return true;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a POSIX group-name token.  Conservative: must be
 * non-empty, no whitespace, no separators, and within the POSIX
 * portable filename character set (letters, digits, `_`, `-`, `.`,
 * `+`).
 */
function isSafeGroupToken(name: string): boolean {
  if (name.length === 0 || name.length > 64 || name === "." || name === "..") return false;
  return /^[A-Za-z0-9_.+-]+$/.test(name);
}

/**
 * Detect duplicate top-level keys by walking the already-validated JSON
 * text. JSON.parse collapses duplicates silently; a regex would also
 * mistake a string value containing `"x":` for a field, so track JSON
 * string boundaries and object depth instead.
 */
function hasDuplicateTopLevelKeys(raw: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  let index = 0;

  while (index < raw.length) {
    const character = raw[index];
    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < raw.length) {
        const current = raw[index];
        index += 1;
        if (escaped) {
          escaped = false;
        } else if (current === "\\") {
          escaped = true;
        } else if (current === '"') {
          break;
        }
      }

      if (depth === 1) {
        while (/\s/.test(raw[index] ?? "")) index += 1;
        if (raw[index] === ":") {
          const key = JSON.parse(raw.slice(start, index)) as string;
          if (seen.has(key)) return true;
          seen.add(key);
        }
      }
      continue;
    }

    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    index += 1;
  }
  return false;
}

function defaultStat(path: string): ServiceConfigStat {
  const st = lstatSync(path);
  return { uid: st.uid, gid: st.gid, mode: st.mode, dev: st.dev, ino: st.ino };
}

/**
 * Diagnostic report for `nookd --check-config`.  Categorical pass /
 * fail only; backend id exposed on pass; never a path or value.
 */
export interface ServiceConfigCheckReport {
  readonly status: "pass" | "fail";
  readonly backend?: typeof SERVICE_CONFIG_BACKEND;
  readonly errors: ReadonlyArray<ServiceConfigErrorCategory>;
}

/**
 * Run a categorical config check.  Never throws; always returns a
 * frozen report.
 */
export function checkServiceConfig(
  path: string,
  options: LoadServiceConfigOptions = {},
): ServiceConfigCheckReport {
  const result = loadServiceConfig(path, options);
  if (result.ok) {
    return Object.freeze({
      status: "pass",
      backend: result.config.backend,
      errors: Object.freeze([]) as ReadonlyArray<ServiceConfigErrorCategory>,
    });
  }
  return Object.freeze({
    status: "fail",
    errors: Object.freeze([result.error.category]) as ReadonlyArray<ServiceConfigErrorCategory>,
  });
}

/**
 * Format a {@link ServiceConfigCheckReport} as a single-line,
 * redacted human summary.  Never includes the config path or any
 * field value.
 */
export function formatCheckReport(report: ServiceConfigCheckReport): string {
  if (report.status === "pass") {
    return `service-config: pass (backend=${report.backend ?? "unknown"})`;
  }
  const categories = report.errors.join(",");
  return `service-config: fail (categories=${categories})`;
}
