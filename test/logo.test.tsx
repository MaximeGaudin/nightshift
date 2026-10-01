import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { Logo } from "../src/web/Logo.tsx";

const svg = readFileSync(new URL("../docs/logo/logo.svg", import.meta.url), "utf8");
const tags = (markup: string) => [...markup.matchAll(/<\/?\s*([a-zA-Z][\w:-]*)/g)].map((m) => m[1]);
const pairs = (markup: string) =>
  [...markup.matchAll(/<path\b([^>]*)>/g)].map((m) => {
    const attrs = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    return { d: attrs.d, fill: attrs.fill };
  });

test("logo-svg-format", () => {
  expect(svg).toContain('viewBox="0 0 16 16"');
  expect(tags(svg).filter((t) => t !== "svg" && t !== "path")).toEqual([]);
  const fills = new Set<string>();
  for (const m of svg.matchAll(/<path\b([^>]*)>/g)) {
    const attrs = [...m[1].matchAll(/([\w-]+)=/g)].map((a) => a[1]);
    for (const a of attrs) expect(["d", "fill", "fill-rule"]).toContain(a);
    const fill = /fill="([^"]*)"/.exec(m[1])?.[1] ?? "";
    expect(["#5e6ad2", "#7f89e0"]).toContain(fill);
    fills.add(fill);
  }
  expect([...fills].sort()).toEqual(["#5e6ad2", "#7f89e0"]);
});

test("logo-component-render", () => {
  const html = renderToStaticMarkup(<Logo size={18} />);
  expect(html).toContain('width="18"');
  expect(html).toContain('height="18"');
  expect(html).toContain('viewBox="0 0 16 16"');
  expect(html).toContain('aria-hidden="true"');
  const got = pairs(html);
  expect(got.length).toBeGreaterThan(0);
  expect(got).toEqual(pairs(svg));
});
