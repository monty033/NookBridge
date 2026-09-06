/**
 * NookBridge Stage 9 §13.11 — bounded AES-256-GCM encrypted undo
 * preimage journal slice.
 *
 * This is the THIRD slice of §13.11 and provides the
 * encrypted preimage storage boundary BEFORE any edit/undo
 * wiring.  The journal is intentionally isolated from the
 * existing `notes-cli.ts` parser/contract surface and from the
 * `notes-read-runtime.ts` adapter; it is NOT yet wired into the
 * operator CLI dispatcher and is NOT yet wired into Notesnook
 * itself.
 *
 * Purpose
 * -------
 *
 * The implementation plan §13.11 commits the bridge to
 * "encrypted undo preimage storage, bounded, expiring, cleaned
 * up".  This slice lands the storage boundary in the smallest
 * form that satisfies that requirement:
 *
 *   - the persistence seam is INJECTED — no real filesystem, no
 *     real Notesnook handle, no real database, no real network,
 *     no RPC, no MCP, no sync, no auth, no editor, no CLI;
 *   - the cipher seam is INJECTED — the journal uses a
 *     caller-supplied cipher helper (default: real AES-256-GCM
 *     via `node:crypto`) but NEVER ships a built-in plaintext
 *     fallback; the cipher's allowlisted shape is
 *     `encrypt(plaintext) -> framed` and `decrypt(framed) ->
 *     plaintext`;
 *   - the token factory is INJECTED so tests are deterministic —
 *     the journal never invents undo tokens itself outside the
 *     injected factory;
 *   - ciphertext-only persistence: the injected store MUST
 *     receive ciphertext and never plaintext; the cipher
 *     framing is fixed so the on-disk shape is bounded and
 *     predictable;
 *   - `record` accepts ONLY a bounded opaque note handle (same
 *     `<prefix>_<token>` grammar as the CLI contract, with the
 *     reserved `rev_` family excluded), bounded revision tokens
 *     (`rev_[0-9a-f]{32}`), title <= 100, content <= 4 MiB UTF-8
 *     bytes, and bounded metadata;
 *   - `load` and `consume` retrieve ciphertext by opaque undo
 *     token, decrypt it, validate the closed preimage schema and
 *     bounds, and return categorical `missing` / `invalid-input` /
 *     `locked` / `error` results WITHOUT echoing the token,
 *     body, title, ID, path, or upstream error;
 *   - failed decrypt / failed validation does NOT remove store
 *     data; `remove` is the ONLY path that deletes data from
 *     the store;
 *   - every record returned to the formatter is frozen so
 *     callers cannot mutate the snapshot through this slice.
 *
 * Non-goals
 * ---------
 *
 *   - this module does NOT read `process.env`, `process.argv`,
 *     or `process.stdin`; it is a runtime/persistence seam that
 *     accepts bounded inputs from a separately wired caller;
 *   - this module does NOT open, sync, or mutate any real
 *     Notesnook database; it adapts an injected store only;
 *   - this module does NOT carry edit / undo / delete / sync /
 *     transport / RPC / MCP semantics beyond the encrypted
 *     storage boundary; the actual undo application is a
 *     separately wired runtime that depends on this slice;
 *   - this module does NOT include a key-source, key-rotation,
 *     key-wipe, or key-derivation routine; the caller supplies a
 *     32-byte key from a separate, separately reviewed origin.
 */

import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";

// ---------------------------------------------------------------------------
// Public constants — closed framing invariants.
// ---------------------------------------------------------------------------

/** AES-256 key length in bytes. */
export const AES_GCM_KEY_BYTES = 32;

/** AES-GCM nonce length in bytes (12 bytes is the IETF default). */
export const AES_GCM_NONCE_BYTES = 12;

/** AES-GCM authentication tag length in bytes. */
export const AES_GCM_AUTH_TAG_BYTES = 16;

/**
 * Fixed version prefix for the encrypted frame.  This prefix is
 * the first `AES_GCM_VERSION_PREFIX.length` bytes of every
 * stored ciphertext; the decrypt path validates the prefix
 * BEFORE accepting the nonce / tag / ciphertext layout.
 */
export const AES_GCM_VERSION_PREFIX = "NBV1" as const;

/** Closed maximum content length (UTF-8 bytes) per preimage. */
export const NOTES_UNDO_CONTENT_MAX_BYTES = 4 * 1024 * 1024;

/** Closed maximum title length per preimage (mirrors the CLI cap). */
export const NOTES_UNDO_TITLE_MAX_LENGTH = 100;

/** Closed maximum handle / revision / metadata key length. */
const NOTES_UNDO_OPAQUE_MAX_LENGTH = 128;

/** Closed maximum metadata value length. */
const NOTES_UNDO_METADATA_VALUE_MAX_LENGTH = 100;

/** Closed maximum number of metadata entries per preimage. */
const NOTES_UNDO_METADATA_ENTRY_MAX = 16;

/** Bounded revision token pattern (`rev_<32-hex>`). */
const REVISION_TOKEN_PATTERN = /^rev_[0-9a-f]{32}$/;

/**
 * Bounded opaque value pattern — must match the CLI contract
 * exactly so an undo token can never be confused with a handle
 * or cursor.  Mirrors `isBoundedOpaqueValue` from `notes-cli.ts`.
 */
const OPAQUE_VALUE_PATTERN = /^[a-z][a-z0-9]{2,3}_[A-Za-z0-9_-]{4,124}$/;

/** Reserved-prefix regex (the `rev_` family). */
const RESERVED_OPAQUE_PREFIX = /^rev_/;

// ---------------------------------------------------------------------------
// Cipher seam — narrow interface, allowlisted, frozen.
// ---------------------------------------------------------------------------

/**
 * The injected cipher interface.  Every call MUST return a
 * `Uint8Array`.  Implementations are expected to be AES-256-GCM
 * but the journal does NOT pin a specific primitive; only the
 * framed-payload shape (version prefix + nonce + tag +
 * ciphertext) is enforced by `createAesGcmCipher`.
 */
export interface NotesUndoJournalAesGcmCipher {
  /**
   * Encrypt a plaintext and return the framed ciphertext.
   * The framing shape is implementation-defined; for the
   * default `createAesGcmCipher` helper the frame is
   * `VERSION_PREFIX | nonce | tag | ciphertext`.
   */
  readonly encrypt: (plaintext: Uint8Array) => Uint8Array;
  /** Decrypt a framed ciphertext and return the plaintext. */
  readonly decrypt: (framed: Uint8Array) => Uint8Array;
}

/**
 * Build the default AES-256-GCM cipher helper.  The key MUST be
 * exactly 32 bytes; the helper rejects every other length
 * categorically.  Every call uses a fresh 12-byte nonce and the
 * IETF default 16-byte authentication tag.
 */
export function createAesGcmCipher(key: Uint8Array): NotesUndoJournalAesGcmCipher {
  if (key === undefined || key === null) {
    throw cipherError("Notes undo journal: cipher key is required");
  }
  const byteLength = (key as { readonly byteLength?: number }).byteLength;
  const length =
    typeof byteLength === "number"
      ? byteLength
      : ((key as unknown as { readonly length?: number }).length ?? -1);
  if (length !== AES_GCM_KEY_BYTES) {
    throw cipherError("Notes undo journal: cipher key length is invalid");
  }
  // Copy the key into a private Buffer so callers cannot mutate
  // the captured handle after construction.
  const keyBuffer = Buffer.from(
    (key as Uint8Array).buffer,
    (key as Uint8Array).byteOffset,
    (key as Uint8Array).byteLength,
  );
  if (keyBuffer.length !== AES_GCM_KEY_BYTES) {
    throw cipherError("Notes undo journal: cipher key length is invalid");
  }
  const prefix = AES_GCM_VERSION_PREFIX;
  const prefixBytes = Buffer.from(prefix, "ascii");
  // Sentinel string used to distinguish auth-tag failures
  // (Node's `decipher.final()` throws a native error that does
  // NOT pass through JavaScript try/catch as a regular Error
  // subclass).  The cipher wraps that failure categorically as
  // a `locked` outcome so the journal can collapse it without
  // leaking the cipher internals.
  const cipher: NotesUndoJournalAesGcmCipher = Object.freeze({
    encrypt(plaintext: Uint8Array): Uint8Array {
      if (plaintext === undefined || plaintext === null) {
        throw cipherError("Notes undo journal: plaintext is required");
      }
      const nonce = randomBytes(AES_GCM_NONCE_BYTES);
      const aes = createCipheriv("aes-256-gcm", keyBuffer, nonce);
      const ciphertext = Buffer.concat([aes.update(plaintext), aes.final()]);
      const tag = aes.getAuthTag();
      const framed = Buffer.alloc(
        prefixBytes.length + AES_GCM_NONCE_BYTES + AES_GCM_AUTH_TAG_BYTES + ciphertext.length,
      );
      let offset = 0;
      prefixBytes.copy(framed, offset);
      offset += prefixBytes.length;
      nonce.copy(framed, offset);
      offset += AES_GCM_NONCE_BYTES;
      tag.copy(framed, offset);
      offset += AES_GCM_AUTH_TAG_BYTES;
      ciphertext.copy(framed, offset);
      return new Uint8Array(framed.buffer, framed.byteOffset, framed.byteLength);
    },
    decrypt(framed: Uint8Array): Uint8Array {
      if (framed === undefined || framed === null) {
        throw cipherError("Notes undo journal: framed payload is required");
      }
      const min = prefixBytes.length + AES_GCM_NONCE_BYTES + AES_GCM_AUTH_TAG_BYTES;
      const byteLength2 = (framed as { readonly byteLength?: number }).byteLength;
      const framedLength =
        typeof byteLength2 === "number"
          ? byteLength2
          : ((framed as unknown as { readonly length?: number }).length ?? -1);
      // Framing-shape failures (under-length / version mismatch /
      // malformed layout) collapse to a categorical `error`
      // outcome.  These are structurally invalid frames, not
      // auth-tag failures.
      if (framedLength < min) {
        throw cipherError("Notes undo journal: framed payload is malformed");
      }
      const view = Buffer.from(
        (framed as Uint8Array).buffer,
        (framed as Uint8Array).byteOffset,
        (framed as Uint8Array).byteLength,
      );
      const head = view.subarray(0, prefixBytes.length).toString("ascii");
      if (head !== prefix) {
        throw cipherError("Notes undo journal: framed payload version mismatch");
      }
      const nonce = view.subarray(prefixBytes.length, prefixBytes.length + AES_GCM_NONCE_BYTES);
      const tag = view.subarray(
        prefixBytes.length + AES_GCM_NONCE_BYTES,
        prefixBytes.length + AES_GCM_NONCE_BYTES + AES_GCM_AUTH_TAG_BYTES,
      );
      const ciphertext = view.subarray(
        prefixBytes.length + AES_GCM_NONCE_BYTES + AES_GCM_AUTH_TAG_BYTES,
      );
      const decipher = createDecipheriv("aes-256-gcm", keyBuffer, nonce);
      decipher.setAuthTag(tag);
      let plaintext: Buffer;
      try {
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        // Auth-tag failure / wrong key / tampered ciphertext —
        // collapse to a categorical `locked` outcome.  The
        // native error is swallowed; the cipher emits the fixed
        // redacted message so no upstream path leaks through.
        throw cipherError("Notes undo journal: cipher rejected the payload");
      }
      return new Uint8Array(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
    },
  });
  return cipher;
}

// ---------------------------------------------------------------------------
// Store seam — narrow interface, allowlisted, frozen.
// ---------------------------------------------------------------------------

/**
 * The injected persistence seam.  The journal accepts ONLY
 * `put` / `get` / `remove`; any other key on the store object
 * is rejected categorically.  No `delete`, no `clear`, no
 * generic `call`, no `transport`, no `sync`, no `send` — those
 * are structurally absent from this slice.
 */
export interface NotesUndoJournalStore {
  readonly put: (token: string, ciphertext: Uint8Array) => Promise<void>;
  readonly get: (token: string) => Promise<Uint8Array | undefined>;
  readonly remove: (token: string) => Promise<void>;
}

/**
 * Forbidden store keys.  Mirrors the read-runtime's
 * `FORBIDDEN_SOURCE_METHODS` so a hostile store cannot smuggle a
 * Notesnook-shaped, transport-shaped, sync-shaped, or generic
 * call surface into the journal.
 */
const FORBIDDEN_STORE_METHODS: readonly string[] = [
  "delete",
  "clear",
  "set",
  "patch",
  "call",
  "invoke",
  "transport",
  "sync",
  "send",
  "write",
  "writeEncrypted",
  "writeMulti",
  "add",
  "update",
  "removeMulti",
  "restore",
  "export",
  "import",
  "host",
  "connectSSE",
  "disconnectSSE",
  "init",
  "setup",
  "reset",
];

// ---------------------------------------------------------------------------
// Closed categorical result mirrors.
// ---------------------------------------------------------------------------

/** The fixed categorical outcomes the journal can return. */
export type NotesUndoJournalResult =
  | Readonly<{ kind: "stored"; token: string }>
  | Readonly<{
      kind: "preimage";
      handle: string;
      revision: string;
      title: string;
      content: string;
      metadata: Readonly<Record<string, string>>;
    }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "removed" }>
  | Readonly<{ kind: "invalid-input"; message: string }>
  | Readonly<{ kind: "locked"; message: string }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "error"; message: string }>;

// ---------------------------------------------------------------------------
// Internal — categorical error normalisation.
// ---------------------------------------------------------------------------

const JOURNAL_ERRORS = new WeakSet<object>();

function cipherError(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { configurable: true, value: undefined });
  Object.defineProperty(error, "__context__", { configurable: true, value: undefined });
  JOURNAL_ERRORS.add(error);
  return error;
}

function journalError(message: string): Error {
  return cipherError(message);
}

/** Public predicate.  Returns true iff `value` is an adapter-owned error. */
export function isNotesUndoJournalError(value: unknown): value is Error {
  return typeof value === "object" && value !== null && JOURNAL_ERRORS.has(value);
}

// ---------------------------------------------------------------------------
// The journal.
// ---------------------------------------------------------------------------

export interface NotesUndoJournalOptions {
  readonly store: NotesUndoJournalStore;
  readonly cipher: NotesUndoJournalAesGcmCipher;
  /**
   * Injected token factory.  The journal calls this factory to
   * mint opaque undo tokens; tests inject a deterministic
   * factory so the journal's token output is reproducible.  A
   * factory that returns a value outside the bounded opaque
   * grammar (or in the reserved `rev_` family) is rejected
   * categorically before encryption / store.
   */
  readonly tokenFactory: () => string;
}

/**
 * The bounded encrypted undo preimage journal.  Maps a bounded
 * `{handle, revision, title, content, metadata}` record onto an
 * AES-256-GCM-encrypted blob persisted under an opaque undo
 * token.  The journal is frozen so its methods cannot be
 * swapped at runtime.
 */
export class NotesUndoJournal {
  readonly #store: NotesUndoJournalStore;
  readonly #cipher: NotesUndoJournalAesGcmCipher;
  readonly #tokenFactory: () => string;

  constructor(options: NotesUndoJournalOptions) {
    this.#store = resolveStore(options.store);
    this.#cipher = resolveCipher(options.cipher);
    this.#tokenFactory = resolveTokenFactory(options.tokenFactory);
    Object.freeze(this);
  }

  /**
   * Record a bounded preimage.  The handle / revision / title /
   * content / metadata are validated against the closed surface;
   * oversized or malformed input is rejected BEFORE encryption /
   * store.  A token is minted by the injected factory and
   * validated against the bounded opaque grammar.  Ciphertext
   * (never plaintext) is written to the store.
   */
  async record(command: {
    readonly handle: string;
    readonly revision: string;
    readonly title: string;
    readonly content: string;
    readonly metadata: Readonly<Record<string, string>>;
  }): Promise<NotesUndoJournalResult> {
    const validated = validateRecordCommand(command);
    if (validated.kind === "error") return validated.error;

    // Mint the undo token via the injected factory and validate
    // the result BEFORE encryption / store.  A factory that emits
    // a value outside the bounded opaque grammar collapses to a
    // fixed categorical `invalid-input` outcome.
    let token: string;
    try {
      token = this.#tokenFactory();
    } catch {
      return invalidInputError();
    }
    if (typeof token !== "string") return invalidInputError();
    if (!isBoundedUndoToken(token)) return invalidInputError();

    // Preimage snapshot is copied and frozen BEFORE encryption so
    // the in-memory plaintext cannot be mutated by the caller
    // after `record` resolves.
    const snapshot = Object.freeze({
      handle: validated.handle,
      revision: validated.revision,
      title: validated.title,
      content: validated.content,
      metadata: Object.freeze({ ...validated.metadata }),
    });

    let framed: Uint8Array;
    try {
      const plaintext = encodePreimage(snapshot);
      framed = this.#cipher.encrypt(plaintext);
    } catch {
      return lockedError();
    }

    // Pre-check the store to keep the conflict categorical clean:
    // if the token already exists, refuse to overwrite — the
    // journal never mutates a slot it did not create itself.
    let existing: Uint8Array | undefined;
    try {
      existing = await this.#store.get(token);
    } catch {
      return runtimeError();
    }
    if (existing !== undefined) return conflictOutcome();

    try {
      await this.#store.put(token, framed);
    } catch {
      return runtimeError();
    }

    return freezeRecord({ kind: "stored", token });
  }

  /**
   * Retrieve a bounded preimage by opaque undo token.  Decrypts
   * the ciphertext, validates the closed preimage schema, and
   * returns a categorical `preimage` / `missing` /
   * `invalid-input` / `locked` / `error` outcome.  NEVER removes
   * store data.
   */
  async load(command: { readonly token: string }): Promise<NotesUndoJournalResult> {
    if (!isBoundedUndoTokenInput(command?.token)) return invalidInputError();
    const token = command.token;

    let framed: Uint8Array | undefined;
    try {
      framed = await this.#store.get(token);
    } catch {
      return runtimeError();
    }
    if (framed === undefined) return { kind: "missing" };

    return decryptAndValidate(framed, this.#cipher);
  }

  /**
   * Retrieve a bounded preimage AND remove the stored entry in
   * a single explicit call.  The remove step only happens after
   * a successful decrypt + schema validation; failed decrypt or
   * failed validation NEVER removes store data.
   */
  async consume(command: { readonly token: string }): Promise<NotesUndoJournalResult> {
    if (!isBoundedUndoTokenInput(command?.token)) return invalidInputError();
    const token = command.token;

    let framed: Uint8Array | undefined;
    try {
      framed = await this.#store.get(token);
    } catch {
      return runtimeError();
    }
    if (framed === undefined) return { kind: "missing" };

    const decrypted = decryptAndValidate(framed, this.#cipher);
    if (decrypted.kind !== "preimage") {
      // Failed decrypt / validation — the journal MUST NOT
      // mutate the store.
      return decrypted;
    }
    try {
      await this.#store.remove(token);
    } catch {
      return runtimeError();
    }
    return decrypted;
  }

  /**
   * Explicitly remove a stored entry.  This is the ONLY path
   * that deletes data from the store.
   */
  async remove(command: { readonly token: string }): Promise<NotesUndoJournalResult> {
    if (!isBoundedUndoTokenInput(command?.token)) return invalidInputError();
    const token = command.token;

    let existing: Uint8Array | undefined;
    try {
      existing = await this.#store.get(token);
    } catch {
      return runtimeError();
    }
    if (existing === undefined) return { kind: "missing" };

    try {
      await this.#store.remove(token);
    } catch {
      return runtimeError();
    }
    return { kind: "removed" };
  }
}

/** Factory helper. */
export function createNotesUndoJournal(options: NotesUndoJournalOptions): NotesUndoJournal {
  return new NotesUndoJournal(options);
}

// ---------------------------------------------------------------------------
// Closed preimage schema — the on-disk encrypted envelope.
// ---------------------------------------------------------------------------

interface PreimageSnapshot {
  readonly handle: string;
  readonly revision: string;
  readonly title: string;
  readonly content: string;
  readonly metadata: Readonly<Record<string, string>>;
}

interface PreimagePersisted {
  readonly handle: string;
  readonly revision: string;
  readonly title: string;
  readonly content: string;
  readonly metadata: Readonly<Record<string, string>>;
}

function encodePreimage(snapshot: PreimageSnapshot): Uint8Array {
  const persisted: PreimagePersisted = {
    handle: snapshot.handle,
    revision: snapshot.revision,
    title: snapshot.title,
    content: snapshot.content,
    metadata: { ...snapshot.metadata },
  };
  const json = JSON.stringify(persisted);
  return new TextEncoder().encode(json);
}

function decodePreimage(bytes: Uint8Array): PreimagePersisted | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === undefined || parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  return coercePreimage(parsed);
}

function coercePreimage(value: unknown): PreimagePersisted | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.handle !== "string") return undefined;
  if (typeof record.revision !== "string") return undefined;
  if (typeof record.title !== "string") return undefined;
  if (typeof record.content !== "string") return undefined;
  if (record.metadata === null || typeof record.metadata !== "object") {
    return undefined;
  }
  const handleOk = isBoundedOpaqueHandleValue(record.handle);
  const revisionOk = REVISION_TOKEN_PATTERN.test(record.revision);
  const titleOk = record.title.length > 0 && record.title.length <= NOTES_UNDO_TITLE_MAX_LENGTH;
  const contentOk = Buffer.byteLength(record.content, "utf8") <= NOTES_UNDO_CONTENT_MAX_BYTES;
  const metadataRaw = record.metadata as Record<string, unknown>;
  const metadataEntries: Record<string, string> = {};
  let metadataCount = 0;
  for (const key of Object.keys(metadataRaw)) {
    if (key.length === 0 || key.length > NOTES_UNDO_OPAQUE_MAX_LENGTH) {
      return undefined;
    }
    const entry = metadataRaw[key];
    if (typeof entry !== "string") return undefined;
    if (entry.length > NOTES_UNDO_METADATA_VALUE_MAX_LENGTH) return undefined;
    metadataEntries[key] = entry;
    metadataCount += 1;
    if (metadataCount > NOTES_UNDO_METADATA_ENTRY_MAX) return undefined;
  }
  if (!handleOk || !revisionOk || !titleOk || !contentOk) return undefined;
  return {
    handle: record.handle,
    revision: record.revision,
    title: record.title,
    content: record.content,
    metadata: Object.freeze(metadataEntries),
  };
}

// ---------------------------------------------------------------------------
// Internal — fixed categorical error factories.
// ---------------------------------------------------------------------------

function invalidInputError(): NotesUndoJournalResult {
  return { kind: "invalid-input", message: "Notes undo journal: invalid input" };
}

function runtimeError(): NotesUndoJournalResult {
  return { kind: "error", message: "Notes undo journal: runtime failure" };
}

function lockedError(): NotesUndoJournalResult {
  return { kind: "locked", message: "Notes undo journal: cipher rejected the payload" };
}

function conflictOutcome(): NotesUndoJournalResult {
  return { kind: "conflict" };
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

type RecordValidation =
  | Readonly<{
      kind: "ok";
      handle: string;
      revision: string;
      title: string;
      content: string;
      metadata: Readonly<Record<string, string>>;
    }>
  | Readonly<{ kind: "error"; error: NotesUndoJournalResult }>;

function validateRecordCommand(command: unknown): RecordValidation {
  if (command === undefined || command === null || typeof command !== "object") {
    return { kind: "error", error: invalidInputError() };
  }
  const record = command as Record<string, unknown>;
  if (typeof record.handle !== "string") {
    return { kind: "error", error: invalidInputError() };
  }
  if (!isBoundedOpaqueHandleValue(record.handle)) {
    return { kind: "error", error: invalidInputError() };
  }
  if (typeof record.revision !== "string") {
    return { kind: "error", error: invalidInputError() };
  }
  if (!REVISION_TOKEN_PATTERN.test(record.revision)) {
    return { kind: "error", error: invalidInputError() };
  }
  if (typeof record.title !== "string") {
    return { kind: "error", error: invalidInputError() };
  }
  if (record.title.length === 0 || record.title.length > NOTES_UNDO_TITLE_MAX_LENGTH) {
    return { kind: "error", error: invalidInputError() };
  }
  if (typeof record.content !== "string") {
    return { kind: "error", error: invalidInputError() };
  }
  if (Buffer.byteLength(record.content, "utf8") > NOTES_UNDO_CONTENT_MAX_BYTES) {
    return { kind: "error", error: invalidInputError() };
  }
  if (record.metadata === undefined || record.metadata === null) {
    return { kind: "error", error: invalidInputError() };
  }
  if (typeof record.metadata !== "object") {
    return { kind: "error", error: invalidInputError() };
  }
  const metadataRaw = record.metadata as Record<string, unknown>;
  const metadata: Record<string, string> = {};
  let count = 0;
  for (const key of Object.keys(metadataRaw)) {
    if (key.length === 0 || key.length > NOTES_UNDO_OPAQUE_MAX_LENGTH) {
      return { kind: "error", error: invalidInputError() };
    }
    const entry = metadataRaw[key];
    if (typeof entry !== "string") {
      return { kind: "error", error: invalidInputError() };
    }
    if (entry.length > NOTES_UNDO_METADATA_VALUE_MAX_LENGTH) {
      return { kind: "error", error: invalidInputError() };
    }
    metadata[key] = entry;
    count += 1;
    if (count > NOTES_UNDO_METADATA_ENTRY_MAX) {
      return { kind: "error", error: invalidInputError() };
    }
  }
  return {
    kind: "ok",
    handle: record.handle,
    revision: record.revision,
    title: record.title,
    content: record.content,
    metadata: Object.freeze(metadata),
  };
}

function isBoundedOpaqueHandleValue(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > NOTES_UNDO_OPAQUE_MAX_LENGTH) return false;
  if (RESERVED_OPAQUE_PREFIX.test(value)) return false;
  return OPAQUE_VALUE_PATTERN.test(value);
}

function isBoundedUndoToken(value: string): boolean {
  // The undo token uses the SAME bounded opaque grammar as a
  // handle.  This guarantees the token can never be confused
  // with a revision token (the reserved `rev_` family is
  // rejected by `OPAQUE_VALUE_PATTERN`).
  return isBoundedOpaqueHandleValue(value);
}

function isBoundedUndoTokenInput(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return isBoundedUndoToken(value);
}

// ---------------------------------------------------------------------------
// Decrypt + validate.
// ---------------------------------------------------------------------------

function decryptAndValidate(
  framed: Uint8Array,
  cipher: NotesUndoJournalAesGcmCipher,
): NotesUndoJournalResult {
  let plaintext: Uint8Array;
  try {
    plaintext = cipher.decrypt(framed);
  } catch (error) {
    // The cipher emits a journal-owned error whose message
    // distinguishes the failure mode.  Framing-shape failures
    // (under-length / version mismatch / malformed layout)
    // collapse to a categorical `error` outcome — the frame is
    // structurally invalid.  Auth-tag failures (wrong key /
    // tampered ciphertext) collapse to a categorical `locked`
    // outcome.
    if (isJournalOwnedError(error)) {
      const message = (error as Error).message;
      if (message.indexOf("framed payload") !== -1 || message.indexOf("version mismatch") !== -1) {
        return runtimeError();
      }
    }
    return lockedError();
  }
  const parsed = decodePreimage(plaintext);
  if (parsed === undefined) return runtimeError();
  return freezeRecord({
    kind: "preimage",
    handle: parsed.handle,
    revision: parsed.revision,
    title: parsed.title,
    content: parsed.content,
    metadata: parsed.metadata,
  });
}

function isJournalOwnedError(value: unknown): boolean {
  return typeof value === "object" && value !== null && JOURNAL_ERRORS.has(value);
}

// ---------------------------------------------------------------------------
// Dependency resolution — allowlisted + frozen.
// ---------------------------------------------------------------------------

function resolveStore(store: unknown): NotesUndoJournalStore {
  if (store === undefined || store === null || typeof store !== "object") {
    throw journalError("Notes undo journal: injected store must be an object");
  }
  const record = store as Record<string, unknown>;
  for (const key of ["put", "get", "remove"] as const) {
    if (typeof record[key] !== "function") {
      throw journalError(`Notes undo journal: injected store is missing ${key}()`);
    }
  }
  for (const name of FORBIDDEN_STORE_METHODS) {
    if (name in record) {
      throw journalError(`Notes undo journal: injected store exposes forbidden ${name}`);
    }
  }
  return record as unknown as NotesUndoJournalStore;
}

function resolveCipher(cipher: unknown): NotesUndoJournalAesGcmCipher {
  if (cipher === undefined || cipher === null || typeof cipher !== "object") {
    throw journalError("Notes undo journal: injected cipher must be an object");
  }
  const record = cipher as Record<string, unknown>;
  if (typeof record.encrypt !== "function") {
    throw journalError("Notes undo journal: injected cipher is missing encrypt()");
  }
  if (typeof record.decrypt !== "function") {
    throw journalError("Notes undo journal: injected cipher is missing decrypt()");
  }
  return record as unknown as NotesUndoJournalAesGcmCipher;
}

function resolveTokenFactory(factory: unknown): () => string {
  if (typeof factory !== "function") {
    throw journalError("Notes undo journal: injected token factory must be a function");
  }
  return factory as () => string;
}

// ---------------------------------------------------------------------------
// Freezing helper.
// ---------------------------------------------------------------------------

function freezeRecord<T extends object>(value: T): T {
  return Object.freeze(value);
}
