/**
 * Stage 5 slice B — the daemon-owned keep-both conflict resolve transaction.
 *
 * This is the operator-only `notes.resolve-conflict` orchestration. It owns:
 *
 *   - the trusted preimage: the daemon captures the note's content id, remote
 *     date and remote digest itself, from a write-free `capture`, and refuses
 *     before any write when the caller's binding does not match;
 *   - the operation record, in the encrypted operator store, with a payload that
 *     holds identifiers, digests and titles only, never a body;
 *   - the recovery journal: the stages `resolve-copy`, `resolve-content`,
 *     `resolve-note-flag` are recorded in that order, each before its write;
 *   - the database mutex, held for the whole transaction;
 *   - the operator pending marker on success. Nothing is uploaded or synced.
 *
 * A crash can leave one resolve in flight for a note. The next run for that
 * note recovers it, and only completes when the content row proves the remote
 * side was adopted and the journal shows the resolve reached a content stage.
 * It then clears only the flag. Anything it cannot prove blocks with
 * `service_unavailable` and writes nothing.
 *
 * Journal bound: each run needs three free marker slots, and the run checks
 * that before any write. A committed run discards its own markers. An
 * unresolved run keeps its markers until recovery completes it, so each one
 * holds up to three of the journal's
 * {@link NOTESNOOK_RECOVERY_JOURNAL_MAX_MARKERS} slots. Markers left for a note
 * with no in-flight operation are stale, and the next fresh run discards them.
 */

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import type { LiveConflictResolveCapability } from "../core/notesnook-conflict-resolve-live.js";
import {
  createNotesnookConflictResolver,
  isClearedContentMarker,
  type NotesnookConflictResolveResult,
  type NotesnookConflictResolveSeam,
} from "../core/notesnook-conflict-resolve-wiring.js";
import {
  createNotesnookRecoveryMarker,
  NOTESNOOK_RECOVERY_JOURNAL_MAX_MARKERS,
  NOTESNOOK_RESOLVE_RECOVERY_STAGES,
  type NotesnookRecoveryStage,
} from "../core/notesnook-recovery-journal.js";
import {
  CONFLICT_RESOLVE_CONFIRMATION,
  type RpcNotesConflictResolveResult,
} from "./rpc-protocol.js";
import type { OperatorPeer } from "./operator-server.js";
import {
  OperatorWriteError,
  ownerKey,
  type OperatorOperationStore,
} from "./notes-operator-write-runtime.js";
import type { OperationRecord } from "./notes-undo-store.js";

const RESOLVE_TTL_MS = 24 * 60 * 60 * 1000;
const BINDING_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;
/** Markers one fresh resolve may need: copy, content, and flag. */
const MARKERS_PER_RESOLVE = 3;
const CONTENT_OR_FLAG_STAGES: ReadonlyArray<NotesnookRecoveryStage> = [
  "resolve-content",
  "resolve-note-flag",
];

/** The private operation payload. It holds no body, only identifiers, digests and titles. */
type ResolvePayload = Readonly<{
  kind: "resolve";
  owner: string;
  noteId: string;
  contentId: string;
  remoteDate: number;
  remoteDigest: string;
  originalTitle: string;
  copyTitle: string;
}>;

export interface OperatorConflictResolveRuntimeOptions {
  readonly capability: LiveConflictResolveCapability;
  readonly store: OperatorOperationStore;
  /** Daemon-side opaque handle resolution; raw note ids never cross the socket. */
  readonly resolveHandle: (handle: string, peer: OperatorPeer) => string | undefined;
}

export interface OperatorConflictResolveRuntime {
  readonly resolveConflict: (
    params: Readonly<{ id: string; binding: string; confirmation: string }>,
    peer: OperatorPeer,
  ) => Promise<RpcNotesConflictResolveResult>;
}

export function createOperatorConflictResolveRuntime(
  options: OperatorConflictResolveRuntimeOptions,
): OperatorConflictResolveRuntime {
  const { capability, store } = options;
  const { seam, journal } = capability;

  async function resolveConflict(
    params: Readonly<{ id: string; binding: string; confirmation: string }>,
    peer: OperatorPeer,
  ): Promise<RpcNotesConflictResolveResult> {
    const owner = ownerKey(peer);
    // Checked before the handle is looked up: without the exact phrase the daemon
    // does nothing. The socket is still the trust boundary; this is an intent guard.
    if (params?.confirmation !== CONFLICT_RESOLVE_CONFIRMATION) fail("invalid_request");
    const noteId = resolveNote(params?.id, peer, options.resolveHandle);
    const binding = params?.binding;
    if (typeof binding !== "string" || !BINDING_PATTERN.test(binding)) {
      fail("invalid_request");
    }
    return capability.runExclusive("notes:resolve-conflict", () =>
      transact(owner, noteId, binding),
    );
  }

  async function transact(
    owner: string,
    noteId: string,
    binding: string,
  ): Promise<RpcNotesConflictResolveResult> {
    // Any unfinished resolve is found first. Only the same owner may recover
    // one, and an unreadable one blocks every resolve until it is reconciled.
    const active = await activeResolves();
    const inFlight: Array<Readonly<{ record: OperationRecord; payload: ResolvePayload }>> = [];
    for (const record of active) {
      const payload = parsePayload(record.payload);
      if (payload === undefined) fail("service_unavailable");
      inFlight.push({ record, payload });
    }
    const forNote = inFlight.filter((entry) => entry.payload.noteId === noteId);
    if (forNote.length > 1) fail("service_unavailable");
    const [only] = forNote;
    if (only !== undefined) {
      if (only.payload.owner !== owner) fail("service_unavailable");
      return recover(only.record, only.payload);
    }

    // No operation is in flight for this note, so any markers it has are stale.
    try {
      journal.discard(noteId, NOTESNOOK_RESOLVE_RECOVERY_STAGES);
    } catch {
      fail("service_unavailable");
    }
    if (NOTESNOOK_RECOVERY_JOURNAL_MAX_MARKERS - journal.snapshot().length < MARKERS_PER_RESOLVE) {
      fail("service_unavailable");
    }

    // Capture is write-free. A refusal here aborts before any operation record exists.
    const resolver = createNotesnookConflictResolver(seam);
    let captured: Awaited<ReturnType<typeof resolver.capture>>;
    try {
      captured = await resolver.capture(noteId, binding);
    } catch {
      fail("service_unavailable");
    }
    if (captured.outcome !== "ready") return project(captured);

    const payload: ResolvePayload = Object.freeze({
      kind: "resolve",
      owner,
      noteId,
      contentId: captured.contentId,
      remoteDate: captured.remoteDate,
      remoteDigest: sha256(captured.remoteText),
      originalTitle: captured.originalTitle,
      copyTitle: captured.copyTitle,
    });
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD_BYTES) fail("service_unavailable");

    let record: OperationRecord;
    try {
      record = await store.insert({ kind: "resolve", payload: encoded, ttlMs: RESOLVE_TTL_MS });
      await store.transition(record.handle, "prepared", "committing", undefined, owner);
    } catch {
      fail("service_unavailable");
    }
    const handle = record.handle;

    // Every write goes through the journal first. A failed journal record
    // stops the write and is reported after the resolver returns.
    let copyAttempted = false;
    let journalFailed = false;
    const mark = (stage: NotesnookRecoveryStage, operation: "create" | "update"): void => {
      try {
        journal.record(createNotesnookRecoveryMarker(operation, noteId, stage));
      } catch {
        journalFailed = true;
        throw new OperatorWriteError("service_unavailable", handle);
      }
    };
    const journaled: NotesnookConflictResolveSeam = {
      noteMeta: seam.noteMeta,
      contentWithConflicted: seam.contentWithConflicted,
      notesAddVerbatim: async (input) => {
        mark("resolve-copy", "create");
        copyAttempted = true;
        return seam.notesAddVerbatim(input);
      },
      noteRelate: seam.noteRelate,
      noteRelations: seam.noteRelations,
      contentResolve: async (input) => {
        mark("resolve-content", "update");
        return seam.contentResolve(input);
      },
      noteClearConflict: async (id) => {
        mark("resolve-note-flag", "update");
        return seam.noteClearConflict(id);
      },
    };

    let outcome: NotesnookConflictResolveResult | undefined;
    try {
      outcome = await createNotesnookConflictResolver(journaled).resolveKeepBoth(noteId, binding);
    } catch {
      outcome = undefined;
    }

    if (journalFailed || outcome === undefined) {
      await settle(handle, copyAttempted ? "unresolved" : "aborted", owner);
      fail("service_unavailable", copyAttempted ? handle : undefined);
    }
    if (outcome.outcome !== "resolved") {
      await settle(handle, copyAttempted ? "unresolved" : "aborted", owner);
      return project(outcome);
    }

    try {
      capability.markPending(noteId);
    } catch {
      await settle(handle, "unresolved", owner);
      fail("service_unavailable", handle);
    }
    try {
      await store.transition(handle, "committing", "committed", undefined, owner);
    } catch {
      fail("service_unavailable", handle);
    }
    discardQuietly(noteId);
    return project(outcome);
  }

  /**
   * Finish an interrupted resolve. The content row must already show the remote
   * side adopted, and the journal must show the resolve reached a content stage.
   * Only the flag is written, and only while it is still set.
   */
  async function recover(
    record: OperationRecord,
    payload: ResolvePayload,
  ): Promise<RpcNotesConflictResolveResult> {
    const handle = record.handle;
    const owner = payload.owner;
    const noteId = payload.noteId;
    const reached = journal
      .snapshot()
      .some((marker) => marker.noteId === noteId && CONTENT_OR_FLAG_STAGES.includes(marker.stage));
    if (!reached) fail("service_unavailable", handle);

    const note = await readOrBlock(handle, () => seam.noteMeta(noteId));
    if (note === undefined || readField(note, "contentId") !== payload.contentId) {
      fail("service_unavailable", handle);
    }
    const row = await readOrBlock(handle, () => seam.contentWithConflicted(payload.contentId));
    const data = readField(row, "data");
    const adopted =
      isClearedContentMarker(readField(row, "conflicted")) &&
      readField(row, "dateResolved") === payload.remoteDate &&
      readField(row, "noteId") === noteId &&
      typeof data === "string" &&
      sha256(data) === payload.remoteDigest;
    if (!adopted) fail("service_unavailable", handle);

    const flag = readField(note, "conflicted");
    if (flag === true) {
      try {
        journal.record(createNotesnookRecoveryMarker("update", noteId, "resolve-note-flag"));
      } catch {
        fail("service_unavailable", handle);
      }
      await readOrBlock(handle, () => seam.noteClearConflict(noteId));
      const after = await readOrBlock(handle, () => seam.noteMeta(noteId));
      if (
        readField(after, "conflicted") !== false ||
        readField(after, "contentId") !== payload.contentId
      ) {
        fail("service_unavailable", handle);
      }
    } else if (flag !== false) {
      fail("service_unavailable", handle);
    }

    try {
      capability.markPending(noteId);
    } catch {
      fail("service_unavailable", handle);
    }
    try {
      await store.transition(handle, record.state, "committed", undefined, owner);
    } catch {
      fail("service_unavailable", handle);
    }
    discardQuietly(noteId);
    return Object.freeze({
      kind: "conflict-resolve",
      outcome: "resolved",
      originalTitle: payload.originalTitle,
      copyTitle: payload.copyTitle,
    });
  }

  /** Operations still committing or unresolved, across every owner. */
  async function activeResolves(): Promise<ReadonlyArray<OperationRecord>> {
    let records: ReadonlyArray<OperationRecord>;
    try {
      records = await store.list();
    } catch {
      return fail("service_unavailable");
    }
    return records.filter(
      (record) =>
        record.kind === "resolve" &&
        (record.state === "committing" || record.state === "unresolved"),
    );
  }

  /** Move a run's own record out of `committing`. Both targets are legal from there. */
  async function settle(
    handle: string,
    to: "unresolved" | "aborted",
    owner: string,
  ): Promise<void> {
    try {
      await store.transition(handle, "committing", to, undefined, owner);
    } catch {
      // The record stays in flight, and the next run finds it and blocks or recovers.
    }
  }

  function discardQuietly(noteId: string): void {
    try {
      journal.discard(noteId, NOTESNOOK_RESOLVE_RECOVERY_STAGES);
    } catch {
      // Stale markers are discarded at the start of the next fresh run.
    }
  }

  return Object.freeze({ resolveConflict });
}

function project(result: NotesnookConflictResolveResult): RpcNotesConflictResolveResult {
  switch (result.outcome) {
    case "resolved":
      return Object.freeze({
        kind: "conflict-resolve",
        outcome: "resolved",
        originalTitle: result.originalTitle,
        copyTitle: result.copyTitle,
      });
    case "stale_revision":
      return Object.freeze({
        kind: "conflict-resolve",
        outcome: "stale_revision",
        copyCreated: result.copyCreated,
      });
    default:
      return Object.freeze({ kind: "conflict-resolve", outcome: result.outcome });
  }
}

function resolveNote(
  id: unknown,
  peer: OperatorPeer,
  resolveHandle: (handle: string, peer: OperatorPeer) => string | undefined,
): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) fail("invalid_request");
  const noteId = resolveHandle(id, peer);
  if (typeof noteId !== "string" || noteId.length === 0) fail("not_found");
  return noteId;
}

function parsePayload(text: string): ResolvePayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { kind, owner, noteId, contentId, remoteDate, remoteDigest, originalTitle, copyTitle } =
    record;
  if (
    kind !== "resolve" ||
    typeof owner !== "string" ||
    typeof noteId !== "string" ||
    typeof contentId !== "string" ||
    typeof remoteDate !== "number" ||
    !Number.isFinite(remoteDate) ||
    typeof remoteDigest !== "string" ||
    !DIGEST_PATTERN.test(remoteDigest) ||
    typeof originalTitle !== "string" ||
    typeof copyTitle !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "resolve",
    owner,
    noteId,
    contentId,
    remoteDate,
    remoteDigest,
    originalTitle,
    copyTitle,
  });
}

function readField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return Reflect.get(value, key);
}

async function readOrBlock<T>(handle: string, read: () => T | PromiseLike<T>): Promise<T> {
  try {
    return await read();
  } catch {
    return fail("service_unavailable", handle);
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fail(
  code: "invalid_request" | "not_found" | "service_unavailable" | "permission_denied",
  operationHandle?: string,
): never {
  throw new OperatorWriteError(code, operationHandle);
}
