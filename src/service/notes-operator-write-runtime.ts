/**
 * T07 — daemon-owned create/edit/undo transaction runtime.
 *
 * This module is the ONLY orchestration point for operator mutations.
 * It owns:
 *
 *   - trusted preimage capture (a daemon read, never a client-supplied
 *     body);
 *   - the revision guard (`expectedRevision`) evaluated BEFORE any
 *     mutation;
 *   - opaque-reference sentinel validation (via
 *     `parseNoteDocumentMarkdown(..., { preimage })`, so a changed,
 *     moved, deleted, duplicated, or forged sentinel fails before any
 *     write);
 *   - the operation state machine (`prepared → committing → committed →
 *     undone`, plus `aborted` and `unresolved`) over the encrypted
 *     daemon operation store;
 *   - honest revision reporting: every result carries the revision the
 *     daemon actually observed after the write.  Nothing is predicted
 *     and nothing is retried blindly.
 *
 * Failures are categorical.  A failure carries a `code` drawn from the
 * closed RPC error vocabulary so the transport can serialise it; no
 * note body, title, id, path, revision, or upstream cause is ever
 * interpolated into a message.
 */

import { Buffer } from "node:buffer";

import {
  decodeNoteDocumentNative,
  serializeNoteDocumentNative,
} from "../core/note-document-native.js";
import {
  parseNoteDocumentMarkdown,
  serializeNoteDocumentMarkdown,
} from "../core/note-document-markdown.js";
import { isVaultLockedRefusal } from "../core/notesnook-readonly-projection.js";
import type { RpcErrorCode } from "./rpc-protocol.js";
import type { OperationRecord, OperationState } from "./notes-undo-store.js";

/** Bounded native stored content envelope. */
export interface OperatorStoredContent {
  readonly type: "html" | "tiptap";
  readonly data: string;
}

/** The daemon-owned read/write seam this runtime depends on. */
export interface OperatorWriteSource {
  /** Trusted read of the stored native content and its current revision. */
  readonly read: (
    noteId: string,
  ) => Promise<Readonly<{ revision: string; content: OperatorStoredContent }> | undefined>;
  /** Guarded bounded content update; returns the ACTUAL post-commit revision. */
  readonly update: (command: {
    readonly noteId: string;
    readonly expectedRevision: string;
    readonly content: OperatorStoredContent;
  }) => Promise<
    | Readonly<{ kind: "updated"; revision: string }>
    | Readonly<{ kind: "conflict" | "locked" | "missing" | "error" }>
  >;
}

/** The bounded subset of the encrypted operation store this runtime uses. */
export interface OperatorOperationStore {
  readonly insert: (input: {
    readonly kind: "create" | "edit" | "undo";
    readonly payload: string;
    readonly ttlMs: number;
  }) => Promise<OperationRecord>;
  readonly get: (handle: string) => Promise<OperationRecord>;
  readonly list: () => Promise<ReadonlyArray<OperationRecord>>;
  readonly transition: (
    handle: string,
    expected: OperationState,
    next: OperationState,
    payload?: string,
  ) => Promise<OperationRecord>;
}

export type OperatorWriteAuditEvent =
  | "edit.noop"
  | "edit.committed"
  | "edit.conflict"
  | "edit.unresolved"
  | "undo.undone"
  | "undo.conflict";

export interface OperatorWriteRuntimeOptions {
  readonly source: OperatorWriteSource;
  readonly store: OperatorOperationStore;
  /** Daemon-side opaque handle resolution; raw note ids never cross the socket. */
  readonly resolveHandle: (handle: string) => string | undefined;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly audit?: (event: OperatorWriteAuditEvent) => void;
}

export interface OperatorEditPreimage {
  readonly kind: "preimage";
  readonly id: string;
  readonly revision: string;
  readonly markdown: string;
  readonly contentBytes: number;
}

export interface OperatorEditApplied {
  readonly kind: "edit";
  readonly id: string;
  readonly appliedFields: ReadonlyArray<"content">;
  readonly revision: string;
  readonly contentBytes: number;
}

export interface OperatorUndoApplied {
  readonly kind: "undo";
  /**
   * Note handle echoed back when the caller supplied one.  A bare
   * `notes undo` addresses the operation alone, and the daemon must
   * never answer with the raw note id, so this is omitted then.
   */
  readonly id?: string;
  readonly appliedFields: ReadonlyArray<"content">;
  readonly revision: string;
  readonly contentBytes: number;
}

export interface OperatorOperationStatus {
  readonly kind: "operation-status";
  readonly operationHandle: string;
  readonly state: OperationState;
}

export interface OperatorOperationList {
  readonly kind: "operation-list";
  readonly handles: ReadonlyArray<string>;
}

export interface OperatorWriteRuntime {
  readonly editPreimage: (params: Readonly<{ id: string }>) => Promise<OperatorEditPreimage>;
  readonly applyEdit: (
    params: Readonly<{ id: string; expectedRevision: string; markdown: string }>,
  ) => Promise<OperatorEditApplied>;
  readonly applyUndo: (
    params: Readonly<{ id?: string; operationHandle: string; expectedRevision?: string }>,
  ) => Promise<OperatorUndoApplied>;
  readonly operationStatus: (
    params: Readonly<{ operationHandle: string }>,
  ) => Promise<OperatorOperationStatus>;
  readonly operationList: () => Promise<OperatorOperationList>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const OPERATION_HANDLE = /^op_[a-f0-9]{64}$/;
const REVISION_TOKEN = /^rev_[0-9a-f]{32}$/;

/**
 * Categorical operator write failure; `code` is from the closed RPC vocabulary.
 *
 * Exported so consumers can identify a failure we raised rather than trusting a
 * `code` field on an arbitrary thrown object.
 */
export class OperatorWriteError extends Error {
  public readonly code: RpcErrorCode;

  constructor(code: RpcErrorCode) {
    super(code);
    this.code = code;
  }
}

function fail(code: RpcErrorCode): never {
  throw new OperatorWriteError(code);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function createOperatorWriteRuntime(
  options: OperatorWriteRuntimeOptions,
): OperatorWriteRuntime {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  const audit = (event: OperatorWriteAuditEvent): void => {
    try {
      options.audit?.(event);
    } catch {
      // Audit is non-observable and never changes the outcome.
    }
  };

  async function load(noteId: string): Promise<
    Readonly<{
      revision: string;
      document: ReturnType<typeof decodeNoteDocumentNative>["document"];
      context: ReturnType<typeof decodeNoteDocumentNative>["context"];
      content: OperatorStoredContent;
    }>
  > {
    let observed: Awaited<ReturnType<OperatorWriteSource["read"]>>;
    try {
      observed = await options.source.read(noteId);
    } catch (error) {
      // A locked note is a categorical refusal, not a service failure.  Catching
      // every read failure as `service_unavailable` made a working lock
      // indistinguishable from a broken daemon on edit-preimage, apply-edit, and
      // apply-undo.  Every other failure stays generic.
      return fail(isVaultLockedRefusal(error) ? "vault_locked" : "service_unavailable");
    }
    if (observed === undefined) return fail("not_found");
    if (typeof observed.revision !== "string" || !REVISION_TOKEN.test(observed.revision)) {
      return fail("service_unavailable");
    }
    try {
      const decoded = decodeNoteDocumentNative(observed.content, {
        noteId,
        revision: observed.revision,
      });
      return {
        revision: observed.revision,
        document: decoded.document,
        context: decoded.context,
        content: observed.content,
      };
    } catch {
      return fail("service_unavailable");
    }
  }

  function resolve(id: unknown): string {
    if (typeof id !== "string" || id.length === 0 || id.length > 256)
      return fail("invalid_request");
    const noteId = options.resolveHandle(id);
    if (typeof noteId !== "string" || noteId.length === 0) return fail("not_found");
    return noteId;
  }

  function mintAt(): number {
    const t = now();
    if (!Number.isSafeInteger(t) || t < 0) return fail("service_unavailable");
    return t;
  }

  const editPreimage = async (params: Readonly<{ id: string }>): Promise<OperatorEditPreimage> => {
    const noteId = resolve(params?.id);
    const { revision, document } = await load(noteId);
    let markdown: string;
    try {
      markdown = serializeNoteDocumentMarkdown(document);
    } catch {
      return fail("service_unavailable");
    }
    return {
      kind: "preimage",
      id: params.id,
      revision,
      markdown,
      contentBytes: byteLength(markdown),
    };
  };

  const applyEdit = async (
    params: Readonly<{ id: string; expectedRevision: string; markdown: string }>,
  ): Promise<OperatorEditApplied> => {
    const noteId = resolve(params?.id);
    if (
      typeof params.expectedRevision !== "string" ||
      !REVISION_TOKEN.test(params.expectedRevision)
    ) {
      return fail("invalid_request");
    }
    if (typeof params.markdown !== "string") return fail("invalid_request");

    const trusted = await load(noteId);
    if (trusted.revision !== params.expectedRevision) return fail("stale_revision");

    let next: ReturnType<typeof decodeNoteDocumentNative>["document"];
    try {
      next = parseNoteDocumentMarkdown(params.markdown, { preimage: trusted.document });
    } catch {
      return fail("invalid_request");
    }

    let encoded: OperatorStoredContent;
    try {
      encoded = serializeNoteDocumentNative(next, {
        context: trusted.context,
        binding: { noteId, revision: trusted.revision },
      }) as OperatorStoredContent;
    } catch {
      return fail("invalid_request");
    }

    // No-change editing performs no write and creates no journal entry.
    if (encoded.type === trusted.content.type && encoded.data === trusted.content.data) {
      audit("edit.noop");
      return {
        kind: "edit",
        id: params.id,
        appliedFields: ["content"],
        revision: trusted.revision,
        contentBytes: byteLength(params.markdown),
      };
    }

    const preimagePayload = JSON.stringify({
      noteId,
      revision: trusted.revision,
      content: trusted.content,
    });
    const createdAt = mintAt();
    let record: OperationRecord;
    try {
      record = await options.store.insert({
        kind: "edit",
        payload: preimagePayload,
        ttlMs,
      });
    } catch {
      return fail("service_unavailable");
    }

    try {
      await options.store.transition(record.handle, "prepared", "committing");
    } catch {
      return fail("service_unavailable");
    }

    let result: Awaited<ReturnType<OperatorWriteSource["update"]>>;
    try {
      result = await options.source.update({
        noteId,
        expectedRevision: trusted.revision,
        content: encoded,
      });
    } catch {
      // The write may or may not have landed: record the uncertainty and
      // never claim success.  The record is retained for reconciliation.
      try {
        await options.store.transition(record.handle, "committing", "unresolved");
      } catch {
        // best-effort: the prepared record still exists on disk
      }
      audit("edit.unresolved");
      return fail("service_unavailable");
    }

    if (result.kind !== "updated") {
      if (result.kind === "conflict") {
        try {
          await options.store.transition(record.handle, "committing", "aborted");
        } catch {
          // best-effort
        }
        audit("edit.conflict");
        return fail("conflict");
      }
      if (result.kind === "locked") {
        try {
          await options.store.transition(record.handle, "committing", "aborted");
        } catch {
          // best-effort
        }
        return fail("vault_locked");
      }
      if (result.kind === "missing") {
        try {
          await options.store.transition(record.handle, "committing", "aborted");
        } catch {
          // best-effort
        }
        return fail("not_found");
      }
      // A categorical transport/runtime error is NOT proof the write did
      // not land.  Retain the record as unresolved for reconciliation.
      try {
        await options.store.transition(record.handle, "committing", "unresolved");
      } catch {
        // best-effort
      }
      audit("edit.unresolved");
      return fail("service_unavailable");
    }

    if (typeof result.revision !== "string" || !REVISION_TOKEN.test(result.revision)) {
      try {
        await options.store.transition(record.handle, "committing", "unresolved");
      } catch {
        // best-effort
      }
      audit("edit.unresolved");
      return fail("service_unavailable");
    }

    try {
      await options.store.transition(
        record.handle,
        "committing",
        "committed",
        JSON.stringify({
          noteId,
          revision: trusted.revision,
          content: trusted.content,
          postRevision: result.revision,
          createdAt,
        }),
      );
    } catch {
      return fail("service_unavailable");
    }
    audit("edit.committed");
    return {
      kind: "edit",
      id: params.id,
      appliedFields: ["content"],
      revision: result.revision,
      contentBytes: byteLength(params.markdown),
    };
  };

  const applyUndo = async (
    params: Readonly<{ id?: string; operationHandle: string; expectedRevision?: string }>,
  ): Promise<OperatorUndoApplied> => {
    if (
      typeof params.operationHandle !== "string" ||
      !OPERATION_HANDLE.test(params.operationHandle)
    ) {
      return fail("invalid_request");
    }

    let record: OperationRecord;
    try {
      record = await options.store.get(params.operationHandle);
    } catch {
      return fail("not_found");
    }
    if (record.kind !== "edit" || record.state !== "committed") return fail("conflict");

    let payload: { noteId?: unknown; content?: unknown; postRevision?: unknown };
    try {
      payload = JSON.parse(record.payload) as {
        noteId?: unknown;
        content?: unknown;
        postRevision?: unknown;
      };
    } catch {
      return fail("service_unavailable");
    }

    // The daemon resolves BOTH the note and the revision it must still
    // match from its own committed record.  A bare `notes undo` holds an
    // opaque operation handle and nothing else — `notes.operation-status`
    // deliberately omits the note reference (D8) — so requiring the
    // caller to resend them would make undo impossible.  A caller that
    // does supply them must agree with the record, so a mismatched or
    // forged value can never retarget the restore.
    if (typeof payload.noteId !== "string" || payload.noteId.length === 0) {
      return fail("service_unavailable");
    }
    if (params.id !== undefined && resolve(params.id) !== payload.noteId) {
      return fail("not_found");
    }
    if (typeof payload.postRevision !== "string" || !REVISION_TOKEN.test(payload.postRevision)) {
      return fail("service_unavailable");
    }
    if (params.expectedRevision !== undefined && params.expectedRevision !== payload.postRevision) {
      return fail("invalid_request");
    }
    const noteId = payload.noteId;
    const guard = payload.postRevision;

    const restore = payload.content as OperatorStoredContent | undefined;
    if (
      restore === undefined ||
      (restore.type !== "html" && restore.type !== "tiptap") ||
      typeof restore.data !== "string"
    ) {
      return fail("service_unavailable");
    }

    const trusted = await load(noteId);
    if (trusted.revision !== guard) {
      audit("undo.conflict");
      return fail("conflict");
    }

    let result: Awaited<ReturnType<OperatorWriteSource["update"]>>;
    try {
      result = await options.source.update({
        noteId,
        expectedRevision: trusted.revision,
        content: restore,
      });
    } catch {
      return fail("service_unavailable");
    }
    if (result.kind === "conflict") {
      audit("undo.conflict");
      return fail("conflict");
    }
    if (result.kind === "locked") return fail("vault_locked");
    if (result.kind === "missing") return fail("not_found");
    if (result.kind !== "updated") return fail("service_unavailable");
    if (typeof result.revision !== "string" || !REVISION_TOKEN.test(result.revision)) {
      return fail("service_unavailable");
    }

    try {
      await options.store.transition(record.handle, "committed", "undone");
    } catch {
      return fail("service_unavailable");
    }
    audit("undo.undone");
    return {
      kind: "undo",
      ...(params.id === undefined ? {} : { id: params.id }),
      appliedFields: ["content"],
      revision: result.revision,
      contentBytes: byteLength(restore.data),
    };
  };

  const operationStatus = async (
    params: Readonly<{ operationHandle: string }>,
  ): Promise<OperatorOperationStatus> => {
    if (
      typeof params?.operationHandle !== "string" ||
      !OPERATION_HANDLE.test(params.operationHandle)
    ) {
      return fail("invalid_request");
    }
    let record: OperationRecord;
    try {
      record = await options.store.get(params.operationHandle);
    } catch {
      return fail("not_found");
    }
    // Deliberately no `id`: the raw database note id must never cross the
    // operator socket (handles are daemon-minted and scoped).
    return {
      kind: "operation-status",
      operationHandle: record.handle,
      state: record.state,
    };
  };

  const operationList = async (): Promise<OperatorOperationList> => {
    let records: ReadonlyArray<OperationRecord>;
    try {
      records = await options.store.list();
    } catch {
      return fail("service_unavailable");
    }
    return {
      kind: "operation-list",
      handles: records.map((record) => record.handle),
    };
  };

  return Object.freeze({
    editPreimage,
    applyEdit,
    applyUndo,
    operationStatus,
    operationList,
  });
}
