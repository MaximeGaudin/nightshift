import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const web = new URL("../src/web/", import.meta.url).pathname;

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });

test("legacy-css-removed", () => {
  expect(existsSync(join(web, "styles.css"))).toBe(false);
  expect(readdirSync(join(web, "styles")).sort()).toEqual(["markdown.css"]);

  const html = readFileSync(join(web, "index.html"), "utf8");
  expect([...html.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1])).toEqual(["./index.css"]);

  const css = readFileSync(join(web, "index.css"), "utf8");
  expect(css).not.toContain("styles.css");
  expect(css).not.toMatch(/legacy/);
  expect(css.match(/markdown\.css/g)?.length).toBe(1);

  for (const file of sources(web)) {
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(/\b(Modal|ErrorBanner)\b\s*[,}]|import[^;]*\b(Modal|ErrorBanner)\b/);
    expect(src).not.toMatch(/<Icon\b/);
    expect(src).not.toMatch(/from "\.\/ui\.tsx"[^;]*\b(Modal|ErrorBanner)\b/);
  }
});
