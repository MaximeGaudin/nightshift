import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, ProjectSnapshot } from "../src/shared/types.ts";
import { type ChildServer, startChildServer, waitFor } from "./helpers.ts";

// Own child process and NIGHTSHIFT_HOME: see helpers.ts. Each scenario opens its own projects.
let srv: ChildServer;

beforeAll(async () => {
  srv = await startChildServer({
    agents: true,
    settings: { claudePath: join(import.meta.dir, "fake-claude.ts") },
    env: { FAKE_DELAY_MS: "600" },
  });
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
});
afterAll(() => srv?.stop());

const json = (path: string, body?: object, method?: string) => srv.call(path, { body, method }).then((r) => r.json());
const snapshot = (dir: string): Promise<ProjectSnapshot> => json(`/api/project?project=${encodeURIComponent(dir)}`);
const setCap = (dir: string, maxParallel: number) => json("/api/board", { project: dir, maxParallel }, "PUT");
const running = (s: ProjectSnapshot) =>
  Object.values(s.live).filter((v) => v === "running").length + s.quickRuns.filter((q) => q.status === "running").length;

/** Fresh project: one skill column (with its own limit) before Done, and the given project cap. */
async function project(cap: number, columnCap: number) {
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  await json("/api/projects/open", { path: dir });
  const res = await json(
    "/api/board",
    { project: dir, maxParallel: cap, columns: [{ name: "Work", type: "skill", skill: "enrich", maxParallel: columnCap }] },
    "PUT",
  );
  const work = res.board.columns.find((c: { name: string }) => c.name === "Work");
  const add = async (title: string): Promise<string> => (await json("/api/cards", { project: dir, columnId: work.id, title })).id;
  return { dir, work, add };
}

/** Polls the project until no agent runs or waits, and returns the highest number of agents seen at once. */
async function peak(dir: string, ms = 20000) {
  let max = 0;
  await waitFor(async () => {
    const s = await snapshot(dir);
    max = Math.max(max, running(s));
    return Object.keys(s.live).length === 0 && s.quickRuns.length === 0;
  }, ms);
  return max;
}

const card = async (dir: string, id: string): Promise<Card | undefined> => (await snapshot(dir)).board.cards.find((c) => c.id === id);

test("project-cap-limits-running: cards and quick runs together never exceed the project cap", async () => {
  const { dir, add } = await project(2, 5);
  await json("/api/quick-runs", { project: dir, skill: "enrich", instruction: "go" });
  for (const t of ["a", "b", "c", "d"]) await add(t);
  expect(await peak(dir)).toBe(2);
}, 30000);

test("project-cap-independent: a full project does not block another one", async () => {
  const one = await project(1, 5);
  const two = await project(1, 5);
  await one.add("slow");
  await two.add("slow");
  await waitFor(async () => running(await snapshot(one.dir)) === 1 && running(await snapshot(two.dir)) === 1);
  await Promise.all([peak(one.dir), peak(two.dir)]);
}, 30000);

test("project-cap-raise-starts-queued: raising the cap starts the waiting card at once", async () => {
  const { dir, add } = await project(1, 5);
  const first = await add("slow");
  const second = await add("slow");
  await waitFor(async () => {
    const s = await snapshot(dir);
    return s.live[first] === "running" && s.live[second] === "queued";
  });
  await setCap(dir, 2);
  // Well before the first card's ~5 s run ends.
  await waitFor(async () => (await snapshot(dir)).live[second] === "running", 2000);
  await peak(dir);
}, 30000);

test("project-cap-lower-keeps-running: lowering the cap stops nothing, later cards wait", async () => {
  const { dir, add } = await project(2, 5);
  const a = await add("slow");
  const b = await add("slow");
  await waitFor(async () => running(await snapshot(dir)) === 2);
  const c = await add("slow");
  await setCap(dir, 1);
  await waitFor(async () => {
    const s = await snapshot(dir);
    // The third card waits until both running ones are done.
    if (s.live[c] === "running") {
      expect(s.live[a]).toBeUndefined();
      expect(s.live[b]).toBeUndefined();
      return true;
    }
    expect(running(s)).toBeLessThanOrEqual(2);
    return false;
  }, 20000);
  for (const id of [a, b]) expect((await card(dir, id))?.lastRun?.status).toBe("success");
  await peak(dir);
}, 30000);

test("project-cap-column-limit-still-applies: a column limit below the project cap holds", async () => {
  const { dir, add } = await project(3, 1);
  for (const t of ["a", "b", "c"]) await add(t);
  expect(await peak(dir)).toBe(1);
}, 30000);
