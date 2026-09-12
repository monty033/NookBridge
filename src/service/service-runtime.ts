/**
 * Stage 5 Task 3 — isolated production service-runtime constructor.
 *
 * This module is the dedicated constructor the Stage 5 `nookd` daemon
 * will use.  It reuses the real-core setup plumbing from the CLI
 * live-login runtime but constrains the public surface and refuses
 * any non-production key backend BEFORE opening persistent storage or
 * importing `@notesnook/core`.
 *
 * Security invariants (Stage 5 service-boundary decision record):
 *
 *   - The constructor MUST fail closed when the supplied
 *     `SecureKeyStore` is not the literal `systemd-credential`
 *     variant with `productionSafe: true`, or when its key material
 *     is absent.  The guard fires before any filesystem touch and
 *     before any dynamic import of the pinned real-core package.
 *   - The returned {@link ServiceRuntime} exposes ONLY:
 *       - `readOnly` — the flattened Stage 3 read-only database;
 *       - `search`, `status`, `listNotebooks`, and `noteMetadata` — bounded
 *         read-only capabilities used by the Slice 2 RPC methods;
 *       - optional bounded local note writes;
 *       - optional approval-gated `requestSync()` backed by the existing
 *         remote-sync coordinator;
 *       - `cleanup()` — the idempotent service-owned teardown hook.
 *     No `Database`, no `user`, no `token`, no `kv`, no raw
 *     `localWrite`, no raw `remoteSync`, no `localConflictObserver`,
 *     no `providerFactory`, no credentials, no bodies, no mutators,
 *     and no generic core-method dispatch is reachable through this
 *     boundary.
 *   - Authentication / provisioning is intentionally absent.  The
 *     service consumes already-provisioned service-owned state; the
 *     upstream auth provider is wired ONLY into the CLI live-login
 *     path and never into the service RPC surface.
 *   - All errors emitted from this module are categorical.  They
 *     never include raw upstream error strings, paths, key bytes,
 *     credential labels, or `cause`/`__context__` details.
 *
 * Lifecycle ownership:
 *
 *   The service owns a single {@link ProductionRuntimeCore} closure
 *   returned by the live-login seam.  Calling `cleanup()` closes the
 *   encrypted persistent storage exactly once and is idempotent
 *   across concurrent and serial invocations.  After `cleanup()`
 *   resolves, every capability call returns a categorical
 *   `service_unavailable`-style error.
 */

import { Buffer } from "node:buffer";
import { normaliseStateDir } from "../config/state-dir.js";
import type { SecureKeyStore } from "../keystore/keystore.js";
import type { Logger } from "../logging/logger.js";
import type { NotesnookReadOnlyDatabase } from "../core/notesnook-readonly-adapter.js";
import type { NotesnookRealCoreModule } from "../core/notesnook-core-adapter.js";
import {
  isNotesnookWriteContractError,
  type AppendNoteCommand,
  type CreateNoteCommand,
  type DeleteNoteCommand,
  type NotesnookRevisionToken,
  type UpdateNoteCommand,
} from "../core/notesnook-write-contract.js";
import { isNotesnookReadOnlyAdapterError } from "../core/notesnook-readonly-adapter.js";
import {
  isNotesnookWriteAdapterError,
  type AppendNoteResult,
  type CreateNoteResult,
  type DeleteNoteResult,
  type UpdateNoteResult,
} from "../core/notesnook-write-adapter.js";
import type { RpcLockedNoteProofResult, RpcNotesPathDiagnosticResult } from "./rpc-protocol.js";
import {
  createProductionRuntimeCore,
  type ProductionRuntimeCore,
} from "../auth/live-login-runtime.js";
import {
  parseExactNotePath,
  resolveExactNotePath,
  diagnoseExactNotePath,
  ExactNotePathError,
  type ExactNotePathDiagnostic,
  type ExactNotePathResolution,
} from "./exact-note-path-resolver.js";

export type CreateProductionServiceRuntimeOptions = Readonly<{
  stateDir: string;
  /**
   * Production-safe key store.  MUST be the systemd-credential
   * variant with the literal `productionSafe: true`; any other
   * backend is refused categorically before the encrypted store is
   * opened or the real-core package is touched.
   */
  keys: SecureKeyStore;
  logger?: Logger;
  /** Offline test seam; never pass this from a production caller. */
  injectedModule?: NotesnookRealCoreModule;
}>;

/**
 * The bounded service surface.  FROZEN.  Every slot is
 * structurally validated, every method is wrapped so a throwing
 * hostile getter / method body never leaks a `cause` or
 * `__context__` out of the boundary.
 */
export interface ServiceRuntime {
  /**
   * Flattened Stage 3 read-only database.  Distinct from a raw
   * `Database`: only `search`, `status`, `sync`, `listNotebooks`,
   * and `getNoteMetadata` (the read-only allowlist) are reachable
   * through it.
   */
  readonly readOnly: NotesnookReadOnlyDatabase;
  /**
   * Title-only `notes.search` capability.  The bounded query is
   * validated up front; non-string / empty queries fail
   * categorically without ever touching the real-core.
   */
  readonly search: (query: string) => Promise<ReadonlyArray<Readonly<{ title: string }>>>;
  readonly status: () => Promise<Readonly<{ lastSynced: number; hasUnsyncedChanges: boolean }>>;
  readonly listNotebooks: () => Promise<
    ReadonlyArray<
      Readonly<{
        id: string;
        title: string;
        parentId?: string;
        dateCreated?: number;
        dateModified?: number;
      }>
    >
  >;
  /** Full hierarchy-proven notebook enumeration for boot-time settings. */
  readonly listNotebooksForSettings?: () => Promise<
    ReadonlyArray<
      Readonly<{
        id: string;
        title: string;
        parentId?: string;
        dateCreated?: number;
        dateModified?: number;
      }>
    >
  >;
  readonly noteMetadata: (id: string) => Promise<
    | Readonly<{
        id: string;
        title: string;
        revision?: string;
        dateCreated?: number;
        dateModified?: number;
        notebookId?: string;
        pinned?: boolean;
        favorite?: boolean;
        localOnly?: boolean;
        conflicted?: boolean;
        locked?: boolean;
      }>
    | undefined
  >;
  /** Resolve one exact hierarchical note path to an opaque id and revision. */
  readonly resolveNotePath?: (path: string) => Promise<ExactNotePathResolution>;
  /** Execute the closed daemon-owned locked-note acceptance proof. */
  readonly lockedNoteProof?: (path: string) => Promise<RpcLockedNoteProofResult>;
  /** Execute the closed, read-only exact-path resolver diagnostic. */
  readonly pathDiagnostic?: (path: string) => Promise<RpcNotesPathDiagnosticResult>;
  /** Optional bounded local note creation capability. */
  readonly createNote?: (command: CreateNoteCommand) => Promise<CreateNoteResult>;
  /** Optional bounded local note append capability. */
  readonly appendNote?: (command: AppendNoteCommand) => Promise<AppendNoteResult>;
  /** Optional bounded local note update capability. */
  readonly updateNote?: (command: UpdateNoteCommand) => Promise<UpdateNoteResult>;
  /** Optional bounded local single-note delete capability. */
  readonly deleteNote?: (command: DeleteNoteCommand) => Promise<DeleteNoteResult>;
  /** Optional approval-gated outbound synchronization capability. */
  readonly requestSync?: () => Promise<
    Readonly<{ status: "idle" | "synced" | "failed"; pendingSync: boolean; attempts: number }>
  >;
  /**
   * Idempotent cleanup.  Closes the encrypted persistent storage
   * exactly once and is safe to call concurrently and repeatedly.
   * After cleanup resolves, every `search` call returns a
   * categorical `service_unavailable`-style error.
   */
  readonly cleanup: () => Promise<void>;
}

/**
 * Construct an isolated production service runtime.
 *
 * Fails closed when:
 *
 *   - `keys.backend !== "systemd-credential"`;
 *   - `keys.productionSafe !== true`;
 *   - `keys.getDatabaseKey()` returns `undefined` or empty;
 *   - the real-core setup seam refuses the supplied options;
 *   - the encrypted persistent storage cannot be opened.
 *
 * Every failure is reported through a rejected promise whose
 * `Error` carries only a categorical message; no upstream detail,
 * no path, no key bytes, no credential label.
 */
export async function createProductionServiceRuntime(
  options: CreateProductionServiceRuntimeOptions,
): Promise<ServiceRuntime> {
  const normalized = normalizeServiceRuntimeOptions(options);
  assertProductionSafeKeyStore(normalized.keys);

  let key: string | undefined;
  try {
    key = normalized.keys.getDatabaseKey();
  } catch {
    throw serviceRuntimeError("service runtime key material is unavailable");
  }
  if (typeof key !== "string" || key.length === 0) {
    throw serviceRuntimeError("service runtime key material is unavailable");
  }

  // The production-safe guard has already passed and the key is
  // present; now hand off to the shared real-core setup seam.
  let core: ProductionRuntimeCore;
  try {
    core = await createProductionRuntimeCore({
      stateDir: normalized.stateDir,
      keys: normalized.keys,
      ...(normalized.logger === undefined ? {} : { logger: normalized.logger }),
      ...(normalized.injectedModule === undefined
        ? {}
        : { injectedModule: normalized.injectedModule }),
    });
  } catch {
    // The seam already normalises every internal failure to a
    // categorical Error; the public envelope is the service-runtime
    // equivalent.  We deliberately do not forward any upstream
    // message or storage detail from inside this try/catch.
    throw serviceRuntimeError("service runtime initialization failed");
  }

  if (core.handle.readOnly === undefined) {
    // Defensive: the real-core seam always produces a read-only
    // surface for production-backed runs, but a legacy injected
    // auth-only fake could omit it.  In that case the service
    // surface cannot satisfy `notes.search` and must fail closed.
    try {
      await core.cleanup();
    } catch {
      // best-effort teardown
    }
    throw serviceRuntimeError("service runtime read-only surface is unavailable");
  }

  return buildServiceRuntime(core);
}

function buildServiceRuntime(core: ProductionRuntimeCore): ServiceRuntime {
  const readOnly: NotesnookReadOnlyDatabase = core.handle.readOnly as NotesnookReadOnlyDatabase;
  const lifecycle = core.lifecycle;
  const cleanupOnce = (() => {
    let inFlight: Promise<void> | undefined;
    return (): Promise<void> => {
      if (inFlight) return inFlight;
      inFlight = core.cleanup();
      return inFlight;
    };
  })();

  const search = async (query: string): Promise<ReadonlyArray<Readonly<{ title: string }>>> => {
    if (lifecycle.isClosed()) {
      throw serviceRuntimeError("service runtime is unavailable");
    }
    if (typeof query !== "string" || query.length === 0) {
      throw serviceRuntimeError("service runtime search query must be a non-empty string");
    }
    let hits;
    try {
      hits = await readOnly.search(query);
    } catch {
      throw serviceRuntimeError("service runtime search failed");
    }
    return hits.map((hit) => Object.freeze({ title: hit.title }));
  };

  const status = async (): Promise<
    Readonly<{ lastSynced: number; hasUnsyncedChanges: boolean }>
  > => {
    if (lifecycle.isClosed()) throw serviceRuntimeError("service runtime is unavailable");
    try {
      const [lastSynced, hasUnsyncedChanges] = await Promise.all([
        readOnly.lastSynced(),
        readOnly.hasUnsyncedChanges(),
      ]);
      return Object.freeze({ lastSynced, hasUnsyncedChanges });
    } catch {
      throw serviceRuntimeError("service runtime status failed");
    }
  };

  const listNotebooks = async (): Promise<
    ReadonlyArray<
      Readonly<{
        id: string;
        title: string;
        dateCreated?: number;
        dateModified?: number;
      }>
    >
  > => {
    if (lifecycle.isClosed()) throw serviceRuntimeError("service runtime is unavailable");
    try {
      return Object.freeze(
        (await readOnly.listNotebooks()).map((notebook) => Object.freeze({ ...notebook })),
      );
    } catch {
      throw serviceRuntimeError("service runtime notebook listing failed");
    }
  };

  const listNotebooksForSettingsSource = readOnly.listNotebooksWithParents;
  const listNotebooksForSettings =
    listNotebooksForSettingsSource === undefined
      ? undefined
      : async (): Promise<
          ReadonlyArray<
            Readonly<{
              id: string;
              title: string;
              parentId?: string;
              dateCreated?: number;
              dateModified?: number;
            }>
          >
        > => {
          if (lifecycle.isClosed()) throw serviceRuntimeError("service runtime is unavailable");
          try {
            return Object.freeze(
              (await listNotebooksForSettingsSource()).map((notebook) =>
                Object.freeze({ ...notebook }),
              ),
            );
          } catch {
            throw serviceRuntimeError("service runtime notebook hierarchy listing failed");
          }
        };

  const noteMetadata = async (
    id: string,
  ): Promise<
    | Readonly<{
        id: string;
        title: string;
        revision?: string;
        dateCreated?: number;
        dateModified?: number;
        notebookId?: string;
        pinned?: boolean;
        favorite?: boolean;
        localOnly?: boolean;
        conflicted?: boolean;
        locked?: boolean;
      }>
    | undefined
  > => {
    if (lifecycle.isClosed()) throw serviceRuntimeError("service runtime is unavailable");
    if (typeof id !== "string" || id.length === 0)
      throw serviceRuntimeError("service runtime note id is invalid");
    try {
      const note = await readOnly.noteMetadata(id);
      return note === undefined ? undefined : Object.freeze({ ...note });
    } catch {
      throw serviceRuntimeError("service runtime note lookup failed");
    }
  };

  const findNotesByTitle = readOnly.findNotesByTitle;
  const findNoteIdsByNotebook = readOnly.findNoteIdsByNotebook;
  const hasNoteInNotebook = readOnly.hasNoteInNotebook;
  const resolveNotePath =
    listNotebooksForSettings === undefined ||
    findNotesByTitle === undefined ||
    findNoteIdsByNotebook === undefined
      ? undefined
      : async (path: string): Promise<ExactNotePathResolution> => {
          if (lifecycle.isClosed()) throw serviceRuntimeError("service runtime is unavailable");

          // Validate and extract the title before touching the full notebook
          // hierarchy. Missing titles are definitively not_found; hierarchy
          // enumeration is only needed after a title candidate exists.
          const parsed = parseExactNotePath(path);
          let titleCandidates: Awaited<ReturnType<NonNullable<typeof findNotesByTitle>>>;
          try {
            titleCandidates = await findNotesByTitle(parsed.noteTitle);
          } catch {
            throw serviceRuntimeError("service runtime title search failed");
          }
          if (!Array.isArray(titleCandidates)) {
            throw serviceRuntimeError("service runtime title search failed");
          }
          if (titleCandidates.length === 0) {
            throw new ExactNotePathError("not_found");
          }

          const notebooks =
            parsed.notebookPath === undefined ? [] : await listNotebooksForSettings();
          return resolveExactNotePath(path, {
            notebooks,
            // Reuse the already validated title candidates; positive paths
            // must not perform a second live title search.
            findNotesByTitle: async () => titleCandidates,
            findNoteIdsByNotebook: (notebookId) => findNoteIdsByNotebook(notebookId),
            ...(hasNoteInNotebook === undefined
              ? {}
              : {
                  hasNoteInNotebook: (notebookId: string, noteId: string) =>
                    hasNoteInNotebook(notebookId, noteId),
                }),
            noteMetadata,
          });
        };

  const pathDiagnostic =
    findNotesByTitle === undefined || findNoteIdsByNotebook === undefined
      ? undefined
      : async (path: string): Promise<RpcNotesPathDiagnosticResult> => {
          if (typeof path !== "string") {
            return pathDiagnosticReport(0, {
              title: "unavailable",
              notebook: "unavailable",
              directMembership: "unavailable",
              recursiveMembership: "unavailable",
              revision: "unavailable",
            });
          }
          const pathBytes = Buffer.byteLength(path, "utf8");
          let parsed: ReturnType<typeof parseExactNotePath>;
          try {
            parsed = parseExactNotePath(path);
          } catch {
            return pathDiagnosticReport(pathBytes, {
              title: "unavailable",
              notebook: "unavailable",
              directMembership: "unavailable",
              recursiveMembership: "unavailable",
              revision: "unavailable",
            });
          }

          let titleCandidates: Awaited<ReturnType<NonNullable<typeof findNotesByTitle>>>;
          try {
            titleCandidates = await findNotesByTitle(parsed.noteTitle);
          } catch {
            return pathDiagnosticReport(pathBytes, {
              title: "unavailable",
              notebook: parsed.notebookPath === undefined ? "not_applicable" : "unavailable",
              directMembership: "not_applicable",
              recursiveMembership: "not_applicable",
              revision: "unavailable",
            });
          }
          if (!Array.isArray(titleCandidates) || titleCandidates.length > 256) {
            return pathDiagnosticReport(pathBytes, {
              title: "unavailable",
              notebook: parsed.notebookPath === undefined ? "not_applicable" : "unavailable",
              directMembership: "not_applicable",
              recursiveMembership: "not_applicable",
              revision: "unavailable",
            });
          }
          if (titleCandidates.length === 0) {
            return pathDiagnosticReport(pathBytes, {
              title: "none",
              notebook: parsed.notebookPath === undefined ? "not_applicable" : "not_applicable",
              directMembership: "not_applicable",
              recursiveMembership: "not_applicable",
              revision: "not_applicable",
            });
          }

          let notebooks: Awaited<ReturnType<NonNullable<typeof listNotebooksForSettings>>> = [];
          if (parsed.notebookPath !== undefined) {
            if (listNotebooksForSettings === undefined) {
              return pathDiagnosticReport(pathBytes, {
                title: titleCandidates.length === 1 ? "one" : "multiple",
                notebook: "unavailable",
                directMembership: "not_applicable",
                recursiveMembership: "not_applicable",
                revision: "unavailable",
              });
            }
            try {
              notebooks = await listNotebooksForSettings();
            } catch {
              return pathDiagnosticReport(pathBytes, {
                title: titleCandidates.length === 1 ? "one" : "multiple",
                notebook: "unavailable",
                directMembership: "not_applicable",
                recursiveMembership: "not_applicable",
                revision: "unavailable",
              });
            }
          }

          const diagnostic = await diagnoseExactNotePath(path, {
            notebooks,
            findNotesByTitle: async () => titleCandidates,
            findNoteIdsByNotebook: (notebookId) => findNoteIdsByNotebook(notebookId),
            ...(hasNoteInNotebook === undefined
              ? {}
              : {
                  hasNoteInNotebook: (notebookId: string, noteId: string) =>
                    hasNoteInNotebook(notebookId, noteId),
                }),
            noteMetadata,
          });
          return pathDiagnosticReport(pathBytes, diagnostic);
        };

  const localWrite = core.handle.localWrite;
  const createNote =
    localWrite === undefined
      ? undefined
      : async (command: CreateNoteCommand): Promise<CreateNoteResult> => {
          if (lifecycle.isClosed()) throw serviceRuntimeError("service runtime is unavailable");
          try {
            const result = await localWrite.createNote(command);
            if (result.operation !== "create") {
              throw serviceRuntimeError("service runtime note creation failed");
            }
            return result;
          } catch (error) {
            if (isServiceRuntimeError(error)) throw error;
            throw serviceRuntimeError("service runtime note creation failed");
          }
        };

  const appendNote =
    localWrite === undefined
      ? undefined
      : async (command: AppendNoteCommand): Promise<AppendNoteResult> => {
          if (lifecycle.isClosed()) throw serviceRuntimeError("service runtime is unavailable");
          try {
            const result = await localWrite.appendNote(command);
            if (result.operation !== "append") {
              throw serviceRuntimeError("service runtime note append failed");
            }
            return result;
          } catch (error) {
            if (isServiceRuntimeError(error)) throw error;
            if (isNotesnookWriteAdapterError(error) || isNotesnookWriteContractError(error))
              throw error;
            throw serviceRuntimeError("service runtime write failed");
          }
        };

  const updateNote =
    localWrite === undefined
      ? undefined
      : async (command: UpdateNoteCommand): Promise<UpdateNoteResult> => {
          if (lifecycle.isClosed()) throw serviceRuntimeError("service runtime is unavailable");
          try {
            const result = await localWrite.updateNote(
              command as unknown as Parameters<typeof localWrite.updateNote>[0],
            );
            if (result.operation !== "update") {
              throw serviceRuntimeError("service runtime note update failed");
            }
            return result;
          } catch (error) {
            if (isServiceRuntimeError(error)) throw error;
            if (isNotesnookWriteAdapterError(error) || isNotesnookWriteContractError(error))
              throw error;
            throw serviceRuntimeError("service runtime write failed");
          }
        };

  const deleteFn = localWrite?.deleteNote;
  const deleteNote =
    deleteFn === undefined
      ? undefined
      : async (command: DeleteNoteCommand): Promise<DeleteNoteResult> => {
          if (lifecycle.isClosed()) throw serviceRuntimeError("service runtime is unavailable");
          try {
            const result = await deleteFn(command);
            if (result.operation !== "delete") {
              throw serviceRuntimeError("service runtime note delete failed");
            }
            return result;
          } catch (error) {
            if (isServiceRuntimeError(error)) throw error;
            if (isNotesnookWriteAdapterError(error) || isNotesnookWriteContractError(error))
              throw error;
            throw serviceRuntimeError("service runtime write failed");
          }
        };

  const proofReadNoteLockState =
    readOnly.readNoteLockState ??
    (async (id: string): Promise<"locked" | "unlocked"> => {
      const metadata = await noteMetadata(id);
      if (metadata === undefined) throw serviceRuntimeError("note lock state is unavailable");
      return metadata.locked === true ? "locked" : "unlocked";
    });
  const lockedNoteProof =
    resolveNotePath === undefined || updateNote === undefined || deleteNote === undefined
      ? undefined
      : async (path: string): Promise<RpcLockedNoteProofResult> => {
          const pathBytes = Buffer.byteLength(path, "utf8");
          const report = {
            kind: "locked_note_proof" as const,
            pathBytes,
            read: "service_unavailable" as RpcLockedNoteProofResult["read"],
            update: "service_unavailable" as RpcLockedNoteProofResult["update"],
            delete: "service_unavailable" as RpcLockedNoteProofResult["delete"],
          };
          let resolution: ExactNotePathResolution;
          try {
            parseExactNotePath(path);
            resolution = await resolveNotePath(path);
          } catch (error) {
            if (error instanceof ExactNotePathError && error.code === "not_found") {
              return Object.freeze({
                ...report,
                read: "not_found",
                update: "not_found",
                delete: "not_found",
              });
            }
            return Object.freeze(report);
          }

          try {
            report.read =
              (await proofReadNoteLockState(resolution.id)) === "locked" ? "vault_locked" : "ok";
          } catch (error) {
            report.read = isVaultLockedReadProofError(error)
              ? "vault_locked"
              : "service_unavailable";
          }
          const pinned = resolution.pinned === true;
          try {
            await updateNote({
              id: resolution.id,
              expectedRevision: resolution.expectedRevision as NotesnookRevisionToken,
              patch: { pinned },
            });
            report.update = "ok";
          } catch (error) {
            report.update = isVaultLockedWriteProofError(error)
              ? "vault_locked"
              : "service_unavailable";
          }
          try {
            await deleteNote({
              id: resolution.id,
              expectedRevision: resolution.expectedRevision as NotesnookRevisionToken,
            });
            report.delete = "ok";
          } catch (error) {
            report.delete = isVaultLockedWriteProofError(error)
              ? "vault_locked"
              : "service_unavailable";
          }
          return Object.freeze(report);
        };

  const remoteSync = core.handle.remoteSync;
  const requestSync =
    remoteSync === undefined
      ? undefined
      : async (): Promise<
          Readonly<{
            status: "idle" | "synced" | "failed";
            pendingSync: boolean;
            attempts: number;
          }>
        > => {
          if (lifecycle.isClosed()) throw serviceRuntimeError("service runtime is unavailable");
          try {
            return await remoteSync.requestSync();
          } catch {
            throw serviceRuntimeError("service runtime sync failed");
          }
        };

  return Object.freeze({
    readOnly,
    search,
    status,
    listNotebooks,
    ...(listNotebooksForSettings === undefined ? {} : { listNotebooksForSettings }),
    noteMetadata,
    ...(resolveNotePath === undefined ? {} : { resolveNotePath }),
    ...(lockedNoteProof === undefined ? {} : { lockedNoteProof }),
    ...(pathDiagnostic === undefined ? {} : { pathDiagnostic }),
    ...(createNote === undefined ? {} : { createNote }),
    ...(appendNote === undefined ? {} : { appendNote }),
    ...(updateNote === undefined ? {} : { updateNote }),
    ...(deleteNote === undefined ? {} : { deleteNote }),
    ...(requestSync === undefined ? {} : { requestSync }),
    cleanup: cleanupOnce,
  });
}

function pathDiagnosticReport(
  pathBytes: number,
  diagnostic: ExactNotePathDiagnostic,
): RpcNotesPathDiagnosticResult {
  return Object.freeze({
    kind: "path_diagnostic" as const,
    pathBytes,
    ...diagnostic,
  });
}

function isVaultLockedReadProofError(error: unknown): boolean {
  return isNotesnookReadOnlyAdapterError(error) && error.message === "vault_locked";
}

function isVaultLockedWriteProofError(error: unknown): boolean {
  if (!isNotesnookWriteAdapterError(error) && !isNotesnookWriteContractError(error)) return false;
  if (typeof error !== "object" || error === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && descriptor.value === "vault_locked";
  } catch {
    return false;
  }
}

type NormalizedServiceRuntimeOptions = Readonly<{
  stateDir: string;
  keys: SecureKeyStore;
  logger?: Logger;
  injectedModule?: NotesnookRealCoreModule;
}>;

function normalizeServiceRuntimeOptions(options: unknown): NormalizedServiceRuntimeOptions {
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw serviceRuntimeError("invalid service runtime options");
    }
    const candidate = options as Record<string, unknown>;
    const stateDir = candidate.stateDir;
    if (typeof stateDir !== "string" || stateDir.length === 0) {
      throw serviceRuntimeError("invalid service runtime state directory");
    }
    const keys = candidate.keys;
    if (
      typeof keys !== "object" ||
      keys === null ||
      Array.isArray(keys) ||
      typeof (keys as { getDatabaseKey?: unknown }).getDatabaseKey !== "function"
    ) {
      throw serviceRuntimeError("invalid service runtime key store");
    }
    const logger = candidate.logger;
    if (logger !== undefined && (typeof logger !== "object" || logger === null)) {
      throw serviceRuntimeError("invalid service runtime logger");
    }
    const injectedModule = candidate.injectedModule;
    const normalisedStateDir = normaliseStateDir(stateDir);
    return {
      stateDir: normalisedStateDir,
      keys: keys as SecureKeyStore,
      ...(logger === undefined ? {} : { logger: logger as Logger }),
      ...(injectedModule === undefined
        ? {}
        : { injectedModule: injectedModule as NotesnookRealCoreModule }),
    };
  } catch (error) {
    if (isServiceRuntimeError(error)) throw error;
    throw serviceRuntimeError("invalid service runtime options");
  }
}

/**
 * Production-safe key store guard.
 *
 * Refuses any backend other than `systemd-credential` with the
 * literal `productionSafe: true`.  The discriminator is the
 * authoritative test; the runtime guard exists so a runtime caller
 * that bypasses the discriminated type (e.g. an `as unknown as
 * SecureKeyStore` cast) still cannot start the daemon with a
 * development-file backend.
 */
function assertProductionSafeKeyStore(keys: SecureKeyStore): void {
  try {
    if (keys.backend !== "systemd-credential") {
      throw serviceRuntimeError("service runtime requires a production-safe key store");
    }
    if ((keys as { productionSafe?: unknown }).productionSafe !== true) {
      throw serviceRuntimeError("service runtime requires a production-safe key store");
    }
  } catch (error) {
    if (isServiceRuntimeError(error)) throw error;
    throw serviceRuntimeError("service runtime requires a production-safe key store");
  }
}

function serviceRuntimeError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  return error;
}

function isServiceRuntimeError(error: unknown): boolean {
  return error instanceof Error && /^service runtime/.test(error.message);
}
