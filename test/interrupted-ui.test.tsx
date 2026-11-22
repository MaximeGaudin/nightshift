import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Board, Card, LiveStatus, ProjectSnapshot } from "../src/shared/types.ts";
import { FlowButtons, interruptedCount } from "../src/web/App.tsx";
import { CardModalFooter, useCardDraft } from "../src/web/CardModal.tsx";
import { CardTile } from "../src/web/CardTile.tsx";
import { setLocale } from "../src/web/i18n/index.ts";

afterEach(() => setLocale("fr"));

const board = {
  version: 1,
  name: "b",
  columns: [
    { id: "col_backlog", name: "Backlog", type: "inert" },
    { id: "col_impl", name: "Implement", type: "skill", skill: "nightshift-implement" },
    { id: "col_done", name: "Done", type: "inert" },
  ],
  cards: [],
  nextCardNumber: 3,
} as Board;

const base: Card = {
  id: "c1",
  number: 1,
  title: "T",
  description: "d",
  columnId: "col_impl",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  enteredColumnAt: "2026-01-01T00:00:00Z",
  history: [],
};
const interrupted: Card = {
  ...base,
  lastRun: {
    columnId: "col_impl",
    status: "cancelled",
    interrupted: true,
    at: "2026-01-01T00:01:00Z",
    error: "Interrupted: Nightshift stopped while the agent was running",
    sessionId: "sess-1",
  },
};
// Interrupted in another column: it no longer counts.
const moved: Card = { ...interrupted, id: "c2", number: 2, columnId: "col_done" };

const snapWith = (cards: Card[], live: Record<string, LiveStatus> = {}) =>
  ({ path: "/p", board: { ...board, cards }, live, flow: { fastForward: false, paused: false } }) as unknown as ProjectSnapshot;

test("interrupted-badge-and-resume-button", () => {
  setLocale("fr");
  const tile = renderToStaticMarkup(<CardTile project="p" card={interrupted} onOpen={() => {}} />);
  expect(tile).toContain("Interrompu");
  expect(tile).toContain("st-interrupted");
  const cancelled = renderToStaticMarkup(
    <CardTile
      project="p"
      card={{ ...interrupted, lastRun: { ...(interrupted.lastRun as Card["lastRun"] & object), interrupted: undefined } }}
      onOpen={() => {}}
    />,
  );
  expect(cancelled).toContain("Annulé");
  expect(cancelled).not.toContain("Interrompu");

  expect(interruptedCount(snapWith([interrupted, moved]))).toBe(1);
  expect(interruptedCount(snapWith([interrupted], { c1: "running" }))).toBe(0);
  const header = renderToStaticMarkup(<FlowButtons snap={snapWith([interrupted, moved])} guard={() => {}} />);
  expect(header).toContain("resume-interrupted");
  expect(header).toContain("Reprendre l&#x27;interrompu (1)");
  setLocale("en");
  expect(renderToStaticMarkup(<FlowButtons snap={snapWith([interrupted, { ...interrupted, id: "c3" }])} guard={() => {}} />)).toContain(
    "Resume interrupted (2)",
  );
  expect(renderToStaticMarkup(<FlowButtons snap={snapWith([moved])} guard={() => {}} />)).not.toContain("resume-interrupted");
});

test("queued-card-remove-button", () => {
  setLocale("fr");
  function Footer({ live }: { live?: LiveStatus }) {
    const draft = useCardDraft("p", base);
    return <CardModalFooter project="p" card={base} board={board} live={live} draft={draft} onClose={() => {}} />;
  }
  for (const live of ["queued", "paused"] as const) {
    const html = renderToStaticMarkup(<Footer live={live} />);
    expect(html).toContain("Retirer de la file");
    expect(html).not.toContain("Arrêter l&#x27;agent");
  }
  const running = renderToStaticMarkup(<Footer live="running" />);
  expect(running).toContain("Arrêter l&#x27;agent");
  expect(renderToStaticMarkup(<Footer />)).not.toContain("Retirer de la file");
});
