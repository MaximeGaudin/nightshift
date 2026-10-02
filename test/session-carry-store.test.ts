import { afterAll, beforeAll, expect, test } from "bun:test";
import { normalizeBoard } from "../src/server/store.ts";
import type { Card, Column } from "../src/shared/types.ts";
import { type ChildServer, startChildServer } from "./helpers.ts";

const modeOf = (board: { columns: Column[] }, id: string) => board.columns.find((c) => c.id === id)?.freshSession;

test("store round-trip: freshSession keeps auto and true, drops anything else, and a second pass changes nothing", () => {
  const raw = {
    columns: [
      { id: "a", name: "A", type: "skill", skill: "s", freshSession: "auto" },
      { id: "b", name: "B", type: "skill", skill: "s", freshSession: true },
      { id: "c", name: "C", type: "skill", skill: "s" },
      { id: "d", name: "D", type: "skill", skill: "s", freshSession: false },
      { id: "e", name: "E", type: "skill", skill: "s", freshSession: "x" },
      { id: "f", name: "F", type: "inert", freshSession: "auto" },
    ],
    cards: [],
  };
  const board = normalizeBoard(raw, "x");
  expect(["a", "b", "c", "d", "e", "f"].map((id) => modeOf(board, id))).toEqual(["auto", true, undefined, undefined, undefined, undefined]);
  expect(normalizeBoard(JSON.parse(JSON.stringify(board)), "x")).toEqual(board);
});

test("store round-trip: lastRun.contextTokens survives a reload", () => {
  const card = {
    id: "k",
    number: 1,
    title: "t",
    description: "",
    columnId: "a",
    enteredColumnAt: "2026-01-01T00:00:00Z",
    history: [],
    lastRun: { columnId: "a", status: "success", at: "2026-01-01T00:00:01Z", contextTokens: 62000 },
  };
  const board = normalizeBoard({ columns: [{ id: "a", name: "A", type: "skill", skill: "s" }], cards: [card] }, "x");
  const reloaded = normalizeBoard(JSON.parse(JSON.stringify(board)), "x");
  expect((reloaded.cards[0] as Card).lastRun?.contextTokens).toBe(62000);
});

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer();
});
afterAll(() => srv.stop());

test("settings: the carry thresholds default to 80000 tokens and 5 minutes", async () => {
  const s = await srv.call("/api/settings").then((r) => r.json());
  expect([s.carryMaxTokens, s.carryMaxAgeMinutes]).toEqual([80000, 5]);
});

test("settings: invalid thresholds are rejected with a 400, valid ones persist", async () => {
  for (const patch of [
    { carryMaxTokens: -1 },
    { carryMaxTokens: 1.5 },
    { carryMaxTokens: "a" },
    { carryMaxAgeMinutes: 0 },
    { carryMaxAgeMinutes: 2.5 },
  ]) {
    const res = await srv.call("/api/settings", { method: "PUT", body: patch });
    expect(res.status).toBe(400);
  }
  const ok = await srv.call("/api/settings", { method: "PUT", body: { carryMaxTokens: 0, carryMaxAgeMinutes: 10 } });
  expect(ok.status).toBe(200);
  const s = await srv.call("/api/settings").then((r) => r.json());
  expect([s.carryMaxTokens, s.carryMaxAgeMinutes]).toEqual([0, 10]);
});

test("board API: a skill column saved with auto comes back as auto", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  await srv.call("/api/projects/open", { body: { path: dir } });
  const res = await srv
    .call("/api/board", {
      method: "PUT",
      body: {
        project: dir,
        columns: [
          { name: "A", type: "skill", skill: "s", freshSession: "auto" },
          { name: "Done", type: "inert" },
        ],
      },
    })
    .then((r) => r.json());
  expect((res.board.columns as Column[]).find((c) => c.name === "A")?.freshSession).toBe("auto");
});
