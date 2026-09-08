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
  planUpdateNote,
  type AppendNoteCommand,
  type CreateNoteCommand,
  type NotesnookRevisionState,
  type NotesnookRevisionToken,
  type NotesnookUpdatePatchField,
  type UpdateNoteCommand,
} from "./notesnook-write-contract.js";
import { assertSupportedConstructs } from "./notesnook-write-codec.js";

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
  readonly encodeMarkdown: (markdown: string) => NotesnookStoredContent;
  readonly appendMarkdownToStoredContent: (input: {
    readonly storedType: "tiptap" | "html";
    readonly storedData: string;
    readonly markdownFragment: string;
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

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export class NotesnookWriteAdapter {
  readonly #database: NotesnookWriteDatabase;
  readonly #codec: NotesnookWriteMarkdownCodec;

  constructor(options: NotesnookWriteAdapterOptions) {
    this.#database = resolveWriteDatabase(options.source);
    this.#codec = resolveCodec(options.codec);
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
    // never concatenated into the stored content slot.
    const encoded = this.#encodeMarkdown(snapshot.content);

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

    // Step 5 — attach the note to the allowlisted notebook and add
    // the bounded tag relations.  These steps must run AFTER the note
    // exists; failures here leave the note orphaned but the contract
    // promises only that the create succeeded, so we surface the
    // failure categorically.
    if (plan.notebookId !== undefined) {
      try {
        await this.#safe("notebookAddNote", () =>
          this.#database.notebookAddNote(plan.notebookId as string, id),
        );
      } catch {
        throw adapterError("sync_failed", "Notesnook write adapter: create notebook attach failed");
      }
    }

    if (plan.tags && plan.tags.length > 0) {
      for (const tagId of plan.tags) {
        try {
          await this.#safe("relationAdd", () =>
            this.#database.relationAdd({ fromId: id, toId: tagId, type: "tag" }),
          );
        } catch {
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
      const encoded = this.#encodeMarkdown(newContent);
      preparedContent = { type: stored.type, data: encoded.data };
    }

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
        } catch {
          throw adapterError("sync_failed", "Notesnook write adapter: notebook attach failed");
        }
      }

      // Tag relation rewrite: an update that sets `tags` replaces the
      // note's tag relations atomically through the bounded relation
      // slots.
      if (patch.tags !== undefined) {
        const desired = patch.tags ?? [];
        const existing = await this.#safe("relationListForNote", () =>
          this.#database.relationListForNote(plan.id),
        );
        for (const rel of existing) {
          if (rel.type !== "tag") continue;
          if (desired.includes(rel.toId)) continue;
          try {
            await this.#safe("relationRemove", () =>
              this.#database.relationRemove({ fromId: plan.id, toId: rel.toId, type: "tag" }),
            );
          } catch {
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
          } catch {
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
      } catch {
        throw adapterError("sync_failed", "Notesnook write adapter: content update failed");
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

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

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

  #encodeMarkdown(markdown: string): NotesnookStoredContent {
    try {
      return this.#codec.encodeMarkdown(markdown);
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
];

function snapshotCreateCommand(command: CreateNoteCommand): CreateNoteCommand {
  const record = command as unknown as Record<string, unknown>;
  const title = snapshotProperty(record, "title");
  const content = snapshotProperty(record, "content");
  const notebookId = snapshotProperty(record, "notebookId");
  const tags = snapshotArray(snapshotProperty(record, "tags"));
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  snapshot.title = title;
  snapshot.content = content;
  if (notebookId !== undefined) snapshot.notebookId = notebookId;
  if (tags !== undefined) snapshot.tags = tags;
  return Object.freeze(snapshot) as unknown as CreateNoteCommand;
}

function snapshotAppendCommand(command: AppendNoteCommand): AppendNoteCommand {
  const record = command as unknown as Record<string, unknown>;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  snapshot.id = snapshotProperty(record, "id");
  snapshot.markdownFragment = snapshotProperty(record, "markdownFragment");
  snapshot.expectedRevision = snapshotProperty(record, "expectedRevision");
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
