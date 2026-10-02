import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column, ProjectSnapshot } from "../src/shared/types.ts";
import { type ChildServer, must, quiet, removeTempDirs, startChildServer, tempDir, waitFor } from "./helpers.ts";

const columns: Column[] = [
  { id: "col_backlog", name: "Backlog", type: "inert" },
  { id: "col_grill", name: "Grill", type: "skill", skill: "enrich", maxParallel: 3 },
  { id: "col_impl", name: "Implement", type: "skill", skill: "enrich", maxParallel: 3 },
  { id: "col_totest", name: "To Test", type: "inert" },
  { id: "col_done", name: "Done", type: "inert" },
];

// Stand-in for `claude`: "fail" errors, "ask" asks once, "slow" takes 2 s; resumed sessions stay quickly, others move next.
const tmp = tempDir("ns-flow-");
const fake = join(tmp, "fake-claude.ts");
writeFileSync(
  fake,
  `#!/usr/bin/env bun
const prompt = await new Response(Bun.stdin.stream()).text();
const title = prompt.match(/<title>([\\s\\S]*?)<\\/title>/)?.[1] ?? "";
const resumed = process.argv.includes("--resume") && !prompt.startsWith("New step for this card.");
const e = (o) => console.log(JSON.stringify(o));
e({ type: "system", subtype: "init", session_id: "s-" + Math.random(), model: "fake" });
await Bun.sleep(!resumed && title.includes("slow") ? 2000 : 150);
if (title.includes("fail")) e({ type: "result", is_error: true, result: "boom", session_id: "s" });
else if (title.includes("ask") && !resumed) e({ type: "result", is_error: false, session_id: "s", structured_output: { move: "stay", summary: "q", questions: ["Why?"] } });
else e({ type: "result", is_error: false, session_id: "s", structured_output: { move: resumed ? "stay" : "next", summary: "ok" } });
`,
);
chmodSync(fake, 0o755);

setDefaultTimeout(20_000);

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

async function open(srv: ChildServer, maxParallel = 3, path?: string): Promise<string> {
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
  const dir = path ?? mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
  if (!path) expect((await srv.call("/api/board", { method: "PUT", body: { project: dir, columns, maxParallel } })).status).toBe(200);
  return dir;
}

const api = (srv: ChildServer, dir: string) => {
  const q = `project=${encodeURIComponent(dir)}`;
  const snap = async (): Promise<ProjectSnapshot> => srv.call(`/api/project?${q}`).then((r) => r.json());
  const find = async (id: string): Promise<Card> => must((await snap()).board.cards.find((c) => c.id === id), "card");
  const create = async (title: string, columnId = "col_backlog", dependsOn?: string[]) =>
    (await srv
      .call("/api/cards", { body: { project: dir, columnId, title, ...(dependsOn ? { dependsOn } : {}) } })
      .then((r) => r.json())) as { id: string };
  const move = (id: string, columnId: string) => srv.call(`/api/cards/${id}/move`, { body: { project: dir, columnId } });
  const flow = (route: string) => srv.call(`/api/flow/${route}`, { body: { project: dir } });
  const starts = async (id: string) => (await find(id)).history.filter((h) => h.kind === "started").length;
  return { snap, find, create, move, flow, starts };
};

test("fast forward moves every ready card at once", async () => {
  const dir = await open(live, 2);
  const { snap, create, flow } = api(live, dir);
  const ids = [(await create("slow a")).id, (await create("slow b")).id, (await create("slow c")).id];
  expect((await (await flow("fast-forward/on")).json()).flow).toEqual({ fastForward: true, paused: false });
  let s = await snap();
  await waitFor(async () => {
    s = await snap();
    const statuses = ids.map((id) => s.live[id]);
    return statuses.filter((x) => x === "running").length === 2 && statuses.filter((x) => x === "queued").length === 1;
  });
  for (const id of ids) expect(s.board.cards.find((c) => c.id === id)?.columnId).toBe("col_grill");
  // One move each, all in a single pass.
  const moved = s.board.cards.filter((c) => ids.includes(c.id)).map((c) => c.history.find((h) => h.text.startsWith("Fast forward"))?.at);
  expect(new Set(moved).size).toBe(1);
});

test("fast forward picks cards added later and skips inert columns", async () => {
  const dir = await open(live);
  const { snap, find, create, flow } = api(live, dir);
  await flow("fast-forward/on");
  await quiet(100);
  const { id } = await create("later");
  await waitFor(async () => (await find(id)).columnId !== "col_backlog");
  expect((await find(id)).skipColumnIds).toContain("col_totest");
  expect((await snap()).flow.fastForward).toBe(true);
});

test("fast forward release gets inert skips", async () => {
  const dir = await open(live);
  const { find, create, move, flow } = api(live, dir);
  const dep = await create("dep", "col_totest");
  const held = await create("held", "col_backlog", [dep.id]);
  await flow("fast-forward/on");
  await quiet(200);
  expect((await find(held.id)).columnId).toBe("col_backlog");
  await move(dep.id, "col_done");
  await waitFor(async () => (await find(held.id)).columnId !== "col_backlog");
  expect((await find(held.id)).skipColumnIds).toContain("col_totest");
});

test("failure only stops that card", async () => {
  const dir = await open(live);
  const { find, create, flow } = api(live, dir);
  const bad = await create("fail one");
  const good = await create("good two");
  await flow("fast-forward/on");
  await waitFor(async () => (await find(good.id)).columnId === "col_done");
  const failed = await find(bad.id);
  expect(failed.columnId).toBe("col_grill");
  expect(failed.lastRun?.status).toBe("error");
});

test("pause lets the running agent finish but holds the next run", async () => {
  const dir = await open(live);
  const { snap, find, create, flow, starts } = api(live, dir);
  const { id } = await create("slow p", "col_grill");
  await waitFor(async () => (await snap()).live[id] === "running");
  expect((await (await flow("pause")).json()).flow.paused).toBe(true);
  await waitFor(async () => (await find(id)).columnId === "col_impl");
  await quiet(300);
  expect((await snap()).live[id]).toBe("paused");
  expect(await starts(id)).toBe(1);
  await flow("play");
  await waitFor(async () => (await starts(id)) === 2);
});

test("pause holds manual moves but not explicit actions", async () => {
  const dir = await open(live);
  const { snap, find, create, move, flow, starts } = api(live, dir);
  await flow("pause");
  const { id } = await create("ask q");
  await move(id, "col_grill");
  await quiet(400);
  expect((await snap()).live[id]).toBe("paused");
  expect(await starts(id)).toBe(0);

  await live.call(`/api/cards/${id}/retry`, { body: { project: dir } });
  await waitFor(async () => (await find(id)).lastRun?.status === "question");

  await live.call(`/api/cards/${id}/answer`, { body: { project: dir, answers: ["because"] } });
  await waitFor(async () => (await starts(id)) === 2 && !(await snap()).live[id]);

  expect((await live.call(`/api/cards/${id}/feedback`, { body: { project: dir, text: "again" } })).status).toBe(200);
  await waitFor(async () => (await starts(id)) === 3 && !(await snap()).live[id]);
});

test("pause stops fast forward feeding", async () => {
  const dir = await open(live);
  const { find, create, flow } = api(live, dir);
  await flow("pause");
  await flow("fast-forward/on");
  const { id } = await create("waiting");
  await quiet(300);
  expect((await find(id)).columnId).toBe("col_backlog");
  await flow("play");
  await waitFor(async () => (await find(id)).columnId !== "col_backlog");
});

test("flow routes", async () => {
  const dir = await open(live);
  const { flow } = api(live, dir);
  expect((await (await flow("fast-forward/on")).json()).flow).toEqual({ fastForward: true, paused: false });
  expect((await (await flow("pause")).json()).flow).toEqual({ fastForward: true, paused: true });
  expect((await (await flow("fast-forward/off")).json()).flow).toEqual({ fastForward: false, paused: true });
  expect((await (await flow("play")).json()).flow).toEqual({ fastForward: false, paused: false });
  expect((await live.call("/api/sequence/play", { body: { project: dir } })).status).toBe(404);

  const idleDir = await open(idle);
  for (const route of ["fast-forward/on", "fast-forward/off", "pause", "play"]) {
    const r = await api(idle, idleDir).flow(route);
    expect(r.status).toBe(409);
  }
});

test("flow state is in memory", async () => {
  const dir = await open(live);
  const { flow } = api(live, dir);
  await flow("fast-forward/on");
  await flow("pause");
  expect(readFileSync(join(dir, "nightshift.json"), "utf8")).not.toContain('"flow"');
  // Another process opening the same board starts from the default.
  await open(idle, 3, dir);
  expect((await api(idle, dir).snap()).flow).toEqual({ fastForward: false, paused: false });
});
