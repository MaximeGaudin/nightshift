import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card, ProjectSnapshot } from "../src/shared/types.ts";
import { ProjectTabs } from "../src/web/ProjectTabs.tsx";
import { type TabsState, tabBoardEvent, tabClosed, tabOpened, tabOpenFailed } from "../src/web/projectTabs.ts";

const at = "2026-10-02T09:00:00.000Z";
const asking: Card = {
  id: "q",
  number: 1,
  title: "Q",
  description: "",
  columnId: "c1",
  createdAt: at,
  updatedAt: at,
  enteredColumnAt: at,
  history: [],
  lastRun: { columnId: "c1", status: "question", at, questions: ["?"] },
};
const snapOf = (path: string, cards: Card[] = []): ProjectSnapshot => ({
  path,
  board: { version: 1, name: path, columns: [], cards, nextCardNumber: cards.length + 1 },
  maxParallel: 3,
  live: {},
  testing: [],
  progress: {},
  quickRuns: [],
  flow: { fastForward: false, paused: false },
});
const empty: TabsState = { tabs: [], snaps: {}, errors: {} };
const render = (state: TabsState, active: string | null, onAdd?: () => void) =>
  renderToStaticMarkup(<ProjectTabs state={state} active={active} onSelect={() => {}} onClose={() => {}} onAdd={onAdd} />);

test("app tabs: switch without reload and live counts", () => {
  let st = tabOpened(empty, "/a", snapOf("/a"));
  st = tabOpened(st, "/b", snapOf("/b"));
  let html = render(st, "/b", () => {});
  expect(html.match(/role="tab"/g)?.length).toBe(2);
  expect(html).toMatch(/aria-selected="true"[^>]*title="\/b"/);
  expect(html).toContain("tab-add");
  expect(html).not.toContain("tab-questions");
  // A board event of the inactive project asks a question: its tab shows the count.
  st = tabBoardEvent(st, "/a", snapOf("/a", [asking]));
  html = render(st, "/b");
  expect(html).toMatch(/tab-questions[^>]*>1</);
  expect(html).not.toContain("tab-add");
});

test("app tabs: board events of projects without a tab are ignored", () => {
  const st = tabOpened(empty, "/a", snapOf("/a"));
  expect(tabBoardEvent(st, "/other", snapOf("/other"))).toBe(st);
});

test("app tabs: resolved path replaces the raw one without a duplicate", () => {
  let st = tabOpened(empty, "/home/me/p", snapOf("/home/me/p"));
  st = tabOpened(st, "~/p", snapOf("/home/me/p"));
  expect(st.tabs).toEqual(["/home/me/p"]);
});

test("app tabs: close and failed open", () => {
  let st = tabOpened(tabOpened(empty, "/a", snapOf("/a")), "/b", snapOf("/b"));
  const closed = tabClosed(st, "/b", "/b");
  expect(closed.next).toBe("/a");
  expect(closed.state.tabs).toEqual(["/a"]);
  expect("/b" in closed.state.snaps).toBe(false);
  expect(tabClosed(closed.state, "/a", "/a").next).toBeNull();
  // A tab whose folder is gone keeps its place and shows the error.
  st = tabOpenFailed({ tabs: ["/gone"], snaps: {}, errors: {} }, "/gone", "Folder not found");
  const html = render(st, null);
  expect(html).toContain("tab-error");
  expect(html).toContain("Folder not found");
  expect(tabOpened(st, "/gone", snapOf("/gone")).errors).toEqual({});
});
