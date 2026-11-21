import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, LogLine } from "../src/shared/types.ts";
import { removeTempDirs, tempDir, waitFor } from "./helpers.ts";

// See card-models-run.test.ts: settings.ts and skills.ts capture their paths at the first import.
process.env.NIGHTSHIFT_HOME = tempDir("ns-home-");
process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-skills-");
const argsLog = join(tempDir("ns-args-"), "args.jsonl");
const prevArgsLog = process.env.FAKE_ARGS_LOG;
process.env.FAKE_ARGS_LOG = argsLog;

const { skillsDir } = await import("../src/server/skills.ts");
const { startServer } = await import("../src/server/server.ts");
const { updateSettings } = await import("../src/server/settings.ts");
const userSkills = skillsDir("user", "");

let srv: ReturnType<typeof startServer>;
let base = "";

beforeAll(() => {
  updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts"), model: "", extraArgs: "--foo bar", agentFeatures: {} });
  srv = startServer({ port: 0 });
  base = `http://localhost:${srv.server.port}`;
  mkdirSync(join(userSkills, "enrich"), { recursive: true });
  writeFileSync(join(userSkills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
});
afterAll(async () => {
  await srv.orch.shutdown();
  srv.server.stop(true);
  if (prevArgsLog === undefined) delete process.env.FAKE_ARGS_LOG;
  else process.env.FAKE_ARGS_LOG = prevArgsLog;
  removeTempDirs();
});

const post = (path: string, body: object, method = "POST") =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const runs = (): { title: string; argv: string[] }[] =>
  readFileSync(argsLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

async function setup(columnFeatures?: object) {
  const dir = tempDir("ns-features-");
  const snap = await post("/api/projects/open", { path: dir });
  const backlog = snap.board.columns[0];
  const done = snap.board.columns.at(-1);
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [backlog, { name: "Enrich", type: "skill", skill: "enrich", ...(columnFeatures ? { agentFeatures: columnFeatures } : {}) }, done],
    },
    "PUT",
  );
  const get = async () =>
    (await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards as Card[];
  const logOf = (id: string): Promise<LogLine[]> =>
    fetch(`${base}/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json());
  return { dir, enrich: res.board.columns[1], get, logOf };
}

test("card run: column override, flags before extraArgs, sources in the start line", async () => {
  const { dir, enrich, get, logOf } = await setup({ hooks: true });
  const { id } = await post("/api/cards", { project: dir, columnId: enrich.id, title: "ask" });
  await waitFor(async () => (await get()).find((c) => c.id === id)?.lastRun?.status === "question");
  const argv = must(runs().findLast((r) => r.title === "ask")).argv;
  expect(argv).toContain("--strict-mcp-config");
  expect(argv).toContain("--no-chrome");
  expect(argv).not.toContain("--setting-sources");
  expect(argv.join(" ")).not.toContain("disableAllHooks");
  expect(argv).not.toContain("--bare");
  expect(Math.max(argv.indexOf("--strict-mcp-config"), argv.indexOf("--no-chrome"))).toBeLessThan(argv.indexOf("--foo"));
  const start = (await logOf(id)).find((l) => l.text.startsWith("Starting"));
  expect(start?.text).toContain("hooks on (column)");
  expect(start?.text).toContain("mcp off (default)");
  expect(start?.text).toContain("user skills on (default)");
});

test("card override beats the column on the next run", async () => {
  const { dir, enrich, get, logOf } = await setup({ mcp: false });
  const { id } = await post("/api/cards", { project: dir, columnId: enrich.id, title: "ask" });
  await waitFor(async () => (await get()).find((c) => c.id === id)?.lastRun?.status === "question");
  await fetch(`${base}/api/cards/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: dir, agentFeatures: { mcp: true } }),
  });
  await post(`/api/cards/${id}/answer`, { project: dir, answers: ["blue", ""] });
  await waitFor(async () => (await logOf(id)).some((l) => l.text.startsWith("Resuming")));
  const resumed = must((await logOf(id)).find((l) => l.text.startsWith("Resuming")));
  expect(resumed.text).toContain("mcp on (card)");
});

test("quick run: global > default, no column nor card", async () => {
  updateSettings({ agentFeatures: { chrome: true } });
  const dir = tempDir("ns-features-quick-");
  await post("/api/projects/open", { path: dir });
  await fetch(`${base}/api/favorite-skills`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: dir, name: "enrich", favorite: true }),
  });
  const { id } = await post("/api/quick-runs", { project: dir, skill: "enrich" });
  const quickRun = () => runs().find((r) => r.argv.includes("nightshift quick: enrich"));
  await waitFor(() => !!quickRun());
  const argv = must(quickRun()).argv;
  expect(argv).toContain("--strict-mcp-config");
  expect(argv).not.toContain("--no-chrome");
  expect(id).toBeTruthy();
  updateSettings({ agentFeatures: {} });
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("missing");
  return v;
}
