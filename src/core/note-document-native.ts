/** T03: bounded, inert native HTML codec. No DOM, transport, or database access.
 * Unknown safe structures become whole-subtree references, never partial edits.
 * Contexts are process-local daemon capabilities: do not put them on the wire.
 * T07 must supply the actual note/revision under its mutation lock.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { URL } from "node:url";
import {
  validateNoteDocument,
  type NoteDocumentV1,
  type NoteBlock,
  type NoteInline,
  type NoteInlineMark,
  type NoteTaskItem,
} from "./note-document.js";
import {
  normaliseNotesnookListKind,
  type NotesnookListKind,
} from "./notesnook-write-list-intent.js";
import type { NotesnookStoredContent } from "./notesnook-write-adapter.js";

export const NOTESNOOK_JSON_WRITER_ENABLED = false;
export const MAX_NOTE_DOCUMENT_NATIVE_BYTES = 256 * 1024;
export interface NativeNoteBinding {
  readonly noteId: string;
  readonly revision: string;
}
/** An unforgeable handle to private native bytes, not a serializable payload. */
export interface NativeNoteContext {
  readonly version: 1;
}
export interface NativeNoteSerializeOptions {
  readonly context?: NativeNoteContext;
  readonly binding?: NativeNoteBinding;
  readonly listKind?: NotesnookListKind;
  readonly writer?: "html" | "json";
}
export class NoteDocumentNativeError extends Error {
  readonly code = "unsupported_content";
  constructor() {
    super("Native note content is not supported");
    this.name = "NoteDocumentNativeError";
    Object.defineProperty(this, "cause", { value: undefined });
    Object.defineProperty(this, "__context__", { value: undefined });
  }
}
function fail(): never {
  throw new NoteDocumentNativeError();
}
function guard<T>(run: () => T): T {
  try {
    return run();
  } catch {
    return fail();
  }
}
function clean(s: string): string {
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    if ((cp < 32 && cp !== 9 && cp !== 10) || cp === 127 || (cp >= 0xd800 && cp <= 0xdfff)) fail();
  }
  return s;
}
// Snapshot own data only; never invoke accessors, proxies, toJSON or cycles.
function snapshot(value: unknown): unknown {
  const active = new Set<object>();
  let count = 0;
  let bytes = 0;
  function walk(v: unknown, depth: number): unknown {
    if (++count > 100_000 || depth > 80) fail();
    if (typeof v === "string") {
      bytes += Buffer.byteLength(v);
      if (bytes > MAX_NOTE_DOCUMENT_NATIVE_BYTES * 8) fail();
      return clean(v);
    }
    if (v === undefined || v === null || typeof v === "boolean" || typeof v === "number") return v;
    if (typeof v !== "object" || types.isProxy(v) || active.has(v)) fail();
    const array = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail();
    active.add(v);
    const out: Record<string, unknown> = array
      ? ([] as unknown as Record<string, unknown>)
      : (Object.create(null) as Record<string, unknown>);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))
        fail();
      const d = descriptors[key]!;
      if (!("value" in d)) fail();
      if (array && key === "length") continue;
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) fail();
      out[key] = walk(d.value, depth + 1);
    }
    if (array && Object.keys(out).length !== (v as unknown[]).length) fail();
    active.delete(v);
    return out;
  }
  return walk(value, 0);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  if (Object.keys(value).some((k) => !keys.includes(k))) fail();
  return value as Record<string, unknown>;
}
function bindingKey(value: unknown): string {
  const r = record(snapshot(value), ["noteId", "revision"]);
  if (typeof r.noteId !== "string" || !r.noteId || typeof r.revision !== "string" || !r.revision)
    fail();
  return JSON.stringify([r.noteId, r.revision]);
}
function bounded(stored: NotesnookStoredContent): NotesnookStoredContent {
  if (Buffer.byteLength(JSON.stringify(stored)) > MAX_NOTE_DOCUMENT_NATIVE_BYTES) fail();
  return Object.freeze(stored);
}
function url(s: string): string {
  if (!/^(https?:\/\/|mailto:)/i.test(s) || /[\s\\]/u.test(clean(s))) fail();
  const parsed = new URL(s);
  if (parsed.username || parsed.password) fail();
  return s;
}
const escape = (s: string): string =>
  clean(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
function entities(s: string): string {
  // Require explicit entities; unknown named entities cannot silently change meaning.
  return clean(
    s.replace(/&([^;\s<&]*);?/g, (whole, name: string) => {
      if (!whole.endsWith(";")) fail();
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: "\u00a0",
      };
      if (Object.hasOwn(named, name)) return named[name]!;
      if (!/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(name)) fail();
      const n =
        name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (!n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) fail();
      return String.fromCodePoint(n);
    }),
  );
}
interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  raw: string;
  start: number;
}
type HtmlNode = Element | string;
const voids = new Set(["br", "hr", "img"]);
const tags = new Set(
  "div p h1 h2 h3 h4 h5 h6 ul ol li strong b em i u s strike del code a br pre blockquote table thead tbody tfoot tr th td span img hr figure figcaption sup sub mark".split(
    " ",
  ),
);
function parseHtml(html: string): HtmlNode[] {
  clean(html);
  const root: Element = { tag: "root", attrs: {}, children: [], raw: "", start: 0 };
  const stack = [root];
  let pos = 0;
  let count = 0;
  while (pos < html.length) {
    if (++count > 30_000 || stack.length > 64) fail();
    const parent = stack.at(-1)!;
    if (html[pos] !== "<") {
      const end = html.indexOf("<", pos);
      const next = end < 0 ? html.length : end;
      const text = entities(html.slice(pos, next));
      if (
        ["ul", "ol", "table", "thead", "tbody", "tfoot", "tr"].includes(parent.tag) &&
        text.trim()
      )
        fail();
      parent.children.push(text);
      pos = next;
      continue;
    }
    const closing = /^<\/([a-z][a-z0-9-]*)\s*>/i.exec(html.slice(pos));
    if (closing) {
      if (stack.length === 1 || parent.tag !== closing[1]!.toLowerCase()) fail();
      pos += closing[0].length;
      parent.raw = html.slice(parent.start, pos);
      stack.pop();
      continue;
    }
    const open = /^<([a-z][a-z0-9-]*)/i.exec(html.slice(pos));
    if (!open) fail();
    const tag = open[1]!.toLowerCase();
    if (!tags.has(tag)) fail();
    // Reject structures a browser would repair/reparent before rendering.
    const phrasing = new Set(
      "strong b em i u s strike del code a br span img sup sub mark".split(" "),
    );
    if (
      (["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(parent.tag) ||
        phrasing.has(parent.tag)) &&
      !phrasing.has(tag)
    )
      fail();
    if (tag === "a" && stack.some((n) => n.tag === "a")) fail();
    const requiredChildren: Record<string, string[]> = {
      ul: ["li"],
      ol: ["li"],
      table: ["thead", "tbody", "tfoot", "tr"],
      thead: ["tr"],
      tbody: ["tr"],
      tfoot: ["tr"],
      tr: ["th", "td"],
    };
    if (requiredChildren[parent.tag] && !requiredChildren[parent.tag]!.includes(tag)) fail();
    const requiredParents: Record<string, string[]> = {
      li: ["ul", "ol"],
      thead: ["table"],
      tbody: ["table"],
      tfoot: ["table"],
      tr: ["table", "thead", "tbody", "tfoot"],
      th: ["tr"],
      td: ["tr"],
    };
    if (requiredParents[tag] && !requiredParents[tag]!.includes(parent.tag)) fail();
    const start = pos;
    pos += open[0].length;
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    while (!/^\s*\/?>/.test(html.slice(pos))) {
      const attr = /^\s+([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(
        html.slice(pos),
      );
      if (!attr) fail();
      const key = attr[1]!.toLowerCase();
      const value = entities(attr[2] ?? attr[3] ?? attr[4]!);
      if (Object.hasOwn(attrs, key)) fail();
      // Closed inert attributes. Preserve unfamiliar data/aria attributes opaquely.
      if (
        !/^(data-[a-z0-9-]+|aria-[a-z0-9-]+)$/.test(key) &&
        ![
          "class",
          "title",
          "href",
          "src",
          "alt",
          "width",
          "height",
          "colspan",
          "rowspan",
          "start",
          "reversed",
          "target",
          "rel",
        ].includes(key)
      )
        fail();
      if (key === "href" || key === "src") url(value);
      attrs[key] = value;
      pos += attr[0].length;
    }
    const end = /^\s*(\/?)>/.exec(html.slice(pos))!;
    pos += end[0].length;
    if (end[1] && !voids.has(tag)) fail();
    const node: Element = { tag, attrs, children: [], raw: html.slice(start, pos), start };
    parent.children.push(node);
    if (!voids.has(tag)) stack.push(node);
  }
  if (stack.length !== 1) fail();
  return root.children;
}
// Internal signal: syntactically safe but not representable without data loss.
class Preserve extends Error {}
function preserve(): never {
  throw new Preserve();
}
/**
 * Check the attributes this tag's decoding actually interprets.
 *
 * `meaningful` maps each attribute NAME the caller reads to the value it
 * accepts.  A name the caller does not read cannot change what is decoded, so
 * it is ignored rather than preserved: a real serializer decorates every
 * element it stores, and preserving a block because of decoration the decoder
 * never consults made every note written through this path unreadable and
 * uneditable.  A *meaningful* name whose value does not match still preserves
 * the element, and an unknown TAG is still preserved — tolerance is limited to
 * attribute names, never to content the decoder cannot express.
 */
function attrs(n: Element, meaningful: Record<string, string | RegExp> = {}): void {
  for (const [key, value] of Object.entries(n.attrs)) {
    const rule = meaningful[key];
    if (rule === undefined) continue;
    if (typeof rule === "string" ? rule !== value : !rule.test(value)) preserve();
  }
}
/**
 * Reject ANY attribute on an element whose canonical form carries none.
 *
 * Used for inline marks and table cells.  Block elements tolerate decoration
 * (a real serializer decorates every element it stores), but the canonical
 * inline model has no attributes at all, so dropping one there would be a
 * silent downgrade rather than decoration.
 */
function attrsStrict(n: Element): void {
  if (Object.keys(n.attrs).length > 0) preserve();
}
function elements(nodes: HtmlNode[]): Element[] {
  return nodes.flatMap((n) => {
    if (typeof n !== "string") return [n];
    if (n.trim()) preserve();
    return [];
  });
}
function canonicalMarks(marks: readonly NoteInlineMark[]): NoteInlineMark[] {
  const order = ["bold", "italic", "underline", "strike", "link", "code"];
  return [...marks].sort(
    (a, b) =>
      order.indexOf(typeof a === "string" ? a : a.type) -
      order.indexOf(typeof b === "string" ? b : b.type),
  );
}
function canonicalRuns(inlines: readonly NoteInline[]): NoteInline[] {
  const runs: NoteInline[] = [];
  for (const run of inlines) {
    const marks = canonicalMarks(run.marks ?? []);
    const keys = marks.map((m) => (typeof m === "string" ? m : m.type));
    if (new Set(keys).size !== keys.length) fail();
    if (!run.text) continue;
    const last = runs.at(-1);
    if (last && JSON.stringify(last.marks ?? []) === JSON.stringify(marks))
      runs[runs.length - 1] = { ...last, text: last.text + run.text };
    else runs.push(marks.length ? { text: run.text, marks } : { text: run.text });
  }
  return runs;
}
function inline(nodes: HtmlNode[], marks: NoteInlineMark[] = []): NoteInline[] {
  const out: NoteInline[] = [];
  const markTags: Record<string, string> = {
    strong: "bold",
    b: "bold",
    em: "italic",
    i: "italic",
    u: "underline",
    s: "strike",
    strike: "strike",
    del: "strike",
    code: "code",
  };
  for (const n of nodes) {
    if (typeof n === "string") {
      if (n) out.push(marks.length ? { text: n, marks } : { text: n });
      continue;
    }
    if (n.tag === "br") {
      // A line break carries no attributes in the canonical model, so any
      // attribute would be silently dropped: preserve the containing block.
      attrsStrict(n);
      out.push(marks.length ? { text: "\n", marks } : { text: "\n" });
      continue;
    }
    let mark: NoteInlineMark;
    if (n.tag === "a") {
      // A link's canonical form carries exactly one attribute.  Anything else
      // cannot be expressed, so preserve the containing block rather than drop
      // it silently.
      if (Object.keys(n.attrs).some((key) => key !== "href")) preserve();
      if (!n.attrs.href) preserve();
      mark = { type: "link", href: url(n.attrs.href) };
    } else {
      attrsStrict(n);
      mark = markTags[n.tag] ?? preserve();
    }
    out.push(...inline(n.children, [...marks, mark]));
  }
  return canonicalRuns(out);
}
function textOnly(n: Element): string {
  attrsStrict(n);
  if (n.children.length === 1 && typeof n.children[0] === "object" && n.children[0].tag === "p")
    return textOnly(n.children[0]);
  if (n.children.some((c) => typeof c !== "string")) preserve();
  return n.children.join("");
}
function listKind(n: Element): NotesnookListKind | undefined {
  if (n.tag !== "ul") return undefined;
  if (n.attrs.class === "simple-checklist") return "simple-checklist";
  if (n.attrs.class === "checklist") return "task-list";
  return undefined;
}
function taskItems(n: Element, kind: NotesnookListKind): NoteTaskItem[] {
  attrs(n, { class: kind === "task-list" ? "checklist" : "simple-checklist" });
  return elements(n.children).map((li) => {
    if (li.tag !== "li") preserve();
    const itemClass = kind === "task-list" ? "checklist--item" : "simple-checklist--item";
    attrs(li, { class: /^[a-z -]+$/ });
    const classes = (li.attrs.class ?? "").split(/\s+/).filter(Boolean);
    if (
      !classes.includes(itemClass) ||
      classes.some((c) => ![itemClass, "checked", "checked--item"].includes(c))
    )
      preserve();
    const kids = elements(li.children);
    const p = kids[0];
    if (!p || p.tag !== "p" || kids.length > 2) preserve();
    attrs(p);
    const nested = kids[1];
    if (nested && listKind(nested) !== kind) preserve();
    return {
      checked: classes.includes("checked") || classes.includes("checked--item"),
      inlines: inline(p.children),
      children: nested ? taskItems(nested, kind) : [],
    };
  });
}
// Property insertion order is not a semantic edit. Empty optional marks and
// adjacent identical runs are normalized by native decoding.
function fingerprint(value: unknown): string {
  function normalized(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(normalized);
    if (!v || typeof v !== "object") return v;
    const r = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(r)
        .sort()
        .filter((k) => r[k] !== undefined)
        .map((k) => [k, normalized(r[k])]),
    );
  }
  return JSON.stringify(normalized(value));
}
interface PrivateContext {
  binding: string;
  original: NotesnookStoredContent;
  baseline: string;
  refs: string[];
  payloads: Map<string, string>;
}
const contexts = new WeakMap<NativeNoteContext, PrivateContext>();
function references(doc: NoteDocumentV1): string[] {
  const refs: string[] = [];
  const tokens = new Set<string>();
  function walk(blocks: readonly NoteBlock[], path: string): void {
    blocks.forEach((b, i) => {
      const at = `${path}/${i}`;
      if (b.type === "opaque") {
        if (tokens.has(b.sentinel.token)) fail();
        tokens.add(b.sentinel.token);
        refs.push(
          JSON.stringify([at, b.nodeType, b.sentinel.version, b.sentinel.source, b.sentinel.token]),
        );
      }
      if (b.type === "callout" || b.type === "blockquote")
        walk(b.blocks, `${at}/${b.type}/${b.type === "callout" ? b.variant : ""}`);
      if (b.type === "bullet-list" || b.type === "ordered-list")
        b.items.forEach((item, j) => walk(item.blocks ?? [], `${at}/${b.type}/${j}`));
    });
  }
  walk(doc.blocks, "");
  return refs;
}
function decodeBlocks(nodes: HtmlNode[], payloads: Map<string, string>): NoteBlock[] {
  return elements(nodes).map((n) => {
    try {
      return decodeBlock(n, payloads);
    } catch (error) {
      if (!(error instanceof Preserve)) throw error;
      // Deterministic, position-mixed token.  The operator preimage contract
      // spans two independent decodes of the same stored content: one mints the
      // markdown, a later one validates it.  A random token could never be
      // re-derived by the second decode, so every note carrying an opaque block
      // was permanently uneditable.  `payloads` is created per decode, so its
      // size is this reference's traversal index — deterministic for identical
      // input, and distinct for two identical subtrees in one document.
      const token = createHash("sha256")
        .update(`${payloads.size}\u0000${n.raw}`)
        .digest("hex")
        .slice(0, 36);
      payloads.set(token, n.raw);
      return {
        type: "opaque",
        nodeType: n.tag,
        sentinel: { version: 1, source: "native-html", token },
      };
    }
  });
}
function decodeBlock(n: Element, payloads: Map<string, string>): NoteBlock {
  if (n.tag === "p" || /^h[1-3]$/.test(n.tag)) {
    attrs(n);
    const inlines = inline(n.children);
    return n.tag === "p"
      ? { type: "paragraph", inlines }
      : { type: "heading", level: Number(n.tag[1]) as 1 | 2 | 3, inlines };
  }
  if (n.tag === "ul" || n.tag === "ol") {
    const kind = listKind(n);
    if (kind) return { type: "task-list", kind, items: taskItems(n, kind) };
    // A class naming a checklist kind but not exactly one cannot be represented
    // faithfully: the recorded item states would be dropped and the list would
    // read back as ordinary bullets.  Preserve rather than guess.  `start` and
    // `reversed` are likewise unrepresentable.  Any other class is decoration
    // and stays tolerated, so a decorated list still round-trips.
    const cls = n.attrs.class;
    if (cls !== undefined && cls.includes("checklist")) preserve();
    // Presence is what matters, not the value: these are boolean or numeric
    // attributes with no canonical representation, and a valueless `reversed`
    // arrives as an empty string.
    if (n.attrs.start !== undefined || n.attrs.reversed !== undefined) preserve();
    const items = elements(n.children).map((li) => {
      if (li.tag !== "li") preserve();
      attrs(li);
      const first = li.children[0];
      if (typeof first === "object" && first.tag === "p") {
        attrs(first);
        const blocks = decodeBlocks(li.children.slice(1), payloads);
        return { inlines: inline(first.children), ...(blocks.length ? { blocks } : {}) };
      }
      // Legacy writer emits bare inline list labels.
      return { inlines: inline(li.children) };
    });
    return { type: n.tag === "ul" ? "bullet-list" : "ordered-list", items };
  }
  if (n.tag === "blockquote") {
    attrs(n);
    return { type: "blockquote", blocks: decodeBlocks(n.children, payloads) };
  }
  if (n.tag === "pre") {
    attrs(n);
    const kids = elements(n.children);
    const code = kids[0];
    if (kids.length !== 1 || code?.tag !== "code") preserve();
    attrs(code, { class: /^language-[A-Za-z0-9_+-]+$/ });
    if (code.children.some((c) => typeof c !== "string")) preserve();
    const language = code.attrs.class?.slice(9);
    return { type: "code-block", text: code.children.join(""), ...(language ? { language } : {}) };
  }
  if (n.tag === "table") {
    attrs(n);
    const groups = elements(n.children);
    let rows: Element[] = [];
    for (const group of groups) {
      if (group.tag === "tr") rows.push(group);
      else if (["thead", "tbody"].includes(group.tag)) {
        attrs(group);
        rows.push(...elements(group.children));
      } else preserve();
    }
    if (!rows.length) preserve();
    const cells = rows.map((row, i) => {
      if (row.tag !== "tr") preserve();
      attrs(row);
      return elements(row.children).map((cell) => {
        if (cell.tag !== (i === 0 ? "th" : "td")) preserve();
        return textOnly(cell);
      });
    });
    const columns = cells[0]!;
    if (!columns.length || cells.some((row) => row.length !== columns.length)) preserve();
    return { type: "table", columns, rows: cells.slice(1) };
  }
  if (n.tag === "div" && n.attrs["data-type"] === "callout") {
    attrs(n, { "data-type": "callout", "data-variant": /^(info|warning|success|danger)$/ });
    const variant = n.attrs["data-variant"];
    if (!variant) preserve();
    return {
      type: "callout",
      variant: variant as "info" | "warning" | "success" | "danger",
      blocks: decodeBlocks(n.children, payloads),
    };
  }
  return preserve();
}
export function decodeNoteDocumentNative(
  envelope: unknown,
  binding: NativeNoteBinding,
): { readonly document: NoteDocumentV1; readonly context: NativeNoteContext } {
  return guard(() => {
    const key = bindingKey(binding);
    const r = record(snapshot(envelope), ["type", "data"]);
    if ((r.type !== "html" && r.type !== "tiptap") || typeof r.data !== "string") fail();
    const original = bounded({ type: r.type, data: r.data });
    const nodes = parseHtml(r.data);
    const roots = elements(nodes);
    if (!roots.length && r.data.trim()) fail();
    let content: HtmlNode[] = roots;
    // The document container is structural, not content: it contributes no
    // blocks of its own, so attributes on it cannot change what the document
    // says.  Requiring it to carry exactly one attribute made every container
    // that a real serializer decorates decode as one opaque block, which made
    // written notes unreadable and uneditable.  Content-level strictness is
    // unaffected -- a root element declaring any other type is still preserved.
    if (
      roots.length === 1 &&
      roots[0]!.tag === "div" &&
      roots[0]!.attrs["data-type"] === "document"
    )
      content = roots[0]!.children;
    const payloads = new Map<string, string>();
    const document: NoteDocumentV1 = { version: 1, blocks: decodeBlocks(content, payloads) };
    validateNoteDocument(document);
    const context: NativeNoteContext = Object.freeze({ version: 1 });
    contexts.set(context, {
      binding: key,
      original,
      baseline: fingerprint(document),
      refs: references(document),
      payloads,
    });
    return Object.freeze({ document, context });
  });
}
function renderInline(inlines: readonly NoteInline[]): string {
  return canonicalRuns(inlines)
    .map((run) => {
      let out = escape(run.text).replace(/\n/g, "<br>");
      const seen = new Set<string>();
      const sorted = canonicalMarks(run.marks ?? []);
      for (const mark of sorted.reverse()) {
        const key = typeof mark === "string" ? mark : mark.type;
        if (seen.has(key)) fail();
        seen.add(key);
        if (typeof mark === "object") out = `<a href="${escape(url(mark.href))}">${out}</a>`;
        else {
          const tag =
            (
              { bold: "strong", italic: "em", underline: "u", strike: "s", code: "code" } as Record<
                string,
                string
              >
            )[mark] ?? fail();
          out = `<${tag}>${out}</${tag}>`;
        }
      }
      return out;
    })
    .join("");
}
function renderTasks(items: readonly NoteTaskItem[], kind: NotesnookListKind): string {
  const cls = kind === "task-list" ? "checklist" : "simple-checklist";
  return `<ul class="${cls}">${items.map((item) => `<li class="${item.checked ? "checked " : ""}${cls}--item"><p>${renderInline(item.inlines)}</p>${item.children.length ? renderTasks(item.children, kind) : ""}</li>`).join("")}</ul>`;
}
function renderBlocks(
  blocks: readonly NoteBlock[],
  kind: NotesnookListKind,
  payloads?: Map<string, string>,
): string {
  const render = (bs: readonly NoteBlock[]) => renderBlocks(bs, kind, payloads);
  return blocks
    .map((b) => {
      switch (b.type) {
        case "paragraph":
          return `<p>${renderInline(b.inlines)}</p>`;
        case "heading":
          return `<h${b.level}>${renderInline(b.inlines)}</h${b.level}>`;
        case "bullet-list":
        case "ordered-list": {
          const tag = b.type === "bullet-list" ? "ul" : "ol";
          return `<${tag}>${b.items.map((item) => `<li><p>${renderInline(item.inlines)}</p>${render(item.blocks ?? [])}</li>`).join("")}</${tag}>`;
        }
        case "task-list":
          return renderTasks(b.items, b.kind ?? kind);
        case "blockquote":
          return `<blockquote>${render(b.blocks)}</blockquote>`;
        case "code-block":
          if (b.language !== undefined && !/^[A-Za-z0-9_+-]+$/.test(b.language)) fail();
          return `<pre><code${b.language ? ` class="language-${escape(b.language)}"` : ""}>${escape(b.text)}</code></pre>`;
        case "table":
          if (!b.columns.length) fail();
          return `<table><thead><tr>${b.columns.map((c) => `<th>${escape(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((row) => `<tr>${row.map((c) => `<td>${escape(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
        case "callout":
          return `<div data-type="callout" data-variant="${b.variant}">${render(b.blocks)}</div>`;
        case "opaque":
          return payloads?.get(b.sentinel.token) ?? fail();
      }
    })
    .join("");
}
// T01 validates values; this boundary additionally refuses fields it cannot emit.
function closedDocument(doc: NoteDocumentV1): void {
  record(doc, ["version", "blocks"]);
  function runs(inlines: readonly NoteInline[]): void {
    for (const run of inlines) {
      record(run, ["text", "marks"]);
      for (const mark of run.marks ?? [])
        if (typeof mark === "object") record(mark, ["type", "href"]);
    }
  }
  function tasks(items: readonly NoteTaskItem[]): void {
    for (const item of items) {
      record(item, ["checked", "inlines", "children"]);
      runs(item.inlines);
      tasks(item.children);
    }
  }
  function blocks(bs: readonly NoteBlock[]): void {
    for (const b of bs) {
      const fields: Record<NoteBlock["type"], string[]> = {
        paragraph: ["type", "inlines"],
        heading: ["type", "level", "inlines"],
        "bullet-list": ["type", "items"],
        "ordered-list": ["type", "items"],
        "task-list": ["type", "kind", "items"],
        blockquote: ["type", "blocks"],
        "code-block": ["type", "text", "language"],
        table: ["type", "columns", "rows"],
        callout: ["type", "variant", "blocks"],
        opaque: ["type", "nodeType", "sentinel"],
      };
      record(b, fields[b.type]);
      if (b.type === "paragraph" || b.type === "heading") runs(b.inlines);
      if (b.type === "bullet-list" || b.type === "ordered-list")
        for (const item of b.items) {
          record(item, ["inlines", "blocks"]);
          runs(item.inlines);
          blocks(item.blocks ?? []);
        }
      if (b.type === "task-list") tasks(b.items);
      if (b.type === "blockquote" || b.type === "callout") blocks(b.blocks);
      if (b.type === "opaque") record(b.sentinel, ["version", "source", "token"]);
    }
  }
  blocks(doc.blocks);
}
export function serializeNoteDocumentNative(
  document: NoteDocumentV1,
  options: NativeNoteSerializeOptions = {},
): NotesnookStoredContent {
  return guard(() => {
    // Inspect option descriptors without copying the context capability identity.
    if (types.isProxy(options) || !options || Object.getPrototypeOf(options) !== Object.prototype)
      fail();
    const descriptors = Object.getOwnPropertyDescriptors(options);
    for (const [key, d] of Object.entries(descriptors))
      if (!["context", "binding", "listKind", "writer"].includes(key) || !("value" in d)) fail();
    const writer = options.writer ?? "html";
    if (writer === "json" && !NOTESNOOK_JSON_WRITER_ENABLED) fail();
    if (writer !== "html") fail();
    const kind = normaliseNotesnookListKind(options.listKind);
    const doc = snapshot(document);
    validateNoteDocument(doc);
    closedDocument(doc);
    const context = options.context === undefined ? undefined : contexts.get(options.context);
    if (options.context !== undefined && !context) fail();
    if (context && context.binding !== bindingKey(options.binding)) fail();
    if (JSON.stringify(references(doc)) !== JSON.stringify(context?.refs ?? [])) fail();
    if (context && fingerprint(doc) === context.baseline) return context.original;
    return bounded({
      type: context?.original.type ?? "tiptap",
      data: `<div data-type="document">${renderBlocks(doc.blocks, kind, context?.payloads)}</div>`,
    });
  });
}
