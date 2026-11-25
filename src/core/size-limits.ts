/**
 * Every byte limit the bridge enforces, in one place.
 *
 * These are currently independent conservative values, not derivations of one
 * another: the wire frame is 64 KiB, the write content cap is deliberately
 * below it, and the parser caps are separate allocation bounds. What they have
 * in common is that changing the note-size story (issue #327) has to change
 * them together — a raised frame with an unchanged content cap fixes nothing,
 * and that is exactly the mistake this module exists to make impossible to
 * make silently.
 *
 * Rules for this file:
 *
 *   - A limit is defined here and imported; it is never written as a literal
 *     anywhere else in `src/`. `tests/size-limits-registry.test.ts` enforces
 *     that by scanning the tree.
 *   - Each value carries the reason it has that number. A limit with no
 *     stated derivation is a limit nobody can safely raise.
 *   - Numerically equal limits stay separate entries unless they are enforced
 *     at the same place for the same reason. Two 64 KiB caps that fail for
 *     different reasons must be able to move independently.
 */

/**
 * Largest operator-socket frame, including its four-byte length prefix.
 *
 * This bounds one contiguous allocation the daemon reads off a connection, so
 * it is a memory bound, not a content bound. It is also smaller than what a
 * single large note needs, which is why the size work in #327 replaces the
 * one-frame-per-connection path rather than only raising this number.
 */
export const OPERATOR_FRAME_BYTES = 65_536;

/**
 * Largest `notes.*` / `notesnook_*` RPC frame.
 *
 * Equal to the operator frame today because both carry the same JSON
 * envelope, but kept separate: the RPC surface may move on its own once the
 * body is streamed outside the frame.
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
 * Content cap for `notes.create` / `notes.update` / `notes.append`.
 *
 * It must stay well below `RPC_FRAME_BYTES`, but it must also be large enough
 * to rewrite a note a caller can read. The read budget is 64 KiB, so the
 * earlier 4,096 left ordinary notes readable and permanently unrewritable.
 *
 * The worst case for text content is JSON escaping of newlines, quotes and
 * backslashes, which doubles the byte count: 27,000 x 2 = 54,000. The
 * remaining request envelope is bounded by the schema — id, revision, title
 * and notebook id at 256 bytes each plus sixteen tags at 256 bytes — so it
 * stays under 5,200 bytes and every shape stays under the frame. A body made
 * entirely of C0 control characters encodes at six bytes each and is refused
 * by the frame preflight rather than truncated: the frame check, not this
 * cap, is the allocation bound.
 */
export const RPC_CONTENT_BYTES = 27_000;

/**
 * Largest MCP stdio message accepted from a client.
 *
 * Separate from the daemon's frames because it is a different transport with
 * a different peer; it happens to share the number today.
 */
export const MCP_MESSAGE_BYTES = 65_536;

/**
 * Largest stored content row the write path will produce.
 *
 * Notesnook stores a note's body as a `content` row whose `data` field is the
 * stored form. This is the ceiling on that value.
 */
export const STORED_CONTENT_BYTES = 262_144;

/**
 * Largest stored content row the read path will decode.
 *
 * Equal to the write cap so that anything the bridge writes it can read back;
 * kept separate because the read side also has to cope with rows written by
 * other clients, and that allowance may diverge.
 */
export const STORED_CONTENT_READ_BYTES = 262_144;

/**
 * Largest native (`tiptap`) document the decoder will accept.
 *
 * Bounds the bytes handed to the decoder before it builds a document tree.
 */
export const NATIVE_DOCUMENT_BYTES = 262_144;

/**
 * Largest single block in a decoded document.
 *
 * A structural bound, not a total: one block may not exceed it even when the
 * whole document is within `NATIVE_DOCUMENT_BYTES`.
 */
export const DOCUMENT_BLOCK_BYTES = 65_536;

/**
 * Largest stored HTML the read-only Markdown projection will tokenise.
 *
 * The projection is the fallback used when the strict decoder refuses, so its
 * input is exactly the malformed or exotic HTML that decoder rejected.
 */
export const PROJECTION_HTML_BYTES = 262_144;

/**
 * Largest Markdown `nookctl notes view` will print in one go.
 *
 * The operator view is not paginated, so this is a terminal-safety bound.
 */
export const NOTES_VIEW_MARKDOWN_BYTES = 262_144;

/**
 * Largest single record in the operator undo journal.
 *
 * An undo record holds the note's stored-form preimage. This value is why
 * operator edits over roughly 64 KiB fail today, independently of the wire
 * and content caps (issue tracked separately).
 */
export const UNDO_RECORD_BYTES = 65_536;

/** Largest total the undo journal will retain across all records. */
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
  MCP_MESSAGE_BYTES,
  STORED_CONTENT_BYTES,
  STORED_CONTENT_READ_BYTES,
  NATIVE_DOCUMENT_BYTES,
  DOCUMENT_BLOCK_BYTES,
  PROJECTION_HTML_BYTES,
  NOTES_VIEW_MARKDOWN_BYTES,
  UNDO_RECORD_BYTES,
  UNDO_TOTAL_BYTES,
} as const);
