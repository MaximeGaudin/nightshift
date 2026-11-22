import { expect, test } from "bun:test";
import {
  collectRunProcesses,
  findTokenPids,
  newRunToken,
  type ProcInfo,
  parseProcessTable,
  protectedPids,
  RUN_TOKEN_ENV,
  readProcessTable,
  stopRunProcesses,
} from "../src/server/runProcesses.ts";

const T = "Sun Nov 22 19:00:00 2026";
const p = (pid: number, ppid: number, pgid: number, startedAt = T, zombie = false): ProcInfo => ({
  pid,
  ppid,
  pgid,
  startedAt,
  ...(zombie ? { zombie: true } : {}),
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("parse-process-table", () => {
  const rows = parseProcessTable(
    "  101     1   101 Ss   Sun Nov 22 19:00:00 2026\n  102   101   102 Z+   Sun Nov 22 19:00:01 2026\ngarbage\n",
  );
  expect(rows).toEqual([p(101, 1, 101), p(102, 101, 102, "Sun Nov 22 19:00:01 2026", true)]);
});

test("collect-excludes-reused-pid", () => {
  const table = [p(10, 1, 10), p(20, 1, 20, "Sun Nov 22 20:00:00 2026"), p(30, 1, 30)];
  const h = { token: "x", rootPid: 10, rootStartedAt: T, tracked: [{ pid: 20, pgid: 20, startedAt: T }] };
  expect(collectRunProcesses(table, h, [], new Set()).map((x) => x.pid)).toEqual([10]);
  // A root whose pid was reused is not the run's either.
  const reused = { ...h, rootStartedAt: "Sat Nov 21 10:00:00 2026", tracked: [] };
  expect(collectRunProcesses(table, reused, [], new Set())).toEqual([]);
});

test("collect-finds-orphan-by-group-and-token", () => {
  const table = [
    p(1, 0, 1),
    p(500, 1, 500), // server (excluded)
    p(40, 1, 40), // tracked group leader, re-parented to init after the root died
    p(41, 1, 40), // member of that group, also re-parented
    p(42, 41, 42), // descendant of the member, in its own group
    p(60, 1, 60), // token holder
    p(61, 60, 61), // its child
    p(70, 1, 70), // unrelated
    p(43, 40, 40, T, true), // zombie member
  ];
  const h = { token: "t", rootPid: 9, rootStartedAt: T, tracked: [{ pid: 40, pgid: 40, startedAt: T }] };
  const got = collectRunProcesses(table, h, [60, 500], new Set([500, 1]))
    .map((x) => x.pid)
    .sort((a, b) => a - b);
  expect(got).toEqual([40, 41, 42, 60, 61]);
});

test("protected-pids-are-self-and-ancestors", () => {
  const table = [p(1, 0, 1), p(5, 1, 5), p(process.pid, 5, 5), p(99, process.pid, 99)];
  expect([...protectedPids(table)].sort((a, b) => a - b)).toEqual([1, 5, process.pid].sort((a, b) => a - b));
});

test("read-process-table-sees-self", async () => {
  const table = await readProcessTable();
  const self = table.find((x) => x.pid === process.pid);
  expect(self?.startedAt).toBeTruthy();
});

test("stop-escalates-to-sigkill", async () => {
  const token = newRunToken();
  // A visible (non-platform) binary that ignores SIGTERM, with a child of its own, both carrying the token.
  const script = `process.on("SIGTERM", () => {}); Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"]); console.log("ready"); setInterval(() => {}, 1000);`;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    detached: true,
    stdout: "pipe",
    env: { ...process.env, [RUN_TOKEN_ENV]: token },
  });
  const reader = proc.stdout.getReader();
  await reader.read();
  await Bun.sleep(200);
  const holders = await findTokenPids(token);
  expect(holders).toContain(proc.pid);
  expect(holders.length).toBeGreaterThanOrEqual(2);
  const start = Date.now();
  await stopRunProcesses({ token, rootPid: proc.pid, tracked: [] }, 300);
  await proc.exited;
  await Bun.sleep(100);
  for (const pid of holders) expect(alive(pid)).toBe(false);
  expect(Date.now() - start).toBeLessThan(5000);
});

test("stop-with-nothing-left-resolves-fast", async () => {
  const start = Date.now();
  await stopRunProcesses({ token: newRunToken(), rootPid: 999_999, tracked: [] }, 5000);
  expect(Date.now() - start).toBeLessThan(2000);
});
