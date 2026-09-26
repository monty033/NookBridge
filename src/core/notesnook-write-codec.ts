/**
 * Stage 4 — deterministic production Markdown → stored-content codec.
 *
 * The Stage 4 write adapter takes its codec by injection *by design*: the
 * adapter never guesses how application-layer Markdown becomes the stored
 * representation the pinned `@notesnook/core@8.1.3` runtime understands.
 * This module supplies the one concrete production codec used by the gated
 * operator write path.
 *
 * Deliberate properties
 * ---------------------
 *
 *   - **No new dependency and no network.**  The translation is a small,
 *     explicit, total function over a bounded input string.  There is no
 *     Markdown library, no HTML sanitiser download, no remote schema.
 *   - **Bounded.**  Input longer than the published contract limit, a
 *     non-string, or a control character other than `\n` / `\t` is refused.
 *     Refusal is a throw, which the adapter normalises to the categorical
 *     `unsupported_content`; this module never invents its own code table.
 *   - **Escaping first.**  Every byte of operator Markdown is HTML-escaped
 *     before any structural markup is added, so no operator input can ever
 *     be interpreted as markup, an attribute, or a script.
 *   - **Append preserves the stored bytes verbatim.**  The append path
 *     concatenates `storedData` and exactly one freshly encoded block.  It
 *     never re-parses, re-serialises, or rewrites the existing stored data.
 *   - **Nothing is logged or printed.**  This module has no logger, no
 *     `process` access, and returns content only to its caller.
 *
 * Supported block grammar (intentionally tiny):
 *
 *   `# `, `## `, `### `         → `<h1>` / `<h2>` / `<h3>`
 *   `- [ ] item` / `- [x] item` → Notesnook **simple checklist** HTML
 *   `- ` / `* ` lines           → `<ul><li>…</li></ul>`
 *   anything else               → `<p>…</p>`, with in-block newlines as `<br />`
 *
 * Markdown checkbox syntax is the input construct `task-list`.  The
 * explicit {@link NotesnookListKind} selector on the write surface
 * chooses which Notesnook native representation the codec emits:
 *
 *   - `simple-checklist` (default — preserves the prior stored shape
 *     for every existing caller) → Notesnook's lightweight checklist
 *     (`<ul class="simple-checklist">` / `simple-checklist--item`,
 *     read-only checkboxes).
 *   - `task-list` → Notesnook's richer native task list
 *     (`<ul class="checklist">` / `checklist--item`, interactive
 *     checkboxes, `checked` / `checked--item` variants).
 *
 * Checklist blocks recognise two-space, tab, or four-space indentation as
 * one nesting level; nested children are emitted as
 * `<ul class="simple-checklist">…</ul>`
 * inside the owning `<li>` so the resulting tree is valid HTML and the
 * Notesnook text conversion walks every depth through the parent checklist.
 * Task-list blocks emit the same nesting shape with the
 * `<ul class="checklist">` / `<li class="checklist--item">` markup.
 */

import { Buffer } from "node:buffer";

import { STAGE4_WRITE_LIMITS } from "./notesnook-write-contract.js";
import type {
  NotesnookStoredContent,
  NotesnookWriteMarkdownCodec,
} from "./notesnook-write-adapter.js";

export type { NotesnookListKind } from "./notesnook-write-list-intent.js";
export {
  DEFAULT_NOTESNOOK_LIST_KIND,
  NOTESNOOK_LIST_KINDS,
  normaliseNotesnookListKind,
} from "./notesnook-write-list-intent.js";
import {
  normaliseNotesnookListKind,
  type NotesnookListKind,
} from "./notesnook-write-list-intent.js";

/**
 * Largest stored payload this codec will emit.  The stored representation
 * is always larger than its Markdown source (escaping plus block tags), so
 * the bound is a small multiple of the contract content limit.  Exceeding it
 * is a refusal rather than a silent truncation.
 */
const MAX_STORED_BYTES = STAGE4_WRITE_LIMITS.maxContentBytes * 4;

/**
 * Codec-owned refusal.  Chain-free and message-fixed: the adapter maps any
 * throw from the codec seam to `unsupported_content`, and this module must
 * not become a channel through which operator content re-enters an error
 * string.
 */
class NotesnookMarkdownCodecError extends Error {
  constructor() {
    super("Notesnook markdown codec: content is not supported");
    Object.defineProperty(this, "name", {
      configurable: true,
      value: "NotesnookMarkdownCodecError",
    });
    Object.defineProperty(this, "cause", { configurable: true, value: undefined });
    Object.defineProperty(this, "__context__", { configurable: true, value: undefined });
  }
}

function refuse(): never {
  throw new NotesnookMarkdownCodecError();
}

/**
 * `true` when `value` contains a lone (unpaired) UTF-16 surrogate: a high
 * surrogate not immediately followed by a low surrogate, or a low
 * surrogate not immediately preceded by a matched high surrogate.
 *
 * A well-formed JS string can still contain one — it is not, itself, a
 * bounds violation `Buffer.byteLength` or a control-character scan would
 * catch.  But it is not valid UTF-8/UTF-16 text: the pinned runtime's
 * native decoder (`note-document-native.ts`) sanitises stored content
 * through a `clean()` pass that rejects it, so content the write codec
 * happily accepted and stored could make the note unreadable on the very
 * next read.  Refusing it here, at the shared input boundary every
 * construct passes through, keeps that failure at write time instead of
 * read time.
 */
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** Accept only bounded plain text: no NUL, no C0 controls except `\n`/`\t`, no lone surrogates. */
function requireBoundedMarkdown(value: unknown, maxBytes: number): string {
  if (typeof value !== "string") refuse();
  if (Buffer.byteLength(value, "utf8") > maxBytes) refuse();
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) refuse();
  }
  if (hasUnpairedSurrogate(value)) refuse();
  return value;
}

function requireBoundedStoredData(value: unknown): string {
  if (typeof value !== "string") refuse();
  if (Buffer.byteLength(value, "utf8") > MAX_STORED_BYTES) refuse();
  return value;
}

function requireStoredType(value: unknown): "tiptap" | "html" {
  if (value === "tiptap" || value === "html") return value;
  refuse();
}

// ---------------------------------------------------------------------------
// Markdown construct fidelity gate (Astra finding P1-7).
//
// The deterministic codec emits a deliberately tiny subset of Markdown:
// `h1` / `h2` / `h3`, unordered lists, paragraphs, and a small inline
// mark set.  Constructs the codec does not round-trip safely MUST be
// refused before the adapter mutates a note so a full replacement never
// silently downgrades the content shape.
//
// The gate detects every construct present in the input (supported and
// unsupported) and throws on the first unsupported construct so the
// adapter can normalise the refusal to `unsupported_content`.
// ---------------------------------------------------------------------------

export type MarkdownConstruct =
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "unordered-list"
  | "task-list"
  | "paragraph"
  | "inline-bold"
  | "inline-italic"
  | "inline-code"
  | "markdown-table"
  | "horizontal-rule"
  | "fenced-code-block"
  | "blockquote"
  | "link-or-image"
  | "attachment-reference"
  | "inline-html";

/**
 * The closed list of Markdown constructs the codec supports.  Anything
 * detected in the input that is not in this set triggers a refusal.
 *
 * Wave 1 (native block parity): `markdown-table`, `horizontal-rule`,
 * `fenced-code-block` and `blockquote` were added alongside matching
 * `renderBlock` branches — see {@link renderBlock}.  Detection and
 * rendering are added together so the gate never admits a construct the
 * renderer would still flatten to a literal paragraph.
 */
export const SUPPORTED_MARKDOWN_CONSTRUCTS: ReadonlySet<MarkdownConstruct> = Object.freeze(
  new Set<MarkdownConstruct>([
    "heading-1",
    "heading-2",
    "heading-3",
    "unordered-list",
    "task-list",
    "paragraph",
    "inline-bold",
    "inline-italic",
    "inline-code",
    "markdown-table",
    "horizontal-rule",
    "fenced-code-block",
    "blockquote",
  ]),
);

/**
 * The inline marks the codec can both detect and render.
 *
 * Detection and rendering share these sources so a construct is accepted
 * exactly when the renderer can express it.  When the two drifted, the gate
 * admitted marks that the renderer left as literal text, and the operator saw
 * `created` over a note carrying asterisks.
 *
 * An asterisk that opens or closes onto whitespace is not emphasis, so
 * `2 * 3 * 4` stays arithmetic and `a ** b ** c` stays prose.
 */
const BOLD_MARK_SOURCE = "\\*\\*([^\\s*](?:[^*\\n]*[^\\s*])?)\\*\\*";
const ITALIC_MARK_SOURCE = "(^|[^*])\\*([^\\s*](?:[^*\\n]*[^\\s*])?)\\*(?!\\*)";
const CODE_MARK_SOURCE = "`([^`\\n]+)`";
const BOLD_MARK_DETECT = new RegExp(BOLD_MARK_SOURCE);
const ITALIC_MARK_DETECT = new RegExp(ITALIC_MARK_SOURCE);
const CODE_MARK_DETECT = new RegExp(CODE_MARK_SOURCE);
const BOLD_MARK_RENDER = new RegExp(BOLD_MARK_SOURCE, "g");
const ITALIC_MARK_RENDER = new RegExp(ITALIC_MARK_SOURCE, "g");
const CODE_MARK_RENDER = new RegExp(CODE_MARK_SOURCE, "g");

/**
 * A placeholder for a lifted-out code span.  Escape has already run, so the
 * text cannot contain markup; the private-use sentinel is not whitespace and
 * not an asterisk, so emphasis may wrap a span without matching inside it.
 */
const CODE_SPAN_SENTINEL = "\uE000";
const CODE_SPAN_RESTORE = new RegExp(`${CODE_SPAN_SENTINEL}(\\d+)${CODE_SPAN_SENTINEL}`, "g");

/**
 * Human-readable names for the Markdown constructs the deterministic
 * codec refuses.  Exposed for the write adapter and operator-facing
 * documentation; tests assert membership.
 */
export const UNSUPPORTED_MARKDOWN_CONSTRUCTS: ReadonlyArray<string> = Object.freeze([
  "attachment-reference",
  "link-or-image",
  "inline-html",
]);

/** A line consisting of three or more `-` and nothing else (a horizontal rule). */
const HORIZONTAL_RULE_LINE = /^-{3,}$/;

/** A fenced code block's opening line: three backticks and an optional bounded language token. */
const CODE_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)$/;

/**
 * A Markdown table separator row cell: a bare dash run only (`-`, `--`,
 * `---`, ...).  Column-alignment colons (`:-`, `-:`, `:-:`) are
 * deliberately NOT accepted here: `NoteTableBlock` (the canonical AST
 * `note-document-native.ts` reads/writes) has no alignment field, so
 * honouring alignment syntax at parse time would silently drop it at
 * render time with no way for a future read+edit round-trip to recover
 * it.  An aligned separator is therefore simply not recognised as a
 * table separator at all — the block falls through to a plain,
 * unmodified paragraph instead of a table that quietly lost its
 * alignment.
 */
const TABLE_SEPARATOR_CELL = /^-+$/;

/**
 * Tokenize `text` on unescaped `|` characters.  `\|` is literal pipe
 * content and `\\` is a literal backslash; every other backslash is
 * literal too (the codec does not support a general escape grammar).
 *
 * Backslash PARITY matters: `a\|b` has one backslash immediately before
 * the pipe, so the pipe is escaped (one cell, `a|b`).  `a\\|b` has TWO
 * backslashes before the pipe — the first escapes the second into a
 * literal backslash, leaving the pipe itself a real, unescaped delimiter
 * (two cells, `a\` and `b`).  Scanning left-to-right and consuming a
 * backslash together with whatever it escapes (rather than only peeking
 * one character back from each pipe) gets this right for any run of
 * backslashes, not just a single one.
 */
function tokenizePipeCells(text: string): {
  readonly cells: readonly string[];
  readonly delimiters: number;
} {
  const cells: string[] = [];
  let current = "";
  let delimiters = 0;
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i] as string;
    if (
      character === "\\" &&
      i + 1 < text.length &&
      (text[i + 1] === "|" || text[i + 1] === "\\")
    ) {
      current += text[i + 1];
      i += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      delimiters += 1;
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return { cells, delimiters };
}

/**
 * Split a `|`-delimited table row into its cell text, dropping one
 * optional leading and trailing EMPTY cell produced by the conventional
 * leading/trailing delimiter pipe (`| a | b |`).  Returns `null` when the
 * line has no unescaped pipe at all, so a bare `|` cannot be mistaken for
 * a table and a line whose only pipe is escaped (`a\|b`, no real
 * delimiter) is not mistaken for a two-cell row either.
 */
function parseTableRow(line: string): readonly string[] | null {
  const { cells, delimiters } = tokenizePipeCells(line.trim());
  if (delimiters === 0) return null;
  let result: readonly string[] = cells;
  if (result.length > 1 && result[0] === "") result = result.slice(1);
  if (result.length > 1 && result[result.length - 1] === "") result = result.slice(0, -1);
  return result;
}

/** Whether `cells` is a valid table separator row (every cell is a dash run). */
function isTableSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell));
}

// ---------------------------------------------------------------------------
// Shared block-shape predicates (P1-7 follow-up: detect/render parity).
//
// A production review of Wave 1 found that `detectMarkdownConstructs` and
// `renderBlock` classified a block using two INDEPENDENT sets of checks
// (a loose per-line scan for detection, a stricter per-block check for
// rendering).  Where those checks disagreed — a line-shaped-like-a-fence
// with trailing text, a horizontal rule with stray whitespace, a
// blockquote mixed into a paragraph, a table row with no real table
// context — the gate would admit a construct the renderer then flattened
// to a literal paragraph: the exact bug class this fidelity gate exists
// to prevent.
//
// The fix is structural: `classifyBlockConstruct` (used by detection) and
// `renderBlock` (used by rendering) now call the SAME shape predicates
// below, on the SAME block boundaries produced by `splitBlocks`, so they
// cannot drift apart again.
// ---------------------------------------------------------------------------

/**
 * A single line, alone in its block, that is exactly a horizontal rule.
 *
 * KNOWN, DELIBERATE LIMITATION: `NoteBlock` (`note-document.ts`) has no
 * horizontal-rule variant, and the pinned runtime's native decoder
 * (`note-document-native.ts`) has no `"hr"` case in `decodeBlock` — but
 * `"hr"` IS one of its recognised void tags (`voids`/`tags`), so an
 * emitted `<hr />` parses cleanly and falls through to that decoder's
 * generic `preserve()` path: the SAME safe, no-data-loss "whole-subtree
 * opaque reference" fallback every other syntactically-valid-but-not-yet-
 * modelled shape in that file gets (see its own header comment: "Unknown
 * safe structures become whole-subtree references, never partial
 * edits.").  A horizontal rule this codec writes is therefore not lost
 * or corrupted on the next read — it stops being individually editable
 * as a discrete block until a future wave adds a canonical AST variant
 * for it, exactly like the blockquote nested-block gap documented on
 * {@link renderBlockquote}.
 */
function isHorizontalRuleBlock(lines: readonly string[]): boolean {
  return lines.length === 1 && HORIZONTAL_RULE_LINE.test(lines[0] as string);
}

/** A block whose first line opens a fence and whose last line is a bare closing fence. */
function isFencedCodeBlock(lines: readonly string[]): boolean {
  return (
    lines.length >= 2 &&
    CODE_FENCE_OPEN.test(lines[0] as string) &&
    lines[lines.length - 1] === "```"
  );
}

/** A block every line of which is a `> `-prefixed quote line. */
function isBlockquoteBlock(lines: readonly string[]): boolean {
  return lines.length > 0 && lines.every((line) => /^> ?/.test(line));
}

/**
 * Parse `lines` as a Markdown table: every line must be a `|`-delimited
 * row, the second row must be a valid separator row, and the separator's
 * column count must match the header's.  Returns `null` for anything
 * that is not a well-formed table header/separator pair — including a
 * lone line that merely contains a `|` — so a stray pipe in ordinary
 * prose is never misclassified as a table.
 *
 * Body-row column count against the header is NOT checked here: that
 * mismatch is refused at render time ({@link renderTableBlock}) rather
 * than silently reclassifying the block as something else, matching the
 * existing "refuse rather than downgrade" contract for a ragged table.
 */
function parseTableBlockRows(lines: readonly string[]): readonly (readonly string[])[] | null {
  if (lines.length < 2) return null;
  const rows = lines.map((line) => parseTableRow(line));
  if (rows.some((row) => row === null)) return null;
  const header = rows[0] as readonly string[];
  const separator = rows[1] as readonly string[];
  if (!isTableSeparatorRow(separator) || separator.length !== header.length) return null;
  return rows as readonly (readonly string[])[];
}

/**
 * Classify one already-split block (see {@link splitBlocks}) as exactly
 * the construct {@link renderBlock} will render it as.  Order matters
 * and must match `renderBlock`'s dispatch order exactly.
 */
function classifyBlockConstruct(lines: readonly string[]): MarkdownConstruct {
  const first = lines[0] ?? "";
  if (isHorizontalRuleBlock(lines)) return "horizontal-rule";
  if (isFencedCodeBlock(lines)) return "fenced-code-block";
  if (isBlockquoteBlock(lines)) return "blockquote";
  if (parseTableBlockRows(lines) !== null) return "markdown-table";
  const heading = /^(#{1,3}) +/.exec(first);
  if (heading !== null && lines.length === 1) {
    const level = (heading[1] as string).length;
    return level === 1 ? "heading-1" : level === 2 ? "heading-2" : "heading-3";
  }
  if (lines.every((line) => TASK_LIST_LINE.test(line))) return "task-list";
  if (lines.every((line) => /^[-*] +/.test(line))) return "unordered-list";
  return "paragraph";
}

/**
 * Detect every construct in `markdown`.  Throws when the input is not a
 * bounded string; otherwise returns the frozen set of detected
 * constructs.  The detection is total over accepted input.
 *
 * Block-level constructs are classified over the SAME blocks
 * {@link splitBlocks}/`renderBlock` use (see {@link classifyBlockConstruct}),
 * so detection can never admit a shape the renderer would flatten
 * differently.  Inline-level constructs (bold/italic/code/link/image/
 * attachment/HTML) are still scanned per line, but a fenced code block's
 * body is skipped: that content is escaped and rendered verbatim, never
 * interpreted as Markup, so a code sample containing e.g. `<b>` or `**`
 * must not itself trigger a refusal.
 */
export function detectMarkdownConstructs(
  markdown: string,
  maxBytes: number,
): ReadonlySet<MarkdownConstruct> {
  const safe = requireBoundedMarkdown(markdown, maxBytes);
  const observed = new Set<MarkdownConstruct>();
  for (const block of splitBlocks(safe)) {
    const lines = block.split("\n");
    const construct = classifyBlockConstruct(lines);
    observed.add(construct);
    // A fenced code block's body is escaped verbatim, and a table cell is
    // escaped text-only (see the doc comment on renderTableBlock) — neither
    // ever interprets bold/italic/code/link/html marks.  Scanning their
    // lines for those marks would report e.g. "inline-bold" as an observed,
    // gate-supported construct even though "**bold**" inside a table cell
    // renders as literal asterisks, not <strong> — a detect/render lie.
    if (construct === "fenced-code-block" || construct === "markdown-table") continue;
    for (const line of lines) {
      if (/!\[[^\]\n]*\]\([^)\n]*\)/.test(line)) observed.add("attachment-reference");
      if (/!\[\[[^\]\n]*\]\]/.test(line)) observed.add("attachment-reference");
      if (/\[[^\]\n]+\]\([^)\n]+\)/.test(line)) observed.add("link-or-image");
      if (BOLD_MARK_DETECT.test(line)) observed.add("inline-bold");
      if (ITALIC_MARK_DETECT.test(line)) observed.add("inline-italic");
      if (CODE_MARK_DETECT.test(line)) observed.add("inline-code");
      if (/<[a-zA-Z][^>\n]*>/.test(line)) observed.add("inline-html");
    }
  }
  return Object.freeze(observed);
}

/**
 * Throw when `markdown` contains a construct outside
 * {@link SUPPORTED_MARKDOWN_CONSTRUCTS}.  The error message is
 * chain-free; the adapter normalises the throw to
 * `unsupported_content`.
 */
export function assertSupportedConstructs(markdown: string, maxBytes: number): void {
  const observed = detectMarkdownConstructs(markdown, maxBytes);
  for (const construct of observed) {
    if (!SUPPORTED_MARKDOWN_CONSTRUCTS.has(construct)) refuse();
  }
}

/**
 * Escape every HTML-significant byte.  Applied to operator text BEFORE any
 * structural tag is added, so operator input can never become markup.
 */
function escapeHtml(text: string): string {
  let out = "";
  for (const character of text) {
    switch (character) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "'":
        out += "&#39;";
        break;
      case "\t":
        out += "    ";
        break;
      default:
        out += character;
    }
  }
  return out;
}

/**
 * The "shape" a non-blank line contributes to the block it joins.  Lines
 * of a different shape never share a block, so a block is always
 * homogeneous by construction — the classification predicates above
 * never see a block mixing e.g. blockquote lines with plain prose.
 *
 * A `|`-containing line is deliberately NOT its own shape here: a lone
 * pipe is extremely common in ordinary prose ("cost is $5 | shipping
 * $2"), and grouping merely by pipe-presence forced innocuous text apart
 * into separate paragraphs.  A genuine table still isolates correctly
 * without this: a real table's header/separator/body lines are already
 * contiguous non-blank lines, so they land in one "other" block together,
 * and {@link parseTableBlockRows} rejects the block outright (falls back
 * to a plain paragraph) the instant any line in it — including
 * surrounding prose merged in by accident — fails to parse as a
 * `|`-delimited row.
 */
type LineShape = "task" | "quote" | "other";

function lineShape(line: string): LineShape {
  if (isTaskListLine(line)) return "task";
  if (/^> ?/.test(line)) return "quote";
  return "other";
}

/**
 * Split on blank lines and structural Markdown transitions into bounded
 * blocks.
 *
 * Three kinds of transition force a new block, independent of blank
 * lines:
 *
 *   - A heading or a horizontal-rule line is always isolated in its own
 *     single-line block (flushed before AND after), matching the
 *     `lines.length === 1` requirement both classification and rendering
 *     use for those two constructs.
 *   - A fenced code block is the one construct whose interior can
 *     contain blank lines that must NOT split it: once an opening fence
 *     is seen, every following line — blank or not — stays in the
 *     current block until the matching closing fence, and the whole
 *     fence is itself isolated from any surrounding prose (flushed
 *     before opening and after closing) so two adjacent fences, or a
 *     fence immediately followed by text, never merge into one block.
 *   - Any other line's {@link lineShape} (task / quote / other) must
 *     match the current block's shape, or the block is flushed first.
 *     This keeps a blockquote from absorbing an adjacent plain-text line
 *     (or vice versa) when there is no blank line between them.  A
 *     table has no dedicated shape here — see {@link lineShape} for why;
 *     instead, once a table is confirmed (see `tableConfirmed` below), a
 *     following body row is absorbed regardless of its shape as long as
 *     it is STILL a `|`-delimited row — a body row that stops looking
 *     like a table row at all (no unescaped pipe) ends the table.
 */
function splitBlocks(markdown: string): readonly string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  // Tracks whether `current` already forms a confirmed table (a valid
  // header + separator pair).  Computed incrementally — checked ONCE,
  // the instant `current` reaches exactly two lines — rather than
  // re-validating the whole (potentially long) growing block on every
  // subsequent line, which would make table parsing quadratic in the
  // table's row count.
  let tableConfirmed = false;
  const flush = (): void => {
    if (current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
    tableConfirmed = false;
  };
  for (const line of markdown.split("\n")) {
    if (inFence) {
      current.push(line);
      if (line === "```") {
        inFence = false;
        flush();
      }
      continue;
    }
    if (CODE_FENCE_OPEN.test(line)) {
      flush();
      current.push(line);
      inFence = true;
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    // Once a table is confirmed, keep absorbing every following line
    // that is STILL a `|`-delimited row as a body row — even one that
    // ALSO happens to match heading, horizontal-rule, task-list, or
    // blockquote syntax (e.g. a cell whose content starts with `# ` or
    // `- [ ] `).  This check runs BEFORE the heading/hr isolation below:
    // otherwise a body row that merely starts with `#` would be sliced
    // out as its own isolated heading block, splitting a genuine table
    // into a headerless table plus a stray heading.  A line with no
    // unescaped pipe at all is never a body row, so it correctly ends
    // the table instead of being swallowed into an invalid mixed block.
    if (tableConfirmed) {
      if (parseTableRow(line) !== null) {
        current.push(line);
        continue;
      }
      flush();
    }
    if (isHeadingLine(line) || HORIZONTAL_RULE_LINE.test(line)) {
      flush();
      current.push(line);
      flush();
      continue;
    }
    if (current.length > 0 && lineShape(current[0] as string) !== lineShape(line)) {
      flush();
    }
    current.push(line);
    if (!tableConfirmed && current.length === 2) {
      tableConfirmed = parseTableBlockRows(current) !== null;
    }
  }
  // Reaching EOF still inside an open fence means the input opened a
  // code block and never closed it.  `isFencedCodeBlock` requires a bare
  // closing ` ``` ` line, so an unterminated fence would otherwise fall
  // through every classification branch to a literal paragraph — the
  // opening fence marker itself rendered as visible backtick text.  A
  // malformed fence has no safe native shape to downgrade to, so it is
  // refused before any mutation, the same "refuse rather than downgrade"
  // contract a ragged table already gets.
  if (inFence) refuse();
  flush();
  return blocks;
}

/**
 * Match a single task-list item line, allowing leading tabs and/or spaces
 * for nested children.  Captures the checkbox state (` `, `x`, or `X`) in
 * group 1 and the item text in group 2.
 *
 * The indentation is intentionally generous — it accepts tabs, two-space
 * Markdown indentation, and four-space indentation rather than requiring a
 * single canonical unit.  The renderer normalises the count to a level after
 * inspecting the block's smallest positive indentation.
 */
const TASK_LIST_LINE = /^(?:\t| )*[-*] +\[( |x|X)\] +([^\n]*)$/;

function isHeadingLine(line: string): boolean {
  return /^#{1,3} +/.test(line);
}

function isTaskListLine(line: string): boolean {
  return TASK_LIST_LINE.test(line);
}

/**
 * Count leading indentation in four-column tab-stop units.
 *
 * Tabs and four spaces both represent one conventional list indentation
 * level.  Keeping this as a column count lets the block parser recognise
 * the common two-space Markdown form without changing the existing tab and
 * four-space behaviour.
 */
function taskListIndentColumns(line: string): number {
  let tabs = 0;
  let spaces = 0;
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i);
    if (code === 0x09) {
      tabs += 1;
      continue;
    }
    if (code === 0x20) {
      spaces += 1;
      continue;
    }
    break;
  }
  return tabs * 4 + spaces;
}

function taskListIndentUnit(lines: readonly string[]): number {
  const positiveIndents = lines
    .map((line) => taskListIndentColumns(line))
    .filter((indent) => indent > 0);
  const smallest = Math.min(...positiveIndents);
  // Two spaces is the compact Markdown form; four columns also covers both
  // literal four-space indentation and one leading tab.  Other partial runs
  // remain deliberately ambiguous and therefore stay at the top level.
  return smallest === 2 ? 2 : 4;
}

function taskListIndent(line: string, unit: number): number {
  const columns = taskListIndentColumns(line);
  return columns > 0 && columns % unit === 0 ? columns / unit : 0;
}

type TaskListItem = {
  readonly checked: boolean;
  readonly text: string;
  readonly children: TaskListItem[];
};

function parseTaskListLines(lines: readonly string[]): readonly TaskListItem[] {
  const rootChildren: TaskListItem[] = [];
  const indentUnit = taskListIndentUnit(lines);
  // Stack entries track the indent of the most recent open <ul> and the
  // list of items owned by that level.  A sentinel at indent -1 owns the
  // top-level items so the loop body can treat every item uniformly.
  const stack: { readonly indent: number; readonly bucket: TaskListItem[] }[] = [
    { indent: -1, bucket: rootChildren },
  ];

  for (const line of lines) {
    const indent = taskListIndent(line, indentUnit);
    const match = TASK_LIST_LINE.exec(line);
    if (match === null) continue;
    const state = match[1] as " " | "x" | "X";
    const text = match[2] ?? "";
    while (stack.length > 1 && (stack[stack.length - 1] as { indent: number }).indent >= indent) {
      stack.pop();
    }
    const item: TaskListItem = { checked: state !== " ", text, children: [] };
    (stack[stack.length - 1] as { bucket: TaskListItem[] }).bucket.push(item);
    stack.push({ indent, bucket: item.children });
  }

  return rootChildren;
}

/**
 * Render the inline mark set the gate accepts.
 *
 * The gate classifies `**bold**`, `*italic*` and `` `code` `` as supported
 * constructs, so the renderer must emit the tags the projection maps back to
 * those delimiters — `strong`, `em` and `code`, the canonical pair declared in
 * `note-document-native.ts`.  Emitting the escaped delimiters instead would
 * make the gate's promise a lie: the operator would see `created` while the
 * note carried literal asterisks.  Both halves read the same patterns
 * ({@link BOLD_MARK_SOURCE} and friends) so they cannot drift apart.
 *
 * Escaping runs first so the marks cannot smuggle markup.  Code spans are then
 * lifted out into placeholders: an emphasis marker inside one stays literal,
 * while emphasis may wrap a whole span (`a *`code`* b`).  Bold is converted
 * before italic so `**x**` cannot be read as an empty italic run.
 *
 * A literal occurrence of the {@link CODE_SPAN_SENTINEL} character in the
 * OPERATOR's own input (a private-use-area code point, legal Unicode but
 * exceedingly rare in prose) is neutralised to its numeric HTML entity
 * before any placeholder is inserted.  Without this, operator text
 * containing that exact character could coincidentally match
 * {@link CODE_SPAN_RESTORE}'s `sentinel-digits-sentinel` pattern and be
 * silently deleted or swapped for an unrelated code span — a private,
 * user-supplied character corrupting content it never targeted.
 */
function renderInline(text: string): string {
  const codeSpans: string[] = [];
  const escaped = escapeHtml(text).split(CODE_SPAN_SENTINEL).join("&#xE000;");
  const masked = escaped.replace(CODE_MARK_RENDER, (_match, inner: string) => {
    codeSpans.push(`<code>${inner}</code>`);
    return `${CODE_SPAN_SENTINEL}${codeSpans.length - 1}${CODE_SPAN_SENTINEL}`;
  });
  return masked
    .replace(BOLD_MARK_RENDER, "<strong>$1</strong>")
    .replace(ITALIC_MARK_RENDER, "$1<em>$2</em>")
    .replace(CODE_SPAN_RESTORE, (_match, index: string) => codeSpans[Number(index)] ?? "");
}

function renderTaskListItems(items: readonly TaskListItem[], listKind: NotesnookListKind): string {
  // The simple-checklist shape uses `<ul class="simple-checklist">` with
  // `simple-checklist--item` rows; the rich task-list shape uses
  // `<ul class="checklist">` with `checklist--item` rows.  Both keep the
  // same item payload (`<p>…</p>` plus nested children) so the codec
  // emits one structural helper per kind.
  const ulClass = listKind === "task-list" ? "checklist" : "simple-checklist";
  const itemClass = listKind === "task-list" ? "checklist--item" : "simple-checklist--item";
  let out = "";
  for (const item of items) {
    const className = item.checked ? `checked ${itemClass}` : itemClass;
    const text = renderInline(item.text);
    out += `<li class="${className}"><p>${text}</p>`;
    if (item.children.length > 0) {
      // Nested children inherit the same listKind so every depth uses
      // the same class pair.
      out += `<ul class="${ulClass}">${renderTaskListItems(item.children, listKind)}</ul>`;
    }
    out += "</li>";
  }
  return out;
}

/**
 * Render a block made entirely of task-list item lines as a (possibly
 * nested) Notesnook checklist tree.  The structural class pair follows
 * `listKind`: `simple-checklist` emits `<ul class="simple-checklist">`,
 * `task-list` emits `<ul class="checklist">`.  Returns an empty
 * checklist for an empty block; callers should never invoke this with
 * no lines because `renderBlock` only dispatches here when every line
 * matched {@link TASK_LIST_LINE}.
 *
 * Item text is escaped with the existing {@link escapeHtml} pass so
 * operator input cannot become markup; the structural checklist tokens
 * are emitted by the codec itself and are never re-escaped.
 */
function renderTaskListBlock(lines: readonly string[], listKind: NotesnookListKind): string {
  const roots = parseTaskListLines(lines);
  const ulClass = listKind === "task-list" ? "checklist" : "simple-checklist";
  return `<ul class="${ulClass}">${renderTaskListItems(roots, listKind)}</ul>`;
}

/**
 * Escape HTML-significant bytes ONLY — unlike {@link escapeHtml}, a tab
 * stays a tab.  `escapeHtml`'s tab-to-four-spaces substitution exists for
 * task-list/paragraph text, where a leading tab is an indentation cue
 * being normalised for display.  A fenced code block's body is verbatim
 * source content: a real tab character in someone's code is meaningful,
 * byte-for-byte content, not an indentation cue to reinterpret.
 */
function escapeCodeBody(text: string): string {
  let out = "";
  for (const character of text) {
    switch (character) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "'":
        out += "&#39;";
        break;
      default:
        out += character;
    }
  }
  return out;
}

/**
 * Render a fenced code block.  The body is escaped but never treated as
 * Markdown: no inline marks, no nested block parsing, and — unlike every
 * other block kind — no tab-to-spaces normalisation, since a code body is
 * verbatim content.  A bounded `language-<tag>` class is emitted only
 * when the opening fence carried one, matching the pinned runtime's
 * code-block convention.
 */
function renderCodeBlock(lines: readonly string[]): string {
  const open = CODE_FENCE_OPEN.exec(lines[0] as string);
  if (open === null || lines[lines.length - 1] !== "```" || lines.length < 2) refuse();
  const body = lines.slice(1, -1).join("\n");
  const language = open[1];
  const classAttr = language ? ` class="language-${language}"` : "";
  return `<pre><code${classAttr}>${escapeCodeBody(body)}</code></pre>`;
}

/**
 * Render a blockquote.  Every line loses its `> ` (or bare `>`) prefix,
 * runs through {@link renderInline} for marks, and is joined with
 * `<br />` — the same in-block line-join convention the plain paragraph
 * branch uses.
 *
 * KNOWN, DELIBERATE LIMITATION: a quoted line's content is rendered
 * inline-only (bold/italic/code marks), never as nested block structure —
 * `> # Heading` becomes a quoted line reading literally "# Heading", not a
 * heading nested inside the quote.  This is a documented scope boundary
 * for Wave 1 (top-level structural blocks), not a fidelity-gate
 * violation: {@link classifyBlockConstruct} classifies such a block as
 * exactly "blockquote" and nothing else, so detection and rendering agree
 * on what it is — the renderer just cannot yet express recursive block
 * nesting inside a quote.  A future wave can extend this without breaking
 * the fidelity gate's contract.  The single wrapping `<p>` this produces
 * still decodes safely on read-back (paragraphs support inline marks in
 * the native decoder); it is a feature gap, not a round-trip hazard.
 */
function renderBlockquote(lines: readonly string[]): string {
  const inner = lines.map((line) => renderInline(line.replace(/^> ?/, ""))).join("<br />");
  return `<blockquote><p>${inner}</p></blockquote>`;
}

/**
 * Render a Markdown table.  `rows[0]` is the header row and `rows[1]` is
 * the already-validated separator row (column count already confirmed to
 * match the header by {@link parseTableBlockRows}); every following body
 * row's column count must also match the header's, or the write is
 * refused before any mutation (a ragged table has no safe native shape
 * to fall back to).
 *
 * Cell text is escaped only — no inline marks (bold/italic/code) — even
 * though {@link renderInline} could express them.  The pinned runtime's
 * native decoder (`note-document-native.ts`) requires a table cell to be
 * text-only (a bare `<p>` or plain text child): the instant a cell holds
 * a `<strong>`/`<em>`/`<code>` element, the decoder cannot express it and
 * preserves the ENTIRE table as one opaque, no-longer-structurally-
 * editable blob on the next read.  Escaping-only here keeps every table
 * this codec writes fully decodable.
 */
function renderTableBlock(rows: readonly (readonly string[])[]): string {
  const header = rows[0] as readonly string[];
  const bodyRows = rows.slice(2);
  for (const row of bodyRows) {
    if (row.length !== header.length) refuse();
  }
  const headCells = header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("");
  const bodyHtml = bodyRows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${headCells}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

/**
 * Dispatch order MUST match {@link classifyBlockConstruct} exactly: both
 * functions see the same block boundaries from {@link splitBlocks} and
 * must agree on what a block is, or the fidelity gate's promise (a
 * supported construct always renders as that construct) breaks again.
 */
function renderBlock(block: string, listKind: NotesnookListKind): string {
  const lines = block.split("\n");
  const first = lines[0] ?? "";

  if (isHorizontalRuleBlock(lines)) {
    return "<hr />";
  }

  if (isFencedCodeBlock(lines)) {
    return renderCodeBlock(lines);
  }

  if (isBlockquoteBlock(lines)) {
    return renderBlockquote(lines);
  }

  const tableRows = parseTableBlockRows(lines);
  if (tableRows !== null) {
    return renderTableBlock(tableRows);
  }

  const heading = /^(#{1,3}) +(.*)$/.exec(first);
  if (heading !== null && lines.length === 1) {
    const level = (heading[1] as string).length;
    return `<h${level}>${renderInline(heading[2] as string)}</h${level}>`;
  }

  // A block is treated as a task-list only when EVERY non-empty line is a
  // recognisable `- [ ]` / `- [x]` / `- [X]` item (with optional leading
  // indentation for nested children).  Mixed blocks fall through to the
  // generic list / paragraph renderer so the adapter never silently
  // downgrades an unsupported shape into a checklist.  The structural
  // class pair depends on `listKind`.
  const isTaskList = lines.every((line) => TASK_LIST_LINE.test(line));
  if (isTaskList) {
    return renderTaskListBlock(lines, listKind);
  }

  const isList = lines.every((line) => /^[-*] +/.test(line));
  if (isList) {
    const items = lines
      .map((line) => `<li>${renderInline(line.replace(/^[-*] +/, ""))}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  return `<p>${lines.map((line) => renderInline(line)).join("<br />")}</p>`;
}

function renderMarkdown(markdown: string, listKind: NotesnookListKind): string {
  const blocks = splitBlocks(markdown);
  if (blocks.length === 0) return "<p></p>";
  return blocks.map((block) => renderBlock(block, listKind)).join("");
}

function boundedStored(type: "tiptap" | "html", data: string): NotesnookStoredContent {
  if (Buffer.byteLength(data, "utf8") > MAX_STORED_BYTES) refuse();
  return Object.freeze({ type, data });
}

/**
 * Build the production {@link NotesnookWriteMarkdownCodec}.
 *
 * The returned object is frozen and stateless, so a single instance can be
 * shared by every write capability without cross-request coupling.
 *
 * `encodeMarkdown` emits `type: "tiptap"` because the pinned runtime stores
 * note content as a Tiptap-compatible HTML string; the adapter re-pins the
 * stored type to the note's existing slot type on update, so this default
 * only ever applies to a freshly created note.
 */
/**
 * Append a Markdown fragment to a stored Tiptap/HTML document.
 *
 * Tiptap stored content is a self-contained `<div data-type="document">…</div>`
 * (or a top-level node equivalent). Concatenating a freshly rendered
 * `<p>…</p>` onto a stored Tiptap document leaves the result syntactically
 * invalid — a new top-level block must be appended inside the document root.
 *
 * HTML stored content is concatenated verbatim because a Notesnook HTML slot is
 * an arbitrary `<div>…</div>` whose internal tree can already be malformed
 * without breaking subsequent reads; the existing test suite codifies that
 * contract.
 */
function appendStored(
  storedType: "tiptap" | "html",
  storedData: string,
  fragmentHtml: string,
): string {
  if (storedType === "tiptap") {
    const trailingMatch = /<\/div>\s*$/.exec(storedData);
    if (trailingMatch === null) return `${storedData}${fragmentHtml}`;
    const head = storedData.slice(0, storedData.length - trailingMatch[0].length);
    return `${head}${fragmentHtml}</div>`;
  }
  return `${storedData}${fragmentHtml}`;
}

export function createDeterministicMarkdownCodec(): NotesnookWriteMarkdownCodec {
  return Object.freeze({
    encodeMarkdown: (markdown: string, listKind?: NotesnookListKind): NotesnookStoredContent => {
      const safe = requireBoundedMarkdown(markdown, STAGE4_WRITE_LIMITS.maxContentBytes);
      // Resolve the selector up-front so an out-of-set value is rejected
      // BEFORE any HTML is generated.  `undefined` selects the published
      // default (`simple-checklist`) so existing callers that never
      // supply the selector see the same stored HTML they did before.
      const resolvedKind = normaliseNotesnookListKind(listKind);
      return boundedStored(
        "tiptap",
        `<div data-type="document">${renderMarkdown(safe, resolvedKind)}</div>`,
      );
    },
    appendMarkdownToStoredContent: (input: {
      readonly storedType: "tiptap" | "html";
      readonly storedData: string;
      readonly markdownFragment: string;
      readonly listKind?: NotesnookListKind;
    }): NotesnookStoredContent => {
      if (typeof input !== "object" || input === null) refuse();
      const storedType = requireStoredType((input as { storedType?: unknown }).storedType);
      const storedData = requireBoundedStoredData((input as { storedData?: unknown }).storedData);
      const fragment = requireBoundedMarkdown(
        (input as { markdownFragment?: unknown }).markdownFragment,
        STAGE4_WRITE_LIMITS.maxFragmentBytes,
      );
      const resolvedKind = normaliseNotesnookListKind((input as { listKind?: unknown }).listKind);
      // Exactly one appended block; the existing stored bytes are preserved
      // byte-for-byte ahead of it and are never re-parsed.
      return boundedStored(
        storedType,
        appendStored(storedType, storedData, renderMarkdown(fragment, resolvedKind)),
      );
    },
  });
}

/** Shared frozen production codec instance. */
export const DETERMINISTIC_MARKDOWN_CODEC: NotesnookWriteMarkdownCodec =
  createDeterministicMarkdownCodec();
