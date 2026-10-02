import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BACKLOG_COLUMN_ID, type Card, type Column, DONE_COLUMN_ID, type ProjectSnapshot } from "../src/shared/types.ts";
import { Board } from "../src/web/Board.tsx";

// Board reads the Done collapse state from localStorage while rendering: a bare in-memory window is enough here.
const store = new Map<string, string>();
(globalThis as { window?: unknown }).window ??= {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
};

const at = "2026-10-02T09:00:00.000Z";
const columns: Column[] = [
  { id: BACKLOG_COLUMN_ID, name: "Backlog", type: "inert" },
  { id: "col_plan", name: "Plan", type: "skill", skill: "demo-plan", model: "opus" },
  { id: DONE_COLUMN_ID, name: "Done", type: "inert" },
];
const card = (id: string, columnId: string): Card => ({
  id,
  number: 1,
  title: `Card ${id}`,
  description: "",
  columnId,
  createdAt: at,
  updatedAt: at,
  enteredColumnAt: at,
  history: [],
});
const snap: ProjectSnapshot = {
  path: "/tmp/p",
  board: { version: 1, name: "P", columns, cards: [card("a", "col_plan"), card("b", BACKLOG_COLUMN_ID)], nextCardNumber: 2 },
  maxParallel: 3,
  live: {},
  testing: [],
  progress: {},
  quickRuns: [],
  flow: { fastForward: false, paused: false },
};

const html = renderToStaticMarkup(<Board snap={snap} onOpen={() => {}} onEditColumns={() => {}} guard={() => {}} />);

test("board: lane and pill styling", () => {
  const plan = html.slice(html.indexOf("Plan"), html.indexOf("Card a"));
  expect(html).toMatch(/<section[^>]*class="column [^"]*bg-lane/);
  expect(plan).toContain("badge skill");
  expect(plan).toContain("badge model");
  expect(plan).toContain('data-slot="badge-dot"');
  expect(plan).not.toContain("font-mono");
});

test("board: column header actions", () => {
  // Edit and add buttons on each wide column header that holds cards (Backlog and Plan).
  expect(html.match(/class="[^"]*column-edit/g)?.length).toBe(2);
  expect(html.match(/class="[^"]*column-add/g)?.length).toBe(2);
  expect(html).toContain('aria-label="Modifier les colonnes"');
  // Without onEditColumns the "…" is not rendered, the "+" stays.
  const bare = renderToStaticMarkup(<Board snap={snap} onOpen={() => {}} guard={() => {}} />);
  expect(bare).not.toContain("column-edit");
  expect(bare).toContain("column-add");
});
