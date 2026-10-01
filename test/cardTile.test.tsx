import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CardTile } from "../src/web/CardTile.tsx";
import type { Card } from "../src/shared/types.ts";

const card = { id: "card_1", title: "Hello", description: "", columnId: "backlog" } as unknown as Card;
const base = { project: "/p", card, dragging: false, onOpen: () => {}, onDragStart: () => {}, onDragEnd: () => {} };

test("card-tile-button", () => {
  const html = renderToStaticMarkup(<CardTile {...base} next={{ name: "Grill" }} onSendNext={() => {}} />);
  expect(html).toContain('type="button"');
  expect(html).toContain('aria-label="Envoyer vers Grill"');
  expect(html).toContain('title="Envoyer vers Grill"');
  expect(html).toContain("card-next");
});

test("card-tile-no-button", () => {
  expect(renderToStaticMarkup(<CardTile {...base} />)).not.toContain("card-next");
});

test("card-tile-sending", () => {
  const html = renderToStaticMarkup(<CardTile {...base} next={{ name: "Grill" }} sending />);
  expect(html).toMatch(/<button[^>]*disabled/);
});
