import { expect, test } from "bun:test";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column, HistoryEntry } from "../src/shared/types.ts";
import { must, tempDir } from "./helpers.ts";
import { nightshiftEnv, PAST } from "./nightshift-helpers.ts";

nightshiftEnv();
const { defaultBoard, normalizeBoard, numberingChanged, Project } = await import("../src/server/store.ts");
const { NIGHTSHIFT_HOME } = await import("../src/server/settings.ts");
const home = NIGHTSHIFT_HOME;
const { BACKLOG_COLUMN_ID, DONE_COLUMN_ID } = await import("../src/shared/types.ts");

const rawCard = (id: string, createdAt: string, number?: unknown) => ({
  id,
  title: id,
  createdAt,
  ...(number === undefined ? {} : { number }),
});
const numbers = (b: { cards: { id: string; number: number }[] }) => Object.fromEntries(b.cards.map((c) => [c.id, c.number]));

test("numbering: migration in createdAt order", () => {
  const b = normalizeBoard(
    {
      cards: [
        rawCard("late", "2026-01-03T00:00:00Z"),
        rawCard("tieA", "2026-01-02T00:00:00Z"),
        rawCard("early", "2026-01-01T00:00:00Z"),
        rawCard("tieB", "2026-01-02T00:00:00Z"),
      ],
    },
    "x",
  );
  expect(b.cards.map((c) => c.id)).toEqual(["late", "tieA", "early", "tieB"]);
  expect(numbers(b)).toEqual({ early: 1, tieA: 2, tieB: 3, late: 4 });
  expect(b.nextCardNumber).toBe(5);

  const three = normalizeBoard(
    { cards: [rawCard("c", "2026-01-03T00:00:00Z"), rawCard("a", "2026-01-01T00:00:00Z"), rawCard("b", "2026-01-02T00:00:00Z")] },
    "x",
  );
  expect(three.cards.map((c) => c.id)).toEqual(["c", "a", "b"]);
  expect(numbers(three)).toEqual({ a: 1, b: 2, c: 3 });
  expect(three.nextCardNumber).toBe(4);
  expect(normalizeBoard({ cards: [] }, "x").nextCardNumber).toBe(1);
});

test("numbering: partial migration starts after the highest", () => {
  const b = normalizeBoard(
    {
      cards: [
        rawCard("old", "2026-01-01T00:00:00Z"),
        rawCard("five", "2026-01-02T00:00:00Z", 5),
        rawCard("bad", "2026-01-03T00:00:00Z", 1.5),
      ],
    },
    "x",
  );
  expect(numbers(b)).toEqual({ five: 5, old: 6, bad: 7 });
  expect(b.nextCardNumber).toBe(8);
  const simple = normalizeBoard({ cards: [rawCard("five", "2026-01-01T00:00:00Z", 5), rawCard("none", "2026-01-02T00:00:00Z")] }, "x");
  expect(numbers(simple)).toEqual({ five: 5, none: 6 });
  expect(simple.nextCardNumber).toBe(7);
});

test("numbering: duplicate repair keeps the older", () => {
  const b = normalizeBoard(
    {
      nextCardNumber: 4,
      cards: [rawCard("newer", "2026-01-02T00:00:00Z", 3), rawCard("older", "2026-01-01T00:00:00Z", 3)],
    },
    "x",
  );
  expect(b.cards.map((c) => c.id)).toEqual(["newer", "older"]);
  expect(numbers(b)).toEqual({ older: 3, newer: 4 });
  expect(b.nextCardNumber).toBe(5);
});

test("numbering: counter too low is raised, higher counter kept", () => {
  const cards = [rawCard("a", "2026-01-01T00:00:00Z", 7), rawCard("b", "2026-01-02T00:00:00Z", 2)];
  expect(normalizeBoard({ nextCardNumber: 2, cards }, "x").nextCardNumber).toBe(8);
  const high = normalizeBoard({ nextCardNumber: 20, cards: [...cards, rawCard("c", "2026-01-03T00:00:00Z")] }, "x");
  expect(numbers(high)).toEqual({ a: 7, b: 2, c: 20 });
  expect(high.nextCardNumber).toBe(21);
  expect(normalizeBoard({ nextCardNumber: 20, cards }, "x").nextCardNumber).toBe(20);
});

test("numbering: load writes back only when changed", async () => {
  const legacy = tempDir("ns-legacy-");
  const legacyFile = join(legacy, "nightshift.json");
  writeFileSync(
    legacyFile,
    JSON.stringify({
      version: 1,
      name: "legacy",
      columns: [{ id: "col", name: "Backlog", type: "inert" }],
      cards: [rawCard("b", "2026-01-02T00:00:00Z"), rawCard("a", "2026-01-01T00:00:00Z")],
    }),
  );
  const migrated = new Project(legacy);
  migrated.close();
  const onDisk = JSON.parse(readFileSync(legacyFile, "utf8"));
  expect(numbers(onDisk)).toEqual({ a: 1, b: 2 });
  expect(onDisk.nextCardNumber).toBe(3);
  expect(numberingChanged(onDisk, normalizeBoard(onDisk, "legacy"))).toBe(false);

  const clean = tempDir("ns-clean-");
  const cleanFile = join(clean, "nightshift.json");
  writeFileSync(cleanFile, JSON.stringify(onDisk));
  // Pin the mtime in the past: a rewrite would move it to now.
  utimesSync(cleanFile, PAST, PAST);
  const before = { text: readFileSync(cleanFile, "utf8"), mtime: statSync(cleanFile).mtimeMs };
  const opened = new Project(clean);
  opened.close();
  expect(opened.board.nextCardNumber).toBe(3);
  expect(readFileSync(cleanFile, "utf8")).toBe(before.text);
  expect(statSync(cleanFile).mtimeMs).toBe(before.mtime);
});

test("defaultBoard has the Nightshift pipeline", () => {
  const b = defaultBoard("x");
  expect(b.columns.map((c) => c.name)).toEqual(["Backlog", "Grill", "Plan", "Implement", "Review", "To Test", "Merge", "Done"]);
  const noId = b.columns.map(({ id: _id, ...rest }) => rest);
  expect(noId).toEqual([
    { name: "Backlog", type: "inert" },
    { name: "Grill", type: "skill", skill: "nightshift-grill", model: "opus", freshSession: "auto", maxParallel: 3, emoji: "🔥" },
    { name: "Plan", type: "skill", skill: "nightshift-plan", model: "opus", freshSession: "auto", maxParallel: 3, emoji: "🗺️" },
    {
      name: "Implement",
      type: "skill",
      skill: "nightshift-implement",
      model: "sonnet",
      freshSession: "auto",
      maxParallel: 3,
      emoji: "🧑‍💻",
    },
    { name: "Review", type: "skill", skill: "nightshift-review", model: "opus", freshSession: "auto", maxParallel: 3, emoji: "🧐" },
    { name: "To Test", type: "inert", emoji: "🪲" },
    { name: "Merge", type: "skill", skill: "nightshift-merge", model: "sonnet", freshSession: "auto", maxParallel: 1, emoji: "🎉" },
    { name: "Done", type: "inert" },
  ]);
  expect(b.columns.at(-1)).toEqual({ id: DONE_COLUMN_ID, name: "Done", type: "inert" });
  for (const c of b.columns) expect("instructions" in c).toBe(false);
  expect(b.cards).toEqual([]);
  expect(b.nextCardNumber).toBe(1);
});

test("defaultBoard emojis match nightshift.json and survive normalization", () => {
  const b = defaultBoard("x");
  expect(b.columns.map((c) => c.emoji)).toEqual([
    undefined,
    "\u{1F525}",
    "\u{1F5FA}\uFE0F",
    "\u{1F9D1}\u200D\u{1F4BB}",
    "\u{1F9D0}",
    "\u{1FAB2}",
    "\u{1F389}",
    undefined,
  ]);
  expect(JSON.stringify(normalizeBoard(b, "x"))).toBe(JSON.stringify(b));
});

test("defaultBoard ids are fresh", () => {
  const ids = (b: ReturnType<typeof defaultBoard>) => b.columns.slice(1, -1).map((c) => c.id);
  const a = ids(defaultBoard("x"));
  const b = ids(defaultBoard("x"));
  expect(a.length).toBe(6);
  expect(new Set(a).size).toBe(6);
  expect(new Set(b).size).toBe(6);
  for (const id of [...a, ...b]) {
    expect(id.startsWith("col_")).toBe(true);
    expect(id).not.toBe(DONE_COLUMN_ID);
  }
  expect(a.filter((id) => b.includes(id))).toEqual([]);
});

test("opening an empty folder writes the pipeline", async () => {
  const dir = tempDir("ns-empty-");
  new Project(dir).close();
  const file = join(dir, "nightshift.json");
  const disk = JSON.parse(readFileSync(file, "utf8"));
  expect(disk.columns.map((c: Column) => c.name)).toEqual(["Backlog", "Grill", "Plan", "Implement", "Review", "To Test", "Merge", "Done"]);
  expect(disk.columns.at(-1).id).toBe(DONE_COLUMN_ID);
  const text = readFileSync(file, "utf8");
  utimesSync(file, PAST, PAST);
  const mtime = statSync(file).mtimeMs;
  new Project(dir).close();
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(statSync(file).mtimeMs).toBe(mtime);
});

test("existing custom columns are untouched", async () => {
  const dir = tempDir("ns-custom-");
  const file = join(dir, "nightshift.json");
  const board = {
    version: 1,
    name: "c",
    columns: [
      { id: BACKLOG_COLUMN_ID, name: "Backlog", type: "inert" },
      { id: "a", name: "A", type: "inert" },
      { id: DONE_COLUMN_ID, name: "Done", type: "inert" },
    ],
    cards: [],
    nextCardNumber: 1,
  };
  writeFileSync(file, `${JSON.stringify(board, null, 2)}\n`);
  const text = readFileSync(file, "utf8");
  utimesSync(file, PAST, PAST);
  const mtime = statSync(file).mtimeMs;
  const p = new Project(dir);
  p.close();
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(statSync(file).mtimeMs).toBe(mtime);
  expect(p.board.columns.map((c) => c.name)).toEqual(["Backlog", "A", "Done"]);
});

test("file without columns gets the pipeline", () => {
  const b = normalizeBoard({ cards: [] }, "x");
  expect(b.columns.map((c) => c.name)).toEqual(["Backlog", "Grill", "Plan", "Implement", "Review", "To Test", "Merge", "Done"]);
});

test("done column: normalizeBoard keeps a user column named Done and puts col_done after it", () => {
  const b = normalizeBoard(
    {
      columns: [
        { id: "u", name: "Done", type: "skill", skill: "s" },
        { id: "w", name: "W", type: "inert" },
      ],
      cards: [],
    },
    "x",
  );
  expect(b.columns.map((c) => c.id)).toEqual([BACKLOG_COLUMN_ID, "u", "w", DONE_COLUMN_ID]);
  expect(b.columns[1].name).toBe("Done");
});

test("done column: load writes col_done back once, then leaves the file alone", async () => {
  const dir = tempDir("ns-done-");
  const file = join(dir, "nightshift.json");
  writeFileSync(
    file,
    JSON.stringify({ version: 1, name: "d", columns: [{ id: "a", name: "A", type: "inert" }], cards: [], nextCardNumber: 1 }),
  );
  new Project(dir).close();
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  expect(onDisk.columns.map((c: Column) => c.id)).toEqual([BACKLOG_COLUMN_ID, DONE_COLUMN_ID]);
  utimesSync(file, PAST, PAST);
  const before = { text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs };
  new Project(dir).close();
  expect(readFileSync(file, "utf8")).toBe(before.text);
  expect(statSync(file).mtimeMs).toBe(before.mtime);
});

test("done column: nextColumn from col_done is undefined", () => {
  const dir = tempDir("ns-donenext-");
  const p = new Project(dir);
  p.close();
  expect(p.nextColumnFor({ columnId: DONE_COLUMN_ID } as Card)).toBeUndefined();
  expect(p.nextColumnFor({ columnId: must(p.board.columns.at(-2)).id } as Card)?.id).toBe(DONE_COLUMN_ID);
});

test("history cap keeps the time in timeBase", async () => {
  const { cardTimeSlices } = await import("../src/shared/timeline.ts");
  const dir = tempDir("ns-cap-");
  const p = new Project(dir);
  const [a, b] = p.board.columns.filter((c) => c.type === "inert");
  const seed = () => {
    p.mutate((bd) => {
      bd.cards.push({
        id: "k",
        number: 1,
        title: "t",
        description: "",
        columnId: a.id,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        enteredColumnAt: "2026-01-01T00:00:00.000Z",
        history: [],
      });
    });
    return p.card("k");
  };
  const card = p.board.cards[0] ?? seed();
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (i: number) => new Date(t0 + i * 60_000).toISOString();
  const full: HistoryEntry[] = [{ at: at(0), kind: "created", text: `Created in ${a.name}`, columnId: a.id }];
  for (let i = 1; i <= 60; i++) {
    const [from, to] = i % 2 ? [a, b] : [b, a];
    full.push({ at: at(i), kind: "moved", text: `Moved by user: ${from.name} → ${to.name}`, columnId: to.id });
  }
  const before = cardTimeSlices(
    { ...card, createdAt: at(0), history: full, timeBase: undefined } as unknown as Card,
    p.board.columns,
    t0 + 100 * 60_000,
  );
  card.createdAt = at(0);
  card.history = [];
  for (const e of full) {
    p.addHistory(card, e.kind, e.text, e.columnId);
    card.history[card.history.length - 1].at = e.at;
  }
  expect(card.history.length).toBeLessThanOrEqual(50);
  expect(card.timeBase).toBeDefined();
  const after = cardTimeSlices(card, p.board.columns, t0 + 100 * 60_000);
  expect(after).toEqual(before);
  p.close();
});

test("--no-agents instance never runs agents nor takes the lock", async () => {
  const { Orchestrator } = await import("../src/server/orchestrator.ts");
  const dir = tempDir("ns-noagents-");
  writeFileSync(
    join(dir, "nightshift.json"),
    JSON.stringify({
      version: 1,
      name: "n",
      columns: [{ id: "s", name: "S", type: "skill", skill: "enrich" }],
      cards: [{ id: "k", title: "t", columnId: "s", history: [] }],
    }),
  );
  const passive = new Orchestrator({ agents: false });
  const p = passive.open(dir);
  // Lets the microtask-scheduled tick run: with agents off it returns at once (Orchestrator.tick), nothing else can start it.
  await Bun.sleep(0);
  expect(must(p.card("k")).lastRun).toBeUndefined();
  expect(passive.snapshot(p).agentsDisabled).toBe(true);
  expect(passive.snapshot(p).live).toEqual({ k: "queued" });
  const { createHash } = await import("node:crypto");
  const lock = join(home, "locks", `${createHash("sha1").update(dir).digest("hex").slice(0, 12)}.lock`);
  expect(require("node:fs").existsSync(lock)).toBe(false);
  passive.shutdown();
});

test("--no-agents instance records queued but never started", async () => {
  const { Orchestrator } = await import("../src/server/orchestrator.ts");
  const dir = tempDir("ns-noagents-hist-");
  writeFileSync(
    join(dir, "nightshift.json"),
    JSON.stringify({
      version: 1,
      name: "n",
      columns: [
        { id: "i", name: "I", type: "inert" },
        { id: "s", name: "S", type: "skill", skill: "enrich" },
      ],
      cards: [{ id: "k", title: "t", columnId: "i", history: [] }],
    }),
  );
  const passive = new Orchestrator({ agents: false });
  const p = passive.open(dir);
  p.mutate((board) => p.moveCard(board, "k", "s", undefined, "Moved by user"));
  // Lets the microtask-scheduled tick run: with agents off it returns at once (Orchestrator.tick), nothing else can start it.
  await Bun.sleep(0);
  const kinds = must(p.card("k")).history.map((h) => h.kind);
  expect(kinds).toContain("queued");
  expect(kinds).not.toContain("started");
  passive.shutdown();
});
