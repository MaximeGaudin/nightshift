import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, toPlainText } from "../src/web/markdown.tsx";

const render = (source: string) => renderToStaticMarkup(<Markdown source={source} />);

test("markdown-blocks", () => {
  const src = [
    "## Titre",
    "",
    "Un paragraphe.",
    "",
    "- un",
    "  - imbriqué",
    "- deux",
    "",
    "1. premier",
    "2. second",
    "",
    "> citation",
    "",
    "---",
    "",
    "```ts",
    "const a = 1 < 2;",
    "  indent();",
    "```",
  ].join("\n");
  const html = render(src);
  expect(html).toContain("<h2>Titre</h2>");
  expect(html).toContain("<p>Un paragraphe.</p>");
  expect(html).toMatch(/<ul><li>un<ul><li>imbriqué<\/li><\/ul><\/li><li>deux<\/li><\/ul>/);
  expect(html).toContain("<ol><li>premier</li><li>second</li></ol>");
  expect(html).toContain("<blockquote><p>citation</p></blockquote>");
  expect(html).toContain("<hr/>");
  expect(html).toContain("<pre><code>const a = 1 &lt; 2;\n  indent();</code></pre>");
});

test("markdown-inline", () => {
  const html = render("**a** *b* `c` [d](https://x.io)");
  expect(html).toContain("<strong>a</strong>");
  expect(html).toContain("<em>b</em>");
  expect(html).toContain("<code>c</code>");
  expect(html).toContain('<a href="https://x.io" target="_blank" rel="noreferrer">d</a>');
});

test("markdown-inline bare urls and underscores", () => {
  const html = render("voir https://x.io/a_b. et _c_ snake_case_name");
  expect(html).toContain('<a href="https://x.io/a_b" target="_blank" rel="noreferrer">https://x.io/a_b</a>.');
  expect(html).toContain("<em>c</em>");
  expect(html).toContain("snake_case_name");
});

test("markdown-table-and-tasks", () => {
  const html = render("| A | B |\n|---|:-:|\n| 1 | 2 |\n\n- [ ] x\n- [x] y");
  expect(html).toContain("<table>");
  expect(html).toContain("<th>A</th>");
  expect(html).toContain('<th style="text-align:center">B</th>');
  expect(html).toContain("<td>1</td>");
  const boxes = html.match(/<input[^>]*>/g) ?? [];
  expect(boxes.length).toBe(2);
  for (const b of boxes) {
    expect(b).toContain('type="checkbox"');
    expect(b).toContain('disabled=""');
  }
  expect(boxes[0]).not.toContain("checked");
  expect(boxes[1]).toContain('checked=""');
});

test("markdown-no-html-injection", () => {
  const html = render("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
});

test("markdown-unsafe-links", () => {
  const html = render("[x](javascript:alert(1)) [y](data:text/html,<b>hi</b>) [z](JaVaScRiPt:alert(1))");
  expect(html).not.toContain("<a");
  expect(html).toContain("javascript:alert(1)");
});

test("markdown-malformed", () => {
  const cases = ["```\nnever closed\nstill code", "a ** b", "|", "", "[open](", "*x", "`tick", "> > >", "- [", "1."];
  for (const src of cases) {
    let html = "";
    expect(() => {
      html = render(src);
    }).not.toThrow();
    expect(html.startsWith('<div class="md')).toBe(true);
  }
  expect(render("```\nnever closed\nstill code")).toContain("<pre><code>never closed\nstill code</code></pre>");
  expect(render("a ** b")).toContain("a ** b");
  expect(render("|")).toContain("|");
  expect(render("")).toBe('<div class="md"></div>');
  expect(render("> ".repeat(500) + "deep")).toContain("deep");
});

test("markdown-plain-text", () => {
  expect(toPlainText("## Titre\n- **a** [lien](https://x.io)")).toBe("Titre a lien");
  expect(toPlainText("")).toBe("");
});

test("markdown-task-with-numbered-text", () => {
  const html = renderToStaticMarkup(<Markdown source={"- [x] 1. Wave 0\n- [ ] 2. Wave 1"} />);
  expect(html).not.toContain("<ol");
  expect(html).toContain("1. Wave 0");
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
});

test("markdown-image-text-fallback", () => {
  const src = "Voir ![Board](/w/nightshift-screenshots/01.png) ici";
  const html = renderToStaticMarkup(<Markdown source={src} />);
  expect(html).toContain("![Board](/w/nightshift-screenshots/01.png)");
  expect(html).not.toContain("<img");
  expect(toPlainText(src)).toBe("Voir ![Board](/w/nightshift-screenshots/01.png) ici");
  const nulled = renderToStaticMarkup(<Markdown source={src} renderImage={() => null} />);
  expect(nulled).toBe(html);
});

test("markdown-image-render-hook", () => {
  const src = "- ![A](/w/nightshift-screenshots/a.png) puis ![B](https://x/b.png)\n\n> ![A](/w/nightshift-screenshots/a.png)";
  const html = renderToStaticMarkup(
    <Markdown source={src} renderImage={(alt, dest) => (dest.startsWith("/") ? <b data-m={alt}>M</b> : null)} />,
  );
  expect(html).toContain('<b data-m="A">M</b>');
  expect(html).not.toContain("![A]");
  expect(html).toContain("![B](https://x/b.png)");
  expect(html.match(/<b data-m/g)?.length).toBe(2);
});

test("markdown-image-figure-not-in-paragraph", () => {
  const html = renderToStaticMarkup(
    <Markdown source={"![A](/w/nightshift-screenshots/01.png)"} renderImage={() => <figure>F</figure>} />,
  );
  expect(html).not.toContain("<p><figure>");
  expect(html).toContain("<figure>F</figure>");
  expect(renderToStaticMarkup(<Markdown source={"![A](https://x/a.png)"} renderImage={() => null} />)).toContain("<p>");
});
