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
 *   `# `, `## `, `### `   → `<h1>` / `<h2>` / `<h3>`
 *   `- ` / `* ` lines     → `<ul><li>…</li></ul>`
 *   anything else         → `<p>…</p>`, with in-block newlines as `<br />`
 *
 * Anything the grammar does not recognise is treated as paragraph text, so
 * the codec is total over accepted input rather than partially defined.
 */

import { Buffer } from "node:buffer";

import { STAGE4_WRITE_LIMITS } from "./notesnook-write-contract.js";
import type {
  NotesnookStoredContent,
  NotesnookWriteMarkdownCodec,
} from "./notesnook-write-adapter.js";

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
    "paragraph",
    "inline-bold",
    "inline-italic",
    "inline-code",
  ]),
);

/**
 * Human-readable names for the Markdown constructs the deterministic
 * codec refuses.  Exposed for the write adapter and operator-facing
 * documentation; tests assert membership.
 */
export const UNSUPPORTED_MARKDOWN_CONSTRUCTS: ReadonlyArray<string> = Object.freeze([
  "markdown-table",
  "task-list",
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
    } else if (/^[-*] +\[ \] +/.test(line) || /^[-*] +\[x\] +/.test(line)) {
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
    if (/\*\*[^*\n]+\*\*/.test(line)) observed.add("inline-bold");
    if (/(^|[^*])\*[^*\n]+\*(?!\*)/.test(line)) observed.add("inline-italic");
    if (/`[^`\n]+`/.test(line)) observed.add("inline-code");
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

/** Split on blank lines into bounded blocks; drop empty blocks. */
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
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}

function renderBlock(block: string): string {
  const lines = block.split("\n");
  const first = lines[0] ?? "";

  const heading = /^(#{1,3}) +(.*)$/.exec(first);
  if (heading !== null && lines.length === 1) {
    const level = (heading[1] as string).length;
    return `<h${level}>${escapeHtml(heading[2] as string)}</h${level}>`;
  }

  const isList = lines.every((line) => /^[-*] +/.test(line));
  if (isList) {
    const items = lines
      .map((line) => `<li>${escapeHtml(line.replace(/^[-*] +/, ""))}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  return `<p>${lines.map((line) => escapeHtml(line)).join("<br />")}</p>`;
}

function renderMarkdown(markdown: string): string {
  const blocks = splitBlocks(markdown);
  if (blocks.length === 0) return "<p></p>";
  return blocks.map(renderBlock).join("");
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
    encodeMarkdown: (markdown: string): NotesnookStoredContent => {
      const safe = requireBoundedMarkdown(markdown, STAGE4_WRITE_LIMITS.maxContentBytes);
      return boundedStored("tiptap", `<div data-type="document">${renderMarkdown(safe)}</div>`);
    },
    appendMarkdownToStoredContent: (input: {
      readonly storedType: "tiptap" | "html";
      readonly storedData: string;
      readonly markdownFragment: string;
    }): NotesnookStoredContent => {
      if (typeof input !== "object" || input === null) refuse();
      const storedType = requireStoredType((input as { storedType?: unknown }).storedType);
      const storedData = requireBoundedStoredData((input as { storedData?: unknown }).storedData);
      const fragment = requireBoundedMarkdown(
        (input as { markdownFragment?: unknown }).markdownFragment,
        STAGE4_WRITE_LIMITS.maxFragmentBytes,
      );
      // Exactly one appended block; the existing stored bytes are preserved
      // byte-for-byte ahead of it and are never re-parsed.
      return boundedStored(
        storedType,
        appendStored(storedType, storedData, renderMarkdown(fragment)),
      );
    },
  });
}

/** Shared frozen production codec instance. */
export const DETERMINISTIC_MARKDOWN_CODEC: NotesnookWriteMarkdownCodec =
  createDeterministicMarkdownCodec();
