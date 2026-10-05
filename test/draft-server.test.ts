import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column, ProjectSnapshot } from "../src/shared/types.ts";
import { type ChildServer, must, removeTempDirs, startChildServer, tempDir, waitFor } from "./helpers.ts";

const columns: Column[] = [
  { id: "col_backlog", name: "Backlog", type: "inert" },
  { id: "col_grill", name: "Grill", type: "skill", skill: "enrich", maxParallel: 3 },
  { id: "col_done", name: "Done", type: "inert" },
];

const tmp = tempDir("ns-draft-");
const fake = join(tmp, "fake-claude.ts");
writeFileSync(
  fake,
  `#!/usr/bin/env bun
await new Response(Bun.stdin.stream()).text();
const e = (o) => console.log(JSON.stringify(o));
e({ type: "system", subtype: "init", session_id: "s-" + Math.random(), model: "fake" });
await Bun.sleep(150);
e({ type: "result", is_error: false, session_id: "s", structured_output: { move: "stay", summary: "ok" } });
`,
);
chmodSync(fake, 0o755);
setDefaultTimeout(20_000);

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer({ agents: true, settings: { claudePath: fake } });
});
afterAll(async () => {
  await srv?.stop();
  removeTempDirs();
});

async function setup() {
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
  expect((await srv.call("/api/board", { method: "PUT", body: { project: dir, columns } })).status).toBe(200);
  const q = `project=${encodeURIComponent(dir)}`;
  const snap = async (): Promise<ProjectSnapshot> => srv.call(`/api/project?${q}`).then((r) => r.json());
  const find = async (id: string): Promise<Card> =>
    must(
      (await snap()).board.cards.find((c) => c.id === id),
      "card",
    );
  const create = async (title: string, extra: object = {}) =>
    (await srv.call("/api/backlog", { body: { project: dir, title, ...extra } }).then((r) => r.json())) as { id: string };
  const patch = (id: string, body: object) => srv.call(`/api/cards/${id}`, { method: "PATCH", body: { project: dir, ...body } });
  const move = (id: string, columnId: string) => srv.call(`/api/cards/${id}/move`, { body: { project: dir, columnId } });
  const flow = (route: string) => srv.call(`/api/flow/${route}`, { body: { project: dir } });
  return { dir, q, snap, find, create, patch, move, flow };
}

test("draft: fast forward ignores a draft card, also one added while it is on", async () => {
  const { find, create, flow } = await setup();
  const before = await create("early draft", { draft: true });
  const plain = await create("plain");
  await flow("fast-forward/on");
  await waitFor(async () => (await find(plain.id)).columnId !== "col_backlog");
  const late = await create("late draft", { draft: true });
  const plain2 = await create("plain two");
  await waitFor(async () => (await find(plain2.id)).columnId !== "col_backlog");
  for (const id of [before.id, late.id]) {
    const c = await find(id);
    expect(c.columnId).toBe("col_backlog");
    expect(c.draft).toBe(true);
  }
  expect("draft" in (await find(plain.id))).toBe(false);
});

test("draft: stays in Backlog when its dependencies finish, deleted or cleared", async () => {
  const { find, create, patch, move, dir, q } = await setup();
  const a = await create("a");
  const b = await create("b");
  const c = await create("c");
  const d1 = await create("d1", { draft: true, dependsOn: [a.id] });
  const d2 = await create("d2", { draft: true, dependsOn: [b.id] });
  const d3 = await create("d3", { draft: true, dependsOn: [c.id] });
  await move(a.id, "col_done");
  expect((await srv.call(`/api/cards/${b.id}?${q}`, { method: "DELETE" })).status).toBe(200);
  expect((await patch(d3.id, { dependsOn: [] })).status).toBe(200);
  await Bun.sleep(400);
  for (const id of [d1.id, d2.id, d3.id]) expect((await find(id)).columnId).toBe("col_backlog");
  expect((await find(d1.id)).dependsOn).toEqual([a.id]);
  void dir;
});

test("draft: clearing the flag releases a ready card", async () => {
  const { find, create, patch, move } = await setup();
  const a = await create("a");
  const x = await create("x", { draft: true, dependsOn: [a.id] });
  await move(a.id, "col_done");
  await Bun.sleep(300);
  expect((await find(x.id)).columnId).toBe("col_backlog");
  expect((await patch(x.id, { draft: false })).status).toBe(200);
  await waitFor(async () => (await find(x.id)).columnId !== "col_backlog");
});

test("draft: clearing the flag lets fast forward take the card", async () => {
  const { find, create, patch, flow } = await setup();
  const x = await create("x", { draft: true });
  await flow("fast-forward/on");
  await Bun.sleep(300);
  expect((await find(x.id)).columnId).toBe("col_backlog");
  await patch(x.id, { draft: false });
  await waitFor(async () => (await find(x.id)).columnId !== "col_backlog");
});

test("draft: a manual move leaves Backlog and drops the flag", async () => {
  const { find, create, move } = await setup();
  const x = await create("x", { draft: true });
  expect((await move(x.id, "col_done")).status).toBe(200);
  const c = await find(x.id);
  expect(c.columnId).toBe("col_done");
  expect("draft" in c).toBe(false);
});

test("draft: refused outside Backlog or when not a boolean", async () => {
  const { dir, create, patch, move } = await setup();
  const x = await create("x");
  await move(x.id, "col_done");
  expect((await patch(x.id, { draft: true })).status).toBe(400);
  expect((await patch(x.id, { draft: false })).status).toBe(200);
  const mk = (body: object) => srv.call("/api/cards", { body: { project: dir, title: "t", ...body } });
  expect((await mk({ columnId: "col_grill", draft: true })).status).toBe(400);
  expect((await mk({ columnId: "col_backlog", draft: "yes" })).status).toBe(400);
  expect((await srv.call("/api/backlog", { body: { project: dir, title: "t", draft: "yes" } })).status).toBe(400);
});

test("draft: toggling the flag adds no history entry", async () => {
  const { find, create, patch } = await setup();
  const x = await create("x");
  const n = (await find(x.id)).history.length;
  await patch(x.id, { draft: true });
  expect((await find(x.id)).draft).toBe(true);
  await patch(x.id, { draft: false });
  const c = await find(x.id);
  expect("draft" in c).toBe(false);
  expect(c.history.length).toBe(n);
});
