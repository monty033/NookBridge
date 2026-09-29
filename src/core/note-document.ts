/**
 * T01 — canonical native-preserving `NoteDocumentV1` AST and validation.
 *
 * Scope (per `.hermes/plans/2026-09-18-notes-features-complete-v3.md`
 * T00 + T01):
 *   - The versioned, internal document AST used by both the editor
 *     interchange grammar (T02) and the native decoder/serializer (T03).
 *   - Per-list intent (T00 D6): a single document may carry both
 *     `simple-checklist` and `task-list` blocks; legacy `listKind`
 *     remains the default at the boundary.
 *   - Block-capable list items with nested task children.
 *   - Closed inline-mark vocabulary (bold / italic / underline / strike /
 *     code / link).
 *   - Opaque-reference sentinel TYPES (T00 D7) — short, versioned,
 *     revision-bound; NO opaque payload bytes are admitted on the editor
 *     document (T02/T03 own payload handling).
 *   - Strict depth / item-count / byte budgets.
 *   - Hostile-object rejection.
 *   - Deterministic structural validation.
 *   - Closed categorical error vocabulary (no input bytes are echoed).
 *
 * Deliberately NOT in this file:
 *   - Markdown / native serialization (T02 / T03 own those slices).
 *   - Any Notesnook handle, token, or revision derivation — the AST is
 *     pure data.
 *   - The interactive editor surface (T08).
 *
 * Why this file is its own module:
 *   - T01 only needs the AST type system + the strict structural
 *     validator.  Keeping it isolated from the parser/serializer means
 *     every T02/T03 PR lands against a frozen validator contract, and
 *     the failing tests in `tests/stage-9-note-document-ast.test.ts`
 *     document exactly which behaviours must continue to hold across
 *     later integration work.
 */

import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { types as utilTypes } from "node:util";

import {
  DEFAULT_NOTESNOOK_LIST_KIND,
  NOTESNOOK_LIST_KINDS,
  normaliseNotesnookListKind,
  type NotesnookListKind,
} from "./notesnook-write-list-intent.js";

// ---------------------------------------------------------------------------
// Version + closed error vocabulary.
// ---------------------------------------------------------------------------

/** Frozen document-format version.  T01 owns `1` only. */
export const NOTE_DOCUMENT_VERSION = 1 as const;

/**
 * Closed categorical failure codes for the T01 validator.
 *
 * Every validator path throws a `NoteDocumentError` whose `code` is one
 * of these literals.  The vocabulary is published here so downstream
 * callers (the T02 parser, the T03 serializer, the T04 transport, and
 * the acceptance tests) map onto a single source of truth.
 */
export type NoteDocumentErrorCode =
  | "invalid_shape"
  | "oversize_document"
  | "oversize_block"
  | "oversize_inline"
  | "oversize_sentinel"
  | "depth_exceeded"
  | "unsupported_node"
  | "unsupported_list_kind"
  | "unsupported_mark"
  | "unsupported_callout_variant"
  | "opaque_payload_forbidden"
  | "malformed_link"
  | "table_column_mismatch"
  | "invalid_reference_url";

/**
 * Categorical, chain-free T01 validator error.
 *
 * Recognised by object identity only (see {@link isNoteDocumentError}),
 * matching the Stage 4 write-contract convention.  `cause` and
 * `__context__` are cleared so a caller-supplied options bag cannot
 * smuggle upstream payloads (paths, tokens, note bodies) across the
 * boundary.
 *
 * Messages are derived only from the categorical code; no caller
 * argument is interpolated, so an attacker cannot smuggle a canary
 * through a rejected field value.
 *
 * IMPORTANT: this is a custom `Error` subclass.  Per the
 * `references/custom-error-subclass-pitfalls.md` note in the
 * `typescript-vitest-tdd` skill, we must NOT call `Object.freeze` on the
 * instance — V8 installs internal properties (`stackStr` and friends)
 * on first capture of the stack trace and freezing the instance throws.
 * We pin `Object.setPrototypeOf(this, NoteDocumentError.prototype)` and
 * rely on the `code` field being declared `readonly` + `writable: false`
 * for immutability of the discriminator.
 */
export class NoteDocumentError extends Error {
  public readonly code!: NoteDocumentErrorCode;

  constructor(code: NoteDocumentErrorCode) {
    super(NOTE_DOCUMENT_ERROR_MESSAGES[code]);
    Object.setPrototypeOf(this, NoteDocumentError.prototype);
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: code,
    });
    // Strip caller-controlled data: a `cause` is never read by callers,
    // and clearing it stops prototypes / option bags from smuggling
    // secrets through the rejection path.
    Object.defineProperty(this, "cause", { configurable: true, value: undefined });
    Object.defineProperty(this, "__context__", { configurable: true, value: undefined });
    Object.defineProperty(this, "name", {
      configurable: true,
      value: "NoteDocumentError",
    });
  }
}

/**
 * Fixed, categorical message table for {@link NoteDocumentError}.  Every
 * message is a literal; no caller argument is interpolated.
 */
const NOTE_DOCUMENT_ERROR_MESSAGES: { readonly [K in NoteDocumentErrorCode]: string } =
  Object.freeze({
    invalid_shape: "NoteDocumentV1: invalid shape",
    oversize_document: "NoteDocumentV1: document exceeds block cap",
    oversize_block: "NoteDocumentV1: block exceeds byte cap",
    oversize_inline: "NoteDocumentV1: inline exceeds byte cap",
    oversize_sentinel: "NoteDocumentV1: opaque sentinel exceeds byte cap",
    depth_exceeded: "NoteDocumentV1: structural depth cap exceeded",
    unsupported_node: "NoteDocumentV1: unsupported node discriminator",
    unsupported_list_kind: "NoteDocumentV1: list kind outside the closed set",
    unsupported_mark: "NoteDocumentV1: inline mark outside the closed set",
    unsupported_callout_variant: "NoteDocumentV1: callout variant outside the closed set",
    opaque_payload_forbidden: "NoteDocumentV1: opaque payload forbidden on the editor document",
    malformed_link: "NoteDocumentV1: malformed link mark",
    table_column_mismatch: "NoteDocumentV1: table row column count mismatch",
    invalid_reference_url: "NoteDocumentV1: reference URL rejected by URL policy",
  });

/** Identity predicate for {@link NoteDocumentError}. */
export function isNoteDocumentError(value: unknown): value is NoteDocumentError {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === NoteDocumentError.prototype
  );
}

function fail(code: NoteDocumentErrorCode): never {
  throw new NoteDocumentError(code);
}

// ---------------------------------------------------------------------------
// Per-list intent vocabulary (T00 D6 — re-uses the Stage 4 closed set).
// ---------------------------------------------------------------------------

/** Per-list intent.  Re-exports the Stage 4 closed vocabulary verbatim. */
export type NoteListKind = NotesnookListKind;

/** Closed per-list intent set, frozen in display order. */
export const NOTE_DOCUMENT_LIST_KINDS: ReadonlyArray<NoteListKind> = Object.freeze([
  ...NOTESNOOK_LIST_KINDS,
]);

/** Default per-list intent for legacy callers and omitted `kind` fields. */
export const DEFAULT_NOTE_DOCUMENT_LIST_KIND: NoteListKind = DEFAULT_NOTESNOOK_LIST_KIND;

/**
 * Normalise a per-list intent selector.  `undefined` resolves to the
 * legacy default; any non-`undefined` value outside the closed set is
 * a categorical refusal surfaced as a {@link NoteDocumentError} so the
 * T01 error vocabulary is uniform across the validator entry points.
 */
export function normaliseNoteDocumentListKind(value: unknown): NoteListKind {
  try {
    return normaliseNotesnookListKind(value);
  } catch {
    fail("unsupported_list_kind");
  }
}

// ---------------------------------------------------------------------------
// Bounded resource limits (frozen, published).
// ---------------------------------------------------------------------------

/**
 * Published T01 resource caps.  Every limit is named, integer-valued,
 * and frozen — downstream code may treat the constant as a contract.
 *
 * - `maxDocumentBytes` — UTF-8 byte cap for the full serialized
 *   document (conservative; tighter than the editor Markdown budget to
 *   keep the structural validator responsive on hostile input);
 * - `maxBlocks` — top-level block cap;
 * - `maxDepth` — structural nesting depth cap (lists inside lists,
 *   blockquote inside list, etc.);
 * - `maxBlockBytes` — UTF-8 byte cap for any single block's serialized
 *   representation;
 * - `maxInlinesPerBlock` — inline count cap per block;
 * - `maxInlineBytes` — UTF-8 byte cap for a single inline text;
 * - `maxListItemsPerList` — items-per-list cap;
 * - `maxTaskChildren` — task-item children cap (recursion guard);
 * - `maxOpaqueSentinelBytes` — UTF-8 byte cap for an opaque sentinel
 *   token (T00 D7: short, versioned, no body/title/id/token bytes);
 * - `maxOpaquePayloadBytes` — strictly zero on the editor document
 *   (T02/T03 own payload handling).
 */
export const MAX_NOTE_DOCUMENT_BLOCKS = 4096;
export const MAX_NOTE_DOCUMENT_BLOCK_BYTES = 65_536;
export const MAX_NOTE_DOCUMENT_INLINE_BYTES = 8192;
export const MAX_NOTE_DOCUMENT_INLINES_PER_BLOCK = 1024;
export const MAX_NOTE_DOCUMENT_LIST_ITEMS_PER_LIST = 2048;
export const MAX_NOTE_DOCUMENT_TASK_CHILDREN = 1024;
export const MAX_NOTE_DOCUMENT_DEPTH = 16;
export const MAX_NOTE_DOCUMENT_OPAQUE_SENTINEL_BYTES = 128;
export const MAX_NOTE_DOCUMENT_OPAQUE_PAYLOAD_BYTES = 0;
export const MAX_NOTE_DOCUMENT_TEXT_BYTES = MAX_NOTE_DOCUMENT_INLINE_BYTES;

/**
 * Byte caps for the structured reference nodes (`image`, `attachment`,
 * `embed`).  These are deliberately small compared to
 * `MAX_NOTE_DOCUMENT_INLINE_BYTES`: a reference URL/label is metadata,
 * never a body, so a generous cap only invites abuse (URL-smuggled
 * payloads, oversized data: URLs disguised as long strings, etc.).
 */
export const MAX_NOTE_DOCUMENT_REFERENCE_URL_BYTES = 2048;
export const MAX_NOTE_DOCUMENT_REFERENCE_LABEL_BYTES = 256;

// ---------------------------------------------------------------------------
// AST type definitions.
// ---------------------------------------------------------------------------

/**
 * Closed inline-mark vocabulary.  Only these literal strings appear on
 * the `marks` array; anything else is a categorical refusal.
 */
export const NOTE_DOCUMENT_INLINE_MARKS: ReadonlyArray<string> = Object.freeze([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
]);

/** A link inline mark. */
export interface NoteLinkMark {
  readonly type: "link";
  readonly href: string;
}

/** Union of inline-mark shapes. */
export type NoteInlineMark = NoteLinkMark | (typeof NOTE_DOCUMENT_INLINE_MARKS)[number];

/** A single inline text run with optional marks. */
export interface NoteInline {
  readonly text: string;
  readonly marks?: readonly NoteInlineMark[];
}

/** A block-capable list item used by `bullet-list` and `ordered-list`. */
export interface NoteListItem {
  readonly inlines: readonly NoteInline[];
  readonly blocks?: readonly NoteBlock[];
}

/** A recursively-nested task item used by `task-list`. */
export interface NoteTaskItem {
  readonly checked: boolean;
  readonly inlines: readonly NoteInline[];
  readonly children: readonly NoteTaskItem[];
}

/** Paragraph block. */
export interface NoteParagraphBlock {
  readonly type: "paragraph";
  readonly inlines: readonly NoteInline[];
}

/** Heading block, levels 1..3 only. */
export interface NoteHeadingBlock {
  readonly type: "heading";
  readonly level: 1 | 2 | 3;
  readonly inlines: readonly NoteInline[];
}

/** Bullet list block. */
export interface NoteBulletListBlock {
  readonly type: "bullet-list";
  readonly items: readonly NoteListItem[];
}

/** Ordered list block. */
export interface NoteOrderedListBlock {
  readonly type: "ordered-list";
  readonly items: readonly NoteListItem[];
}

/**
 * Task-list block.  The optional `kind` field carries the per-list
 * intent (T00 D6); omitting it falls back to the legacy default
 * `simple-checklist` so callers that pre-date the per-list selector
 * see the same stored representation as before.
 */
export interface NoteTaskListBlock {
  readonly type: "task-list";
  readonly kind?: NoteListKind;
  readonly items: readonly NoteTaskItem[];
}

/** Blockquote block (recursive). */
export interface NoteBlockquoteBlock {
  readonly type: "blockquote";
  readonly blocks: readonly NoteBlock[];
}

/** Code block (optional language tag). */
export interface NoteCodeBlock {
  readonly type: "code-block";
  readonly language?: string;
  readonly text: string;
}

/** Table block (closed column / row shape). */
export interface NoteTableBlock {
  readonly type: "table";
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** Callout block (closed variant set). */
export interface NoteCalloutBlock {
  readonly type: "callout";
  readonly variant: "info" | "warning" | "success" | "danger";
  readonly blocks: readonly NoteBlock[];
}

/** Horizontal rule block.  No attributes — a plain structural divider. */
export interface NoteHorizontalRuleBlock {
  readonly type: "horizontal-rule";
}

/**
 * Structured image reference.  This is NOT a native render and NOT an
 * asset upload: it is a closed-shape pointer at a remote `https`/`http`
 * URL, exactly the "structured preservation" tier from plan §2.  `alt`
 * is optional bounded alt text; there is no `data`, `path`, or `bytes`
 * field, so the AST can never smuggle a local file or inline payload.
 */
export interface NoteImageBlock {
  readonly type: "image";
  readonly url: string;
  readonly alt?: string;
}

/**
 * Structured attachment reference.  Same safety envelope as
 * {@link NoteImageBlock}: a bounded remote URL plus optional bounded
 * `name` / `mime` labels.  Binary asset transport (plan Task 3.3) is
 * explicitly out of scope here — this node only carries a reference.
 */
export interface NoteAttachmentBlock {
  readonly type: "attachment";
  readonly url: string;
  readonly name?: string;
  readonly mime?: string;
}

/**
 * Structured embed reference. Bounded remote URL only, with no
 * provider claim until a runtime-backed provider policy is proven.
 * No arbitrary iframe/HTML is ever admitted.
 */
export interface NoteEmbedBlock {
  readonly type: "embed";
  readonly url: string;
}

/**
 * Closed set of opaque-reference sentinel sources.  The source tag is
 * the daemon's surface that produced the sentinel (e.g. native-html
 * fallback vs the tiptap JSON writer); T01 publishes the vocabulary
 * but T02/T03 own the runtime minting path.
 */
export type NoteOpaqueSentinelSource = "native-html" | "native-tiptap";

/**
 * Opaque-reference sentinel (T00 D7).  The token is short, versioned,
 * and opaque to body / title / id / token bytes.  The T01 validator
 * admits ONLY this shape on the editor document — opaque payloads are
 * forbidden (see {@link validateOpaqueBlock}).
 */
export interface NoteOpaqueSentinel {
  readonly version: 1;
  readonly token: string;
  readonly source: NoteOpaqueSentinelSource;
}

/**
 * Opaque block.  Carries the daemon-minted sentinel reference (T00 D7);
 * the editor document must NOT carry an opaque payload inline (T02/T03
 * own payload handling through the directive channel).
 */
export interface NoteOpaqueBlock {
  readonly type: "opaque";
  readonly nodeType: string;
  readonly sentinel: NoteOpaqueSentinel;
}

/** Closed union of every T01 block variant. */
export type NoteBlock =
  | NoteParagraphBlock
  | NoteHeadingBlock
  | NoteBulletListBlock
  | NoteOrderedListBlock
  | NoteTaskListBlock
  | NoteBlockquoteBlock
  | NoteCodeBlock
  | NoteTableBlock
  | NoteCalloutBlock
  | NoteHorizontalRuleBlock
  | NoteImageBlock
  | NoteAttachmentBlock
  | NoteEmbedBlock
  | NoteOpaqueBlock;

/** The versioned document. */
export interface NoteDocumentV1 {
  readonly version: typeof NOTE_DOCUMENT_VERSION;
  readonly blocks: readonly NoteBlock[];
}

// ---------------------------------------------------------------------------
// Validation entry points.
// ---------------------------------------------------------------------------

function snapshotHostileObjectGraph(value: unknown): unknown {
  const active = new Set<object>();
  let nodes = 0;
  let byteLength = 0;
  const maxNodes = 200_000;
  const maxBytes = MAX_NOTE_DOCUMENT_BLOCKS * MAX_NOTE_DOCUMENT_BLOCK_BYTES;
  const maxDepth = MAX_NOTE_DOCUMENT_DEPTH * 4 + 8;

  function visit(current: unknown, depth: number): unknown {
    if (++nodes > maxNodes) fail("oversize_document");
    if (typeof current === "string") {
      byteLength += Buffer.byteLength(current, "utf8");
      if (byteLength > maxBytes) fail("oversize_document");
      return current;
    }
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean" ||
      current === undefined
    ) {
      return current;
    }
    if (typeof current !== "object" || utilTypes.isProxy(current) || active.has(current)) {
      fail("invalid_shape");
    }
    if (depth > maxDepth) fail("depth_exceeded");

    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    ) {
      fail("invalid_shape");
    }
    active.add(current);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (ownKeys.length > maxNodes) fail("oversize_document");
      if (array) {
        const length = descriptors.length?.value;
        if (typeof length !== "number" || length > maxNodes || ownKeys.length !== length + 1) {
          fail("invalid_shape");
        }
        const copy: unknown[] = new Array(length);
        for (const key of ownKeys) {
          if (key === "length") continue;
          if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) fail("invalid_shape");
          const index = Number(key);
          if (index >= length) fail("invalid_shape");
          const descriptor = descriptors[key]!;
          if (!descriptor.enumerable || !("value" in descriptor)) fail("invalid_shape");
          copy[index] = visit(descriptor.value, depth + 1);
        }
        return copy;
      }

      const copy = Object.create(null) as Record<string, unknown>;
      for (const key of ownKeys) {
        if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) {
          fail("invalid_shape");
        }
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !("value" in descriptor)) fail("invalid_shape");
        copy[key] = visit(descriptor.value, depth + 1);
      }
      return copy;
    } finally {
      active.delete(current);
    }
  }

  return visit(value, 0);
}

/**
 * Validate a `NoteDocumentV1`.  Throws a categorical
 * {@link NoteDocumentError} on the first refusal path; otherwise
 * returns the input untouched.  Pure / deterministic: identical input
 * yields identical behaviour.
 *
 * Refusal paths:
 *   - top-level shape is not a frozen-shaped object with `version: 1`
 *     and a `blocks` array;
 *   - any block exceeds the depth / item-count / byte cap;
 *   - any inline carries a mark outside the closed set;
 *   - any `opaque` block smuggles an inline payload;
 *   - any `callout` carries a variant outside the closed set;
 *   - any `task-list` carries a `kind` outside the closed set;
 *   - any table row's column count differs from `columns.length`;
 *   - any link mark carries a non-string `href`;
 *   - any reference label contains a forbidden control byte or lone surrogate.
 *
 * The validator never echoes the offending value in the message.
 */
export function validateNoteDocument(value: unknown): asserts value is NoteDocumentV1 {
  const safeValue = snapshotHostileObjectGraph(value);
  if (!isPlainRecord(safeValue)) fail("invalid_shape");
  rejectUnknownKeys(safeValue, NOTE_DOCUMENT_KEYS, ["version", "blocks"]);
  if (safeValue.version !== NOTE_DOCUMENT_VERSION) fail("invalid_shape");
  if (!isNonProxyArray(safeValue.blocks)) fail("invalid_shape");
  if (safeValue.blocks.length > MAX_NOTE_DOCUMENT_BLOCKS) fail("oversize_document");

  validateBlockArray(safeValue.blocks, 1);

  // Block byte cap is enforced inside `validateBlockArray` via
  // `serialisedBlockBytes`; the document cap also counts each sanitized block.
  const totalBytes = serialisedDocumentBytes(safeValue.blocks);
  if (totalBytes > MAX_NOTE_DOCUMENT_BLOCKS * MAX_NOTE_DOCUMENT_BLOCK_BYTES) {
    fail("oversize_document");
  }
}

// ---------------------------------------------------------------------------
// Internal validators (block, inline, list, table, callout, opaque).
// ---------------------------------------------------------------------------

const CALLOUT_VARIANTS: ReadonlySet<string> = new Set(["info", "warning", "success", "danger"]);

const INLINE_MARK_STRINGS: ReadonlySet<string> = new Set(NOTE_DOCUMENT_INLINE_MARKS);

// ---------------------------------------------------------------------------
// Reference-node closed key sets (horizontal-rule / image / attachment /
// embed).  Each set is the EXACT admitted attribute vocabulary for its
// node; any other own key is a categorical refusal.
// ---------------------------------------------------------------------------

const HORIZONTAL_RULE_KEYS: ReadonlySet<string> = new Set(["type"]);
const IMAGE_KEYS: ReadonlySet<string> = new Set(["type", "url", "alt"]);
const ATTACHMENT_KEYS: ReadonlySet<string> = new Set(["type", "url", "name", "mime"]);
const EMBED_KEYS: ReadonlySet<string> = new Set(["type", "url"]);
const NOTE_DOCUMENT_KEYS = new Set(["version", "blocks"]);
const LINK_MARK_KEYS = new Set(["type", "href"]);
const OPAQUE_SENTINEL_KEYS = new Set(["version", "source", "token"]);
const LIST_ITEM_KEYS = new Set(["inlines", "blocks"]);
const TASK_ITEM_KEYS = new Set(["checked", "inlines", "children"]);
const INLINE_KEYS = new Set(["text", "marks"]);
const BLOCK_SHAPES: Readonly<
  Record<string, { readonly keys: ReadonlySet<string>; readonly required: readonly string[] }>
> = Object.freeze({
  paragraph: { keys: new Set(["type", "inlines"]), required: ["type", "inlines"] },
  heading: { keys: new Set(["type", "level", "inlines"]), required: ["type", "level", "inlines"] },
  "bullet-list": { keys: new Set(["type", "items"]), required: ["type", "items"] },
  "ordered-list": { keys: new Set(["type", "items"]), required: ["type", "items"] },
  "task-list": { keys: new Set(["type", "kind", "items"]), required: ["type", "items"] },
  blockquote: { keys: new Set(["type", "blocks"]), required: ["type", "blocks"] },
  "code-block": { keys: new Set(["type", "text", "language"]), required: ["type", "text"] },
  table: { keys: new Set(["type", "columns", "rows"]), required: ["type", "columns", "rows"] },
  callout: {
    keys: new Set(["type", "variant", "blocks"]),
    required: ["type", "variant", "blocks"],
  },
  "horizontal-rule": { keys: HORIZONTAL_RULE_KEYS, required: ["type"] },
  image: { keys: IMAGE_KEYS, required: ["type", "url"] },
  attachment: { keys: ATTACHMENT_KEYS, required: ["type", "url"] },
  embed: { keys: EMBED_KEYS, required: ["type", "url"] },
  opaque: {
    keys: new Set(["type", "nodeType", "sentinel"]),
    required: ["type", "nodeType", "sentinel"],
  },
});

/**
 * Only `https:`/`http:` are admitted.  This categorically rejects
 * `file:` (local filesystem paths), `javascript:` and `data:` (inline
 * executable/payload smuggling), `mailto:`, and any other scheme —
 * per plan §4 ("No remote URL fetching ... URLs are validated and
 * stored as references only") and §3.2 ("reject credentials, control
 * bytes, javascript/data URLs").  The URL is never dereferenced here;
 * `new URL()` only parses the string, it never performs I/O.
 */
const ALLOWED_REFERENCE_URL_SCHEMES: ReadonlySet<string> = new Set(["https:", "http:"]);

/** Reject any own key not in `allowed` — closed attribute-set enforcement. */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[] = [],
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) fail("invalid_shape");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("invalid_shape");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("invalid_shape");
  }
}

function validateNoForbiddenTextCodePoints(
  value: string,
  errorCode: NoteDocumentErrorCode,
  allowTabAndLineFeed: boolean,
): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint < 32 && !(allowTabAndLineFeed && (codePoint === 9 || codePoint === 10))) ||
      codePoint === 127 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      fail(errorCode);
    }
  }
}

/**
 * Validate a structured reference URL (`image`/`attachment`/`embed`).
 * Refuses non-string, empty, oversized, control-byte-bearing,
 * lone-surrogate-bearing, unparsable, non-http(s)-scheme, or credential-bearing URLs.
 * Never performs network I/O — `new URL()` is a pure parser.
 */
function validateReferenceUrl(value: unknown): void {
  if (typeof value !== "string") fail("invalid_reference_url");
  if (value.length === 0) fail("invalid_reference_url");
  if (Buffer.byteLength(value, "utf8") > MAX_NOTE_DOCUMENT_REFERENCE_URL_BYTES) {
    fail("invalid_reference_url");
  }
  validateNoForbiddenTextCodePoints(value, "invalid_reference_url", false);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("invalid_reference_url");
  }
  if (!ALLOWED_REFERENCE_URL_SCHEMES.has(parsed.protocol)) fail("invalid_reference_url");
  if (parsed.username.length > 0 || parsed.password.length > 0) fail("invalid_reference_url");
  if (parsed.hostname.length === 0) fail("invalid_reference_url");
}

/** Validate an optional bounded reference label (alt/name/mime/provider). */
function validateOptionalReferenceLabel(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string") fail("invalid_shape");
  if (Buffer.byteLength(value, "utf8") > MAX_NOTE_DOCUMENT_REFERENCE_LABEL_BYTES) {
    fail("oversize_inline");
  }
  validateNoForbiddenTextCodePoints(value, "invalid_shape", true);
}

function validateBlockArray(blocks: readonly unknown[], depth: number): void {
  if (depth > MAX_NOTE_DOCUMENT_DEPTH) fail("depth_exceeded");
  for (const block of blocks) {
    validateBlock(block, depth);
  }
}

function validateBlock(value: unknown, depth: number): void {
  if (!isPlainRecord(value)) fail("invalid_shape");
  const typeDescriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (!typeDescriptor || typeof typeDescriptor.value !== "string") fail("invalid_shape");
  const type = typeDescriptor.value as string;
  const shape = Object.hasOwn(BLOCK_SHAPES, type) ? BLOCK_SHAPES[type] : undefined;
  if (!shape) fail("unsupported_node");
  rejectUnknownKeys(value, shape.keys, shape.required);

  // Read the discriminator from an own data descriptor before touching
  // any caller-controlled property. New reference blocks additionally
  // validate every attribute descriptor before reading its value.
  switch (type) {
    case "paragraph":
      validateParagraph(value);
      return;
    case "heading":
      validateHeading(value);
      return;
    case "bullet-list":
      validateBulletList(value, depth);
      return;
    case "ordered-list":
      validateOrderedList(value, depth);
      return;
    case "task-list":
      validateTaskList(value, depth);
      return;
    case "blockquote":
      validateBlockquote(value, depth);
      return;
    case "code-block":
      validateCodeBlock(value);
      return;
    case "table":
      validateTable(value);
      return;
    case "callout":
      validateCallout(value, depth);
      return;
    case "horizontal-rule":
      validateHorizontalRule(value);
      return;
    case "image":
      validateImage(value);
      return;
    case "attachment":
      validateAttachment(value);
      return;
    case "embed":
      validateEmbed(value);
      return;
    case "opaque":
      validateOpaqueBlock(value);
      return;
    default:
      fail("unsupported_node");
  }
}

function validateParagraph(value: Record<string, unknown>): void {
  validateInlines(value.inlines);
  serialiseAndCapBlockBytes(value, "paragraph");
}

function validateHeading(value: Record<string, unknown>): void {
  const level = value.level;
  if (level !== 1 && level !== 2 && level !== 3) fail("invalid_shape");
  validateInlines(value.inlines);
  serialiseAndCapBlockBytes(value, "heading");
}

function validateBulletList(value: Record<string, unknown>, depth: number): void {
  validateListItems(value.items, "bullet-list", depth);
  serialiseAndCapBlockBytes(value, "bullet-list");
}

function validateOrderedList(value: Record<string, unknown>, depth: number): void {
  validateListItems(value.items, "ordered-list", depth);
  serialiseAndCapBlockBytes(value, "ordered-list");
}

function validateListItems(
  items: unknown,
  containerType: "bullet-list" | "ordered-list",
  depth: number,
): void {
  if (!isNonProxyArray(items)) fail("invalid_shape");
  if (items.length > MAX_NOTE_DOCUMENT_LIST_ITEMS_PER_LIST) fail("oversize_document");
  for (const item of items) {
    validateListItem(item, depth, containerType);
  }
}

function validateListItem(
  value: unknown,
  depth: number,
  containerType: "bullet-list" | "ordered-list",
): void {
  if (!isPlainRecord(value)) fail("invalid_shape");
  rejectUnknownKeys(value, LIST_ITEM_KEYS, ["inlines"]);
  validateInlines(value.inlines);
  // Block-capable list items (T01 brief): optional `blocks` array
  // that may carry continuation paragraphs, sub-lists, callouts, etc.
  if (value.blocks !== undefined) {
    if (!isNonProxyArray(value.blocks)) fail("invalid_shape");
    validateBlockArray(value.blocks, depth + 1);
  }
  // The serialised item bytes include its inlines + nested blocks;
  // we check the parent list's overall block byte cap in
  // `serialiseAndCapBlockBytes`, so a per-item cap is unnecessary.
  // Intentionally no-op to avoid duplicate byte accounting.
  void containerType;
}

function validateTaskList(value: Record<string, unknown>, depth: number): void {
  if (value.kind !== undefined) {
    try {
      normaliseNoteDocumentListKind(value.kind);
    } catch {
      fail("unsupported_list_kind");
    }
  }
  if (!isNonProxyArray(value.items)) fail("invalid_shape");
  if (value.items.length > MAX_NOTE_DOCUMENT_LIST_ITEMS_PER_LIST) fail("oversize_document");
  for (const item of value.items) {
    validateTaskItem(item, depth);
  }
  serialiseAndCapBlockBytes(value, "task-list");
}

function validateTaskItem(value: unknown, depth: number): void {
  if (!isPlainRecord(value)) fail("invalid_shape");
  rejectUnknownKeys(value, TASK_ITEM_KEYS, ["checked", "inlines", "children"]);
  if (typeof value.checked !== "boolean") fail("invalid_shape");
  validateInlines(value.inlines);
  if (!isNonProxyArray(value.children)) fail("invalid_shape");
  if (value.children.length > MAX_NOTE_DOCUMENT_TASK_CHILDREN) fail("oversize_document");
  if (depth + 1 > MAX_NOTE_DOCUMENT_DEPTH) fail("depth_exceeded");
  for (const child of value.children) {
    validateTaskItem(child, depth + 1);
  }
}

function validateBlockquote(value: Record<string, unknown>, depth: number): void {
  if (!isNonProxyArray(value.blocks)) fail("invalid_shape");
  validateBlockArray(value.blocks, depth + 1);
  serialiseAndCapBlockBytes(value, "blockquote");
}

function validateCodeBlock(value: Record<string, unknown>): void {
  if (typeof value.text !== "string") fail("invalid_shape");
  if (value.text.length > MAX_NOTE_DOCUMENT_TEXT_BYTES) fail("oversize_inline");
  if (value.language !== undefined && typeof value.language !== "string") {
    fail("invalid_shape");
  }
  serialiseAndCapBlockBytes(value, "code-block");
}

function validateTable(value: Record<string, unknown>): void {
  if (!isNonProxyArray(value.columns)) fail("invalid_shape");
  if (!isNonProxyArray(value.rows)) fail("invalid_shape");
  for (const column of value.columns) {
    if (typeof column !== "string") fail("invalid_shape");
  }
  const columnCount = value.columns.length;
  for (const row of value.rows) {
    if (!isNonProxyArray(row)) fail("invalid_shape");
    if (row.length !== columnCount) fail("table_column_mismatch");
    for (const cell of row) {
      if (typeof cell !== "string") fail("invalid_shape");
    }
  }
  serialiseAndCapBlockBytes(value, "table");
}

function validateCallout(value: Record<string, unknown>, depth: number): void {
  if (typeof value.variant !== "string") fail("invalid_shape");
  if (!CALLOUT_VARIANTS.has(value.variant)) fail("unsupported_callout_variant");
  if (!isNonProxyArray(value.blocks)) fail("invalid_shape");
  validateBlockArray(value.blocks, depth + 1);
  serialiseAndCapBlockBytes(value, "callout");
}

function validateHorizontalRule(value: Record<string, unknown>): void {
  // No payload fields at all — reject anything beyond `type` so a
  // caller cannot smuggle unrelated data through an otherwise-inert
  // divider node.
  rejectUnknownKeys(value, HORIZONTAL_RULE_KEYS);
  serialiseAndCapBlockBytes(value, "horizontal-rule");
}

function validateImage(value: Record<string, unknown>): void {
  rejectUnknownKeys(value, IMAGE_KEYS);
  validateReferenceUrl(value.url);
  validateOptionalReferenceLabel(value.alt);
  serialiseAndCapBlockBytes(value, "image");
}

function validateAttachment(value: Record<string, unknown>): void {
  rejectUnknownKeys(value, ATTACHMENT_KEYS);
  validateReferenceUrl(value.url);
  validateOptionalReferenceLabel(value.name);
  validateOptionalReferenceLabel(value.mime);
  serialiseAndCapBlockBytes(value, "attachment");
}

function validateEmbed(value: Record<string, unknown>): void {
  rejectUnknownKeys(value, EMBED_KEYS);
  validateReferenceUrl(value.url);
  serialiseAndCapBlockBytes(value, "embed");
}

function validateOpaqueBlock(value: Record<string, unknown>): void {
  if (typeof value.nodeType !== "string") fail("invalid_shape");
  if (value.nodeType.length === 0) fail("invalid_shape");
  if (value.nodeType.length > MAX_NOTE_DOCUMENT_OPAQUE_SENTINEL_BYTES) {
    fail("oversize_sentinel");
  }
  const sentinel = value.sentinel;
  if (!isPlainRecord(sentinel)) fail("invalid_shape");
  rejectUnknownKeys(sentinel, OPAQUE_SENTINEL_KEYS, ["version", "source", "token"]);
  if (sentinel.version !== 1) fail("invalid_shape");
  if (typeof sentinel.token !== "string") fail("invalid_shape");
  if (sentinel.token.length === 0) fail("invalid_shape");
  if (sentinel.token.length > MAX_NOTE_DOCUMENT_OPAQUE_SENTINEL_BYTES) {
    fail("oversize_sentinel");
  }
  if (typeof sentinel.source !== "string") fail("invalid_shape");
  if (sentinel.source !== "native-html" && sentinel.source !== "native-tiptap") {
    fail("invalid_shape");
  }
  // T01 invariant (T00 D7): the editor document must NOT carry an
  // opaque payload field.  Any payload-bearing key is a categorical
  // refusal.
  if ("payload" in sentinel) fail("opaque_payload_forbidden");
  if ("data" in sentinel) fail("opaque_payload_forbidden");
  if ("html" in sentinel) fail("opaque_payload_forbidden");
  if ("attrs" in sentinel) fail("opaque_payload_forbidden");
  serialiseAndCapBlockBytes(value, "opaque");
}

// ---------------------------------------------------------------------------
// Inline validation (shared by paragraph / heading / list-item / task-item).
// ---------------------------------------------------------------------------

function validateInlines(value: unknown): readonly NoteInline[] {
  if (!isNonProxyArray(value)) fail("invalid_shape");
  if (value.length > MAX_NOTE_DOCUMENT_INLINES_PER_BLOCK) fail("oversize_inline");
  for (const inline of value) {
    validateInline(inline);
  }
  return value as readonly NoteInline[];
}

function validateInline(value: unknown): void {
  if (!isPlainRecord(value)) fail("invalid_shape");
  rejectUnknownKeys(value, INLINE_KEYS, ["text"]);
  if (typeof value.text !== "string") fail("invalid_shape");
  if (Buffer.byteLength(value.text, "utf8") > MAX_NOTE_DOCUMENT_INLINE_BYTES) {
    fail("oversize_inline");
  }
  if (value.marks === undefined) return;
  if (!isNonProxyArray(value.marks)) fail("invalid_shape");
  for (const mark of value.marks) {
    validateInlineMark(mark);
  }
}

function validateInlineMark(mark: unknown): void {
  if (typeof mark === "string") {
    if (!INLINE_MARK_STRINGS.has(mark)) fail("unsupported_mark");
    return;
  }
  if (isPlainRecord(mark) && (mark as Record<string, unknown>).type === "link") {
    rejectUnknownKeys(mark, LINK_MARK_KEYS, ["type", "href"]);
    if (typeof mark.href !== "string") fail("malformed_link");
    if (mark.href.length === 0) fail("malformed_link");
    if (Buffer.byteLength(mark.href, "utf8") > MAX_NOTE_DOCUMENT_INLINE_BYTES) {
      fail("malformed_link");
    }
    return;
  }
  fail("unsupported_mark");
}

// ---------------------------------------------------------------------------
// Serialised byte accounting (for the per-block byte cap).
// ---------------------------------------------------------------------------

/**
 * Approximate a block's serialised byte length using a conservative
 * upper bound on each textual field.  The point is to refuse obvious
 * bombs BEFORE we walk a deeply-nested tree — exact deterministic
 * re-serialisation is T02/T03's responsibility.
 */
function serialisedBlockBytes(value: unknown): number {
  return Buffer.byteLength(stableStringify(value), "utf8");
}

function serialisedDocumentBytes(blocks: readonly unknown[]): number {
  let total = 0;
  for (const block of blocks) {
    total += serialisedBlockBytes(block);
  }
  return total;
}

function serialiseAndCapBlockBytes(value: Record<string, unknown>, blockType: string): void {
  if (serialisedBlockBytes(value) > MAX_NOTE_DOCUMENT_BLOCK_BYTES) {
    // The `blockType` parameter is purely diagnostic for future
    // logging; it is intentionally NOT interpolated into the error
    // message because it would echo attacker-controlled data.
    void blockType;
    fail("oversize_block");
  }
}

// ---------------------------------------------------------------------------
// Hostile-object rejection + deterministic serialisation.
// ---------------------------------------------------------------------------

/**
 * A "plain record" is an own-data object whose prototype is
 * `Object.prototype` or `null`.  This rejects prototype-polluted
 * inputs (`__proto__` payloads) and instances of host classes that
 * carry extra behaviour, so the validator cannot be tricked by a
 * hostile caller-supplied object.
 */
function isNonProxyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && !utilTypes.isProxy(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deterministic JSON serialiser used solely for byte accounting.
 *
 * - Object keys are sorted alphabetically so equivalent ASTs produce
 *   identical bytes (T00 §13.18: "Deterministic output: equivalent
 *   ASTs produce byte-stable stored output.");
 * - `undefined` and function values are dropped (JSON-compatible);
 * - arrays preserve order (the validator already enforces a closed
 *   shape, so order is part of the contract).
 *
 * The result is only used for byte-length comparison; it is never
 * re-parsed, so it does not need to be round-trippable.
 */
function stableStringify(value: unknown, active = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "0";
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object" && value !== null) {
    if (utilTypes.isProxy(value) || active.has(value)) fail("invalid_shape");
    if (Array.isArray(value)) {
      active.add(value);
      let out = "[";
      try {
        for (let i = 0; i < value.length; i += 1) {
          if (i > 0) out += ",";
          out += stableStringify(value[i], active);
        }
      } finally {
        active.delete(value);
      }
      return out + "]";
    }
    if (isPlainRecord(value)) {
      active.add(value);
      const keys = Object.keys(value).sort();
      let out = "{";
      let first = true;
      try {
        for (const key of keys) {
          const entry = (value as Record<string, unknown>)[key];
          if (entry === undefined) continue;
          if (!first) out += ",";
          first = false;
          out += JSON.stringify(key) + ":" + stableStringify(entry, active);
        }
      } finally {
        active.delete(value);
      }
      return out + "}";
    }
  }
  return "null";
}
