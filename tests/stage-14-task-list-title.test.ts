import { describe, expect, it } from "vitest";
import {
  decodeNoteDocumentNative,
  serializeNoteDocumentNative,
} from "../src/core/note-document-native.js";
import {
  parseNoteDocumentMarkdown,
  serializeNoteDocumentMarkdown,
} from "../src/core/note-document-markdown.js";
import type { NoteDocumentV1 } from "../src/core/note-document.js";
import { NoteDocumentError, validateNoteDocument } from "../src/core/note-document.js";

const binding = { noteId: "fixture-note", revision: "fixture-revision" };
const wrap = (s: string) => ({
  type: "tiptap" as const,
  data: `<div data-type="document">${s}</div>`,
});

describe("task-list titles", () => {
  it("preserves separator characters in task-list titles and canonical JSON spelling", () => {
    for (const title of ["line\u2028separator", "paragraph\u2029separator"]) {
      const document: NoteDocumentV1 = {
        version: 1,
        blocks: [
          {
            type: "task-list",
            kind: "task-list",
            title,
            items: [{ checked: false, inlines: [{ text: "x" }], children: [] }],
          },
        ],
      };
      expect(() => validateNoteDocument(document)).not.toThrow();
      const markdown = serializeNoteDocumentMarkdown(document);
      expect(parseNoteDocumentMarkdown(markdown)).toEqual(document);
      const jsonTitle = JSON.stringify(title);
      const separator = title.includes("line") ? "\u2028" : "\u2029";
      const alternateTitle = jsonTitle.replace(
        separator,
        title.includes("line") ? "\\u2028" : "\\u2029",
      );
      const alternate = markdown.replace(jsonTitle, alternateTitle);
      expect(alternate).not.toBe(markdown);
      expect(() => parseNoteDocumentMarkdown(alternate)).toThrow(NoteDocumentError);
    }
  });

  it("normalizes a validated empty task-list title to omitted Markdown", () => {
    const document: NoteDocumentV1 = {
      version: 1,
      blocks: [
        {
          type: "task-list",
          kind: "task-list",
          title: "",
          items: [{ checked: false, inlines: [{ text: "x" }], children: [] }],
        },
      ],
    };
    expect(() => validateNoteDocument(document)).not.toThrow();
    const markdown = serializeNoteDocumentMarkdown(document);
    expect(markdown).not.toContain("title=");
    expect(parseNoteDocumentMarkdown(markdown)).toEqual({
      version: 1,
      blocks: [
        {
          type: "task-list",
          kind: "task-list",
          items: [{ checked: false, inlines: [{ text: "x" }], children: [] }],
        },
      ],
    });
  });

  it("preserves meaningful whitespace inside task-list titles", () => {
    const document: NoteDocumentV1 = {
      version: 1,
      blocks: [
        {
          type: "task-list",
          kind: "task-list",
          title: "task  title",
          items: [{ checked: false, inlines: [{ text: "x" }], children: [] }],
        },
      ],
    };
    expect(parseNoteDocumentMarkdown(serializeNoteDocumentMarkdown(document))).toEqual(document);
  });

  it("round-trips titled rich lists through Markdown and native HTML edits", () => {
    const native = wrap(
      '<ul class="checklist" data-title="Nookbridge Tasks"><li class="checklist--item"><p>one</p></li></ul>',
    );
    const decoded = decodeNoteDocumentNative(native, binding);
    expect(decoded.document.blocks[0]).toMatchObject({
      type: "task-list",
      title: "Nookbridge Tasks",
    });
    const markdown = serializeNoteDocumentMarkdown(decoded.document);
    expect(markdown).toContain(':::nookbridge list task-list title="Nookbridge Tasks"');
    const edited = parseNoteDocumentMarkdown(markdown.replace("one", "two"), {
      preimage: decoded.document,
    });
    expect(
      serializeNoteDocumentNative(edited, { context: decoded.context, binding }).data,
    ).toContain('data-title="Nookbridge Tasks"');
  });

  it("escapes title content and preserves intentional title removal", () => {
    const doc: NoteDocumentV1 = {
      version: 1,
      blocks: [
        {
          type: "task-list",
          kind: "task-list",
          title: 'A "<&> / 😀',
          items: [{ checked: false, inlines: [{ text: "x" }], children: [] }],
        },
      ],
    };
    const md = serializeNoteDocumentMarkdown(doc);
    expect(parseNoteDocumentMarkdown(md)).toEqual(doc);
    expect(serializeNoteDocumentNative(doc).data).toContain(
      'data-title="A &quot;&lt;&amp;&gt; / 😀"',
    );
    const removed = {
      ...doc,
      blocks: [
        {
          type: "task-list" as const,
          kind: "task-list" as const,
          items: doc.blocks[0]!.type === "task-list" ? doc.blocks[0]!.items : [],
        },
      ],
    };
    expect(serializeNoteDocumentMarkdown(removed)).not.toContain("title=");
  });

  it.each(["x".repeat(257), "bad\nname", "\ud800", 42])("rejects invalid title %s", (title) => {
    const document = {
      version: 1,
      blocks: [
        {
          type: "task-list",
          kind: "task-list",
          title,
          items: [{ checked: false, inlines: [{ text: "x" }], children: [] }],
        },
      ],
    };
    if (title === "") {
      expect(() => validateNoteDocument(document)).not.toThrow();
    } else {
      expect(() => validateNoteDocument(document)).toThrow(NoteDocumentError);
    }
  });

  it("decodes two independent top-level titled task lists", () => {
    const decoded = decodeNoteDocumentNative(
      wrap(
        '<ul class="checklist" data-title="first"><li class="checklist--item"><p>a</p></li></ul><ul class="checklist" data-title="second"><li class="checklist--item"><p>b</p></li></ul>',
      ),
      binding,
    );
    expect(serializeNoteDocumentMarkdown(decoded.document)).toContain('title="first"');
    expect(serializeNoteDocumentMarkdown(decoded.document)).toContain('title="second"');
  });

  it("preserves supported single-quoted and case-insensitive task-list attributes", () => {
    const decoded = decodeNoteDocumentNative(
      wrap(
        "<ul class='checklist' DATA-TITLE='outer'><li class='checklist--item'><p>x</p></li></ul>",
      ),
      binding,
    );
    expect(decoded.document.blocks[0]).toMatchObject({ type: "task-list", title: "outer" });
  });

  it("detects titled ordered-list checklist metadata before legacy updates", async () => {
    const { hasNonemptyNativeTaskListTitle } = await import("../src/core/note-document-native.js");
    expect(
      hasNonemptyNativeTaskListTitle(
        '<ol class="checklist" data-title="opaque"><li class="checklist--item"><p>x</p></li></ol>',
      ),
    ).toBe(true);
    expect(
      hasNonemptyNativeTaskListTitle('<ul class="ordinary" title="checklist"><li>x</li></ul>'),
    ).toBe(false);
  });

  it("accepts script-looking text only inside a canonical task-list title", async () => {
    const { createRevisionToken, planUpdateNote } = await import(
      "../src/core/notesnook-write-contract.js"
    );
    const content = `---\nnookbridge-format: 1\n---\n\n:::nookbridge list task-list title=${JSON.stringify("<script>alert(1)</script>")}\n- [ ] task\n:::\n`;
    const expectedRevision = createRevisionToken({ id: "note_test", dateEdited: 1 });
    expect(() =>
      planUpdateNote({
        id: "note_test",
        expectedRevision,
        patch: { content },
      }),
    ).not.toThrow();
    expect(() =>
      planUpdateNote({
        id: "note_test",
        expectedRevision,
        patch: { content: "<script>body</script>" },
      }),
    ).toThrow();
  });

  it("keeps unsupported simple-checklist titles opaque", () => {
    const decoded = decodeNoteDocumentNative(
      wrap(
        '<ul class="simple-checklist" data-title="opaque"><li class="simple-checklist--item"><p>x</p></li></ul>',
      ),
      binding,
    );
    expect(decoded.document.blocks[0]?.type).toBe("opaque");
  });

  it.each(["blockquote", "callout", "ordinary-list-item"])(
    "keeps nested titled rich lists opaque inside %s while decoding siblings",
    (container) => {
      const rich = `<ul class="checklist" data-title="${"x".repeat(257)}"><li class="checked checklist--item"><p>nested</p></li></ul>`;
      const nested =
        container === "blockquote"
          ? `<blockquote>${rich}</blockquote>`
          : container === "callout"
            ? `<div data-type="callout" data-variant="info">${rich}</div>`
            : `<ul><li><p>label</p>${rich}</li></ul>`;
      const decoded = decodeNoteDocumentNative(wrap(`<p>before</p>${nested}<p>after</p>`), binding);
      const blocks = decoded.document.blocks;
      expect(blocks[0]?.type).toBe("paragraph");
      const opaque =
        container === "ordinary-list-item"
          ? blocks[1]
          : blocks[1]?.type === "blockquote" || blocks[1]?.type === "callout"
            ? blocks[1].blocks[0]
            : undefined;
      expect(opaque?.type).toBe("opaque");
      expect(blocks[2]?.type).toBe("paragraph");
      const edited = {
        ...decoded.document,
        blocks: [
          { type: "paragraph" as const, inlines: [{ text: "changed" }] },
          blocks[1]!,
          blocks[2]!,
        ],
      };
      const stored = serializeNoteDocumentNative(edited, {
        context: decoded.context,
        binding,
      }).data;
      expect(stored).toContain(rich);
      expect(stored).toContain(">nested</p>");
    },
  );

  it.each(["blockquote", "callout"])(
    "promotes ordinary lists containing recursive opaque titles through %s",
    (container) => {
      const rich =
        '<ul class="checklist" data-title="nested"><li class="checked checklist--item"><p>task</p></li></ul>';
      const nested =
        container === "blockquote"
          ? `<blockquote>${rich}</blockquote>`
          : `<div data-type="callout" data-variant="info">${rich}</div>`;
      const list = `<ul><li><p>label</p>${nested}</li></ul>`;
      const decoded = decodeNoteDocumentNative(wrap(`<p>before</p>${list}`), binding);
      expect(decoded.document.blocks[1]?.type).toBe("opaque");
      const markdown = serializeNoteDocumentMarkdown(decoded.document);
      const edited = parseNoteDocumentMarkdown(markdown.replace("before", "after"), {
        preimage: decoded.document,
      });
      expect(
        serializeNoteDocumentNative(edited, { context: decoded.context, binding }).data,
      ).toContain(list);
    },
  );

  it.each(["blockquote", "callout"])(
    "rejects authored nonempty titles nested in %s at all serializers",
    (container) => {
      const task = {
        type: "task-list" as const,
        kind: "task-list" as const,
        title: "nested",
        items: [{ checked: false, inlines: [{ text: "task" }], children: [] }],
      };
      const outer =
        container === "blockquote"
          ? { type: "blockquote" as const, blocks: [task] }
          : { type: "callout" as const, variant: "info" as const, blocks: [task] };
      const doc = { version: 1 as const, blocks: [outer] };
      expect(() => validateNoteDocument(doc)).toThrow(NoteDocumentError);
      expect(() => serializeNoteDocumentMarkdown(doc)).toThrow(NoteDocumentError);
      expect(() => serializeNoteDocumentNative(doc)).toThrow();
      const body = ':::nookbridge list task-list title="nested"\n- [ ] task\n:::';
      const content =
        container === "blockquote"
          ? body
              .split("\n")
              .map((line) => "> " + line)
              .join("\n")
          : `:::nookbridge callout info\n${body}\n:::`;
      expect(() =>
        parseNoteDocumentMarkdown(`---\nnookbridge-format: 1\n---\n\n${content}\n`),
      ).toThrow(NoteDocumentError);
      const emptyTask = { ...task, title: "" };
      const emptyOuter =
        container === "blockquote"
          ? { type: "blockquote" as const, blocks: [emptyTask] }
          : { type: "callout" as const, variant: "info" as const, blocks: [emptyTask] };
      expect(() =>
        serializeNoteDocumentMarkdown({ version: 1, blocks: [emptyOuter] }),
      ).not.toThrow();
    },
  );

  it("refuses a root titled rich list with an oversized title", () => {
    const native = wrap(
      `<ul class="checklist" data-title="${"x".repeat(257)}"><li class="checklist--item"><p>root</p></li></ul>`,
    );
    expect(() => decodeNoteDocumentNative(native, binding)).toThrow();
  });

  it("normalizes an empty top-level rich-list title to absent on edited serialization", () => {
    const decoded = decodeNoteDocumentNative(
      wrap('<ul class="checklist" data-title=""><li class="checklist--item"><p>x</p></li></ul>'),
      binding,
    );
    expect(decoded.document.blocks[0]).toMatchObject({ type: "task-list", kind: "task-list" });
    expect(decoded.document.blocks[0]).not.toHaveProperty("title");
    const markdown = serializeNoteDocumentMarkdown(decoded.document).replace("x", "edited");
    const edited = parseNoteDocumentMarkdown(markdown, { preimage: decoded.document });
    expect(
      serializeNoteDocumentNative(edited, { context: decoded.context, binding }).data,
    ).not.toContain("data-title");
  });
});
