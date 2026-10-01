import { expect, test } from "bun:test";
import { resolveNextColumn } from "../src/shared/skip.ts";
import type { Column } from "../src/shared/types.ts";

const cols: Column[] = [
  { id: "backlog", name: "Backlog", type: "inert" },
  { id: "grill", name: "Grill", type: "inert" },
  { id: "totest", name: "To Test", type: "inert" },
  { id: "merged", name: "Merged", type: "inert" },
  { id: "done", name: "Done", type: "inert" },
];

test("next-column-middle", () => {
  expect(resolveNextColumn(cols, { columnId: "backlog" })?.name).toBe("Grill");
  expect(resolveNextColumn(cols, { columnId: "totest" })?.name).toBe("Merged");
});

test("next-column-last", () => {
  expect(resolveNextColumn(cols, { columnId: "done" })).toBeUndefined();
});

test("next-column-unknown", () => {
  expect(resolveNextColumn(cols, { columnId: "nope" })).toBeUndefined();
});

test("next-column-skips", () => {
  expect(resolveNextColumn(cols, { columnId: "backlog", skipColumnIds: ["grill"] })?.name).toBe("To Test");
  expect(resolveNextColumn(cols, { columnId: "grill", skipColumnIds: ["totest", "merged"] })?.name).toBe("Done");
});
