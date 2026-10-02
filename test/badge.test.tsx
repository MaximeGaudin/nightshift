import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge } from "../src/web/components/ui/badge.tsx";

test("badge: pill with a colored dot", () => {
  const html = renderToStaticMarkup(<Badge dot="ok">x</Badge>);
  expect(html).toContain("rounded-full");
  expect(html).toMatch(/data-slot="badge-dot"[^>]*bg-ok/);
  expect(html).not.toContain("font-mono");
});

test("badge: no dot without the prop", () => {
  const html = renderToStaticMarkup(<Badge>x</Badge>);
  expect(html).toContain("rounded-full");
  expect(html).not.toContain("badge-dot");
});
