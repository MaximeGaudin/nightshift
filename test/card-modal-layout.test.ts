import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/web/styles/card-modal.css", import.meta.url), "utf8");
const rule = (selector: string): string => {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[1]!;
};

test("card-modal-layout-css-contract", () => {
  const side = rule(".card-side");
  expect(side).toContain("overflow-y: auto");
  expect(side).toContain("min-height: 0");
  const log = rule(".log");
  expect(log).toContain("min-height: 320px");
  expect(log).toContain("flex: 1 0 320px");
  const out = rule(".test-output");
  expect(out).toContain("min-height: 0");
  expect(out).toContain("flex: none");
  const shots = rule(".test-shots");
  expect(shots).toContain("max-height");
  expect(shots).toContain("overflow: auto");
});

const mdCss = readFileSync(new URL("../src/web/styles/markdown.css", import.meta.url), "utf8");
const mdRule = (selector: string): string => {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  const blocks = [...mdCss.matchAll(re)].map((m) => m[1]!);
  if (!blocks.length) throw new Error(`rule not found: ${selector}`);
  return blocks.join(" ");
};
const mobileBlock = (): string => {
  const m = css.match(/@media \(max-width: 800px\)\s*\{([\s\S]*?\n)\}/);
  if (!m) throw new Error("media query not found");
  return m[1]!;
};

test("card-modal-grid-tracks-shrink", () => {
  expect(rule(".card-modal")).toContain("grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr)");
});

test("card-modal-mobile-track-shrinks", () => {
  expect(mobileBlock()).toContain(".card-modal { grid-template-columns: minmax(0, 1fr); }");
});

test("card-modal-children-min-width", () => {
  for (const sel of [".card-modal", ".card-edit", ".card-side", ".card-desc", ".last-run", ".question"]) {
    expect(rule(sel)).toContain("min-width: 0");
  }
  const side = rule(".card-side");
  expect(side).toContain("overflow-y: auto");
  expect(side).not.toContain("overflow-x: hidden");
});

test("markdown-wide-blocks-scroll", () => {
  const table = mdRule(".md .md-table");
  expect(table).toContain("overflow-x: auto");
  expect(table).toContain("max-width: 100%");
  expect(mdRule(".md pre")).toContain("overflow-x: auto");
  expect(mdRule(".md")).toContain("overflow-wrap: anywhere");
});
