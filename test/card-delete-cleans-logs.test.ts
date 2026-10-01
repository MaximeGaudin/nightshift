import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
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

const logFiles = (id: string) => {
  const root = join(srv.home, "logs");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((d) => join(root, d, `${id}.jsonl`))
    .filter(existsSync);
};

test("card-delete-cleans-logs: deleting a card removes its log file and in-memory log", async () => {
  const { dir, id, card } = await addAgentCard(srv, "to-delete");
  await waitFor(async () => !!(await card())?.lastRun);
  expect(logFiles(id).length).toBe(1);
  expect((await srv.call(`/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json())).length).toBeGreaterThan(0);

  const res = await srv.call(`/api/cards/${id}`, { method: "DELETE", body: { project: dir } });
  expect(res.status).toBe(200);
  expect(logFiles(id)).toEqual([]);
  expect(await srv.call(`/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json())).toEqual([]);
});
