import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addAgentCard, type ChildServer, startChildServer, waitFor } from "./helpers.ts";

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer({
    agents: true,
    settings: { claudePath: join(import.meta.dir, "fake-claude.ts") },
    env: { FAKE_DELAY_MS: "50" },
  });
});
afterAll(() => srv.stop());

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("shutdown-kills-sigterm-ignoring-test", async () => {
  const { dir, id, card } = await addAgentCard(srv, "stay");
  await waitFor(async () => !!(await card())?.lastRun);
  const pidFile = join(srv.tmp, "test.pid");
  await srv.call(`/api/cards/${id}/test`, {
    method: "PUT",
    body: { project: dir, command: `echo $$ > ${pidFile}; trap '' TERM; sleep 30` },
  });
  expect((await srv.call(`/api/cards/${id}/test/start`, { body: { project: dir } })).status).toBe(200);
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(alive(pid)).toBe(true);
  try {
    await srv.stop();
    expect(alive(pid)).toBe(false);
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
}, 15000);
