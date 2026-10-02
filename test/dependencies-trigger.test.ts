import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column } from "../src/shared/types.ts";
import { type ChildServer, must, quiet, removeTempDirs, startChildServer, tempDir, waitFor } from "./helpers.ts";

const columns: Column[] = [
  { id: "col_backlog", name: "Backlog", type: "inert" },
  { id: "col_grill", name: "Grill", type: "skill", skill: "enrich" },
  { id: "col_plan", name: "Plan", type: "skill", skill: "enrich" },
  { id: "col_done", name: "Done", type: "inert" },
];

// Stand-in for `claude`: every run keeps the card where it is.
const tmp = tempDir("ns-deps-trigger-");
const fake = join(tmp, "fake-claude.ts");
writeFileSync(
  fake,
  `#!/usr/bin/env bun
await new Response(Bun.stdin.stream()).text();
const e = (o) => console.log(JSON.stringify(o));
e({ type: "system", subtype: "init", session_id: "s", model: "fake" });
e({ type: "result", is_error: false, session_id: "s", structured_output: { move: "stay", summary: "ok" } });
`,
);
chmodSync(fake, 0o755);

let live: ChildServer;
let idle: ChildServer;

beforeAll(async () => {
  live = await startChildServer({ agents: true, settings: { claudePath: fake } });
  idle = await startChildServer({ agents: false });
});
afterAll(async () => {
  await live?.stop();
  await idle?.stop();
  removeTempDirs();
});

async function open(srv: ChildServer, d?: string): Promise<string> {
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
  const path = d ?? mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path } })).status).toBe(200);
  if (!d) expect((await srv.call("/api/board", { method: "PUT", body: { project: path, columns } })).status).toBe(200);
  return path;
}

const api = (srv: ChildServer, dir: string) => {
  const q = `project=${encodeURIComponent(dir)}`;
  const find = async (id: string): Promise<Card> =>
    must(
      (await srv.call(`/api/project?${q}`).then((r) => r.json())).board.cards.find((c: Card) => c.id === id),
      "card",
    );
  const create = async (title: string, columnId: string, dependsOn?: string[]) =>
    (await srv
      .call("/api/cards", { body: { project: dir, columnId, title, ...(dependsOn ? { dependsOn } : {}) } })
      .then((r) => r.json())) as {
      id: string;
      number: number;
    };
  const move = (id: string, columnId: string) => srv.call(`/api/cards/${id}/move`, { body: { project: dir, columnId } });
  return { find, create, move };
};

test("a held card waits for all its dependencies, then enters the next column and its agent starts", async () => {
  const dir = await open(live);
  const { find, create, move } = api(live, dir);
  const d1 = await create("d1", "col_plan");
  const d2 = await create("d2", "col_plan");
  const x = await create("x", "col_backlog", [d1.id, d2.id]);

  await move(d1.id, "col_done");
  await quiet();
  expect((await find(x.id)).columnId).toBe("col_backlog");

  await move(d2.id, "col_done");
  await waitFor(async () => (await find(x.id)).columnId === "col_grill");
  await waitFor(async () => (await find(x.id)).lastRun?.columnId === "col_grill");
  const card = await find(x.id);
  expect(Object.hasOwn(card, "dependsOn")).toBe(false);
  expect(card.history.some((h) => h.text === `Dependencies done (#${d1.number}, #${d2.number}): Backlog → Grill`)).toBe(true);

  // A dependency leaving Done afterwards changes nothing.
  await move(d1.id, "col_plan");
  await quiet();
  expect((await find(x.id)).columnId).toBe("col_grill");
});

test("no ready card: changes do not cause extra writes", async () => {
  const dir = await open(live);
  const { find, create } = api(live, dir);
  const d = await create("d", "col_plan");
  const x = await create("x", "col_backlog", [d.id]);
  await live.call(`/api/cards/${x.id}`, { method: "PATCH", body: { project: dir, title: "x2" } });
  await quiet();
  const file = join(dir, "nightshift.json");
  const mtime = statSync(file).mtimeMs;
  await quiet();
  expect(statSync(file).mtimeMs).toBe(mtime);
  expect((await find(x.id)).columnId).toBe("col_backlog");
});

test("a held card moved out of Backlog by hand is never moved by its dependencies", async () => {
  const dir = await open(live);
  const { find, create, move } = api(live, dir);
  const d = await create("d", "col_plan");
  const x = await create("x", "col_backlog", [d.id]);
  await move(x.id, "col_plan");
  await move(d.id, "col_done");
  await quiet();
  const card = await find(x.id);
  expect(card.columnId).toBe("col_plan");
  expect(card.dependsOn).toEqual([d.id]);
});

test("--no-agents never releases; the instance that runs agents catches up when it opens the project", async () => {
  const dir = await open(idle);
  const { find, create, move } = api(idle, dir);
  const d = await create("d", "col_plan");
  const x = await create("x", "col_backlog", [d.id]);
  await move(d.id, "col_done");
  await quiet();
  expect((await find(x.id)).columnId).toBe("col_backlog");

  await open(live, dir);
  const onLive = api(live, dir);
  await waitFor(async () => (await onLive.find(x.id)).columnId === "col_grill");
  expect(Object.hasOwn(await onLive.find(x.id), "dependsOn")).toBe(false);
});
