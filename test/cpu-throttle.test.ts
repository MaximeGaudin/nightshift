import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSnapshot } from "../src/shared/types.ts";
import { type ChildServer, startChildServer, waitFor } from "./helpers.ts";

let srv: ChildServer;
const SLOW_MS = 1500;
const loadFile = () => join(srv.tmp, "cpu-load");
/** Writes the injected load; the sampler reads it every 100 ms, so give it time to see it before a card moves. */
const setLoad = async (n: number | null) => {
  if (n === null) rmSync(loadFile(), { force: true });
  else writeFileSync(loadFile(), String(n));
  await Bun.sleep(350);
};

beforeAll(async () => {
  srv = await startChildServer({
    agents: true,
    settings: { claudePath: join(import.meta.dir, "fake-claude.ts") },
    env: { FAKE_DELAY_MS: "300", FAKE_SLOW_MS: String(SLOW_MS) },
  });
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
});
afterAll(() => srv?.stop());

const json = (path: string, body?: object, method?: string) => srv.call(path, { body, method }).then((r) => r.json());
const snapshot = (dir: string): Promise<ProjectSnapshot> => json(`/api/project?project=${encodeURIComponent(dir)}`);

async function project(cap = 5) {
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  await json("/api/projects/open", { path: dir });
  const res = await json(
    "/api/board",
    { project: dir, maxParallel: cap, columns: [{ name: "Work", type: "skill", skill: "enrich", maxParallel: 5 }] },
    "PUT",
  );
  const work = res.board.columns.find((c: { name: string }) => c.name === "Work");
  const add = async (title: string): Promise<string> => (await json("/api/cards", { project: dir, columnId: work.id, title })).id;
  return { dir, add };
}

test("cpu-throttle-holds then releases: a ready card waits above the limit and starts when the load drops", async () => {
  await setLoad(95);
  const { dir, add } = await project();
  await waitFor(async () => (await snapshot(dir)).cpuThrottle === undefined);
  const id = await add("slow");
  await waitFor(async () => {
    const s = await snapshot(dir);
    return s.cpuThrottle?.load === 95 && s.cpuThrottle.limit === 85;
  });
  expect((await snapshot(dir)).live[id]).toBe("queued");
  await setLoad(50);
  await waitFor(async () => (await snapshot(dir)).live[id] === "running");
  expect((await snapshot(dir)).cpuThrottle).toBeUndefined();
}, 30000);

test("cpu-throttle-running-kept: a running card is not stopped when the load rises", async () => {
  await setLoad(10);
  const { dir, add } = await project();
  const id = await add("slow");
  await waitFor(async () => (await snapshot(dir)).live[id] === "running");
  await setLoad(99);
  await Bun.sleep(500);
  expect((await snapshot(dir)).live[id]).toBe("running");
  await setLoad(null);
  await waitFor(async () => (await snapshot(dir)).live[id] === undefined, 20000);
}, 30000);

test("cpu-throttle-quick-run: a quick run starts above the limit", async () => {
  await setLoad(99);
  const { dir } = await project();
  await json("/api/favorite-skills", { project: dir, name: "enrich", favorite: true }, "PUT");
  await json("/api/quick-runs", { project: dir, skill: "enrich", instruction: "FAKE_QUICK_SLOW" });
  await waitFor(async () => (await snapshot(dir)).quickRuns.some((q) => q.status === "running"));
  await setLoad(null);
}, 30000);

test("cpu-throttle-disabled: with the switch off a card starts above the limit", async () => {
  await setLoad(99);
  await json("/api/settings", { cpuThrottleEnabled: false }, "PUT");
  const { dir, add } = await project();
  const id = await add("slow");
  await waitFor(async () => (await snapshot(dir)).live[id] === "running");
  expect((await snapshot(dir)).cpuThrottle).toBeUndefined();
  await json("/api/settings", { cpuThrottleEnabled: true }, "PUT");
  await setLoad(null);
}, 30000);

test("cpu-throttle-cap-not-cpu: a card held by the project cap is not reported as held by the CPU", async () => {
  await setLoad(10);
  const { dir, add } = await project(1);
  const first = await add("slow");
  await waitFor(async () => (await snapshot(dir)).live[first] === "running");
  await setLoad(99);
  const second = await add("slow");
  await Bun.sleep(500);
  const s = await snapshot(dir);
  expect(s.live[second]).toBe("queued");
  expect(s.cpuThrottle).toBeUndefined();
  await setLoad(null);
}, 30000);
