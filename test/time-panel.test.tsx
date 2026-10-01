import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DONE_COLUMN_ID, type Board, type Card, type Column } from "../src/shared/types.ts";
import { startTicker, TimePanelView } from "../src/web/TimePanel.tsx";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

const backlog: Column = { id: "c_back", name: "Backlog", type: "inert" };
const plan: Column = { id: "c_plan", name: "Plan", type: "skill", skill: "x" };
const done: Column = { id: DONE_COLUMN_ID, name: "Done", type: "inert" };
const board = (cards: Card[]): Board => ({ version: 1, name: "t", columns: [backlog, plan, done], cards, nextCardNumber: 2 });

const card = (history: Card["history"], columnId: string): Card => ({
  id: "k1",
  number: 1,
  title: "T",
  description: "",
  columnId,
  createdAt: iso(0),
  updatedAt: iso(0),
  enteredColumnAt: iso(0),
  history,
});
const created = (col: Column) => ({ at: iso(0), kind: "created" as const, text: `Created in ${col.name}`, columnId: col.id });

const render = (c: Card, nowMs: number) => renderToStaticMarkup(<TimePanelView card={c} board={board([c])} nowMs={nowMs} />);

test("empty tab: just created, or only in Done", () => {
  const c = card([created(backlog)], backlog.id);
  expect(render(c, T0)).toContain("Pas encore de temps mesuré");
  const d = card([created(done)], done.id);
  expect(render(d, T0 + 60_000)).toContain("Pas encore de temps mesuré");
});

test("single part: filled circle and 100 %", () => {
  const c = card([created(backlog)], backlog.id);
  const html = render(c, T0 + 90_000);
  expect(html).toMatch(/<circle[^>]*fill="hsl\(/);
  expect(html).not.toContain("<path");
  expect(html).toContain("100 %");
  expect(html).toContain("1 min");
});

test("several parts: arcs, labels, legacy pattern", () => {
  const c = card(
    [
      created(plan),
      { at: iso(0), kind: "queued", text: "Queued", columnId: plan.id },
      { at: iso(10_000), kind: "started", text: "Started", columnId: plan.id },
      { at: iso(40_000), kind: "run", text: "Run", columnId: plan.id },
    ],
    plan.id,
  );
  const html = render(c, T0 + 100_000);
  expect(html).toContain("<path");
  expect(html).toContain("En file (concurrence)");
  expect(html).toContain("Agent en cours");
  expect(html).toContain("Attente humaine");
  const legacy = card([{ at: iso(0), kind: "created", text: "Created in Plan" }], plan.id);
  expect(render(legacy, T0 + 5000)).toContain("Détail indisponible");
  expect(render(legacy, T0 + 5000)).toContain("<pattern");
});

test("tick: duration grows as time passes", () => {
  const c = card([created(backlog)], backlog.id);
  expect(render(c, T0 + 5_000)).toContain("5 s");
  expect(render(c, T0 + 6_000)).toContain("6 s");
});

test("startTicker: one interval, cleared on stop", () => {
  const set = spyOn(globalThis, "setInterval");
  const clear = spyOn(globalThis, "clearInterval");
  let ticks = 0;
  const stop = startTicker(() => ticks++, 10);
  expect(set).toHaveBeenCalledTimes(1);
  expect(set.mock.calls[0]![1]).toBe(10);
  expect(clear).not.toHaveBeenCalled();
  stop();
  expect(clear).toHaveBeenCalledTimes(1);
  expect(clear.mock.calls[0]![0]).toBe(set.mock.results[0]!.value);
  set.mockRestore();
  clear.mockRestore();
});

test("startTicker: default period 1 s, fires on schedule", async () => {
  const set = spyOn(globalThis, "setInterval");
  const stop = startTicker(() => {});
  expect(set.mock.calls[0]![1]).toBe(1000);
  stop();
  set.mockRestore();
  let ticks = 0;
  const stop2 = startTicker(() => ticks++, 5);
  await new Promise((r) => setTimeout(r, 40));
  stop2();
  const seen = ticks;
  expect(seen).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 30));
  expect(ticks).toBe(seen);
});
