import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChildServer, quiet, startChildServer, waitFor } from "./helpers.ts";

const fake = join(import.meta.dir, "fake-claude.ts");
const cleanup: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

type Card = {
  id: string;
  columnId: string;
  enteredColumnAt: string;
  lastRun?: { status: string; interrupted?: boolean; sessionId?: string; summary?: string };
  history: { kind: string; text: string }[];
};

async function server(reuse?: ChildServer) {
  return startChildServer({
    agents: true,
    settings: { claudePath: fake },
    env: { FAKE_DELAY_MS: "50", FAKE_SLOW_MS: "3000" },
    ...(reuse ? { reuse } : {}),
  });
}

/** A project with Backlog, a skill column Work, Done; maxParallel 1. */
async function project(srv: ChildServer) {
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  await srv.call("/api/projects/open", { body: { path: dir } });
  const res = await srv
    .call("/api/board", {
      method: "PUT",
      body: {
        project: dir,
        maxParallel: 1,
        columns: [
          { name: "Work", type: "skill", skill: "enrich" },
          { name: "Done", type: "inert" },
        ],
      },
    })
    .then((r) => r.json());
  const cols = res.board.columns as { id: string; name: string }[];
  const work = cols.find((c) => c.name === "Work")?.id as string;
  const done = cols.find((c) => c.name === "Done")?.id as string;
  const snap = async () => srv.call(`/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());
  const card = async (id: string): Promise<Card> => (await snap()).board.cards.find((c: Card) => c.id === id);
  const create = async (title: string, columnId = work): Promise<string> =>
    (await srv.call("/api/cards", { body: { project: dir, columnId, title } }).then((r) => r.json())).id;
  const cancel = (id: string) => srv.call(`/api/cards/${id}/cancel`, { body: { project: dir } }).then((r) => r.json());
  return { dir, work, done, snap, card, create, cancel };
}

test("cancel-queued-dequeues, cancel-idle-false", async () => {
  const srv = await server();
  cleanup.push(() => srv.stop());
  const { work, done, snap, card, create, cancel } = await project(srv);
  const slow = await create("slow");
  await waitFor(async () => (await snap()).live[slow] === "running", 8000);
  const queued = await create("plain");
  await waitFor(async () => (await snap()).live[queued] === "queued", 8000);

  expect(await cancel(queued)).toEqual({ cancelled: true, was: "queued" });
  const c = await card(queued);
  expect(c.lastRun?.status).toBe("cancelled");
  expect(c.lastRun?.summary).toBe("Cancelled before it started");
  expect(c.lastRun?.interrupted).toBeUndefined();
  expect((await snap()).live[queued]).toBeUndefined();

  // The slot frees up: the cancelled card does not start.
  await waitFor(async () => !!(await card(slow)).lastRun, 15000);
  await quiet(1000);
  expect((await card(queued)).history.some((h) => h.kind === "started")).toBe(false);
  expect((await card(queued)).columnId).toBe(work);

  // Neither running nor queued.
  const idle = await create("idle", done);
  expect(await cancel(idle)).toEqual({ cancelled: false });
  // Running.
  const running = await create("slow");
  await waitFor(async () => (await snap()).live[running] === "running", 8000);
  expect(await cancel(running)).toEqual({ cancelled: true, was: "running" });
}, 40000);

test("resume-interrupted-endpoint", async () => {
  const srv = await server();
  const { dir, work, done, create } = await project(srv);
  const withSession = await create("plain", done);
  const without = await create("plain", done);
  await srv.kill("SIGTERM");
  cleanup.push(() => rmSync(srv.tmp, { recursive: true, force: true }));

  // Both were running in Work when Nightshift stopped: one had a session, the other had none yet.
  const file = join(dir, "nightshift.json");
  const board = JSON.parse(readFileSync(file, "utf8"));
  const at = new Date(Date.now() - 60_000).toISOString();
  for (const c of board.cards as Card[]) {
    if (c.id !== withSession && c.id !== without) continue;
    c.columnId = work;
    c.enteredColumnAt = at;
    c.lastRun = {
      columnId: work,
      status: "cancelled",
      interrupted: true,
      at: new Date().toISOString(),
      ...(c.id === withSession ? { sessionId: "sess-old" } : {}),
    } as Card["lastRun"];
  }
  writeFileSync(file, JSON.stringify(board, null, 2));

  const again = await server(srv);
  cleanup.push(() => again.kill("SIGTERM"));
  await again.call("/api/projects/open", { body: { path: dir } });
  await quiet(500);
  const snap = async () => again.call(`/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());
  const card = async (id: string): Promise<Card> => (await snap()).board.cards.find((c: Card) => c.id === id);
  expect((await card(withSession)).history.some((h) => h.kind === "started")).toBe(false);

  const r = await again.call("/api/resume-interrupted", { body: { project: dir } }).then((x) => x.json());
  expect(r).toEqual({ resumed: 2 });
  expect((await card(withSession)).history.some((h) => h.text === "Session resume requested by user")).toBe(true);
  expect((await card(without)).history.some((h) => h.text === "Retry requested by user")).toBe(true);
  // Both run again, then leave the interrupted state.
  await waitFor(
    async () => !(await card(withSession)).lastRun?.interrupted && !(await card(without)).lastRun?.interrupted,
    15000,
    async () => [(await card(withSession)).lastRun, (await card(without)).lastRun],
  );
  for (const id of [withSession, without]) expect((await card(id)).history.some((h) => h.kind === "started")).toBe(true);
  expect(await again.call("/api/resume-interrupted", { body: { project: dir } }).then((x) => x.json())).toEqual({ resumed: 0 });
}, 40000);
