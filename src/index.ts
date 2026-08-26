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

// CLI entry.
export { run as runNookCtl } from "./cli.js";
