/**
 * Every byte limit the bridge enforces, in one place.
 *
 * What this file is: the definition site for every cap measured in bytes, and
 * the place a note-size change has to start. What it is not: a set of derived
 * values. These caps are independent conservative numbers today, not
 * consequences of one another, and the comments say which is which.
 *
 * Rules for this file:
 *
 *   - A byte cap is defined here and imported; it is not written as a literal
 *     anywhere else in `src/`. `tests/size-limits-registry.test.ts` enforces
 *     that by parsing the tree, not by matching spellings.
 *   - Sizes stated in prose live here only. A module that repeats the number
 *     in a comment has two homes for it and will drift.
 *   - Each entry says what it actually bounds and where. A comment that
 *     describes a guarantee the code does not provide is worse than no
 *     comment, because the next reader will trust it.
 *
 * Count-based caps (blocks per document, inlines per block, search hits) are
 * not here. They are structural, not byte budgets, and they do not move with
 * the note-size work.
 */

// ---------------------------------------------------------------------------
// Transport frames and RPC request fields.
// ---------------------------------------------------------------------------

/**
 * Largest operator-socket frame, including its four-byte length prefix.
 *
 * This bounds one contiguous allocation the daemon reads off a connection, so
 * it is a memory bound, not a content bound. It is smaller than what one large
 * note needs, which is why the size work replaces the one-frame-per-connection
 * path rather than only raising this number.
 */
export const OPERATOR_FRAME_BYTES = 65_536;

/**
 * Largest `notes.*` / `notesnook_*` RPC frame, including its four-byte prefix.
 *
 * Enforced as the total frame size on read and as the declared payload on
 * write, which makes the effective payload four bytes tighter than the
 * operator socket's. Equal to `OPERATOR_FRAME_BYTES` today; kept separate
 * because the two surfaces may move independently.
 */
export const RPC_FRAME_BYTES = 65_536;

/**
 * Largest response the daemon will build for one request.
 *
 * This is the read budget: it bounds the JSON a caller can pull out in one
 * reply, and therefore also bounds the projection a note is turned into.
 */
export const RPC_RESPONSE_BYTES = 65_536;

/**
 * Content cap for `notes.create` / `notes.update` / `notes.append` bodies.
 *
 * It must stay well below `RPC_FRAME_BYTES`, but it must also be large enough
 * to rewrite a note a caller can read. The worst case for text content is JSON
 * escaping of newlines, quotes and backslashes, which doubles the byte count,
 * so this cap leaves the request envelope comfortably inside one frame. A body
 * made entirely of C0 control characters encodes at six bytes each and is
 * refused by the frame preflight rather than truncated: the frame check, not
 * this cap, is the allocation bound.
 *
 * The arithmetic that makes this number safe: text content is the worst case
 * because JSON escaping of newlines, quotes and backslashes doubles it, so a
 * full body of this size costs at most twice this value on the wire. The rest
 * of the envelope — id, revision, title and notebook id plus sixteen tags — is
 * bounded at a little over 5 KiB by the schema. Together that has to fit one
 * frame: `2 x RPC_CONTENT_BYTES + envelope <= RPC_FRAME_BYTES`, which the
 * registry test asserts, so raising this value without raising the frame fails
 * a test rather than producing notes that can never be written.
 */
export const RPC_CONTENT_BYTES = 27_000;

/**
 * Largest search query the RPC surface accepts.
 *
 * Also applied as a generic byte cap to `path`, `notebookPath` and diagnostic
 * path values, so this one entry serves two purposes and cannot move for one
 * without the other. Splitting them is a wire change, not a rename.
 */
export const RPC_QUERY_BYTES = 512;

/** Largest note title on the RPC surface, in bytes. */
export const RPC_TITLE_BYTES = 256;

/** Largest id, revision or handle on the RPC surface, in bytes. */
export const RPC_IDENTIFIER_BYTES = 256;

/**
 * Largest MCP stdio message the bounded JSON-RPC decoder accepts.
 *
 * Scoped honestly: the decoder it bounds is the diagnostics and test path. The
 * production MCP transport is the SDK's `StdioServerTransport`, whose own
 * message bound is outside this repository and is not controlled here.
 *
 * One entry bounds both a buffer holding N newline-delimited messages and a
 * single message within it, because the decoder applies it to each.
 */
export const MCP_MESSAGE_BYTES = 65_536;

/**
 * Largest search query the MCP layer will forward.
 *
 * Mirrors `RPC_QUERY_BYTES` so the MCP layer cannot accept a query the daemon
 * would reject; kept separate because the two are enforced in different
 * processes.
 */
export const MCP_QUERY_BYTES = 512;

// ---------------------------------------------------------------------------
// Stored content and documents.
// ---------------------------------------------------------------------------

/**
 * Largest stored content the write path accepts.
 *
 * Applied to what a caller sends — an inbound Markdown body or native
 * envelope — not to what the path produces. The produced row is bounded by
 * `NATIVE_DOCUMENT_BYTES`.
 */
export const STORED_CONTENT_BYTES = 262_144;

/**
 * Largest stored content row the read path will decode.
 *
 * Equal to `STORED_CONTENT_BYTES` so that anything the bridge writes it can
 * read back. It is a refusal threshold, not an allowance: a larger row is
 * refused categorically, it is not partially read.
 */
export const STORED_CONTENT_READ_BYTES = 262_144;

/**
 * Largest native (`tiptap`) document envelope the bridge will accept or emit.
 *
 * Bounds the stored envelope on the way in and the serialized document on the
 * way out. The decoder's own input-byte bound is derived from this value, so
 * that derivation moves with it.
 */
export const NATIVE_DOCUMENT_BYTES = 262_144;

/**
 * Largest payload a single conflict resolution may carry.
 *
 * The payload holds identifiers, digests and titles only — the note body is
 * reduced to a digest before it is recorded — so this cap scales with titles
 * and ids, not with note size, and a large note does not bind it.
 */
export const CONFLICT_RESOLVE_PAYLOAD_BYTES = 65_536;

/** Largest fragment a single `notes.append` may carry. */
export const FRAGMENT_BYTES = 32_768;

/**
 * Largest single block in a decoded document.
 *
 * A per-block bound. The whole-document byte budget is not this value and not
 * `NATIVE_DOCUMENT_BYTES`: the validator's whole-document check multiplies the
 * block count by this cap, so raising this one raises that product too.
 */
export const DOCUMENT_BLOCK_BYTES = 65_536;

/** Largest single inline run in a decoded document. */
export const DOCUMENT_INLINE_BYTES = 8_192;

/** Largest opaque-block sentinel the decoder will carry. */
export const DOCUMENT_OPAQUE_SENTINEL_BYTES = 128;

/** Largest derived readable text a single preserved block may carry. */
export const DOCUMENT_OPAQUE_TEXT_BYTES = 8_192;

/**
 * Total derived readable text a decoded document may carry across blocks.
 *
 * Decoder-only: the validator does not enforce it, because a document read
 * from a client legitimately carries text the decoder minted under this
 * budget. The per-block cap above is the one the schema checks.
 */
export const DOCUMENT_OPAQUE_TEXT_TOTAL_BYTES = 16_384;

/** Largest URL on a structured reference node (image, attachment, embed). */
export const DOCUMENT_REFERENCE_URL_BYTES = 2_048;

/** Largest label on a structured reference node. */
export const DOCUMENT_REFERENCE_LABEL_BYTES = 256;

/**
 * Largest stored HTML the read-only Markdown projection will tokenise.
 *
 * Its input is any stored HTML the read path may meet, not only the HTML the
 * strict decoder rejected: the discovery and write-runner paths project
 * stored content directly, and only the read path reaches it as a fallback.
 */
export const PROJECTION_HTML_BYTES = 262_144;

// ---------------------------------------------------------------------------
// Operator CLI and journals.
// ---------------------------------------------------------------------------

/** Maximum Markdown body `nookctl notes get` will emit. */
export const NOTES_GET_MARKDOWN_BYTES = 262_144;

/**
 * Maximum search query text the operator CLI will read before refusing.
 *
 * Not the query contract: `parseNotesSearchQuery` refuses anything over
 * `RPC_QUERY_BYTES`, because a query the daemon rejects takes the connection
 * down with it. This bound only decides how much the reader consumes first.
 */
export const NOTES_QUERY_BYTES = 4 * 1024 * 1024;

/** Largest Markdown a single note document may be parsed from. */
export const DOCUMENT_MARKDOWN_BYTES = 4 * 1024 * 1024;

/** Largest Markdown the operator editor will accept for one edit. */
export const EDITOR_MARKDOWN_BYTES = 4 * 1024 * 1024;

/** Largest search query text the operator read runtime will read. */
export const NOTES_READ_QUERY_BYTES = 4 * 1024 * 1024;

/** Largest content a single operator undo preimage may carry. */
export const NOTES_UNDO_CONTENT_BYTES = 4 * 1024 * 1024;

/**
 * Largest single record in the daemon operation store.
 *
 * The store holds small JSON metadata and a trusted-editor content snapshot
 * for an in-flight create or edit; it does not hold a stored-form preimage.
 * This value is why an operator edit whose content approaches this size is
 * refused, independently of the content caps.
 */
export const UNDO_RECORD_BYTES = 65_536;

/**
 * Default total the daemon operation store retains across all records.
 *
 * A default, not an enforced ceiling: the store validates that a caller's
 * value is positive but does not bound it from above. Only `UNDO_RECORD_BYTES`
 * has a hard ceiling in the validation path.
 */
export const UNDO_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * Frozen view of the registry, for tests and for callers that need to assert
 * on the whole set at once.
 */
export const SIZE_LIMITS = Object.freeze({
  OPERATOR_FRAME_BYTES,
  RPC_FRAME_BYTES,
  RPC_RESPONSE_BYTES,
  RPC_CONTENT_BYTES,
  RPC_QUERY_BYTES,
  RPC_TITLE_BYTES,
  RPC_IDENTIFIER_BYTES,
  MCP_MESSAGE_BYTES,
  MCP_QUERY_BYTES,
  STORED_CONTENT_BYTES,
  STORED_CONTENT_READ_BYTES,
  NATIVE_DOCUMENT_BYTES,
  FRAGMENT_BYTES,
  CONFLICT_RESOLVE_PAYLOAD_BYTES,
  DOCUMENT_BLOCK_BYTES,
  DOCUMENT_INLINE_BYTES,
  DOCUMENT_OPAQUE_SENTINEL_BYTES,
  DOCUMENT_OPAQUE_TEXT_BYTES,
  DOCUMENT_OPAQUE_TEXT_TOTAL_BYTES,
  DOCUMENT_REFERENCE_URL_BYTES,
  DOCUMENT_REFERENCE_LABEL_BYTES,
  PROJECTION_HTML_BYTES,
  NOTES_GET_MARKDOWN_BYTES,
  NOTES_QUERY_BYTES,
  DOCUMENT_MARKDOWN_BYTES,
  EDITOR_MARKDOWN_BYTES,
  NOTES_READ_QUERY_BYTES,
  NOTES_UNDO_CONTENT_BYTES,
  UNDO_RECORD_BYTES,
  UNDO_TOTAL_BYTES,
} as const);
