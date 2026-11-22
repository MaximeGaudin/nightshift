import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartedAt } from "../src/server/runProcesses.ts";
import { addAgentCard, type ChildServer, quiet, startChildServer, waitFor } from "./helpers.ts";

const fake = join(import.meta.dir, "fake-claude.ts");
const cleanup: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readPids = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : []);
type Entry = { cardId?: string; rootPid: number; rootStartedAt?: string; tracked: { pid: number }[] };
const registryEntries = (home: string): Entry[] => {
  const dir = join(home, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    try {
      return JSON.parse(readFileSync(join(dir, f), "utf8")).entries as Entry[];
    } catch {
      return [];
    }
  });
};
const boardCard = (dir: string, id: string) =>
  JSON.parse(readFileSync(join(dir, "nightshift.json"), "utf8")).cards.find((c: { id: string }) => c.id === id);

async function server(pidFile: string, opts: { reuse?: ChildServer; agents?: boolean } = {}) {
  const srv = await startChildServer({
    agents: opts.agents ?? true,
    settings: { claudePath: fake },
    env: { FAKE_DELAY_MS: "50", FAKE_SLOW_MS: "60000", FAKE_BG_PID_FILE: pidFile },
    ...(opts.reuse ? { reuse: opts.reuse } : {}),
  });
  return srv;
}

function killAll(pids: number[]) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/** A server whose card "realbg" runs, with its background processes started. */
async function runningRealbg() {
  const pidFile = join(mkdtempSync(join(tmpdir(), "ns-int-")), "pids");
  const srv = await server(pidFile);
  cleanup.push(() => killAll(readPids(pidFile)));
  const { dir, id, card } = await addAgentCard(srv, "realbg");
  await waitFor(
    () => readPids(pidFile).length >= 3,
    10000,
    () => readPids(pidFile),
  );
  return { srv, pidFile, dir, id, card };
}

test("shutdown-kills-run-processes-and-marks-interrupted, interrupted-not-restarted", async () => {
  const { srv, pidFile, dir, id } = await runningRealbg();
  const root = registryEntries(srv.home).find((e) => e.cardId === id)?.rootPid;
  expect(root).toBeTruthy();
  const pids = [...readPids(pidFile), root as number];
  for (const pid of pids) expect(alive(pid)).toBe(true);
  await srv.kill("SIGTERM");
  cleanup.push(() => rmSync(srv.tmp, { recursive: true, force: true }));
  expect(pids.filter(alive)).toEqual([]);
  const c = boardCard(dir, id);
  expect(c.lastRun.status).toBe("cancelled");
  expect(c.lastRun.interrupted).toBe(true);
  expect(c.pendingAnswer).toBeUndefined();
  expect(c.history.at(-1).text).toContain("interrupted (Nightshift stopped)");
  expect(registryEntries(srv.home)).toEqual([]);

  // Restart: the interrupted card waits for the user.
  const again = await server(pidFile, { reuse: srv });
  cleanup.push(() => again.kill("SIGTERM"));
  await again.call("/api/projects/open", { body: { path: dir } });
  await quiet(1000);
  const snap = await again.call(`/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());
  expect(snap.live[id]).toBeUndefined();
  const after = snap.board.cards.find((x: { id: string }) => x.id === id);
  expect(after.history.filter((h: { kind: string }) => h.kind === "started").length).toBe(1);
  expect(after.lastRun.interrupted).toBe(true);
}, 40000);

test("crash-reaps-orphans", async () => {
  const { srv, pidFile, dir, id } = await runningRealbg();
  const sleepPid = readPids(pidFile)[2] as number;
  // The tracker has snapshotted the tree (the sleep under its sh) and the root's start time.
  await waitFor(
    () => registryEntries(srv.home).some((e) => e.cardId === id && !!e.rootStartedAt && e.tracked.some((t) => t.pid === sleepPid)),
    10000,
    () => registryEntries(srv.home),
  );
  const root = registryEntries(srv.home).find((e) => e.cardId === id)?.rootPid as number;
  cleanup.push(() => killAll([root]));
  await srv.kill("SIGKILL");
  cleanup.push(() => rmSync(srv.tmp, { recursive: true, force: true }));
  const pids = [...readPids(pidFile), root];
  // The crash left them all behind.
  for (const pid of pids) expect(alive(pid)).toBe(true);

  const again = await server(pidFile, { reuse: srv });
  cleanup.push(() => again.kill("SIGTERM"));
  await waitFor(
    () => pids.every((pid) => !alive(pid)),
    10000,
    () => pids.filter(alive),
  );
  // Not marked before the project is opened; marked when it is, and never restarted.
  expect(boardCard(dir, id).lastRun).toBeUndefined();
  await again.call("/api/projects/open", { body: { path: dir } });
  await waitFor(
    () => boardCard(dir, id).lastRun?.interrupted === true,
    5000,
    () => boardCard(dir, id).lastRun,
  );
  await quiet(1000);
  const c = boardCard(dir, id);
  expect(c.history.filter((h: { kind: string }) => h.kind === "started").length).toBe(1);
  expect(registryEntries(srv.home)).toEqual([]);
}, 60000);

test("reap-ignores-live-server, no-agents-does-not-reap", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ns-child-"));
  const home = join(tmp, "home");
  mkdirSync(join(home, "runs"), { recursive: true });
  const project = mkdtempSync(join(tmpdir(), "ns-int-proj-"));
  const victim = Bun.spawn(["sleep", "60"]);
  const liveServer = Bun.spawn(["sleep", "60"]);
  cleanup.push(() => killAll([victim.pid, liveServer.pid]));
  cleanup.push(() => rmSync(tmp, { recursive: true, force: true }));
  await waitFor(async () => !!(await processStartedAt(victim.pid)), 5000);
  const started = (await processStartedAt(victim.pid)) as string;
  const entry = {
    id: "e1",
    kind: "quick",
    project,
    startedAt: new Date().toISOString(),
    token: "nomatch",
    rootPid: victim.pid,
    rootStartedAt: started,
    tracked: [{ pid: victim.pid, pgid: victim.pid, startedAt: started }],
  };
  const file = join(home, "runs", `${liveServer.pid}-aaaaaa.json`);
  writeFileSync(file, JSON.stringify({ version: 1, serverPid: liveServer.pid, serverStartedAtMs: Date.now(), entries: [entry] }));

  // A live server's runs are left alone.
  const a = await server("/dev/null", { reuse: { tmp } });
  await quiet(1500);
  expect(alive(victim.pid)).toBe(true);
  await a.kill("SIGTERM");

  // The server is dead now: a --no-agents instance still reaps nothing.
  liveServer.kill("SIGKILL");
  await liveServer.exited;
  const b = await server("/dev/null", { reuse: { tmp }, agents: false });
  await quiet(1500);
  expect(alive(victim.pid)).toBe(true);
  await b.kill("SIGTERM");

  // An agents-enabled instance stops it, and drops the entry.
  const c = await server("/dev/null", { reuse: { tmp } });
  cleanup.push(() => c.kill("SIGTERM"));
  await waitFor(() => !alive(victim.pid), 10000);
  await waitFor(() => !existsSync(file), 5000);
}, 60000);
