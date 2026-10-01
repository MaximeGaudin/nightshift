import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeBoard } from "../src/server/store.ts";
import { normalizeSkipColumnIds, resolveNextColumn, skippedColumns } from "../src/shared/skip.ts";
import { type Column, DONE_COLUMN_ID } from "../src/shared/types.ts";
import { SkipColumnsPicker } from "../src/web/SkipColumnsPicker.tsx";
import { must } from "./helpers.ts";

const names = ["Backlog", "Grill", "Plan", "Implement", "Review", "To Test", "Merge"];
const cols: Column[] = [
  ...names.map((name, i): Column => ({ id: `col_${i}`, name, type: "inert" })),
  { id: DONE_COLUMN_ID, name: "Done", type: "inert" },
];
const id = (name: string) => must(cols.find((c) => c.name === name)).id;

test("resolve without skip: each column goes to its neighbor, Done to nothing", () => {
  cols.slice(0, -1).forEach((c, i) => {
    expect(resolveNextColumn(cols, { columnId: c.id })?.id).toBe(must(cols[i + 1]).id);
  });
  expect(resolveNextColumn(cols, { columnId: DONE_COLUMN_ID })).toBeUndefined();
});

test("resolve chains consecutive skips down to Done", () => {
  const card = { columnId: id("Review"), skipColumnIds: [id("To Test"), id("Merge")] };
  expect(resolveNextColumn(cols, card)?.id).toBe(DONE_COLUMN_ID);
});

test("resolve ignores Done and unknown ids", () => {
  const skip = [DONE_COLUMN_ID, "col_gone"];
  expect(resolveNextColumn(cols, { columnId: id("Merge"), skipColumnIds: skip })?.id).toBe(DONE_COLUMN_ID);
  expect(resolveNextColumn(cols, { columnId: id("Review"), skipColumnIds: skip })?.id).toBe(id("To Test"));
});

test("skippedColumns lists existing non-Done skipped columns in board order", () => {
  const card = { skipColumnIds: [id("Merge"), "col_gone", DONE_COLUMN_ID, id("Plan")] };
  expect(skippedColumns(cols, card).map((c) => c.name)).toEqual(["Plan", "Merge"]);
  expect(skippedColumns(cols, {})).toEqual([]);
});

test("normalize: canonical order, unique, no Done, no unknown, no junk", () => {
  const c: Column[] = [
    { id: "a", name: "A", type: "inert" },
    { id: "b", name: "B", type: "inert" },
    { id: DONE_COLUMN_ID, name: "Done", type: "inert" },
  ];
  expect(normalizeSkipColumnIds(c, [DONE_COLUMN_ID, "b", "x", "a", "b", 3])).toEqual(["a", "b"]);
  expect(normalizeSkipColumnIds(c, [])).toBeUndefined();
  expect(normalizeSkipColumnIds(c, ["x", DONE_COLUMN_ID])).toBeUndefined();
  expect(normalizeSkipColumnIds(c, "a")).toBeUndefined();
});

test("normalizeBoard: old card has no skip key; stored value is canonicalized; empty drops the key", () => {
  const card = (extra: object) => ({ id: "card_1", title: "t", columnId: "col_a", ...extra });
  const raw = {
    columns: [
      { id: "col_a", name: "A", type: "inert" },
      { id: "col_b", name: "B", type: "inert" },
      { id: "col_c", name: "C", type: "inert" },
    ],
    cards: [card({}), card({ id: "card_2", skipColumnIds: ["col_c", "col_b", "nope"] }), card({ id: "card_3", skipColumnIds: [] })],
  };
  const [old, withSkip, empty] = normalizeBoard(raw, "p").cards;
  expect("skipColumnIds" in must(old)).toBe(false);
  expect(withSkip?.skipColumnIds).toEqual(["col_b", "col_c"]);
  expect("skipColumnIds" in must(empty)).toBe(false);
});

test("SkipColumnsPicker: collapsed, counts checked, emits ids in column order, null when empty", () => {
  const html = renderToStaticMarkup(
    createElement(SkipColumnsPicker, { columns: cols.slice(1, 4), value: [id("Plan")], onChange: () => {} }),
  );
  expect(html).toContain("<details");
  expect(html).not.toContain("open");
  expect(html).toContain("Sauter des colonnes (1)");
  expect(html.match(/type="checkbox"/g)?.length).toBe(3);
  expect(renderToStaticMarkup(createElement(SkipColumnsPicker, { columns: [], value: [], onChange: () => {} }))).toBe("");
  expect(renderToStaticMarkup(createElement(SkipColumnsPicker, { columns: cols.slice(1, 3), value: [], onChange: () => {} }))).toContain(
    ">Sauter des colonnes<",
  );
});
