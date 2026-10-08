/**
 * Reserved `nookbridge-format` claim classifier, and the legacy controls for
 * claim-free `notes.create` input.
 *
 * The classifier recognises a top-level reserved key in a leading YAML header
 * with a real YAML parser (no regex over the key), under hard byte/alias/depth/
 * work bounds. Anything it cannot prove claim-free fails closed.
 */
import console from "node:console";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { describe, expect, it, vi } from "vitest";

import {
  createNotesnookWriteAdapter,
  type NotesnookStoredContent,
  type NotesnookWriteDatabase,
} from "../src/core/notesnook-write-adapter.js";
import {
  MARKDOWN_VERSION_CLAIM_MAX_HEADER_BYTES,
  classifyMarkdownVersionClaim,
} from "../src/core/note-document-version-claim.js";
import {
  assertSupportedConstructs,
  createDeterministicMarkdownCodec,
} from "../src/core/notesnook-write-codec.js";
import { STAGE4_WRITE_LIMITS } from "../src/core/notesnook-write-contract.js";

const claimed = (input: string) => expect(classifyMarkdownVersionClaim(input)).toBe("claimed");
const free = (input: string) => expect(classifyMarkdownVersionClaim(input)).toBe("claim-free");
const ambiguous = (input: string) => expect(classifyMarkdownVersionClaim(input)).toBe("ambiguous");

describe("version claim classifier — claims", () => {
  const forms: ReadonlyArray<readonly [string, string]> = [
    ["canonical header", "---\nnookbridge-format: 1\n---\n\nbody\n"],
    ["unknown version", "---\nnookbridge-format: 2\n---\n\nbody\n"],
    ["null value", "---\nnookbridge-format:\n---\n\nbody\n"],
    ["double-quoted key", '---\n"nookbridge-format": 1\n---\n\nbody\n'],
    ["single-quoted key", "---\n'nookbridge-format': 1\n---\n\nbody\n"],
    ["hex-escaped key", '---\n"nookbridge\\x2dformat": 2\n---\n\nbody\n'],
    ["unicode-escaped key", '---\n"\\u006eookbridge-format": 2\n---\n\nbody\n'],
    ["explicit multiline escaped key", '---\n? "nookbridge-\\\n  format"\n: 2\n---\n\nbody\n'],
    ["!!str tagged key", "---\n!!str nookbridge-format: 2\n---\n\nbody\n"],
    ["custom tagged key", "---\n!custom nookbridge-format: 2\n---\n\nbody\n"],
    ["anchored key", "---\n&a nookbridge-format: 2\n---\n\nbody\n"],
    ["explicit key", "---\n? nookbridge-format\n: 2\n---\n\nbody\n"],
    ["explicit quoted key", '---\n? "nookbridge-format"\n: 2\n---\n\nbody\n'],
    ["block-scalar value", "---\nnookbridge-format: >\n  2\n---\n\nbody\n"],
    ["flow mapping", "---\n{nookbridge-format: 2}\n---\n\nbody\n"],
    ["multiline flow mapping", "---\n{\n  title: x,\n  nookbridge-format: 2\n}\n---\n\nbody\n"],
    ["flow-style pair among others", "---\n{a: 1, 'nookbridge-format': 2, b: 3}\n---\n\nbody\n"],
    ["inline opener flow mapping", "--- {nookbridge-format: 2}\n---\n\nbody\n"],
    ["commented opener", "--- # metadata\nnookbridge-format: 2\n---\n\nbody\n"],
    ["tagged flow mapping", "--- !!map {nookbridge-format: 2}\n---\n\nbody\n"],
    ["anchored mapping", "--- &doc\nnookbridge-format: 2\n---\n\nbody\n"],
    ["alias-resolved key", "---\nname: &k nookbridge-format\n*k : 2\n---\n\nbody\n"],
    ["merge via alias", "---\nbase: &b\n  nookbridge-format: 2\n<<: *b\n---\n\nbody\n"],
    ["merge via inline map", "---\n<<: {nookbridge-format: 2}\n---\n\nbody\n"],
    [
      "merge via sequence",
      "---\na: &a {x: 1}\nb: &b {nookbridge-format: 2}\n<<: [*a, *b]\n---\n\nbody\n",
    ],
    ["nested merge", "---\nx: &x {nookbridge-format: 2}\ny: &y {<<: *x}\n<<: *y\n---\n\nbody\n"],
    [
      "merge key through alias key",
      "---\nm: &m nookbridge-format\nbase: &b {*m : 2}\n<<: *b\n---\n\nbody\n",
    ],
    ["case variant", "---\nNookBridge-Format: 2\n---\n\nbody\n"],
    ["leading blank lines", "\n\n---\nnookbridge-format: 2\n---\n\nbody\n"],
    ["byte-order mark", "\uFEFF---\nnookbridge-format: 2\n---\n\nbody\n"],
    ["CRLF header", "---\r\nnookbridge-format: 1\r\n---\r\n\r\nbody\r\n"],
    ["document-end terminator", "---\nnookbridge-format: 2\n...\n\nbody\n"],
    ["trailing spaces after opener", "---   \nnookbridge-format: 2\n---\n\nbody\n"],
    ["no terminator at all", "---\nnookbridge-format: 2\n"],
    ["claim followed by a second front matter", "---\nnookbridge-format: 1\n---\n---\nx: 1\n---\n"],
  ];
  for (const [label, input] of forms) {
    it(`claims: ${label}`, () => claimed(input));
  }
});

describe("version claim classifier — claim-free", () => {
  const forms: ReadonlyArray<readonly [string, string]> = [
    ["ordinary prose", "Notes about nookbridge-format: the spec is long.\n"],
    ["claim-looking line without an opener", "nookbridge-format: 1\n\nbody\n"],
    ["fenced example", "```\n---\nnookbridge-format: 2\n---\n```\n"],
    ["fenced example with language", "```yaml\n---\nnookbridge-format: 1\n---\n```\n"],
    ["heading then header-looking text", "# Title\n\n---\nnookbridge-format: 2\n---\n"],
    ["colon without space is a scalar", "---\nnookbridge-format:guide\n---\n\nbody\n"],
    ["bare colon scalar document", "nookbridge-format:guide\n"],
    ["similarly named key", "---\nnookbridge-title: x\n---\n\nbody\n"],
    ["longer key", "---\nnookbridge-format-guide: x\n---\n\nbody\n"],
    ["prefixed key", "---\nmy-nookbridge-format: x\n---\n\nbody\n"],
    ["filename key", "---\nnookbridge-format.md: 1\n---\n\nbody\n"],
    ["filename value", "---\nfile: nookbridge-format.md\n---\n\nbody\n"],
    ["claim only as a value", "---\ntitle: nookbridge-format\n---\n\nbody\n"],
    ["claim only inside a nested mapping", "---\nmeta:\n  nookbridge-format: 2\n---\n\nbody\n"],
    ["claim only inside a flow value", "---\nmeta: {nookbridge-format: 2}\n---\n\nbody\n"],
    ["claim only inside a sequence", "---\n- nookbridge-format: 2\n---\n\nbody\n"],
    ["unrelated alias key", "---\nname: &a title\n*a : 1\n---\n\nbody\n"],
    ["unrelated merge", "---\nbase: &b {color: red}\n<<: *b\n---\n\nbody\n"],
    ["quoted merge-like key is literal", "---\n'<<': 1\n---\n\nbody\n"],
    ["claim only after the terminator", "---\ntitle: x\n---\nnookbridge-format: 2\n"],
    ["claim only in a later document", "---\ntitle: x\n---\n---\nnookbridge-format: 2\n---\n"],
    ["ordinary front matter", "---\ntitle: x\ntags: [a, b]\n---\n\nbody\n"],
    ["empty front matter", "---\n---\n\nbody\n"],
    ["horizontal rule only", "---"],
    ["horizontal rule then prose", "---\n\nsome prose\n"],
    ["four dashes", "----\nnookbridge-format: 2\n----\n"],
    ["dashes glued to text", "---nookbridge-format: 2\n"],
    ["inline-opener scalar", "--- hello there\n\nmore\n"],
    ["top-level sequence", "---\n- a\n- b\n---\n\nbody\n"],
    ["indented opener", "  ---\n  nookbridge-format: 2\n  ---\n"],
    ["prose with a mid-document rule", "intro\n\n---\nnookbridge-format: 2\n---\n"],
    ["empty string", ""],
  ];
  for (const [label, input] of forms) {
    it(`claim-free: ${label}`, () => free(input));
  }
});

describe("version claim classifier — fails closed and stays bounded", () => {
  const forms: ReadonlyArray<readonly [string, string]> = [
    ["malformed escaped key", '---\n"nookbridge\\qformat": 2\n---\n\nbody\n'],
    ["malformed escaped key, truncated escape", '---\n"nookbridge\\x2": 2\n---\n'],
    ["unterminated quoted key", '---\n"nookbridge-format: 2\n---\n\nbody\n'],
    ["unterminated flow mapping", "---\n{nookbridge-format: 2\n---\n\nbody\n"],
    ["duplicate keys", "---\na: 1\na: 2\n---\n\nbody\n"],
    ["unresolved alias key", "---\n*missing : 1\n---\n\nbody\n"],
    ["tab indentation", "---\n\tnookbridge-format: 2\n---\n"],
    ["bad indentation", "---\na: 1\n  b: 2\n---\n"],
    ["unterminated opener with non-YAML remainder", "---\n\n`code` is a thing.\n"],
    ["implicit multiline quoted key", '---\n"nookbridge-\\\n  format": 2\n---\n\nbody\n'],
    [
      "flow mapping header followed by prose, no terminator",
      "--- {nookbridge-format: 2}\n\nbody\n",
    ],
    ["CR-only line breaks", "---\rnookbridge-format: 2\r---\r\rbody\r"],
  ];
  for (const [label, input] of forms) {
    it(`ambiguous: ${label}`, () => ambiguous(input));
  }

  it("treats a header larger than the byte bound as ambiguous without parsing it", () => {
    const comments = "# padding\n".repeat(
      Math.ceil(MARKDOWN_VERSION_CLAIM_MAX_HEADER_BYTES / 10) + 5,
    );
    ambiguous(`---\n${comments}nookbridge-format: 2\n---\n\nbody\n`);
    ambiguous(`---\n${comments}`);
  });

  it("bounds a 240KB malformed flow header (no terminator) in time", () => {
    const input = `---\n${"[".repeat(240 * 1024)}`;
    const started = performance.now();
    ambiguous(input);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("bounds a 240KB malformed flow header followed by a late terminator in time", () => {
    const input = `---\n${"{[".repeat(120 * 1024)}\n---\n\nbody\n`;
    const started = performance.now();
    ambiguous(input);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("bounds a malformed flow header that fits under the byte bound", () => {
    const input = `---\n${"{[".repeat(MARKDOWN_VERSION_CLAIM_MAX_HEADER_BYTES / 4)}\n---\n\nbody\n`;
    const started = performance.now();
    ambiguous(input);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("bounds deeply nested but well-formed flow collections", () => {
    const depth = 200;
    const input = `---\nk: ${"[".repeat(depth)}${"]".repeat(depth)}\n---\n\nbody\n`;
    const started = performance.now();
    ambiguous(input);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("caps alias count, including an alias-amplification header, without expanding it", () => {
    const lines = ["a: &a0 [x, x, x, x, x, x, x, x, x]"];
    for (let level = 1; level < 12; level += 1) {
      const refs = Array.from({ length: 9 }, () => `*a${level - 1}`).join(", ");
      lines.push(`a${level}: &a${level} [${refs}]`);
    }
    const input = `---\n${lines.join("\n")}\n---\n\nbody\n`;
    expect(input.length).toBeLessThan(MARKDOWN_VERSION_CLAIM_MAX_HEADER_BYTES);
    const started = performance.now();
    ambiguous(input);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("caps merge expansion work", () => {
    const merges = Array.from({ length: 64 }, () => "*b").join(", ");
    const input = `---\nb: &b {a: 1}\n<<: [${merges}]\n---\n\nbody\n`;
    ambiguous(input);
  });

  it("never throws for hostile string input", () => {
    for (const input of [
      "---",
      "---\n",
      "--- ",
      "\uFEFF",
      "---\n\u0000",
      "---\n\ud800",
      "...",
      "---\n...",
    ]) {
      expect(() => classifyMarkdownVersionClaim(input)).not.toThrow();
    }
  });

  it("does not print parser diagnostics", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      classifyMarkdownVersionClaim('---\n"nookbridge\\qformat": 2\n---\n');
      classifyMarkdownVersionClaim("---\n!custom a: 1\n---\n");
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Legacy controls: claim-free input keeps the baseline codec/fidelity result.
// ---------------------------------------------------------------------------

function legacyOutcome(content: string): NotesnookStoredContent | "unsupported_content" {
  try {
    assertSupportedConstructs(content, STAGE4_WRITE_LIMITS.maxContentBytes);
    return createDeterministicMarkdownCodec().encodeMarkdown(content, "simple-checklist");
  } catch {
    return "unsupported_content";
  }
}

function seam(
  notesAdd: (input: { title: string; content: NotesnookStoredContent }) => Promise<string>,
): NotesnookWriteDatabase {
  return {
    notesAdd,
    note: vi.fn(async () => undefined),
    contentFindByNoteId: vi.fn(async () => undefined),
    notesUpdate: vi.fn(async () => undefined),
    notesTouch: vi.fn(async () => undefined),
    contentAdd: vi.fn(async () => "content-id"),
    contentUpdateByNoteId: vi.fn(async () => undefined),
    notebookExists: vi.fn(async () => true),
    notebookNotes: vi.fn(async () => [] as readonly string[]),
    notebookAddNote: vi.fn(async () => undefined),
    notebookRemoveNote: vi.fn(async () => undefined),
    tagExists: vi.fn(async () => true),
    tagAdd: vi.fn(async () => "tag-id"),
    relationAdd: vi.fn(async () => undefined),
    relationRemove: vi.fn(async () => undefined),
    relationListForNote: vi.fn(async () => [] as readonly unknown[]),
  } as unknown as NotesnookWriteDatabase;
}

async function adapterOutcome(
  content: string,
): Promise<NotesnookStoredContent | "unsupported_content" | "refused"> {
  const stored: NotesnookStoredContent[] = [];
  const database = seam(async (input) => {
    stored.push(input.content);
    return "0123456789abcdef0123456789abcdef";
  });
  const adapter = createNotesnookWriteAdapter({
    source: database,
    codec: createDeterministicMarkdownCodec(),
  });
  try {
    await adapter.createNote({ title: "legacy", content });
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "unsupported_content" ? "unsupported_content" : "refused";
  }
  return stored[0] as NotesnookStoredContent;
}

describe("claim-free create input keeps the baseline legacy codec and fidelity gate", () => {
  const controls: ReadonlyArray<readonly [string, string]> = [
    [
      "ordinary prose",
      "Plain prose that mentions nookbridge-format: the guide.\n\nSecond paragraph.",
    ],
    ["fenced text containing a claim", "```\n---\nnookbridge-format: 2\n---\n```"],
    ["colon-without-space", "nookbridge-format:guide"],
    ["similarly named front matter", "---\nnookbridge-title: x\n---\n\nbody"],
    ["filename mention", "See nookbridge-format.md for details.\n\n---\n\nnookbridge-format.md"],
    ["unrelated alias key front matter", "---\nname: &a title\n*a : 1\n---\n\nbody"],
    ["ordinary front matter", "---\ntitle: x\ntags: [a, b]\n---\n\nbody"],
    ["horizontal rule only", "---"],
    ["horizontal rule between paragraphs", "before\n\n---\n\nafter"],
    ["checklist", "- [ ] one\n- [x] two"],
  ];
  for (const [label, content] of controls) {
    it(`matches the legacy result for: ${label}`, async () => {
      expect(classifyMarkdownVersionClaim(content)).toBe("claim-free");
      const expected = legacyOutcome(content);
      const actual = await adapterOutcome(content);
      expect(actual).toEqual(expected);
    });
  }

  it("does not newly admit legacy front matter the fidelity gate rejects", async () => {
    const content = "---\ntitle: x\n---\n\n| a | b |\n| :- | -: |\n| 1 | 2 |";
    expect(classifyMarkdownVersionClaim(content)).toBe("claim-free");
    const expected = legacyOutcome(content);
    expect(await adapterOutcome(content)).toEqual(expected);
  });

  it("never reaches the legacy codec for any claimed form", async () => {
    const encodeMarkdown = vi.fn(createDeterministicMarkdownCodec().encodeMarkdown);
    const notesAdd = vi.fn(async () => "id");
    const adapter = createNotesnookWriteAdapter({
      source: seam(notesAdd),
      codec: {
        encodeMarkdown,
        appendMarkdownToStoredContent:
          createDeterministicMarkdownCodec().appendMarkdownToStoredContent,
      },
    });
    for (const content of [
      "---\nnookbridge-format: 2\n---\n\nbody\n",
      '---\n"nookbridge\\x2dformat": 2\n---\n\nbody\n',
      "---\nbase: &b {nookbridge-format: 2}\n<<: *b\n---\n\nbody\n",
      '---\n"nookbridge\\qformat": 2\n---\n\nbody\n',
    ]) {
      await expect(adapter.createNote({ title: "x", content })).rejects.toMatchObject({
        code: "unsupported_content",
      });
    }
    expect(encodeMarkdown).not.toHaveBeenCalled();
    expect(notesAdd).not.toHaveBeenCalled();
  });
});
