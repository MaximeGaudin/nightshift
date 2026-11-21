import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
const putColumns = (columns: object[]) => srv.call("/api/board", { method: "PUT", body: { project: dir, columns } });
const newCard = async (): Promise<string> => {
  const r = await srv.call("/api/cards", { body: { project: dir, columnId: "col_backlog", title: "t" } });
  return (await r.json()).id;
};

beforeAll(async () => {
  srv = await startChildServer({ agents: false });
  dir = mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
});
afterAll(async () => {
  await srv?.stop();
  removeTempDirs();
});

test("invalid settings value: 400 and nothing written", async () => {
  const before = await (await srv.call("/api/settings")).json();
  for (const agentFeatures of [{ mcp: "yes" }, { nope: true }, null, "x"]) {
    const r = await srv.call("/api/settings", { method: "PUT", body: { agentFeatures } });
    expect(r.status).toBe(400);
  }
  expect(await (await srv.call("/api/settings")).json()).toEqual(before);
  expect(before.agentFeatures).toEqual({});
});

test("valid settings value is stored", async () => {
  const r = await srv.call("/api/settings", { method: "PUT", body: { agentFeatures: { chrome: true } } });
  expect(r.status).toBe(200);
  expect((await (await srv.call("/api/settings")).json()).agentFeatures).toEqual({ chrome: true });
});

test("card: invalid 400, valid stored with one history entry, null clears", async () => {
  const id = await newCard();
  const before = await find(id);
  expect((await patch(id, { agentFeatures: { hooks: 1 }, title: "changed" })).status).toBe(400);
  expect(await find(id)).toEqual(before);
  expect((await patch(id, { agentFeatures: { mcp: true } })).status).toBe(200);
  let card = await find(id);
  expect(card.agentFeatures).toEqual({ mcp: true });
  expect(card.history.filter((h) => h.kind === "edited").map((h) => h.text)).toEqual(["Agent features: mcp=on (by user)"]);
  await patch(id, { agentFeatures: null });
  card = await find(id);
  expect("agentFeatures" in card).toBe(false);
});

test("columns: invalid 400, valid round-trips, never {} and never on inert columns", async () => {
  const cols: Column[] = (await snapshot()).board.columns;
  const skill = must(
    cols.find((c) => c.type === "skill"),
    "skill column",
  );
  const withFeatures = (patchOf: object) => cols.map((c) => (c.id === skill.id ? { ...c, ...patchOf } : c));
  expect((await putColumns(withFeatures({ agentFeatures: { bogus: true } }))).status).toBe(400);
  expect((await putColumns(withFeatures({ agentFeatures: { chrome: true } }))).status).toBe(200);
  let now: Column[] = (await snapshot()).board.columns;
  expect(now.find((c) => c.id === skill.id)?.agentFeatures).toEqual({ chrome: true });
  // A client that never heard of the field sends the column back as it read it: the value comes back with it.
  expect((await putColumns(now)).status).toBe(200);
  expect((await snapshot()).board.columns.find((c: Column) => c.id === skill.id).agentFeatures).toEqual({ chrome: true });
  expect((await putColumns(withFeatures({ agentFeatures: {} }))).status).toBe(200);
  now = (await snapshot()).board.columns;
  expect("agentFeatures" in (now.find((c) => c.id === skill.id) as Column)).toBe(false);
  const inert = must(
    now.find((c) => c.type === "inert" && c.id !== "col_done" && c.id !== "col_backlog"),
    "inert column",
  );
  await putColumns(now.map((c) => (c.id === inert.id ? { ...c, agentFeatures: { mcp: true } } : c)));
  expect("agentFeatures" in ((await snapshot()).board.columns.find((c: Column) => c.id === inert.id) as Column)).toBe(false);
});
