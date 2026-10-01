import { expect, test } from "bun:test";
import type { Card, Column } from "../src/shared/types.ts";
import {
  applyDrop,
  cardsByColumn,
  hoverPosition,
  isColumnSection,
  localCards,
  localColumnOf,
  moveLocal,
  resolveDrop,
  sameLane,
  snapshotOrder,
  zoneAt,
} from "../src/web/boardDnd.ts";

const col = (id: string, type: Column["type"] = "inert"): Column => ({ id, name: id, type }) as Column;
const columns = [col("X"), col("Y"), col("Z"), col("col_done")];
const mk = (id: string, columnId: string) => ({ id, columnId, title: id }) as unknown as Card;
const cards = [mk("A", "X"), mk("B", "X"), mk("C", "X"), mk("D", "Y"), mk("E", "Y"), mk("F", "col_done")];
const onCard = (cardId: string) => ({ kind: "card" as const, cardId });
const onCol = (columnId: string) => ({ kind: "column" as const, columnId });

test("board-dnd-same-column-down", () => {
  expect(resolveDrop(columns, cards, "A", onCard("C"))).toEqual({ columnId: "X", index: 2 });
  expect(resolveDrop(columns, cards, "A", onCard("B"))).toEqual({ columnId: "X", index: 1 });
  expect(resolveDrop(columns, cards, "C", onCard("A"))).toEqual({ columnId: "X", index: 0 });
  expect(resolveDrop(columns, cards, "A", onCol("X"))).toEqual({ columnId: "X", index: 2 });
});

test("board-dnd-other-column", () => {
  expect(resolveDrop(columns, cards, "A", onCard("E"))).toEqual({ columnId: "Y", index: 1 });
  expect(resolveDrop(columns, cards, "A", onCard("D"))).toEqual({ columnId: "Y", index: 0 });
  expect(resolveDrop(columns, cards, "A", onCol("Y"))).toEqual({ columnId: "Y", index: 2 });
});

test("board-dnd-compact-and-done", () => {
  expect(resolveDrop(columns, cards, "A", onCol("Z"))).toEqual({ columnId: "Z", index: 0 });
  expect(resolveDrop(columns, cards, "A", onCol("col_done"))).toEqual({ columnId: "col_done" });
  expect(resolveDrop(columns, cards, "A", onCard("F"))).toEqual({ columnId: "col_done" });
  expect(resolveDrop(columns, cards, "F", onCol("col_done"))).toBeNull();
  expect(resolveDrop(columns, cards, "F", onCol("Y"))).toEqual({ columnId: "Y", index: 2 });
});

test("board-dnd-noop", () => {
  expect(resolveDrop(columns, cards, "A", onCard("A"))).toBeNull();
  expect(resolveDrop(columns, cards, "C", onCol("X"))).toBeNull();
  expect(resolveDrop(columns, cards, "ghost", onCol("X"))).toBeNull();
  expect(resolveDrop(columns, cards, "A", onCol("nowhere"))).toBeNull();
});

test("board-dnd-live-move-keeps-origin", () => {
  // A was live-moved into Y before E; dropping it there is a real move, dropping it below E too.
  let local = moveLocal(snapshotOrder(columns, cards), "A", "Y", "E");
  expect(localColumnOf(local, "A")).toBe("Y");
  let flat = localCards(columns, cards, local);
  const origin = { columnId: "X", index: 0 };
  expect(resolveDrop(columns, flat, "A", onCard("A"), origin)).toEqual({ columnId: "Y", index: 1 });
  expect(resolveDrop(columns, flat, "A", onCard("E"), origin)).toEqual({ columnId: "Y", index: 2 });
  expect(resolveDrop(columns, flat, "A", onCard("D"), origin)).toEqual({ columnId: "Y", index: 0 });
  // Back in its own column at its own place: nothing to do.
  local = snapshotOrder(columns, cards);
  flat = localCards(columns, cards, local);
  expect(resolveDrop(columns, flat, "A", onCard("A"), origin)).toBeNull();
});

test("board-dnd-local-order-merges-snapshots", () => {
  const local = moveLocal(snapshotOrder(columns, cards), "A", "Y");
  const fresh = [...cards.filter((c) => c.id !== "B"), mk("G", "X")];
  const grouped = cardsByColumn(columns, fresh, local);
  expect(grouped.X?.map((c) => c.id)).toEqual(["C", "G"]);
  expect(grouped.Y?.map((c) => c.id)).toEqual(["D", "E", "A"]);
  expect(cardsByColumn(columns, cards, null).X?.map((c) => c.id)).toEqual(["A", "B", "C"]);
});

test("board-dnd-stale-local-cards-follow-snapshot", () => {
  // A is dragged; meanwhile a snapshot moves D (another card) from Y to Z.
  const local = moveLocal(snapshotOrder(columns, cards), "A", "Y", "E");
  const fresh = cards.map((c) => (c.id === "D" ? mk("D", "Z") : c));
  const grouped = cardsByColumn(columns, fresh, local, "A");
  expect(grouped.Y?.map((c) => c.id)).toEqual(["A", "E"]);
  expect(grouped.Z?.map((c) => c.id)).toEqual(["D"]);
  expect(resolveDrop(columns, localCards(columns, fresh, local, "A"), "A", onCard("E"), { columnId: "X", index: 0 })).toEqual({
    columnId: "Y",
    index: 1,
  });
});

test("board-dnd-apply-drop", () => {
  const order = snapshotOrder(columns, cards);
  expect(applyDrop(order, "A", { columnId: "X", index: 2 }).X).toEqual(["B", "C", "A"]);
  expect(applyDrop(order, "C", { columnId: "X", index: 0 }).X).toEqual(["C", "A", "B"]);
  const cross = applyDrop(order, "A", { columnId: "Y", index: 1 });
  expect(cross.X).toEqual(["B", "C"]);
  expect(cross.Y).toEqual(["D", "A", "E"]);
  expect(applyDrop(order, "A", { columnId: "col_done" }).col_done).toEqual(["F", "A"]);
  expect(applyDrop(order, "A", { columnId: "Z", index: 0 }).Z).toEqual(["A"]);
});

test("board-dnd-hover-position-follows-local-order", () => {
  // A was live-moved into Y before E: hovering it or E announces Y, not its origin column X.
  const shown = cardsByColumn(columns, cards, moveLocal(snapshotOrder(columns, cards), "A", "Y", "E"), "A");
  expect(hoverPosition(shown, "A", onCard("A"))).toEqual({ columnId: "Y", position: 2 });
  expect(hoverPosition(shown, "A", onCard("E"))).toEqual({ columnId: "Y", position: 3 });
  expect(hoverPosition(shown, "A", onCol("Y"))).toEqual({ columnId: "Y", position: 3 });
  expect(hoverPosition(shown, "A", onCol("Z"))).toEqual({ columnId: "Z", position: 1 });
  expect(hoverPosition(shown, "A", onCard("ghost"))).toBeNull();
});

test("board-dnd-keyboard-skips-column-sections", () => {
  expect(isColumnSection("column")).toBe(true);
  expect(isColumnSection("card")).toBe(false);
  expect(isColumnSection("column-empty")).toBe(false);
  expect(isColumnSection(undefined)).toBe(false);
});

test("board-dnd-keyboard-zone-at-top-left", () => {
  const strip = { left: 300, top: 10, width: 48, height: 800 };
  const done = { left: 360, top: 10, width: 290, height: 800 };
  const zones = [
    { id: "column:Z", rect: strip },
    { id: "column:col_done", rect: done },
    { id: "column:gone", rect: null },
  ];
  // The rect sits at the strip's top-left: its centre (400px below) would lose against nearby cards.
  expect(zoneAt({ x: 300, y: 10 }, zones)).toBe("column:Z");
  expect(zoneAt({ x: 360, y: 10 }, zones)).toBe("column:col_done");
  expect(zoneAt({ x: 400, y: 500 }, zones)).toBe("column:col_done");
  expect(zoneAt({ x: 10, y: 10 }, zones)).toBeUndefined();
});

test("board-dnd-same-lane: a tilted overlay still counts as its own column, the next column does not", () => {
  const card = { left: 19, width: 284 };
  expect(sameLane({ left: 17.5, width: 287 }, card)).toBe(true);
  expect(sameLane({ left: 321, width: 284 }, card)).toBe(false);
  expect(sameLane({ left: 321, width: 40 }, card)).toBe(false);
});
