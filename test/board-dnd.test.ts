import { expect, test } from "bun:test";
import type { Card, Column } from "../src/shared/types.ts";
import { cardsByColumn, localCards, localColumnOf, moveLocal, resolveDrop, snapshotOrder } from "../src/web/boardDnd.ts";

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
