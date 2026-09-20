/**
 * T02 canonical, deliberately restricted Markdown interchange (not CommonMark).
 * LF, one blank line between blocks, one final newline, fixed version header.
 * Marks: **bold**, *italic*, __underline__, ~~strike~~, `code`, [link](URL).
 * Task indentation is two spaces; an optional `:::nookbridge list KIND`
 * wrapper preserves explicit per-list intent. Tables contain one canonical JSON
 * object; callouts contain blocks. Directives close with `:::` and nest.
 * Links allow only http, https and mailto, without embedded credentials.
 * Raw HTML, images and list continuation blocks are outside this subset;
 * unsupported/ambiguous syntax uses the existing categorical AST errors.
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
          out = `:::nookbridge callout ${block.variant}\n${renderBlocks(block.blocks, depth + 1)}\n:::`;
          break;
        case "blockquote":
          keys(block, ["type", "blocks"]);
          out = renderBlocks(block.blocks, depth + 1)
            .split("\n")
            .map((line) => (line ? "> " + line : ">"))
            .join("\n");
          break;
        case "bullet-list":
        case "ordered-list":
          keys(block, ["type", "items"]);
          out = block.items
            .map((item, i) => {
              keys(item, ["inlines", "blocks"]);
              if (item.blocks?.length) fail("unsupported_node");
              return (
                (block.type === "bullet-list" ? "- " : `${i + 1}. `) + renderInlines(item.inlines)
              );
            })
            .join("\n");
          break;
        case "task-list": {
          keys(block, ["type", "kind", "items"]);
          const tasks = (items: readonly NoteTaskItem[], level: number): string =>
            items
              .map((item) => {
                keys(item, ["checked", "inlines", "children"]);
                return (
                  "  ".repeat(level) +
                  `- [${item.checked ? "x" : " "}] ` +
                  renderInlines(item.inlines) +
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
      fail();
    }
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
      const ordered = /^\d/.test(line);
      const items: { inlines: NoteInline[] }[] = [];
      while (this.pos < this.lines.length) {
        const m = (ordered ? /^\d+\. (.*)$/ : /^- (.*)$/).exec(this.lines[this.pos]!);
        if (!m) break;
        if (items.length >= MAX_NOTE_DOCUMENT_LIST_ITEMS_PER_LIST) fail("oversize_document");
        items.push({ inlines: parseInlines(m[1]!) });
        this.pos++;
      }
      return { type: ordered ? "ordered-list" : "bullet-list", items };
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
