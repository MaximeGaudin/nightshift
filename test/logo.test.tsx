import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { Logo } from "../src/web/Logo.tsx";

const read = (n: number) => readFileSync(new URL(`../docs/logo/variant-${n}.svg`, import.meta.url), "utf8");
const tags = (svg: string) => [...svg.matchAll(/<\/?\s*([a-zA-Z][\w:-]*)/g)].map((m) => m[1]);
const pairs = (markup: string) =>
  [...markup.matchAll(/<path\b([^>]*)>/g)].map((m) => {
    const attrs = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    return { d: attrs.d, fill: attrs.fill };
  });

test("logo-variant-format", () => {
  const dLists: string[] = [];
  for (const n of [1, 2, 3]) {
    const svg = read(n);
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(tags(svg).filter((t) => t !== "svg" && t !== "path")).toEqual([]);
    const fills = new Set<string>();
    const ds: string[] = [];
    for (const m of svg.matchAll(/<path\b([^>]*)>/g)) {
      const attrs = [...m[1].matchAll(/([\w-]+)=/g)].map((a) => a[1]);
      for (const a of attrs) expect(["d", "fill", "fill-rule"]).toContain(a);
      const fill = /fill="([^"]*)"/.exec(m[1])?.[1] ?? "";
      expect(["#5e6ad2", "#7f89e0"]).toContain(fill);
      fills.add(fill);
      ds.push(/ d="([^"]*)"/.exec(m[1])?.[1] ?? "");
    }
    expect([...fills].sort()).toEqual(["#5e6ad2", "#7f89e0"]);
    dLists.push(ds.join("|"));
  }
  expect(new Set(dLists).size).toBe(3);
});

test("logo-component-render", () => {
  const html = renderToStaticMarkup(<Logo size={18} />);
  expect(html).toContain('width="18"');
  expect(html).toContain('height="18"');
  expect(html).toContain('viewBox="0 0 16 16"');
  expect(html).toContain('aria-hidden="true"');
  const got = pairs(html);
  expect(got.length).toBeGreaterThan(0);
  const matches = [1, 2, 3].some((n) => JSON.stringify(pairs(read(n))) === JSON.stringify(got));
  expect(matches).toBe(true);
});
