import { expect, test } from "bun:test";
import type { Column } from "../src/shared/types.ts";
import { nextColumn } from "../src/web/nextColumn.ts";

const cols: Column[] = [
  { id: "backlog", name: "Backlog", type: "inert" },
  { id: "grill", name: "Grill", type: "inert" },
  { id: "totest", name: "To Test", type: "inert" },
  { id: "merged", name: "Merged", type: "inert" },
  { id: "done", name: "Done", type: "inert" },
];

test("next-column-middle", () => {
  expect(nextColumn(cols, "backlog")?.name).toBe("Grill");
  expect(nextColumn(cols, "totest")?.name).toBe("Merged");
});

test("next-column-last", () => {
  expect(nextColumn(cols, "done")).toBeUndefined();
});

test("next-column-unknown", () => {
  expect(nextColumn(cols, "nope")).toBeUndefined();
});
