import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Board, Card } from "../src/shared/types.ts";
import { CardModalFooter, useCardDraft } from "../src/web/CardModal.tsx";
import { CardTile } from "../src/web/CardTile.tsx";

const board = {
  version: 1,
  name: "b",
  columns: [
    { id: "col_backlog", name: "Backlog", type: "inert" },
    { id: "col_impl", name: "Implement", type: "skill", skill: "nightshift-implement" },
    { id: "col_done", name: "Done", type: "inert" },
  ],
  cards: [],
  nextCardNumber: 2,
} as Board;

const card: Card = {
  id: "c1",
  number: 1,
  title: "T",
  description: "d",
  columnId: "col_impl",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  enteredColumnAt: "2026-01-01T00:00:00Z",
  history: [],
  lastRun: {
    columnId: "col_impl",
    status: "attention",
    at: "2026-01-01T00:01:00Z",
    summary: "tests not finished",
    error: "Stopped in Implement without finishing: tests not finished",
    sessionId: "sess-1",
  },
};

test("attention-badge: the tile shows a needs-attention badge with the reason", () => {
  const html = renderToStaticMarkup(<CardTile project="p" card={card} onOpen={() => {}} />);
  expect(html).toContain("À reprendre");
  expect(html).toContain("st-attention");
  expect(html).toContain("text-err");
  expect(html).toContain("Stopped in Implement without finishing");
});

test("attention-badge: the card detail offers Resume and Retry", () => {
  function Content() {
    const draft = useCardDraft("p", card);
    return <CardModalFooter project="p" card={card} board={board} draft={draft} onClose={() => {}} />;
  }
  const html = renderToStaticMarkup(<Content />);
  expect(html).toContain("Reprendre la session");
  expect(html).toContain("Relancer");
});
