/**
 * NookBridge source root.
 *
 * Stage 0: pinned, reproducible baseline.  This file exports the
 * baseline constants and the closed Stage 0 surface (see the bottom of
 * the file for what's added in Stage 1).
 *
 * Stage 1 layered on top: PersistentStorage, SecureKeyStore, config,
 * state-directory + lock management, redacting structured logger,
 * and the `nookctl doctor` diagnostic.  Stage 1 entries are added
 * ADDITIVELY — Stage 0 values and the `baseline` object are unchanged
 * and remain part of the public surface that downstream tooling may
 * already import.
 */

export const NOOKBRIDGE_STAGE = "stage-1-persistent-storage" as const;

/**
 * Stage 0 version constant.  Bumped by hand when the baseline changes.
 * Stage 1 keeps Stage 0's value of STAGE_0_VERSION and adds a parallel
 * STAGE_1_VERSION while the second stage is in flight.
 */
export const STAGE_0_VERSION = "0.0.0-stage.0" as const;

/** Stage 1 version. */
export const STAGE_1_VERSION = "0.1.0-stage.1" as const;

/**
 * The upstream Notesnook monorepo commit SHA that this baseline pins.
 *
 * This is the SHA the Stage -1 spike validated against and that Stage 0
 * declares in `docs/pins.md` and `docs/upstream-contract.md`. It is exported
 * as a typed constant so tests can assert the contract rather than reading
 * a markdown file.
 */
export const PINNED_NOTESNOOK_MONOREPO_SHA = "c9c4936d9e8222b86204781cd1c93cdf2a1738d3" as const;

/**
 * The pinned @notesnook/core package version this baseline is built
 * against.  The actual runtime import of @notesnook/core is Stage 2
 * work; Stage 1 implements a structurally compatible IStorage locally
 * (see src/storage/istorage.ts).
 */
export const PINNED_NOTESNOOK_CORE_VERSION = "8.1.3" as const;

/**
 * The Nixpkgs revision this baseline is pinned to (see flake.lock).
 */
export const PINNED_NIXPKGS_REV = "5880666fd9eb563038431edb35c2d0aa595884e6" as const;

/**
 * Stage 0 has no application behaviour. The `baseline` object is a
 * placeholder for what Stage 1 will replace with a real client handle.
 *
 * Stage 1 KEEPS the frozen baseline object for downward compatibility
 * with anything that already imported it from Stage 0.
 */
export const baseline = Object.freeze({
  stage: NOOKBRIDGE_STAGE,
  stage0Version: STAGE_0_VERSION,
  stage1Version: STAGE_1_VERSION,
  notesnookMonorepoSha: PINNED_NOTESNOOK_MONOREPO_SHA,
  notesnookCoreVersion: PINNED_NOTESNOOK_CORE_VERSION,
  nixpkgsRev: PINNED_NIXPKGS_REV,
});

export default baseline;

// ---------------------------------------------------------------------------
// Stage 1 surface — additive exports.
//
// The Stage 1 modules ARE published through this entry point so a
// downstream test (or future Stage 2 importer) can `import { ... } from
// "nookbridge"`.  Stage 0 callers that only read NOOKBRIDGE_STAGE etc.
// are unaffected because every export above is structurally unchanged.

// Local IStorage compatibility type.  See src/storage/istorage.ts for
// the structural conformance notes to upstream @notesnook/core.
export type { IStorage, SerializedKey, SerializedKeyPair, Cipher } from "./storage/istorage.js";

// PersistentStorage — encrypted SQLite-backed IStorage implementation.
export {
  PersistentStorage,
  createPersistentStorage,
  type CreatePersistentStorageOptions,
} from "./storage/persistent-storage.js";

// SecureKeyStore interface and Stage 1 development backend.
export type { SecureKeyStore, KeyStoreBackendId } from "./keystore/keystore.js";
export {
  createDevelopmentFileKeyStore,
  type DevelopmentFileKeyStoreOptions,
} from "./keystore/file-keystore.js";
// Stage 5 production-safe systemd `LoadCredential=` backend.  The
// daemon MUST NOT select the development-file backend; this factory
// is the only production path.  The public credential label is
// `NOOKBRIDGE_DB_KEY_LABEL` and the bounded max credential size is
// `SYSTEMD_CREDENTIAL_MAX_BYTES`.
export {
  createSystemdCredentialKeyStore,
  NOOKBRIDGE_DB_KEY_LABEL,
  SYSTEMD_CREDENTIAL_MAX_BYTES,
  type CreateSystemdCredentialKeyStoreOptions,
} from "./keystore/systemd-credential-keystore.js";

// Configuration + state-directory + lock plumbing.
export type {
  NookBridgeConfig,
  LoadConfigInput,
  LoggerConfig,
  KeyStoreConfig,
  DbConfig,
} from "./config/config.js";
export {
  loadConfig,
  DEFAULT_REDACT_FIELDS as CONFIG_DEFAULT_REDACT_FIELDS,
} from "./config/config.js";
export { ensureStateDir, normaliseStateDir } from "./config/state-dir.js";
export { tryAcquireLock, releaseLock, isLocked, lockPath } from "./config/lock.js";

// Structured logger with secret/content redaction.
export type { Logger, LogLevel, LogRecord } from "./logging/logger.js";
export { createLogger, formatLine, redactRecord, DEFAULT_REDACT_FIELDS } from "./logging/logger.js";

// Diagnostic surface.
export type { DoctorReport, Check, CheckStatus, RunDoctorOptions } from "./doctor/doctor.js";
export { runDoctor } from "./doctor/doctor.js";

// Stage 2A offline authentication boundary. The mock provider is explicitly
// test-only/offline; real account authentication remains deferred to the
// separately authorized Stage 2B live checkpoint — the default CLI
// `nookctl auth` path resolves to a structured `deferred` outcome.
export type {
  AuthCredentials,
  AuthenticatedAuthState,
  AuthProvider,
  AuthSession,
  AuthState,
  ExpiredAuthState,
  SignedOutAuthState,
} from "./auth/types.js";
export { AuthCoordinator, type AuthCoordinatorOptions } from "./auth/coordinator.js";
export { MockAuthProvider, type MockAuthProviderOptions } from "./auth/mock-provider.js";

// Stage 2B-live offline mocked Notesnook UserManager/TokenManager auth
// provider. No @notesnook/core runtime import, no live transport, no signup,
// no MFA enrollment, no SSE, no sync — the provider accepts only an
// injected, structurally-typed Notesnook database handle.
export type {
  MfaSupplier,
  NotesnookAuthProviderOptions,
  NotesnookDatabaseHandle,
  NotesnookTokenEnvelope,
  NotesnookTokenManager,
  NotesnookUserManager,
  PasswordSupplier,
} from "./auth/notesnook-auth-provider.js";
export {
  NOTESNOOK_TOKEN_KEY,
  NotesnookAuthProvider,
  createNotesnookAuthProvider,
} from "./auth/notesnook-auth-provider.js";

// Stage 2A injected upstream-core seam. No @notesnook/core import or live
// service transport is exposed by this boundary.
export type {
  NotesnookCoreAdapterOptions,
  NotesnookCoreFactory,
  NotesnookCoreModule,
  NotesnookCoreSource,
  NotesnookDatabase,
  NotesnookDatabaseSetupOptions,
  NotesnookEventSourceConstructor,
  NotesnookEventSourceInit,
  NotesnookEventSourceLike,
  NotesnookFileEncryptionMetadata,
  NotesnookFileEncryptionMetadataWithHash,
  NotesnookICompressor,
  NotesnookIFileStorage,
  NotesnookRealCoreModule,
  NotesnookRequestOptions,
  NotesnookSQLiteDialect,
  NotesnookSQLiteOptions,
} from "./core/notesnook-core-adapter.js";
export {
  createNotesnookCoreAdapter,
  markRealCoreModule,
  NotesnookCoreAdapter,
  validateDatabaseSetupOptions,
  validateSQLiteOptions,
} from "./core/notesnook-core-adapter.js";

// Stage 2B-live minimal lazy narrow real-core factory. The dynamic
// `import("@notesnook/core")` lives inside the exported factory
// function; ordinary imports of this module do NOT load the pinned
// package, so offline tooling can pull the narrow types without
// paying the cost (or the network surface) of the live module.
export type {
  NotesnookLiveCoreFactory,
  NotesnookLiveCoreHandle,
  NotesnookLiveFactoryOptions,
  NotesnookLiveKvKey,
  NotesnookLiveTokenEnvelope,
  NotesnookLiveUser,
} from "./core/notesnook-live-factory.js";
export {
  NOTESNOOK_LIVE_KV_TOKEN_KEY,
  createNotesnookLiveCoreFactory,
} from "./core/notesnook-live-factory.js";

// Stage 2B-live explicit live Notesnook auth provider. The provider is
// wired to the narrow {@link NotesnookLiveCoreHandle} returned by the
// lazy factory above — it never accepts a raw `Database`, a generic
// transport, or a generic core passthrough. The provider follows the
// pinned login order (email -> optional MFA -> password), refreshes
// via the canonical `_refreshToken(true)` then `getToken()` path,
// persists the envelope only through the upstream `db.kv` accessor
// under the canonical `token` key, and cleans up via
// `core.user.logout(true)` + `token` removal + the injected
// cleanup hook. No password/MFA code is ever cached on the
// provider; the public `AuthSession` never carries a `refresh_token`.
export type {
  LiveCleanupHook,
  LiveMfaSupplier,
  LiveNotesnookAuthProviderOptions,
  LivePasswordSupplier,
} from "./auth/live-notesnook-auth-provider.js";
export {
  LIVE_NOTESNOOK_KV_TOKEN_KEY,
  LiveNotesnookAuthProvider,
  createLiveNotesnookAuthProvider,
} from "./auth/live-notesnook-auth-provider.js";

// Stage 2B-live explicit live auth runner. The runner is the only
// path that drives the live provider from the CLI boundary; it
// collects credentials ONLY through the injected `SecretPrompt`,
// zeroizes every captured buffer, and returns a redacted outcome.
// The runner is OPT-IN — production CLI runs preserve the deferred
// default; callers wire this runner in via the `providerFactory`
// seam when they want to exercise the live handle.
export type {
  LiveAuthCommandKind,
  LiveProviderFactory,
  RunLiveAuthCommandOptions,
  RunLiveAuthResult,
} from "./auth/live-auth-runner.js";
export { runLiveAuthCommand } from "./auth/live-auth-runner.js";

// Stage 2B secure interactive secret-input boundary and admin auth
// command plumbing. No @notesnook/core import, no live transport, no
// credential persistence, and no real account login by default —
// the default admin auth runner resolves to a structured "deferred"
// outcome. The live runner above is the OPT-IN path; it is not
// reached unless a caller wires in the `providerFactory` seam.
export type {
  CollectedSecret,
  CollectSecretOptions,
  SecretKind,
  SecretPrompt,
} from "./auth/secret-input.js";
export {
  collectEmail,
  collectMfaCode,
  collectPassword,
  createStdioPrompt,
} from "./auth/secret-input.js";
export type {
  AuthSubcommand,
  DeferredAuthOutcome,
  ParseAuthCommandResult,
  ParsedAuthCommand,
  RunAuthCommandOptions,
  RunAuthCommandResult,
} from "./auth/admin-command.js";
export { formatAuthHelp, parseAuthCommand, runAuthCommand } from "./auth/admin-command.js";

// Stage 3 preparation — narrow read-only core adapter seam.  The seam
// is the offline, deterministic shape a future Stage 3 runner will
// plug an opened Notesnook Database (or a fake) into.  It exposes a
// closed allowlisted read-only surface (status, sync("full"|"fetch"),
// listNotebooks, noteMetadata, search); it rejects any mutation /
// delete / generic-passthrough; it serializes concurrent sync
// attempts through a per-instance single-flight mutex; and it
// normalizes every failure to a categorical, chain-free error.  No
// raw Database, no generic transport, no live network call is
// exposed.
export type {
  NotesnookReadOnlyAdapterOptions,
  NotesnookReadOnlyDatabase,
  NotesnookReadOnlyDatabaseSource,
  NotesnookReadOnlyNoteMetadata,
  NotesnookReadOnlyNotebookSummary,
  NotesnookReadOnlySearchHit,
  NotesnookReadOnlyStatus,
  NotesnookReadOnlySyncOptions,
  NotesnookReadOnlySyncType,
} from "./core/notesnook-readonly-adapter.js";
export {
  createNotesnookReadOnlyAdapter,
  isNotesnookReadOnlyAdapterError,
  NotesnookReadOnlyAdapter,
} from "./core/notesnook-readonly-adapter.js";

// Stage 3 production projection and operator-only sync proof.  The
// projection exposes only the flattened read-only seam; the raw live
// Database remains internal to the live factory/runtime.
export type { NotesnookReadOnlyProjectionSource } from "./core/notesnook-readonly-projection.js";
export {
  flattenLiveDatabaseToReadOnly,
  isNotesnookReadOnlyProjectionError,
  NotesnookReadOnlyProjectionError,
} from "./core/notesnook-readonly-projection.js";
export type {
  OfflineSyncProofReport,
  OfflineSyncProofStep,
  RunOfflineSyncProofOptions,
} from "./core/notesnook-sync-proof.js";
export {
  formatOfflineSyncProofReport,
  isOfflineSyncProofError,
  runOfflineSyncProof,
  OfflineSyncProofError,
} from "./core/notesnook-sync-proof.js";
export type {
  ParseSyncCommandResult,
  ParsedSyncCommand,
  RunSyncCommandOptions,
  RunSyncCommandResult,
  SyncSubcommand,
} from "./core/notesnook-sync-admin.js";
export {
  formatSyncCommandResult,
  formatSyncHelp,
  LIVE_SYNC_ENABLE_ENV,
  parseSyncCommand,
  runSyncCommand,
} from "./core/notesnook-sync-admin.js";

// Stage 5 local-state conflict-marker observer.  This is a separately named,
// read-only projection and operator command; it does not expose the raw
// database, synchronization, mutation, or conflict-resolution surfaces.
export type {
  NotesnookLocalConflictMetadata,
  NotesnookLocalConflictObservation,
  NotesnookLocalConflictObserver,
  NotesnookLocalConflictSelector,
  NotesnookLocalConflictSource,
} from "./core/notesnook-local-conflict-projection.js";
export {
  createNotesnookLocalConflictObserver,
  isNotesnookLocalConflictProjectionError,
  NotesnookLocalConflictProjectionError,
} from "./core/notesnook-local-conflict-projection.js";
export type {
  ConflictObservationReport,
  ConflictSubcommand,
  NotesnookLocalConflictRuntime,
  ParseConflictCommandResult,
  ParsedConflictCommand,
  RunConflictCommandOptions,
  RunConflictCommandResult,
} from "./core/notesnook-conflict-admin.js";
export {
  formatConflictCommandResult,
  formatConflictHelp,
  LIVE_CONFLICT_ENABLE_ENV,
  parseConflictCommand,
  runConflictCommand,
} from "./core/notesnook-conflict-admin.js";

// Stage 5 Task 3 — isolated production service-runtime constructor.
// The service consumes already-provisioned service-owned state and
// exposes only the read-only database, the bounded title-only search
// capability, and the idempotent cleanup hook.  No `Database`,
// upstream `user` / `token` / `kv` slots, write surface, sync
// surface, local-conflict observer, or auth provider factory is
// reachable through this boundary.
export type {
  CreateProductionServiceRuntimeOptions,
  ServiceRuntime,
} from "./service/service-runtime.js";
export { createProductionServiceRuntime } from "./service/service-runtime.js";

// Stage 5 Task 4 — pure closed framed RPC protocol boundary.  The
// parser and serializer are pure functions of their inputs; no
// runtime / daemon / socket / filesystem / Notesnook import is
// reached through this surface.  Only `notes.search` is in the
// initial allowlist; request and response frames are bounded by
// `STAGE5_RPC_LIMITS`; results are title-only.
export type {
  RpcErrorEnvelope,
  RpcErrorEnvelopePayload,
  RpcMethod,
  RpcNotesSearchParams,
  RpcNotesSearchRequest,
  RpcRequest,
  RpcResponseEnvelope,
  RpcSearchHit,
  RpcSearchResult,
  RpcSuccessEnvelope,
  Stage5RpcLimits,
} from "./service/rpc-protocol.js";
export {
  isRpcProtocolError,
  parseRpcFrame,
  serializeRpcResponse,
  STAGE5_RPC_LIMITS,
} from "./service/rpc-protocol.js";

// Stage 5 Task 5 — pure `notes.search` application handler.  It bridges
// parsed Task 4 requests to the bounded Task 3 service-runtime search seam;
// it does not parse frames, open sockets, or touch live state.
export type { RpcHandlerRuntimeLike } from "./service/rpc-handler.js";
export { handleRpcRequest } from "./service/rpc-handler.js";

// CLI entry.
export { run as runNookCtl } from "./cli.js";
