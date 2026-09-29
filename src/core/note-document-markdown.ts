/**
 * T02 canonical, deliberately restricted Markdown interchange (not CommonMark).
 * LF, one blank line between blocks, one final newline, fixed version header.
 * Marks: **bold**, *italic*, __underline__, ~~strike~~, `code`, [link](URL).
 * Task indentation is two spaces; an optional `:::nookbridge list KIND`
 * wrapper preserves explicit per-list intent. Tables contain one canonical JSON
 * object; callouts contain blocks. Directives close with `:::` and nest.
 * Links allow only http, https and mailto, without embedded credentials.
 * A horizontal rule is a COMPLETE standalone `---` block (exactly three
 * dashes, nothing else on the line): it is recognised only when it forms an
 * entire block by itself, never mid-paragraph, and never as a table
 * horizontal rule (the grammar requires blank-line block separators); an
 * unescaped `---` embedded in paragraph text is rejected as ambiguous.
 * Escape a literal `---` paragraph line as `\\-\\-\\-` so it cannot collide
 * with the structural form. This grammar has no pipe-table syntax, so no
 * table-delimiter collision is possible.
 * Image, attachment and embed are closed, versioned directives —
 * `:::nookbridge image 1`, `:::nookbridge attachment 1`, and
 * `:::nookbridge embed 1` — each carrying exactly one canonical JSON object
 * with the node's closed key set (see `note-document.ts`). They are
 * structured references only (bounded http(s) URL plus optional bounded
 * labels), never binary payloads, local paths, or raw HTML; an unrecognised
 * version token or any extra/duplicate JSON key is a categorical refusal.
 * Ordinary bullet/ordered list continuation blocks are represented by two-space-indented nested list lines; other continuation block types remain outside this subset.
 * unsupported/ambiguous syntax uses the existing categorical AST errors.
 * `math` has no interchange form yet (native-block-parity plan Task 3.1
 * is an unmet prerequisite) — it is refused the same as any other unknown
 * discriminator, never guessed.
 * Opaque bodies are `ref:1:SOURCE:TOKEN`, never native data or JSON.
 *
 * Parsing refuses noncanonical spellings rather than silently normalizing an
 * edit. No source cache or hidden AST metadata is needed for byte stability.
 * A trusted, revision-bound preimage from the daemon is REQUIRED to accept any
 * opaque reference. This codec checks identity and structural position; T07
 * must bind that preimage to the originating note/revision before mutation.
 * Native/frame/journal budgets belong to their respective encoders (T00 D9).
 */
import { Buffer } from "node:buffer";
import { types } from "node:util";
import { URL } from "node:url";
import {
  NoteDocumentError,
  isNoteDocumentError,
  validateNoteDocument,
  MAX_NOTE_DOCUMENT_BLOCKS,
  MAX_NOTE_DOCUMENT_BLOCK_BYTES,
  MAX_NOTE_DOCUMENT_DEPTH,
  MAX_NOTE_DOCUMENT_INLINE_BYTES,
  MAX_NOTE_DOCUMENT_INLINES_PER_BLOCK,
  MAX_NOTE_DOCUMENT_LIST_ITEMS_PER_LIST,
  MAX_NOTE_DOCUMENT_OPAQUE_SENTINEL_BYTES,
  type NoteDocumentErrorCode,
  type NoteDocumentV1,
  type NoteBlock,
  type NoteInline,
  type NoteInlineMark,
  type NoteTaskItem,
} from "./note-document.js";

export const NOTE_DOCUMENT_MARKDOWN_HEADER = "---\nnookbridge-format: 1\n---\n";
export const MAX_NOTE_DOCUMENT_MARKDOWN_BYTES = 4 * 1024 * 1024;
export interface NoteDocumentMarkdownOptions {
  readonly preimage?: NoteDocumentV1;
}
function fail(code: NoteDocumentErrorCode = "invalid_shape"): never {
  throw new NoteDocumentError(code);
}
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
function bounded(s: string, max: number, code: NoteDocumentErrorCode): void {
  if (bytes(s) > max) fail(code);
}
function clean(s: string): void {
  for (const character of s) {
    const cp = character.codePointAt(0)!;
    if ((cp < 32 && cp !== 9 && cp !== 10) || cp === 127 || (cp >= 0xd800 && cp <= 0xdfff)) fail();
  }
}

function guard<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (isNoteDocumentError(error)) throw error;
    return fail();
  }
}

// Inspect own data descriptors before the T01 validator ever reads a property.
// Proxies, accessors, cycles, sparse arrays, foreign prototypes and excessive
// work are refused without invoking user code (including toJSON).
function snapshot(value: unknown): unknown {
  const active = new Set<object>();
  let count = 0;
  let size = 0;
  function visit(v: unknown, depth: number): unknown {
    if (++count > 200_000) fail("oversize_document");
    if (typeof v === "string") {
      clean(v);
      size += bytes(v);
      if (size > MAX_NOTE_DOCUMENT_MARKDOWN_BYTES) fail("oversize_document");
      return v;
    }
    if (v === null || typeof v === "number" || typeof v === "boolean" || v === undefined) return v;
    if (typeof v !== "object" || types.isProxy(v) || active.has(v)) fail();
    if (depth > MAX_NOTE_DOCUMENT_DEPTH * 4 + 8) fail("depth_exceeded");
    const array = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail();
    active.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(descriptors).length > 200_000) fail("oversize_document");
    const out: Record<string, unknown> | unknown[] = array
      ? []
      : (Object.create(null) as Record<string, unknown>);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))
        fail();
      const d = descriptors[key]!;
      if (!("value" in d)) fail();
      if (array && key === "length") continue;
      if (!d.enumerable || (array && !/^(0|[1-9][0-9]*)$/.test(key))) fail();
      Object.defineProperty(out, key, {
        value: visit(d.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    if (array && (out as unknown[]).length !== descriptors.length?.value) fail();
    if (array && Object.keys(out).length !== (out as unknown[]).length) fail();
    active.delete(v);
    return out;
  }
  return visit(value, 0);
}
function keys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some((k) => !allowed.includes(k))) fail();
}
/**
 * Canonical JSON body for the `image` / `attachment` / `embed` reference
 * directives. `undefined`-valued fields are dropped (never emitted as an
 * explicit `"key":null`-shaped placeholder), so the SAME helper produces the
 * canonical text on both the encode side (from a validated AST block, where
 * every field is either a real string or absent) and the decode side (used
 * to reject any raw JSON that does not literally match this canonical
 * shape — duplicate keys, alternate key order, or an extra field all fail
 * the byte comparison before the value is ever trusted). Field order is
 * always the caller's insertion order, so callers must list `url` before
 * any optional label to stay byte-stable across releases.
 */
function refBody(fields: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    if (fields[key] !== undefined) out[key] = fields[key];
  }
  return JSON.stringify(out);
}
function safeDocument(value: unknown): NoteDocumentV1 {
  const doc = snapshot(value);
  validateNoteDocument(doc);
  keys(doc, ["version", "blocks"]);
  return doc;
}
function href(s: string): string {
  if (!/^(https?:\/\/|mailto:)[^\s<>()[\]\\]+$/.test(s)) fail("malformed_link");
  try {
    const url = new URL(s);
    if (url.username || url.password || (url.protocol !== "mailto:" && !url.hostname))
      fail("malformed_link");
  } catch {
    fail("malformed_link");
  }
  return s;
}
const delimiters: Record<string, string> = {
  bold: "**",
  italic: "*",
  underline: "__",
  strike: "~~",
};
function escapeText(s: string): string {
  return s
    .replace(/[\\*_~`[\]<>]/g, "\\$&")
    .replace(/^(?=[#>:+!|]|- |\d+\. )/gm, "\\")
    .replace(/^---$/gm, "\\-\\-\\-");
}
function fence(s: string): string {
  let length = 2;
  for (const m of s.matchAll(/`+/g)) length = Math.max(length, m[0].length);
  return "`".repeat(length + 1);
}
function inlineCode(s: string): string {
  if (!s || s.includes("\n") || s.startsWith("`") || s.endsWith("`")) fail();
  let n = 0;
  for (const m of s.matchAll(/`+/g)) n = Math.max(n, m[0].length);
  const d = "`".repeat(n + 1);
  return d + s + d;
}
function renderInlines(inlines: readonly NoteInline[]): string {
  let out = "";
  let open: NoteInlineMark[] = [];
  const same = (a: NoteInlineMark, b: NoteInlineMark) => JSON.stringify(a) === JSON.stringify(b);
  const close = (m: NoteInlineMark) =>
    typeof m === "string" ? (delimiters[m] ?? fail("unsupported_mark")) : `](${href(m.href)})`;
  for (const inline of inlines) {
    keys(inline, ["text", "marks"]);
    const marks = [...(inline.marks ?? [])];
    if (new Set(marks.map((m) => (typeof m === "string" ? m : "link"))).size !== marks.length)
      fail("unsupported_mark");
    for (const m of marks)
      if (typeof m !== "string") {
        keys(m, ["type", "href"]);
        href(m.href);
      }
    const code = marks.indexOf("code");
    if (code !== -1 && code !== marks.length - 1) fail("unsupported_mark");
    if (code !== -1) marks.pop();
    if (marks.filter((m) => typeof m !== "string").length > 1) fail("unsupported_mark");
    let shared = 0;
    while (shared < open.length && shared < marks.length && same(open[shared]!, marks[shared]!))
      shared++;
    for (let i = open.length - 1; i >= shared; i--) out += close(open[i]!);
    for (let i = shared; i < marks.length; i++) {
      const m = marks[i]!;
      out += typeof m === "string" ? (delimiters[m] ?? fail("unsupported_mark")) : "[";
    }
    out += code === -1 ? escapeText(inline.text) : inlineCode(inline.text);
    open = marks;
  }
  for (let i = open.length - 1; i >= 0; i--) out += close(open[i]!);
  return out;
}
function parseInlines(s: string): NoteInline[] {
  let pos = 0;
  const out: NoteInline[] = [];
  function add(text: string, marks: NoteInlineMark[]): void {
    if (!text) return;
    const last = out.at(-1);
    if (last && JSON.stringify(last.marks ?? []) === JSON.stringify(marks))
      out[out.length - 1] = { ...last, text: last.text + text };
    else out.push(marks.length ? { text, marks: [...marks] } : { text });
    if (out.length > MAX_NOTE_DOCUMENT_INLINES_PER_BLOCK) fail("oversize_inline");
    bounded(out.at(-1)!.text, MAX_NOTE_DOCUMENT_INLINE_BYTES, "oversize_inline");
  }
  function sequence(marks: NoteInlineMark[], stop?: string): void {
    if (marks.length > 6) fail("unsupported_mark");
    let text = "";
    const flush = () => {
      add(text, marks);
      text = "";
    };
    while (pos < s.length) {
      if (stop && s.startsWith(stop, pos)) {
        flush();
        pos += stop.length;
        return;
      }
      const c = s[pos]!;
      if (c === "\\") {
        pos++;
        if (pos >= s.length || !/[\\*_~`[\]<>#:+!|.\->]/.test(s[pos]!)) fail();
        text += s[pos++]!;
        continue;
      }
      if (c === "`") {
        flush();
        const d = /^`+/.exec(s.slice(pos))![0];
        pos += d.length;
        const end = s.indexOf(d, pos);
        if (end === -1) fail();
        const content = s.slice(pos, end);
        if (!content || content.includes("\n")) fail();
        add(content, [...marks, "code"]);
        pos = end + d.length;
        continue;
      }
      if (c === "[") {
        flush();
        if (marks.some((m) => typeof m !== "string")) fail("malformed_link");
        pos++;
        const start = out.length;
        sequence([...marks, { type: "link", href: "pending" }], "]");
        if (s[pos++] !== "(") fail("malformed_link");
        const end = s.indexOf(")", pos);
        if (end === -1) fail("malformed_link");
        const url = href(s.slice(pos, end));
        pos = end + 1;
        for (let i = start; i < out.length; i++)
          out[i] = {
            ...out[i]!,
            marks: out[i]!.marks!.map((m) =>
              typeof m !== "string" && m.href === "pending" ? { type: "link", href: url } : m,
            ),
          };
        continue;
      }
      const match = Object.entries(delimiters).find(([, d]) => s.startsWith(d, pos));
      if (match) {
        flush();
        if (marks.includes(match[0])) fail("unsupported_mark");
        pos += match[1].length;
        sequence([...marks, match[0]], match[1]);
        continue;
      }
      if (/[\]<>*_~]/.test(c)) fail();
      text += c;
      pos++;
    }
    flush();
    if (stop) fail();
  }
  sequence([]);
  return out;
}

function renderBlocks(blocks: readonly NoteBlock[], depth = 1): string {
  if (depth > MAX_NOTE_DOCUMENT_DEPTH) fail("depth_exceeded");
  return blocks
    .map((block) => {
      let out: string;
      switch (block.type) {
        case "paragraph":
        case "heading":
          keys(
            block,
            block.type === "heading" ? ["type", "level", "inlines"] : ["type", "inlines"],
          );
          if (!block.inlines.length) fail("unsupported_node");
          out =
            (block.type === "heading" ? "#".repeat(block.level) + " " : "") +
            renderInlines(block.inlines);
          break;
        case "code-block": {
          keys(block, ["type", "text", "language"]);
          bounded(block.text, MAX_NOTE_DOCUMENT_INLINE_BYTES, "oversize_inline");
          if (block.language !== undefined && !/^[A-Za-z0-9_+-]+$/.test(block.language)) fail();
          const d = fence(block.text);
          out = d + (block.language ?? "") + "\n" + block.text + "\n" + d;
          break;
        }
        case "table":
          keys(block, ["type", "columns", "rows"]);
          out =
            ":::nookbridge table\n" +
            JSON.stringify({ columns: block.columns, rows: block.rows }) +
            "\n:::";
          break;
        case "callout":
          keys(block, ["type", "variant", "blocks"]);
          if (!block.blocks.length) fail("unsupported_node");
          out = `:::nookbridge callout ${block.variant}\n${renderBlocks(block.blocks, depth + 1)}\n:::`;
          break;
        case "blockquote":
          keys(block, ["type", "blocks"]);
          if (!block.blocks.length) fail("unsupported_node");
          out = renderBlocks(block.blocks, depth + 1)
            .split("\n")
            .map((line) => (line ? "> " + line : ">"))
            .join("\n");
          break;
        case "bullet-list":
        case "ordered-list": {
          keys(
            block,
            block.type === "ordered-list" ? ["type", "start", "items"] : ["type", "items"],
          );
          if (!block.items.length) fail("unsupported_node");
          const list = (current: typeof block, indent: number, level: number): string => {
            if (level > MAX_NOTE_DOCUMENT_DEPTH) fail("depth_exceeded");
            const start = current.type === "ordered-list" ? (current.start ?? 1) : 1;
            return current.items
              .map((item, i) => {
                keys(item, ["inlines", "blocks"]);
                const contents = renderInlines(item.inlines);
                if (!contents) fail("unsupported_node");
                const marker = start + i;
                if (!Number.isSafeInteger(marker)) fail("invalid_shape");
                const prefix = " ".repeat(indent);
                const markerText = current.type === "bullet-list" ? "- " : `${marker}. `;
                const nested = item.blocks ?? [];
                if (
                  nested.some(
                    (child) => child.type !== "bullet-list" && child.type !== "ordered-list",
                  )
                )
                  fail("unsupported_node");
                return (
                  prefix +
                  markerText +
                  contents +
                  (nested.length
                    ? "\n" +
                      nested
                        .map((child) => {
                          if (child.type !== "bullet-list" && child.type !== "ordered-list")
                            fail("unsupported_node");
                          return list(child, indent + 2, level + 1);
                        })
                        .join("\n")
                    : "")
                );
              })
              .join("\n");
          };
          out = list(block, 0, depth);
          break;
        }
        case "task-list": {
          keys(block, ["type", "kind", "items"]);
          if (!block.items.length) fail("unsupported_node");
          const tasks = (items: readonly NoteTaskItem[], level: number): string =>
            items
              .map((item) => {
                keys(item, ["checked", "inlines", "children"]);
                const contents = renderInlines(item.inlines);
                if (!contents) fail("unsupported_node");
                return (
                  "  ".repeat(level) +
                  `- [${item.checked ? "x" : " "}] ` +
                  contents +
                  (item.children.length ? "\n" + tasks(item.children, level + 1) : "")
                );
              })
              .join("\n");
          out = tasks(block.items, 0);
          if (block.kind !== undefined) out = `:::nookbridge list ${block.kind}\n${out}\n:::`;
          break;
        }
        case "opaque":
          keys(block, ["type", "nodeType", "sentinel"]);
          keys(block.sentinel, ["version", "source", "token"]);
          if (
            !/^[A-Za-z][A-Za-z0-9_-]*$/.test(block.nodeType) ||
            !/^[A-Za-z0-9_-]+$/.test(block.sentinel.token)
          )
            fail("opaque_payload_forbidden");
          bounded(
            block.sentinel.token,
            MAX_NOTE_DOCUMENT_OPAQUE_SENTINEL_BYTES,
            "oversize_sentinel",
          );
          out = `:::nookbridge opaque ${block.nodeType}\nref:1:${block.sentinel.source}:${block.sentinel.token}\n:::`;
          break;
        case "horizontal-rule":
          keys(block, ["type"]);
          out = "---";
          break;
        case "image":
          keys(block, ["type", "url", "alt"]);
          out = `:::nookbridge image 1\n${refBody({ url: block.url, alt: block.alt })}\n:::`;
          break;
        case "attachment":
          keys(block, ["type", "url", "name", "mime"]);
          out = `:::nookbridge attachment 1\n${refBody({ url: block.url, name: block.name, mime: block.mime })}\n:::`;
          break;
        case "embed":
          keys(block, ["type", "url"]);
          out = `:::nookbridge embed 1\n${refBody({ url: block.url })}\n:::`;
          break;
        default:
          // Every `NoteBlock` discriminator has an explicit case above
          // (native-block-parity plan, Task 1.2). This branch is a
          // defensive fallback only — a future AST addition (e.g. a
          // pinned-runtime `math` node, plan Task 3.1) must land its own
          // explicit case here rather than fall through silently to a
          // paragraph or any other downgrade.
          fail("unsupported_node");
      }
      bounded(out, MAX_NOTE_DOCUMENT_BLOCK_BYTES, "oversize_block");
      return out;
    })
    .join("\n\n");
}

class Parser {
  private pos = 0;
  private count = 0;
  constructor(private readonly lines: string[]) {}
  blocks(depth = 1, nested = false): NoteBlock[] {
    if (depth > MAX_NOTE_DOCUMENT_DEPTH) fail("depth_exceeded");
    const blocks: NoteBlock[] = [];
    while (this.pos < this.lines.length) {
      if (this.lines[this.pos] === ":::") {
        if (!nested) fail();
        this.pos++;
        return blocks;
      }
      if (++this.count > MAX_NOTE_DOCUMENT_BLOCKS) fail("oversize_document");
      const start = this.pos;
      const block = this.block(depth);
      blocks.push(block);
      bounded(
        this.lines.slice(start, this.pos).join("\n"),
        MAX_NOTE_DOCUMENT_BLOCK_BYTES,
        "oversize_block",
      );
      if (this.pos === this.lines.length) break;
      if (nested && this.lines[this.pos] === ":::") continue;
      if (this.lines[this.pos++] !== "") fail();
      if (this.pos === this.lines.length || this.lines[this.pos] === "") fail();
    }
    if (nested) fail();
    return blocks;
  }
  private block(depth: number): NoteBlock {
    const line = this.lines[this.pos++]!;
    if (line.startsWith(":::")) {
      if (line === ":::nookbridge table") {
        const json = this.lines[this.pos++] ?? fail();
        bounded(json, MAX_NOTE_DOCUMENT_BLOCK_BYTES, "oversize_block");
        // Canonical JSON comparison rejects duplicate keys (including escaped
        // aliases), extra fields and alternate encodings before use.
        let data: unknown;
        try {
          data = JSON.parse(json);
        } catch {
          fail();
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) fail();
        const d = data as Record<string, unknown>;
        keys(d, ["columns", "rows"]);
        const block = { type: "table", columns: d.columns, rows: d.rows };
        if (JSON.stringify({ columns: d.columns, rows: d.rows }) !== json) fail();
        if (this.lines[this.pos++] !== ":::") fail();
        validateNoteDocument({ version: 1, blocks: [block] });
        return block as NoteBlock;
      }
      const callout = /^:::nookbridge callout (\S+)$/.exec(line);
      if (callout) {
        if (!["info", "warning", "success", "danger"].includes(callout[1]!))
          fail("unsupported_callout_variant");
        return {
          type: "callout",
          variant: callout[1] as "info" | "warning" | "success" | "danger",
          blocks: this.blocks(depth + 1, true),
        };
      }
      const list = /^:::nookbridge list (\S+)$/.exec(line);
      if (list) {
        if (list[1] !== "simple-checklist" && list[1] !== "task-list")
          fail("unsupported_list_kind");
        const items = this.tasks(depth, 0);
        if (!items.length || this.lines[this.pos++] !== ":::") fail();
        return { type: "task-list", kind: list[1], items };
      }
      const opaque = /^:::nookbridge opaque ([A-Za-z][A-Za-z0-9_-]*)$/.exec(line);
      if (opaque) {
        const body = this.lines[this.pos++] ?? fail("opaque_payload_forbidden");
        const ref = /^ref:1:(native-html|native-tiptap):([A-Za-z0-9_-]+)$/.exec(body);
        if (!ref || this.lines[this.pos++] !== ":::") fail("opaque_payload_forbidden");
        bounded(ref[2]!, MAX_NOTE_DOCUMENT_OPAQUE_SENTINEL_BYTES, "oversize_sentinel");
        return {
          type: "opaque",
          nodeType: opaque[1]!,
          sentinel: {
            version: 1,
            source: ref[1] as "native-html" | "native-tiptap",
            token: ref[2]!,
          },
        };
      }
      const image = /^:::nookbridge image (\S+)$/.exec(line);
      if (image) return this.reference(image[1]!, "image", ["url", "alt"]);
      const attachment = /^:::nookbridge attachment (\S+)$/.exec(line);
      if (attachment) return this.reference(attachment[1]!, "attachment", ["url", "name", "mime"]);
      const embed = /^:::nookbridge embed (\S+)$/.exec(line);
      if (embed) return this.reference(embed[1]!, "embed", ["url"]);
      fail();
    }
    // A complete standalone `---` line (exactly three dashes, nothing else)
    // is the horizontal-rule block. It is only reachable here — after every
    // `:::` directive, before the code-fence/list/quote/heading checks —
    // so it can never be swallowed into a multi-line paragraph or confused
    // with a directive; this grammar has no pipe-table syntax, so there is
    // no table-delimiter row to disambiguate against either. Any other run
    // of dashes (`----`, `--`, `--- text`, …) falls through unchanged as
    // ordinary paragraph text.
    if (line === "---") return { type: "horizontal-rule" };
    const code = /^(`{3,})([A-Za-z0-9_+-]*)$/.exec(line);
    if (code) {
      const start = this.pos;
      while (this.pos < this.lines.length && this.lines[this.pos] !== code[1]) this.pos++;
      if (this.pos === this.lines.length) fail();
      const text = this.lines.slice(start, this.pos++).join("\n");
      bounded(text, MAX_NOTE_DOCUMENT_INLINE_BYTES, "oversize_inline");
      return { type: "code-block", text, ...(code[2] ? { language: code[2] } : {}) };
    }
    if (/^- \[[ x]\] /.test(line)) {
      this.pos--;
      return { type: "task-list", items: this.tasks(depth, 0) };
    }
    if (/^(?:- |\d+\. )/.test(line)) {
      this.pos--;
      const list = (indent: number, depth: number): NoteBlock => {
        if (depth > MAX_NOTE_DOCUMENT_DEPTH) fail("depth_exceeded");
        const first = /^( *)/.exec(this.lines[this.pos]!)![1]!.length;
        if (first !== indent) fail();
        const ordered = /^\s*\d+\. /.test(this.lines[this.pos]!);
        const items: { inlines: NoteInline[]; blocks?: NoteBlock[] }[] = [];
        let start: number | undefined;
        let returnedFromDeeperList = false;
        while (this.pos < this.lines.length) {
          const current = this.lines[this.pos]!;
          const spaces = /^( *)/.exec(current)![1]!.length;
          if (spaces < indent) break;
          if (spaces > indent) {
            if (spaces !== indent + 2 || items.length === 0) fail();
            const nestedMatch = /^(?:- |\d+\. )/.test(current.slice(spaces));
            if (!nestedMatch) fail();
            const nested = list(indent + 2, depth + 1);
            const last = items.at(-1)!;
            (last.blocks ??= []).push(nested);
            returnedFromDeeperList = true;
            continue;
          }
          const match = (ordered ? /^( *)(\d+)\. (.*)$/ : /^( *)- (.*)$/).exec(current);
          if (!match) break;
          if (items.length >= MAX_NOTE_DOCUMENT_LIST_ITEMS_PER_LIST) fail("oversize_document");
          const text = ordered ? match[3]! : match[2]!;
          if (ordered && items.length === 0) {
            const marker = Number(match[2]);
            if (!Number.isSafeInteger(marker)) fail("invalid_shape");
            start = marker;
          } else if (ordered) {
            const marker = Number(match[2]);
            const expected = (start as number) + items.length;
            if (
              !Number.isSafeInteger(marker) ||
              !Number.isSafeInteger(expected) ||
              marker !== expected
            ) {
              if (returnedFromDeeperList && indent > 0) break;
              fail("invalid_shape");
            }
          }
          items.push({ inlines: parseInlines(text) });
          this.pos++;
          returnedFromDeeperList = false;
        }
        return ordered
          ? {
              type: "ordered-list",
              ...(start === undefined || start === 1 ? {} : { start }),
              items,
            }
          : { type: "bullet-list", items };
      };
      const indent = /^( *)/.exec(line)![1]!.length;
      if (indent !== 0) fail();
      return list(indent, depth);
    }
    if (line === ">" || line.startsWith("> ")) {
      const quote = [line.slice(2)];
      while (this.pos < this.lines.length && /^>( |$)/.test(this.lines[this.pos]!))
        quote.push(this.lines[this.pos++]!.slice(2));
      return { type: "blockquote", blocks: new Parser(quote).blocks(depth + 1) };
    }
    const heading = /^(#{1,3}) (.*)$/.exec(line);
    if (heading)
      return {
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        inlines: parseInlines(heading[2]!),
      };
    const lines = [line];
    while (
      this.pos < this.lines.length &&
      this.lines[this.pos] !== "" &&
      this.lines[this.pos] !== ":::"
    )
      lines.push(this.lines[this.pos++]!);
    for (const l of lines) if (!l || /^\s|^(?:[#>:!|]|- |\d+\. |---$)/.test(l)) fail();
    return { type: "paragraph", inlines: parseInlines(lines.join("\n")) };
  }
  private tasks(depth: number, indent: number): NoteTaskItem[] {
    if (depth + 1 > MAX_NOTE_DOCUMENT_DEPTH) fail("depth_exceeded");
    const items: NoteTaskItem[] = [];
    while (this.pos < this.lines.length) {
      const m = /^( *)- \[([ x])\] (.*)$/.exec(this.lines[this.pos]!);
      if (!m || m[1]!.length < indent) break;
      if (m[1]!.length !== indent) fail();
      if (items.length >= MAX_NOTE_DOCUMENT_LIST_ITEMS_PER_LIST) fail("oversize_document");
      this.pos++;
      const inlines = parseInlines(m[3]!);
      const next = /^( +)- \[/.exec(this.lines[this.pos] ?? "");
      const children = next && next[1]!.length > indent ? this.tasks(depth + 1, indent + 2) : [];
      items.push({ checked: m[2] === "x", inlines, children });
    }
    return items;
  }
  /**
   * Shared decoder for the `image` / `attachment` / `embed` versioned
   * reference directives. `version` must be the exact literal `"1"` — any
   * other spelling (`"01"`, `"2"`, …) is a categorical refusal, not a
   * silent fallback, so a future format bump can add a new literal case
   * without reinterpreting old documents. The JSON body must canonicalize
   * byte-for-byte back to itself via {@link refBody} (rejecting duplicate
   * keys, extra fields, and alternate encodings exactly like the `table`
   * directive), and the resulting block is re-validated through the T01
   * validator so the closed key set, URL scheme policy, and byte caps are
   * enforced from a single source of truth.
   */
  private reference(
    version: string,
    type: "image" | "attachment" | "embed",
    allowed: readonly string[],
  ): NoteBlock {
    if (version !== "1") fail();
    const json = this.lines[this.pos++] ?? fail();
    bounded(json, MAX_NOTE_DOCUMENT_BLOCK_BYTES, "oversize_block");
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      fail();
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) fail();
    const d = data as Record<string, unknown>;
    keys(d, allowed);
    const fields: Record<string, unknown> = {};
    for (const key of allowed) fields[key] = d[key];
    if (refBody(fields) !== json) fail();
    const block: Record<string, unknown> = { type };
    for (const key of allowed) if (d[key] !== undefined) block[key] = d[key];
    if (this.lines[this.pos++] !== ":::") fail();
    validateNoteDocument({ version: 1, blocks: [block] });
    return block as unknown as NoteBlock;
  }
}
function references(doc: NoteDocumentV1): string[] {
  const refs: string[] = [];
  const tokens = new Set<string>();
  function walk(blocks: readonly NoteBlock[], path: string): void {
    blocks.forEach((b, i) => {
      const at = `${path}/${i}`;
      if (b.type === "opaque") {
        if (tokens.has(b.sentinel.token)) fail("opaque_payload_forbidden");
        tokens.add(b.sentinel.token);
        refs.push(
          JSON.stringify([at, b.nodeType, b.sentinel.version, b.sentinel.source, b.sentinel.token]),
        );
      }
      if (b.type === "callout" || b.type === "blockquote")
        walk(b.blocks, `${at}/${b.type}${b.type === "callout" ? "/" + b.variant : ""}`);
      if (b.type === "bullet-list" || b.type === "ordered-list")
        b.items.forEach((item, j) => walk(item.blocks ?? [], `${at}/${b.type}/${j}`));
    });
  }
  walk(doc.blocks, "");
  return refs;
}
function emit(doc: NoteDocumentV1): string {
  const body = renderBlocks(doc.blocks);
  const result = NOTE_DOCUMENT_MARKDOWN_HEADER + (doc.blocks.length ? "\n" + body + "\n" : "");
  bounded(result, MAX_NOTE_DOCUMENT_MARKDOWN_BYTES, "oversize_document");
  return result;
}
function decode(input: string): NoteDocumentV1 {
  bounded(input, MAX_NOTE_DOCUMENT_MARKDOWN_BYTES, "oversize_document");
  clean(input);
  if (!input.startsWith(NOTE_DOCUMENT_MARKDOWN_HEADER)) fail();
  const rest = input.slice(NOTE_DOCUMENT_MARKDOWN_HEADER.length);
  if (!rest) return { version: 1, blocks: [] };
  if (!rest.startsWith("\n") || !rest.endsWith("\n")) fail();
  const doc: NoteDocumentV1 = {
    version: 1,
    blocks: new Parser(rest.slice(1, -1).split("\n")).blocks(),
  };
  return safeDocument(doc);
}
export function parseNoteDocumentMarkdown(
  input: unknown,
  options: NoteDocumentMarkdownOptions = {},
): NoteDocumentV1 {
  return guard(() => {
    if (typeof input !== "string") fail();
    const opts = snapshot(options) as NoteDocumentMarkdownOptions;
    if (!opts || typeof opts !== "object" || Array.isArray(opts)) fail();
    keys(opts, ["preimage"]);
    const preimage = opts.preimage === undefined ? undefined : safeDocument(opts.preimage);
    const doc = decode(input);
    if (JSON.stringify(references(doc)) !== JSON.stringify(preimage ? references(preimage) : []))
      fail("opaque_payload_forbidden");
    if (emit(doc) !== input) fail();
    return doc;
  });
}
// Compare semantic trees as well as rendered bytes. Coalescing adjacent text
// runs and dropping empty optional arrays are the only allowed normalization.
function semantics(value: unknown): string {
  function normalize(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(normalize);
    if (!v || typeof v !== "object") return v;
    const record = v as Record<string, unknown>;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(record).sort()) {
      const field = record[k];
      if (field === undefined || (k === "marks" && Array.isArray(field) && !field.length)) continue;
      if (
        k === "blocks" &&
        !("type" in record) &&
        !("version" in record) &&
        Array.isArray(field) &&
        !field.length
      )
        continue;
      if (k === "inlines" && Array.isArray(field)) {
        const runs: { text: string; marks?: unknown }[] = [];
        for (const inline of field) {
          const run = normalize(inline) as { text: string; marks?: unknown };
          if (!run.text) continue;
          const last = runs.at(-1);
          if (last && JSON.stringify(last.marks) === JSON.stringify(run.marks))
            last.text += run.text;
          else runs.push(run);
        }
        result[k] = runs;
      } else result[k] = normalize(field);
    }
    return result;
  }
  return JSON.stringify(normalize(value));
}
export function serializeNoteDocumentMarkdown(document: NoteDocumentV1): string {
  return guard(() => {
    const doc = safeDocument(document);
    references(doc);
    const result = emit(doc);
    // Verify that generated syntax has exactly the semantics emitted; reject
    // delimiter collisions and AST constructs outside the lossless subset.
    const decoded = decode(result);
    if (emit(decoded) !== result || semantics(doc) !== semantics(decoded)) fail();
    return result;
  });
}
