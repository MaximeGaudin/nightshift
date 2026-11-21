import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerEvent, TeamclaudeWait } from "../src/shared/types.ts";
import { addAgentCard, type ChildServer, quiet, removeTempDirs, startChildServer, tempDir, waitFor } from "./helpers.ts";

// A fake proxy (503 = unreachable for the probe) and a fake `teamclaude` binary first on PATH.
let proxyUp = true;
const proxy = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) =>
    new URL(req.url).pathname === "/teamclaude/quota" && proxyUp
      ? Response.json({ accounts: [], aggregate: {} })
      : new Response("down", { status: 503 }),
});
const proxyUrl = `http://127.0.0.1:${proxy.port}`;
const bin = tempDir("ns-tc-bin-");
const witness = join(bin, "teamclaude-called");
writeFileSync(
  join(bin, "teamclaude"),
  `#!/bin/sh
touch ${JSON.stringify(witness)}
echo "export HTTPS_PROXY=http://127.0.0.1:${proxy.port}"
echo "export NODE_EXTRA_CA_CERTS='/tmp/a b'"
echo "unset ANTHROPIC_BASE_URL"
`,
);
chmodSync(join(bin, "teamclaude"), 0o755);
const logs = tempDir("ns-tc-logs-");
const envLog = join(logs, "env.jsonl");
const argsLog = join(logs, "args.jsonl");

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer({
    agents: true,
    settings: { claudePath: join(import.meta.dir, "fake-claude.ts") },
    env: {
      FAKE_DELAY_MS: "50",
      FAKE_ENV_LOG: envLog,
      FAKE_ARGS_LOG: argsLog,
      PATH: `${bin}:${process.env.PATH}`,
      ANTHROPIC_BASE_URL: "http://x",
    },
  });
}, 30000);
afterAll(async () => {
  await srv.stop();
  proxy.stop(true);
  removeTempDirs();
});
beforeEach(async () => {
  proxyUp = true;
  rmSync(witness, { force: true });
  await setSettings({ teamclaudeEnabled: true, teamclaudeUrl: proxyUrl });
});

const setSettings = (s: Record<string, unknown>) => srv.call("/api/settings", { method: "PUT", body: s });
const readLines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const runsOf = (file: string, title: string) => readLines(file).filter((l: { title: string }) => l.title === title);
const waitState = async () => ((await srv.call("/api/teamclaude/wait").then((r) => r.json())) as { wait: TeamclaudeWait | null }).wait;
const decide = (action: string) => srv.call("/api/teamclaude/decision", { body: { action } });
const logOf = async (dir: string, id: string) =>
  (await srv.call(`/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json())) as
    | { lines?: { text: string }[] }
    | { text: string }[];
const logText = async (dir: string, id: string) => {
  const l = await logOf(dir, id);
  return (Array.isArray(l) ? l : (l.lines ?? [])).map((x) => x.text).join("\n");
};
const snapshot = async (dir: string) => srv.call(`/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());
const isWaiting = async (title: string) => ((await waitState())?.entries ?? []).some((e) => e.title === title);
const finished = async (card: () => Promise<{ lastRun?: { status: string } }>) => !!(await card()).lastRun;

function listen() {
  const events: ServerEvent[] = [];
  const ws = new WebSocket(`${srv.base.replace("http", "ws")}/ws`);
  ws.onmessage = (m) => events.push(JSON.parse(String(m.data)));
  return { events, close: () => ws.close() };
}

test("teamclaude-off-unchanged: no teamclaude call, no proxy variable", async () => {
  await setSettings({ teamclaudeEnabled: false });
  const { card } = await addAgentCard(srv, "tc-off");
  await waitFor(() => finished(card));
  expect(existsSync(witness)).toBe(false);
  const [run] = runsOf(envLog, "tc-off");
  expect(run.HTTPS_PROXY).toBeUndefined();
  expect(run.ANTHROPIC_BASE_URL).toBe("http://x");
});

test("teamclaude-proxy-env: claude gets the teamclaude variables, same arguments", async () => {
  const { dir, id, card } = await addAgentCard(srv, "tc-on");
  await waitFor(() => finished(card));
  expect((await card()).lastRun.status).toBe("success");
  const [run] = runsOf(envLog, "tc-on");
  expect(run).toMatchObject({ HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, NODE_EXTRA_CA_CERTS: "/tmp/a b" });
  expect(run.ANTHROPIC_BASE_URL).toBeUndefined();
  const off = runsOf(argsLog, "tc-off")[0].argv;
  const on = runsOf(argsLog, "tc-on")[0].argv;
  const strip = (a: string[]) => a.map((x) => (x.startsWith("nightshift: ") ? "NAME" : x));
  expect(strip(on)).toEqual(strip(off));
  expect(await logText(dir, id)).toContain("via teamclaude");
});

test("teamclaude-wait-and-modal-state: no claude run, wait listed, card in proxyWaiting, event sent", async () => {
  proxyUp = false;
  const { events, close } = listen();
  const { dir, id, card } = await addAgentCard(srv, "tc-wait");
  await waitFor(() => isWaiting("tc-wait"));
  const wait = await waitState();
  expect(wait?.failure).toEqual({ kind: "no-response", url: proxyUrl });
  const entry = wait?.entries.find((e) => e.title === "tc-wait");
  expect(entry).toMatchObject({ project: dir, cardId: id, ref: `#${(await card()).number}` });
  expect((await snapshot(dir)).proxyWaiting).toEqual([id]);
  expect((await snapshot(dir)).live[id]).toBe("running");
  await waitFor(() => events.some((e) => e.type === "teamclaude" && e.wait !== null));
  await quiet();
  expect(runsOf(argsLog, "tc-wait")).toHaveLength(0);
  await decide("cancel");
  await waitFor(async () => (await waitState()) === null);
  await waitFor(() => events.some((e) => e.type === "teamclaude" && e.wait === null));
  close();
});

test("teamclaude-retry: still down keeps the wait, back up runs through the proxy", async () => {
  proxyUp = false;
  const { card } = await addAgentCard(srv, "tc-retry");
  await waitFor(() => isWaiting("tc-retry"));
  const r = await decide("retry").then((x) => x.json());
  expect(r.wait.entries.some((e: { title: string }) => e.title === "tc-retry")).toBe(true);
  expect(r.wait.retrying).toBe(false);
  proxyUp = true;
  const ok = await decide("retry").then((x) => x.json());
  expect(ok.wait).toBeNull();
  await waitFor(() => finished(card));
  expect(runsOf(envLog, "tc-retry")[0].HTTPS_PROXY).toBe(`http://127.0.0.1:${proxy.port}`);
});

test("teamclaude-direct: runs without the proxy, the next run checks again", async () => {
  proxyUp = false;
  const a = await addAgentCard(srv, "tc-direct");
  await waitFor(() => isWaiting("tc-direct"));
  await decide("direct");
  await waitFor(() => finished(a.card));
  expect(runsOf(envLog, "tc-direct")[0].HTTPS_PROXY).toBeUndefined();
  expect(await logText(a.dir, a.id)).toContain("without teamclaude");
  await addAgentCard(srv, "tc-direct-2");
  await waitFor(() => isWaiting("tc-direct-2"));
  await decide("cancel");
});

test("teamclaude-cancel: the run fails in place, a retry waits again", async () => {
  proxyUp = false;
  const { dir, id, card } = await addAgentCard(srv, "tc-cancel");
  const column = (await card()).columnId;
  await waitFor(() => isWaiting("tc-cancel"));
  await decide("cancel");
  await waitFor(() => finished(card));
  const c = await card();
  expect(c.lastRun.status).toBe("error");
  expect(c.lastRun.error).toBe(`teamclaude proxy unreachable at ${proxyUrl}`);
  expect(c.columnId).toBe(column);
  expect(runsOf(argsLog, "tc-cancel")).toHaveLength(0);
  await srv.call(`/api/cards/${id}/retry`, { body: { project: dir } });
  await waitFor(() => isWaiting("tc-cancel"));
  await decide("cancel");
  await waitFor(async () => (await waitState()) === null);
});

test("teamclaude-move-removes: a moved card leaves the wait and never runs", async () => {
  proxyUp = false;
  const { dir, id } = await addAgentCard(srv, "tc-move");
  await waitFor(() => isWaiting("tc-move"));
  await srv.call(`/api/cards/${id}/move`, { body: { project: dir, columnId: "col_backlog" } });
  await waitFor(async () => (await waitState()) === null);
  expect((await snapshot(dir)).proxyWaiting).toEqual([]);
  proxyUp = true;
  await decide("retry");
  await quiet();
  expect(runsOf(argsLog, "tc-move")).toHaveLength(0);
});

test("teamclaude-counts-in-limit: a waiting run holds its column's only slot", async () => {
  proxyUp = false;
  const { dir, card } = await addAgentCard(srv, "tc-limit-1");
  await waitFor(() => isWaiting("tc-limit-1"));
  const col = (await card()).columnId;
  const { id: second } = await srv.call("/api/cards", { body: { project: dir, columnId: col, title: "tc-limit-2" } }).then((r) => r.json());
  await quiet();
  expect((await snapshot(dir)).live[second]).toBe("queued");
  expect(await isWaiting("tc-limit-2")).toBe(false);
  await decide("cancel");
  await waitFor(() => isWaiting("tc-limit-2"));
  await decide("cancel");
  await waitFor(async () => (await waitState()) === null);
});

test("teamclaude-toggle-off-releases: turning the option off runs the waiting cards directly", async () => {
  proxyUp = false;
  const { card } = await addAgentCard(srv, "tc-toggle");
  await waitFor(() => isWaiting("tc-toggle"));
  await setSettings({ teamclaudeEnabled: false });
  await waitFor(() => finished(card));
  expect(await waitState()).toBeNull();
  expect(runsOf(envLog, "tc-toggle")[0].HTTPS_PROXY).toBeUndefined();
});

test("teamclaude-decision: an unknown action is refused, no wait answers null", async () => {
  expect((await decide("nope")).status).toBe(400);
  expect(await decide("retry").then((r) => r.json())).toEqual({ wait: null });
});

test("teamclaude-not-found: no teamclaude binary on PATH is reported", async () => {
  const other = await startChildServer({
    agents: true,
    settings: { claudePath: join(import.meta.dir, "fake-claude.ts"), teamclaudeEnabled: true, teamclaudeUrl: proxyUrl },
    env: {
      FAKE_DELAY_MS: "50",
      PATH: (process.env.PATH ?? "")
        .split(":")
        .filter((d) => !existsSync(join(d, "teamclaude")))
        .join(":"),
    },
  });
  try {
    await addAgentCard(other, "tc-nf");
    await waitFor(async () => !!(await other.call("/api/teamclaude/wait").then((r) => r.json())).wait);
    const { wait } = await other.call("/api/teamclaude/wait").then((r) => r.json());
    expect(wait.failure).toEqual({ kind: "not-found" });
    await other.call("/api/teamclaude/decision", { body: { action: "cancel" } });
  } finally {
    await other.stop();
  }
});
