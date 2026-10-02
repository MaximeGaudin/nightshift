import { expect, test } from "bun:test";
import {
  dependencyCycle,
  describeCycle,
  isHeld,
  isReady,
  releaseReason,
  releaseTarget,
  resolveDependencyRefs,
  unmetDependencies,
  wouldCreateCycle,
} from "../src/shared/dependencies.ts";
import { fastForwardCandidates } from "../src/shared/flow.ts";
import { BACKLOG_COLUMN_ID, type Board, type Card, type Column, DONE_COLUMN_ID } from "../src/shared/types.ts";

const columns: Column[] = [
  { id: BACKLOG_COLUMN_ID, name: "Backlog", type: "inert" },
  { id: "col_grill", name: "Grill", type: "skill", skill: "nightshift-grill" },
  { id: "col_plan", name: "Plan", type: "skill", skill: "nightshift-plan" },
  { id: DONE_COLUMN_ID, name: "Done", type: "inert" },
];
const T0 = "2026-01-01T00:00:00.000Z";
const card = (id: string, number: number, over: Partial<Card> = {}): Card => ({
  id,
  number,
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

test("resolveDependencyRefs accepts refs, numbers and ids, deduplicated in input order", () => {
  const b = board([card("card_a", 12), card("card_b", 15), card("card_x", 3)]);
  expect(resolveDependencyRefs(b, ["#12", 15, "card_x", "#12", "15"])).toEqual(["card_a", "card_b", "card_x"]);
  expect(resolveDependencyRefs(b, [])).toEqual([]);
  expect(() => resolveDependencyRefs(b, ["#99"])).toThrow("Unknown card in dependsOn: #99");
  expect(() => resolveDependencyRefs(b, ["card_zz"])).toThrow("Unknown card");
  expect(() => resolveDependencyRefs(b, [1.5])).toThrow("Unknown card");
  expect(() => resolveDependencyRefs(b, ["#12"], "card_a")).toThrow("A card cannot depend on itself");
  expect(() => resolveDependencyRefs(b, "#12")).toThrow("dependsOn must be an array");
});

test("wouldCreateCycle detects indirect cycles and terminates on existing ones", () => {
  const a = card("A", 1, { dependsOn: ["B"] });
  const b = card("B", 2, { dependsOn: ["C"] });
  const c = card("C", 3);
  expect(wouldCreateCycle(board([a, b, c]), "C", ["A"])).toBe(true);
  expect(describeCycle(board([a, b, c]), dependencyCycle(board([a, b, c]), "C", ["A"]) ?? [])).toBe("Dependency cycle: #3 → #1 → #2 → #3");
  expect(wouldCreateCycle(board([a, b, c]), "A", ["C"])).toBe(false);
  const loop = board([card("A", 1), card("B", 2, { dependsOn: ["C"] }), card("C", 3, { dependsOn: ["B"] })]);
  expect(wouldCreateCycle(loop, "A", ["B"])).toBe(false);
  expect(wouldCreateCycle(loop, "B", ["C"])).toBe(true);
});

test("unmet, held and ready follow Backlog and Done", () => {
  const d1 = card("d1", 12, { columnId: DONE_COLUMN_ID });
  const d2 = card("d2", 15, { columnId: "col_grill" });
  const x = card("x", 20, { dependsOn: ["d1", "d2"] });
  const b = board([d1, d2, x]);
  expect(unmetDependencies(b, x).map((c) => c.id)).toEqual(["d2"]);
  expect(isHeld(x)).toBe(true);
  expect(isReady(b, x)).toBe(false);
  d2.columnId = DONE_COLUMN_ID;
  expect(isReady(b, x)).toBe(true);
  expect(isHeld({ ...x, columnId: "col_plan" })).toBe(false);
  expect(isHeld({ ...x, dependsOn: undefined })).toBe(false);
  expect(releaseReason(b, x)).toBe("Dependencies done (#12, #15)");
  expect(releaseReason(b, {})).toBe("Dependencies cleared");
});

test("releaseTarget is the first column after Backlog the card does not skip", () => {
  expect(releaseTarget(columns, {})?.id).toBe("col_grill");
  expect(releaseTarget(columns, { skipColumnIds: ["col_grill"] })?.id).toBe("col_plan");
  expect(releaseTarget(columns, { skipColumnIds: ["col_grill", "col_plan"] })?.id).toBe(DONE_COLUMN_ID);
});

test("fastForwardCandidates skips cards held by their dependencies", () => {
  const held = card("h", 1, { dependsOn: ["d"] });
  const free = card("f", 2);
  const dep = card("d", 3, { columnId: "col_grill" });
  expect(fastForwardCandidates(board([held, free, dep])).map((c) => c.id)).toEqual(["f"]);
  expect(fastForwardCandidates(board([held, dep]))).toEqual([]);
});
