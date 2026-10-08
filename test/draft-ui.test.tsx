import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BACKLOG_COLUMN_ID, type Card } from "../src/shared/types.ts";
import { AddCard, submitQuickAddCard } from "../src/web/AddCard.tsx";
import { DraftSection } from "../src/web/CardModal.tsx";
import { CardTile } from "../src/web/CardTile.tsx";

const T0 = "2026-01-01T00:00:00Z";
const card = (over: Partial<Card> = {}): Card => ({
  id: "x",
  number: 1,
  title: "X",
  description: "",
  columnId: BACKLOG_COLUMN_ID,
  createdAt: T0,
  updatedAt: T0,
  enteredColumnAt: T0,
  history: [],
  ...over,
});

test("draft: the tile of a draft card shows the badge, a plain one does not", () => {
  const base = { project: "/p", onOpen: () => {} };
  expect(renderToStaticMarkup(<CardTile {...base} card={card({ draft: true })} />)).toContain("draft-badge");
  expect(renderToStaticMarkup(<CardTile {...base} card={card()} />)).not.toContain("draft-badge");
});

test("draft: the toggle is rendered only for a Backlog card", () => {
  const noop = () => Promise.resolve();
  expect(renderToStaticMarkup(<DraftSection project="/p" card={card()} update={noop} />)).toContain("card-draft");
  const on = renderToStaticMarkup(<DraftSection project="/p" card={card({ draft: true })} update={noop} />);
  expect(on).toContain('aria-checked="true"');
  expect(renderToStaticMarkup(<DraftSection project="/p" card={card({ columnId: "col_grill" })} update={noop} />)).toBe("");
});

test("draft: the quick add-card form shows the checkbox only when the column is draftable", () => {
  const onAdd = () => {};
  expect(renderToStaticMarkup(<AddCard initialOpen draftable onAdd={onAdd} />)).toContain("add-card-draft");
  expect(renderToStaticMarkup(<AddCard initialOpen onAdd={onAdd} />)).not.toContain("add-card-draft");
});

test("draft: the quick add-card form sends the draft flag only for a draftable column and resets it", () => {
  const sent: [string, string[], boolean][] = [];
  const onAdd = (title: string, skip: string[], draft: boolean) => sent.push([title, skip, draft]);
  expect(submitQuickAddCard(" A ", [], true, true, onAdd)).toEqual({ title: "", skip: [], draft: false, close: true });
  submitQuickAddCard("B", [], true, false, onAdd);
  submitQuickAddCard("C", [], false, true, onAdd);
  expect(sent).toEqual([
    ["A", [], true],
    ["B", [], false],
    ["C", [], false],
  ]);
  expect(submitQuickAddCard("  ", ["col_x"], true, true, onAdd)).toEqual({ title: "  ", skip: ["col_x"], draft: true, close: false });
  expect(sent).toHaveLength(3);
});
