import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { defaultBoard, normalizeBoard } from "../src/server/store.ts";
import type { Column } from "../src/shared/types.ts";
import { type ChildServer, must, removeTempDirs, startChildServer } from "./helpers.ts";

const entry = {
  features: { mcp: true, chrome: false, hooks: false, userSettings: true },
  effort: "medium",
  reason: "needs Linear",
  fingerprint: "0123456789abcdef",
  costUsd: 0.0012,
  durationMs: 3800,
  at: "2026-11-21T10:00:00.000Z",
};

test("smart-persistence: column smartMode and valid smartChoices survive a reload, corrupt entries are dropped", () => {
  const base = defaultBoard("x");
  const raw = {
    ...base,
    columns: [
      base.columns[0],
      { id: "col_a", name: "A", type: "skill", skill: "x", smartMode: false },
      { id: "col_b", name: "B", type: "inert", smartMode: true },
      { id: "col_c", name: "C", type: "skill", skill: "y", smartMode: "yes" },
      ...base.columns.slice(1),
    ],
    cards: [
      {
        id: "k",
        number: 1,
        title: "t",
        description: "d",
        columnId: "col_backlog",
        history: [],
        smartChoices: { col_a: entry, col_c: { ...entry, effort: "max" }, col_x: "nope" },
      },
      { id: "j", number: 2, title: "t", description: "d", columnId: "col_backlog", history: [], smartChoices: { col_a: 1 } },
    ],
  };
  const board = normalizeBoard(raw, "x");
  const col = (id: string) =>
    must(
      board.columns.find((c) => c.id === id),
      id,
    );
  expect(col("col_a").smartMode).toBe(false);
  expect("smartMode" in col("col_b")).toBe(false);
  expect("smartMode" in col("col_c")).toBe(false);
  expect(board.cards[0].smartChoices).toEqual({ col_a: entry } as never);
  expect("smartChoices" in board.cards[1]).toBe(false);
  expect(normalizeBoard(JSON.parse(JSON.stringify(board)), "x")).toEqual(board);
});

test("smart-persistence: a board without the new keys reloads identical", () => {
  const board = normalizeBoard(defaultBoard("x"), "x");
  expect(JSON.stringify(normalizeBoard(JSON.parse(JSON.stringify(board)), "x"))).toBe(JSON.stringify(board));
  expect(board.columns.some((c) => "smartMode" in c)).toBe(false);
});

let srv: ChildServer;
let dir = "";
beforeAll(async () => {
  srv = await startChildServer({ agents: false });
  dir = mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
});
afterAll(async () => {
  await srv?.stop();
  removeTempDirs();
});

test("smart-api: column smartMode passes through PUT /api/board on skill columns only", async () => {
  const r = await srv.call("/api/board", {
    method: "PUT",
    body: {
      project: dir,
      columns: [
        { name: "A", type: "skill", skill: "x", smartMode: false },
        { name: "B", type: "skill", skill: "y", smartMode: true },
        { name: "C", type: "skill", skill: "z" },
        { name: "D", type: "inert", smartMode: false },
        { id: "col_done", name: "Done", type: "inert" },
      ],
    },
  });
  expect(r.status).toBe(200);
  const cols: Column[] = (await (await srv.call(`/api/project?project=${encodeURIComponent(dir)}`)).json()).board.columns;
  const by = (n: string) =>
    must(
      cols.find((c) => c.name === n),
      n,
    );
  expect(by("A").smartMode).toBe(false);
  expect(by("B").smartMode).toBe(true);
  expect("smartMode" in by("C")).toBe(false);
  expect("smartMode" in by("D")).toBe(false);
});

test("smart-api: settings smartMode defaults to true and rejects a non-boolean", async () => {
  const s = await (await srv.call("/api/settings")).json();
  expect(s.smartMode).toBe(true);
  expect((await srv.call("/api/settings", { method: "PUT", body: { smartMode: "yes" } })).status).toBe(400);
});
