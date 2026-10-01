import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "../src/shared/types.ts";
import { TestPanel } from "../src/web/TestPanel.tsx";

const render = (url: string) =>
  renderToStaticMarkup(
    <TestPanel
      project="/p"
      card={{ id: "card_a", description: "", test: { command: "bun dev", url } } as unknown as Card}
      running={false}
      onError={() => {}}
    />,
  );

test("test-url-render: javascript: url is never rendered as a link", () => {
  const html = render("javascript:alert(1)");
  expect(html).toContain("bun dev");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("<a ");
});

test("test-url-render: http url is still a link", () => {
  expect(render("http://localhost:3000")).toContain('<a href="http://localhost:3000"');
});
