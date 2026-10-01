import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CardModal } from "../src/web/CardModal.tsx";
import type { Board, Card } from "../src/shared/types.ts";

const board = {
  columns: [
    { id: "backlog", name: "Backlog", type: "inert" },
    { id: "col_done", name: "Done", type: "inert" },
  ],
  cards: [],
} as unknown as Board;
const card = (columnId: string) => ({ id: "card_1", title: "Hello", description: "", columnId }) as unknown as Card;
const render = (columnId: string) =>
  renderToStaticMarkup(<CardModal project="/p" card={card(columnId)} board={board} testing={false} onClose={() => {}} />);

test("card-modal-validate-button", () => {
  const html = render("backlog");
  expect(html).toMatch(/<button[^>]*title="Envoyer vers Done"[^>]*>Valider<\/button>/);
  expect(html.indexOf("Enregistrer")).toBeLessThan(html.indexOf("Valider"));
});

test("card-modal-no-validate-on-done", () => {
  expect(render("col_done")).not.toContain("Valider");
});
