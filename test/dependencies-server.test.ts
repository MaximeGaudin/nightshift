import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column } from "../src/shared/types.ts";
import { type ChildServer, must, removeTempDirs, startChildServer } from "./helpers.ts";

// Routes only: a --no-agents server never runs agents nor releases cards on its own.
const columns: Column[] = [
  { id: "col_backlog", name: "Backlog", type: "inert" },
  { id: "col_grill", name: "Grill", type: "skill", skill: "enrich" },
  { id: "col_plan", name: "Plan", type: "skill", skill: "enrich" },
  { id: "col_done", name: "Done", type: "inert" },
];

let srv: ChildServer;
let dir = "";

beforeAll(async () => {
  srv = await startChildServer({ agents: false });
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
  dir = mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
  expect((await srv.call("/api/board", { method: "PUT", body: { project: dir, columns } })).status).toBe(200);
});
afterAll(async () => {
  await srv?.stop();
  removeTempDirs();
});

const q = () => `project=${encodeURIComponent(dir)}`;
const cards = async (): Promise<Card[]> => (await srv.call(`/api/project?${q()}`).then((r) => r.json())).board.cards;
const find = async (id: string) =>
  must(
    (await cards()).find((c) => c.id === id),
    "card",
  );
const create = async (body: object, columnId = "col_backlog") => {
  const r = await srv.call("/api/cards", { body: { project: dir, columnId, ...body } });
  return { status: r.status, body: await r.json() };
};
const backlog = async (body: object) => {
  const r = await srv.call("/api/backlog", { body: { project: dir, ...body } });
  return { status: r.status, body: await r.json() };
};
const patch = async (id: string, body: object) => {
  const r = await srv.call(`/api/cards/${id}`, { method: "PATCH", body: { project: dir, ...body } });
  return { status: r.status, body: r.status === 200 ? null : await r.json() };
};
const move = (id: string, columnId: string) => srv.call(`/api/cards/${id}/move`, { body: { project: dir, columnId } });
const edited = (c: Card) => c.history.filter((h) => h.kind === "edited").map((h) => h.text);

test("POST /api/backlog with dependsOn normalizes refs, numbers and ids", async () => {
  const a = (await create({ title: "a" })).body;
  const b = (await create({ title: "b" })).body;
  const x = (await create({ title: "x" })).body;
  const r = await backlog({ title: "w", dependsOn: [`#${a.number}`, b.number, x.id, `#${a.number}`] });
  expect(r.status).toBe(201);
  const w = await find(r.body.id);
  expect(w.dependsOn).toEqual([a.id, b.id, x.id]);
  expect(w.columnId).toBe("col_backlog");

  const unknown = await backlog({ title: "u", dependsOn: ["#999"] });
  expect(unknown.status).toBe(400);
  expect(unknown.body.error).toBe("Unknown card in dependsOn: #999");
  expect((await backlog({ title: "u", dependsOn: "#1" })).body.error).toBe("dependsOn must be an array");
  expect(Object.hasOwn(await find((await backlog({ title: "none", dependsOn: [] })).body.id), "dependsOn")).toBe(false);

  const outside = await create({ title: "o", dependsOn: [a.id] }, "col_plan");
  expect(outside.status).toBe(400);
  expect(outside.body.error).toBe("dependsOn requires the Backlog column");
});

test("a card whose dependencies are all already in Done leaves Backlog at creation", async () => {
  const d = (await create({ title: "d" })).body;
  await move(d.id, "col_done");
  const r = await create({ title: "w", dependsOn: [`#${d.number}`], skipColumnIds: ["col_grill"] });
  const w = await find(r.body.id);
  expect(w.columnId).toBe("col_plan");
  expect(Object.hasOwn(w, "dependsOn")).toBe(false);
  expect(w.history.some((h) => h.text === `Dependencies done (#${d.number}): Backlog → Plan`)).toBe(true);
});

test("PATCH dependsOn: edit in Backlog, cycle and outside Backlog refused, clearing releases", async () => {
  const a = (await create({ title: "a" })).body;
  const b = (await create({ title: "b" })).body;
  const w = (await create({ title: "w" })).body;

  expect((await patch(w.id, { dependsOn: [`#${a.number}`, `#${b.number}`] })).status).toBe(200);
  let card = await find(w.id);
  expect(card.dependsOn).toEqual([a.id, b.id]);
  expect(edited(card)).toEqual([`Dependencies: #${a.number}, #${b.number}`]);

  expect((await patch(w.id, { dependsOn: [b.id] })).status).toBe(200);
  card = await find(w.id);
  expect(card.dependsOn).toEqual([b.id]);
  expect(card.columnId).toBe("col_backlog");

  // b -> w would close w -> b.
  const cycle = await patch(b.id, { dependsOn: [w.id] });
  expect(cycle.status).toBe(400);
  expect(cycle.body.error).toBe(`Dependency cycle: #${b.number} → #${w.number} → #${b.number}`);
  expect(Object.hasOwn(await find(b.id), "dependsOn")).toBe(false);

  expect((await patch(w.id, { dependsOn: [w.id] })).body?.error).toBe("A card cannot depend on itself");

  await move(a.id, "col_plan");
  const outside = await patch(a.id, { dependsOn: [b.id] });
  expect(outside.status).toBe(400);
  expect(outside.body?.error).toBe("Dependencies can only be edited in Backlog");

  expect((await patch(w.id, { dependsOn: [] })).status).toBe(200);
  card = await find(w.id);
  expect(card.columnId).toBe("col_grill");
  expect(Object.hasOwn(card, "dependsOn")).toBe(false);
  expect(edited(card)).toContain("Dependencies cleared");
  expect(card.history.some((h) => h.text === "Dependencies cleared: Backlog → Grill")).toBe(true);
});

test("deleting a dependency drops it, records it and releases the card when nothing is left to wait for", async () => {
  const d1 = (await create({ title: "d1" })).body;
  const d2 = (await create({ title: "d2" })).body;
  await move(d1.id, "col_grill");
  await move(d2.id, "col_done");
  const x = (await create({ title: "x", dependsOn: [d1.id, d2.id] })).body;
  const y = (await create({ title: "y", dependsOn: [d1.id] })).body;
  const z = (await create({ title: "z", dependsOn: [d1.id, x.id] })).body;
  expect((await find(x.id)).columnId).toBe("col_backlog");

  expect((await srv.call(`/api/cards/${d1.id}?${q()}`, { method: "DELETE" })).status).toBe(200);
  const cx = await find(x.id);
  expect(edited(cx)).toContain(`Dependency #${d1.number} deleted`);
  expect(cx.columnId).toBe("col_grill");
  expect(Object.hasOwn(cx, "dependsOn")).toBe(false);
  expect(cx.history.some((h) => h.text === `Dependencies done (#${d2.number}): Backlog → Grill`)).toBe(true);

  const cy = await find(y.id);
  expect(cy.columnId).toBe("col_grill");
  expect(cy.history.some((h) => h.text === "Dependencies cleared: Backlog → Grill")).toBe(true);

  // z still waits for x, which is not in Done.
  const cz = await find(z.id);
  expect(cz.columnId).toBe("col_backlog");
  expect(cz.dependsOn).toEqual([x.id]);
});
