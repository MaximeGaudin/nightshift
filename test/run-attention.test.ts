import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "../src/shared/types.ts";
import { removeTempDirs, tempDir, waitFor } from "./helpers.ts";

// Same setup as card-models-run.test.ts: settings.ts and skills.ts capture their paths at the first import.
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
  updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts"), model: "" });
  srv = startServer({ port: 0 });
  base = `http://localhost:${srv.server.port}`;
  mkdirSync(join(userSkills, "work"), { recursive: true });
  writeFileSync(join(userSkills, "work", "SKILL.md"), "---\nname: work\ndescription: test\n---\n");
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

/** A fresh project: Backlog, one "Work" skill column, Done. */
async function setup() {
  const dir = tempDir("ns-attention-");
  const snap = await post("/api/projects/open", { path: dir });
  const backlog = snap.board.columns[0];
  const done = snap.board.columns.at(-1);
  const res = await post("/api/board", { project: dir, columns: [backlog, { name: "Work", type: "skill", skill: "work" }, done] }, "PUT");
  const card = async (id: string) =>
    ((await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards as Card[]).find(
      (c) => c.id === id,
    ) as Card;
  return { dir, work: res.board.columns[1], done: res.board.columns.at(-1), card };
}

const launches = (title: string) =>
  readFileSync(argsLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { title: string; resumed: boolean })
    .filter((l) => l.title === title);

test("run-stay-attention: stay without questions needs attention, keeps its sections and is not re-run", async () => {
  process.env.FAKE_EXTRA_OUTPUT = JSON.stringify({ sections: [{ heading: "Result", content: "tests not finished" }] });
  try {
    const { dir, work, card } = await setup();
    const { id } = await post("/api/cards", { project: dir, columnId: work.id, title: "stay" });
    await waitFor(async () => (await card(id)).lastRun?.status !== undefined);
    const c = await card(id);
    expect(c.lastRun?.status).toBe("attention");
    expect(c.lastRun?.error).toBe("Stopped in Work without finishing: stayed");
    expect(c.lastRun?.summary).toBe("stayed");
    expect(c.columnId).toBe(work.id);
    expect(c.description).toContain("## Result\n\ntests not finished");
    expect(c.history.some((h) => h.kind === "run" && h.text.startsWith("Work: needs attention (Stopped in Work"))).toBe(true);
    const before = launches("stay").length;
    await Bun.sleep(1000);
    expect(launches("stay").length).toBe(before);
    expect((await card(id)).lastRun?.status).toBe("attention");
  } finally {
    delete process.env.FAKE_EXTRA_OUTPUT;
  }
});

test("run-question-unchanged: questions stay a question, a next run is a success and moves", async () => {
  const { dir, work, done, card } = await setup();
  const ask = await post("/api/cards", { project: dir, columnId: work.id, title: "ask" });
  const ok = await post("/api/cards", { project: dir, columnId: work.id, title: "plain" });
  await waitFor(async () => (await card(ask.id)).lastRun?.status === "question");
  await waitFor(async () => (await card(ok.id)).lastRun?.status === "success");
  expect((await card(ask.id)).columnId).toBe(work.id);
  expect((await card(ok.id)).columnId).toBe(done.id);
});

test("run-stay-feedback-unchanged: feedback answered with stay in an inert column is a success", async () => {
  const { dir, work, done, card } = await setup();
  const { id } = await post("/api/cards", { project: dir, columnId: work.id, title: "fb" });
  await waitFor(async () => (await card(id)).columnId === done.id && (await card(id)).lastRun?.status === "success");
  const ranAt = (await card(id)).lastRun?.at;
  await post(`/api/cards/${id}/feedback`, { project: dir, text: "please tweak FAKE_MOVE=stay" });
  await waitFor(async () => {
    const lr = (await card(id)).lastRun;
    return lr?.at !== ranAt && lr?.status !== undefined && lr.summary === "feedback applied";
  });
  const c = await card(id);
  expect(c.lastRun?.status).toBe("success");
  expect(c.columnId).toBe(done.id);
});
