/**
 * Stage 4 — bounded local Notesnook mutation adapter.
 *
 * Implements `docs/stage-4-write-plan.md` §2/§3/§5:
 *
 *   - create / append / controlled update through an explicit,
 *     separately named `NotesnookWriteDatabase` structural seam;
 *   - revision guards that read the current state immediately before
 *     mutation, fail closed on stale revisions, and never choose a side;
 *   - categorical redaction — every Notesnook throw is rewritten to a
 *     chain-free {@link NotesnookWriteAdapterError} with a closed code
 *     set; note ids, bodies, canaries, causes, contexts, and upstream
 *     messages never cross the boundary;
 *   - hostile-getter / Proxy safety for every injected member;
 *   - explicit rejection of sync / delete / force / Vault escape hatches.
 *
 * Non-goals
 * ---------
 *
 *   - No raw Notesnook `Database`, `Notes`, `Content`, `Notebooks`,
 *     `Tags`, `Relations`, transport, storage, credential, or
 *     collection-mutator passthrough.  This module imports nothing from
 *     `@notesnook/*`; every mutation slot is a narrow function on the
 *     structural seam.
 *   - No delete, force-overwrite, Vault unlock/password, send/full sync,
 *     network call, or arbitrary core-method call.
 *   - No mutation that the contract did not authorise.  Every operation
 *     runs the contract plan first; only then does it touch the seam.
 *   - No widening of `NotesnookReadOnlyDatabase` or
 *     `NotesnookLiveDatabase`.  The write seam is a separate, explicitly
 *     named type so a future reader cannot accidentally widen the
 *     Stage 3 read-only boundary.
 *   - No remote-synchronisation claim.  `localCommitted` flips to `true`
 *     only after a successful local mutation; `remoteSynced` stays
 *     `false` and `pendingSync` stays `true` until a separate
 *     Stage 4 sync coordinator proves otherwise.
 */

import { Buffer } from "node:buffer";

import {
  NotesnookWriteContractError,
  STAGE4_WRITE_LIMITS,
  assertRevisionMatch,
  createRevisionToken,
  isNotesnookWriteContractError,
  planAppendNote,
  planCreateNote,
  planDeleteNote,
  planUpdateNote,
  type AppendNoteCommand,
  type CreateNoteCommand,
  type DeleteNoteCommand,
  type NotesnookRevisionState,
  type NotesnookRevisionToken,
  type NotesnookUpdatePatchField,
  type UpdateNoteCommand,
} from "./notesnook-write-contract.js";
import { assertSupportedConstructs, type NotesnookListKind } from "./notesnook-write-codec.js";
import {
  createNotesnookRecoveryMarker,
  type NotesnookRecoveryJournal,
  type NotesnookRecoveryStage,
} from "./notesnook-recovery-journal.js";

// ---------------------------------------------------------------------------
// Markdown → stored-content codec seam.
//
// The pinned `@notesnook/core@8.1.3` runtime stores note content as a
// `ContentItem` with `type: "tiptap" | "html"`.  This adapter never
// concatenates raw Markdown into that slot; instead, every create /
// append / update path asks the injected codec to translate the
// application-layer Markdown into the stored representation the
// runtime already understands.  Tests inject a deterministic codec so
// the contract is auditable; production wires a Tiptap-safe codec.
//
// The contract is narrow:
//   - `encodeMarkdown(markdown)` → `{type, data}` for a fresh note
//   - `appendMarkdownToStoredContent({storedType, storedData, fragment})`
//     → `{type, data}` that preserves `storedData` and inserts exactly
//     one new fragment
// Any throw is normalised to `unsupported_content` so the categorical
// boundary stays closed.
// ---------------------------------------------------------------------------

export interface NotesnookStoredContent {
  readonly type: "tiptap" | "html";
  readonly data: string;
}

export interface NotesnookWriteMarkdownCodec {
  /**
   * Translate Markdown into the stored representation.  The optional
   * `listKind` selector picks between Notesnook's lightweight
   * `simple-checklist` HTML and the rich interactive `checklist`
   * HTML.  Omitting it preserves the existing default
   * (`simple-checklist`) so every caller that does not opt in still sees
   * the stored HTML shape it saw before the selector was introduced.
   */
  readonly encodeMarkdown: (
    markdown: string,
    listKind?: NotesnookListKind,
  ) => NotesnookStoredContent;
  /**
   * Append a freshly encoded Markdown fragment to an existing stored
   * document.  The optional `listKind` selector carries the same
   * intent as {@link NotesnookWriteMarkdownCodec.encodeMarkdown} and
   * is forwarded verbatim to the codec.
   */
  readonly appendMarkdownToStoredContent: (input: {
    readonly storedType: "tiptap" | "html";
    readonly storedData: string;
    readonly markdownFragment: string;
    readonly listKind?: NotesnookListKind;
  }) => NotesnookStoredContent;
}

// ---------------------------------------------------------------------------
// Mutator-only structural seam.
//
// This seam is SEPARATE from `NotesnookReadOnlyDatabase` and
// `NotesnookLiveDatabase`.  Production wiring opens a real Database,
// flattens it to the read-only shape for the Stage 3 adapter, and only
// then injects a separately-built write seam to this module.  The
// read-only boundary stays read-only.
// ---------------------------------------------------------------------------

/**
 * The narrow note fields a Stage 4 update may address, as observed on
 * the seam.  Locked / conflicted / content-type guards happen at the
 * adapter boundary; the seam returns the closed metadata shape.
 */
export interface NotesnookWriteNoteMetadata {
  readonly id: string;
  readonly title: string;
  readonly contentId?: string;
  readonly notebookId?: string;
  readonly pinned: boolean;
  readonly favorite: boolean;
  readonly conflicted: boolean;
  readonly locked: boolean;
  readonly dateEdited: number;
  readonly tags?: readonly string[];
}

/**
 * The narrow stored-content shape a Stage 4 append / update reads.
 * Body content stays in the seam; the adapter never widens it.
 *
 * `locked` is the authoritative Notesnook Vault marker carried on the
 * stored content record (Astra finding P1-2).  When the upstream
 * `notes.note(id)` projection omits the deprecated `note.locked`
 * flag, the seam consults `content.findByNoteId(id).locked` and
 * surfaces it here so the adapter's `vault_locked` gate can refuse
 * the write without a follow-up fetch.
 */
export interface NotesnookWriteStoredContent {
  readonly id: string;
  readonly noteId: string;
  readonly type: "tiptap" | "html";
  readonly data: string;
  readonly locked?: boolean;
}

/**
 * The bounded structural seam consumed by the Stage 4 write adapter.
 *
 * The seam is MUTATOR-ONLY.  There is no `sync`, no `delete`, no
 * `force`, no `vaultUnlock`, no raw `database`, no generic collection
 * accessor, no arbitrary-method passthrough.  Every member below is
 * the smallest surface the contract needs and every other member is
 * rejected during validation.
 *
 * `add`, `update`, `relation*`, `tag*`, and `notebook*` slot names are
 * the closed shapes upstream `@notesnook/core@8.1.3` exposes for the
 * pinned create/append/update workflow; the adapter never exposes them
 * to Hermes as a generic method surface.
 */
export interface NotesnookWriteDatabase {
  readonly note: (id: string) => Promise<NotesnookWriteNoteMetadata | undefined>;
  readonly contentFindByNoteId: (
    noteId: string,
  ) => Promise<NotesnookWriteStoredContent | undefined>;
  readonly notesAdd: (input: {
    readonly title: string;
    readonly content: NotesnookStoredContent;
  }) => Promise<string>;
  readonly notesUpdate: (ids: readonly string[], partial: Record<string, unknown>) => Promise<void>;
  readonly notesDelete?: (id: string) => Promise<void>;
  readonly notesTouch: (ids: readonly string[], dateEdited: number) => Promise<void>;
  readonly contentAdd: (partial: Record<string, unknown>) => Promise<string>;
  readonly contentUpdateByNoteId: (
    partial: Record<string, unknown>,
    ...ids: string[]
  ) => Promise<void>;
  readonly notebookExists: (id: string) => Promise<boolean>;
  readonly notebookNotes: (id: string) => Promise<readonly string[]>;
  readonly notebookAddNote: (notebookId: string, noteId: string) => Promise<void>;
  readonly notebookRemoveNote: (notebookId: string, noteId: string) => Promise<void>;
  readonly tagExists: (id: string) => Promise<boolean>;
  readonly tagAdd: (input: { readonly title: string }) => Promise<string>;
  readonly relationAdd: (input: {
    readonly fromId: string;
    readonly toId: string;
    readonly type: string;
  }) => Promise<void>;
  readonly relationRemove: (input: {
    readonly fromId: string;
    readonly toId: string;
    readonly type: string;
  }) => Promise<void>;
  readonly relationListForNote: (
    noteId: string,
  ) => Promise<ReadonlyArray<{ readonly toId: string; readonly type: string }>>;
}

export type NotesnookWriteDatabaseSource = NotesnookWriteDatabase | (() => NotesnookWriteDatabase);

export interface NotesnookWriteAdapterOptions {
  readonly source: NotesnookWriteDatabaseSource;
  readonly codec: NotesnookWriteMarkdownCodec;
  /** Optional encrypted metadata journal for compensation failures. */
  readonly recoveryJournal?: NotesnookRecoveryJournal;
}

// ---------------------------------------------------------------------------
// Result shapes — every successful write reports a stable local outcome.
// `remoteSynced` is always `false`; `pendingSync` is always `true` until
// a separate coordinator proves otherwise.
// ---------------------------------------------------------------------------

interface WriteOutcomeFlags {
  readonly localCommitted: true;
  readonly remoteSynced: false;
  readonly pendingSync: true;
}

export interface CreateNoteResult extends WriteOutcomeFlags {
  readonly operation: "create";
  readonly id: string;
  readonly titleBytes: number;
  readonly contentBytes: number;
}

export interface AppendNoteResult extends WriteOutcomeFlags {
  readonly operation: "append";
  readonly id: string;
  readonly contentBytes: number;
}

export interface UpdateNoteResult extends WriteOutcomeFlags {
  readonly operation: "update";
  readonly id: string;
  readonly appliedFields: readonly NotesnookUpdatePatchField[];
  readonly contentBytes?: number;
}

export interface DeleteNoteResult extends WriteOutcomeFlags {
  readonly operation: "delete";
  readonly id: string;
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export class NotesnookWriteAdapter {
  readonly #database: NotesnookWriteDatabase;
  readonly #codec: NotesnookWriteMarkdownCodec;
  readonly #recoveryJournal: NotesnookRecoveryJournal | undefined;

  constructor(options: NotesnookWriteAdapterOptions) {
    this.#database = resolveWriteDatabase(options.source);
    this.#codec = resolveCodec(options.codec);
    this.#recoveryJournal = resolveRecoveryJournal(options.recoveryJournal);
    Object.freeze(this);
  }

  /**
   * Create a note from the published `CreateNoteCommand`.  Title,
   * content, optional notebook membership, and optional tag relations
   * are the only fields the contract accepts.  Tag relations are
   * created through the bounded `relationAdd` slot, never through a
   * generic collection mutator.
   */
  async createNote(command: CreateNoteCommand): Promise<CreateNoteResult> {
    // Step 1 — pure contract plan.  This module imports the existing
    // pure slice so every input field is re-validated against the
    // closed set, including hostile-getter defence.  Nothing the
    // adapter does can bypass that boundary.
    const snapshot = snapshotCreateCommand(command);
    const plan = planCreateNote(snapshot);
    const titleBytes = Buffer.byteLength(plan.title, "utf8");

    // Step 2 — notebook membership is allowlisted and explicit.  We
    // confirm the notebook exists before we set up the create path;
    // this fails closed with `invalid_input` if the id references
    // something the seam does not know about.
    if (plan.notebookId !== undefined) {
      const exists = await this.#safe("notebookExists", () =>
        this.#database.notebookExists(plan.notebookId as string),
      );
      if (exists !== true) {
        throw adapterError(
          "invalid_input",
          "Notesnook write adapter: notebook reference is not recognised",
        );
      }
    }

    // Validate every desired tag before encoding or mutating.  This is
    // the create transaction's preflight boundary: an unknown tag must
    // not leave a note behind after `notesAdd` succeeds.
    if (plan.tags !== undefined) {
      await this.#validateTags(plan.tags);
    }

    // Step 2.5 — fidelity gate.  Refuse Markdown constructs the codec
    // cannot round-trip (Astra finding P1-7).  The throw is normalised
    // to `unsupported_content` so the categorical boundary stays
    // closed.  Runs before any mutator so the unsupported construct is
    // never silently downgraded to a paragraph.
    try {
      assertSupportedConstructs(snapshot.content, STAGE4_WRITE_LIMITS.maxContentBytes);
    } catch {
      throw adapterError(
        "unsupported_content",
        "Notesnook write adapter: create content uses an unsupported construct",
      );
    }

    // Step 3 — translate Markdown to the stored representation via the
    // injected codec.  Any throw is normalised to `unsupported_content`.
    // The contract only stores byte counts here; the raw Markdown is
    // never concatenated into the stored content slot.  `listKind` is
    // forwarded verbatim from the plan so the codec picks the requested
    // intent; a malformed value has already been rewritten to
    // `invalid_input` by the contract plan.
    const encoded = this.#encodeMarkdown(snapshot.content, plan.listKind);

    // Step 4 — perform the local mutation.  We catch every upstream
    // throw and rewrite it to a categorical failure.  The adapter
    // claims `localCommitted: true` ONLY after `notesAdd` resolves.
    let id: string;
    try {
      id = await this.#safe("notesAdd", () =>
        this.#database.notesAdd({ title: plan.title, content: encoded }),
      );
    } catch {
      throw adapterError("sync_failed", "Notesnook write adapter: create failed");
    }

    let notebookAttached = false;
    if (plan.notebookId !== undefined) {
      try {
        await this.#safe("notebookAddNote", () =>
          this.#database.notebookAddNote(plan.notebookId as string, id),
        );
        notebookAttached = true;
      } catch {
        if (!(await this.#compensateCreatedNote(id, plan.notebookId, notebookAttached, []))) {
          this.#recordRecovery("create", id, "create-notebook-attach");
        }
        throw adapterError("sync_failed", "Notesnook write adapter: create notebook attach failed");
      }
    }

    const addedTags: string[] = [];
    if (plan.tags && plan.tags.length > 0) {
      for (const tagId of plan.tags) {
        try {
          await this.#safe("relationAdd", () =>
            this.#database.relationAdd({ fromId: id, toId: tagId, type: "tag" }),
          );
          addedTags.push(tagId);
        } catch {
          if (
            !(await this.#compensateCreatedNote(id, plan.notebookId, notebookAttached, addedTags))
          ) {
            this.#recordRecovery("create", id, "create-tag-relation");
          }
          throw adapterError("sync_failed", "Notesnook write adapter: create tag relation failed");
        }
      }
    }

    return Object.freeze({
      operation: "create" as const,
      id,
      titleBytes,
      contentBytes: plan.contentBytes,
      localCommitted: true as const,
      remoteSynced: false as const,
      pendingSync: true as const,
    });
  }

  /**
   * Append one Markdown fragment to an existing note.
   *
   * Re-reads the current note and content immediately before any
   * mutation, derives the current revision token from the freshly
   * observed state, and compares it to `expectedRevision` through
   * the pure contract guard.  A mismatch fails closed with
   * `stale_revision` BEFORE any mutator fires.
   *
   * Locked notes fail with `vault_locked`.  Conflicted notes fail
   * with `conflict`.  Codec throws are normalised to
   * `unsupported_content`.  The raw Markdown is never concatenated
   * into the stored content slot; only the codec output is written.
   */
  async appendNote(command: AppendNoteCommand): Promise<AppendNoteResult> {
    const snapshot = snapshotAppendCommand(command);
    const plan = planAppendNote(snapshot);

    // Re-read immediately before mutation; a hostile getter on the
    // stored note is normalised to `invalid_input` and never reaches
    // the caller.
    const observed = await this.#readNoteFreshly(plan.id);
    this.#assertCanWrite(observed, plan.expectedRevision);

    // Read the current stored content.  The pinned runtime stores it
    // as either HTML or Tiptap; only HTML has a safe direct append
    // primitive in the injected codec, so we route every other case
    // through the codec seam which may itself refuse.
    const stored = await this.#safe("contentFindByNoteId", () =>
      this.#database.contentFindByNoteId(plan.id),
    );
    if (stored === undefined) {
      throw adapterError(
        "unsupported_content",
        "Notesnook write adapter: stored content is not available",
      );
    }

    // Fidelity gate.  Refuse Markdown constructs the codec cannot
    // round-trip before any mutator fires (Astra finding P1-7).
    try {
      assertSupportedConstructs(snapshot.markdownFragment, STAGE4_WRITE_LIMITS.maxFragmentBytes);
    } catch {
      throw adapterError(
        "unsupported_content",
        "Notesnook write adapter: append fragment uses an unsupported construct",
      );
    }

    let next: NotesnookStoredContent;
    try {
      next = this.#codec.appendMarkdownToStoredContent({
        storedType: stored.type,
        storedData: stored.data,
        markdownFragment: snapshot.markdownFragment,
        // Forward the resolved listKind from the contract plan so the
        // codec emits the requested intent.  A malformed value has
        // already been rewritten to `invalid_input` by the contract
        // plan; the codec itself refuses `undefined` defaults to
        // `simple-checklist`.
        listKind: plan.listKind,
      });
    } catch {
      throw adapterError(
        "unsupported_content",
        "Notesnook write adapter: stored content cannot accept a Markdown append",
      );
    }

    try {
      await this.#safe("contentUpdateByNoteId", () =>
        this.#database.contentUpdateByNoteId({ type: next.type, data: next.data }, plan.id),
      );
    } catch {
      throw adapterError("sync_failed", "Notesnook write adapter: append failed");
    }

    // The pinned `@notesnook/core@8.1.3` Content collection does not
    // bump the parent note's `dateEdited` when a content row is replaced
    // through `Content.updateByNoteId`.  Without this explicit touch,
    // a follow-up `notesnook_get_note` reads the same `dateEdited` and
    // returns the pre-append revision token, so the concurrency gate
    // cannot fire on a follow-up append.  The touch is a narrow write
    // (one field, one id) so it does not widen the patch surface.
    try {
      await this.#safe("notesTouch", () => this.#database.notesTouch([plan.id], Date.now()));
    } catch {
      throw adapterError(
        "sync_failed",
        "Notesnook write adapter: append failed to bump note dateEdited",
      );
    }

    return Object.freeze({
      operation: "append" as const,
      id: plan.id,
      contentBytes: plan.fragmentBytes,
      localCommitted: true as const,
      remoteSynced: false as const,
      pendingSync: true as const,
    });
  }

  /**
   * Apply an allowlisted patch to an existing note.  Re-reads the
   * note immediately before mutation and derives the current revision
   * token from the freshly observed state.  Fields outside the
   * patch are never touched.
   *
   * Compensation slice
   * -------------------
   *
   * The update path is a multi-step saga: a single
   * `updateNote` call may issue `notesUpdate`, `notebookAddNote`,
   * `relationRemove`/`relationAdd`, `contentUpdateByNoteId`, and
   * `notesTouch` mutators in sequence.  When a forward mutator
   * fails after one or more earlier mutators have already applied,
   * the saga MUST leave the note either at its pre-mutation state
   * (compensation succeeded) or marked as a bounded recovery entry
   * (one of the inverse mutators also failed).  A successful
   * `updateNote` must never claim `localCommitted: true` when the
   * note is partially mutated; an unsuccessful `updateNote` must
   * never leave a phantom partial state behind without a recovery
   * marker.
   *
   * The slice is deliberately bounded: it uses ONLY the existing
   * mutator slots on the {@link NotesnookWriteDatabase} seam, so
   * the inverse path is symmetric with the forward path and no new
   * low-level storage adapter or Kysely/SQL is introduced.  The
   * recovery journal continues to record the bounded
   * `{operation, noteId, stage}` shape; the only addition is that
   * the update saga now also records `update-metadata`,
   * `update-tags`, and `update-content` markers when its own
   * inverse mutators fail to complete the rollback.  The journal
   * type already includes those stages.
   */
  async updateNote(command: UpdateNoteCommand): Promise<UpdateNoteResult> {
    const snapshot = snapshotUpdateCommand(command);
    const plan = planUpdateNote(snapshot);

    // Re-read immediately before mutation.
    const observed = await this.#readNoteFreshly(plan.id);
    this.#assertCanWrite(observed, plan.expectedRevision);

    const patch = snapshot.patch;

    // Step A — metadata fields.  Every field is explicitly allowlisted.
    const metadataFields: NotesnookUpdatePatchField[] = [];
    let contentBytes: number | undefined;

    for (const field of plan.patchFields) {
      if (field === "content") continue;
      metadataFields.push(field);
    }

    // Complete all read-only validation before the first mutator.  In
    // particular, every desired tag is checked before notesUpdate or
    // relationRemove can change the note.
    if (patch.tags !== undefined) {
      await this.#validateTags(patch.tags ?? []);
    }

    // Capture the pre-mutation stored content so the content compensation
    // can restore it after a failed forward write.  This is read-only —
    // the forward content mutator uses the freshly-encoded representation.
    let preStoredContent: NotesnookStoredContent | undefined;
    let preparedContent: NotesnookStoredContent | undefined;
    if (plan.patchFields.includes("content")) {
      const newContent = patch.content as string;
      // Fidelity gate.  Refuse Markdown constructs the codec cannot
      // round-trip before any mutator fires (Astra finding P1-7).
      try {
        assertSupportedConstructs(newContent, STAGE4_WRITE_LIMITS.maxContentBytes);
      } catch {
        throw adapterError(
          "unsupported_content",
          "Notesnook write adapter: update content uses an unsupported construct",
        );
      }
      contentBytes = Buffer.byteLength(newContent, "utf8");
      const stored = await this.#safe("contentFindByNoteId", () =>
        this.#database.contentFindByNoteId(plan.id),
      );
      if (stored === undefined) {
        throw adapterError(
          "unsupported_content",
          "Notesnook write adapter: stored content is not available",
        );
      }
      // Forward the resolved listKind from the plan.  The contract only
      // surfaces a `listKind` slot on the plan when the patch carries
      // a `content` field, so this is exactly the case where the codec
      // must run.
      const encoded = this.#encodeMarkdown(newContent, plan.listKind);
      preparedContent = { type: stored.type, data: encoded.data };
      // Only the codec-encoded bytes are written forward; the stored
      // shape must be restored verbatim on compensation.  We snapshot
      // a closed shape (no `id`, no `noteId`, no `locked`) so the
      // inverse writer cannot accidentally rely on stale identity.
      preStoredContent = { type: stored.type, data: stored.data };
    }

    // Compensation progress.  These locals are flipped as each forward
    // mutator completes; the compensation saga walks them in reverse
    // and invokes inverse mutators to undo the partial progress.  None
    // of the values cross the public surface — they are bounded,
    // internal state.
    let notebookAttachSucceeded = false;
    let notebookAttachId: string | undefined;
    const removedTagRelations: string[] = [];
    const addedTagRelations: string[] = [];
    let contentMutated = false;

    if (metadataFields.length > 0) {
      const partialForNotes: Record<string, unknown> = {};
      for (const field of metadataFields) {
        switch (field) {
          case "title":
            partialForNotes.title = patch.title;
            break;
          case "notebookId":
            partialForNotes.notebookId = patch.notebookId;
            break;
          case "tags":
            partialForNotes.tags = patch.tags;
            break;
          case "pinned":
            partialForNotes.pinned = patch.pinned;
            break;
          case "favorite":
            partialForNotes.favorite = patch.favorite;
            break;
        }
      }

      // Confirm notebook membership exists before mutating.
      if (patch.notebookId !== undefined) {
        const exists = await this.#safe("notebookExists", () =>
          this.#database.notebookExists(patch.notebookId as string),
        );
        if (exists !== true) {
          throw adapterError(
            "invalid_input",
            "Notesnook write adapter: notebook reference is not recognised",
          );
        }
      }

      try {
        await this.#safe("notesUpdate", () =>
          this.#database.notesUpdate([plan.id], partialForNotes),
        );
      } catch {
        throw adapterError("sync_failed", "Notesnook write adapter: metadata update failed");
      }

      // Notebook membership: the allowlisted `notebookId` patch moves
      // the note between notebooks.  We use the bounded
      // `notebookAddNote` slot — never a generic collection mutator.
      if (patch.notebookId !== undefined) {
        try {
          await this.#safe("notebookAddNote", () =>
            this.#database.notebookAddNote(patch.notebookId as string, plan.id),
          );
          notebookAttachSucceeded = true;
          notebookAttachId = patch.notebookId;
        } catch {
          await this.#compensateUpdateNote({
            id: plan.id,
            observed,
            notebookAttachSucceeded: false,
            notebookAttachId: patch.notebookId,
            removedTagRelations,
            addedTagRelations,
            contentMutated: false,
            metadataMutated: metadataFields.length > 0,
            preStoredContent,
          });
          throw adapterError("sync_failed", "Notesnook write adapter: notebook attach failed");
        }
      }

      // Tag relation rewrite: an update that sets `tags` replaces the
      // note's tag relations atomically through the bounded relation
      // slots.
      if (patch.tags !== undefined) {
        const desired = patch.tags ?? [];
        let existing: ReadonlyArray<{ readonly toId: string; readonly type: string }>;
        try {
          existing = await this.#safe("relationListForNote", () =>
            this.#database.relationListForNote(plan.id),
          );
        } catch {
          await this.#compensateUpdateNote({
            id: plan.id,
            observed,
            notebookAttachSucceeded,
            notebookAttachId,
            removedTagRelations,
            addedTagRelations,
            contentMutated: false,
            metadataMutated: metadataFields.length > 0,
            preStoredContent,
          });
          throw adapterError(
            "sync_failed",
            "Notesnook write adapter: tag relation inspection failed",
          );
        }
        // Track which existing tag relations we actually removed so the
        // compensation can re-add them in reverse order if a later step
        // fails.  We only count `tag`-typed relations; the schema may
        // carry other relation types that are not part of this update.
        for (const rel of existing) {
          if (rel.type !== "tag") continue;
          if (desired.includes(rel.toId)) continue;
          try {
            await this.#safe("relationRemove", () =>
              this.#database.relationRemove({ fromId: plan.id, toId: rel.toId, type: "tag" }),
            );
            removedTagRelations.push(rel.toId);
          } catch {
            await this.#compensateUpdateNote({
              id: plan.id,
              observed,
              notebookAttachSucceeded,
              notebookAttachId,
              removedTagRelations,
              addedTagRelations,
              contentMutated: false,
              metadataMutated: metadataFields.length > 0,
              preStoredContent,
            });
            throw adapterError(
              "sync_failed",
              "Notesnook write adapter: tag relation removal failed",
            );
          }
        }
        for (const tagId of desired) {
          if (existing.some((rel) => rel.type === "tag" && rel.toId === tagId)) continue;
          try {
            await this.#safe("relationAdd", () =>
              this.#database.relationAdd({ fromId: plan.id, toId: tagId, type: "tag" }),
            );
            addedTagRelations.push(tagId);
          } catch {
            await this.#compensateUpdateNote({
              id: plan.id,
              observed,
              notebookAttachSucceeded,
              notebookAttachId,
              removedTagRelations,
              addedTagRelations,
              contentMutated: false,
              metadataMutated: metadataFields.length > 0,
              preStoredContent,
            });
            throw adapterError("sync_failed", "Notesnook write adapter: tag relation add failed");
          }
        }
      }
    }

    // Step B — content field.  The content was read and encoded during
    // preflight, before any metadata mutator.  Only the write itself
    // remains here.
    if (preparedContent !== undefined) {
      try {
        await this.#safe("contentUpdateByNoteId", () =>
          this.#database.contentUpdateByNoteId(
            { type: preparedContent.type, data: preparedContent.data },
            plan.id,
          ),
        );
        contentMutated = true;
      } catch {
        await this.#compensateUpdateNote({
          id: plan.id,
          observed,
          notebookAttachSucceeded,
          notebookAttachId,
          removedTagRelations,
          addedTagRelations,
          contentMutated: false,
          metadataMutated: metadataFields.length > 0,
          preStoredContent,
        });
        throw adapterError("sync_failed", "Notesnook write adapter: content update failed");
      }

      // The pinned `@notesnook/core@8.1.3` Content collection does not
      // bump the parent note's `dateEdited` when a content row is replaced
      // through `Content.updateByNoteId`.  Advance it explicitly so a
      // follow-up revision token cannot remain valid after this mutation.
      try {
        await this.#safe("notesTouch", () =>
          this.#database.notesTouch([plan.id], Math.max(Date.now(), observed.dateEdited + 1)),
        );
      } catch {
        // Content was written but the follow-up touch rejected.  The
        // bounded saga must undo the content write; the touch never
        // succeeded so the pre-mutation dateEdited is still authoritative
        // and needs no separate inverse.
        await this.#compensateUpdateNote({
          id: plan.id,
          observed,
          notebookAttachSucceeded,
          notebookAttachId,
          removedTagRelations,
          addedTagRelations,
          contentMutated,
          metadataMutated: metadataFields.length > 0,
          preStoredContent,
        });
        throw adapterError(
          "sync_failed",
          "Notesnook write adapter: content update failed to bump note dateEdited",
        );
      }
    }

    const result: {
      operation: "update";
      id: string;
      appliedFields: readonly NotesnookUpdatePatchField[];
      contentBytes?: number;
      localCommitted: true;
      remoteSynced: false;
      pendingSync: true;
    } = {
      operation: "update" as const,
      id: plan.id,
      appliedFields: plan.patchFields,
      localCommitted: true as const,
      remoteSynced: false as const,
      pendingSync: true as const,
    };
    if (contentBytes !== undefined) {
      result.contentBytes = contentBytes;
    }
    return Object.freeze(result);
  }

  /**
   * Soft-delete exactly one note through the pinned `notes.moveToTrash`
   * projection.  Metadata is re-read immediately before this sole
   * mutation, and every locked/conflicted/stale state fails closed.
   */
  async deleteNote(command: DeleteNoteCommand): Promise<DeleteNoteResult> {
    const snapshot = snapshotDeleteCommand(command);
    const plan = planDeleteNote(snapshot);
    const observed = await this.#readNoteFreshly(plan.id);
    this.#assertCanWrite(observed, plan.expectedRevision);
    try {
      const notesDelete = this.#database.notesDelete;
      if (notesDelete === undefined) {
        throw adapterError("invalid_input", "Notesnook write adapter: delete unavailable");
      }
      await notesDelete(plan.id);
    } catch (error) {
      if (isWriteAdapterError(error) || isNotesnookWriteContractError(error)) {
        throw error;
      }
      if (isUpstreamVaultLockedRefusal(error)) {
        throw adapterError(
          "vault_locked",
          "Notesnook write adapter: delete refused by locked vault",
        );
      }
      throw adapterError("sync_failed", "Notesnook write adapter: delete failed");
    }
    return Object.freeze({
      operation: "delete" as const,
      id: plan.id,
      localCommitted: true as const,
      remoteSynced: false as const,
      pendingSync: true as const,
    });
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  async #compensateCreatedNote(
    id: string,
    notebookId: string | undefined,
    notebookAttached: boolean,
    addedTags: readonly string[],
  ): Promise<boolean> {
    let complete = true;
    for (let index = addedTags.length - 1; index >= 0; index -= 1) {
      try {
        await this.#safe("relationRemove", () =>
          this.#database.relationRemove({ fromId: id, toId: addedTags[index]!, type: "tag" }),
        );
      } catch {
        complete = false;
      }
    }
    if (notebookAttached && notebookId !== undefined) {
      try {
        await this.#safe("notebookRemoveNote", () =>
          this.#database.notebookRemoveNote(notebookId, id),
        );
      } catch {
        complete = false;
      }
    }
    if (this.#database.notesDelete === undefined) return false;
    try {
      await this.#safe("notesDelete", () => this.#database.notesDelete!(id));
    } catch {
      complete = false;
    }
    return complete;
  }

  /**
   * Bounded inverse of every mutator the update saga may have applied.
   *
   * The saga walks the captured pre-mutation state in reverse order
   * (newest applied first) so a partial rollback still leaves the
   * note as close to the pre-mutation state as the seam allows.  Each
   * inverse mutator is invoked exactly as the forward mutator was: a
   * throw is absorbed here and recorded as a bounded recovery marker
   * for the affected stage.  The caller always observes the
   * categorical `sync_failed` from the original forward failure; the
   * compensation saga must never replace that error.
   *
   * Stages recorded:
   *
   *   - `update-content` — the inverse content write failed;
   *   - `update-tags` — at least one inverse relationAdd/relationRemove
   *     failed;
   *   - `update-metadata` — at least one of the inverse metadata
   *     mutators (notebook detach, notesUpdate re-apply) failed.
   *
   * The recovery journal marker shape (`{operation, noteId, stage}`)
   * is unchanged; the journal type already included those three update
   * stages so no new marker variant is introduced.
   */
  async #compensateUpdateNote(progress: {
    readonly id: string;
    readonly observed: NotesnookWriteNoteMetadata;
    readonly notebookAttachSucceeded: boolean;
    readonly notebookAttachId: string | undefined;
    readonly removedTagRelations: readonly string[];
    readonly addedTagRelations: readonly string[];
    readonly contentMutated: boolean;
    readonly metadataMutated: boolean;
    readonly preStoredContent: NotesnookStoredContent | undefined;
  }): Promise<void> {
    // 1. Content compensation.  The forward content phase writes the
    //    freshly-encoded body and then bumps the parent note's
    //    `dateEdited` via `notesTouch`.  The follow-up touch is the
    //    very last mutator of the saga: when it fails the content
    //    write has already applied, so the inverse must rewrite the
    //    pre-mutation stored body.  The touch itself never succeeded
    //    on a failure path, so no separate inverse `notesTouch` is
    //    required (the pre-mutation `dateEdited` is still authoritative
    //    for any future revision token).  Any failure here records an
    //    `update-content` marker.
    if (progress.contentMutated && progress.preStoredContent !== undefined) {
      const revertContent = progress.preStoredContent;
      try {
        await this.#safe("contentUpdateByNoteId", () =>
          this.#database.contentUpdateByNoteId(
            { type: revertContent.type, data: revertContent.data },
            progress.id,
          ),
        );
      } catch {
        this.#recordRecovery("update", progress.id, "update-content");
      }
    }

    // 2. Tag relation compensation.  Reverse order: re-add removed
    //    relations, then remove added relations.  Any failure records
    //    an `update-tags` marker.
    if (progress.addedTagRelations.length > 0 || progress.removedTagRelations.length > 0) {
      let tagCompensationComplete = true;
      for (let index = progress.removedTagRelations.length - 1; index >= 0; index -= 1) {
        const toId = progress.removedTagRelations[index]!;
        try {
          await this.#safe("relationAdd", () =>
            this.#database.relationAdd({ fromId: progress.id, toId, type: "tag" }),
          );
        } catch {
          tagCompensationComplete = false;
        }
      }
      for (let index = progress.addedTagRelations.length - 1; index >= 0; index -= 1) {
        const toId = progress.addedTagRelations[index]!;
        try {
          await this.#safe("relationRemove", () =>
            this.#database.relationRemove({ fromId: progress.id, toId, type: "tag" }),
          );
        } catch {
          tagCompensationComplete = false;
        }
      }
      if (!tagCompensationComplete) {
        this.#recordRecovery("update", progress.id, "update-tags");
      }
    }

    // 3. Metadata compensation.  Inverse notebook detach (only if a
    //    notebook was attached by this call), then re-apply the
    //    pre-mutation metadata.  Any failure records an
    //    `update-metadata` marker.
    if (!progress.metadataMutated) return;
    let metadataCompensationComplete = true;
    if (progress.notebookAttachSucceeded && progress.notebookAttachId !== undefined) {
      const notebookId = progress.notebookAttachId;
      try {
        await this.#safe("notebookRemoveNote", () =>
          this.#database.notebookRemoveNote(notebookId, progress.id),
        );
      } catch {
        metadataCompensationComplete = false;
      }
    }
    // The pre-mutation `observed` shape is the authoritative rollback
    // for the `notesUpdate` partial: every field the saga wrote
    // (title, pinned, favorite, notebookId, tags) is restored verbatim
    // from the freshly-read pre-state.  Tag relations are separately
    // handled by the inverse relationAdd/relationRemove loop above, but
    // the metadata tags field must still be restored here.
    try {
      const revertPartial: Record<string, unknown> = {};
      revertPartial.title = progress.observed.title;
      revertPartial.pinned = progress.observed.pinned;
      revertPartial.favorite = progress.observed.favorite;
      revertPartial.tags = progress.observed.tags ?? [];
      revertPartial.notebookId = progress.observed.notebookId;
      await this.#safe("notesUpdate", () =>
        this.#database.notesUpdate([progress.id], revertPartial),
      );
    } catch {
      metadataCompensationComplete = false;
    }
    if (!metadataCompensationComplete) {
      this.#recordRecovery("update", progress.id, "update-metadata");
    }
  }

  #recordRecovery(
    operation: "create" | "append" | "update" | "delete",
    id: string,
    stage: NotesnookRecoveryStage,
  ): void {
    if (this.#recoveryJournal === undefined) return;
    try {
      this.#recoveryJournal.record(createNotesnookRecoveryMarker(operation, id, stage));
    } catch {
      // The caller already receives sync_failed. Never replace the categorical
      // result with a journal/storage exception or expose its details.
    }
  }

  async #validateTags(tagIds: readonly string[]): Promise<void> {
    for (const tagId of tagIds) {
      const exists = await this.#safe("tagExists", () => this.#database.tagExists(tagId));
      if (exists !== true) {
        throw adapterError(
          "invalid_input",
          "Notesnook write adapter: tag reference is not recognised",
        );
      }
    }
  }

  #encodeMarkdown(markdown: string, listKind?: NotesnookListKind): NotesnookStoredContent {
    try {
      return this.#codec.encodeMarkdown(markdown, listKind);
    } catch {
      throw adapterError(
        "unsupported_content",
        "Notesnook write adapter: content encoding refused the new body",
      );
    }
  }

  async #readNoteFreshly(id: string): Promise<NotesnookWriteNoteMetadata> {
    const observed = await this.#safe("note", () => this.#database.note(id));
    if (observed === undefined) {
      throw adapterError("invalid_input", "Notesnook write adapter: note is not present");
    }
    return observed;
  }

  #assertCanWrite(
    observed: NotesnookWriteNoteMetadata,
    expectedRevision: NotesnookRevisionToken,
  ): void {
    if (observed.conflicted === true) {
      throw adapterError("conflict", "Notesnook write adapter: note is conflicted");
    }
    if (observed.locked === true) {
      throw adapterError("vault_locked", "Notesnook write adapter: note is locked in the vault");
    }
    const state: NotesnookRevisionState = {
      id: observed.id,
      dateEdited: observed.dateEdited,
    };
    const current = createRevisionToken(state);
    try {
      assertRevisionMatch(expectedRevision, current);
    } catch (error) {
      if (isNotesnookWriteContractError(error) && error.code === "stale_revision") {
        throw adapterError("stale_revision", "Notesnook write adapter: revision mismatch");
      }
      throw adapterError("invalid_input", "Notesnook write adapter: revision token is invalid");
    }
  }

  async #safe<T>(name: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (isWriteAdapterError(error) || isNotesnookWriteContractError(error)) {
        throw error;
      }
      throw adapterError("sync_failed", `Notesnook write adapter: ${name} call rejected upstream`);
    }
  }
}

export function createNotesnookWriteAdapter(
  options: NotesnookWriteAdapterOptions,
): NotesnookWriteAdapter {
  return new NotesnookWriteAdapter(options);
}

// ---------------------------------------------------------------------------
// Command snapshots.
//
// The pure plan functions validate values, but their compact plan shapes do
// not retain every value needed by the mutation path (for example, create
// content or an update title).  Snapshot the caller boundary first, then
// validate that immutable snapshot.  This makes each caller getter run once
// and ensures no later await can expose a changed command or patch.
// ---------------------------------------------------------------------------

const SNAPSHOT_PATCH_FIELDS: ReadonlyArray<NotesnookUpdatePatchField> = [
  "title",
  "content",
  "notebookId",
  "tags",
  "pinned",
  "favorite",
  "listKind",
];

function snapshotCreateCommand(command: CreateNoteCommand): CreateNoteCommand {
  const record = command as unknown as Record<string, unknown>;
  const title = snapshotProperty(record, "title");
  const content = snapshotProperty(record, "content");
  const notebookId = snapshotProperty(record, "notebookId");
  const tags = snapshotArray(snapshotProperty(record, "tags"));
  const listKind = snapshotProperty(record, "listKind");
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  snapshot.title = title;
  snapshot.content = content;
  if (notebookId !== undefined) snapshot.notebookId = notebookId;
  if (tags !== undefined) snapshot.tags = tags;
  if (listKind !== undefined) snapshot.listKind = listKind;
  return Object.freeze(snapshot) as unknown as CreateNoteCommand;
}

function snapshotAppendCommand(command: AppendNoteCommand): AppendNoteCommand {
  const record = command as unknown as Record<string, unknown>;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  snapshot.id = snapshotProperty(record, "id");
  snapshot.markdownFragment = snapshotProperty(record, "markdownFragment");
  snapshot.expectedRevision = snapshotProperty(record, "expectedRevision");
  const listKind = snapshotProperty(record, "listKind");
  if (listKind !== undefined) snapshot.listKind = listKind;
  return Object.freeze(snapshot) as unknown as AppendNoteCommand;
}

function snapshotUpdateCommand(command: UpdateNoteCommand): UpdateNoteCommand {
  const record = command as unknown as Record<string, unknown>;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  snapshot.id = snapshotProperty(record, "id");
  snapshot.patch = snapshotPatch(snapshotProperty(record, "patch"));
  snapshot.expectedRevision = snapshotProperty(record, "expectedRevision");
  return Object.freeze(snapshot) as unknown as UpdateNoteCommand;
}

function snapshotDeleteCommand(command: DeleteNoteCommand): DeleteNoteCommand {
  const record = command as unknown as Record<string, unknown>;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(record);
  } catch {
    throw adapterError("invalid_input", "Notesnook write adapter: delete command rejected");
  }
  for (const key of keys) {
    if (typeof key !== "string") continue;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(record, key);
    } catch {
      throw adapterError("invalid_input", "Notesnook write adapter: delete command rejected");
    }
    if (descriptor?.enumerable !== true) continue;
    if (key !== "id" && key !== "expectedRevision") {
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: undefined,
      });
      continue;
    }
    snapshot[key] = snapshotProperty(record, key);
  }
  if (!Object.prototype.hasOwnProperty.call(snapshot, "id")) snapshot.id = undefined;
  if (!Object.prototype.hasOwnProperty.call(snapshot, "expectedRevision")) {
    snapshot.expectedRevision = undefined;
  }
  return Object.freeze(snapshot) as unknown as DeleteNoteCommand;
}

function snapshotProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    return Reflect.get(record, key, record);
  } catch {
    throw adapterError("invalid_input", "Notesnook write adapter: command accessor rejected");
  }
}

function snapshotPatch(value: unknown): unknown {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw adapterError("invalid_input", "Notesnook write adapter: update patch rejected");
  }
  if (value === null || typeof value !== "object" || isArray) return value;

  const source = value as Record<string, unknown>;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(source);
  } catch {
    throw adapterError("invalid_input", "Notesnook write adapter: update patch rejected");
  }
  for (const key of keys) {
    if (typeof key !== "string") continue;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    } catch {
      throw adapterError("invalid_input", "Notesnook write adapter: update patch rejected");
    }
    if (descriptor?.enumerable !== true) continue;
    // Preserve the plan's unsupported-field rejection without invoking an
    // attacker-controlled getter for a field the contract will reject.
    if (!SNAPSHOT_PATCH_FIELDS.includes(key as NotesnookUpdatePatchField)) {
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: undefined,
      });
      continue;
    }
    const captured = snapshotProperty(source, key);
    snapshot[key] = key === "tags" ? snapshotArray(captured) : captured;
  }
  return Object.freeze(snapshot);
}

function snapshotArray(value: unknown): unknown {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw adapterError("invalid_input", "Notesnook write adapter: array value rejected");
  }
  if (!isArray) return value;

  let length: number;
  try {
    length = (value as { readonly length: number }).length;
  } catch {
    throw adapterError("invalid_input", "Notesnook write adapter: array value rejected");
  }
  // Let the contract plan produce the categorical bounds error.  Valid
  // arrays are copied by direct indexed reads so no iterator/species hook is
  // invoked, and the copy is immutable before it is passed to the plan.
  if (!Number.isSafeInteger(length) || length < 0 || length > 16) return value;
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      copy.push(Reflect.get(value as object, String(index), value));
    } catch {
      throw adapterError("invalid_input", "Notesnook write adapter: array value rejected");
    }
  }
  return Object.freeze(copy);
}

// ---------------------------------------------------------------------------
// Categorical error normalisation.
//
// Adapter-owned errors are recognised by identity, not by message.  The
// marker is held in a module-private `WeakSet<object>` keyed on object
// identity, mirroring the existing adapter's pattern.  `cause` and
// `__context__` are explicitly cleared so an attacker that controls
// the upstream error cannot smuggle data through the chain.
// ---------------------------------------------------------------------------

function isUpstreamVaultLockedRefusal(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  try {
    const code = Object.getOwnPropertyDescriptor(value, "code");
    if (code?.get === undefined && code?.value === "ERR_VAULT_LOCKED") return true;
    const message = Object.getOwnPropertyDescriptor(value, "message");
    return message?.get === undefined && message?.value === "ERR_VAULT_LOCKED";
  } catch {
    return false;
  }
}

const WRITE_ADAPTER_ERRORS = new WeakSet<object>();

/**
 * Construct a categorical, chain-free write-adapter error.
 */
function adapterError(code: NotesnookWriteContractError["code"], _message: string): Error {
  // Always rebuild the underlying contract error so the code table is
  // closed and the message is fixed by the categorical `code`.  We
  // discard `_message` deliberately so the caller cannot interpolate
  // a canary.
  const error = new NotesnookWriteContractError(code, undefined);
  Object.defineProperty(error, "name", {
    configurable: true,
    value: "NotesnookWriteAdapterError",
  });
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", {
    configurable: true,
    value: undefined,
  });
  WRITE_ADAPTER_ERRORS.add(error);
  return error;
}

/**
 * Public predicate.  Returns true iff `value` is an adapter-owned
 * error emitted by this module.
 */
export function isNotesnookWriteAdapterError(value: unknown): value is Error {
  return typeof value === "object" && value !== null && WRITE_ADAPTER_ERRORS.has(value);
}

function isWriteAdapterError(value: unknown): value is Error {
  return isNotesnookWriteAdapterError(value);
}

// ---------------------------------------------------------------------------
// Seam resolution and validation.
// ---------------------------------------------------------------------------

function resolveWriteDatabase(source: NotesnookWriteDatabaseSource): NotesnookWriteDatabase {
  const candidate = typeof source === "function" ? safeCall(source) : source;
  if (isPromiseLike(candidate)) {
    throw adapterError(
      "invalid_input",
      "Notesnook write adapter: injected source must resolve before construction",
    );
  }
  return validateWriteDatabase(candidate);
}

function safeCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch {
    throw adapterError("invalid_input", "Notesnook write adapter: injected source factory threw");
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

const REQUIRED_WRITE_SLOTS: ReadonlyArray<keyof NotesnookWriteDatabase> = [
  "note",
  "contentFindByNoteId",
  "notesAdd",
  "notesUpdate",
  "notesTouch",
  "contentAdd",
  "contentUpdateByNoteId",
  "notebookExists",
  "notebookNotes",
  "notebookAddNote",
  "notebookRemoveNote",
  "tagExists",
  "tagAdd",
  "relationAdd",
  "relationRemove",
  "relationListForNote",
];

const FORBIDDEN_WRITE_NAMES: ReadonlyArray<string> = [
  // Stage 3 read-only surface — must not leak through the write seam.
  "sync",
  "lastSynced",
  "hasUnsyncedChanges",
  "listNotebooks",
  "noteMetadata",
  "search",
  // Generic / dangerous upstream surface.
  "delete",
  "remove",
  "moveToTrash",
  "duplicate",
  "restore",
  "force",
  "setLastSynced",
  "pin",
  "favorite",
  "readonly",
  "localOnly",
  "addToNotebook",
  "removeFromNotebook",
  "removeFromAllNotebooks",
  "changePassword",
  "disconnectSSE",
  "connectSSE",
  "init",
  "setup",
  "host",
  "writeEncrypted",
  "writeMulti",
  "write",
  "removeMulti",
  "clear",
  "import",
  "export",
  "dropTable",
  "exec",
  "vaultUnlock",
  "vaultLock",
  "vaultAdd",
  "vaultRemove",
  "vaultCreate",
  "vaultClear",
  "publish",
  "unpublish",
  "send",
  "fetch",
];

function validateWriteDatabase(value: unknown): NotesnookWriteDatabase {
  if (!value || typeof value !== "object") {
    throw adapterError(
      "invalid_input",
      "Notesnook write adapter: injected source must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  for (const slot of REQUIRED_WRITE_SLOTS) {
    if (typeof record[slot] !== "function") {
      throw adapterError(
        "invalid_input",
        "Notesnook write adapter: injected source is missing a required slot",
      );
    }
  }
  for (const name of FORBIDDEN_WRITE_NAMES) {
    if (name in record && typeof record[name] !== "undefined") {
      throw adapterError(
        "invalid_input",
        "Notesnook write adapter: injected source exposes a forbidden escape hatch",
      );
    }
  }
  return value as NotesnookWriteDatabase;
}

function resolveRecoveryJournal(value: unknown): NotesnookRecoveryJournal | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw adapterError("invalid_input", "Notesnook write adapter: invalid recovery journal");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.record !== "function" || typeof record.snapshot !== "function") {
    throw adapterError("invalid_input", "Notesnook write adapter: invalid recovery journal");
  }
  return Object.freeze({
    record: (marker: Parameters<NotesnookRecoveryJournal["record"]>[0]) =>
      Reflect.apply(record.record as (...args: unknown[]) => unknown, value, [marker]),
    snapshot: () =>
      Reflect.apply(record.snapshot as (...args: unknown[]) => unknown, value, []) as ReturnType<
        NotesnookRecoveryJournal["snapshot"]
      >,
  });
}

function resolveCodec(codec: unknown): NotesnookWriteMarkdownCodec {
  if (!codec || typeof codec !== "object") {
    throw adapterError(
      "invalid_input",
      "Notesnook write adapter: injected codec must be an object",
    );
  }
  const record = codec as Record<string, unknown>;
  if (typeof record.encodeMarkdown !== "function") {
    throw adapterError(
      "invalid_input",
      "Notesnook write adapter: injected codec is missing encodeMarkdown()",
    );
  }
  if (typeof record.appendMarkdownToStoredContent !== "function") {
    throw adapterError(
      "invalid_input",
      "Notesnook write adapter: injected codec is missing appendMarkdownToStoredContent()",
    );
  }
  return codec as NotesnookWriteMarkdownCodec;
}
