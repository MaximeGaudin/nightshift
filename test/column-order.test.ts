import { expect, test } from "bun:test";
import { reorderColumns } from "../src/web/columnOrder.ts";

const A = { id: "a", key: "a", name: "A", type: "inert" as const };
const B = { id: "b", key: "b", name: "B", type: "inert" as const };
const Done = { id: "col_done", key: "col_done", name: "Done", type: "inert" as const };
const names = (cols: { key: string }[]) => cols.map((c) => c.key);

test("column-order-done-locked", () => {
  const cols = [A, B, Done];
  expect(names(reorderColumns(cols, "col_done", "a"))).toEqual(["a", "b", "col_done"]);
  expect(names(reorderColumns(cols, "a", "col_done"))).toEqual(["b", "a", "col_done"]);
  expect(names(reorderColumns(cols, "b", "a"))).toEqual(["b", "a", "col_done"]);
  expect(reorderColumns(cols, "a", "a")).toBe(cols);
  expect(reorderColumns(cols, "x", "a")).toBe(cols);
});

const Backlog = { id: "col_backlog", key: "col_backlog", name: "Backlog", type: "inert" as const };

test("column-order-backlog-pinned", () => {
  const cols = [Backlog, A, B, Done];
  expect(names(reorderColumns(cols, "a", "col_backlog"))).toEqual(["col_backlog", "a", "b", "col_done"]);
  expect(names(reorderColumns(cols, "b", "col_backlog"))).toEqual(["col_backlog", "b", "a", "col_done"]);
  expect(reorderColumns(cols, "col_backlog", "b")).toBe(cols);
  expect(reorderColumns(cols, "col_backlog", "col_done")).toBe(cols);
  expect(names(reorderColumns(cols, "a", "col_done"))).toEqual(["col_backlog", "b", "a", "col_done"]);
});
