/**
 * `nookd` process entry point.
 *
 * The daemon has one explicit production startup form:
 * `nookd --config <absolute-config-path>`.  It composes the validated
 * service config, the systemd credential store, the bounded production
 * runtime, and the Unix server.  No other startup form may select defaults.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkServiceConfig,
  formatCheckReport,
  loadServiceConfig,
  SERVICE_CONFIG_BACKEND,
  SERVICE_CONFIG_CREDENTIAL_NAME,
  SERVICE_CONFIG_SETTINGS_BACKENDS,
  SERVICE_CONFIG_ALLOWED_METHODS,
  type LoadServiceConfigOptions,
  type LoadServiceConfigResult,
  type ServiceConfig,
  type ServiceConfigSettingsBackend,
} from "./config/service-config.js";
import {
  createSystemdCredentialKeyStore,
  NOOKBRIDGE_DB_KEY_LABEL,
  type CreateSystemdCredentialKeyStoreOptions,
} from "./keystore/systemd-credential-keystore.js";
import type { SecureKeyStore } from "./keystore/keystore.js";
import {
  createProductionServiceRuntime,
  type CreateProductionServiceRuntimeOptions,
  type ServiceRuntime,
} from "./service/service-runtime.js";
import {
  startNookdServer,
  type NookdServerHandle,
  type NookdServerRuntime,
  type StartNookdServerOptions,
} from "./service/nookd-server.js";
import { DEFAULT_SERVICE_ABUSE_BOUNDS } from "./service/service-abuse-bounds.js";
import { createLogger } from "./logging/logger.js";
import type { RpcMethod } from "./service/rpc-protocol.js";
import { createServicePolicyFromMethods, type ServicePolicy } from "./service/service-policy.js";
import {
  buildNotebookIndex,
  type NotebookIndex,
  type NotebookRecord,
} from "./settings/notebook-index.js";
import { createSettingsEvaluator } from "./settings/settings-evaluator.js";
import { loadSettings } from "./settings/settings-loader.js";

const freeze = Object.freeze;
const defineProperty = Object.defineProperty;
const isArray = Array.isArray;
const reflectApply = Reflect.apply;
const reflectGet = Reflect.get;
const reflectOwnKeys = Reflect.ownKeys;

export {
  createNookdServer,
  startNookdServer,
  type NookdServerHandle,
  type NookdServerRuntime,
  type StartNookdServerOptions,
} from "./service/nookd-server.js";

export {
  SERVICE_CONFIG_BACKEND,
  SERVICE_CONFIG_CREDENTIAL_NAME,
  SERVICE_CONFIG_ERROR_CATEGORIES,
  ServiceConfigError,
  checkServiceConfig,
  formatCheckReport,
  isServiceConfigError,
  loadServiceConfig,
  type LoadServiceConfigOptions,
  type LoadServiceConfigResult,
  type ServiceConfig,
  type ServiceConfigCheckReport,
  type ServiceConfigErrorCategory,
  type ServiceConfigStat,
} from "./config/service-config.js";

export { SERVICE_CONFIG_READ_POLICY } from "./config/service-config.js";

export type NookdOutputStream = Readonly<{ write: (chunk: string) => unknown }>;
export type NookdCliOutput = Readonly<{
  stdout: NookdOutputStream;
  stderr: NookdOutputStream;
}>;

export type NookdStartupRuntime = Pick<ServiceRuntime, "search" | "cleanup"> &
  Partial<
    Pick<
      ServiceRuntime,
      | "status"
      | "listNotebooks"
      | "noteMetadata"
      | "createNote"
      | "appendNote"
      | "updateNote"
      | "deleteNote"
      | "resolveNotePath"
      | "pathDiagnostic"
      | "lockedNoteProof"
      | "requestSync"
      | "listNotebooksForSettings"
      | "resolveNotebookPath"
    >
  >;

/** Narrow seams for testing composition without replacing production defaults. */
export type NookdStartupFactories = Readonly<{
  loadConfig: (path: string, options?: LoadServiceConfigOptions) => LoadServiceConfigResult;
  createKeyStore: (options: CreateSystemdCredentialKeyStoreOptions) => SecureKeyStore;
  createRuntime: (options: CreateProductionServiceRuntimeOptions) => Promise<NookdStartupRuntime>;
  readSettingsFile: (path: string) => string;
  startServer: (options: StartNookdServerOptions) => Promise<NookdServerHandle>;
}>;

export type NookdStartupOptions = Readonly<{
  configPath: string;
  /** Config-loader seam/options; never supplies credentials or overrides. */
  configOptions?: LoadServiceConfigOptions;
  /** Offline test seams; omitted by the real entry point. */
  factories?: NookdStartupFactories;
  /** Explicit settings path is a test-only seam; production uses systemd credentials. */
  settingsPath?: string;
}>;

export const NOOKD_STARTUP_ERROR_CATEGORIES = freeze([
  "invalid_arguments",
  "configuration",
  "credentials",
  "settings_invalid",
  "runtime",
  "server",
] as const);
export type NookdStartupErrorCategory = (typeof NOOKD_STARTUP_ERROR_CATEGORIES)[number];

const NOOKD_STARTUP_ERROR_MESSAGES: Readonly<Record<NookdStartupErrorCategory, string>> = freeze({
  invalid_arguments: "nookd startup arguments are invalid",
  configuration: "nookd configuration startup failed",
  credentials: "nookd credential directory or startup failed",
  settings_invalid: "nookd settings startup failed",
  runtime: "nookd runtime startup failed",
  server: "nookd server startup failed",
});
const NOOKD_STARTUP_ERROR_MARKERS = new WeakSet<object>();

/** Public startup failures contain only a closed categorical message. */
export class NookdStartupError extends Error {
  declare readonly category: NookdStartupErrorCategory;

  constructor(category: NookdStartupErrorCategory, _message: string) {
    const safeCategory = isStartupCategory(category) ? category : "runtime";
    super(NOOKD_STARTUP_ERROR_MESSAGES[safeCategory]);
    defineProperty(this, "name", {
      configurable: false,
      enumerable: false,
      value: "NookdStartupError",
      writable: false,
    });
    defineProperty(this, "message", {
      configurable: false,
      enumerable: false,
      value: NOOKD_STARTUP_ERROR_MESSAGES[safeCategory],
      writable: false,
    });
    defineProperty(this, "category", {
      configurable: false,
      enumerable: true,
      value: safeCategory,
      writable: false,
    });
    defineProperty(this, "cause", { configurable: true, value: undefined });
    defineProperty(this, "__context__", { configurable: true, value: undefined });
    NOOKD_STARTUP_ERROR_MARKERS.add(this);
  }
}

const HELP =
  "Usage: nookd --help\n       nookd --check-config <absolute-config-path>\n       nookd --config <absolute-config-path>\n";
const CONFIGURATION_UNAVAILABLE =
  "nookd: invalid startup arguments; refusing to use implicit defaults\n";
const INVALID_CONFIG_ARGUMENT =
  "nookd: invalid configuration argument; refusing to inspect an unvalidated path\n";

const PRODUCTION_STARTUP_FACTORIES: NookdStartupFactories = freeze({
  loadConfig: (path, options) => loadServiceConfig(path, options),
  createKeyStore: (options) => createSystemdCredentialKeyStore(options),
  createRuntime: (options) => createProductionServiceRuntime(options),
  readSettingsFile: (path) => readFileSync(path, "utf8"),
  startServer: (options) => startNookdServer(options),
});

/**
 * Compose and start the only permitted production daemon runtime.
 *
 * The config is loaded exactly once.  The credential label is fixed in this
 * module and the credential directory comes only from systemd's process
 * environment.  Runtime cleanup is wrapped once so both bind failure and
 * every later shutdown release resources exactly once.
 */
export async function startNookd(options: NookdStartupOptions): Promise<NookdServerHandle> {
  try {
    return await startNookdInternal(options);
  } catch (error) {
    const category = getSafeStartupCategory(error);
    if (category !== undefined) throw startupError(category);
    throw startupError("runtime");
  }
}

async function startNookdInternal(options: NookdStartupOptions): Promise<NookdServerHandle> {
  let configPath: string;
  let configOptions: LoadServiceConfigOptions | undefined;
  let factories: NookdStartupFactories;
  let settingsPath: string | undefined;
  try {
    if (typeof options !== "object" || options === null || isArray(options)) {
      throw startupError("invalid_arguments", "nookd startup arguments are invalid");
    }
    configPath = options.configPath;
    if (
      typeof configPath !== "string" ||
      hasControlCharacter(configPath) ||
      !isAbsolute(configPath) ||
      resolve(configPath) !== configPath
    ) {
      throw startupError("invalid_arguments", "nookd startup requires an absolute config path");
    }
    configOptions = options.configOptions;
    factories = options.factories ?? PRODUCTION_STARTUP_FACTORIES;
    settingsPath = options.settingsPath;
    if (
      settingsPath !== undefined &&
      (typeof settingsPath !== "string" ||
        hasControlCharacter(settingsPath) ||
        !isAbsolute(settingsPath) ||
        resolve(settingsPath) !== settingsPath)
    ) {
      throw startupError("invalid_arguments", "nookd settings path is invalid");
    }
  } catch (error) {
    const category = getSafeStartupCategory(error);
    throw startupError(category ?? "invalid_arguments");
  }

  let config: ServiceConfig;
  let policy: ServicePolicy;
  try {
    const loaded =
      configOptions === undefined
        ? factories.loadConfig(configPath)
        : factories.loadConfig(configPath, configOptions);
    // Defense in depth: the loader has already validated the config
    // before returning, but the `factories.loadConfig` seam is callable
    // by hostile tests/scripts.  Re-validate the result here so a
    // service-boundary caller can never forward an unsafe injected
    // config object (hostile getters, wrong backend/credential labels,
    // non-canonical paths, etc.) into createRuntime / startServer.
    config = narrowLoadedServiceConfig(loaded);
    // Policy construction is intentionally deferred until the settings evaluator
    // and trusted notebook index have both been built below.
  } catch {
    throw startupError("configuration", "nookd configuration startup failed");
  }

  let credentialsDirectory: string | undefined;
  try {
    credentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
  } catch {
    throw startupError("credentials", "nookd credential directory is unavailable");
  }
  if (!isSystemdCredentialsDirectory(credentialsDirectory)) {
    throw startupError("credentials", "nookd credential directory is unavailable");
  }

  const resolvedSettingsPath = settingsPath ?? `${credentialsDirectory}/nookbridge-settings`;
  let settingsText: string;
  let settings: ReturnType<typeof loadSettings>;
  try {
    settingsText = factories.readSettingsFile(resolvedSettingsPath);
    if (typeof settingsText !== "string") throw new Error("invalid settings text");
    settings = loadSettings(JSON.parse(settingsText) as unknown);
  } catch {
    throw startupError("settings_invalid", "nookd settings startup failed");
  }

  let keys: SecureKeyStore;
  try {
    keys = factories.createKeyStore({
      credentialsDirectory,
      credentialName: NOOKBRIDGE_DB_KEY_LABEL,
    });
  } catch {
    throw startupError("credentials", "nookd credential startup failed");
  }

  let search: NookdStartupRuntime["search"];
  let status: NookdStartupRuntime["status"];
  let listNotebooks: NookdStartupRuntime["listNotebooks"];
  let noteMetadata: NookdStartupRuntime["noteMetadata"];
  let createNote: NookdStartupRuntime["createNote"];
  let appendNote: NookdStartupRuntime["appendNote"];
  let updateNote: NookdStartupRuntime["updateNote"];
  let deleteNote: NookdStartupRuntime["deleteNote"];
  let resolveNotePath: NookdStartupRuntime["resolveNotePath"];
  let pathDiagnostic: NookdStartupRuntime["pathDiagnostic"];
  let lockedNoteProof: NookdStartupRuntime["lockedNoteProof"];
  let requestSync: NookdStartupRuntime["requestSync"];
  let runtimeCleanup: NookdStartupRuntime["cleanup"] | undefined;
  let listNotebooksForSettings: NonNullable<NookdStartupRuntime["listNotebooksForSettings"]>;
  let resolveNotebookPath: NookdStartupRuntime["resolveNotebookPath"];
  let notebookIndex: NotebookIndex;
  let settingsPhase = false;
  try {
    const runtime = await factories.createRuntime({ stateDir: config.stateDir, keys });
    if (typeof runtime !== "object" || runtime === null) {
      throw new Error("invalid service runtime");
    }
    const capturedSearch = runtime.search;
    const capturedStatus = runtime.status;
    const capturedListNotebooks = runtime.listNotebooks;
    const capturedNoteMetadata = runtime.noteMetadata;
    const capturedCreateNote = runtime.createNote;
    const capturedAppendNote = runtime.appendNote;
    const capturedUpdateNote = runtime.updateNote;
    const capturedDeleteNote = runtime.deleteNote;
    const capturedResolveNotePath = runtime.resolveNotePath;
    const capturedPathDiagnostic = runtime.pathDiagnostic;
    const capturedLockedNoteProof = runtime.lockedNoteProof;
    const capturedRequestSync = runtime.requestSync;
    const capturedListNotebooksForSettings = runtime.listNotebooksForSettings;
    const capturedResolveNotebookPath = runtime.resolveNotebookPath;
    const capturedCleanup = runtime.cleanup;
    if (
      typeof capturedSearch !== "function" ||
      typeof capturedCleanup !== "function" ||
      (capturedStatus !== undefined && typeof capturedStatus !== "function") ||
      (capturedListNotebooks !== undefined && typeof capturedListNotebooks !== "function") ||
      (capturedNoteMetadata !== undefined && typeof capturedNoteMetadata !== "function") ||
      (capturedCreateNote !== undefined && typeof capturedCreateNote !== "function") ||
      (capturedAppendNote !== undefined && typeof capturedAppendNote !== "function") ||
      (capturedUpdateNote !== undefined && typeof capturedUpdateNote !== "function") ||
      (capturedDeleteNote !== undefined && typeof capturedDeleteNote !== "function") ||
      (capturedResolveNotePath !== undefined && typeof capturedResolveNotePath !== "function") ||
      (capturedPathDiagnostic !== undefined && typeof capturedPathDiagnostic !== "function") ||
      (capturedLockedNoteProof !== undefined && typeof capturedLockedNoteProof !== "function") ||
      (capturedRequestSync !== undefined && typeof capturedRequestSync !== "function") ||
      typeof capturedListNotebooksForSettings !== "function" ||
      (capturedResolveNotebookPath !== undefined &&
        typeof capturedResolveNotebookPath !== "function")
    ) {
      throw new Error("invalid service runtime");
    }
    search = capturedSearch;
    status = capturedStatus;
    listNotebooks = capturedListNotebooks;
    noteMetadata = capturedNoteMetadata;
    createNote = capturedCreateNote;
    appendNote = capturedAppendNote;
    updateNote = capturedUpdateNote;
    deleteNote = capturedDeleteNote;
    resolveNotePath = capturedResolveNotePath;
    pathDiagnostic = capturedPathDiagnostic;
    lockedNoteProof = capturedLockedNoteProof;
    requestSync = capturedRequestSync;
    listNotebooksForSettings = capturedListNotebooksForSettings;
    resolveNotebookPath = capturedResolveNotebookPath;
    runtimeCleanup = capturedCleanup;

    settingsPhase = true;
    const notebookRecords = await listNotebooksForSettings();
    if (!Array.isArray(notebookRecords)) throw new Error("invalid notebook hierarchy");
    const notebookIds = new Set<string>();
    for (const notebook of notebookRecords) {
      if (typeof notebook.id !== "string") throw new Error("invalid notebook hierarchy");
      notebookIds.add(notebook.id);
    }
    for (const notebook of notebookRecords) {
      if (notebook.parentId !== undefined && !notebookIds.has(notebook.parentId)) {
        throw new Error("incomplete notebook hierarchy");
      }
    }
    notebookIndex = buildNotebookIndex(notebookRecords as readonly NotebookRecord[]);
    const settingsEvaluator = createSettingsEvaluator(settings, notebookIndex);
    policy = createServicePolicyFromMethods(config.readPolicy, settingsEvaluator);
  } catch {
    if (runtimeCleanup !== undefined) await swallowCleanup(onceAsync(runtimeCleanup));
    throw startupError(
      settingsPhase ? "settings_invalid" : "runtime",
      settingsPhase ? "nookd settings startup failed" : "nookd runtime startup failed",
    );
  }

  if (runtimeCleanup === undefined) throw startupError("runtime", "nookd runtime startup failed");
  const cleanup = onceAsync(runtimeCleanup);
  const serverRuntime: NookdServerRuntime = freeze({
    search,
    ...(status === undefined ? {} : { status }),
    ...(listNotebooks === undefined ? {} : { listNotebooks }),
    ...(noteMetadata === undefined ? {} : { noteMetadata }),
    ...(createNote === undefined ? {} : { createNote }),
    ...(appendNote === undefined ? {} : { appendNote }),
    ...(updateNote === undefined ? {} : { updateNote }),
    ...(deleteNote === undefined ? {} : { deleteNote }),
    ...(requestSync === undefined ? {} : { requestSync }),
    ...(resolveNotePath === undefined ? {} : { resolveNotePath }),
    ...(pathDiagnostic === undefined ? {} : { pathDiagnostic }),
    ...(lockedNoteProof === undefined ? {} : { lockedNoteProof }),
    ...(resolveNotebookPath === undefined ? {} : { resolveNotebookPath }),
    notebookIndex,
    cleanup,
  });

  let serverShutdown: () => Promise<void>;
  try {
    const server = await factories.startServer({
      socketPath: config.socketPath,
      runtime: serverRuntime,
      policy,
      abuseBounds: DEFAULT_SERVICE_ABUSE_BOUNDS,
      auditLogger: createLogger({ bindings: { component: "nookd" } }),
    });
    if (typeof server !== "object" || server === null || isArray(server)) {
      throw new Error("invalid nookd server handle");
    }
    const serverSocketPath = server.socketPath;
    const capturedShutdown = server.shutdown;
    const capturedClose = server.close;
    if (
      typeof serverSocketPath !== "string" ||
      !isAbsolute(serverSocketPath) ||
      serverSocketPath !== config.socketPath ||
      typeof capturedShutdown !== "function" ||
      typeof capturedClose !== "function"
    ) {
      throw new Error("invalid nookd server handle");
    }
    serverShutdown = () => reflectApply(capturedShutdown, server, []);
  } catch {
    await swallowCleanup(cleanup);
    throw startupError("server", "nookd server startup failed");
  }

  const shutdown = onceAsync(async () => {
    let failed = false;
    try {
      await serverShutdown();
    } catch {
      failed = true;
    }
    try {
      await cleanup();
    } catch {
      failed = true;
    }
    if (failed) throw startupError("server", "nookd server shutdown failed");
  });

  return freeze({
    socketPath: config.socketPath,
    shutdown,
    close: shutdown,
  });
}

function isSystemdCredentialsDirectory(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !hasControlCharacter(value) &&
    isAbsolute(value) &&
    !value.split("/").some((segment) => segment === "..")
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Re-validate an already-loaded {@link LoadServiceConfigResult} before the
 * startup path trusts it.  The dedicated loader has already validated the
 * config before returning, but the `factories.loadConfig` seam is callable
 * by hostile tests/scripts; this validator is the only thing standing
 * between an injected `{ ok: true, config }` and the runtime / server.
 *
 * The validator:
 *
 *   - reads every field via {@link Reflect.get} inside a try/catch so a
 *     Proxy with a throwing getter cannot turn the validator into a raw
 *     exception;
 *   - captures each field EXACTLY ONCE so a side-effecting getter cannot
 *     reach a different value on the second access;
 *   - rejects any non-`ok` result, any non-object result, any config that
 *     is missing a required slot, any config that has additional slots,
 *     any non-string field, any field that is not frozen-string equal to
 *     the canonical deployment value, and any stateDir / socketPath that
 *     is not an absolute canonical-text path under its allowed root.
 *
 * It MUST NOT echo the offending value, the config path, or the injected
 * keys.  On any failure it throws an opaque `Error` so the surrounding
 * try/catch in `startNookdInternal` maps it to the closed `configuration`
 * startup category.
 */
function narrowLoadedServiceConfig(loaded: unknown): ServiceConfig {
  // Reject the result object itself before touching any field.  A hostile
  // result object may have a throwing `ok` getter or a getter that
  // returns different values on each access; both are caught here.
  const safeLoaded = safeGet(loaded, "ok");
  if (safeLoaded !== true) throw new Error("invalid service config");
  const configSource = safeGet(loaded, "config");
  const configRecord = safeAsObject(configSource);

  // Capture each required field EXACTLY ONCE through Reflect.get so a
  // hostile getter that mutates state cannot reach a different value on
  // the second read.  Validate field-by-field before reading the next so
  // the error surface is closed.
  const stateDir = captureStringField(configRecord, "stateDir");
  const socketPath = captureStringField(configRecord, "socketPath");
  const socketGroup = captureStringField(configRecord, "socketGroup");
  const backend = captureStringField(configRecord, "backend");
  const credentialName = captureStringField(configRecord, "credentialName");
  const readPolicy = captureReadPolicyField(configRecord, "readPolicy");

  // Reject any extra slot the hostile config might have tacked on.
  // `Object.keys` is itself hostile-getter-safe via Reflect.ownKeys below
  // (covers symbol keys too).
  const ownKeys = reflectOwnKeys(configRecord);
  if (ownKeys.length !== 6 && ownKeys.length !== 7) throw new Error("invalid service config");
  const hasSettingsBackend = ownKeys.some((key) => key === "settingsBackend");
  let settingsBackend: ServiceConfigSettingsBackend | undefined;
  if (hasSettingsBackend) {
    const candidate = safeGet(configRecord, "settingsBackend");
    if (
      typeof candidate !== "string" ||
      !SERVICE_CONFIG_SETTINGS_BACKENDS.includes(candidate as ServiceConfigSettingsBackend)
    ) {
      throw new Error("invalid service config");
    }
    settingsBackend = candidate as ServiceConfigSettingsBackend;
  }
  for (const key of ownKeys) {
    if (
      key !== "stateDir" &&
      key !== "socketPath" &&
      key !== "socketGroup" &&
      key !== "backend" &&
      key !== "credentialName" &&
      key !== "readPolicy" &&
      key !== "settingsBackend"
    ) {
      throw new Error("invalid service config");
    }
  }

  if (
    !isCanonicalAbsolutePath(stateDir, "/var/lib/nookbridge") ||
    !isCanonicalAbsolutePath(socketPath, "/run/nookbridge")
  ) {
    throw new Error("invalid service config");
  }
  if (backend !== SERVICE_CONFIG_BACKEND) {
    throw new Error("invalid service config");
  }
  if (credentialName !== SERVICE_CONFIG_CREDENTIAL_NAME) {
    throw new Error("invalid service config");
  }
  if (!isSafeSocketGroupToken(socketGroup)) {
    throw new Error("invalid service config");
  }
  if (readPolicy.length === 0 || readPolicy.length > SERVICE_CONFIG_ALLOWED_METHODS.length) {
    throw new Error("invalid service config");
  }
  for (let index = 0; index < readPolicy.length; index += 1) {
    const method = readPolicy[index];
    if (typeof method !== "string" || !isAllowedServiceMethod(method)) {
      throw new Error("invalid service config");
    }
    for (let previous = 0; previous < index; previous += 1) {
      if (readPolicy[previous] === method) throw new Error("invalid service config");
    }
  }

  return freeze({
    stateDir,
    socketPath,
    socketGroup,
    backend: SERVICE_CONFIG_BACKEND,
    credentialName: SERVICE_CONFIG_CREDENTIAL_NAME,
    ...(settingsBackend === undefined ? {} : { settingsBackend }),
    readPolicy,
  });
}

function safeGet(record: unknown, key: string): unknown {
  try {
    return reflectGet(record as object, key);
  } catch {
    throw new Error("invalid service config");
  }
}

function safeAsObject(value: unknown): Record<PropertyKey, unknown> {
  try {
    if (typeof value !== "object" || value === null || isArray(value)) {
      throw new Error("invalid service config");
    }
    return value as Record<PropertyKey, unknown>;
  } catch {
    throw new Error("invalid service config");
  }
}

function captureStringField(record: Record<PropertyKey, unknown>, key: string): string {
  const value = safeGet(record, key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid service config");
  }
  return value;
}

function captureReadPolicyField(
  record: Record<PropertyKey, unknown>,
  key: string,
): readonly RpcMethod[] {
  const value = safeGet(record, key);
  if (!isArray(value)) throw new Error("invalid service config");
  const length = value.length;
  if (length === 0 || length > SERVICE_CONFIG_ALLOWED_METHODS.length) {
    throw new Error("invalid service config");
  }

  const captured: RpcMethod[] = [];
  for (let index = 0; index < length; index += 1) {
    let candidate: unknown;
    try {
      candidate = value[index];
    } catch {
      throw new Error("invalid service config");
    }
    if (typeof candidate !== "string" || !isAllowedServiceMethod(candidate)) {
      throw new Error("invalid service config");
    }
    for (let previous = 0; previous < index; previous += 1) {
      if (captured[previous] === candidate) throw new Error("invalid service config");
    }
    captured[index] = candidate;
  }
  return freeze(captured);
}

function isAllowedServiceMethod(value: string): value is RpcMethod {
  for (let index = 0; index < SERVICE_CONFIG_ALLOWED_METHODS.length; index += 1) {
    if (SERVICE_CONFIG_ALLOWED_METHODS[index] === value) return true;
  }
  return false;
}

function isCanonicalAbsolutePath(value: string, allowedRoot: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!isAbsolute(value)) return false;
  if (hasControlCharacter(value)) return false;
  // Canonical-text check: the literal path must already be in resolved form.
  if (resolve(value) !== value) return false;
  if (value === `${allowedRoot}/`) return false;
  return value === allowedRoot || value.startsWith(`${allowedRoot}/`);
}

function isSafeSocketGroupToken(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 64) return false;
  if (value === "." || value === "..") return false;
  return /^[A-Za-z0-9_.+-]+$/.test(value);
}

function onceAsync(task: () => void | Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  return (): Promise<void> => {
    if (inFlight !== undefined) return inFlight;
    inFlight = Promise.resolve().then(task);
    return inFlight;
  };
}

async function swallowCleanup(cleanup: () => Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch {
    // Preserve the startup category; never expose a cleanup cause.
  }
}

function startupError(category: NookdStartupErrorCategory, _message?: string): NookdStartupError {
  return new NookdStartupError(category, NOOKD_STARTUP_ERROR_MESSAGES[category]);
}

function formatStartupError(error: unknown): string {
  const category = getSafeStartupCategory(error);
  if (category !== undefined) return `nookd: ${NOOKD_STARTUP_ERROR_MESSAGES[category]}\n`;
  return "nookd: startup failed\n";
}

function startupExitCode(error: unknown): number {
  return getSafeStartupCategory(error) === "invalid_arguments" ? 64 : 78;
}

function isStartupCategory(value: unknown): value is NookdStartupErrorCategory {
  return (
    typeof value === "string" &&
    (NOOKD_STARTUP_ERROR_CATEGORIES as readonly string[]).includes(value)
  );
}

function getSafeStartupCategory(error: unknown): NookdStartupErrorCategory | undefined {
  if (typeof error !== "object" || error === null || !NOOKD_STARTUP_ERROR_MARKERS.has(error)) {
    return undefined;
  }
  try {
    const category = (error as { readonly category?: unknown }).category;
    return isStartupCategory(category) ? category : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run the CLI surface. Synchronous commands retain their existing numeric
 * return values; the explicit production startup returns a promise because
 * server construction and Unix binding are asynchronous.
 */
export function runNookdCli(
  argv: readonly string[] = process.argv.slice(2),
  output: NookdCliOutput | NookdOutputStream = process,
  stderrOrOptions?: NookdOutputStream | LoadServiceConfigOptions,
  options: LoadServiceConfigOptions = {},
  startupFactories?: NookdStartupFactories,
): number | Promise<number> {
  try {
    const result = runNookdCliInternal(argv, output, stderrOrOptions, options, startupFactories);
    if (typeof result === "number") return result;
    return result.catch(() => {
      safeWriteCliOutput(output, "nookd: startup failed\n");
      return 78;
    });
  } catch {
    safeWriteCliOutput(output, "nookd: startup failed\n");
    return 78;
  }
}

function runNookdCliInternal(
  argv: readonly string[] = process.argv.slice(2),
  output: NookdCliOutput | NookdOutputStream = process,
  stderrOrOptions?: NookdOutputStream | LoadServiceConfigOptions,
  options: LoadServiceConfigOptions = {},
  startupFactories?: NookdStartupFactories,
): number | Promise<number> {
  const stdout = "stdout" in output ? output.stdout : output;
  let stderr = "stderr" in output ? output.stderr : process.stderr;
  let checkOptions = options;

  if (stderrOrOptions !== undefined) {
    if ("write" in stderrOrOptions) {
      stderr = stderrOrOptions;
    } else {
      checkOptions = stderrOrOptions;
    }
  }

  if (argv.length === 1 && argv[0] === "--help") {
    stdout.write(HELP);
    return 0;
  }

  if (argv.length === 2 && argv[0] === "--check-config") {
    const configPath = argv[1];
    if (
      typeof configPath !== "string" ||
      hasControlCharacter(configPath) ||
      !isAbsolute(configPath) ||
      resolve(configPath) !== configPath
    ) {
      stderr.write(INVALID_CONFIG_ARGUMENT);
      return 64;
    }
    const report = checkServiceConfig(configPath, checkOptions);
    const text = `${formatCheckReport(report)}\n`;
    if (report.status === "pass") {
      stdout.write(text);
      return 0;
    }
    stderr.write(text);
    return 78;
  }

  if (argv.length === 2 && argv[0] === "--config") {
    const configPath = argv[1];
    if (
      typeof configPath !== "string" ||
      hasControlCharacter(configPath) ||
      !isAbsolute(configPath) ||
      resolve(configPath) !== configPath
    ) {
      stderr.write(INVALID_CONFIG_ARGUMENT);
      return 64;
    }
    return runNookdStartup(configPath, stdout, stderr, checkOptions, startupFactories);
  }

  stderr.write(CONFIGURATION_UNAVAILABLE);
  return 64;
}

function safeWriteCliOutput(output: NookdCliOutput | NookdOutputStream, message: string): void {
  try {
    if (typeof output !== "object" || output === null) return;
    const candidate = reflectGet(output, "stderr");
    const stream = candidate === undefined ? output : candidate;
    const write = reflectGet(stream, "write");
    if (typeof write === "function") reflectApply(write, stream, [message]);
  } catch {
    // A hostile output object cannot turn a categorical failure into a raw
    // exception or influence the fallback message.
  }
}

/** Promise-normalized CLI entry point for callers that always await startup. */
export async function runNookdCliAsync(
  argv: readonly string[] = process.argv.slice(2),
  output: NookdCliOutput | NookdOutputStream = process,
  stderrOrOptions?: NookdOutputStream | LoadServiceConfigOptions,
  options: LoadServiceConfigOptions = {},
  startupFactories?: NookdStartupFactories,
): Promise<number> {
  return await runNookdCli(argv, output, stderrOrOptions, options, startupFactories);
}

async function runNookdStartup(
  configPath: string,
  stdout: NookdOutputStream,
  stderr: NookdOutputStream,
  configOptions: LoadServiceConfigOptions,
  startupFactories: NookdStartupFactories | undefined,
): Promise<number> {
  void stdout;
  try {
    await startNookd({
      configPath,
      configOptions,
      ...(startupFactories === undefined ? {} : { factories: startupFactories }),
    });
    return 0;
  } catch (error) {
    stderr.write(formatStartupError(error));
    return startupExitCode(error);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runNookdCli();
  if (typeof result === "number") {
    process.exitCode = result;
  } else {
    void result.then((code) => {
      process.exitCode = code;
    });
  }
}
