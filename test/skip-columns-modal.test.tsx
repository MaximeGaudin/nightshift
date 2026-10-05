import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Board, Card, Column } from "../src/shared/types.ts";
import { CardModalContent, saveSkipColumns, useCardDraft } from "../src/web/CardModal.tsx";
import { nextInertTarget } from "../src/web/NextColumnButton.tsx";

const columns: Column[] = [
  { id: "col_fdc888c3ed", name: "Backlog", type: "inert" },
  { id: "col_0fc8f00a6b", name: "Review", type: "skill", skill: "review" },
  { id: "col_2e5738f5a3", name: "To Test", type: "inert" },
  { id: "col_f95bc1734d", name: "Merge", type: "skill", skill: "merge" },
  { id: "col_done", name: "Done", type: "inert" },
];
const board = { version: 1, name: "b", columns, cards: [], nextCardNumber: 2 } as Board;
const card = (columnId: string, skipColumnIds?: string[]): Card => ({
  id: "c1",
  number: 1,
  title: "T",
  description: "",
  columnId,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  enteredColumnAt: "2026-01-01T00:00:00Z",
  history: [],
  ...(skipColumnIds ? { skipColumnIds } : {}),
});
// Radix dialogs render nothing on the server: the tests render the dialog body.
function Content({ card: c }: { card: Card }) {
  const draft = useCardDraft("p", c);
  return <CardModalContent project="p" card={c} board={board} testing={false} onClose={() => {}} onError={() => {}} draft={draft} />;
}
const render = (c: Card) => renderToStaticMarkup(<Content card={c} />);

test("modal picker lists all columns except the current one and Done", () => {
  const html = render(card("col_0fc8f00a6b"));
  const list = html.slice(html.indexOf("skip-picker-list"));
  expect(html).toContain("Sauter des colonnes");
  expect(list).toContain("Backlog");
  expect(list).toContain("To Test");
  expect(list).toContain("Merge");
  expect(list).not.toContain(">Review<");
  expect(list).not.toContain(">Done<");
  expect(list.match(/type="checkbox"/g)?.length).toBe(3);
});

test("modal picker shows the board snapshot value", () => {
  const html = render(card("col_0fc8f00a6b", ["col_2e5738f5a3"]));
  expect(html).toContain("Sauter des colonnes (1)");
  expect(html.match(/checked=""/g)?.length).toBe(1);
});

test("checking To Test saves only skipColumnIds, without title or description", async () => {
  const calls: unknown[][] = [];
  const ok = await saveSkipColumns({
    project: "p",
    cardId: "c1",
    ids: ["col_2e5738f5a3"],
    onError: () => {},
    update: async (...a) => void calls.push(a),
  });
  expect(ok).toBe(true);
  expect(calls).toEqual([["p", "c1", { skipColumnIds: ["col_2e5738f5a3"] }]]);
  expect(Object.keys(calls[0]?.[2] as object)).toEqual(["skipColumnIds"]);
});

test("a failed skip save goes to onError", async () => {
  const errors: string[] = [];
  const ok = await saveSkipColumns({
    project: "p",
    cardId: "c1",
    ids: [],
    onError: (m) => errors.push(m),
    update: async () => {
      throw new Error("boom");
    },
  });
  expect(ok).toBe(false);
  expect(errors).toEqual(["boom"]);
});

test("nextInertTarget jumps over the skipped column", () => {
  expect(nextInertTarget(board, card("col_fdc888c3ed"))?.id).toBe("col_0fc8f00a6b");
  expect(nextInertTarget(board, card("col_fdc888c3ed", ["col_0fc8f00a6b"]))?.id).toBe("col_2e5738f5a3");
  expect(nextInertTarget(board, card("col_2e5738f5a3", ["col_f95bc1734d"]))?.id).toBe("col_done");
  expect(nextInertTarget(board, card("col_0fc8f00a6b", ["col_2e5738f5a3"]))).toBeUndefined();
});

test("modal picker has a status region and the auto-save hint", () => {
  const html = render(card("col_0fc8f00a6b"));
  expect(html).toContain('role="status"');
  expect(html).toContain("Enregistré automatiquement");
});
