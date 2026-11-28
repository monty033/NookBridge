/**
 * Every named bound the bridge enforces, in one place — including the absolute
 * deadline for receiving a declared raw body.
 *
 * What this file is: the named definition site for the bounds the bridge
 * enforces on note content and on the wire, and the place a note-size change
 * has to start. What it is not: a complete inventory of every number compared
 * against a byte length in `src/`. Inline limits inside one function — a title
 * length check, a per-field ceiling — still exist and are not all listed here;
 * they are named below when they matter for note size.
 *
 * Most entries are independent conservative numbers, not consequences of one
 * another. Four are derived, in two different ways. `PROJECTION_MARKDOWN_BYTES`
 * is defined as `RPC_RESPONSE_BYTES`, permanently: a read without `accept` is
 * bounded by the frame it has to fit, so the two are the same number by
 * definition. `ADMISSION_ROW_BYTES` names a job a neighbour currently does, so
 * that job can move without moving the bound that happens to share its value;
 * `WIRE_BODY_BYTES` is a multiple of `ADMISSION_ROW_BYTES` so wire sizing can
 * never outrun admission; `PROJECTION_HTML_BYTES` follows
 * `STORED_CONTENT_READ_BYTES` because both measure the same stored string, so
 * the fallback's cap cannot bind before the read threshold. Derived entries say
 * which derivation applies. One entry, `BODY_RECEIVE_TIMEOUT_MS`, is a deadline
 * rather than a byte cap, and lives here because it bounds the same exchange.
 *
 * Rules for this file:
 *
 *   - A *named* byte cap is defined here and imported; it is not written as a
 *     literal or derived from another table anywhere else in `src/`. The
 *     registry test enforces that for module constants and for the published
 *     limit tables by parsing the tree; it does not claim to catch every inline
 *     comparison, which is why the first paragraph says so.
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
 * Largest response the daemon will build for one request, and therefore the
 * frame every client of it has to accept — the MCP client bounds its own
 * response frame from this value.
 *
 * This is the single-frame read budget: it bounds the JSON a caller can pull
 * out in one reply frame. A note's projection is bounded through
 * `PROJECTION_MARKDOWN_BYTES`, which is this value. A read that carries
 * `accept` may send Markdown it can carry as a declared body under
 * `min(accept.bodyBytes, WIRE_BODY_BYTES)` instead, with only its header in
 * this frame; Markdown a body cannot carry is still bounded and answered by
 * this frame, exactly as the read without `accept` is.
 */
export const RPC_RESPONSE_BYTES = 65_536;

/**
 * Largest Markdown projection produced for a note read without `accept` — the
 * projection a single-frame reply carries inline.
 *
 * Derived, and equal to `RPC_RESPONSE_BYTES` by definition: a read that carries
 * no `accept` is bounded by the frame it has to fit. It is not a value that
 * could drift from the frame, and a body-framed read does not raise it — that
 * read is bounded by `min(accept.bodyBytes, WIRE_BODY_BYTES)` instead. This
 * value still applies to Markdown a declared body cannot carry: a lone
 * surrogate, or a disallowed control character. Both go back to the bound the
 * same read without `accept` would get, answered inline or refused by the
 * serializer exactly as that read is.
 */
export const PROJECTION_MARKDOWN_BYTES = RPC_RESPONSE_BYTES;

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

/**
 * Largest note title on the RPC surface, in bytes.
 *
 * Also the bound the MCP layer applies to the same title, on both the server
 * and the client — the client has to accept what the daemon may send. It is
 * not the bound on a title inside a note's own body: that is
 * `DOCUMENT_TASK_TITLE_BYTES`.
 */
export const RPC_TITLE_BYTES = 256;

/** Largest title on a task-list block inside a note body, in bytes. */
export const DOCUMENT_TASK_TITLE_BYTES = 256;

/**
 * Largest id or handle on the RPC surface, in bytes.
 *
 * Not the revision bound: a revision token is shape-checked on this surface,
 * and where a length is applied it is `RPC_REVISION_BYTES`.
 */
export const RPC_IDENTIFIER_BYTES = 256;

/** Largest revision token the RPC surface length-checks, in bytes. */
export const RPC_REVISION_BYTES = 64;

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
 * envelope — not to what the path produces. The produced row is bounded
 * separately, and differently by codec: the native codec is bounded by
 * `NATIVE_DOCUMENT_BYTES`, the Markdown codec by
 * `MARKDOWN_CODEC_STORED_BYTES`.
 */
export const STORED_CONTENT_BYTES = 262_144;

/**
 * Largest stored content row the read path will decode.
 *
 * Equal to the inbound `STORED_CONTENT_BYTES`, because the read threshold must
 * not be tighter than what the native write path accepts.
 *
 * This is the row the read path will accept, and the row the write path is
 * allowed to produce. The Markdown codec's own bound (`MARKDOWN_CODEC_STORED_BYTES`)
 * is larger, because it is an allocation guard rather than an admission rule, so
 * the adapter measures the row it produced — after encoding, on create, update
 * and the composed result of an append — and refuses it as `too_large` before
 * any mutator runs.
 *
 * Where a write is bounded somewhere else instead, that bound is never looser
 * than this one, and the refusal carries that layer's own code:
 *
 *   - the native stored envelope is caller-supplied and written verbatim; the
 *     contract refuses one above this value as `invalid_input` before the
 *     adapter sees it, and the adapter's own check catches an empty one;
 *   - a native document is bounded by `NATIVE_DOCUMENT_BYTES` (equal to this
 *     value) inside the serializer; its `document_too_large` reason is reported
 *     as `too_large`, its other refusals as `unsupported_content`;
 *   - conflict keep-both refuses when either side's text is empty or exceeds the
 *     Stage 4 content cap (equal to this value), as `unsupported_content` — it
 *     refuses the whole conflict rather than diagnosing one row.
 *
 * An empty row is refused on every channel except compensation, because the
 * reader rejects it and this threshold only describes the upper end. The one
 * write that is neither measured nor refused is compensation, which restores the
 * pre-mutation row verbatim rather than composing anything new.
 *
 * It is a refusal threshold, not an allowance: a larger row is refused
 * categorically, it is not partially read.
 */
export const STORED_CONTENT_READ_BYTES = 262_144;

/**
 * Largest produced stored-content row admitted by the write path.
 *
 * This is the wire-sizing name for the bound `STORED_CONTENT_READ_BYTES`
 * already states — the two are the same number deliberately, and that entry is
 * where the admission rule itself lives. It follows the read threshold today;
 * when the stored-row limit changes, this entry becomes `MAX_STORED_JSON_BYTES`
 * so wire sizing continues to follow admission rather than moving ahead of it.
 */
export const ADMISSION_ROW_BYTES = STORED_CONTENT_READ_BYTES;

/**
 * Largest declared raw body carried alongside an RPC header frame.
 *
 * Derived from `ADMISSION_ROW_BYTES`, though the factor is a budget choice
 * rather than a derived invariant: the multiple keeps wire sizing from
 * outrunning what admission accepts, and the 2 is chosen so a writable row's
 * projection and escaping have room. No test establishes that every stored
 * shape projects within it, so do not read the allowance as a proven bound.
 * Nothing depends on it holding — a body over it is refused, never truncated.
 *
 * It governs both directions. A request body is refused above it. For a note
 * read that carries `accept`, Markdown the body path can carry is bounded by
 * `min(accept.bodyBytes, WIRE_BODY_BYTES)` — refused `oversize` above that,
 * never truncated — and then travels as a declared response body of at most
 * this many bytes. Markdown a body cannot carry, and every read without
 * `accept`, is bounded by `PROJECTION_MARKDOWN_BYTES`.
 */
export const WIRE_BODY_BYTES = 2 * ADMISSION_ROW_BYTES;

/**
 * Absolute deadline for receiving a declared raw body, in milliseconds.
 *
 * This is not an idle-between-chunks timeout: a peer cannot extend a body
 * exchange indefinitely by continuing to send small chunks.
 *
 * The daemon exposes this as the default `bodyReceiveTimeoutMs` service abuse
 * bound and enforces it from body admission until all declared bytes arrive.
 * The same deadline bounds sending a declared response body: from the header
 * write until the last body byte has been handed to the socket.
 */
export const BODY_RECEIVE_TIMEOUT_MS = 30_000;

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

/**
 * Largest stored payload the Markdown write codec will emit.
 *
 * This is an allocation guard, not an admission rule. It exists so a runaway
 * encode cannot allocate without bound; it is not the size a note is allowed to
 * be. The codec must be able to produce a row bigger than the read threshold,
 * because the read threshold may move (and does, with the server limit) while
 * the codec's own guard stays put — and an injected codec need not honour this
 * value at all.
 *
 * What a note is allowed to be is decided after encoding, in the write adapter,
 * against `STORED_CONTENT_READ_BYTES`. That check is deliberately downstream of
 * the codec so it binds whatever codec is installed.
 */
export const MARKDOWN_CODEC_STORED_BYTES = 1_048_576;

/** Largest stored title, in bytes, for a title bounded at 256 characters. */
export const STORED_TITLE_BYTES = 1_024;

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
 *
 * Derived from `STORED_CONTENT_READ_BYTES` rather than repeating the literal:
 * both measure the same stored `data` string, so equal values mean this cap
 * cannot bind before the read threshold. As an independent literal it would
 * start refusing HTML that passes the threshold the moment that threshold rises.
 */
export const PROJECTION_HTML_BYTES = STORED_CONTENT_READ_BYTES;

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
  PROJECTION_MARKDOWN_BYTES,
  RPC_CONTENT_BYTES,
  RPC_QUERY_BYTES,
  RPC_TITLE_BYTES,
  DOCUMENT_TASK_TITLE_BYTES,
  RPC_IDENTIFIER_BYTES,
  RPC_REVISION_BYTES,
  MCP_MESSAGE_BYTES,
  MCP_QUERY_BYTES,
  STORED_CONTENT_BYTES,
  STORED_CONTENT_READ_BYTES,
  ADMISSION_ROW_BYTES,
  WIRE_BODY_BYTES,
  BODY_RECEIVE_TIMEOUT_MS,
  NATIVE_DOCUMENT_BYTES,
  STORED_TITLE_BYTES,
  FRAGMENT_BYTES,
  MARKDOWN_CODEC_STORED_BYTES,
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
