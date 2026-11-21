import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, LogLine } from "../src/shared/types.ts";
import { removeTempDirs, tempDir, waitFor } from "./helpers.ts";

process.env.NIGHTSHIFT_HOME = tempDir("ns-home-");
process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-skills-");
const argsLog = join(tempDir("ns-args-"), "args.jsonl");
const prevArgsLog = process.env.FAKE_ARGS_LOG;
process.env.FAKE_ARGS_LOG = argsLog;

const { skillsDir } = await import("../src/server/skills.ts");
const { RESULT_SCHEMA, buildPrompt } = await import("../src/server/orchestrator.ts");
const { defaultBoard } = await import("../src/server/store.ts");
const { startServer } = await import("../src/server/server.ts");
const { updateSettings } = await import("../src/server/settings.ts");
const userSkills = skillsDir("user", "");

let srv: ReturnType<typeof startServer>;
let base = "";

beforeAll(() => {
  updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts"), model: "", effort: "", extraArgs: "" });
  srv = startServer({ port: 0 });
  base = `http://localhost:${srv.server.port}`;
  for (const s of ["nightshift-merge", "nightshift-review"]) {
    mkdirSync(join(userSkills, s), { recursive: true });
    writeFileSync(join(userSkills, s, "SKILL.md"), `---\nname: ${s}\ndescription: test\n---\n`);
  }
});
afterAll(async () => {
  delete process.env.FAKE_EXTRA_OUTPUT;
  await srv.orch.shutdown();
  srv.server.stop(true);
  if (prevArgsLog === undefined) delete process.env.FAKE_ARGS_LOG;
  else process.env.FAKE_ARGS_LOG = prevArgsLog;
  removeTempDirs();
});

const post = (path: string, body: object, method = "POST") =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

async function setup(skill: string) {
  const dir = tempDir("ns-effort-");
  const snap = await post("/api/projects/open", { path: dir });
  const backlog = snap.board.columns[0];
  const done = snap.board.columns.at(-1);
  const res = await post("/api/board", { project: dir, columns: [backlog, { name: "Work", type: "skill", skill }, done] }, "PUT");
  const get = async () =>
    (await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards as Card[];
  const logOf = (id: string): Promise<LogLine[]> =>
    fetch(`${base}/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json());
  return { dir, col: res.board.columns[1], get, logOf };
}

const runs = (title: string): { argv: string[] }[] =>
  readFileSync(argsLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((r) => r.title === title);

test("merge column without setting passes --effort low before extraArgs, and logs it", async () => {
  updateSettings({ effort: "", extraArgs: "--verbose-x" });
  const { dir, col, get, logOf } = await setup("nightshift-merge");
  const { id } = await post("/api/cards", { project: dir, columnId: col.id, title: "ask" });
  await waitFor(async () => (await get()).find((c) => c.id === id)?.lastRun?.status === "question");
  const argv = runs("ask").at(-1)?.argv ?? [];
  const i = argv.indexOf("--effort");
  expect(argv[i + 1]).toBe("low");
  expect(i).toBeLessThan(argv.indexOf("--verbose-x"));
  expect((await logOf(id)).find((l) => l.text.startsWith("Starting"))?.text).toContain("effort: low (default)");
  updateSettings({ extraArgs: "" });
});

test("settings inherit passes no --effort", async () => {
  updateSettings({ effort: "inherit" });
  const { dir, col, get, logOf } = await setup("nightshift-merge");
  const { id } = await post("/api/cards", { project: dir, columnId: col.id, title: "ask" });
  await waitFor(async () => (await get()).find((c) => c.id === id)?.lastRun?.status === "question");
  expect(runs("ask").at(-1)?.argv ?? []).not.toContain("--effort");
  expect((await logOf(id)).find((l) => l.text.startsWith("Starting"))?.text).toContain("effort: inherit (settings)");
  updateSettings({ effort: "" });
});

test("agent efforts are merged and apply to the next run, dropped ones are logged", async () => {
  process.env.FAKE_EXTRA_OUTPUT = JSON.stringify({ efforts: { "nightshift-merge": "xhigh", bad: "turbo" } });
  const { dir, col, get, logOf } = await setup("nightshift-merge");
  const { id } = await post("/api/cards", { project: dir, columnId: col.id, title: "ask" });
  await waitFor(async () => (await get()).find((c) => c.id === id)?.lastRun?.status === "question");
  const card = (await get()).find((c) => c.id === id) as Card;
  expect(card.efforts).toEqual({ "nightshift-merge": "xhigh" });
  expect(card.history.some((h) => h.text === "Efforts: nightshift-merge=xhigh (by agent)")).toBe(true);
  expect((await logOf(id)).some((l) => l.text.includes('Ignored effort "turbo" for bad'))).toBe(true);
  await post(`/api/cards/${id}/answer`, { project: dir, answers: ["blue", ""] });
  await waitFor(async () => (await logOf(id)).some((l) => l.text.startsWith("Resuming")));
  expect((await logOf(id)).find((l) => l.text.startsWith("Resuming"))?.text).toContain("effort: xhigh (card)");
  delete process.env.FAKE_EXTRA_OUTPUT;
});

test("schema and prompt mention efforts", () => {
  const efforts = (RESULT_SCHEMA.properties as Record<string, { type: string }>).efforts;
  expect(efforts.type).toBe("object");
  expect(RESULT_SCHEMA.required).not.toContain("efforts");
  const col = { id: "c", name: "Work", type: "skill" as const, skill: "nightshift-merge" };
  const board = { ...defaultBoard("x"), columns: [col] };
  const card = { id: "k", number: 1, title: "t", description: "d" } as unknown as Card;
  expect(buildPrompt(board, card, col, undefined)).toContain("- efforts: optional");
});
