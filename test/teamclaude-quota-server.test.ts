import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerEvent } from "../src/shared/types.ts";
import type { QuotaSnapshot } from "../src/shared/usage.ts";
import { addAgentCard, type ChildServer, quiet, removeTempDirs, startChildServer, tempDir, waitFor } from "./helpers.ts";

// Fake teamclaude proxy serving a minimal buildQuotaSummary; `up = false` answers 503.
let up = true;
const SUMMARY = {
  accounts: [
    { name: "a", type: "oauth", disabled: false },
    { name: "b", type: "oauth", disabled: true },
  ],
  aggregate: {
    fiveHour: { utilization: 0.4, nextResetAt: 1791193200000 },
    weeklyShared: { utilization: 0.7, nextResetAt: 1791237600000 },
  },
};
const proxy = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) =>
    new URL(req.url).pathname === "/teamclaude/quota" && up ? Response.json(SUMMARY) : new Response("down", { status: 503 }),
});
const proxyUrl = `http://127.0.0.1:${proxy.port}`;
const POOLED = {
  source: "teamclaude",
  accounts: 1,
  fiveHour: { utilization: 0.4, resetsAt: 1791193200 },
  sevenDay: { utilization: 0.7, resetsAt: 1791237600 },
};

// A fake `teamclaude` first on PATH, so runs through the proxy never depend on a real install.
const bin = tempDir("ns-tcq-bin-");
writeFileSync(join(bin, "teamclaude"), `#!/bin/sh\necho "export HTTPS_PROXY=${proxyUrl}"\n`);
chmodSync(join(bin, "teamclaude"), 0o755);

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer({
    agents: true,
    settings: { claudePath: join(import.meta.dir, "fake-claude.ts") },
    env: { FAKE_DELAY_MS: "50", NIGHTSHIFT_TEAMCLAUDE_POLL_MS: "150", PATH: `${bin}:${process.env.PATH}` },
  });
}, 30000);
afterAll(async () => {
  await srv.stop();
  proxy.stop(true);
  removeTempDirs();
});

const usageOf = async () => ((await srv.call("/api/usage").then((r) => r.json())) as { usage: QuotaSnapshot | null }).usage;
const setSettings = (s: Record<string, unknown>) => srv.call("/api/settings", { method: "PUT", body: s });

test("teamclaude-quota-gauge: the pool replaces the stream quota while on, and comes back off", async () => {
  const { card } = await addAgentCard(srv, "rate-limit");
  await waitFor(async () => (await usageOf()) !== null);
  const own = await usageOf();
  expect(own?.source).toBeUndefined();

  const events: ServerEvent[] = [];
  const ws = new WebSocket(`${srv.base.replace("http", "ws")}/ws`);
  ws.onmessage = (m) => events.push(JSON.parse(String(m.data)));
  await waitFor(() => events.some((e) => e.type === "usage"));

  await setSettings({ teamclaudeEnabled: true, teamclaudeUrl: proxyUrl });
  await waitFor(async () => (await usageOf())?.source === "teamclaude");
  expect(await usageOf()).toMatchObject(POOLED);
  await waitFor(() => events.some((e) => e.type === "usage" && e.usage?.source === "teamclaude"));

  await setSettings({ teamclaudeEnabled: false });
  await waitFor(async () => (await usageOf())?.source === undefined);
  expect(await usageOf()).toMatchObject({ fiveHour: own?.fiveHour, sevenDay: own?.sevenDay });
  const lastUsage = () => events.filter((e) => e.type === "usage").at(-1) as { usage: QuotaSnapshot | null } | undefined;
  await waitFor(() => !!lastUsage()?.usage && lastUsage()?.usage?.source === undefined);
  ws.close();
  // The run ends once the processes it left are swept (a `ps` scan): wait for its outcome rather than assume it.
  await waitFor(async () => !!(await card())?.lastRun);
  expect((await card()).lastRun.status).toBe("success");
});

test("teamclaude-quota-gauge: a rate-limit event while teamclaude is on does not change the gauge", async () => {
  await setSettings({ teamclaudeEnabled: true, teamclaudeUrl: proxyUrl });
  await waitFor(async () => (await usageOf())?.source === "teamclaude");
  const { card } = await addAgentCard(srv, "rate-limit");
  await waitFor(async () => !!(await card()).lastRun);
  await quiet();
  expect(await usageOf()).toMatchObject(POOLED);
  await setSettings({ teamclaudeEnabled: false });
});

test("teamclaude-quota-unreachable: a failed poll keeps the windows, marked unreachable", async () => {
  up = true;
  await setSettings({ teamclaudeEnabled: true, teamclaudeUrl: proxyUrl });
  await waitFor(async () => (await usageOf())?.source === "teamclaude");
  up = false;
  await waitFor(async () => (await usageOf())?.unreachable === true);
  expect(await usageOf()).toMatchObject({ ...POOLED, unreachable: true });
  up = true;
  await waitFor(async () => (await usageOf())?.unreachable === undefined);
  await setSettings({ teamclaudeEnabled: false });
});
