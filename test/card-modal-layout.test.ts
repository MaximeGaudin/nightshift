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
