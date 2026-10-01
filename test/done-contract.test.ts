import { expect, test } from "bun:test";
import { type Column, doneColumn, ensureDoneColumn } from "../src/shared/types.ts";

const a: Column = { id: "a", name: "A", type: "inert" };
const b: Column = { id: "b", name: "B", type: "skill", skill: "x" };

test("adds Done when missing", () => {
  expect(ensureDoneColumn([a, b])).toEqual([a, b, doneColumn()]);
});

test("moves Done from the middle to the end", () => {
  expect(ensureDoneColumn([a, doneColumn(), b])).toEqual([a, b, doneColumn()]);
});

test("repairs a malformed Done and keeps extra fields", () => {
  const bad = { id: "col_done", type: "skill", skill: "s", model: "m", maxParallel: 3, name: "Fini", extra: 1 } as Column;
  expect(ensureDoneColumn([bad, a])).toEqual([a, { id: "col_done", name: "Done", type: "inert", extra: 1 } as Column]);
});

test("collapses duplicates into one last", () => {
  const r = ensureDoneColumn([doneColumn(), a, doneColumn()]);
  expect(r).toEqual([a, doneColumn()]);
});

test("idempotent and does not mutate input", () => {
  const input = [{ id: "col_done", type: "skill", skill: "s", name: "Fini" } as Column, a];
  const snap = structuredClone(input);
  const first = ensureDoneColumn(input);
  expect(input).toEqual(snap);
  expect(ensureDoneColumn(first)).toEqual(first);
});

test("done-keeps-emoji", () => {
  const withEmoji = ensureDoneColumn([a, { ...doneColumn(), emoji: "🏁", skill: "s" } as Column]);
  expect(withEmoji[1]).toEqual({ id: "col_done", name: "Done", type: "inert", emoji: "🏁" });
  expect("emoji" in ensureDoneColumn([a])[1]).toBe(false);
});
