/** T03: bounded, inert native HTML codec. No DOM, transport, or database access.
 * Unknown safe structures become whole-subtree references, never partial edits.
 * Contexts are process-local daemon capabilities: do not put them on the wire.
 * T07 must supply the actual note/revision under its mutation lock.
 */
import { Buffer } from "node:buffer";
import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { types } from "node:util";
import { noteHtmlReadonlyMarkdown } from "./note-html-readonly-markdown.js";
import { serializeNoteDocumentMarkdown } from "./note-document-markdown.js";
import { URL } from "node:url";
import {
  MAX_NOTE_DOCUMENT_OPAQUE_TEXT_BYTES,
  MAX_NOTE_DOCUMENT_OPAQUE_TEXT_TOTAL_BYTES,
  isNoteDocumentError,
  validateNoteDocument,
  type NoteDocumentErrorCode,
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
/**
 * Internal class of a whole-document refusal. Owner's rule: anything that
 * fetches, executes, or that a browser would silently repair is hostile;
 * anything merely outside the grammar is preservable (`uninterpretable`).
 *
 *   - `hostile` — the markup is actively unsafe (or a parser differential).
 *   - `uninterpretable` — well-formed with a known extent, outside the grammar.
 *   - `limit` — a size or count bound.
 *   - `unclassified` — a throw no `fail` site named (for example a URL parser
 *     exception or a validator check outside the bounds). Nothing is known
 *     about it, so it is NOT preservable: it must be treated like `hostile`
 *     until a site is given a reason, and never counted as `uninterpretable`.
 *   - `edit_refusal` — not a decode class: an edit that drops or moves a
 *     preserved block. It is neither hostile nor preservable, is never counted
 *     as a decode failure, and no preservation step may relax it.
 *
 * When one decoded document has several faults, the worst one decides its
 * class: hostile, then unclassified, then limit, then uninterpretable (see
 * `FAULT_SEVERITY`). An uninterpretable fault is deferred and the scan goes on,
 * so a document classed `uninterpretable` was scanned to its end and holds no
 * hostile, unclassified or limit fault anywhere. The reason is the worst
 * fault's; between faults of one class it is the first reached. A limit stops
 * the scan, so nothing past it is examined; a limit is never preservable.
 * Serialization is outside this rule: its first fault wins.
 *
 * Internal only: the class never crosses an RPC error, an operator message or
 * the client boundary.
 */
export type NativeFailureClass =
  | "hostile"
  | "uninterpretable"
  | "limit"
  | "unclassified"
  | "edit_refusal";
/** Closed internal vocabulary: one reason per whole-document failure site. */
export type NativeFailureReason =
  | "internal_failure"
  | "document_bounds_exceeded"
  | "control_character"
  | "crlf_line_ending"
  | "envelope_too_complex"
  | "envelope_too_large"
  | "envelope_proxy"
  | "envelope_not_plain"
  | "envelope_bad_prototype"
  | "envelope_forbidden_key"
  | "envelope_accessor"
  | "envelope_non_index_key"
  | "envelope_sparse_array"
  | "envelope_not_record"
  | "envelope_unexpected_field"
  | "binding_invalid"
  | "document_too_large"
  | "url_not_permitted"
  | "url_inert"
  | "url_credentials"
  | "document_too_complex"
  | "stray_text_in_table"
  | "stray_text_in_container"
  | "mismatched_tag"
  | "malformed_markup"
  | "forbidden_tag"
  | "misnested_block"
  | "nested_anchor"
  | "nested_list"
  | "invalid_child"
  | "orphan_list_item"
  | "misplaced_element"
  | "malformed_attribute"
  | "duplicate_attribute"
  | "active_attribute"
  | "fetching_attribute"
  | "attr_unrecognised"
  | "unsafe_style"
  | "dir_unrecognised"
  | "entity_encoded_url"
  | "url_raw_ampersand"
  | "self_closing_element"
  | "unclosed_element"
  | "duplicate_mark"
  | "duplicate_opaque_token"
  | "envelope_shape"
  | "document_without_blocks"
  | "duplicate_mark_output"
  | "unknown_mark"
  | "code_language_invalid"
  | "table_without_columns"
  | "block_not_serializable"
  | "opaque_payload_missing"
  | "options_not_plain"
  | "options_unexpected_field"
  | "json_writer_disabled"
  | "writer_unsupported"
  | "context_unknown"
  | "context_binding_mismatch"
  | "context_references_mismatch";

const NATIVE_FAILURE_CLASSES: Readonly<Record<NativeFailureReason, NativeFailureClass>> =
  Object.freeze({
    internal_failure: "unclassified",
    document_bounds_exceeded: "limit",
    control_character: "hostile",
    crlf_line_ending: "uninterpretable",
    envelope_too_complex: "limit",
    envelope_too_large: "limit",
    envelope_proxy: "hostile",
    envelope_not_plain: "uninterpretable",
    envelope_bad_prototype: "uninterpretable",
    envelope_forbidden_key: "hostile",
    envelope_accessor: "hostile",
    envelope_non_index_key: "uninterpretable",
    envelope_sparse_array: "uninterpretable",
    // The binding is not a record, so the body is never scanned. Nothing here can
    // certify the document free of hostile content, so it is not preservable.
    envelope_not_record: "unclassified",
    envelope_unexpected_field: "uninterpretable",
    binding_invalid: "uninterpretable",
    document_too_large: "limit",
    url_not_permitted: "hostile",
    url_inert: "uninterpretable",
    url_credentials: "hostile",
    document_too_complex: "limit",
    stray_text_in_table: "hostile",
    stray_text_in_container: "uninterpretable",
    mismatched_tag: "hostile",
    malformed_markup: "hostile",
    forbidden_tag: "hostile",
    misnested_block: "hostile",
    nested_anchor: "hostile",
    nested_list: "uninterpretable",
    invalid_child: "hostile",
    orphan_list_item: "uninterpretable",
    misplaced_element: "hostile",
    malformed_attribute: "hostile",
    duplicate_attribute: "hostile",
    active_attribute: "hostile",
    fetching_attribute: "hostile",
    attr_unrecognised: "uninterpretable",
    unsafe_style: "hostile",
    dir_unrecognised: "uninterpretable",
    entity_encoded_url: "hostile",
    url_raw_ampersand: "uninterpretable",
    self_closing_element: "hostile",
    unclosed_element: "hostile",
    duplicate_mark: "uninterpretable",
    duplicate_opaque_token: "hostile",
    envelope_shape: "uninterpretable",
    document_without_blocks: "uninterpretable",
    duplicate_mark_output: "uninterpretable",
    unknown_mark: "uninterpretable",
    code_language_invalid: "uninterpretable",
    table_without_columns: "uninterpretable",
    block_not_serializable: "uninterpretable",
    opaque_payload_missing: "uninterpretable",
    options_not_plain: "uninterpretable",
    options_unexpected_field: "uninterpretable",
    json_writer_disabled: "uninterpretable",
    writer_unsupported: "uninterpretable",
    context_unknown: "uninterpretable",
    context_binding_mismatch: "hostile",
    context_references_mismatch: "edit_refusal",
  });

/**
 * The closed reason vocabulary as data, for exhaustiveness checks over the
 * class table. No reason crosses the census wire, which carries class counts.
 */
export const NATIVE_FAILURE_REASONS: ReadonlyArray<NativeFailureReason> = Object.freeze(
  Object.keys(NATIVE_FAILURE_CLASSES) as NativeFailureReason[],
);

export function nativeFailureClass(reason: NativeFailureReason): NativeFailureClass {
  return NATIVE_FAILURE_CLASSES[reason];
}

export class NoteDocumentNativeError extends Error {
  readonly code = "unsupported_content";
  /**
   * The internal reason.  Deliberately non-enumerable so `JSON.stringify` of a
   * refusal (or of an envelope that mistakenly embeds one) never carries it.
   */
  readonly reason: NativeFailureReason;
  constructor(reason: NativeFailureReason) {
    super("Native note content is not supported");
    this.name = "NoteDocumentNativeError";
    this.reason = reason;
    Object.defineProperty(this, "reason", {
      value: reason,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(this, "cause", { value: undefined });
    Object.defineProperty(this, "__context__", { value: undefined });
  }
}
/** Worst first. Only an `uninterpretable` fault is ever deferred. */
const FAULT_SEVERITY: Readonly<Record<NativeFailureClass, number>> = Object.freeze({
  hostile: 4,
  unclassified: 3,
  limit: 2,
  uninterpretable: 1,
  edit_refusal: 0,
});
const severity = (reason: NativeFailureReason): number =>
  FAULT_SEVERITY[NATIVE_FAILURE_CLASSES[reason]];
/**
 * The worst deferred fault of the decode in progress. Decoding is synchronous
 * and never re-enters, so one slot suffices; `scanned` owns it.
 */
let scanning = false;
let deferred: NativeFailureReason | undefined;
/** Throw the worse of this fault and any deferred one; a tie keeps the earlier. */
function fail(reason: NativeFailureReason): never {
  throw new NoteDocumentNativeError(
    deferred !== undefined && severity(deferred) >= severity(reason) ? deferred : reason,
  );
}
/**
 * A fault the scan can continue past. Inside a decode an uninterpretable one is
 * recorded and the caller carries on, so a worse fault later in the document
 * still decides the class; anywhere else, or for any worse class, it throws.
 */
function defer(reason: NativeFailureReason): void {
  if (!scanning || NATIVE_FAILURE_CLASSES[reason] !== "uninterpretable") fail(reason);
  if (deferred === undefined || severity(reason) > severity(deferred)) deferred = reason;
}
/** Run a whole-document decode under the worst-fault rule. */
function scanned<T>(run: () => T): T {
  scanning = true;
  deferred = undefined;
  try {
    const out = guard(run);
    if (deferred !== undefined) fail(deferred);
    return out;
  } finally {
    scanning = false;
    deferred = undefined;
  }
}
function guard<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    // A classified refusal keeps its reason; an unexpected throw (for example a
    // URL parser exception) becomes the unclassified internal failure.
    if (error instanceof NoteDocumentNativeError) throw error;
    return fail("internal_failure");
  }
}
/** The document validator's size, count and depth bounds. */
const VALIDATOR_BOUND_CODES: ReadonlySet<NoteDocumentErrorCode> = new Set([
  "oversize_document",
  "oversize_block",
  "oversize_inline",
  "oversize_sentinel",
  "depth_exceeded",
]);
/**
 * `validateNoteDocument`, with its bound failures classed as `limit`. Any
 * other validator failure propagates to `guard` and stays unclassified.
 */
function validated(doc: unknown): asserts doc is NoteDocumentV1 {
  try {
    validateNoteDocument(doc);
  } catch (error) {
    if (isNoteDocumentError(error) && VALIDATOR_BOUND_CODES.has(error.code))
      fail("document_bounds_exceeded");
    throw error;
  }
}
function clean(s: string): string {
  let hostile = false;
  let crlf = false;
  let cr = false;
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    // A carriage return is a line ending only as the first half of a CRLF.
    if (cr && cp !== 10) hostile = true;
    cr = cp === 13;
    if (cr) crlf = true;
    else if ((cp < 32 && cp !== 9 && cp !== 10) || cp === 127 || (cp >= 0xd800 && cp <= 0xdfff))
      hostile = true;
  }
  if (hostile || cr) fail("control_character");
  // After the whole string, so a hostile character anywhere in it wins.
  if (crlf) defer("crlf_line_ending");
  return s;
}
// Snapshot own data only; never invoke accessors, proxies, toJSON or cycles.
function snapshot(value: unknown): unknown {
  const active = new Set<object>();
  let count = 0;
  let bytes = 0;
  function walk(v: unknown, depth: number): unknown {
    if (++count > 100_000 || depth > 80) fail("envelope_too_complex");
    if (typeof v === "string") {
      bytes += Buffer.byteLength(v);
      if (bytes > MAX_NOTE_DOCUMENT_NATIVE_BYTES * 8) fail("envelope_too_large");
      return clean(v);
    }
    if (v === undefined || v === null || typeof v === "boolean" || typeof v === "number") return v;
    // A Proxy runs code whenever it is inspected: hostile, not merely non-plain.
    if (types.isProxy(v)) fail("envelope_proxy");
    // Each uninterpretable fault below is deferred and the walk goes on over
    // own data descriptors only, so a hostile value beside it still decides.
    if (typeof v !== "object" || active.has(v)) {
      defer("envelope_not_plain");
      return undefined;
    }
    const array = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      defer("envelope_bad_prototype");
    active.add(v);
    const out: Record<string, unknown> = array
      ? ([] as unknown as Record<string, unknown>)
      : (Object.create(null) as Record<string, unknown>);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))
        fail("envelope_forbidden_key");
      const d = descriptors[key]!;
      if (!("value" in d)) fail("envelope_accessor");
      if (array && key === "length") continue;
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) {
        defer("envelope_non_index_key");
        walk(d.value, depth + 1);
        continue;
      }
      out[key] = walk(d.value, depth + 1);
    }
    if (array && Object.keys(out).length !== (v as unknown[]).length)
      defer("envelope_sparse_array");
    active.delete(v);
    return out;
  }
  return walk(value, 0);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("envelope_not_record");
  if (Object.keys(value).some((k) => !keys.includes(k))) defer("envelope_unexpected_field");
  return value as Record<string, unknown>;
}
/**
 * Key for opaque placeholder tokens.  The token is keyed so a caller who sees
 * the note id, revision and Markdown cannot confirm a guess about the withheld
 * content offline (review finding 10).  The daemon configures it from the
 * database key at startup; until then a per-process random key is used, so a
 * token is never derivable from public inputs.
 */
let placeholderKey: Buffer = randomBytes(32);
function derivePlaceholderKey(keyMaterial: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(keyMaterial, "utf8"),
      Buffer.from("nookbridge/opaque-placeholder/salt/v1"),
      Buffer.from("nookbridge/opaque-placeholder/key/v1"),
      32,
    ),
  );
}

export function configureOpaquePlaceholderKey(keyMaterial: string | undefined): void {
  placeholderKey =
    keyMaterial === undefined || keyMaterial.length === 0
      ? randomBytes(32)
      : derivePlaceholderKey(keyMaterial);
}

function bindingKey(value: unknown): string {
  const r = record(snapshot(value), ["noteId", "revision"]);
  const noteId = r.noteId;
  const revision = r.revision;
  // Deferred in a decode, so a bad binding never ends the scan of the content.
  if (typeof noteId !== "string" || !noteId || typeof revision !== "string" || !revision)
    defer("binding_invalid");
  return JSON.stringify([noteId, revision]);
}
function bounded(stored: NotesnookStoredContent): NotesnookStoredContent {
  if (Buffer.byteLength(JSON.stringify(stored)) > MAX_NOTE_DOCUMENT_NATIVE_BYTES)
    fail("document_too_large");
  return Object.freeze(stored);
}
/**
 * A link target that neither runs nor fetches: a fragment, a path-relative
 * reference, `tel:`, or an `nn://` note link without credentials. A
 * network-path reference (`//host`) names a host, so it is not one.
 */
function inertLink(s: string): boolean {
  if (/^nn:\/\//i.test(s)) return !/^nn:\/\/[^/?#]*@/i.test(s);
  if (/^tel:/i.test(s) || s.startsWith("#")) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith("//");
}
/**
 * `fetched` marks an attribute the browser loads on render (`src`). An inert
 * link is outside the grammar there too, but a relative one would be fetched,
 * so only a link that is merely followed can be `url_inert`.
 */
function url(s: string, fetched = false): string {
  // A browser silently strips whitespace from a URL and reads `\` as `/`.
  const repaired = /[\s\\]/u.test(s);
  const permitted = /^(https?:\/\/|mailto:)/i.test(s);
  if (!repaired && !permitted && !fetched && inertLink(clean(s))) {
    defer("url_inert");
    return s;
  }
  if (repaired || !permitted) fail("url_not_permitted");
  const parsed = new URL(clean(s));
  if (parsed.username || parsed.password) fail("url_credentials");
  return s;
}
const escape = (s: string): string =>
  clean(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
/**
 * True when a browser leaves this `&` literal in an attribute value: nothing
 * that could start a character reference follows it, or an alphanumeric run
 * ends at `=` (the query-string case). A browser may decode anything else.
 */
const literalAmpersand = (name: string): boolean => /^(?:$|[^a-z0-9#]|[a-z0-9]+=)/i.test(name);
/** `raw`: every undecoded `&` is one a browser also leaves literal. */
function entities(s: string): { value: string; unsupported: boolean; raw: boolean } {
  let unsupported = false;
  let raw = true;
  const value = s.replace(/&([^;\s<&]*);?/g, (whole, name: string) => {
    if (!whole.endsWith(";")) {
      unsupported = true;
      raw &&= literalAmpersand(name);
      return whole;
    }
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: "\u00a0",
    };
    if (Object.hasOwn(named, name)) return named[name]!;
    if (/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(name)) {
      const n =
        name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff)) return String.fromCodePoint(n);
    }
    // Keep an entity the model cannot decode attached to its original block.
    // Its source bytes are retained in the private opaque payload below.
    unsupported = true;
    raw &&= literalAmpersand(name);
    return whole;
  });
  return { value: clean(value), unsupported, raw };
}
interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  raw: string;
  /** The opening tag's source bytes; `raw` grows to the whole element on close. */
  open: string;
  start: number;
  unsupported: boolean;
}
type HtmlNode = Element | string;
const voids = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const tags = new Set(
  "div p h1 h2 h3 h4 h5 h6 ul ol li strong b em i u s strike del code a br pre blockquote table thead tbody tfoot tr th td span img hr figure figcaption sup sub mark".split(
    " ",
  ),
);
const forbiddenTags = new Set([
  "applet",
  "audio",
  "base",
  "embed",
  "form",
  "frame",
  "frameset",
  "iframe",
  "link",
  "math",
  "noembed",
  "noframes",
  "object",
  "portal",
  "plaintext",
  "script",
  "source",
  "style",
  "title",
  "svg",
  "textarea",
  "track",
  "video",
  "xmp",
]);
const forbiddenExternalReferenceAttributes = new Set([
  "action",
  "formaction",
  "ping",
  "poster",
  "srcset",
]);
/**
 * Attribute names a browser loads a resource from (or, for `http-equiv`, is
 * redirected by) on some element this parser does not refuse by tag:
 * `background` on table cells, `src` on `input` or `image`. Outside the
 * per-tag allow-list they are hostile, not merely unrecognised.
 */
const fetchingAttributes = new Set([
  "background",
  "dynsrc",
  "http-equiv",
  "lowsrc",
  "manifest",
  "src",
]);
/**
 * Open elements that stop a browser's search for an `<li>` to close when a new
 * `<li>` starts: special elements other than `div` and `p`. Phrasing and
 * unknown elements do not stop it.
 */
const listItemScopeStops = new Set(
  "h1 h2 h3 h4 h5 h6 ul ol pre blockquote table thead tbody tfoot tr th td figure figcaption".split(
    " ",
  ),
);
/** True when a browser would silently close an open `<li>` at a new `<li>`. */
function closesOpenListItem(stack: readonly Element[]): boolean {
  for (let i = stack.length - 1; i > 0; i--) {
    const tag = stack[i]!.tag;
    if (tag === "li") return true;
    if (listItemScopeStops.has(tag)) return false;
  }
  return false;
}
const inertAttributeTags: Readonly<Record<string, ReadonlySet<string>>> = {
  alt: new Set(["img"]),
  colspan: new Set(["td", "th"]),
  height: new Set(["hr", "img"]),
  href: new Set(["a"]),
  rel: new Set(["a"]),
  reversed: new Set(["ol"]),
  rowspan: new Set(["td", "th"]),
  src: new Set(["img"]),
  start: new Set(["ol"]),
  target: new Set(["a"]),
  width: new Set(["hr", "img"]),
};
function hasUnsafeCssFunction(value: string): boolean {
  const decoded = value
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gs, " ")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(
      /\\([\da-f]{1,6})\s?|\\(.)/gi,
      (_match, hex: string | undefined, char: string | undefined) => {
        if (!hex) return char ?? "";
        const codePoint = parseInt(hex, 16);
        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
      },
    );
  return /(?:^|[^a-z0-9_-])(?:url|var|image-set|-webkit-image-set|image|symbols|cross-fade|element|paint|src|expression)\s*\(/i.test(
    decoded,
  );
}
const safeOpaqueStyleProperties = new Set([
  "text-align",
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "width",
  "height",
  "display",
  "vertical-align",
  "white-space",
  "list-style-type",
  "opacity",
]);
function isSafeOpaqueStyleProperty(property: string): boolean {
  return (
    safeOpaqueStyleProperties.has(property) ||
    /^margin(?:-(?:top|right|bottom|left|block(?:-start|-end)?|inline(?:-start|-end)?))?$/.test(
      property,
    ) ||
    /^padding(?:-(?:top|right|bottom|left|block(?:-start|-end)?|inline(?:-start|-end)?))?$/.test(
      property,
    ) ||
    /^border(?:-(?:top|right|bottom|left|block(?:-start|-end)?|inline(?:-start|-end)?))?(?:-(?:width|color|style))?$/.test(
      property,
    ) ||
    /^(?:min|max)-(?:width|height|inline-size|block-size)$/.test(property) ||
    /^text-decoration(?:-(?:line|color|style|thickness))?$/.test(property)
  );
}
function safeOpaqueStyle(style: string): boolean {
  let declaration = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let depth = 0;
  const allowed = (part: string): boolean => {
    const trimmed = part.trim();
    if (!trimmed) return true;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) return false;
    const property = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1);
    return (
      /^[a-z][a-z0-9-]*$/.test(property) &&
      isSafeOpaqueStyleProperty(property) &&
      !hasUnsafeCssFunction(value)
    );
  };

  for (const character of style) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      depth++;
    } else if (character === ")") {
      if (depth === 0) return false;
      depth--;
    } else if (character === ";" && depth === 0) {
      if (!allowed(declaration)) return false;
      declaration = "";
      continue;
    }
    declaration += character;
  }
  return !escaped && !quote && depth === 0 && allowed(declaration);
}
function parseHtml(html: string): HtmlNode[] {
  clean(html);
  const root: Element = {
    tag: "root",
    attrs: {},
    children: [],
    raw: "",
    open: "",
    start: 0,
    unsupported: false,
  };
  const stack = [root];
  let pos = 0;
  let count = 0;
  while (pos < html.length) {
    if (++count > 30_000 || stack.length > 64) fail("document_too_complex");
    const parent = stack.at(-1)!;
    if (html[pos] !== "<") {
      const end = html.indexOf("<", pos);
      const next = end < 0 ? html.length : end;
      const decoded = entities(html.slice(pos, next));
      if (decoded.unsupported) parent.unsupported = true;
      if (decoded.value.trim()) {
        // A browser moves text out of a table (foster parenting); it keeps
        // text in a list where it is.
        if (["table", "thead", "tbody", "tfoot", "tr"].includes(parent.tag))
          fail("stray_text_in_table");
        if (["ul", "ol"].includes(parent.tag)) defer("stray_text_in_container");
      }
      parent.children.push(decoded.value);
      pos = next;
      continue;
    }
    const closing = /^<\/([a-z][a-z0-9:_-]*)\s*>/i.exec(html.slice(pos));
    if (closing) {
      if (stack.length === 1 || parent.tag !== closing[1]!.toLowerCase()) fail("mismatched_tag");
      pos += closing[0].length;
      parent.raw = html.slice(parent.start, pos);
      stack.pop();
      continue;
    }
    const open = /^<([a-z][a-z0-9:_-]*)/i.exec(html.slice(pos));
    if (!open) fail("malformed_markup");
    const tag = open[1]!.toLowerCase();
    if (forbiddenTags.has(tag)) fail("forbidden_tag");
    const knownTag = tags.has(tag);
    // Reject structures a browser would repair/reparent before rendering.
    const phrasing = new Set(
      "strong b em i u s strike del code a br span img sup sub mark".split(" "),
    );
    if (
      knownTag &&
      (["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(parent.tag) ||
        phrasing.has(parent.tag)) &&
      !phrasing.has(tag)
    )
      fail("misnested_block");
    if (knownTag && tag === "a" && stack.some((n) => n.tag === "a")) fail("nested_anchor");
    const requiredChildren: Record<string, string[]> = {
      ul: ["li"],
      ol: ["li"],
      table: ["thead", "tbody", "tfoot", "tr"],
      thead: ["tr"],
      tbody: ["tr"],
      tfoot: ["tr"],
      tr: ["th", "td"],
    };
    if (knownTag && requiredChildren[parent.tag] && !requiredChildren[parent.tag]!.includes(tag)) {
      // A browser keeps a list directly inside a list where it is.
      if (["ul", "ol"].includes(parent.tag) && ["ul", "ol"].includes(tag)) defer("nested_list");
      else fail("invalid_child");
    }
    const requiredParents: Record<string, string[]> = {
      li: ["ul", "ol"],
      thead: ["table"],
      tbody: ["table"],
      tfoot: ["table"],
      tr: ["table", "thead", "tbody", "tfoot"],
      th: ["tr"],
      td: ["tr"],
    };
    if (
      knownTag &&
      (parent.tag === "root" || tags.has(parent.tag)) &&
      requiredParents[tag] &&
      !requiredParents[tag]!.includes(parent.tag)
    ) {
      // A bare `<li>` stays where it is, unless it would close an open one.
      if (tag === "li" && !closesOpenListItem(stack)) defer("orphan_list_item");
      else fail("misplaced_element");
    }
    const start = pos;
    pos += open[0].length;
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    let unsupported = false;
    while (!/^\s*\/?>/.test(html.slice(pos))) {
      const attr = /^\s+([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(
        html.slice(pos),
      );
      if (!attr) fail("malformed_attribute");
      const key = attr[1]!.toLowerCase();
      const rawValue = attr[2] ?? attr[3] ?? attr[4] ?? "";
      const decoded = entities(rawValue);
      if (Object.hasOwn(attrs, key)) fail("duplicate_attribute");
      if (key.startsWith("on") || forbiddenExternalReferenceAttributes.has(key))
        fail("active_attribute");
      // These inert decorations are retained opaquely when the model cannot
      // represent them; style declarations pass a closed property allowlist.
      const paragraphDecoration = tag === "p" && key === "id";
      const allowed =
        /^(data-[a-z0-9-]+|aria-[a-z0-9-]+)$/.test(key) ||
        key === "class" ||
        key === "title" ||
        key === "style" ||
        key === "dir" ||
        inertAttributeTags[key]?.has(tag) === true ||
        paragraphDecoration;
      // Every attribute of the element is examined: an unrecognised one is
      // deferred, so a fetching or active attribute after it still decides.
      if (!allowed) {
        if (fetchingAttributes.has(key)) fail("fetching_attribute");
        defer("attr_unrecognised");
      }
      if (key === "style" && (decoded.unsupported || !safeOpaqueStyle(decoded.value)))
        fail("unsafe_style");
      if (key === "dir" && !/^(ltr|rtl|auto)$/i.test(decoded.value)) defer("dir_unrecognised");
      if (decoded.unsupported) unsupported = true;
      if (key === "href" || key === "src") {
        // Hostile first: an entity a browser may decode, then the URL itself
        // (which still holds any raw `&` literally), then the raw `&`.
        if (decoded.unsupported && !decoded.raw) fail("entity_encoded_url");
        url(decoded.value, key === "src");
        if (decoded.unsupported) defer("url_raw_ampersand");
      }
      attrs[key] = decoded.value;
      pos += attr[0].length;
    }
    const end = /^\s*(\/?)>/.exec(html.slice(pos))!;
    pos += end[0].length;
    if (end[1] && !voids.has(tag)) fail("self_closing_element");
    const raw = html.slice(start, pos);
    const node: Element = {
      tag,
      attrs,
      children: [],
      raw,
      open: raw,
      start,
      unsupported,
    };
    parent.children.push(node);
    if (!end[1] && !voids.has(tag)) stack.push(node);
  }
  if (stack.length !== 1) fail("unclosed_element");
  return root.children;
}
/** Fail-closed preflight for legacy writers that cannot retain rich-list titles. */
export function hasNonemptyNativeTaskListTitle(html: string): boolean {
  const visit = (nodes: HtmlNode[]): boolean =>
    nodes.some((node) => {
      if (typeof node === "string") return false;
      return (
        ((node.tag === "ul" || node.tag === "ol") &&
          (node.attrs.class ?? "")
            .split(/\s+/)
            .some((token) => ["checklist", "simple-checklist"].includes(token)) &&
          node.attrs["data-title"] !== undefined &&
          node.attrs["data-title"]!.length > 0) ||
        visit(node.children)
      );
    });
  return visit(parseHtml(html));
}
// Internal signal: syntactically safe but not representable without data loss.
class Preserve extends Error {}
function preserve(): never {
  throw new Preserve();
}
/**
 * Check the attribute values this tag's decoding actually interprets. The
 * parser has already refused active or unsupported attribute names; accepted
 * inert decoration that the model does not read is ignored.
 */
function attrs(n: Element, meaningful: Record<string, string | RegExp> = {}): void {
  for (const [key, value] of Object.entries(n.attrs)) {
    if ((n.tag === "p" && key === "id") || key === "style" || key === "dir") preserve();
    const rule = meaningful[key];
    if (rule === undefined) continue;
    if (typeof rule === "string" ? rule !== value : !rule.test(value)) preserve();
  }
}
/**
 * Reject ANY attribute on an element whose canonical form carries none.
 *
 * Used for inline marks and table cells. Dropping an attribute from either
 * would be a silent downgrade, so the containing block stays opaque.
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
    let marks = canonicalMarks(run.marks ?? []);
    const keys = marks.map((m) => (typeof m === "string" ? m : m.type));
    if (new Set(keys).size !== keys.length) {
      // Deferred in a decode: keep the first of each mark so the document
      // stays valid and the scan reaches the validator's bounds.
      defer("duplicate_mark");
      marks = marks.filter((_, i) => keys.indexOf(keys[i]!) === i);
    }
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
function taskItems(n: Element, kind: NotesnookListKind, allowTitle = false): NoteTaskItem[] {
  attrs(n, {
    class: kind === "task-list" ? "checklist" : "simple-checklist",
    ...(allowTitle ? { "data-title": /.*/ } : {}),
  });
  if (!allowTitle && n.attrs["data-title"] !== undefined) preserve();
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
/**
 * Private decode record of one block: its source bytes and structural identity.
 * Held only in the decode context, never in the document or on the wire.
 */
interface BlockRecord {
  readonly raw: string;
  /**
   * Opening-tag bytes. Emitted only for a container identified as this same
   * instance: one that holds preserved regions and whose anchor chain names
   * this record, or one whose whole block matched exactly and is echoed raw.
   */
  readonly open: string;
  readonly type: NoteBlock["type"];
  readonly variant: string | undefined;
  /** True when this block is, or contains, a preserved region. */
  readonly holdsRegion: boolean;
  readonly canon: string;
  readonly digest: string;
  readonly children: readonly BlockRecord[];
}
interface PrivateContext {
  binding: string;
  original: NotesnookStoredContent;
  /** The document container's original opening tag, when the note had one. */
  container: string | undefined;
  baseline: string;
  refs: string[];
  payloads: Map<string, string>;
  blocks: readonly BlockRecord[];
}
const contexts = new WeakMap<NativeNoteContext, PrivateContext>();
const digestOf = (canon: string): string => createHash("sha256").update(canon).digest("hex");
const variantOf = (b: NoteBlock): string | undefined =>
  b.type === "callout" ? b.variant : undefined;
const holdsRegion = (b: NoteBlock): boolean =>
  b.type === "opaque" ||
  ((b.type === "blockquote" || b.type === "callout") && b.blocks.some(holdsRegion));
/** Containers that can hold blocks, keyed by type and variant. */
function containerKey(b: NoteBlock): string | undefined {
  return b.type === "blockquote" ||
    b.type === "callout" ||
    b.type === "bullet-list" ||
    b.type === "ordered-list"
    ? `${b.type}:${variantOf(b) ?? ""}`
    : undefined;
}
/**
 * Preserved regions are anchored by document order, not position: each token
 * once, in order, inside the same chain of containers. Each link of the chain
 * is the container's type, variant and its ordinal among the same-type,
 * same-variant siblings before it, so a region cannot hop between two
 * look-alike containers.
 *
 * First-release limitation (plan-owner ruling): the ordinal is positional, so
 * inserting or deleting a same-type, same-variant container BEFORE an anchored
 * container shifts that container's ordinal and refuses the edit. A container
 * of a different type, or of the same type with a different variant, does not
 * count toward the ordinal and stays accepted.
 */
function references(doc: NoteDocumentV1): string[] {
  const refs: string[] = [];
  const tokens = new Set<string>();
  function walk(blocks: readonly NoteBlock[], chain: string): void {
    const seen = new Map<string, number>();
    const link = (b: NoteBlock): string => {
      const key = containerKey(b)!;
      const ordinal = seen.get(key) ?? 0;
      seen.set(key, ordinal + 1);
      return `${chain}/${key}#${ordinal}`;
    };
    for (const b of blocks) {
      if (b.type === "opaque") {
        if (tokens.has(b.sentinel.token)) fail("duplicate_opaque_token");
        tokens.add(b.sentinel.token);
        refs.push(
          JSON.stringify([
            chain,
            b.nodeType,
            b.sentinel.version,
            b.sentinel.source,
            b.sentinel.token,
            b.text,
          ]),
        );
      }
      if (b.type === "callout" || b.type === "blockquote") walk(b.blocks, link(b));
      if (b.type === "bullet-list" || b.type === "ordered-list") {
        const next = link(b);
        for (const item of b.items) walk(item.blocks ?? [], next);
      }
    }
  }
  walk(doc.blocks, "");
  return refs;
}
/** Beyond this many cells the quadratic table is skipped and the middle is rebuilt. */
const MAX_ALIGN_CELLS = 4_000_000;
interface Aligned {
  readonly record: BlockRecord;
  /** True when the edited block equals the original, so its bytes are echoed. */
  readonly exact: boolean;
}
/**
 * Match an edited block list against the original in order: a longest common
 * subsequence over fingerprints, confirmed by structural equality, one original
 * per edited block at most. An edited container holding preserved regions is
 * additionally identified with its original by ordinal, so edits inside it keep
 * its opening tag and unchanged children.
 */
function align(
  blocks: readonly NoteBlock[],
  records: readonly BlockRecord[],
): (Aligned | undefined)[] {
  const canon = blocks.map(fingerprint);
  const digest = canon.map(digestOf);
  const same = (i: number, j: number): boolean =>
    digest[i] === records[j]!.digest && canon[i] === records[j]!.canon;
  const n = blocks.length;
  const m = records.length;
  const pairs: [number, number][] = [];
  let head = 0;
  while (head < n && head < m && same(head, head)) pairs.push([head, head++]);
  let tail = 0;
  while (tail < n - head && tail < m - head && same(n - 1 - tail, m - 1 - tail)) tail++;
  const rows = n - head - tail;
  const cols = m - head - tail;
  if (rows > 0 && cols > 0 && rows * cols <= MAX_ALIGN_CELLS) {
    // lcs[i][j]: length of the longest common subsequence of the suffixes.
    const width = cols + 1;
    const lcs = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--)
      for (let j = cols - 1; j >= 0; j--)
        lcs[i * width + j] = same(head + i, head + j)
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    // Walking forward and taking every equal pair keeps the earliest copy.
    for (let i = 0, j = 0; i < rows && j < cols; ) {
      if (same(head + i, head + j)) pairs.push([head + i++, head + j++]);
      else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) i++;
      else j++;
    }
  }
  for (let k = 0; k < tail; k++) pairs.push([n - tail + k, m - tail + k]);
  const plan: (Aligned | undefined)[] = new Array<Aligned | undefined>(n).fill(undefined);
  for (const [i, j] of pairs) plan[i] = { record: records[j]!, exact: true };
  // Bytes are never borrowed by guessing. An edited container that is not an
  // exact match takes its original opening tag only if it holds preserved
  // regions and its ordinal among same-type, same-variant siblings names an
  // original that holds regions too; `references` has already proven that the
  // regions inside sit at the same anchor chain. Anything else, including a
  // delete-and-insert in a gap, is rebuilt with the canonical tag, so editing a
  // container without regions drops its tolerated attributes (accepted).
  const used = new Set(pairs.map(([, j]) => records[j]!));
  const ordinals = new Map<string, number>();
  blocks.forEach((b, i) => {
    if (b.type !== "blockquote" && b.type !== "callout") return;
    const key = containerKey(b)!;
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    if (plan[i] || !holdsRegion(b)) return;
    const record = records.filter((r) => `${r.type}:${r.variant ?? ""}` === key)[ordinal];
    if (!record?.holdsRegion || used.has(record)) return;
    used.add(record);
    plan[i] = { record, exact: false };
  });
  return plan;
}
/** What a derived text costs on the wire: escaped into the directive, then JSON-encoded again. */
function opaqueTextCharge(text: string): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(text)), "utf8");
}

/**
 * Readable Markdown for a preserved region, bounded by the wire budget.
 *
 * The bytes are rendered by the read-only HTML renderer, which never executes
 * or fetches anything, and then clamped to whichever is smaller: the per-block
 * cap the editor document admits, or the budget the caller has left. Both are
 * measured as they cost on the wire — the text is escaped into the directive and
 * the whole body is JSON-encoded again in the response — so a budget of N is a
 * promise about the frame, not about raw bytes. Clamping keeps the decoder's
 * output a document its own validator accepts; an unbounded rendering of a large
 * region would otherwise fail validation, turning preserving into a refusal.
 *
 * The clamp is on a code-point boundary, so the text stays valid UTF-8, and it
 * ends with an ellipsis so a reader can tell the text is incomplete.
 */
export function readableOpaqueText(
  raw: string,
  wireBudget = opaqueTextCharge("x".repeat(MAX_NOTE_DOCUMENT_OPAQUE_TEXT_BYTES)),
): string | undefined {
  // Rendering costs time; below this floor no useful prefix can fit anyway.
  if (wireBudget < 68) return undefined;
  let rendered: string;
  try {
    rendered = noteHtmlReadonlyMarkdown(raw);
  } catch {
    // The read-only renderer has its own bounds and tokenizer, so it can refuse
    // bytes the native parser preserved. A refusal here means the region stays
    // reference-only: it must not turn preserving into a decode failure.
    return undefined;
  }
  // A region that renders to nothing carries no text at all: an empty
  // `text=""` would claim a readability it does not add.
  if (rendered.length === 0) return undefined;
  const fits = (value: string): boolean =>
    Buffer.byteLength(value, "utf8") <= MAX_NOTE_DOCUMENT_OPAQUE_TEXT_BYTES &&
    opaqueTextCharge(value) <= wireBudget;
  if (fits(rendered)) return rendered;
  // Leave room for a marker, so the reader can tell the text is incomplete.
  const marker = "\u2026";
  const characters = [...rendered];
  let low = 0;
  let high = characters.length;
  // The largest prefix whose charge, with the marker, still fits.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(characters.slice(0, mid).join("") + marker)) low = mid;
    else high = mid - 1;
  }
  // Below this floor the clamp would mint a stub ("#…") that helps no reader,
  // so the region keeps its reference and carries no text.
  if (low < 64) return undefined;
  return characters.slice(0, low).join("") + marker;
}

const MARKDOWN_LIMIT_ERRORS: ReadonlySet<NoteDocumentErrorCode> = new Set([
  "oversize_document",
  "oversize_block",
  "oversize_inline",
  "oversize_sentinel",
  "depth_exceeded",
]);

/**
 * A native block is only modelled when the public Markdown interchange can
 * represent it losslessly. A safe native shape outside that grammar stays as
 * one opaque reference instead of making the whole note fall back.
 *
 * Only an emission or round-trip refusal is a representability verdict about
 * this block: those stages are the codec saying it cannot spell what it was
 * given. A validation or reference refusal is the codec disagreeing with the
 * document model itself, which a preserved block must not paper over — the
 * block stays typed and the note-level serializer refuses the note, so the
 * fallback is reported rather than silently converted. Size and depth codes are
 * never demoted either: a Markdown-side limit refusal leaves the block typed and
 * surfaces as a note-level serializer fallback, not a silent rewrite. The
 * decoder's own bounded opaque-text retry is a different mechanism, triggered
 * only by a native `document_bounds_exceeded`.
 */
function preserveIfMarkdownUnrepresentable(block: NoteBlock): void {
  try {
    serializeNoteDocumentMarkdown({ version: 1, blocks: [block] });
  } catch (error) {
    if (!isNoteDocumentError(error)) throw error;
    if (MARKDOWN_LIMIT_ERRORS.has(error.code)) return;
    if (
      error.serializationStage === "markdown_emission" ||
      error.serializationStage === "round_trip"
    )
      preserve();
  }
}

function decodeBlocks(
  nodes: HtmlNode[],
  payloads: Map<string, string>,
  binding: string,
  topLevel: boolean,
  records: BlockRecord[],
  textBudget: { remaining: number },
  mintText: boolean,
): NoteBlock[] {
  return elements(nodes).map((n) => {
    const children: BlockRecord[] = [];
    try {
      if (containsUnsupportedMarkup(n)) preserve();
      const block = decodeBlock(n, payloads, binding, topLevel, children, textBudget, mintText);
      preserveIfMarkdownUnrepresentable(block);
      const canon = fingerprint(block);
      records.push({
        raw: n.raw,
        open: n.open,
        type: block.type,
        variant: variantOf(block),
        holdsRegion: holdsRegion(block),
        canon,
        digest: digestOf(canon),
        children,
      });
      return block;
    } catch (error) {
      if (!(error instanceof Preserve)) throw error;
      // Deterministic, revision-bound, position-mixed token. The operator
      // preimage contract spans two independent decodes of the same stored
      // content: one mints the Markdown, a later one validates it. A random
      // token could never be re-derived by the second decode, while a token
      // that omitted the binding could be replayed from an older revision.
      // `payloads` is created per decode, so its size is this reference's
      // traversal index — deterministic for identical input and binding, and
      // distinct for two identical subtrees in one document.
      const token = createHmac("sha256", placeholderKey)
        .update(JSON.stringify([binding, payloads.size, n.raw]))
        .digest("hex")
        .slice(0, 36);
      payloads.set(token, n.raw);
      // `readableOpaqueText` clamps against the budget it is given, measured as
      // the text costs on the wire, so a minted value already fits the budget.
      const text = mintText ? readableOpaqueText(n.raw, textBudget.remaining) : undefined;
      if (text !== undefined) textBudget.remaining -= opaqueTextCharge(text);
      const block: NoteBlock = {
        type: "opaque",
        nodeType: n.tag,
        ...(text === undefined ? {} : { text }),
        sentinel: { version: 1, source: "native-html", token },
      };
      const canon = fingerprint(block);
      records.push({
        raw: n.raw,
        open: n.open,
        type: "opaque",
        variant: undefined,
        holdsRegion: true,
        canon,
        digest: digestOf(canon),
        children: [],
      });
      return block;
    }
  });
}
function containsUnsupportedMarkup(n: Element): boolean {
  return (
    n.unsupported ||
    n.children.some((child) => typeof child !== "string" && containsUnsupportedMarkup(child))
  );
}
function decodeBlock(
  n: Element,
  payloads: Map<string, string>,
  binding: string,
  topLevel: boolean,
  children: BlockRecord[],
  textBudget: { remaining: number },
  mintText: boolean,
): NoteBlock {
  if (n.tag === "hr") {
    const canonicalStyle =
      "display:block;border:0;border-top:1px solid currentColor;height:0;margin:1em 0";
    if (
      Object.keys(n.attrs).some((key) => key !== "style") ||
      n.attrs.style !== canonicalStyle ||
      n.children.length !== 0
    )
      preserve();
    return { type: "horizontal-rule" };
  }
  if (n.tag === "p" || /^h[1-3]$/.test(n.tag)) {
    attrs(n);
    const inlines = inline(n.children);
    return n.tag === "p"
      ? { type: "paragraph", inlines }
      : { type: "heading", level: Number(n.tag[1]) as 1 | 2 | 3, inlines };
  }
  if (n.tag === "ul" || n.tag === "ol") {
    const kind = listKind(n);
    if (kind) {
      const title = n.attrs["data-title"];
      if (!topLevel && title !== undefined && title.length > 0) preserve();
      if (title !== undefined && kind !== "task-list") preserve();
      const items = taskItems(n, kind, true);
      return {
        type: "task-list",
        kind,
        items,
        ...(title === undefined || title.length === 0 ? {} : { title }),
      };
    }
    // A class naming a checklist kind but not exactly one cannot be represented
    // faithfully: preserving its item states as ordinary bullets would lose
    // meaning. Decorative classes that contain no checklist token are ignored.
    const classes = (n.attrs.class ?? "").split(/\s+/).filter(Boolean);
    if (classes.includes("checklist") || classes.includes("simple-checklist")) preserve();
    // Numbering data has no representation in the document model.
    if (n.attrs.start !== undefined || n.attrs.reversed !== undefined) preserve();
    if (n.attrs["data-title"] !== undefined) preserve();
    attrs(n);
    const items = elements(n.children).map((li) => {
      if (li.tag !== "li") preserve();
      attrs(li);
      const first = li.children[0];
      if (typeof first === "object" && first.tag === "p") {
        attrs(first);
        // The Markdown writer rejects every ordinary-list item continuation
        // (`item.blocks`), so preserve the containing list opaquely instead of
        // admitting a decoded child the interchange cannot serialize. This
        // covers HR and all other recursive continuation shapes without
        // widening ordinary-list Markdown support.
        if (li.children.slice(1).some((child) => typeof child !== "string" || child.trim() !== ""))
          preserve();
        return { inlines: inline(first.children) };
      }
      // Legacy writer emits bare inline list labels.
      return { inlines: inline(li.children) };
    });
    return { type: n.tag === "ul" ? "bullet-list" : "ordered-list", items };
  }
  if (n.tag === "blockquote") {
    attrs(n);
    return {
      type: "blockquote",
      blocks: decodeBlocks(n.children, payloads, binding, false, children, textBudget, mintText),
    };
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
      blocks: decodeBlocks(n.children, payloads, binding, false, children, textBudget, mintText),
    };
  }
  return preserve();
}
export function decodeNoteDocumentNative(
  envelope: unknown,
  binding: NativeNoteBinding,
): { readonly document: NoteDocumentV1; readonly context: NativeNoteContext } {
  return scanned(() => {
    const key = bindingKey(binding);
    const r = record(snapshot(envelope), ["type", "data"]);
    if ((r.type !== "html" && r.type !== "tiptap") || typeof r.data !== "string")
      defer("envelope_shape");
    // A string body under an unknown type is still scanned as markup, so its
    // class is certified like any other; with no string body there is none.
    const data = typeof r.data === "string" ? r.data : "";
    const original = bounded({ type: r.type as NotesnookStoredContent["type"], data });
    const nodes = parseHtml(data);
    const roots = elements(nodes);
    if (!roots.length && data.trim()) defer("document_without_blocks");
    let content: HtmlNode[] = roots;
    let container: string | undefined;
    // The document container is structural. Its accepted presentation and data
    // attributes do not alter its content, so decode its children as the root.
    // Its opening tag is kept so a rewrite can emit the same bytes.
    if (
      roots.length === 1 &&
      roots[0]!.tag === "div" &&
      roots[0]!.attrs["data-type"] === "document" &&
      roots[0]!.attrs.dir === undefined
    ) {
      content = roots[0]!.children;
      container = roots[0]!.open;
    }
    // Readable `text` is minted first, on the assumption that the note fits.
    // A container whose own byte cap is now reached by its children's text
    // would make `validated` reject a document the decoder itself produced, so
    // the decode is retried once with the text left out. The retry depends only
    // on the input, so the read decode and the write decode still agree.
    const build = (mintText: boolean) => {
      const payloads = new Map<string, string>();
      const blocks: BlockRecord[] = [];
      const textBudget = { remaining: MAX_NOTE_DOCUMENT_OPAQUE_TEXT_TOTAL_BYTES };
      const document: NoteDocumentV1 = {
        version: 1,
        blocks: decodeBlocks(content, payloads, key, true, blocks, textBudget, mintText),
      };
      return { document, payloads, blocks };
    };
    let built = build(true);
    try {
      validated(built.document);
    } catch (error) {
      // Only a bound failure can be caused by the text itself: a container's
      // byte cap counts its children, and readable text makes children big.
      const boundExceeded =
        error instanceof NoteDocumentNativeError && error.reason === "document_bounds_exceeded";
      if (!boundExceeded) throw error;
      built = build(false);
      validated(built.document);
    }
    const { document, payloads, blocks } = built;
    const context: NativeNoteContext = Object.freeze({ version: 1 });
    contexts.set(context, {
      binding: key,
      original,
      container,
      baseline: fingerprint(document),
      refs: references(document),
      payloads,
      blocks,
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
        if (seen.has(key)) fail("duplicate_mark_output");
        seen.add(key);
        if (typeof mark === "object") out = `<a href="${escape(url(mark.href))}">${out}</a>`;
        else {
          const tag =
            (
              { bold: "strong", italic: "em", underline: "u", strike: "s", code: "code" } as Record<
                string,
                string
              >
            )[mark] ?? fail("unknown_mark");
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
  records?: readonly BlockRecord[],
): string {
  const render = (bs: readonly NoteBlock[], rs?: readonly BlockRecord[]) =>
    renderBlocks(bs, kind, payloads, rs);
  const plan = records && align(blocks, records);
  return blocks
    .map((b, i) => {
      const aligned = plan?.[i];
      // An unchanged block keeps the bytes it was decoded from.
      if (aligned?.exact) return aligned.record.raw;
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
        case "task-list": {
          const taskKind = b.kind ?? kind;
          const title =
            b.title === undefined || b.title.length === 0 ? "" : ` data-title="${escape(b.title)}"`;
          return `<ul class="${taskKind === "task-list" ? "checklist" : "simple-checklist"}"${title}>${b.items.map((item) => `<li class="${item.checked ? "checked " : ""}${taskKind === "task-list" ? "checklist" : "simple-checklist"}--item"><p>${renderInline(item.inlines)}</p>${item.children.length ? renderTasks(item.children, taskKind) : ""}</li>`).join("")}</ul>`;
        }
        case "blockquote":
          return `${aligned?.record.open ?? "<blockquote>"}${render(b.blocks, aligned?.record.children)}</blockquote>`;
        case "code-block":
          if (b.language !== undefined && !/^[A-Za-z0-9_+-]+$/.test(b.language))
            fail("code_language_invalid");
          return `<pre><code${b.language ? ` class="language-${escape(b.language)}"` : ""}>${escape(b.text)}</code></pre>`;
        case "table":
          if (!b.columns.length) fail("table_without_columns");
          return `<table><thead><tr>${b.columns.map((c) => `<th>${escape(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((row) => `<tr>${row.map((c) => `<td>${escape(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
        case "callout":
          return `${aligned?.record.open ?? `<div data-type="callout" data-variant="${b.variant}">`}${render(b.blocks, aligned?.record.children)}</div>`;
        case "horizontal-rule":
          return '<hr style="display:block;border:0;border-top:1px solid currentColor;height:0;margin:1em 0" />';
        case "image":
        case "attachment":
        case "embed":
          // These node types still have no native HTML encoding.
          return fail("block_not_serializable");
        case "opaque":
          return payloads?.get(b.sentinel.token) ?? fail("opaque_payload_missing");
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
        "task-list": ["type", "kind", "title", "items"],
        blockquote: ["type", "blocks"],
        "code-block": ["type", "text", "language"],
        table: ["type", "columns", "rows"],
        callout: ["type", "variant", "blocks"],
        "horizontal-rule": ["type"],
        image: ["type", "url", "alt"],
        attachment: ["type", "url", "name", "mime"],
        embed: ["type", "url"],
        opaque: ["type", "nodeType", "sentinel", "text"],
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
      fail("options_not_plain");
    const descriptors = Object.getOwnPropertyDescriptors(options);
    for (const [key, d] of Object.entries(descriptors))
      if (!["context", "binding", "listKind", "writer"].includes(key) || !("value" in d))
        fail("options_unexpected_field");
    const writer = options.writer ?? "html";
    if (writer === "json" && !NOTESNOOK_JSON_WRITER_ENABLED) fail("json_writer_disabled");
    if (writer !== "html") fail("writer_unsupported");
    const kind = normaliseNotesnookListKind(options.listKind);
    const doc = snapshot(document);
    validated(doc);
    closedDocument(doc);
    const context = options.context === undefined ? undefined : contexts.get(options.context);
    if (options.context !== undefined && !context) fail("context_unknown");
    if (context && context.binding !== bindingKey(options.binding))
      fail("context_binding_mismatch");
    if (JSON.stringify(references(doc)) !== JSON.stringify(context?.refs ?? []))
      fail("context_references_mismatch");
    if (context && fingerprint(doc) === context.baseline) return context.original;
    return bounded({
      type: context?.original.type ?? "tiptap",
      data: `${context?.container ?? '<div data-type="document">'}${renderBlocks(doc.blocks, kind, context?.payloads, context?.blocks)}</div>`,
    });
  });
}
