import { describe, expect, it, vi } from "vitest";
import {
  NoteDocumentError,
  type NoteBlock,
  type NoteDocumentV1,
} from "../src/core/note-document.js";
import {
  parseNoteDocumentMarkdown as parse,
  serializeNoteDocumentMarkdown as serialize,
  NOTE_DOCUMENT_MARKDOWN_HEADER as H,
  MAX_NOTE_DOCUMENT_MARKDOWN_BYTES as LIMIT,
} from "../src/core/note-document-markdown.js";

const header = "---\nnookbridge-format: 1\n---\n";
const md = (body: string) => header + "\n" + body + "\n";
function rejects(run: () => unknown, code = "invalid_shape") {
  try {
    run();
    throw new Error("accepted invalid input");
  } catch (error) {
    expect(error).toBeInstanceOf(NoteDocumentError);
    expect((error as NoteDocumentError).code).toBe(code);
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).message).not.toContain("CANARY");
  }
}
const opaque: NoteDocumentV1 = {
  version: 1,
  blocks: [
    {
      type: "opaque",
      nodeType: "image",
      sentinel: { version: 1, source: "native-html", token: "ref_0123456789abcdef" },
    },
  ],
};

describe("T02 deterministic Markdown interchange", () => {
  it("publishes the frozen version header and editor budget", () => {
    expect(H).toBe(header);
    expect(LIMIT).toBe(4 * 1024 * 1024);
    expect(serialize(parse(header))).toBe(header);
  });
  it.each([
    "# Title\n\n## 二\n\n### Three\n\nHello 😀 é.",
    "**bold** *italic* __underline__ ~~strike~~ `code` [link](https://example.test/a)",
    "**nested *marks*** and \\*literal\\* \\<tag\\> \\\\.",
    "- [ ] parent\n  - [x] child\n    - [ ] grandchild\n- [x] sibling",
    ":::nookbridge list simple-checklist\n- [ ] simple\n:::\n\n:::nookbridge list task-list\n- [x] interactive\n  - [ ] child\n:::",
    "- one\n- two\n\n1. first\n2. second",
    "> quote\n>\n> ## Heading",
    "```ts\nconst x = '😀';\n:::nookbridge callout danger\n```",
    "````\n```\n---\nnookbridge-format: 1\n---\n````",
    ':::nookbridge table\n{"columns":["Owner","Status"],"rows":[["二","a|b"],["x","line\\nnext"]]}\n:::',
    ":::nookbridge callout warning\nCheck **this**.\n\n:::nookbridge callout info\nNested.\n:::\n:::",
    "\\-\\-\\-\nnookbridge-format: 1\n\\-\\-\\-",
    "---",
    "----",
    "before\n\n---\n\nafter",
    "> ---",
    ":::nookbridge callout info\n---\n:::",
    ':::nookbridge table\n{"columns":["a"],"rows":[["1"]]}\n:::\n\n---\n\n:::nookbridge table\n{"columns":["b"],"rows":[["2"]]}\n:::',
    ':::nookbridge image 1\n{"url":"https://example.test/a.png"}\n:::',
    ':::nookbridge image 1\n{"url":"https://example.test/a.png","alt":"A diagram"}\n:::',
    ':::nookbridge attachment 1\n{"url":"https://example.test/report.pdf"}\n:::',
    ':::nookbridge attachment 1\n{"url":"https://example.test/report.pdf","name":"report.pdf","mime":"application/pdf"}\n:::',
    ':::nookbridge embed 1\n{"url":"https://example.test/video"}\n:::',
  ])("round-trips supported bytes: %s", (body) => {
    const input = md(body);
    const doc = parse(input);
    expect(serialize(doc)).toBe(input);
    expect(serialize(JSON.parse(JSON.stringify(doc)))).toBe(input);
  });
  it("maps nesting, marks, tables and list intent structurally", () => {
    expect(parse(md("- [ ] a\n  - [x] b")).blocks).toEqual([
      {
        type: "task-list",
        items: [
          {
            checked: false,
            inlines: [{ text: "a" }],
            children: [{ checked: true, inlines: [{ text: "b" }], children: [] }],
          },
        ],
      },
    ]);
    expect(parse(md("**bold**")).blocks).toEqual([
      { type: "paragraph", inlines: [{ text: "bold", marks: ["bold"] }] },
    ]);
    expect(parse(md(":::nookbridge list task-list\n- [x] a\n:::")).blocks[0]).toMatchObject({
      kind: "task-list",
    });
  });
  it.each([
    "",
    "---\nnookbridge-format: 2\n---\n",
    md("#### no"),
    md("<script>CANARY</script>"),
    md("![image](https://example.test)"),
    md("**unclosed"),
    md("[x](javascript:CANARY)"),
    md("[x](data:text/html,CANARY)"),
    md("[x](file:///CANARY)"),
    md(":::nookbridge nope\nCANARY\n:::"),
    md(":::nookbridge callout info\nunclosed"),
    md(":::nookbridge table\n{bad CANARY}\n:::"),
    md(':::nookbridge table\n{"columns":[],"columns":[],"rows":[]}\n:::'),
    md(':::nookbridge table\n{"columns":[],"rows":[],"__proto__":{}}\n:::'),
    md("---\ntext"),
    md('<img src="https://example.test/a.png" alt="CANARY">'),
    md(":::nookbridge image 1\n{bad CANARY}\n:::"),
    md(':::nookbridge image 2\n{"url":"https://example.test/a.png"}\n:::'),
    md(
      ':::nookbridge image 1\n{"url":"https://example.test/a.png","url":"https://example.test/b.png"}\n:::',
    ),
    md(':::nookbridge image 1\n{"url":"https://example.test/a.png","junk":"CANARY"}\n:::'),
    md(':::nookbridge image 1\n{"url":"https://example.test/a.png","__proto__":{}}\n:::'),
    md(':::nookbridge image 1\n{"url":"javascript:CANARY"}\n:::'),
    md(':::nookbridge image 1\n{"alt":"CANARY"}\n:::'),
    md(":::nookbridge image 1\n{}\n:::"),
    md(':::nookbridge image 1\n{"url":"https://example.test/a.png"}'),
    md(":::nookbridge image 1\n"),
    md(':::nookbridge attachment 1\n{"url":"file:///etc/CANARY"}\n:::'),
    md(':::nookbridge attachment 1\n{"url":"https://example.test/report.pdf","sizeBytes":12}\n:::'),
    md(':::nookbridge embed 1\n{"url":"https://example.test/video","provider":"CANARY"}\n:::'),
    md(':::nookbridge embed 1\n{"url":"javascript:alert(document.CANARY)"}\n:::'),
    md(":::nookbridge embed 1\n{}\n:::"),
    md("- [X] upper"),
    md("- [ ] a\n   - [x] bad"),
    md("- [ ] a\n    - [x] jump"),
    md("- a\n  continuation"),
    md("```\nunclosed"),
    md("text\n# ambiguous"),
    md("---\nnookbridge-format: 1\n---"),
    md("text\n\n"),
    md("text\r"),
    md("\ud800"),
    md("a\u0000CANARY"),
  ])("rejects malformed, hostile or noncanonical input", (input) => {
    try {
      parse(input);
      throw new Error("accepted");
    } catch (e) {
      expect(e).toBeInstanceOf(NoteDocumentError);
    }
  });
  it("refuses unsafe links without fetching even safe links", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      parse(md("[safe](https://example.test)"));
      rejects(() => parse(md("[x](javascript:CANARY)")), "malformed_link");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("round-trips opaque references only against a trusted preimage", () => {
    const input = serialize(opaque);
    expect(serialize(parse(input, { preimage: opaque }))).toBe(input);
    rejects(() => parse(input), "opaque_payload_forbidden");
    rejects(
      () => parse(input.replace("0123456789abcdef", "fedcba9876543210"), { preimage: opaque }),
      "opaque_payload_forbidden",
    );
    rejects(() => parse(header, { preimage: opaque }), "opaque_payload_forbidden");
    rejects(
      () => parse(md("before\n\n" + input.slice(header.length + 1, -1)), { preimage: opaque }),
      "opaque_payload_forbidden",
    );
    rejects(
      () =>
        parse(
          md(input.slice(header.length + 1, -1) + "\n\n" + input.slice(header.length + 1, -1)),
          { preimage: opaque },
        ),
      "opaque_payload_forbidden",
    );
    rejects(
      () =>
        parse(input.replace("ref_0123456789abcdef", '{"payload":"CANARY"}'), { preimage: opaque }),
      "opaque_payload_forbidden",
    );
  });
  it("enforces byte, inline, block, item and depth budgets", () => {
    rejects(() => parse(header + "é".repeat(LIMIT / 2)), "oversize_document");
    rejects(() => parse(md("é".repeat(4097))), "oversize_inline");
    rejects(
      () => parse(md(Array.from({ length: 4097 }, () => "a").join("\n\n"))),
      "oversize_document",
    );
    rejects(
      () => parse(md(Array.from({ length: 2049 }, () => "- a").join("\n"))),
      "oversize_document",
    );
    rejects(
      () =>
        parse(md(":::nookbridge callout info\n".repeat(17) + "a\n" + ":::\n".repeat(16) + ":::")),
      "depth_exceeded",
    );
    rejects(() => parse(md("```\n" + "é".repeat(4097) + "\n```")), "oversize_inline");
    rejects(
      () =>
        parse(
          md(':::nookbridge table\n{"columns":["x"],"rows":[["' + "a".repeat(65536) + '"]]}\n:::'),
        ),
      "oversize_block",
    );
  });
  it("rejects hostile AST objects without invoking accessors or mutating inputs", () => {
    const getter = vi.fn(() => {
      throw new Error("CANARY");
    });
    rejects(() =>
      serialize(Object.defineProperty({}, "version", { get: getter }) as NoteDocumentV1),
    );
    expect(getter).not.toHaveBeenCalled();
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    rejects(() => serialize({ version: 1, blocks: cyclic } as unknown as NoteDocumentV1));
    rejects(() => serialize(new Proxy(opaque, { get: getter })));
    const frozen = Object.freeze({ version: 1 as const, blocks: Object.freeze([]) });
    expect(serialize(frozen)).toBe(header);
    rejects(() => parse({ toString: getter } as unknown as string));
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("T02 semantic and hostile-structure regressions", () => {
  it("never turns inline line breaks into extra task items", () => {
    rejects(() =>
      serialize({
        version: 1,
        blocks: [
          {
            type: "task-list",
            items: [{ checked: false, inlines: [{ text: "a\n- [x] b" }], children: [] }],
          },
        ],
      }),
    );
  });
  it("rejects controls and malformed Unicode inside JSON string escapes", () => {
    rejects(() =>
      parse(md(':::nookbridge table\n{"columns":["x"],"rows":[["\\u0000CANARY"]]}\n:::')),
    );
    rejects(() => parse(md(':::nookbridge table\n{"columns":["x"],"rows":[["\\ud800"]]}\n:::')));
  });
  it("rejects payload properties, unknown fields and unsafe language injection", () => {
    rejects(() =>
      serialize({
        ...opaque,
        blocks: [{ ...opaque.blocks[0], payload: "CANARY" }],
      } as unknown as NoteDocumentV1),
    );
    rejects(() =>
      serialize({
        version: 1,
        blocks: [{ type: "code-block", text: "x", language: "js\nCANARY" }],
      }),
    );
    rejects(
      () =>
        serialize({
          version: 1,
          blocks: [
            {
              type: "paragraph",
              inlines: [{ text: "x", marks: [{ type: "link", href: "javascript:CANARY" }] }],
            },
          ],
        }),
      "malformed_link",
    );
  });
  it("handles fence collisions, trailing code newlines and adjacent text runs", () => {
    for (const text of ["", "x\n", ":::", "````\n```\n`", "😀\n"]) {
      const doc: NoteDocumentV1 = { version: 1, blocks: [{ type: "code-block", text }] };
      expect(parse(serialize(doc))).toEqual(doc);
    }
    const doc: NoteDocumentV1 = {
      version: 1,
      blocks: [{ type: "paragraph", inlines: [{ text: "a" }, { text: "b", marks: [] }] }],
    };
    expect(serialize(doc)).toBe(md("ab"));
  });
  it("rejects invalid table dimensions and unsupported list kinds categorically", () => {
    rejects(
      () => parse(md(':::nookbridge table\n{"columns":["x"],"rows":[[]]}\n:::')),
      "table_column_mismatch",
    );
    rejects(() => parse(md(":::nookbridge list CANARY\n- [ ] a\n:::")), "unsupported_list_kind");
  });
  it("preserves nested opaque references and rejects a changed parent kind", () => {
    const preimage: NoteDocumentV1 = {
      version: 1,
      blocks: [{ type: "callout", variant: "info", blocks: opaque.blocks }],
    };
    const input = serialize(preimage);
    expect(serialize(parse(input, { preimage }))).toBe(input);
    rejects(
      () => parse(input.replace("callout info", "callout warning"), { preimage }),
      "opaque_payload_forbidden",
    );
  });
});

describe("T02 horizontal-rule / image / attachment / embed directives (Task 1.2)", () => {
  it("maps a standalone --- line to a bare horizontal-rule block", () => {
    expect(parse(md("---")).blocks).toEqual([{ type: "horizontal-rule" }]);
  });
  it("maps the versioned image/attachment/embed directives structurally", () => {
    expect(
      parse(md(':::nookbridge image 1\n{"url":"https://example.test/a.png"}\n:::')).blocks,
    ).toEqual([{ type: "image", url: "https://example.test/a.png" }]);
    expect(
      parse(
        md(':::nookbridge attachment 1\n{"url":"https://example.test/r.pdf","name":"r.pdf"}\n:::'),
      ).blocks,
    ).toEqual([{ type: "attachment", url: "https://example.test/r.pdf", name: "r.pdf" }]);
    expect(
      parse(md(':::nookbridge embed 1\n{"url":"https://example.test/v"}\n:::')).blocks,
    ).toEqual([{ type: "embed", url: "https://example.test/v" }]);
  });
  it("disambiguates a horizontal rule from adjacent table-directive block boundaries", () => {
    const input = md(
      ':::nookbridge table\n{"columns":["a"],"rows":[["1"]]}\n:::\n\n---\n\n:::nookbridge table\n{"columns":["b"],"rows":[["2"]]}\n:::',
    );
    const doc = parse(input);
    expect(doc.blocks.map((b) => b.type)).toEqual(["table", "horizontal-rule", "table"]);
    expect(serialize(doc)).toBe(input);
  });
  it("does not treat a longer dash run as an ambiguous horizontal rule", () => {
    expect(parse(md("----")).blocks).toEqual([{ type: "paragraph", inlines: [{ text: "----" }] }]);
  });
  it("still distinguishes an escaped literal '---' paragraph line from the real directive", () => {
    const literal = parse(md("\\-\\-\\-"));
    expect(literal.blocks).toEqual([{ type: "paragraph", inlines: [{ text: "---" }] }]);
    const rule = parse(md("---"));
    expect(rule.blocks).toEqual([{ type: "horizontal-rule" }]);
    expect(serialize(literal)).not.toBe(serialize(rule));
  });
  it("rejects an unsupported directive version categorically", () => {
    rejects(
      () => parse(md(':::nookbridge image 2\n{"url":"https://example.test/a.png"}\n:::')),
      "invalid_shape",
    );
  });
  it("rejects a missing required url field categorically", () => {
    // The directive JSON simply omits `url` (never an explicit `"url":null`
    // placeholder), so the T01 validator's own required-field check fires:
    // `invalid_shape`, the same categorical code every other "required key
    // absent" AST shape uses (see `tests/stage-9-note-document.test.ts`).
    rejects(() => parse(md(':::nookbridge image 1\n{"alt":"x"}\n:::')), "invalid_shape");
    rejects(() => parse(md(":::nookbridge embed 1\n{}\n:::")), "invalid_shape");
  });
  it("rejects a hostile URL scheme inside every reference directive", () => {
    rejects(
      () => parse(md(':::nookbridge image 1\n{"url":"javascript:CANARY"}\n:::')),
      "invalid_reference_url",
    );
    rejects(
      () => parse(md(':::nookbridge attachment 1\n{"url":"file:///etc/CANARY"}\n:::')),
      "invalid_reference_url",
    );
    rejects(
      () => parse(md(':::nookbridge embed 1\n{"url":"javascript:CANARY"}\n:::')),
      "invalid_reference_url",
    );
  });
  it("rejects control bytes and lone surrogates in reference labels", () => {
    rejects(() =>
      parse(
        md(
          ':::nookbridge image 1\n{"url":"https://example.test/a.png","alt":"bad\\u0000label"}\n:::',
        ),
      ),
    );
    rejects(() =>
      parse(
        md(
          ':::nookbridge attachment 1\n{"url":"https://example.test/a.pdf","name":"bad\\u007flabel"}\n:::',
        ),
      ),
    );
    rejects(() =>
      parse(
        md(
          ':::nookbridge attachment 1\n{"url":"https://example.test/a.pdf","mime":"bad\\ud800label"}\n:::',
        ),
      ),
    );
  });
  it("rejects raw HTML image/embed markup instead of accepting it as a fallback", () => {
    rejects(() => parse(md('<img src="https://example.test/a.png">')));
    rejects(() => parse(md('<iframe src="https://example.test/v"></iframe>')));
  });
  it("rejects an unknown attribute smuggled through the reference directive JSON", () => {
    rejects(() =>
      parse(md(':::nookbridge embed 1\n{"url":"https://example.test/v","provider":"CANARY"}\n:::')),
    );
    rejects(() =>
      parse(
        md(':::nookbridge attachment 1\n{"url":"https://example.test/r.pdf","sizeBytes":12}\n:::'),
      ),
    );
  });
  it("still refuses an explicit math directive/discriminator (unimplemented by design)", () => {
    rejects(() => parse(md(":::nookbridge math 1\ntex\n:::")));
    rejects(
      () =>
        serialize({
          version: 1,
          blocks: [{ type: "math", tex: "E=mc^2" } as unknown as NoteBlock],
        } as unknown as NoteDocumentV1),
      "unsupported_node",
    );
  });
});

describe("ordinary-list continuation blocks", () => {
  it("round-trips nested bullet and ordered blocks without changing semantics", () => {
    const document: NoteDocumentV1 = {
      version: 1,
      blocks: [
        {
          type: "bullet-list",
          items: [
            {
              inlines: [{ text: "parent" }],
              blocks: [
                { type: "bullet-list", items: [{ inlines: [{ text: "child" }] }] },
                { type: "ordered-list", items: [{ inlines: [{ text: "step" }] }] },
              ],
            },
          ],
        },
      ],
    };
    const markdown = serialize(document);
    expect(parse(markdown)).toEqual(document);
    expect(serialize(parse(markdown))).toBe(markdown);
  });

  it("rejects adjacent nested lists of the same kind that Markdown would merge", () => {
    const document: NoteDocumentV1 = {
      version: 1,
      blocks: [
        {
          type: "bullet-list",
          items: [
            {
              inlines: [{ text: "parent" }],
              blocks: [
                { type: "bullet-list", items: [{ inlines: [{ text: "first" }] }] },
                { type: "bullet-list", items: [{ inlines: [{ text: "second" }] }] },
              ],
            },
          ],
        },
      ],
    };
    rejects(() => serialize(document), "invalid_shape");
  });
});

describe("T02 standalone inline forms", () => {
  it.each([
    "~~strike~~",
    "`code`",
    "``a`b``",
    "__underline__",
    "*italic*",
    "**bold**",
    "[link](mailto:user@example.test)",
  ])("round-trips %s", (body) => {
    expect(serialize(parse(md(body)))).toBe(md(body));
  });
});

describe("T02 empty structural-block representability", () => {
  it.each([
    {
      label: "empty paragraph",
      document: { version: 1, blocks: [{ type: "paragraph", inlines: [] }] },
    },
    {
      label: "empty heading",
      document: { version: 1, blocks: [{ type: "heading", level: 1, inlines: [] }] },
    },
    {
      label: "empty bullet list",
      document: { version: 1, blocks: [{ type: "bullet-list", items: [] }] },
    },
    {
      label: "empty ordered list",
      document: { version: 1, blocks: [{ type: "ordered-list", items: [] }] },
    },
    {
      label: "empty kindless task list",
      document: { version: 1, blocks: [{ type: "task-list", items: [] }] },
    },
    {
      label: "empty explicit task list",
      document: { version: 1, blocks: [{ type: "task-list", kind: "task-list", items: [] }] },
    },
    {
      label: "empty blockquote",
      document: { version: 1, blocks: [{ type: "blockquote", blocks: [] }] },
    },
    {
      label: "empty callout",
      document: { version: 1, blocks: [{ type: "callout", variant: "info", blocks: [] }] },
    },
  ])("categorically refuses $label instead of emitting ambiguous syntax", ({ document }) => {
    rejects(() => serialize(document as NoteDocumentV1), "unsupported_node");
  });

  it.each([
    {
      label: "blockquote",
      document: {
        version: 1,
        blocks: [
          { type: "blockquote", blocks: [{ type: "paragraph", inlines: [{ text: "quoted" }] }] },
        ],
      },
    },
    {
      label: "callout",
      document: {
        version: 1,
        blocks: [
          {
            type: "callout",
            variant: "info",
            blocks: [{ type: "paragraph", inlines: [{ text: "note" }] }],
          },
        ],
      },
    },
    {
      label: "explicit task-list kind",
      document: {
        version: 1,
        blocks: [
          {
            type: "task-list",
            kind: "task-list",
            items: [{ checked: false, inlines: [{ text: "todo" }], children: [] }],
          },
        ],
      },
    },
  ])("round-trips non-empty $label with exact AST semantics", ({ document }) => {
    const ast = document as NoteDocumentV1;
    const markdown = serialize(ast);
    expect(parse(markdown)).toEqual(ast);
    expect(serialize(parse(markdown))).toBe(markdown);
  });
});
