import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column } from "../src/shared/types.ts";
import { type ChildServer, must, removeTempDirs, startChildServer } from "./helpers.ts";

let srv: ChildServer;
let dir = "";
const q = (d: string) => `project=${encodeURIComponent(d)}`;
const snapshot = () => srv.call(`/api/project?${q(dir)}`).then((r) => r.json());
const find = async (id: string): Promise<Card> =>
  must(
    (await snapshot()).board.cards.find((c: Card) => c.id === id),
    "card",
  );
const patch = (id: string, body: object) => srv.call(`/api/cards/${id}`, { method: "PATCH", body: { project: dir, ...body } });
const edits = (c: Card) => c.history.filter((h) => h.kind === "edited").map((h) => h.text);
const newCard = async (): Promise<string> => {
  const r = await srv.call("/api/cards", { body: { project: dir, columnId: "col_backlog", title: "t" } });
  return (await r.json()).id;
};

beforeAll(async () => {
  srv = await startChildServer({ agents: false });
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
  dir = mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
});
afterAll(async () => {
  await srv?.stop();
  removeTempDirs();
});

test("invalid models: 400 naming the entry, nothing written", async () => {
  const id = await newCard();
  const before = await find(id);
  for (const models of [{ "nightshift-implement": "opus; rm" }, { "nightshift-implement": "default" }, { "Bad Key": "opus" }, "opus"]) {
    const r = await patch(id, { models, title: "changed" });
    expect(r.status).toBe(400);
    if (typeof models === "object") expect((await r.json()).error).toContain(Object.keys(models)[0]);
  }
  expect(await find(id)).toEqual(before);
});

test("valid set replaces the map; models-only adds only the Models entry", async () => {
  const id = await newCard();
  expect((await patch(id, { models: { "nightshift-plan": "opus", "nightshift-review": "haiku" } })).status).toBe(200);
  let card = await find(id);
  expect(card.models).toEqual({ "nightshift-plan": "opus", "nightshift-review": "haiku" });
  expect(edits(card)).toEqual(["Models: nightshift-plan=opus, nightshift-review=haiku (by user)"]);

  await patch(id, { models: { "nightshift-plan": "opus", "nightshift-review": "haiku" } });
  expect(edits(await find(id))).toHaveLength(1);

  await patch(id, { models: { "nightshift-plan": "sonnet" } });
  card = await find(id);
  expect(card.models).toEqual({ "nightshift-plan": "sonnet" });
  expect(edits(card).at(-1)).toBe("Models: nightshift-plan=sonnet, nightshift-review removed (by user)");
  expect(edits(card)).not.toContain("Edited by user");
});

test("clear with {} or null deletes the map, once", async () => {
  for (const empty of [{}, null]) {
    const id = await newCard();
    await patch(id, { models: { "nightshift-plan": "opus" } });
    expect((await patch(id, { models: empty })).status).toBe(200);
    const card = await find(id);
    expect(Object.hasOwn(card, "models")).toBe(false);
    expect(edits(card)).toEqual(["Models: nightshift-plan=opus (by user)", "Models: nightshift-plan removed (by user)"]);
    await patch(id, { models: empty });
    expect(edits(await find(id))).toHaveLength(2);
  }
});

test("PUT board keeps lockModel on skill columns only", async () => {
  const columns: Column[] = [
    { id: "col_backlog", name: "Backlog", type: "inert", lockModel: true } as Column,
    { id: "a", name: "A", type: "skill", skill: "enrich", lockModel: true },
    { id: "b", name: "B", type: "skill", skill: "enrich", lockModel: false } as unknown as Column,
    { id: "c", name: "C", type: "inert", lockModel: true } as Column,
    { id: "col_done", name: "Done", type: "inert", lockModel: true } as Column,
  ];
  const r = await srv.call("/api/board", { method: "PUT", body: { project: dir, columns } });
  expect(r.status).toBe(200);
  const cols: Column[] = (await snapshot()).board.columns;
  const lock = (id: string) => cols.find((c) => c.id === id)?.lockModel;
  expect(lock("a")).toBe(true);
  expect(lock("b")).toBeUndefined();
  expect(lock("c")).toBeUndefined();
  expect(lock("col_backlog")).toBeUndefined();
  expect(lock("col_done")).toBeUndefined();
});
