import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { STRIP_COLUMN, WIDE_COLUMN } from "../src/web/compactColumn.tsx";

const board = readFileSync(new URL("../src/web/Board.tsx", import.meta.url), "utf8");

test("board-layout-contract", () => {
  for (const cls of ["flex-[1_0_290px]", "min-w-[290px]", "max-w-[560px]"]) expect(WIDE_COLUMN).toContain(cls);
  // Strips (compact and collapsed Done) opt out of the wide rules.
  expect(STRIP_COLUMN).toContain("max-w-none");
  expect(STRIP_COLUMN).toContain("min-w-0");
  expect(STRIP_COLUMN).not.toContain("290");
  // Columns are centred when they do not fill the board, without justify-content: center (it would clip the overflow).
  const boardClass = board.match(/className="board [^"]*"/)?.[0] ?? "";
  expect(boardClass).toContain("[&>:first-child]:ml-auto");
  expect(boardClass).toContain("[&>:last-child]:mr-auto");
  expect(boardClass).not.toContain("justify-center");
});
