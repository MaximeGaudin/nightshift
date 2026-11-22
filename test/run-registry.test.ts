import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRegistry } from "../src/server/runRegistry.ts";

const dirs: string[] = [];
const home = () => {
  const d = mkdtempSync(join(tmpdir(), "ns-registry-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}

const entry = (project: string, cardId: string, kind: "card" | "quick" | "test" = "card") => ({
  id: `e-${cardId}`,
  kind,
  project,
  cardId,
  columnId: "col",
  enteredColumnAt: "2026-11-22T10:00:00.000Z",
  startedAt: "2026-11-22T10:00:01.000Z",
  token: "tok",
  rootPid: 1_999_999,
  tracked: [],
});

function writeRegistry(
  h: string,
  name: string,
  serverPid: number,
  entries: unknown[],
  serverStartedAtMs = Date.now(),
  heartbeatAt = Date.now(),
) {
  mkdirSync(join(h, "runs"), { recursive: true });
  writeFileSync(join(h, "runs", name), JSON.stringify({ version: 1, serverPid, serverStartedAtMs, heartbeatAt, entries }));
}

test("registry-dead-detection", async () => {
  const h = home();
  const project = home();
  const dead = await deadPid();
  writeRegistry(h, `${dead}-aaaaaa.json`, dead, [entry(project, "dead")]);
  // A live pid, but the file's server started before the last boot: the pid was reused, the server is dead.
  const sleeper = Bun.spawn(["sleep", "30"]);
  try {
    writeRegistry(h, `${sleeper.pid}-bbbbbb.json`, sleeper.pid, [entry(project, "reused")], 0);
    // A live pid whose heartbeat stopped: the server died and its pid was reused, the server is dead.
    writeRegistry(h, `${sleeper.pid}-dddddd.json`, sleeper.pid, [entry(project, "stale")], Date.now(), Date.now() - 120_000);
    // A live server started in this boot, with a fresh heartbeat, is left alone.
    writeRegistry(h, `${sleeper.pid}-cccccc.json`, sleeper.pid, [entry(project, "live")]);
    // Another instance in this very process is never dead.
    const other = new RunRegistry(h);
    other.add({ kind: "card", project, cardId: "same-process", startedAt: new Date().toISOString() }, "tok2", sleeper.pid);
    const reg = new RunRegistry(h);
    const ids = reg
      .readDeadEntries()
      .map((e) => e.cardId)
      .sort();
    expect(ids).toEqual(["dead", "reused", "stale"]);
    other.close();
  } finally {
    sleeper.kill("SIGKILL");
  }
});

test("registry-take-interrupted", async () => {
  const h = home();
  const a = home();
  const b = home();
  const dead = await deadPid();
  const name = `${dead}-dddddd.json`;
  writeRegistry(h, name, dead, [entry(a, "a1"), entry(b, "b1"), entry(a, "q", "quick"), entry(join(a, "gone"), "g")]);
  const reg = new RunRegistry(h);
  reg.dropNonCardDeadEntries();
  const left = JSON.parse(readFileSync(join(h, "runs", name), "utf8")).entries.map((e: { cardId: string }) => e.cardId);
  expect(left.sort()).toEqual(["a1", "b1", "g"]);
  expect(reg.takeInterrupted(a).map((e) => e.cardId)).toEqual(["a1"]);
  const after = JSON.parse(readFileSync(join(h, "runs", name), "utf8")).entries.map((e: { cardId: string }) => e.cardId);
  expect(after).toEqual(["b1"]);
  expect(reg.takeInterrupted(b).map((e) => e.cardId)).toEqual(["b1"]);
  expect(existsSync(join(h, "runs", name))).toBe(false);
});

test("registry-corrupt-dead-file-is-deleted", async () => {
  const h = home();
  const dead = await deadPid();
  mkdirSync(join(h, "runs"), { recursive: true });
  writeFileSync(join(h, "runs", `${dead}-eeeeee.json`), "{not json");
  const reg = new RunRegistry(h);
  expect(reg.readDeadEntries()).toEqual([]);
  reg.dropNonCardDeadEntries();
  expect(readdirSync(join(h, "runs"))).toEqual([]);
});

test("registry-tracks-descendants-and-removes-file", async () => {
  const h = home();
  const project = home();
  const reg = new RunRegistry(h);
  const sh = Bun.spawn(["sh", "-c", "sleep 30 & wait"], { detached: true });
  try {
    const run = reg.add({ kind: "test", project, cardId: "c", startedAt: new Date().toISOString() }, "toktrack", sh.pid);
    await Bun.sleep(300);
    expect(run.rootStartedAt).toBeTruthy();
    await reg.track();
    const files = readdirSync(join(h, "runs"));
    expect(files.length).toBe(1);
    const data = JSON.parse(readFileSync(join(h, "runs", files[0] as string), "utf8"));
    expect(data.serverPid).toBe(process.pid);
    expect(Date.now() - data.heartbeatAt).toBeLessThan(5000);
    const tracked: { pid: number }[] = data.entries[0].tracked;
    expect(tracked.some((t) => t.pid === sh.pid)).toBe(true);
    expect(tracked.length).toBeGreaterThanOrEqual(2);
    reg.remove(run.id);
    expect(readdirSync(join(h, "runs"))).toEqual([]);
  } finally {
    process.kill(-sh.pid, "SIGKILL");
    reg.close();
  }
});
