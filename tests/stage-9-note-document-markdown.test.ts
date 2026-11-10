import { describe, expect, it, vi } from "vitest";
import { NoteDocumentError, type NoteDocumentV1 } from "../src/core/note-document.js";
import {
  inspectNoteDocumentMarkdownWithoutTaskTitles,
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
const opaqueBlock = {
  type: "opaque" as const,
  nodeType: "image",
  sentinel: { version: 1 as const, source: "native-html" as const, token: "ref_0123456789abcdef" },
};
const opaque: NoteDocumentV1 = { version: 1, blocks: [opaqueBlock] };

describe("T02 deterministic Markdown interchange", () => {
  it("publishes the frozen version header and editor budget", () => {
    expect(H).toBe(header);
    expect(LIMIT).toBe(4 * 1024 * 1024);
    expect(serialize(parse(header))).toBe(header);
  });
  it.each(["1", "123456789"])("round-trips %s digit prose prefixes", (digits) => {
    const document: NoteDocumentV1 = {
      version: 1,
      blocks: [{ type: "paragraph", inlines: [{ text: `${digits}. This is prose` }] }],
    };
    const markdown = serialize(document);
    expect(markdown).toContain(`\\${digits}. This is prose`);
    expect(parse(markdown)).toEqual(document);
  });
  // Ordinary prose must survive a read unchanged: an underscore inside a
  // word cannot open or close emphasis, and a backslash is only an escape
  // before ASCII punctuation.
  it.each([
    "the code was invalid_request",
    "snake_case_name and SCREAMING_CASE",
    "a path like C:\\temp and D:\\data\\file.txt",
    "100% of users_said.so",
  ])("leaves ordinary prose untouched: %s", (text) => {
    const document: NoteDocumentV1 = {
      version: 1,
      blocks: [{ type: "paragraph", inlines: [{ text }] }],
    };
    const markdown = serialize(document);
    expect(markdown).toContain(text);
    expect(parse(markdown)).toEqual(document);
  });
  it("still escapes underscore emphasis and a backslash before punctuation", () => {
    const document: NoteDocumentV1 = {
      version: 1,
      blocks: [
        {
          type: "paragraph",
          inlines: [{ text: "_emphasis_ and a literal \\* star" }],
        },
      ],
    };
    const markdown = serialize(document);
    expect(markdown).toContain("\\_emphasis\\_");
    expect(markdown).toContain("\\\\\\*");
    expect(parse(markdown)).toEqual(document);
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
  it.each([undefined, "", "Readable"])(
    "renders exact opaque bytes and round-trips text %s",
    (text) => {
      const doc: NoteDocumentV1 = {
        version: 1,
        blocks: [{ ...opaque.blocks[0]!, ...(text === undefined ? {} : { text }) }],
      };
      const expected =
        text === undefined
          ? "---\nnookbridge-format: 1\n---\n\n:::nookbridge opaque image\nref:1:native-html:ref_0123456789abcdef\n:::\n"
          : text === ""
            ? '---\nnookbridge-format: 1\n---\n\n:::nookbridge opaque image text=""\nref:1:native-html:ref_0123456789abcdef\n:::\n'
            : '---\nnookbridge-format: 1\n---\n\n:::nookbridge opaque image text="Readable"\nref:1:native-html:ref_0123456789abcdef\n:::\n';
      expect(serialize(doc)).toBe(expected);
      expect(parse(serialize(doc), { preimage: doc })).toEqual(doc);
      if (text !== undefined) {
        rejects(
          () =>
            parse(serialize(doc).replace(`text=${JSON.stringify(text)}`, 'text="changed"'), {
              preimage: doc,
            }),
          "opaque_payload_forbidden",
        );
      }
    },
  );
  it.each([
    ["text=42", "invalid_shape"],
    ["text=null", "invalid_shape"],
    ['text="\\u006fk"', "invalid_shape"],
    ['text= "ok"', "invalid_shape"],
    ['text="ok" ', "invalid_shape"],
    ["text=", "invalid_shape"],
    ['text="ok" payload="CANARY"', "invalid_shape"],
  ])("rejects the directive attribute %s", (attribute, code) => {
    // The preimage carries `text`, so replacing it is a real edit of a real
    // field: a body with no `text` would be refused for the wrong reason and
    // prove nothing about the grammar. A non-canonical re-stringify, a stray
    // space, an empty value or a payload key must all be refused.
    const preimage: NoteDocumentV1 = { version: 1, blocks: [{ ...opaqueBlock, text: "ok" }] };
    const input = serialize(preimage).replace('text="ok"', attribute);
    expect(input).not.toBe(serialize(preimage));
    rejects(() => parse(input, { preimage }), code);
  });

  it("rejects a directive that names text twice", () => {
    const preimage: NoteDocumentV1 = { version: 1, blocks: [{ ...opaqueBlock, text: "ok" }] };
    const input = serialize(preimage).replace('text="ok"', 'text="ok" text="ok"');
    rejects(() => parse(input, { preimage }), "invalid_shape");
  });

  it("refuses a removed or added text against the preimage", () => {
    const withText: NoteDocumentV1 = { version: 1, blocks: [{ ...opaqueBlock, text: "ok" }] };
    rejects(() => parse(serialize(opaque), { preimage: withText }), "opaque_payload_forbidden");
    rejects(() => parse(serialize(withText), { preimage: opaque }), "opaque_payload_forbidden");
  });

  it("masks derived opaque text when inspecting for embedded markup", () => {
    // The readable text is derived from the preserved bytes, so it can hold
    // escaped markup (`\<script\>`). It is bound to the preimage by the
    // reference tuple, so masking it cannot let a client smuggle markup in.
    const doc: NoteDocumentV1 = {
      version: 1,
      blocks: [{ ...opaqueBlock, text: "\\<script>alert(1)</script>" }],
    };
    const serialised = serialize(doc);
    expect(serialised).toContain("script");
    const inspected = inspectNoteDocumentMarkdownWithoutTaskTitles(serialised);
    expect(inspected).not.toMatch(/<\s*script/i);
    expect(inspected).toContain(`ref:1:native-html:${opaqueBlock.sentinel.token}`);
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
