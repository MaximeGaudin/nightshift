import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/web/index.css", import.meta.url)).text();

/** Body of the first block that starts with `opener` (balanced braces). */
function block(opener: string, from = 0): string {
  const start = css.indexOf(opener, from);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  throw new Error(`Unclosed block ${opener}`);
}

test("theme-tokens: primary is the indigo accent in both themes", () => {
  expect(block(":root {")).toMatch(/--primary:\s*#5e6ad2;/i);
  expect(block("@media (prefers-color-scheme: dark)")).toMatch(/--primary:\s*#5e6ad2;/i);
});

test("theme-tokens: dark media query redefines the surface tokens", () => {
  const dark = block("@media (prefers-color-scheme: dark)");
  for (const name of ["--background", "--foreground", "--card", "--border", "--ok", "--warn", "--err"]) {
    expect(dark).toContain(`${name}:`);
  }
  expect(css).not.toMatch(/\.dark\s*[{,]/);
});

test("theme-tokens: semantic colors exist and are exposed as utilities", () => {
  const root = block(":root {");
  for (const name of ["--ok", "--ok-soft", "--warn", "--warn-soft", "--err", "--err-soft"]) expect(root).toContain(`${name}:`);
  const theme = block("@theme inline");
  for (const name of ["ok", "ok-soft", "warn", "warn-soft", "err", "err-soft"]) expect(theme).toContain(`--color-${name}: var(--${name});`);
});

test("theme-tokens: reduced motion turns off animations and transitions", () => {
  const reduced = block("@media (prefers-reduced-motion: reduce)");
  expect(reduced).toMatch(/animation:\s*none/);
  expect(reduced).toMatch(/transition:\s*none/);
});
