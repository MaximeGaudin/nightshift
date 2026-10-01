import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

type Pair = { d: string; fill: string };

/** Extracts (d, fill) pairs from every <path> element, in order, whatever the quote style. */
function pathPairs(markup: string): Pair[] {
  const pairs: Pair[] = [];
  for (const [element] of markup.matchAll(/<path\b[^>]*>/g)) {
    const d = element.match(/\sd=(?:"([^"]*)"|'([^']*)')/);
    const fill = element.match(/\sfill=(?:"([^"]*)"|'([^']*)')/);
    if (d && fill) pairs.push({ d: d[1] ?? d[2] ?? "", fill: fill[1] ?? fill[2] ?? "" });
  }
  return pairs;
}

function faviconPairs(): Pair[] {
  const href = read("src/web/index.html").match(/<link rel="icon" href="data:image\/svg\+xml,([^"]*)"/);
  expect(href).not.toBeNull();
  return pathPairs(decodeURIComponent(href?.[1] ?? ""));
}

test("logo-sources-agree", () => {
  const component = pathPairs(read("src/web/Logo.tsx"));
  expect(component.length).toBeGreaterThan(0);
  expect(faviconPairs()).toEqual(component);

  const readme = read("README.md").match(/<img src="(docs\/logo\/variant-\d+\.svg)"/);
  expect(readme).not.toBeNull();
  const src = readme?.[1] ?? "";
  expect(existsSync(join(root, src))).toBe(true);
  expect(pathPairs(read(src))).toEqual(component);
});

test("logo-moon-removed", () => {
  for (const file of ["src/web/App.tsx", "src/web/ProjectPicker.tsx"]) {
    const source = read(file);
    const lucide = source.match(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/);
    const names = (lucide?.[1] ?? "").split(",").map((name) => name.trim().split(/\s+as\s+/)[0]);
    expect(names).not.toContain("Moon");
    expect(source).toMatch(/import\s*\{\s*Logo\s*\}\s*from\s*"\.\/Logo\.tsx"/);
  }
});
