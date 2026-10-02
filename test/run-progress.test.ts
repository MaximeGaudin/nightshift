import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column } from "../src/shared/types.ts";
import { quiet, removeTempDirs, tempDir, waitFor } from "./helpers.ts";

// The server, orchestrator and settings modules keep process-wide singletons (NIGHTSHIFT_HOME is read at
// import, settings live on globalThis) and `bun test` shares them across files. To avoid clobbering
// nightshift.test.ts, the scenarios run in a child `bun test` of this very file with its own home.
const CHILD = process.env.RUN_PROGRESS_CHILD === "1";

if (!CHILD) {
  test("run-progress-isolated: scenarios pass in a dedicated process", async () => {
    const proc = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, RUN_PROGRESS_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) console.error(out + err);
    expect(code).toBe(0);
    for (const name of [
      "run-progress-live",
      "run-progress-cleared",
      "run-progress-todo-fallback",
      "run-progress-ignores-subagents",
      "prompt-mentions-marker",
      "run-progress-activity-fallback",
      "run-progress-marker-beats-activity",
      "run-progress-activity-ignores-subagents",
    ]) {
      expect(out + err).toContain(`(pass) ${name}`);
    }
  }, 60000);
} else {
  const home = tempDir("ns-prog-home-");
  const userSkills = tempDir("ns-prog-skills-");
  process.env.NIGHTSHIFT_HOME = home;
  process.env.NIGHTSHIFT_USER_SKILLS = userSkills;
  process.env.FAKE_DELAY_MS = "1500";

  const { buildPrompt } = await import("../src/server/orchestrator.ts");
  const { defaultBoard } = await import("../src/server/store.ts");
  const { startServer } = await import("../src/server/server.ts");
  const { updateSettings } = await import("../src/server/settings.ts");

  let srv: ReturnType<typeof startServer>;
  let base = "";

  beforeAll(() => {
    updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts") });
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

  async function setup(title: string) {
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
    return { dir, id };
  }

  const stripAt = (p: { at?: unknown }) => {
    const { at, ...rest } = p;
    expect(typeof at).toBe("string");
    return rest;
  };

  test("run-progress-live: marker wins over TodoWrite while running", async () => {
    const { dir, id } = await setup("progress");
    await waitFor(async () => !!(await getProject(dir)).progress?.[id]?.source && (await getProject(dir)).progress[id].source === "marker");
    await quiet(200); // the second TodoWrite must not override the marker
    const s = await getProject(dir);
    expect(stripAt(s.progress[id])).toEqual({ step: 2, total: 3, label: "Deuxième", source: "marker" });
    await waitFor(async () => (await getProject(dir)).live[id] === undefined);
  });

  test("run-progress-cleared: absent after the run, never written to nightshift.json", async () => {
    const { dir, id } = await setup("progress");
    await waitFor(async () => !!(await getProject(dir)).progress?.[id]);
    await waitFor(async () => (await getProject(dir)).live[id] === undefined);
    const s = await getProject(dir);
    expect(s.progress[id]).toBeUndefined();
    // The fake agent renames the card "progress ✓": check for a progress key/value, not the bare word.
    const raw = readFileSync(join(dir, "nightshift.json"), "utf8");
    expect(raw).not.toMatch(/"progress"\s*:/);
    expect(raw).not.toContain("nightshift-progress");
    expect(raw).not.toContain('"source"');
  });

  test("run-progress-todo-fallback: TodoWrite alone gives source todo", async () => {
    const { dir, id } = await setup("progress-todo");
    await waitFor(async () => !!(await getProject(dir)).progress?.[id]);
    const s = await getProject(dir);
    expect(stripAt(s.progress[id])).toEqual({ step: 1, total: 2, label: "Tâche 1 en cours", source: "todo" });
    await waitFor(async () => (await getProject(dir)).live[id] === undefined);
  });

  test("run-progress-ignores-subagents: subagent marker and TodoWrite do not override", async () => {
    const { dir, id } = await setup("progress-subagent");
    await waitFor(async () => !!(await getProject(dir)).progress?.[id]);
    await quiet(200); // subagent events must not override the main agent progress
    const s = await getProject(dir);
    expect(stripAt(s.progress[id])).toEqual({ step: 1, total: 2, label: "Principal", source: "marker" });
    await waitFor(async () => (await getProject(dir)).live[id] === undefined);
  });

  test("run-progress-activity-fallback: tool calls alone give source activity", async () => {
    const { dir, id } = await setup("progress-none");
    await waitFor(async () => (await getProject(dir)).progress?.[id]?.label === "Run the tests");
    const s = await getProject(dir);
    expect(stripAt(s.progress[id])).toEqual({ source: "activity", step: 0, total: 0, label: "Run the tests" });
    await waitFor(async () => (await getProject(dir)).live[id] === undefined);
  });

  test("run-progress-marker-beats-activity: a later tool call does not revert a marker", async () => {
    const { dir, id } = await setup("progress-marker-after-tool");
    await waitFor(async () => (await getProject(dir)).progress?.[id]?.label === "First tool");
    expect((await getProject(dir)).progress[id].source).toBe("activity");
    await waitFor(async () => (await getProject(dir)).progress?.[id]?.source === "marker");
    await quiet(900); // the last tool call has been emitted by now
    const s = await getProject(dir);
    expect(stripAt(s.progress[id])).toEqual({ step: 1, total: 3, label: "A", source: "marker" });
    await waitFor(async () => (await getProject(dir)).live[id] === undefined);
  });

  test("run-progress-activity-ignores-subagents: subagent tool calls leave progress unchanged", async () => {
    const { dir, id } = await setup("progress-activity-subagent");
    await waitFor(async () => (await getProject(dir)).progress?.[id]?.label === "Main tool");
    await quiet(800);
    const s = await getProject(dir);
    expect(stripAt(s.progress[id])).toEqual({ source: "activity", step: 0, total: 0, label: "Main tool" });
    await waitFor(async () => (await getProject(dir)).live[id] === undefined);
  });

  test("prompt-mentions-marker", () => {
    const board = defaultBoard("x");
    const col: Column = { id: "c", name: "Work", type: "skill", skill: "enrich" };
    const card = { id: "k", number: 1, title: "t", description: "d" } as Card;
    const prompt = buildPrompt({ ...board, columns: [col] }, card, col, undefined);
    expect(prompt).toContain("[nightshift-progress]");
    expect(prompt).toContain("## Progress");
  });
}
