import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column } from "../src/shared/types.ts";
import { type ChildServer, must, removeTempDirs, startChildServer } from "./helpers.ts";

let srv: ChildServer;
let dir = "";
const q = (d: string) => `project=${encodeURIComponent(d)}`;
const snapshot = () => srv.call(`/api/project?${q(dir)}`).then((r) => r.json());
const putBoard = (columns: object[]) => srv.call("/api/board", { method: "PUT", body: { project: dir, columns } });
const patch = (id: string, body: object) => srv.call(`/api/cards/${id}`, { method: "PATCH", body: { project: dir, ...body } });

beforeAll(async () => {
  srv = await startChildServer({ agents: false });
  dir = mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
});
afterAll(async () => {
  await srv?.stop();
  removeTempDirs();
});

test("invalid column effort: 400 and board file unchanged", async () => {
  const file = join(dir, "nightshift.json");
  const before = readFileSync(file, "utf8");
  const r = await putBoard([
    { name: "A", type: "skill", skill: "x", effort: "turbo" },
    { id: "col_done", name: "Done", type: "inert" },
  ]);
  expect(r.status).toBe(400);
  expect(readFileSync(file, "utf8")).toBe(before);
});

test("valid column effort kept on skill columns, dropped on inert ones", async () => {
  const r = await putBoard([
    { name: "A", type: "skill", skill: "x", effort: " high " },
    { name: "B", type: "inert", effort: "low" },
    { name: "C", type: "skill", skill: "y", effort: "" },
    { id: "col_done", name: "Done", type: "inert" },
  ]);
  expect(r.status).toBe(200);
  const cols: Column[] = (await snapshot()).board.columns;
  const by = (n: string) => must(cols.find((c) => c.name === n), n);
  expect(by("A").effort).toBe("high");
  expect("effort" in by("B")).toBe(false);
  expect("effort" in by("C")).toBe(false);
});

test("card efforts: invalid PATCH 400, valid persisted, cleared with {}", async () => {
  const id = (await (await srv.call("/api/cards", { body: { project: dir, columnId: "col_backlog", title: "t" } })).json()).id;
  for (const efforts of [{ x: "turbo" }, { x: "default" }, { "Bad Key": "low" }, "low"]) {
    expect((await patch(id, { efforts })).status).toBe(400);
  }
  expect((await patch(id, { efforts: { "nightshift-merge": "low" } })).status).toBe(200);
  let card: Card = must((await snapshot()).board.cards.find((c: Card) => c.id === id), "card");
  expect(card.efforts).toEqual({ "nightshift-merge": "low" });
  expect((await patch(id, { efforts: {} })).status).toBe(200);
  card = must((await snapshot()).board.cards.find((c: Card) => c.id === id), "card");
  expect("efforts" in card).toBe(false);
});

test("settings effort: invalid 400, valid kept", async () => {
  expect((await srv.call("/api/settings", { method: "PUT", body: { effort: "turbo" } })).status).toBe(400);
  expect((await srv.call("/api/settings", { method: "PUT", body: { effort: "inherit" } })).status).toBe(200);
  expect((await (await srv.call("/api/settings")).json()).effort).toBe("inherit");
  expect((await srv.call("/api/settings", { method: "PUT", body: { effort: "" } })).status).toBe(200);
});

test("loading a board file cleans invalid efforts", async () => {
  const d2 = mkdtempSync(join(srv.tmp, "proj-"));
  writeFileSync(
    join(d2, "nightshift.json"),
    JSON.stringify({
      version: 1,
      name: "p",
      columns: [
        { id: "col_backlog", name: "Backlog", type: "inert" },
        { id: "c1", name: "S", type: "skill", skill: "x", effort: "bad" },
        { id: "c2", name: "I", type: "inert", effort: "low" },
        { id: "col_done", name: "Done", type: "inert" },
      ],
      cards: [{ id: "k1", title: "t", description: "", columnId: "c1", efforts: { a: "bad", b: "low" }, history: [] }],
      nextCardNumber: 2,
    }),
  );
  expect((await srv.call("/api/projects/open", { body: { path: d2 } })).status).toBe(200);
  const b = (await (await srv.call(`/api/project?${q(d2)}`)).json()).board;
  expect(b.cards[0].efforts).toEqual({ b: "low" });
  expect(b.columns.some((c: Column) => "effort" in c)).toBe(false);
});
