import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "../src/shared/types.ts";
import { DoneColumn } from "../src/web/DoneColumn.tsx";
import { readDoneCollapsed, sortDoneCards, writeDoneCollapsed } from "../src/web/doneColumn.ts";

const fakeStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

const mk = (n: number, at: string): Card => ({
  id: `c${n}`, number: n, title: `Titre ${n}`, description: "", columnId: "col_done",
  createdAt: at, updatedAt: at, enteredColumnAt: at, history: [],
});
const cards = [mk(1, "2026-01-01T00:00:00Z"), mk(2, "2026-03-01T00:00:00Z"), mk(3, "2026-02-01T00:00:00Z")];

test("done collapsed preference", () => {
  const s = fakeStorage();
  expect(readDoneCollapsed(s, "/a")).toBe(true);
  writeDoneCollapsed(s, "/a", false);
  expect(readDoneCollapsed(s, "/a")).toBe(false);
  expect(readDoneCollapsed(s, "/b")).toBe(true);
  const bad = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
  expect(() => writeDoneCollapsed(bad, "/a", true)).not.toThrow();
  expect(readDoneCollapsed(bad, "/a")).toBe(true);
});

test("sortDoneCards newest first", () => {
  expect(sortDoneCards(cards).map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
  expect(cards.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
});

test("DoneColumn renders collapsed and expanded", () => {
  const props = {
    cards, dragging: false, dropActive: false, onDragOverDone() {}, onDragLeaveDone() {},
    onDropDone() {}, onToggle() {}, renderCard: (c: Card) => <b>{c.title}</b>,
  };
  const closed = renderToStaticMarkup(<DoneColumn {...props} collapsed />);
  expect(closed).toContain("Done");
  expect(closed).toContain("3");
  expect(closed).toContain('aria-expanded="false"');
  expect(closed).not.toContain("Titre");
  const open = renderToStaticMarkup(<DoneColumn {...props} collapsed={false} />);
  expect(open.indexOf("Titre 2")).toBeGreaterThan(-1);
  expect(open.indexOf("Titre 2")).toBeLessThan(open.indexOf("Titre 3"));
  expect(open.indexOf("Titre 3")).toBeLessThan(open.indexOf("Titre 1"));
});
