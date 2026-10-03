import { describe, expect, it } from "vitest";
import { noteHtmlReadonlyMarkdown } from "../src/core/note-html-readonly-markdown.js";

describe("read-only Notesnook HTML Markdown projection", () => {
  it("drops decoration and renders headings", () => {
    expect(
      noteHtmlReadonlyMarkdown(
        '<h4><span style="color:red"><strong>Hi</strong></span></h4><h6>x</h6>',
      ),
    ).toBe("#### **Hi**\n\n###### x");
  });
  it("renders nested lists, ordered starts, and checklist states", () => {
    expect(
      noteHtmlReadonlyMarkdown(
        '<ol start="3"><li>A<ul><li>B</li></ul></li></ol><ul class="checklist"><li class="checklist--item checked"><p>Done</p></li><li class="checklist--item"><p>Todo</p></li></ul>',
      ),
    ).toContain("3. A\n  - B\n\n- [x] Done\n- [ ] Todo");
  });
  it("renders tables, code, quote, and safe links", () => {
    const html =
      '<table><colgroup><col></colgroup><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></tbody></table><pre><code class="language-ts">let x=1</code></pre><blockquote><p>q</p></blockquote><a href="javascript:alert(1)">bad</a><a href="https://example.com">ok</a>';
    const result = noteHtmlReadonlyMarkdown(html);
    expect(result).toContain("| A | B |");
    expect(result).toContain("```ts\nlet x=1\n```");
    expect(result).toContain("> q");
    expect(result).toContain("bad");
    expect(result).toContain("[ok](https://example.com)");
  });
  it("drops active content and keeps only safe placeholders", () => {
    const result = noteHtmlReadonlyMarkdown(
      '<script>secret</script><style>x</style><img src="https://private/x" alt="leak"><div data-type="attachment" data-name="report.pdf">x</div><x-foo>custom &amp; text</x-foo>',
    );
    expect(result).not.toContain("secret");
    expect(result).not.toContain("private");
    expect(result).toContain("[image]");
    expect(result).toContain("custom & text");
    expect(result).not.toMatch(/<\/?[a-z]/i);
  });
  it("bounds input and nesting with a failure signal", () => {
    expect(() => noteHtmlReadonlyMarkdown("<" + "p>" + "x".repeat(300_001))).toThrow();
    expect(() =>
      noteHtmlReadonlyMarkdown("<div>".repeat(66) + "x" + "</div>".repeat(66)),
    ).toThrow();
  });
  it("degrades malformed markup without throwing", () => {
    expect(() => noteHtmlReadonlyMarkdown("<p>unfinished <b>mark")).not.toThrow();
  });

  it.each([
    ["raw markup tags are never emitted", "<p>before</p><x-foo>after</x-foo>", "before\n\nafter"],
    [
      "entities remain text, not parsed markup",
      "<p>&lt;script&gt;safe&lt;/script&gt;</p>",
      "\\<script\\>safe\\</script\\>",
    ],
    [
      "link text and href delimiters are escaped",
      '<a href="https://example.test/a)b]">x]y)</a>',
      "[x\\]y\\)](https://example.test/a\\)b\\])",
    ],
    [
      "link text cannot inject nested Markdown links",
      '<a href="https://example.test/">[x](https://evil.test)</a>',
      "[\\[x\\]\\(https://evil.test\\)](https://example.test/)",
    ],
    [
      "href parentheses are escaped",
      '<a href="https://example.test/a(b">t</a>',
      "[t](https://example.test/a\\(b)",
    ],
    [
      "invalid numeric entities are dropped, not thrown",
      "<p>a&#xD800;b&#1114112;c&#55296;d</p>",
      "abcd",
    ],
    [
      "image syntax in text is neutralized",
      '<p>!<a href="https://safe.test">x</a></p>',
      "\\![x](https://safe.test)",
    ],
    ["backticks in text are escaped", "<p>`hello`</p>", "\\`hello\\`"],
    ["heading marker in text is escaped", "<p># not heading</p>", "\\# not heading"],
    ["list marker in text is escaped", "<p>- not list</p>", "\\- not list"],
    ["ordered marker in text is escaped", "<p>1. not list</p>", "1\\. not list"],
    ["emphasis characters in text are escaped", "<p>a*b_c~d|e</p>", "a\\*b\\_c\\~d\\|e"],
    [
      "br inside link text does not split the link",
      '<a href="https://safe.test">a<br>b</a>',
      "[a b](https://safe.test)",
    ],
    ["code span content is not double escaped", "<p><code>a_b</code></p>", "`a_b`"],
    ["br in heading cannot forge a heading", "<h2>x<br># forged</h2>", "## x # forged"],
    ["br in list label cannot forge an item", "<ul><li>x<br>- forged</li></ul>", "- x - forged"],
    [
      "pipes in table cells are escaped",
      "<table><tr><td>x| forged | cell</td></tr></table>",
      "| x\\| forged \\| cell |\n| --- |",
    ],
    [
      "code fence cannot be broken out of",
      "<pre><code>x```# injected```</code></pre>",
      "````\nx```# injected```\n````",
    ],
    [
      "attachment name markdown is escaped",
      '<div data-type="attachment" data-name="a`b*c_d!e.pdf">x</div>',
      "[attachment: a\\`b\\*c\\_d\\!e.pdf]",
    ],
    [
      "blockquote text is escaped and quoted",
      "<blockquote><p># h</p><p>- l</p></blockquote>",
      "> \\# h\n> \n> \\- l",
    ],
    [
      "br in blockquote keeps quote prefix on every line",
      "<blockquote><p>a<br># b</p></blockquote>",
      "> a\n> \\# b",
    ],
    [
      "code block keeps its line breaks",
      "<pre><code>a\n  b\nc</code></pre><p>tail</p>",
      "```\na\n  b\nc\n```\n\ntail",
    ],
    ["br inside code block becomes a newline", "<pre><code>a<br>b</code></pre>", "```\na\nb\n```"],
    ["br inside inline code becomes a space", "<p><code>a<br>b</code></p>", "`a b`"],
    [
      "code block with fence run and newlines stays contained",
      "<pre><code>x\n```\n# y\n```</code></pre>",
      "````\nx\n```\n# y\n```\n````",
    ],
    [
      "mailto links are allowed",
      '<a href="mailto:a@example.test">email</a>',
      "[email](mailto:a@example.test)",
    ],
    ["unsafe links become text", '<a href="data:text/html,x">plain</a>', "plain"],
    [
      "task tokens require exact class tokens",
      '<ul class="not-checklist"><li>one</li></ul>',
      "- one",
    ],
    [
      "simple checklist tokens are recognized",
      '<ul class="simple-checklist"><li class="simple-checklist--item checked">yes</li></ul>',
      "- [x] yes",
    ],
    [
      "thead and tbody tables render",
      "<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>D</td></tr></tbody></table>",
      "| H |\n| --- |\n| D |",
    ],
    [
      "attachment filename is sanitized",
      '<div data-type="attachment" data-name="[bad]\nfile.pdf">x</div>',
      "[attachment: \\[bad\\]file.pdf]",
    ],
    [
      "all active content is dropped",
      "<p>a</p><script>x<script>nested</script>y</script><p>b</p>",
      "a\n\nb",
    ],
    ["unmatched dangerous close preserves following text", "</script><p>safe</p>", "safe"],
  ])("%s", (_name, html, expected) => {
    expect(noteHtmlReadonlyMarkdown(html)).toBe(expected);
  });

  it("strips controls while preserving br newlines", () => {
    expect(noteHtmlReadonlyMarkdown("<p>a\u0001<br>b\u007f</p>")).toBe("a\nb");
  });

  it("keeps code language to safe identifier characters", () => {
    expect(
      noteHtmlReadonlyMarkdown('<pre><code class="language-ts onmouseover=bad">x</code></pre>'),
    ).toBe("```ts\nx\n```");
  });
});
