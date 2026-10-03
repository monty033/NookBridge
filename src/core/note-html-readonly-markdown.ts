import { Buffer } from "node:buffer";

const MAX_TOKENS = 30_000;
const MAX_DEPTH = 64;
const MAX_BYTES = 256 * 1024;
type Node = { tag: string; attrs: Record<string, string>; children: Array<Node | string> };
const voidTags = new Set(["br", "hr", "img", "col", "source", "input"]);
const cleanControls = (value: string, preserveNewline = false): string => {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if ((code < 0x20 && !(preserveNewline && code === 0x0a)) || code === 0x7f) continue;
    result += char;
  }
  return result;
};
const decode = (text: string): string =>
  cleanControls(
    text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isInteger(n) && n >= 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff)
          ? String.fromCodePoint(n)
          : "";
      }
      return (
        ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[
          e.toLowerCase()
        ] ?? m
      );
    }),
    true,
  );
function parse(html: string): Array<Node | string> {
  if (Buffer.byteLength(html) > MAX_BYTES) throw new Error("bounded HTML projection failed");
  const root: Node = { tag: "root", attrs: {}, children: [] };
  const stack: Node[] = [root];
  const re = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+|</g;
  let match: RegExpExecArray | null,
    count = 0,
    dropping: { tag: string; depth: number } | undefined;
  while ((match = re.exec(html))) {
    if (++count > MAX_TOKENS) throw new Error("bounded HTML projection failed");
    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;
    const close = /^<\/\s*([\w-]+)/.exec(token);
    if (close) {
      const tag = close[1]!.toLowerCase();
      if (dropping) {
        if (tag === dropping.tag) {
          dropping.depth -= 1;
          if (dropping.depth === 0) dropping = undefined;
        }
        continue;
      }
      if (stack.length > 1) {
        const idx = stack.map((n) => n.tag).lastIndexOf(tag);
        if (idx > 0) stack.length = idx;
      }
      continue;
    }
    const open = /^<([\w-]+)/.exec(token);
    if (!open) {
      if (!dropping) stack.at(-1)!.children.push(decode(token));
      continue;
    }
    const tag = open[1]!.toLowerCase();
    if (dropping) {
      if (tag === dropping.tag && !token.endsWith("/>")) dropping.depth += 1;
      continue;
    }
    if (["script", "style", "iframe", "object", "svg"].includes(tag)) {
      if (!token.endsWith("/>")) dropping = { tag, depth: 1 };
      continue;
    }
    const attrs: Record<string, string> = Object.create(null);
    const attrText = token.slice(open[0].length).replace(/\/?\s*>$/, "");
    const ar = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(attrText))) attrs[a[1]!.toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    const node: Node = { tag, attrs, children: [] };
    stack.at(-1)!.children.push(node);
    if (!voidTags.has(tag) && !token.endsWith("/>")) {
      stack.push(node);
      if (stack.length > MAX_DEPTH) throw new Error("bounded HTML projection failed");
    }
  }
  return root.children;
}
const text = (nodes: Array<Node | string>): string =>
  nodes
    .map((n) => (typeof n === "string" ? n : text(n.children)))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
const rawText = (nodes: Array<Node | string>): string =>
  nodes
    .map((n) => (typeof n === "string" ? n : n.tag === "br" ? "\n" : rawText(n.children)))
    .join("");
const escapeText = (value: string): string => value.replace(/[\\`*_[\]()<>!~|]/g, "\\$&");
const escapeLineStart = (value: string): string =>
  value.replace(/^([ \t]*)([#+\-=]|\d+[.)])/gm, (_m, ws: string, mark: string) =>
    /^\d/.test(mark) ? `${ws}${mark.slice(0, -1)}\\${mark.slice(-1)}` : `${ws}\\${mark}`,
  );
const oneLine = (value: string): string => value.replace(/\s*\n\s*/g, " ");
const inline = (nodes: Array<Node | string>): string =>
  nodes
    .map((n) => {
      if (typeof n === "string") return escapeText(n.replace(/\s+/g, " "));
      const c = inline(n.children),
        t = n.tag;
      if (t === "br") return "\n";
      if (["strong", "b"].includes(t)) return `**${c}**`;
      if (["em", "i"].includes(t)) return `*${c}*`;
      if (["s", "strike", "del"].includes(t)) return `~~${c}~~`;
      if (t === "code")
        return `\`${rawText(n.children).replace(/\s+/g, " ").trim().replace(/`/g, "")}\``;
      if (t === "a")
        return /^(https?:\/\/|mailto:)/i.test(n.attrs.href ?? "")
          ? `[${c.replace(/\s*\n\s*/g, " ")}](${(n.attrs.href ?? "").replace(/[[\]\\()]/g, "\\$&")})`
          : c;
      if (t === "img") return "[image]";
      return c;
    })
    .join("");
function blocks(nodes: Array<Node | string>, depth = 0): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (typeof n === "string") {
      if (n.trim()) out.push(escapeLineStart(escapeText(n.replace(/\s+/g, " ").trim())));
      continue;
    }
    const t = n.tag;
    if (/^h[1-6]$/.test(t))
      out.push(
        `${"#".repeat(Number(t[1]))} ${escapeLineStart(oneLine(inline(n.children).trim()))}`,
      );
    else if (t === "p") {
      const v = escapeLineStart(inline(n.children).trim());
      if (v) out.push(v);
    } else if (t === "hr") out.push("---");
    else if (t === "blockquote")
      out.push(
        blocks(n.children)
          .join("\n\n")
          .split("\n")
          .map((x) => `> ${x}`)
          .join("\n"),
      );
    else if (t === "pre") {
      const code = n.children.find((x): x is Node => typeof x !== "string" && x.tag === "code");
      const lang = code?.attrs.class?.match(/(?:^|\s)language-([A-Za-z0-9_+-]+)/)?.[1] ?? "";
      {
        const body = rawText(code ? code.children : n.children)
          .replace(/\r\n?/g, "\n")
          .replace(/^\n/, "")
          .replace(/\n+$/, "");
        const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
        const fence = "`".repeat(Math.max(3, longest + 1));
        out.push(`${fence}${lang}\n${body}\n${fence}`);
      }
    } else if (t === "ul" || t === "ol") out.push(renderList(n, depth));
    else if (t === "table") {
      const rows: string[][] = [];
      const visit = (x: Node) => {
        if (x.tag === "tr")
          rows.push(
            x.children
              .filter((c): c is Node => typeof c !== "string" && ["td", "th"].includes(c.tag))
              .map((c) => escapeText(oneLine(text(c.children)))),
          );
        else
          x.children.forEach((c) => {
            if (typeof c !== "string") visit(c);
          });
      };
      n.children.forEach((c) => {
        if (typeof c !== "string") visit(c);
      });
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const row = (r: string[]) =>
          `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
        out.push(
          [row(rows[0]!), row(Array(width).fill("---")), ...rows.slice(1).map(row)].join("\n"),
        );
      }
    } else if (t === "img") out.push("[image]");
    else if (
      ["a", "strong", "b", "em", "i", "s", "strike", "del", "code", "span", "mark", "u"].includes(t)
    )
      out.push(inline([n]));
    else if (t === "div" && /attachment|embed|file/i.test(n.attrs["data-type"] ?? "")) {
      const name = n.attrs["data-name"] ?? n.attrs["data-filename"];
      out.push(
        name ? `[attachment: ${escapeText(cleanControls(name).slice(0, 100))}]` : "[attachment]",
      );
    } else {
      const v = blocks(n.children, depth);
      out.push(...v);
    }
  }
  return out;
}
function renderList(n: Node, depth: number): string {
  let index = Number(n.attrs.start) || 1;
  return n.children
    .filter((x): x is Node => typeof x !== "string" && x.tag === "li")
    .map((li) => {
      const classes = (li.attrs.class ?? "").split(/\s+/);
      const taskTokens = new Set([
        "checklist",
        "simple-checklist",
        "checklist--item",
        "simple-checklist--item",
      ]);
      const task = `${n.attrs.class ?? ""} ${li.attrs.class ?? ""}`
        .split(/\s+/)
        .some((token) => taskTokens.has(token));
      const labelNode = li.children.find((x): x is Node => typeof x !== "string" && x.tag === "p");
      const label = escapeLineStart(
        oneLine(
          inline(
            labelNode
              ? labelNode.children
              : li.children.filter(
                  (x) =>
                    typeof x === "string" || ((x as Node).tag !== "ul" && (x as Node).tag !== "ol"),
                ),
          ).trim(),
        ),
      );
      const prefix = task
        ? `- [${classes.some((c) => c === "checked" || c === "checked--item") ? "x" : " "}] `
        : n.tag === "ol"
          ? `${index++}. `
          : "- ";
      const nested = li.children
        .filter((x): x is Node => typeof x !== "string" && (x.tag === "ul" || x.tag === "ol"))
        .map((x) => renderList(x, depth + 1));
      return `${"  ".repeat(depth)}${prefix}${label}${nested.length ? `\n${nested.join("\n")}` : ""}`;
    })
    .join("\n");
}
export function noteHtmlReadonlyMarkdown(html: string): string {
  if (typeof html !== "string") throw new Error("bounded HTML projection failed");
  return blocks(parse(html))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
