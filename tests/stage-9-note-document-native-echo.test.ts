import { describe, expect, it } from "vitest";
import {
  decodeNoteDocumentNative,
  serializeNoteDocumentNative,
} from "../src/core/note-document-native.js";
import type { NoteBlock, NoteDocumentV1 } from "../src/core/note-document.js";

const binding = { noteId: "fixture-note", revision: "fixture-revision" };
const CONTAINER = '<div data-type="document">';
const wrap = (s: string, open = CONTAINER) => ({
  type: "tiptap" as const,
  data: `${open}${s}</div>`,
});
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
type Doc = Mutable<NoteDocumentV1>;
type Block = Mutable<NoteBlock>;
const para = (text: string): Block => ({ type: "paragraph", inlines: [{ text }] });
const clone = (doc: NoteDocumentV1): Doc => JSON.parse(JSON.stringify(doc)) as Doc;
const refused = { code: "unsupported_content", message: "Native note content is not supported" };

// Synthetic fixtures. The first group decodes to modelled blocks that carry
// attributes the model drops; the second group is preserved whole (opaque).
const P_X = '<p class="x" data-a="1">a</p>';
const P_Y = '<p class="y">b</p>';
const H4 = "<h4>Four</h4>";
const OL = '<ol start="3"><li>third</li></ol>';
const TABLE = "<table><tr><th><b>marked</b></th></tr></table>";

function open(html: string, container?: string) {
  const decoded = decodeNoteDocumentNative(wrap(html, container), binding);
  const edit = (blocks: readonly NoteBlock[], options: { binding?: typeof binding } = {}) =>
    serializeNoteDocumentNative(
      { version: 1, blocks },
      { context: decoded.context, binding: options.binding ?? binding },
    );
  return { ...decoded, edit, blocks: clone(decoded.document).blocks };
}

describe("A1 byte-preserving native echo", () => {
  it("keeps an unedited decorated paragraph byte for byte when its neighbour changes", () => {
    const note = open(P_X + P_Y);
    const out = note.edit([note.blocks[0]!, para("changed")]);
    expect(out.data).toBe(`${CONTAINER}${P_X}<p>changed</p></div>`);
  });

  it("accepts a paragraph inserted before a preserved region and keeps its bytes", () => {
    const note = open(P_X + H4);
    expect(note.blocks[1]!.type).toBe("opaque");
    const out = note.edit([para("new"), ...note.blocks]);
    expect(out.data).toBe(`${CONTAINER}<p>new</p>${P_X}${H4}</div>`);
  });

  it("accepts deleting an ordinary block between two preserved regions", () => {
    const note = open(`${H4}<p>middle</p>${TABLE}`);
    const out = note.edit([note.blocks[0]!, note.blocks[2]!]);
    expect(out.data).toBe(`${CONTAINER}${H4}${TABLE}</div>`);
  });

  describe("preserved regions are anchored by order and container chain", () => {
    const note = open(`${P_X}${H4}${OL}`);
    const [p, a, b] = note.blocks as [NoteBlock, NoteBlock, NoteBlock];
    it.each([
      ["deleted", [p, b]],
      ["duplicated", [p, a, a, b]],
      ["swapped", [p, b, a]],
      ["moved into a blockquote", [p, { type: "blockquote", blocks: [a] }, b]],
      ["dropped with all regions", [p]],
    ] as [string, NoteBlock[]][])("refuses a region %s, emitting nothing", (_name, blocks) => {
      expect(() => note.edit(blocks)).toThrow(expect.objectContaining(refused));
    });

    it("refuses a forged token", () => {
      const forged = clone({ version: 1, blocks: note.blocks });
      const block = forged.blocks[1]!;
      if (block.type !== "opaque") throw new Error("fixture");
      block.sentinel.token = "forged";
      expect(() => note.edit(forged.blocks)).toThrow(expect.objectContaining(refused));
    });

    it("refuses a stale revision", () => {
      expect(() => note.edit(note.blocks, { binding: { ...binding, revision: "stale" } })).toThrow(
        expect.objectContaining(refused),
      );
      expect(() =>
        note.edit([para("x"), ...note.blocks], { binding: { ...binding, revision: "stale" } }),
      ).toThrow(expect.objectContaining(refused));
    });

    it("refuses moving a region between containers of a different variant", () => {
      const callouts = open(
        '<div data-type="callout" data-variant="info"><h4>X</h4></div>' +
          '<div data-type="callout" data-variant="warning"><p>w</p></div>',
      );
      const [info, warning] = callouts.blocks as unknown as [
        Extract<NoteBlock, { type: "callout" }>,
        Extract<NoteBlock, { type: "callout" }>,
      ];
      expect(() =>
        callouts.edit([
          { ...info, blocks: [] },
          { ...warning, blocks: [...info.blocks, ...warning.blocks] },
        ]),
      ).toThrow(expect.objectContaining(refused));
    });

    it("accepts the same preserved region while its blockquote is edited around it", () => {
      const quoted = open('<blockquote class="q"><p class="in">a</p><h4>Nested</h4></blockquote>');
      const quote = quoted.blocks[0] as Extract<NoteBlock, { type: "blockquote" }>;
      const out = quoted.edit([{ type: "blockquote", blocks: [para("first"), quote.blocks[1]!] }]);
      expect(out.data).toBe(
        `${CONTAINER}<blockquote class="q"><p>first</p><h4>Nested</h4></blockquote></div>`,
      );
    });
  });

  it("emits the original opening tag of the document container", () => {
    const tag = '<div data-type="document" class="c">';
    const note = open(P_X + P_Y, tag);
    const out = note.edit([note.blocks[0]!, para("changed")]);
    expect(out.data.startsWith(tag)).toBe(true);
    expect(out.data).toBe(`${tag}${P_X}<p>changed</p></div>`);
  });

  it("rebuilds an edited container that holds no preserved region with the canonical tag", () => {
    // Accepted consequence (plan-owner ruling 2): bytes are never borrowed by
    // guessing, so a container without regions loses its tolerated attributes
    // when its text is edited, as it did before A1. An unedited one is echoed.
    const html =
      '<blockquote class="q" data-k="v"><p class="in">a</p><p>b</p></blockquote>' +
      '<div data-type="callout" data-variant="info" class="c"><p class="z">n</p></div>';
    const note = open(html);
    const [quote, callout] = note.blocks as unknown as [
      Extract<NoteBlock, { type: "blockquote" }>,
      Extract<NoteBlock, { type: "callout" }>,
    ];
    expect(note.edit([quote, para("after")]).data).toBe(
      `${CONTAINER}${html.slice(0, html.indexOf("<div"))}<p>after</p></div>`,
    );
    const out = note.edit([
      { type: "blockquote", blocks: [quote.blocks[0]!, para("B")] },
      { ...callout, blocks: [para("N"), ...callout.blocks] },
    ]);
    expect(out.data).toBe(
      `${CONTAINER}<blockquote><p>a</p><p>B</p></blockquote>` +
        '<div data-type="callout" data-variant="info"><p>N</p><p>n</p></div></div>',
    );
  });

  it("returns the identical original content for an unchanged document", () => {
    const note = open(P_X + H4);
    const first = note.edit(note.blocks);
    expect(first).toEqual(wrap(P_X + H4));
    expect(note.edit(note.blocks)).toBe(first);
    expect(note.edit(clone(note.document).blocks)).toBe(first);
  });

  it("emits each original slice at most once when a block is copied in the same edit", () => {
    const note = open(P_X + P_Y);
    const [x, y] = note.blocks as [NoteBlock, NoteBlock];
    expect(note.edit([x, y, x]).data).toBe(`${CONTAINER}${P_X}${P_Y}<p>a</p></div>`);
    expect(note.edit([x, x, y]).data).toBe(`${CONTAINER}${P_X}<p>a</p>${P_Y}</div>`);
    expect(note.edit([y, x, x]).data.split(P_X).length - 1).toBe(1);
  });

  describe("container anchors and opening-tag ownership", () => {
    const T = "<h4>Four</h4>";
    const U = "<h4>Five</h4>";
    const bq = (blocks: readonly NoteBlock[]): NoteBlock => ({ type: "blockquote", blocks });
    const callout = (variant: "info" | "warning", blocks: readonly NoteBlock[]): NoteBlock => ({
      type: "callout",
      variant,
      blocks,
    });
    const kids = (b: NoteBlock): readonly NoteBlock[] => {
      if (b.type !== "blockquote" && b.type !== "callout") throw new Error("fixture");
      return b.blocks;
    };
    const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
    const INFO = '<div data-type="callout" data-variant="info">';

    it.each([
      [
        "blockquote #0 to an empty blockquote #1",
        `<blockquote class="a"><p>x</p>${T}</blockquote><blockquote class="b"></blockquote>`,
        (q: NoteBlock[]) => [bq([kids(q[0]!)[0]!]), bq([kids(q[0]!)[1]!])],
      ],
      [
        "blockquote #1 into blockquote #0",
        `<blockquote class="a"></blockquote><blockquote class="b"><p>y</p>${T}</blockquote>`,
        (q: NoteBlock[]) => [bq([kids(q[1]!)[1]!]), bq([kids(q[1]!)[0]!])],
      ],
      [
        "callout #0 to an empty same-variant callout #1",
        `${INFO}<p>x</p>${T}</div>${INFO}</div>`,
        (q: NoteBlock[]) => [
          callout("info", [kids(q[0]!)[0]!]),
          callout("info", [kids(q[0]!)[1]!]),
        ],
      ],
      [
        "a blockquote into one that already holds another region (before it)",
        `<blockquote><p>x</p>${T}</blockquote><blockquote>${U}</blockquote>`,
        (q: NoteBlock[]) => [bq([kids(q[0]!)[0]!]), bq([kids(q[0]!)[1]!, kids(q[1]!)[0]!])],
      ],
      [
        "a blockquote into one that already holds another region (after it)",
        `<blockquote><p>x</p>${T}</blockquote><blockquote>${U}</blockquote>`,
        (q: NoteBlock[]) => [bq([kids(q[0]!)[0]!]), bq([kids(q[1]!)[0]!, kids(q[0]!)[1]!])],
      ],
      [
        "a region nested in callout:info inside blockquote #0 into blockquote #1",
        `<blockquote>${INFO}${T}</div></blockquote><blockquote>${INFO}<p>y</p></div></blockquote>`,
        (q: NoteBlock[]) => [
          bq([callout("info", [])]),
          bq([callout("info", [kids(kids(q[0]!)[0]!)[0]!, kids(kids(q[1]!)[0]!)[0]!])]),
        ],
      ],
    ] as [string, string, (q: NoteBlock[]) => NoteBlock[]][])(
      "refuses moving %s, emitting nothing",
      (_name, html, build) => {
        const note = open(html);
        expect(() => note.edit(build(note.blocks))).toThrow(expect.objectContaining(refused));
      },
    );

    it("refuses swapping two containers that hold regions", () => {
      for (const html of [
        `<blockquote class="a">${T}</blockquote><blockquote class="b">${U}</blockquote>`,
        `${INFO}${T}</div>${INFO}${U}</div>`,
      ]) {
        const note = open(html);
        expect(() => note.edit([note.blocks[1]!, note.blocks[0]!])).toThrow(
          expect.objectContaining(refused),
        );
      }
    });

    it("accepts a paragraph inserted above containers and keeps every region", () => {
      const html = `<blockquote class="a">${T}</blockquote>${INFO.replace(">", ' class="c">')}${U}</div>`;
      const note = open(html);
      expect(note.edit([para("new"), ...note.blocks]).data).toBe(
        `${CONTAINER}<p>new</p>${html}</div>`,
      );
    });

    it("refuses a same-type, same-variant container inserted or deleted before an anchored one", () => {
      // First-release limitation (plan-owner ruling 1): the anchor ordinal is
      // positional, so shifting it by adding or removing a look-alike sibling
      // before an anchored container is refused.
      const inserted = open(`<blockquote class="a">${T}</blockquote>`);
      expect(() => inserted.edit([bq([para("new")]), ...inserted.blocks])).toThrow(
        expect.objectContaining(refused),
      );
      const deleted = open(`<blockquote><p>gone</p></blockquote><blockquote>${T}</blockquote>`);
      expect(() => deleted.edit([deleted.blocks[1]!])).toThrow(expect.objectContaining(refused));
      const calls = open(`${INFO}${T}</div>`);
      expect(() => calls.edit([callout("info", [para("new")]), ...calls.blocks])).toThrow(
        expect.objectContaining(refused),
      );
    });

    it("accepts a container of another type or variant inserted before an anchored one", () => {
      const quoted = open(`<blockquote class="a">${T}</blockquote>`);
      expect(quoted.edit([callout("info", [para("n")]), ...quoted.blocks]).data).toBe(
        `${CONTAINER}${INFO}<p>n</p></div><blockquote class="a">${T}</blockquote></div>`,
      );
      const called = open(`${INFO.replace(">", ' class="c">')}${T}</div>`);
      expect(called.edit([callout("warning", [para("n")]), ...called.blocks]).data).toBe(
        `${CONTAINER}<div data-type="callout" data-variant="warning"><p>n</p></div>` +
          `<div data-type="callout" data-variant="info" class="c">${T}</div></div>`,
      );
    });

    it("rebuilds a replacement container canonically without borrowing the deleted one's bytes", () => {
      const note = open('<blockquote data-uid="X1"><p>x</p></blockquote><p>tail</p>');
      const out = note.edit([bq([para("y")]), note.blocks[1]!]);
      expect(out.data).toBe(`${CONTAINER}<blockquote><p>y</p></blockquote><p>tail</p></div>`);
      expect(out.data).not.toContain("X1");
    });

    it("emits no original opening tag twice in an accepted edit", () => {
      const tags = [
        '<blockquote class="a">',
        '<blockquote class="r">',
        INFO.replace(">", ' class="c">'),
      ];
      const html =
        `<blockquote class="a"><p>t</p>${T}</blockquote><blockquote class="r"><p>r</p></blockquote>` +
        `${INFO.replace(">", ' class="c">')}<p>u</p>${U}</div>`;
      const note = open(html);
      const [a, r, c] = note.blocks as [NoteBlock, NoteBlock, NoteBlock];
      const edits: NoteBlock[][] = [
        [para("new"), a, r, c],
        [bq([para("t2"), kids(a)[1]!]), r, callout("info", [para("u2"), kids(c)[1]!])],
        [a, r, r, c],
        [a, bq([para("r2")]), c],
      ];
      for (const blocks of edits) {
        const out = note.edit(blocks).data;
        for (const tag of tags) expect(count(out, tag), tag).toBeLessThanOrEqual(1);
      }
    });

    it("keeps the opening tag of an edited container with regions, not one without", () => {
      const note = open(
        `<blockquote class="a" data-k="1"><p>t</p>${T}</blockquote><blockquote class="b" data-k="2"><p>u</p></blockquote>`,
      );
      const [a, b] = note.blocks as [NoteBlock, NoteBlock];
      const out = note.edit([bq([para("t2"), kids(a)[1]!]), bq([para("u2")])]).data;
      expect(out).toBe(
        `${CONTAINER}<blockquote class="a" data-k="1"><p>t2</p>${T}</blockquote>` +
          "<blockquote><p>u2</p></blockquote></div>",
      );
      expect(b.type).toBe("blockquote");
    });
  });

  describe("locks", () => {
    it("still refuses a context-free replacement of content that carries a preserved region", () => {
      const note = open(P_X + H4);
      expect(() => serializeNoteDocumentNative(clone(note.document))).toThrow(
        expect.objectContaining(refused),
      );
    });
    it("never accepts a context bound to a different note", () => {
      const note = open(P_X + H4);
      const other = decodeNoteDocumentNative(wrap(P_X + H4), { ...binding, noteId: "other-note" });
      expect(() =>
        serializeNoteDocumentNative(clone(note.document), { context: other.context, binding }),
      ).toThrow(expect.objectContaining(refused));
    });
  });
});

// --- seeded random edit scripts -------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Containers carry a unique data-uid so an emitted opening tag is attributable.
// "o" containers hold no region; "p" containers do.
const C_INFO = '<div data-type="callout" data-variant="info"';
const ORDINARY = [
  '<p class="x" data-a="1">alpha</p>',
  '<p title="t">beta</p>',
  '<p aria-label="l">gamma</p>',
  '<h2 class="hh" data-k="v">head</h2>',
  '<ul class="fancy"><li><p>one</p></li><li><p>two</p></li></ul>',
  '<pre><code class="language-ts">let x</code></pre>',
  '<blockquote class="q" data-uid="o1"><p class="in">inner</p><p>two</p></blockquote>',
  '<blockquote data-uid="o2"><p>second</p></blockquote>',
  `${C_INFO} class="c" data-uid="o3"><p class="z">note</p></div>`,
  "<p>plain</p>",
];
const PRESERVED = [
  H4,
  OL,
  TABLE,
  '<blockquote class="p" data-uid="p1"><p>q</p><h4>N1</h4></blockquote>',
  '<blockquote data-uid="p2"><h4>N2</h4></blockquote>',
  `${C_INFO} data-uid="p3"><p class="w">w</p><h4>C1</h4></div>`,
  '<div data-type="callout" data-variant="warning" data-uid="p4"><h4>C2</h4></div>',
  `<blockquote data-uid="p5">${C_INFO} data-uid="p6"><h4>D1</h4></div></blockquote>`,
];
// The raw regions that must survive byte for byte.
const REGIONS: Record<string, string[]> = {
  [PRESERVED[0]!]: [H4],
  [PRESERVED[1]!]: [OL],
  [PRESERVED[2]!]: [TABLE],
  [PRESERVED[3]!]: ["<h4>N1</h4>"],
  [PRESERVED[4]!]: ["<h4>N2</h4>"],
  [PRESERVED[5]!]: ["<h4>C1</h4>"],
  [PRESERVED[6]!]: ["<h4>C2</h4>"],
  [PRESERVED[7]!]: ["<h4>D1</h4>"],
};

function lists(doc: Doc): Block[][] {
  const out: Block[][] = [];
  const walk = (blocks: Block[]) => {
    out.push(blocks);
    for (const b of blocks) if (b.type === "blockquote" || b.type === "callout") walk(b.blocks);
  };
  walk(doc.blocks);
  return out;
}

// Independent oracle: (container chain with sibling ordinals, token) per region.
function regionRefs(doc: NoteDocumentV1, tokens = true): string[] {
  const out: string[] = [];
  const walk = (blocks: readonly NoteBlock[], chain: string) => {
    const seen = new Map<string, number>();
    for (const b of blocks) {
      if (b.type === "opaque") out.push(JSON.stringify([chain, tokens ? b.sentinel.token : ""]));
      if (b.type !== "blockquote" && b.type !== "callout") continue;
      const key = `${b.type}:${b.type === "callout" ? b.variant : ""}`;
      const ordinal = seen.get(key) ?? 0;
      seen.set(key, ordinal + 1);
      walk(b.blocks, `${chain}/${key}#${ordinal}`);
    }
  };
  walk(doc.blocks, "");
  return out;
}

// Chain (with ordinals) of every container carrying a data-uid in emitted HTML.
function uidChains(html: string): [string, string][] {
  const out: [string, string][] = [];
  const stack: { chain: string; seen: Map<string, number> }[] = [];
  for (const m of html.matchAll(/<(\/?)(blockquote|div)\b([^>]*)>/g)) {
    const [, close, tag, attrs = ""] = m;
    if (close) {
      stack.pop();
      continue;
    }
    if (tag === "div" && attrs.includes('data-type="document"')) {
      stack.push({ chain: "", seen: new Map() });
      continue;
    }
    const key =
      tag === "blockquote"
        ? "blockquote:"
        : `callout:${/data-variant="([a-z]+)"/.exec(attrs)?.[1]}`;
    const parent = stack.at(-1)!;
    const ordinal = parent.seen.get(key) ?? 0;
    parent.seen.set(key, ordinal + 1);
    const chain = `${parent.chain}/${key}#${ordinal}`;
    const uid = /data-uid="([^"]+)"/.exec(attrs)?.[1];
    if (uid) out.push([uid, chain]);
    stack.push({ chain, seen: new Map() });
  }
  return out;
}

// Opaque tokens are position-mixed, so compare re-decoded documents by ordinal.
function normalised(doc: NoteDocumentV1): unknown {
  let n = 0;
  return JSON.parse(
    JSON.stringify(doc, (key, value: unknown) => (key === "sentinel" ? { ordinal: n++ } : value)),
  );
}

describe("A1 random edit scripts", () => {
  it("accepts exactly the edits that keep every region's anchor, with both ownership invariants", () => {
    let accepted = 0;
    let refusedCount = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const rand = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
      const chosen: string[] = [];
      for (const html of [...ORDINARY, ...PRESERVED]) if (rand() < 0.45) chosen.push(html);
      if (!chosen.some((h) => PRESERVED.includes(h))) chosen.push(pick(PRESERVED));
      if (!chosen.some((h) => ORDINARY.includes(h))) chosen.unshift(pick(ORDINARY));
      // Shuffle (Fisher-Yates) so regions sit at varied positions.
      for (let i = chosen.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [chosen[i], chosen[j]] = [chosen[j]!, chosen[i]!];
      }
      const tag = rand() < 0.5 ? CONTAINER : '<div data-type="document" class="c" data-n="1">';
      const originalHtml = chosen.join("");
      const note = open(originalHtml, tag);
      const edited = clone(note.document);
      const label = `seed ${seed}`;

      for (let step = 0, steps = 1 + Math.floor(rand() * 4); step < steps; step++) {
        const list = pick(lists(edited));
        const at = Math.floor(rand() * (list.length + 1));
        const index = Math.floor(rand() * list.length);
        switch (Math.floor(rand() * 7)) {
          case 0:
            list.splice(at, 0, para(`new ${seed}.${step}`));
            break;
          case 1:
            if (list.length) list.splice(index, 1);
            break;
          case 2: {
            const text = list.filter((b) => b.type === "paragraph" || b.type === "heading");
            const target = text.length ? pick(text) : undefined;
            if (target && (target.type === "paragraph" || target.type === "heading"))
              target.inlines = [{ text: `edit ${seed}.${step}` }];
            break;
          }
          case 3:
            if (list.length)
              list.splice(at, 0, clone({ version: 1, blocks: [list[index]!] }).blocks[0]!);
            break;
          case 4:
            if (list.length) {
              // Move any block, a region or a container holding one included.
              const [moved] = list.splice(index, 1);
              const target = pick(lists(edited));
              target.splice(Math.floor(rand() * (target.length + 1)), 0, moved!);
            }
            break;
          case 5:
            list.splice(
              at,
              0,
              rand() < 0.5
                ? { type: "blockquote", blocks: [para(`bq ${seed}.${step}`)] }
                : { type: "callout", variant: pick(["info", "warning"] as const), blocks: [] },
            );
            break;
          default:
            if (list.length > 1) {
              const other = Math.floor(rand() * list.length);
              [list[index], list[other]] = [list[other]!, list[index]!];
            }
        }
      }

      const expected =
        JSON.stringify(regionRefs(edited)) === JSON.stringify(regionRefs(note.document));
      let out;
      try {
        out = serializeNoteDocumentNative(edited, { context: note.context, binding });
      } catch (error) {
        expect(error, label).toMatchObject(refused);
        expect(expected, `${label}: refused an edit that keeps every anchor`).toBe(false);
        refusedCount++;
        continue;
      }
      expect(expected, `${label}: accepted an edit that moves an anchor`).toBe(true);
      accepted++;
      expect(out.data.startsWith(tag), label).toBe(true);
      const again = decodeNoteDocumentNative(out, binding);
      expect(normalised(again.document), label).toEqual(normalised(edited));
      expect(regionRefs(again.document, false), label).toEqual(regionRefs(note.document, false));

      let cursor = 0;
      for (const html of chosen)
        for (const region of REGIONS[html] ?? []) {
          const found = out.data.indexOf(region, cursor);
          expect(found, `${label} region ${region}`).toBeGreaterThanOrEqual(cursor);
          cursor = found + region.length;
          expect(out.data.split(region).length - 1, `${label} once ${region}`).toBe(1);
        }

      // Ownership: an original opening tag appears at most once; a container
      // that holds regions keeps its own tag at its own chain; one without
      // appears only inside a complete, exactly echoed original block.
      const origin = new Map(uidChains(`${tag}${originalHtml}</div>`));
      const emitted = uidChains(out.data);
      expect(new Set(emitted.map(([uid]) => uid)).size, `${label} duplicate tag`).toBe(
        emitted.length,
      );
      for (const [uid, chain] of emitted) {
        if (uid.startsWith("p")) expect(chain, `${label} ${uid}`).toBe(origin.get(uid));
        else
          expect(
            out.data.includes(chosen.find((h) => h.includes(`data-uid="${uid}"`))!),
            `${label} ${uid} echoed only whole`,
          ).toBe(true);
      }
      for (const uid of origin.keys())
        if (uid.startsWith("p"))
          expect(
            emitted.some(([u]) => u === uid),
            `${label} ${uid}`,
          ).toBe(true);
    }
    // The script must exercise both outcomes.
    expect(accepted).toBeGreaterThan(100);
    expect(refusedCount).toBeGreaterThan(50);
  });
});
