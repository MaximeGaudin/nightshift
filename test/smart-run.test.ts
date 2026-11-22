import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, LogLine } from "../src/shared/types.ts";
import { removeTempDirs, restoreEnvAfterAll, tempDir, waitFor } from "./helpers.ts";

// See card-models-run.test.ts: settings.ts and skills.ts capture their paths at the first import.
restoreEnvAfterAll("NIGHTSHIFT_HOME", "NIGHTSHIFT_USER_SKILLS");
process.env.NIGHTSHIFT_HOME = tempDir("ns-home-");
process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-skills-");
const logs = tempDir("ns-smart-logs-");
const argsLog = join(logs, "args.jsonl");
const smartLog = join(logs, "smart.jsonl");
const saved = {
  args: process.env.FAKE_ARGS_LOG,
  smart: process.env.FAKE_SMART_LOG,
  timeout: process.env.NIGHTSHIFT_SMART_TIMEOUT_MS,
  delay: process.env.FAKE_DELAY_MS,
};
process.env.FAKE_ARGS_LOG = argsLog;
process.env.FAKE_SMART_LOG = smartLog;
process.env.NIGHTSHIFT_SMART_TIMEOUT_MS = "500";
process.env.FAKE_DELAY_MS = "50";

const { skillsDir } = await import("../src/server/skills.ts");
const { startServer } = await import("../src/server/server.ts");
const { updateSettings } = await import("../src/server/settings.ts");
const userSkills = skillsDir("user", "");

let srv: ReturnType<typeof startServer>;
let base = "";

beforeAll(() => {
  updateSettings({
    claudePath: join(import.meta.dir, "fake-claude.ts"),
    model: "",
    effort: "",
    extraArgs: "",
    agentFeatures: {},
    smartMode: true,
  });
  srv = startServer({ port: 0 });
  base = `http://localhost:${srv.server.port}`;
  mkdirSync(join(userSkills, "enrich"), { recursive: true });
  writeFileSync(join(userSkills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
});
afterAll(async () => {
  await srv.orch.shutdown();
  srv.server.stop(true);
  for (const [k, v] of [
    ["FAKE_ARGS_LOG", saved.args],
    ["FAKE_SMART_LOG", saved.smart],
    ["NIGHTSHIFT_SMART_TIMEOUT_MS", saved.timeout],
    ["FAKE_DELAY_MS", saved.delay],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeTempDirs();
});

const send = (path: string, body: object, method = "POST") =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const lines = (file: string): { title: string; argv: string[]; prompt: string }[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const agentRuns = (title: string) => lines(argsLog).filter((r) => r.title === title);
const smartCalls = (title: string) => lines(smartLog).filter((r) => r.title === title);

async function setup(column: object = {}) {
  const dir = tempDir("ns-smart-");
  const snap = await send("/api/projects/open", { path: dir });
  const backlog = snap.board.columns[0];
  const done = snap.board.columns.at(-1);
  const res = await send(
    "/api/board",
    { project: dir, columns: [backlog, { name: "Enrich", type: "skill", skill: "enrich", ...column }, done] },
    "PUT",
  );
  const enrich = res.board.columns[1];
  const cards = async () =>
    (await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards as Card[];
  const card = async (id: string) => must((await cards()).find((c) => c.id === id));
  const logOf = (id: string): Promise<LogLine[]> =>
    fetch(`${base}/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json());
  const create = (title: string, description = "") => send("/api/cards", { project: dir, columnId: enrich.id, title, description });
  return { dir, enrich, card, logOf, create };
}

test("smart-run: chosen config applied and logged, cost added to the run", async () => {
  const { enrich, card, logOf, create } = await setup();
  const { id } = await create("stay", "plain card");
  await waitFor(async () => (await card(id)).lastRun?.status === "attention");
  expect(smartCalls("stay").length).toBeGreaterThanOrEqual(1);
  const call = must(smartCalls("stay").at(-1));
  expect(call.argv.slice(0, 4)).toEqual(["-p", "--model", "haiku", "--effort"]);
  const argv = must(agentRuns("stay").at(-1)).argv;
  expect(argv).not.toContain("--strict-mcp-config");
  expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
  const log = await logOf(id);
  const smartLine = must(log.find((l) => l.text.startsWith("Smart: ")));
  expect(smartLine.text).toContain("mcp on, chrome off, hooks off, user skills on, effort high — fake smart (haiku, $0.0012,");
  const start = must(log.find((l) => l.text.startsWith("Starting")));
  expect(start.text).toContain("effort: high (smart)");
  expect(start.text).toContain("mcp on (smart)");
  expect(log.indexOf(smartLine)).toBeLessThan(log.indexOf(start));
  const c = await card(id);
  expect(c.lastRun?.costUsd).toBeCloseTo(0.0012, 6);
  expect(c.smartChoices?.[enrich.id]).toMatchObject({ effort: "high", reason: "fake smart", costUsd: 0.0012 });
});

test("smart-run: column override wins over the smart choice", async () => {
  const { card, create } = await setup({ agentFeatures: { mcp: false }, effort: "low" });
  const { id } = await create("stay", "column override");
  await waitFor(async () => (await card(id)).lastRun?.status === "attention");
  const argv = must(agentRuns("stay").at(-1)).argv;
  expect(argv).toContain("--strict-mcp-config");
  expect(argv[argv.indexOf("--effort") + 1]).toBe("low");
});

test("smart-run: fallback on error, invalid output and timeout; nothing cached", async () => {
  const { card, logOf, create } = await setup();
  for (const title of ["smart-fail", "smart-invalid", "smart-slow"]) {
    const { id } = await create(title, "x");
    await waitFor(async () => !!(await card(id)).lastRun, 8000);
    const log = await logOf(id);
    expect(log.some((l) => l.text.startsWith("Smart unavailable ("))).toBe(true);
    const start = must(log.find((l) => l.text.startsWith("Starting")));
    expect(start.text).toContain("mcp off (default)");
    expect(agentRuns(title).length).toBe(1);
    expect((await card(id)).smartChoices).toBeUndefined();
  }
}, 20000);

test("smart-run: no smart call on answer and feedback; the session keeps its config", async () => {
  const { card, create, dir } = await setup();
  const { id } = await create("ask", "question card");
  await waitFor(async () => (await card(id)).lastRun?.status === "question");
  expect(smartCalls("ask").length).toBe(1);
  // Resumed runs carry no <title> in their prompt: count every agent run from here.
  const start = lines(argsLog).length;
  await send(`/api/cards/${id}/answer`, { project: dir, answers: ["blue"] });
  await waitFor(
    async () => lines(argsLog).length === start + 1 && !(await card(id)).pendingAnswer && (await card(id)).lastRun?.status === "success",
  );
  await send(`/api/cards/${id}/feedback`, { project: dir, text: "more" });
  await waitFor(async () => lines(argsLog).length === start + 2 && !(await card(id)).pendingAnswer);
  expect(smartCalls("ask").length).toBe(1);
  expect(lines(smartLog).filter((c) => c.prompt.includes("question card")).length).toBe(1);
  for (const run of lines(argsLog).slice(start)) expect(run.argv[run.argv.indexOf("--effort") + 1]).toBe("high");
});

test("smart-run: a retry reads the cache; a new description calls again", async () => {
  const { card, logOf, create, dir } = await setup();
  const { id } = await create("stay", "first");
  await waitFor(async () => (await card(id)).lastRun?.status === "attention");
  const before = smartCalls("stay").length;
  await send(`/api/cards/${id}/retry`, { project: dir });
  await waitFor(async () => (await logOf(id)).some((l) => l.text.startsWith("Smart (cached): ")));
  await waitFor(
    async () => (await card(id)).lastRun?.status === "attention" && !(await logOf(id)).some((l) => l.text.startsWith("Smart: ")),
  );
  expect(smartCalls("stay").length).toBe(before);
  const retried = must(agentRuns("stay").at(-1)).argv;
  expect(retried[retried.indexOf("--effort") + 1]).toBe("high");
  await send(`/api/cards/${id}`, { project: dir, description: "second" }, "PATCH");
  await waitFor(async () => (await card(id)).lastRun?.status === "attention");
  await send(`/api/cards/${id}/retry`, { project: dir });
  await waitFor(() => smartCalls("stay").length === before + 1);
});

test("smart-run: a failed call drops the stale cache entry, so a later answer runs without smart", async () => {
  const { enrich, card, create, dir } = await setup();
  const { id } = await create("stay", "cached first");
  await waitFor(async () => !!(await card(id)).smartChoices?.[enrich.id]);
  await waitFor(async () => (await card(id)).lastRun?.status === "attention");
  await send(`/api/cards/${id}`, { project: dir, title: "smart-fail now" }, "PATCH");
  await send(`/api/cards/${id}/retry`, { project: dir });
  await waitFor(async () => (await card(id)).smartChoices === undefined && (await card(id)).lastRun?.status === "success");
});

test("smart-run: off globally or on the column", async () => {
  const col = await setup({ smartMode: false });
  const a = await col.create("stay", "column off");
  await waitFor(async () => (await col.card(a.id)).lastRun?.status === "attention");
  expect((await col.logOf(a.id)).some((l) => l.text === "Smart off for this column.")).toBe(true);
  expect(smartCalls("stay").every((c) => !c.prompt.includes("column off"))).toBe(true);

  updateSettings({ smartMode: false });
  try {
    const g = await setup();
    const b = await g.create("stay", "global off");
    await waitFor(async () => (await g.card(b.id)).lastRun?.status === "attention");
    expect((await g.logOf(b.id)).some((l) => l.text === "Smart off for this column.")).toBe(true);
    expect(smartCalls("stay").every((c) => !c.prompt.includes("global off"))).toBe(true);
  } finally {
    updateSettings({ smartMode: true });
  }
});

test("smart-run: cancelling during the smart call never starts the agent", async () => {
  process.env.NIGHTSHIFT_SMART_TIMEOUT_MS = "20000";
  try {
    const { card, create, dir } = await setup();
    const { id } = await create("smart-slow cancel", "x");
    await waitFor(() => smartCalls("smart-slow cancel").length === 1);
    await send(`/api/cards/${id}/cancel`, { project: dir });
    await waitFor(async () => (await card(id)).lastRun?.status === "cancelled", 5000);
    expect(agentRuns("smart-slow cancel").length).toBe(0);
  } finally {
    process.env.NIGHTSHIFT_SMART_TIMEOUT_MS = "500";
  }
}, 15000);

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("missing");
  return v;
}
