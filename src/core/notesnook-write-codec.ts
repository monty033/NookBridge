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

/** Accept only bounded plain text: no NUL, no C0 controls except `\n`/`\t`. */
function requireBoundedMarkdown(value: unknown, maxBytes: number): string {
  if (typeof value !== "string") refuse();
  if (Buffer.byteLength(value, "utf8") > maxBytes) refuse();
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) refuse();
  }
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
  | "fenced-code-block"
  | "link-or-image"
  | "attachment-reference"
  | "inline-html";

/**
 * The closed list of Markdown constructs the codec supports.  Anything
 * detected in the input that is not in this set triggers a refusal.
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
  "markdown-table",
  "attachment-reference",
  "fenced-code-block",
  "link-or-image",
  "inline-html",
]);

/**
 * Detect every construct in `markdown`.  Throws when the input is not a
 * bounded string; otherwise returns the frozen set of detected
 * constructs.  The detection is total over accepted input.
 */
export function detectMarkdownConstructs(
  markdown: string,
  maxBytes: number,
): ReadonlySet<MarkdownConstruct> {
  const safe = requireBoundedMarkdown(markdown, maxBytes);
  const observed = new Set<MarkdownConstruct>();
  const lines = safe.split("\n");
  for (const line of lines) {
    if (/^#{1,3} +/.test(line)) {
      const level = line.startsWith("### ") ? 3 : line.startsWith("## ") ? 2 : 1;
      observed.add(level === 1 ? "heading-1" : level === 2 ? "heading-2" : "heading-3");
    } else if (/^[-*] +\[( |x|X)\] +/.test(line)) {
      observed.add("task-list");
    } else if (/^[-*] +/.test(line)) {
      observed.add("unordered-list");
    } else if (/^\|.+\|/.test(line) || /^\s*-{3,}\s*$/.test(line)) {
      observed.add("markdown-table");
    } else if (line.trim().length > 0) {
      observed.add("paragraph");
    }
    if (/!\[[^\]\n]*\]\([^)\n]*\)/.test(line)) observed.add("attachment-reference");
    if (/!\[\[[^\]\n]*\]\]/.test(line)) observed.add("attachment-reference");
    if (/```/.test(line)) observed.add("fenced-code-block");
    if (/\[[^\]\n]+\]\([^)\n]+\)/.test(line)) observed.add("link-or-image");
    if (BOLD_MARK_DETECT.test(line)) observed.add("inline-bold");
    if (ITALIC_MARK_DETECT.test(line)) observed.add("inline-italic");
    if (CODE_MARK_DETECT.test(line)) observed.add("inline-code");
    if (/<[a-zA-Z][^>\n]*>/.test(line)) observed.add("inline-html");
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

/** Split on blank lines and structural Markdown transitions into bounded blocks. */
function splitBlocks(markdown: string): readonly string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of markdown.split("\n")) {
    if (line.trim().length === 0) {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    const startsHeading = isHeadingLine(line);
    const startsTaskList = isTaskListLine(line);
    const currentHasNonTaskLine = current.some((currentLine) => !isTaskListLine(currentLine));
    if (current.length > 0 && (startsHeading || (startsTaskList && currentHasNonTaskLine))) {
      blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
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
 */
function renderInline(text: string): string {
  const codeSpans: string[] = [];
  const masked = escapeHtml(text).replace(CODE_MARK_RENDER, (_match, inner: string) => {
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

function renderBlock(block: string, listKind: NotesnookListKind): string {
  const lines = block.split("\n");
  const first = lines[0] ?? "";

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
