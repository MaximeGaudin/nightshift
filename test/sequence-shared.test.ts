import { expect, test } from "bun:test";
import { autoMergeSkipIds, sequenceColumns, sequenceFailure, sequenceLabel } from "../src/shared/sequence.ts";
import { type Board, type Card, type Column, DONE_COLUMN_ID, type LastRun } from "../src/shared/types.ts";

const col = (id: string, name: string, type: Column["type"] = "inert", skill?: string): Column => ({
  id,
  name,
  type,
  ...(skill ? { skill } : {}),
});
const columns: Column[] = [
  col("col_backlog", "Backlog"),
  col("col_grill", "Grill", "skill", "nightshift-grill"),
  col("col_review", "Review", "skill", "nightshift-review"),
  col("col_totest", "To Test"),
  col("col_merge", "Merge", "skill", "nightshift-merge"),
  col(DONE_COLUMN_ID, "Done"),
];
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const card = (over: Partial<Card> = {}): Card => ({
  id: "c1",
  number: 23,
  title: "t",
  description: "",
  columnId: "col_merge",
  createdAt: T0,
  updatedAt: T0,
  enteredColumnAt: T0,
  history: [],
  ...over,
});
const board = (cards: Card[] = []): Board => ({ version: 1, name: "b", columns, cards, nextCardNumber: 99 });
const run = (over: Partial<LastRun> = {}): LastRun => ({ columnId: "col_merge", status: "success", at: T1, ...over });

test("seq-shared-columns", () => {
  expect(sequenceColumns(columns)).toEqual({ source: columns[0], entry: columns[1] });
  expect(sequenceColumns([col(DONE_COLUMN_ID, "Done")])).toBeUndefined();
});

test("seq-shared-skip", () => {
  const cols = [
    col("col_backlog", "Backlog"),
    columns[1] as Column,
    columns[2] as Column,
    columns[3] as Column,
    columns[4] as Column,
    columns[5] as Column,
  ];
  expect(autoMergeSkipIds(cols, { skipColumnIds: ["col_review"] })).toEqual(["col_review", "col_totest"]);
});

test("seq-shared-failure", () => {
  const b = board();
  expect(sequenceFailure(b, card({ lastRun: run({ status: "error", error: "x" }) }), true)).toBeUndefined();
  expect(
    sequenceFailure(b, card({ lastRun: run({ status: "error" }), pendingAnswer: { text: "a", sessionId: "s", at: T1 } }), false),
  ).toBeUndefined();
  expect(sequenceFailure(b, card({ lastRun: run({ status: "error", columnId: "col_review" }) }), false)).toBeUndefined();
  expect(sequenceFailure(b, card({ enteredColumnAt: T1, lastRun: run({ status: "error", at: T0 }) }), false)).toBeUndefined();
  expect(sequenceFailure(b, card({ lastRun: run({ status: "question" }) }), false)).toBeUndefined();
  expect(
    sequenceFailure(b, card({ columnId: "col_totest", lastRun: run({ columnId: "col_totest", status: "success" }) }), false),
  ).toBeUndefined();
  expect(sequenceFailure(b, card({ lastRun: run({ status: "error", error: "boom".repeat(100) }) }), false)).toBe(
    `en erreur : ${"boom".repeat(100).slice(0, 120)}`,
  );
  expect(sequenceFailure(b, card({ lastRun: run({ status: "cancelled" }) }), false)).toBe("run annulé");
  expect(sequenceFailure(b, card({ lastRun: run() }), false)).toBe("l'agent a gardé la carte dans Merge");
});

test("seq-shared-label", () => {
  const b = board([card()]);
  expect(sequenceLabel({ status: "stopped" }, b)).toBe("Mode séquentiel : arrêté");
  expect(sequenceLabel({ status: "active", cardId: "c1" }, b)).toBe("Mode séquentiel : actif — #23");
  expect(sequenceLabel({ status: "paused", cardId: "c1" }, b)).toBe("Mode séquentiel : en pause — #23 (la suivante ne partira pas)");
});
