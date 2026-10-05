import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerEvent } from "../src/shared/types.ts";
import type { QuotaSnapshot } from "../src/shared/usage.ts";
import { addAgentCard, type ChildServer, removeTempDirs, startChildServer, tempDir, waitFor } from "./helpers.ts";

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer({
    agents: true,
    settings: { claudePath: join(import.meta.dir, "fake-claude.ts") },
    env: { FAKE_DELAY_MS: "50" },
  });
}, 30000);
afterAll(async () => {
  await srv.stop();
  removeTempDirs();
});

const usageOf = async (s: ChildServer = srv) =>
  ((await s.call("/api/usage").then((r) => r.json())) as { usage: QuotaSnapshot | null }).usage;
const EXPECTED = {
  fiveHour: { utilization: 0.38, resetsAt: 1791193200 },
  sevenDay: { utilization: 0.88, resetsAt: 1791237600 },
  status: "allowed_warning",
  isUsingOverage: false,
};

/** Opens the websocket and collects its events until closed. */
function listen(s: ChildServer) {
  const events: ServerEvent[] = [];
  const ws = new WebSocket(`${s.base.replace("http", "ws")}/ws`);
  ws.onmessage = (m) => events.push(JSON.parse(String(m.data)));
  return { events, close: () => ws.close() };
}

test("server-capture-persist", async () => {
  expect(await usageOf()).toBeNull();
  const { events, close } = listen(srv);
  await addAgentCard(srv, "rate-limit");
  await waitFor(async () => (await usageOf()) !== null);
  expect(await usageOf()).toMatchObject(EXPECTED);
  expect(JSON.parse(readFileSync(join(srv.home, "usage.json"), "utf8"))).toMatchObject(EXPECTED);
  await waitFor(() => events.some((e) => e.type === "usage" && e.usage !== null));
  close();
});

test("server-bad-event", async () => {
  const { card } = await addAgentCard(srv, "rate-limit-bad");
  const start = (await card()).columnId;
  await waitFor(async () => (await card()).columnId !== start);
  expect(await usageOf()).toMatchObject(EXPECTED);
});

test("server-two-projects", async () => {
  const { events, close } = listen(srv);
  await waitFor(() => events.some((e) => e.type === "usage"));
  const first = events.filter((e) => e.type === "usage");
  expect(first).toHaveLength(1);
  expect("project" in first[0]).toBe(false);
  const a = await addAgentCard(srv, "rate-limit");
  const b = await addAgentCard(srv, "plain");
  expect(a.dir).not.toBe(b.dir);
  expect(await usageOf()).toMatchObject(EXPECTED);
  close();
});

test("server-restart", async () => {
  const home = join(tempDir("ns-usage-home-"), "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "usage.json"), readFileSync(join(srv.home, "usage.json")));
  const second = await startChildServer({ agents: false, env: { NIGHTSHIFT_HOME: home } });
  try {
    expect(await usageOf(second)).toMatchObject(EXPECTED);
    const { events, close } = listen(second);
    await waitFor(() => events.some((e) => e.type === "usage"));
    expect(events.find((e) => e.type === "usage")).toMatchObject({ usage: EXPECTED });
    close();
  } finally {
    await second.stop();
  }
});
