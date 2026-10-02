import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, LogLine } from "../src/shared/types.ts";
import { removeTempDirs, tempDir, waitFor } from "./helpers.ts";

// See nightshift.test.ts: settings.ts and skills.ts capture their paths at the first import, so read them back.
process.env.NIGHTSHIFT_HOME = tempDir("ns-home-");
process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-skills-");
const argsLog = join(tempDir("ns-args-"), "args.jsonl");
const prevArgsLog = process.env.FAKE_ARGS_LOG;
process.env.FAKE_ARGS_LOG = argsLog;

const { skillsDir } = await import("../src/server/skills.ts");
const { RESULT_SCHEMA, buildFeedbackPrompt, buildPrompt } = await import("../src/server/orchestrator.ts");
const { defaultBoard } = await import("../src/server/store.ts");
const { startServer } = await import("../src/server/server.ts");
const { updateSettings } = await import("../src/server/settings.ts");
const userSkills = skillsDir("user", "");

let srv: ReturnType<typeof startServer>;
let base = "";

beforeAll(() => {
  updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts"), maxParallel: 2, model: "" });
  srv = startServer({ port: 0 });
  base = `http://localhost:${srv.server.port}`;
  mkdirSync(join(userSkills, "enrich"), { recursive: true });
  writeFileSync(join(userSkills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
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

/** Opens a fresh project with one "Enrich" skill column and returns what the tests need. */
async function setup(columnModel?: string) {
  const dir = tempDir("ns-models-");
  const snap = await post("/api/projects/open", { path: dir });
  const backlog = snap.board.columns[0];
  const done = snap.board.columns.at(-1);
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [backlog, { name: "Enrich", type: "skill", skill: "enrich", ...(columnModel ? { model: columnModel } : {}) }, done],
    },
    "PUT",
  );
  const get = async () =>
    (await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards as Card[];
  const logOf = (id: string): Promise<LogLine[]> =>
    fetch(`${base}/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json());
  return { dir, enrich: res.board.columns[1], get, logOf };
}

test("output applies models on question round", async () => {
  process.env.FAKE_EXTRA_OUTPUT = JSON.stringify({ models: { "nightshift-implement": "opus", other: "sonnet" } });
  const { dir, enrich, get } = await setup();
  const { id } = await post("/api/cards", { project: dir, columnId: enrich.id, title: "ask" });
  await waitFor(async () => (await get()).find((c) => c.id === id)?.lastRun?.status === "question");
  const card = (await get()).find((c) => c.id === id) as Card;
  expect(card.columnId).toBe(enrich.id);
  expect(card.models).toEqual({ "nightshift-implement": "opus", other: "sonnet" });
  const entries = card.history.filter((h) => h.text.startsWith("Models:"));
  expect(entries).toHaveLength(1);
  expect(entries[0].kind).toBe("edited");
  expect(entries[0].text).toBe("Models: nightshift-implement=opus, other=sonnet (by agent)");
});

test("dropped models logged once", async () => {
  const long = "x".repeat(200);
  process.env.FAKE_EXTRA_OUTPUT = JSON.stringify({ models: { good: "haiku", bad1: "gpt-4", bad2: long } });
  const { dir, enrich, get, logOf } = await setup();
  const { id } = await post("/api/cards", { project: dir, columnId: enrich.id, title: "ask" });
  await waitFor(async () => (await get()).find((c) => c.id === id)?.lastRun?.status === "question");
  const card = (await get()).find((c) => c.id === id) as Card;
  expect(card.models).toEqual({ good: "haiku" });
  const lines = (await logOf(id)).filter((l) => l.text.includes("Ignored model"));
  expect(lines).toHaveLength(1);
  expect(lines[0].kind).toBe("info");
  expect(lines[0].text).toContain('"gpt-4" for bad1');
  expect(lines[0].text).toContain(`"${"x".repeat(80)}" for bad2`);
  expect(lines[0].text).not.toContain("x".repeat(81));
});

test("default removes an entry and an emptied map is deleted", async () => {
  process.env.FAKE_EXTRA_OUTPUT = JSON.stringify({ models: { enrich: "default" } });
  const { dir, enrich, get } = await setup();
  const { id } = await post("/api/cards", { project: dir, columnId: enrich.id, title: "ask" });
  await waitFor(async () => (await get()).find((c) => c.id === id)?.lastRun?.status === "question");
  const card = (await get()).find((c) => c.id === id) as Card;
  expect("models" in card).toBe(false);
  expect(card.history.some((h) => h.text.startsWith("Models:"))).toBe(false);
});

test("prompt and schema list models", () => {
  const models = (RESULT_SCHEMA.properties as Record<string, { type: string; additionalProperties?: unknown }>).models;
  expect(models.type).toBe("object");
  expect(models.additionalProperties).toEqual({ type: "string" });
  expect(RESULT_SCHEMA.required).not.toContain("models");
  const col = { id: "c", name: "Work", type: "skill" as const, skill: "enrich" };
  const board = { ...defaultBoard("x"), columns: [col] };
  const card = { id: "k", number: 1, title: "t", description: "d" } as unknown as Card;
  const sentence = "The plan agent should set it from the task's complexity; other agents usually omit it.";
  expect(buildPrompt(board, card, col, undefined)).toContain(sentence);
  expect(buildFeedbackPrompt(board, card, col, "enrich", undefined)).toContain(sentence);
});

test("start log line shows the model source, read from the fresh card", async () => {
  process.env.FAKE_EXTRA_OUTPUT = JSON.stringify({ models: { enrich: "opus" } });
  const { dir, enrich, get, logOf } = await setup("sonnet");
  const first = await post("/api/cards", { project: dir, columnId: enrich.id, title: "ask" });
  await waitFor(async () => (await get()).find((c) => c.id === first.id)?.lastRun?.status === "question");
  let start = (await logOf(first.id)).find((l) => l.text.startsWith("Starting"));
  expect(start?.text).toContain("model: sonnet (column)");
  // The card now carries its own model: the answer resumes the session with it.
  await post(`/api/cards/${first.id}/answer`, { project: dir, answers: ["blue", ""] });
  await waitFor(async () => (await logOf(first.id)).some((l) => l.text.startsWith("Resuming")));
  start = (await logOf(first.id)).find((l) => l.text.startsWith("Resuming"));
  expect(start?.text).toContain("model: opus (card)");
});

test("start log line says default when no model applies", async () => {
  delete process.env.FAKE_EXTRA_OUTPUT;
  const { dir, enrich, get, logOf } = await setup();
  const { id } = await post("/api/cards", { project: dir, columnId: enrich.id, title: "ask" });
  await waitFor(async () => (await get()).find((c) => c.id === id)?.lastRun?.status === "question");
  const start = (await logOf(id)).find((l) => l.text.startsWith("Starting"));
  expect(start?.text).toContain("model: default).");
});
