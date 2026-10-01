import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Board, Card, Column } from "../src/shared/types.ts";
import { NextColumnButton, nextInertTarget, sendToNext } from "../src/web/NextColumnButton.tsx";

const columns: Column[] = [
  { id: "x1", name: "Alpha", type: "inert" },
  { id: "x2", name: "Beta", type: "skill", skill: "s" },
  { id: "x3", name: "Gamma", type: "inert" },
  { id: "x4", name: "Omega", type: "inert" },
];
const board = { version: 1, name: "b", columns, cards: [], nextCardNumber: 1 } as Board;
const cardIn = (columnId: string) => ({ id: "card1", columnId }) as Card;

test("next-column-visibility", () => {
  expect(nextInertTarget(board, cardIn("x1"))?.id).toBe("x2");
  expect(nextInertTarget(board, cardIn("x2"))).toBeUndefined();
  expect(nextInertTarget(board, cardIn("x3"))?.id).toBe("x4");
  expect(nextInertTarget(board, cardIn("x4"))).toBeUndefined();
  const props = { project: "p", board, beforeMove: async () => {}, onError: () => {} };
  expect(renderToStaticMarkup(<NextColumnButton {...props} card={cardIn("x2")} />)).toBe("");
  expect(renderToStaticMarkup(<NextColumnButton {...props} card={cardIn("x1")} />)).toContain("Envoyer à Beta →");
});

test("next-column-click-order", async () => {
  const calls: unknown[][] = [];
  const errors: string[] = [];
  const base = {
    project: "p",
    card: cardIn("x1"),
    target: columns[1],
    onError: (m: string) => errors.push(m),
    moveCard: async (...a: unknown[]) => void calls.push(["move", ...a]),
  };
  await sendToNext({ ...base, beforeMove: async () => void calls.push(["before"]) });
  expect(calls).toEqual([["before"], ["move", "p", "card1", "x2"]]);

  calls.length = 0;
  await sendToNext({
    ...base,
    beforeMove: async () => {
      throw new Error("boom");
    },
  });
  expect(calls).toEqual([]);
  expect(errors).toEqual(["boom"]);
});

test("next-column-busy-render", () => {
  const props = { project: "p", board, beforeMove: async () => {}, onError: () => {} };
  const working = renderToStaticMarkup(<NextColumnButton {...props} card={cardIn("x1")} live="running" />);
  expect(working).toContain("Envoyer à Beta →");
  expect(working).toContain("disabled");
  expect(working).toContain("L&#x27;agent n&#x27;a pas fini");

  const asking = { ...cardIn("x1"), lastRun: { status: "question", columnId: "x1" } } as Card;
  const q = renderToStaticMarkup(<NextColumnButton {...props} card={asking} />);
  expect(q).toContain("disabled");
  expect(q).toContain("L&#x27;agent attend une réponse");

  const done = { ...cardIn("x1"), lastRun: { status: "done", columnId: "x1" } } as Card;
  const d = renderToStaticMarkup(<NextColumnButton {...props} card={done} />);
  expect(d).toContain("Envoyer à Beta →");
  expect(d).not.toContain("disabled");
  expect(d).not.toContain("title");
});
