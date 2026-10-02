import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card, ProjectSnapshot } from "../src/shared/types.ts";
import { FlowButtons } from "../src/web/App.tsx";
import { CardTile } from "../src/web/CardTile.tsx";
import { setLocale } from "../src/web/i18n/index.ts";

const card = { id: "card_1", number: 1, title: "Hello", description: "", columnId: "col_grill", history: [] } as unknown as Card;
const snapWith = (extra: object = {}) =>
  ({
    path: "/p",
    board: { name: "b", columns: [], cards: [card] },
    live: {},
    flow: { fastForward: false, paused: false },
    ...extra,
  }) as unknown as ProjectSnapshot;
const render = (snap: ProjectSnapshot) => renderToStaticMarkup(<FlowButtons snap={snap} guard={() => {}} />);
const disabled = /<button[^>]*\sdisabled(=|\s|>)/;

afterEach(() => setLocale("fr"));

test("flow buttons", () => {
  setLocale("fr");
  const idle = render(snapWith());
  expect(idle).toContain("lucide-fast-forward");
  expect(idle).toContain("lucide-pause");
  expect(idle).toContain('aria-label="Avance rapide : inactive');
  expect(idle).toContain('aria-label="Lecture : cliquer pour mettre en pause"');
  expect(idle).not.toContain('aria-pressed="true"');
  expect(idle).not.toMatch(disabled);

  const paused = render(snapWith({ flow: { fastForward: true, paused: true }, live: { a: "paused", b: "paused", c: "queued" } }));
  expect(paused).toContain("lucide-play");
  expect(paused).toContain('aria-label="En pause : 2 cartes en attente');
  expect(paused).toContain('aria-label="Avance rapide : active');
  expect(paused.match(/aria-pressed="true"/g)?.length).toBe(2);

  setLocale("en");
  expect(render(snapWith({ flow: { fastForward: false, paused: true }, live: { a: "paused" } }))).toContain(
    'aria-label="Paused: 1 card waiting',
  );
  expect(render(snapWith({ agentsDisabled: true }))).toMatch(disabled);
  expect(render(snapWith({ lockedBy: 42 }))).toMatch(disabled);
});

test("paused badge", () => {
  setLocale("fr");
  expect(renderToStaticMarkup(<CardTile project="/p" card={card} live="paused" onOpen={() => {}} />)).toContain("En pause");
  setLocale("en");
  const html = renderToStaticMarkup(<CardTile project="/p" card={card} live="paused" onOpen={() => {}} />);
  expect(html).toContain("Paused");
  expect(html).toContain("st-paused");
  expect(renderToStaticMarkup(<CardTile project="/p" card={card} live="queued" onOpen={() => {}} />)).not.toContain("Paused");
});
