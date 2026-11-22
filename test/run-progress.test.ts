import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column, LogLine } from "../src/shared/types.ts";
import { removeTempDirs, restoreEnvAfterAll, tempDir, waitFor } from "./helpers.ts";

// settings.ts and skills.ts capture their paths at the first import and the server keeps one orchestrator per
// process (see card-models-run.test.ts): the paths come from the imported modules, the environment is put back after.
restoreEnvAfterAll("NIGHTSHIFT_HOME", "NIGHTSHIFT_USER_SKILLS", "FAKE_DELAY_MS", "FAKE_HOLD_FILE");
process.env.NIGHTSHIFT_HOME = tempDir("ns-prog-home-");
process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-prog-skills-");
// Progress only exists while the run is live: every test holds its run with FAKE_HOLD_FILE instead of a long delay.
process.env.FAKE_DELAY_MS = "50";

const { buildPrompt } = await import("../src/server/orchestrator.ts");
const { defaultBoard } = await import("../src/server/store.ts");
const { startServer } = await import("../src/server/server.ts");
const { updateSettings } = await import("../src/server/settings.ts");
const { skillsDir } = await import("../src/server/skills.ts");
const userSkills = skillsDir("user", "");

let srv: ReturnType<typeof startServer>;
let base = "";

beforeAll(() => {
  updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts"), model: "", effort: "", extraArgs: "", agentFeatures: {} });
  srv = startServer({ port: 0 });
  base = `http://localhost:${srv.server.port}`;
  mkdirSync(join(userSkills, "enrich"), { recursive: true });
  writeFileSync(join(userSkills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
});
afterAll(async () => {
  await srv.orch.shutdown();
  srv.server.stop(true);
  removeTempDirs();
});

const post = (path: string, body: object, method = "POST") =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const getProject = (path: string) => fetch(`${base}/api/project?project=${encodeURIComponent(path)}`).then((r) => r.json());

/** Card log lines with this exact text. The orchestrator logs an event before it updates the progress, in the same
 * synchronous handler (handleEvent in orchestrator.ts): once the line is there, the event has been applied. */
const logged = async (dir: string, id: string, text: string) =>
  ((await fetch(`${base}/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json())) as LogLine[]).filter(
    (l) => l.text === text,
  ).length;

/** Opens a board and adds a card whose fake run stays live until `release()`, which then waits for the run to end. */
async function setup(title: string) {
  const holdFile = join(tempDir("ns-prog-hold-"), "release");
  process.env.FAKE_HOLD_FILE = holdFile;
  const dir = tempDir("ns-prog-");
  await post("/api/projects/open", { path: dir });
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        { name: "Work", type: "skill", skill: "enrich" },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  const { id } = await post("/api/cards", { project: dir, columnId: res.board.columns[1].id, title });
  const release = async () => {
    writeFileSync(holdFile, "");
    delete process.env.FAKE_HOLD_FILE;
    await waitFor(async () => (await getProject(dir)).live[id] === undefined);
  };
  return { dir, id, release };
}

const stripAt = (p: { at?: unknown }) => {
  const { at, ...rest } = p;
  expect(typeof at).toBe("string");
  return rest;
};

test("run-progress-live: marker wins over TodoWrite while running", async () => {
  const { dir, id, release } = await setup("progress");
  await waitFor(async () => !!(await getProject(dir)).progress?.[id]?.source && (await getProject(dir)).progress[id].source === "marker");
  // The second TodoWrite must not override the marker: wait until it has been handled.
  await waitFor(async () => (await logged(dir, id, "TodoWrite")) === 2);
  const s = await getProject(dir);
  expect(stripAt(s.progress[id])).toEqual({ step: 2, total: 3, label: "Deuxième", source: "marker" });
  await release();
});

test("run-progress-cleared: absent after the run, never written to nightshift.json", async () => {
  const { dir, id, release } = await setup("progress");
  await waitFor(async () => !!(await getProject(dir)).progress?.[id]);
  await release();
  const s = await getProject(dir);
  expect(s.progress[id]).toBeUndefined();
  // The fake agent renames the card "progress ✓": check for a progress key/value, not the bare word.
  const raw = readFileSync(join(dir, "nightshift.json"), "utf8");
  expect(raw).not.toMatch(/"progress"\s*:/);
  expect(raw).not.toContain("nightshift-progress");
  expect(raw).not.toContain('"source"');
});

test("run-progress-todo-fallback: TodoWrite alone gives source todo", async () => {
  const { dir, id, release } = await setup("progress-todo");
  await waitFor(async () => !!(await getProject(dir)).progress?.[id]);
  const s = await getProject(dir);
  expect(stripAt(s.progress[id])).toEqual({ step: 1, total: 2, label: "Tâche 1 en cours", source: "todo" });
  await release();
});

test("run-progress-ignores-subagents: subagent marker and TodoWrite do not override", async () => {
  const { dir, id, release } = await setup("progress-subagent");
  await waitFor(async () => !!(await getProject(dir)).progress?.[id]);
  // Subagent events must not override the main agent progress: wait until the last one has been handled.
  await waitFor(async () => (await logged(dir, id, "[nightshift-progress] 5/9 Sous-agent")) === 1);
  const s = await getProject(dir);
  expect(stripAt(s.progress[id])).toEqual({ step: 1, total: 2, label: "Principal", source: "marker" });
  await release();
});

test("run-progress-activity-fallback: tool calls alone give source activity", async () => {
  const { dir, id, release } = await setup("progress-none");
  await waitFor(async () => (await getProject(dir)).progress?.[id]?.label === "Run the tests");
  const s = await getProject(dir);
  expect(stripAt(s.progress[id])).toEqual({ source: "activity", step: 0, total: 0, label: "Run the tests" });
  await release();
});

test("run-progress-marker-beats-activity: a later tool call does not revert a marker", async () => {
  const { dir, id, release } = await setup("progress-marker-after-tool");
  await waitFor(async () => (await getProject(dir)).progress?.[id]?.label === "First tool");
  expect((await getProject(dir)).progress[id].source).toBe("activity");
  await waitFor(async () => (await getProject(dir)).progress?.[id]?.source === "marker");
  // The last tool call comes after the marker: wait until it has been handled (the generic opening tool call is the first "Bash: ls").
  await waitFor(async () => (await logged(dir, id, "Bash: ls")) === 3);
  const s = await getProject(dir);
  expect(stripAt(s.progress[id])).toEqual({ step: 1, total: 3, label: "A", source: "marker" });
  await release();
});

test("run-progress-activity-ignores-subagents: subagent tool calls leave progress unchanged", async () => {
  const { dir, id, release } = await setup("progress-activity-subagent");
  await waitFor(async () => (await getProject(dir)).progress?.[id]?.label === "Main tool");
  // The subagent tool call must leave the progress alone: wait until it has been handled (third "Bash: ls", after the
  // generic opening one and the main one).
  await waitFor(async () => (await logged(dir, id, "Bash: ls")) === 3);
  const s = await getProject(dir);
  expect(stripAt(s.progress[id])).toEqual({ source: "activity", step: 0, total: 0, label: "Main tool" });
  await release();
});

test("prompt-mentions-marker", () => {
  const board = defaultBoard("x");
  const col: Column = { id: "c", name: "Work", type: "skill", skill: "enrich" };
  const card = { id: "k", number: 1, title: "t", description: "d" } as Card;
  const prompt = buildPrompt({ ...board, columns: [col] }, card, col, undefined);
  expect(prompt).toContain("[nightshift-progress]");
  expect(prompt).toContain("## Progress");
});
