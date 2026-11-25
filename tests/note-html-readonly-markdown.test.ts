import { describe, expect, it } from "vitest";
import { noteHtmlReadonlyMarkdown, scanHtml } from "../src/core/note-html-readonly-markdown.js";

describe("read-only Notesnook HTML Markdown projection", () => {
  it("drops decoration and renders headings", () => {
    expect(
      noteHtmlReadonlyMarkdown(
        '<h4><span style="color:red"><strong>Hi</strong></span></h4><h6>x</h6>',
      ),
    ).toBe("#### **Hi**\n\n###### x");
  });
  it("leaves hash tags and equals prose unescaped at line start", () => {
    expect(noteHtmlReadonlyMarkdown("<p>#tag</p><p>= label</p>")).toBe("#tag\n\n= label");
  });
  it("renders nested lists, ordered starts, and checklist states", () => {
    expect(
      noteHtmlReadonlyMarkdown(
        '<ol start="3"><li>A<ul><li>B</li></ul></li></ol><ul class="checklist"><li class="checklist--item checked"><p>Done</p></li><li class="checklist--item"><p>Todo</p></li></ul>',
      ),
    ).toContain("3. A\n  - B\n\n- [x] Done\n- [ ] Todo");
  });
  it("escapes list markers inside generated list labels", () => {
    expect(noteHtmlReadonlyMarkdown("<ul><li><p>- literal</p></li></ul>")).toBe("- \\- literal");
  });
  it("protects inline elements from emitting a new list at line start", () => {
    expect(noteHtmlReadonlyMarkdown("<span>Notes:<br />- Settings</span>")).toBe(
      "Notes:\n\\- Settings",
    );
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
      "[x\\]y)](https://example.test/a\\)b\\])",
    ],
    [
      "link text cannot inject nested Markdown links",
      '<a href="https://example.test/">[x](https://evil.test)</a>',
      "[\\[x\\](https://evil.test)](https://example.test/)",
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
    ["emphasis characters in text are escaped", "<p>a*b_c~d|e</p>", "a\\*b_c\\~d\\|e"],
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
      "[attachment: a\\`b\\*c_d\\!e.pdf]",
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

  // The scanner must stay linear on input that never terminates a token. Each
  // opener in the old regex form rescanned to end-of-input, so cost was
  // tokens x length. These cases put a large opener count in front of a long
  // tail, which makes that product huge while leaving the linear scan trivial.
  // The token budget is raised deliberately: under the production caps the
  // quadratic form is still cheap enough to pass, so the caps would hide the
  // regression this guards against when issue #327 raises them.
  const MB = 1024 * 1024;
  const roomy = { maxBytes: 16 * MB, maxTokens: 4_000_000 };
  const scanTime = (html: string): number => {
    const started = Date.now();
    expect(Array.isArray(scanHtml(html, roomy))).toBe(true);
    return Date.now() - started;
  };

  it("scans unterminated tag openers in linear time", () => {
    const html = "<a".repeat(100_000) + "x".repeat(8 * MB - 200_000);
    expect(scanTime(html)).toBeLessThan(3_000);
  });

  it("scans unterminated comments in linear time", () => {
    const html = "<!--".repeat(100_000) + "x".repeat(8 * MB - 400_000);
    expect(scanTime(html)).toBeLessThan(3_000);
  });

  // An unterminated comment was not a comment to the old alternation: it fell
  // through to the declaration form and was swallowed up to the next `>`. The
  // scanner reproduces that, and only degrades to literal text when no `>`
  // remains at all.
  it.each([
    ["unterminated comment swallows to the next >", "<!-- x >", ""],
    ["unterminated comment with only >", "<!-->", ""],
    ["empty comment", "<!---->", ""],
    ["declaration is dropped", "<![CDATA[x]]>", ""],
    ["comment followed by text keeps the text", "<!--a-->b", "b"],
    ["empty close tag is literal", "</>", "\\<\n\n/\\>"],
    ["close tag with a space is literal", "</ a>", "\\<\n\n/ a\\>"],
  ])("%s", (_name, html, expected) => {
    expect(noteHtmlReadonlyMarkdown(html)).toBe(expected);
  });

  it("keeps unterminated openers as literal text below the token budget", () => {
    const markdown = noteHtmlReadonlyMarkdown("<a".repeat(1_000));
    // An opener with no `>` is not a tag: the `<` survives as escaped literal
    // text and the rest is ordinary text, exactly as the regex form produced.
    expect(markdown.startsWith("\\<")).toBe(true);
    expect(markdown).toContain("a");
  });
});
