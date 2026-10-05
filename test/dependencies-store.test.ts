import { afterAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeBoard, Project } from "../src/server/store.ts";
import { BACKLOG_COLUMN_ID, DONE_COLUMN_ID } from "../src/shared/types.ts";
import { must, removeTempDirs, tempDir } from "./helpers.ts";

afterAll(removeTempDirs);

const T0 = "2026-01-01T00:00:00.000Z";
const columns = [
  { id: BACKLOG_COLUMN_ID, name: "Backlog", type: "inert" },
  { id: "col_grill", name: "Grill", type: "skill", skill: "nightshift-grill" },
  { id: "col_plan", name: "Plan", type: "skill", skill: "nightshift-plan" },
  { id: DONE_COLUMN_ID, name: "Done", type: "inert" },
];
const card = (id: string, number: number, extra: object = {}) => ({
  id,
  number,
  title: id,
  description: "",
  columnId: BACKLOG_COLUMN_ID,
  createdAt: T0,
  updatedAt: T0,
  enteredColumnAt: T0,
  history: [],
  ...extra,
});

test("normalizeBoard cleans dependsOn: unknown ids, self, duplicates, junk and [] dropped", () => {
  const b = normalizeBoard(
    {
      version: 1,
      name: "t",
      columns,
      cards: [
        card("a", 1, { dependsOn: ["b", "gone", "a", "b", 7, "c"] }),
        card("b", 2, { dependsOn: [] }),
        card("c", 3, { dependsOn: "b" }),
        card("d", 4, { dependsOn: ["a"] }),
      ],
      nextCardNumber: 5,
    },
    "t",
  );
  expect(b.cards.map((c) => c.dependsOn)).toEqual([["b", "c"], undefined, undefined, ["a"]]);
  expect(b.cards.map((c) => "dependsOn" in c)).toEqual([true, false, false, true]);
});

test("dependsOn survives a read/write round trip", () => {
  const dir = tempDir("ns-deps-");
  const file = join(dir, "nightshift.json");
  writeFileSync(
    file,
    JSON.stringify({ version: 1, name: "t", columns, cards: [card("a", 1, { dependsOn: ["b"] }), card("b", 2)], nextCardNumber: 3 }),
  );
  const p = new Project(dir);
  p.mutate((board) => {
    must(board.cards[1]).title = "edited";
  });
  p.close();
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.cards[0].dependsOn).toEqual(["b"]);
  expect(new Project(dir).card("a")?.dependsOn).toEqual(["b"]);
});

test("releaseDependencies drops dependsOn and follows the skips", () => {
  const dir = tempDir("ns-deps-");
  writeFileSync(
    join(dir, "nightshift.json"),
    JSON.stringify({
      version: 1,
      name: "t",
      columns,
      cards: [
        card("x", 20, { dependsOn: ["d1", "d2"], skipColumnIds: ["col_grill"] }),
        card("d1", 12, { columnId: DONE_COLUMN_ID }),
        card("d2", 15, { columnId: DONE_COLUMN_ID }),
      ],
      nextCardNumber: 21,
    }),
  );
  const p = new Project(dir);
  p.mutate((board) => p.releaseDependencies(board, must(p.card("x")), "Dependencies done (#12, #15)"));
  const x = must(p.card("x"));
  p.close();
  expect(x.columnId).toBe("col_plan");
  expect(x.dependsOn).toBeUndefined();
  expect(x.history.map((h) => [h.kind, h.text])).toEqual([
    ["moved", "Dependencies done (#12, #15): Backlog → Plan"],
    ["queued", "Queued in Plan"],
  ]);
});

test("draft: normalizeBoard keeps draft only on Backlog cards and never false", () => {
  const b = normalizeBoard(
    {
      version: 1,
      name: "t",
      columns,
      cards: [
        card("a", 1, { draft: true }),
        card("b", 2, { draft: true, columnId: "col_grill" }),
        card("c", 3, { draft: false }),
      ],
      nextCardNumber: 4,
    },
    "t",
  );
  expect(b.cards.map((c) => "draft" in c)).toEqual([true, false, false]);
  expect(b.cards[0]?.draft).toBe(true);
});

test("draft: moveCard out of Backlog removes draft", () => {
  const dir = tempDir("ns-draft-");
  writeFileSync(
    join(dir, "nightshift.json"),
    JSON.stringify({ version: 1, name: "t", columns, cards: [card("x", 1, { draft: true })], nextCardNumber: 2 }),
  );
  const p = new Project(dir);
  p.mutate((board) => p.moveCard(board, "x", "col_grill"));
  const x = must(p.card("x"));
  p.close();
  expect(x.columnId).toBe("col_grill");
  expect("draft" in x).toBe(false);
});
