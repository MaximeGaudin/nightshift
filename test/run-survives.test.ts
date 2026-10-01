import { afterAll, beforeAll, expect, test } from "bun:test";
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

test("run-survives-bad-agent-output: a non-string test.url does not kill the server", async () => {
  const { card } = await addAgentCard(srv, "bad-url");
  await waitFor(async () => !!(await card())?.lastRun);
  const c = await card();
  expect(["error", "success"]).toContain(c.lastRun.status);
  expect(c.test?.url).toBeUndefined();
  expect((await srv.call("/api/settings")).status).toBe(200);
});
