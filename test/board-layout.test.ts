import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/web/styles/board.css", import.meta.url), "utf8");
const rule = (selector: string): string => {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[1];
};

test("board-layout-css-contract", () => {
  const column = rule(".column");
  expect(column).toContain("flex: 1 0 290px");
  expect(column).toContain("min-width: 290px");
  expect(column).toContain("max-width: 560px");
  for (const strip of [".column.compact", ".column.done-collapsed"]) {
    expect(rule(strip)).toContain("max-width: none");
    expect(rule(strip)).toContain("min-width: 0");
  }
  expect(rule(".board > :first-child")).toContain("margin-left: auto");
  expect(rule(".board > :last-child")).toContain("margin-right: auto");
  expect(rule(".board")).not.toContain("justify-content: center");
});
