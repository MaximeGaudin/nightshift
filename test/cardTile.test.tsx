import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "../src/shared/types.ts";
import { CardTile } from "../src/web/CardTile.tsx";

const card = { id: "card_1", title: "Hello", description: "", columnId: "backlog" } as unknown as Card;
const base = { project: "/p", card, onOpen: () => {} };

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

test("card-tile-hooks-kept", () => {
  const html = renderToStaticMarkup(<CardTile {...base} next={{ name: "Grill" }} skipped={["Plan"]} sequential />);
  for (const hook of ["card-ref", "card-next", "card-skipped", "sequence-badge"]) expect(html).toContain(hook);
  expect(html).toMatch(/<article[^>]*class="card /);
  expect(html).not.toContain('draggable="true"');
  expect(html).not.toMatch(/<article[^>]*draggable/);
});

test("card-tile-dimmed-while-dragged", () => {
  expect(renderToStaticMarkup(<CardTile {...base} dragging />)).toMatch(/<article[^>]*class="[^"]*\bdragging\b/);
  expect(renderToStaticMarkup(<CardTile {...base} />)).not.toMatch(/<article[^>]*class="[^"]*\bdragging\b/);
});
