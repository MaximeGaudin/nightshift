import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAgentCard, type ChildServer, startChildServer, waitFor } from "./helpers.ts";

let srv: ChildServer;
let pidFile: string;
beforeAll(async () => {
  pidFile = join(tmpdir(), `ns-realbg-${process.pid}-${Date.now()}.pids`);
  srv = await startChildServer({
    agents: true,
    settings: { claudePath: join(import.meta.dir, "fake-claude.ts") },
    env: { FAKE_DELAY_MS: "50", FAKE_SLOW_MS: "30000", FAKE_BG_PID_FILE: pidFile },
  });
});
afterAll(async () => {
  for (const pid of pids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await srv.stop();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pids = () => (existsSync(pidFile) ? readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
const registryEntries = () => {
  const dir = join(srv.home, "runs");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).reduce((n, f) => n + JSON.parse(readFileSync(join(dir, f), "utf8")).entries.length, 0);
};

test("cancel-kills-background-command", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(pidFile, "");
  const { dir, id, card } = await addAgentCard(srv, "realbg");
  await waitFor(
    () => pids().length >= 3,
    8000,
    () => pids(),
  );
  const started = pids();
  for (const pid of started) expect(alive(pid)).toBe(true);
  const r = await srv.call(`/api/cards/${id}/cancel`, { body: { project: dir } }).then((x) => x.json());
  expect(r.cancelled).toBeTruthy();
  await waitFor(
    () => started.every((pid) => !alive(pid)),
    6000,
    () => started.filter(alive),
  );
  await waitFor(async () => (await card())?.lastRun?.status === "cancelled", 8000, card);
  await waitFor(() => registryEntries() === 0, 8000, registryEntries);
}, 30000);

test("run-end-kills-leftover", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(pidFile, "");
  const { card } = await addAgentCard(srv, "realbg-exit");
  await waitFor(async () => !!(await card())?.lastRun, 10000, card);
  const started = pids();
  expect(started.length).toBeGreaterThanOrEqual(3);
  await waitFor(
    () => started.every((pid) => !alive(pid)),
    6000,
    () => started.filter(alive),
  );
  expect((await card())?.lastRun?.status).not.toBe("cancelled");
  await waitFor(() => registryEntries() === 0, 8000, registryEntries);
}, 30000);

test("test-command-end-kills-leftover", async () => {
  const { dir, id, card } = await addAgentCard(srv, "stay");
  await waitFor(async () => !!(await card())?.lastRun, 10000, card);
  const bgPidFile = `${pidFile}.test`;
  await srv.call(`/api/cards/${id}/test`, {
    method: "PUT",
    body: { project: dir, command: `${process.execPath} -e "setInterval(() => {}, 1000)" & echo $! > ${bgPidFile}; exit 0` },
  });
  expect((await srv.call(`/api/cards/${id}/test/start`, { body: { project: dir } })).status).toBe(200);
  await waitFor(() => existsSync(bgPidFile) && readFileSync(bgPidFile, "utf8").trim() !== "", 8000);
  const pid = Number(readFileSync(bgPidFile, "utf8"));
  try {
    await waitFor(
      () => !alive(pid),
      8000,
      () => `still alive: ${pid}`,
    );
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
}, 30000);
