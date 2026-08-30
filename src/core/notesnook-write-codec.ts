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
export function createDeterministicMarkdownCodec(): NotesnookWriteMarkdownCodec {
  return Object.freeze({
    encodeMarkdown: (markdown: string): NotesnookStoredContent => {
      const safe = requireBoundedMarkdown(markdown, STAGE4_WRITE_LIMITS.maxContentBytes);
      return boundedStored("tiptap", renderMarkdown(safe));
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
      return boundedStored(storedType, `${storedData}${renderMarkdown(fragment)}`);
    },
  });
}

/** Shared frozen production codec instance. */
export const DETERMINISTIC_MARKDOWN_CODEC: NotesnookWriteMarkdownCodec =
  createDeterministicMarkdownCodec();
