import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cardTimeSlices, cardTimers } from "../src/shared/timeline.ts";
import { backlogColumn, type Card, type Column, doneColumn, type HistoryEntry } from "../src/shared/types.ts";
import { CardTile } from "../src/web/CardTile.tsx";
import { nowSubscribers } from "../src/web/useNow.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const backlog = backlogColumn();
const grill: Column = { id: "grill", name: "Grill", type: "skill", skill: "g" };
const plan: Column = { id: "plan", name: "Plan", type: "skill", skill: "p" };
const columns: Column[] = [backlog, grill, plan, doneColumn()];

const history = (...e: [number, string, Column][]): HistoryEntry[] =>
  e.map(([t, kind, col]) =>
    kind === "created"
      ? { at: at(t), kind: "created", text: `Created in ${col.name}`, columnId: col.id }
      : { at: at(t), kind: "moved", text: `Agent: x → ${col.name}`, columnId: col.id },
  );

// Created in Backlog at 0, left at 3 days, Grill until 3 days + 300 s, then Plan.
const DAY = 86400;
const card = (col: Column, enteredAt: number): Card =>
  ({
    id: "c",
    title: "T",
    description: "",
    columnId: col.id,
    createdAt: at(0),
    enteredColumnAt: at(enteredAt),
    history: history([0, "created", backlog], [3 * DAY, "moved", grill], [3 * DAY + 300, "moved", plan]),
  }) as unknown as Card;

test("total excludes Backlog, step counts from the last entry", () => {
  const now = T0 + (3 * DAY + 300 + 60) * 1000;
  expect(cardTimers(card(plan, 3 * DAY + 300), columns, now)).toEqual({ totalMs: 360_000, stepMs: 60_000 });
});

test("back to Backlog and out again: neither chrono nor chart counts Backlog", () => {
  const h = history([0, "created", grill], [100, "moved", backlog], [1000, "moved", grill]);
  const c = { ...card(grill, 1000), history: h } as Card;
  const now = T0 + 1060 * 1000;
  const sum = cardTimeSlices(c, columns, now).reduce((a, x) => a + x.ms, 0);
  expect(sum).toBe(160_000);
  expect(cardTimers(c, columns, now)?.totalMs).toBe(sum);
});

test("no timers in Backlog or Done", () => {
  expect(cardTimers(card(backlog, 0), columns, T0 + 1000)).toBeNull();
  expect(cardTimers(card(doneColumn(), 0), columns, T0 + 1000)).toBeNull();
});

test("invalid or future entry date gives 0, never NaN", () => {
  const bad = { ...card(plan, 0), enteredColumnAt: "garbage" } as Card;
  expect(cardTimers(bad, columns, T0 + (3 * DAY + 400) * 1000)?.stepMs).toBe(0);
  const future = card(plan, 3 * DAY + 10_000);
  const r = cardTimers(future, columns, T0 + (3 * DAY + 400) * 1000);
  expect(r?.stepMs).toBe(0);
  expect(Number.isNaN(r?.totalMs)).toBe(false);
});

test("tile renders both chronos in a work column, none in Backlog, none without columns", () => {
  const props = { project: "/p", onOpen: () => {} };
  const html = renderToStaticMarkup(<CardTile {...props} card={card(plan, 0)} column={plan} columns={columns} />);
  expect(html).toContain("card-timer-total");
  expect(html).toContain("card-timer-step");
  expect(html).toContain("Temps dans Plan");
  expect(renderToStaticMarkup(<CardTile {...props} card={card(backlog, 0)} column={backlog} columns={columns} />)).not.toContain(
    "card-timers",
  );
  expect(renderToStaticMarkup(<CardTile {...props} card={card(plan, 0)} />)).not.toContain("card-timers");
});

test("ticker is idle without subscribers", () => {
  expect(nowSubscribers()).toBe(0);
});
