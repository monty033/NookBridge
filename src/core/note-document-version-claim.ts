/**
 * Reserved `nookbridge-format` version-claim classifier.
 *
 * The canonical v1 interchange starts with a fixed YAML-looking header. Any
 * other input that claims that reserved top-level key (quoted, escaped, tagged,
 * anchored, explicit-key, multiline, flow, merged, alias-resolved, behind a
 * commented or inline `---` opener, ...) must never be reinterpreted as legacy
 * Markdown. Recognising those spellings is YAML semantics, so the leading
 * header is parsed with the pinned `yaml` parser and the resulting AST is
 * inspected; there is no regex over the key itself.
 *
 * Containment, because the input is attacker-controlled:
 *   - only the first {@link MARKDOWN_VERSION_CLAIM_MAX_HEADER_BYTES} are ever
 *     examined; a header that is not closed inside that window is ambiguous
 *     and the remainder of the input is never parsed;
 *   - pretty diagnostics are off, so no input text is copied into errors;
 *   - anchors/aliases are resolved by this module against a table built from
 *     the AST in document order. Aliases and merges are never expanded into
 *     values, and alias count, node count, depth and merge work are capped;
 *   - the first parse error, unknown warning, budget overrun or thrown
 *     exception classifies the input as `ambiguous`.
 *
 * `claim-free` is returned only for input that either has no leading `---`
 * header or whose cleanly parsed header has no reserved top-level key.
 */
import { Buffer } from "node:buffer";
import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";

export const MARKDOWN_VERSION_CLAIM_MAX_HEADER_BYTES = 8 * 1024;
const MAX_ALIASES = 32;
const MAX_NODES = 1_024;
const MAX_DEPTH = 16;
const MAX_MERGE_WORK = 256;
const RESERVED_KEY = "nookbridge-format";

export type MarkdownVersionClaim = "claim-free" | "claimed" | "ambiguous";

class Ambiguous extends Error {}
function ambiguous(): never {
  throw new Ambiguous();
}

export function classifyMarkdownVersionClaim(markdown: unknown): MarkdownVersionClaim {
  try {
    if (typeof markdown !== "string") return "ambiguous";
    return classify(markdown);
  } catch {
    return "ambiguous";
  }
}

const isBreak = (c: string | undefined): boolean => c === "\n" || c === "\r";
const isBlank = (c: string | undefined): boolean => c === " " || c === "\t";

/** Index of the next line start after the line beginning at `from`, or -1. */
function nextLineStart(text: string, from: number): number {
  let i = from;
  while (i < text.length && !isBreak(text[i])) i += 1;
  if (i >= text.length) return -1;
  return text[i] === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
}

/**
 * A YAML document marker (`---` or `...`) starting at `at`. A marker flush
 * against the end of a truncated window is not provably a marker.
 */
function marker(text: string, at: number, token: "---" | "...", complete: boolean): boolean {
  if (!text.startsWith(token, at)) return false;
  if (at + 3 >= text.length) return complete;
  return isBlank(text[at + 3]) || isBreak(text[at + 3]);
}

function classify(markdown: string): MarkdownVersionClaim {
  const truncated = markdown.length > MARKDOWN_VERSION_CLAIM_MAX_HEADER_BYTES;
  const window = truncated ? markdown.slice(0, MARKDOWN_VERSION_CLAIM_MAX_HEADER_BYTES) : markdown;

  // Locate the opener: the first non-blank line, which must be a column-zero
  // `---` marker (directive-end), optionally followed by a comment or inline
  // content. Anything else is not a header.
  let opener = markdown.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    let first = opener;
    while (first < window.length && isBlank(window[first])) first += 1;
    if (first >= window.length) return truncated ? "ambiguous" : "claim-free";
    if (isBreak(window[first])) {
      opener = window[first] === "\r" && window[first + 1] === "\n" ? first + 2 : first + 1;
      continue;
    }
    if (first !== opener) return "claim-free";
    break;
  }
  if (!window.startsWith("---", opener)) return "claim-free";
  const after = window[opener + 3];
  if (opener + 3 >= window.length) {
    if (truncated) return "ambiguous";
  } else if (!isBlank(after) && !isBreak(after)) {
    return "claim-free";
  }

  // Close the header at the first following `---` / `...` marker line.
  let end = window.length;
  let closed = false;
  for (let at = nextLineStart(window, opener); at !== -1; at = nextLineStart(window, at)) {
    if (marker(window, at, "---", !truncated) || marker(window, at, "...", !truncated)) {
      end = at;
      closed = true;
      break;
    }
  }
  if (!closed && truncated) return "ambiguous";

  const header = window.slice(opener, end);
  if (Buffer.byteLength(header, "utf8") > MARKDOWN_VERSION_CLAIM_MAX_HEADER_BYTES) {
    return "ambiguous";
  }
  return inspectHeader(header);
}

type Node = unknown;

function inspectHeader(header: string): MarkdownVersionClaim {
  const doc = parseDocument(header, {
    prettyErrors: false,
    logLevel: "silent",
    merge: true,
    uniqueKeys: true,
    strict: true,
  });
  if (doc.errors.length > 0) return "ambiguous";
  // An unrecognised tag keeps the scalar as a plain string; any other warning
  // means the parser did something this module did not account for.
  if (doc.warnings.some((warning) => warning.code !== "TAG_RESOLVE_FAILED")) return "ambiguous";

  const top: Node = doc.contents;
  if (!isMap(top)) return "claim-free";

  const anchors = new Map<string, Node>();
  let nodes = 0;
  let aliases = 0;
  let work = 0;

  const register = (node: Node): void => {
    const name = (node as { anchor?: unknown }).anchor;
    if (typeof name === "string" && name.length > 0) anchors.set(name, node);
  };
  const resolve = (node: Node): Node => {
    if (!isAlias(node)) return node;
    const target = anchors.get(node.source);
    if (target === undefined) return ambiguous();
    return target;
  };
  const walk = (node: Node, depth: number): void => {
    if (node === null || node === undefined) return;
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) ambiguous();
    if (isAlias(node)) {
      if (++aliases > MAX_ALIASES) ambiguous();
      return;
    }
    if (isMap(node) || isSeq(node)) {
      for (const item of node.items as Node[]) {
        if (isPair(item)) {
          walk(item.key, depth + 1);
          walk(item.value, depth + 1);
        } else {
          walk(item, depth + 1);
        }
      }
    }
    register(node);
  };
  const isMergeKey = (key: Node): boolean => {
    const resolved = resolve(key);
    return (
      isScalar(resolved) &&
      typeof resolved.value === "symbol" &&
      resolved.value.description === "<<"
    );
  };
  const isReserved = (key: Node): boolean => {
    const resolved = resolve(key);
    return (
      isScalar(resolved) &&
      typeof resolved.value === "string" &&
      resolved.value.toLowerCase() === RESERVED_KEY
    );
  };
  // Keys a merge value contributes, without materialising any values.
  const mergesReserved = (value: Node, depth: number): boolean => {
    if (++work > MAX_MERGE_WORK || depth > MAX_DEPTH) ambiguous();
    const source = resolve(value);
    if (isSeq(source)) {
      return (source.items as Node[]).some((item) => mergesReserved(item, depth + 1));
    }
    if (!isMap(source)) return false;
    for (const pair of source.items as Node[]) {
      if (++work > MAX_MERGE_WORK) ambiguous();
      if (!isPair(pair)) continue;
      if (isMergeKey(pair.key)) {
        if (mergesReserved(pair.value, depth + 1)) return true;
      } else if (isReserved(pair.key)) {
        return true;
      }
    }
    return false;
  };

  try {
    for (const pair of top.items as Node[]) {
      if (!isPair(pair)) return ambiguous();
      walk(pair.key, 1);
      if (isMergeKey(pair.key)) {
        walk(pair.value, 1);
        if (mergesReserved(pair.value, 1)) return "claimed";
        continue;
      }
      if (isReserved(pair.key)) return "claimed";
      walk(pair.value, 1);
    }
  } catch (error) {
    if (error instanceof Ambiguous) return "ambiguous";
    throw error;
  }
  return "claim-free";
}
