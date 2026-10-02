import { expect, test } from "bun:test";
import { cardTimeSlices, formatDuration, formatPercent, replayHistory } from "../src/shared/timeline.ts";
import { type Card, type Column, doneColumn, type HistoryEntry } from "../src/shared/types.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const s = (n: number) => n * 1000;

const backlog: Column = { id: "col_backlog", name: "Backlog", type: "inert" };
const grill: Column = { id: "grill", name: "Grill", type: "skill", skill: "g" };
const plan: Column = { id: "plan", name: "Plan", type: "skill", skill: "p" };
const columns: Column[] = [backlog, grill, plan, doneColumn()];

const created = (t: number, col: Column): HistoryEntry => ({
  at: at(t),
  kind: "created",
  text: `Created in ${col.name}`,
  columnId: col.id,
});
const moved = (t: number, from: Column, to: Column): HistoryEntry => ({
  at: at(t),
  kind: "moved",
  text: `Agent: ${from.name} → ${to.name}`,
  columnId: to.id,
});
const oldMoved = (t: number, from: string, to: string): HistoryEntry => ({ at: at(t), kind: "moved", text: `Agent: ${from} → ${to}` });
const queued = (t: number, col: Column): HistoryEntry => ({ at: at(t), kind: "queued", text: `Queued in ${col.name}`, columnId: col.id });
const started = (t: number, col: Column): HistoryEntry => ({
  at: at(t),
  kind: "started",
  text: `Agent started in ${col.name}`,
  columnId: col.id,
});
const run = (t: number, col: Column): HistoryEntry => ({ at: at(t), kind: "run", text: `${col.name}: done` });
const edited = (t: number): HistoryEntry => ({ at: at(t), kind: "edited", text: "Edited by user" });

function card(history: HistoryEntry[], extra: Partial<Card> = {}): Card {
  return {
    id: "c",
    number: 1,
    title: "t",
    description: "",
    columnId: "col_backlog",
    createdAt: at(0),
    updatedAt: at(0),
    enteredColumnAt: at(0),
    history,
    ...extra,
  };
}

const view = (slices: ReturnType<typeof cardTimeSlices>) => slices.map((x) => `${x.columnName}/${x.part}/${x.ms}`);

test("Backlog time is never a slice, even from a legacy entry named Backlog", () => {
  const h = [created(0, backlog), moved(10, backlog, plan)];
  expect(view(cardTimeSlices(card(h), columns, T0 + s(30)))).toEqual(["Plan/inert/20000"]);
  const old = [oldMoved(10, "Backlog", "Plan")];
  expect(view(cardTimeSlices(card(old), columns, T0 + s(30)))).toEqual(["Plan/legacy/20000"]);
  expect(cardTimeSlices(card([created(0, backlog)]), columns, T0 + s(30))).toEqual([]);
});

test("time in any inert column (To Test) is never a slice", () => {
  const toTest: Column = { id: "totest", name: "To Test", type: "inert" };
  const cols = [backlog, grill, toTest, plan, doneColumn()];
  const h = [created(0, grill), moved(10, grill, toTest), moved(40, toTest, plan)];
  expect(view(cardTimeSlices(card(h), cols, T0 + s(50)))).toEqual(["Grill/inert/10000", "Plan/inert/10000"]);
  expect(view(cardTimeSlices(card([oldMoved(10, "To Test", "Plan")]), cols, T0 + s(30)))).toEqual(["Plan/legacy/20000"]);
});

test("detailed replay splits inert, queued, running and human time", () => {
  const h = [
    created(0, backlog),
    moved(10, backlog, plan),
    queued(10, plan),
    started(15, plan),
    run(25, plan),
    moved(40, plan, doneColumn()),
  ];
  expect(view(cardTimeSlices(card(h), columns, T0 + s(100)))).toEqual(["Plan/queued/5000", "Plan/running/10000", "Plan/human/15000"]);
});

test("visits are merged into one row per column and part", () => {
  const h = [
    created(0, backlog),
    moved(10, backlog, plan),
    queued(10, plan),
    started(12, plan),
    moved(20, plan, backlog),
    moved(30, backlog, plan),
    queued(30, plan),
    started(31, plan),
    run(40, plan),
    moved(50, plan, doneColumn()),
  ];
  expect(view(cardTimeSlices(card(h), columns, T0 + s(100)))).toEqual(["Plan/queued/3000", "Plan/running/17000", "Plan/human/10000"]);
});

test("a rerun stops human waiting at queued", () => {
  const h = [
    created(0, plan),
    queued(0, plan),
    started(5, plan),
    run(10, plan),
    edited(20),
    queued(30, plan),
    started(32, plan),
    run(40, plan),
  ];
  expect(view(cardTimeSlices(card(h), columns, T0 + s(50)))).toEqual(["Plan/queued/7000", "Plan/running/13000", "Plan/human/30000"]);
});

test("old cards give legacy slices for skill columns and nothing for inert ones", () => {
  const h: HistoryEntry[] = [
    { at: at(0), kind: "created", text: "Created in Backlog" },
    oldMoved(10, "Backlog", "Grill"),
    { at: at(15), kind: "run", text: "Grill: done" },
    oldMoved(20, "Grill", "Plan"),
    oldMoved(30, "Plan", "Backlog"),
    oldMoved(40, "Backlog", "Done"),
  ];
  expect(view(cardTimeSlices(card(h), columns, T0 + s(100)))).toEqual(["Grill/legacy/10000", "Plan/legacy/10000"]);
});

test("an already truncated history attributes the first interval to the source column", () => {
  const h = [oldMoved(50, "Grill", "Plan")];
  expect(view(cardTimeSlices(card(h), columns, T0 + s(60)))).toEqual(["Grill/legacy/50000", "Plan/legacy/10000"]);
  expect(cardTimeSlices(card([edited(5)]), columns, T0 + s(60))).toEqual([]);
});

test("deleted column keeps its last parsed name after the board columns", () => {
  const gone: HistoryEntry[] = [
    created(0, backlog),
    { at: at(10), kind: "moved", text: "Moved by user: Backlog → Old name", columnId: "gone" },
    { at: at(20), kind: "moved", text: "Moved by user: Old name → Renamed", columnId: "gone" },
    moved(30, plan, plan),
  ];
  expect(view(cardTimeSlices(card(gone), columns, T0 + s(40)))).toEqual(["Plan/inert/10000", "Renamed/inert/20000"]);
});

test("legacy cursor ignores detailed-only entries until the next move", () => {
  const h = [
    oldMoved(10, "Backlog", "Plan"),
    queued(12, plan),
    started(14, plan),
    run(16, plan),
    moved(20, plan, grill),
    queued(20, grill),
  ];
  expect(view(cardTimeSlices(card(h), columns, T0 + s(30)))).toEqual(["Grill/queued/10000", "Plan/legacy/10000"]);
});

test("replay does not mutate its base", () => {
  const base = replayHistory(undefined, [created(0, backlog)], at(0));
  const copy = structuredClone(base);
  replayHistory(base, [moved(10, backlog, plan)], at(0));
  expect(base).toEqual(copy);
});

test("checkpoint replay equals full replay at every cut point", () => {
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const cols = [backlog, grill, plan, doneColumn()];
  const names = ["Backlog", "Grill", "Plan", "Done", "Gone"];
  const h: HistoryEntry[] = [];
  let t = 0;
  for (let i = 0; i < 120; i++) {
    t += rnd(7) - 1; // occasionally goes backwards
    const col = cols[rnd(cols.length)];
    const detailed = i > 60 || rnd(3) === 0;
    switch (rnd(7)) {
      case 0:
        h.push(detailed ? created(t, col) : { at: at(t), kind: "created", text: `Created in ${names[rnd(5)]}` });
        break;
      case 1:
      case 2:
        h.push(detailed ? moved(t, cols[rnd(cols.length)], col) : oldMoved(t, names[rnd(5)], names[rnd(5)]));
        break;
      case 3:
        h.push(queued(t, col));
        break;
      case 4:
        h.push(started(t, col));
        break;
      case 5:
        h.push(run(t, col));
        break;
      default:
        h.push(edited(t));
    }
  }
  const createdAt = at(0);
  const full = cardTimeSlices(card(h), columns, T0 + s(1000));
  expect(full.length).toBeGreaterThan(0);
  for (let k = 0; k <= h.length; k++) {
    const timeBase = replayHistory(undefined, h.slice(0, k), createdAt);
    expect(timeBase.totals.length).toBeLessThanOrEqual(2 * 5 * 5);
    const rest = card(h.slice(k), { timeBase });
    expect(cardTimeSlices(rest, columns, T0 + s(1000))).toEqual(full);
  }
});

test("a first-entry-less prefix still gives the same result when cut", () => {
  const h = [edited(1), oldMoved(50, "Grill", "Plan"), run(60, plan)];
  const full = cardTimeSlices(card(h), columns, T0 + s(100));
  for (let k = 0; k <= h.length; k++) {
    const timeBase = replayHistory(undefined, h.slice(0, k), at(0));
    expect(cardTimeSlices(card(h.slice(k), { timeBase }), columns, T0 + s(100))).toEqual(full);
  }
});

test("formatDuration", () => {
  expect(formatDuration(45000)).toBe("45 s");
  expect(formatDuration(840000)).toBe("14 min");
  expect(formatDuration(8040000)).toBe("2 h 14 min");
  expect(formatDuration(3 * 86400000 + 4 * 3600000)).toBe("3 j 4 h");
});

test("formatPercent", () => {
  expect(formatPercent(1, 3)).toBe("33 %");
  expect(formatPercent(1, 1000)).toBe("< 1 %");
  expect(formatPercent(0, 10)).toBe("0 %");
});
