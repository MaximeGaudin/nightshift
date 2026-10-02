import { expect, test } from "bun:test";
import { fastForwardCandidates, fastForwardSkipIds, fastForwardTarget } from "../src/shared/flow.ts";
import { BACKLOG_COLUMN_ID, type Board, type Card, type Column, DONE_COLUMN_ID } from "../src/shared/types.ts";

const columns: Column[] = [
  { id: BACKLOG_COLUMN_ID, name: "Backlog", type: "inert" },
  { id: "col_grill", name: "Grill", type: "skill", skill: "nightshift-grill" },
  { id: "col_impl", name: "Implement", type: "skill", skill: "nightshift-implement" },
  { id: "col_totest", name: "To Test", type: "inert" },
  { id: "col_merge", name: "Merge", type: "skill", skill: "nightshift-merge" },
  { id: DONE_COLUMN_ID, name: "Done", type: "inert" },
];
const T0 = "2026-01-01T00:00:00.000Z";
const card = (id: string, over: Partial<Card> = {}): Card => ({
  id,
  number: 1,
  title: id,
  description: "",
  columnId: BACKLOG_COLUMN_ID,
  createdAt: T0,
  updatedAt: T0,
  enteredColumnAt: T0,
  history: [],
  ...over,
});
const board = (cards: Card[]): Board => ({ version: 1, name: "b", columns, cards, nextCardNumber: 99 });

test("fast forward candidates skip held cards", () => {
  const dep = card("d", { columnId: "col_grill" });
  const cards = [card("a"), card("h", { dependsOn: ["d"] }), dep, card("b")];
  expect(fastForwardCandidates(board(cards)).map((c) => c.id)).toEqual(["a", "b"]);
});

test("fast forward target follows skips", () => {
  const skips = fastForwardSkipIds(columns, { skipColumnIds: ["col_grill"] });
  expect(skips).toContain("col_totest");
  expect(skips).toContain("col_grill");
  expect(skips).not.toContain(DONE_COLUMN_ID);
  expect(skips).not.toContain(BACKLOG_COLUMN_ID);
  expect(fastForwardTarget(columns, skips)?.id).toBe("col_impl");
  expect(fastForwardTarget(columns, fastForwardSkipIds(columns, {}))?.id).toBe("col_grill");
  expect(fastForwardTarget(columns, ["col_grill", "col_impl", "col_totest", "col_merge"])?.id).toBe(DONE_COLUMN_ID);
});
