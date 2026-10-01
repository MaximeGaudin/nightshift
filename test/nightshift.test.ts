import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "ns-home-"));
const userSkills = mkdtempSync(join(tmpdir(), "ns-skills-"));
process.env.NIGHTSHIFT_HOME = home;
process.env.NIGHTSHIFT_USER_SKILLS = userSkills;
// Read by the fake claude binary, which inherits the server's environment.
const argsLog = join(mkdtempSync(join(tmpdir(), "ns-args-")), "args.jsonl");
const prevArgsLog = process.env.FAKE_ARGS_LOG;
process.env.FAKE_ARGS_LOG = argsLog;

const { parseFrontmatter, listSkills, createSkill } = await import("../src/server/skills.ts");
const { splitArgs, resolveModel } = await import("../src/server/orchestrator.ts");
const { needsRun, normalizeBoard } = await import("../src/server/store.ts");
const { startServer } = await import("../src/server/server.ts");
const { updateSettings } = await import("../src/server/settings.ts");

test("parseFrontmatter handles folded descriptions", () => {
  const fm = parseFrontmatter("---\nname: x\ndescription: >\n  hello\n  world\n---\nbody");
  expect(fm).toEqual({ name: "x", description: "hello world" });
});

test("splitArgs honours quotes", () => {
  expect(splitArgs(`--allowedTools "Bash(git *)" --x 'a b' c`)).toEqual(["--allowedTools", "Bash(git *)", "--x", "a b", "c"]);
});

test("needsRun logic", () => {
  const b = normalizeBoard(
    { columns: [{ id: "a", name: "A", type: "skill", skill: "s" }, { id: "b", name: "B", type: "inert" }], cards: [] },
    "x",
  );
  const card: any = { id: "c", columnId: "a", enteredColumnAt: "2026-01-01T00:00:00Z", history: [] };
  expect(needsRun(b, card)).toBe(true);
  card.lastRun = { columnId: "a", status: "success", at: "2026-01-01T00:00:01Z" };
  expect(needsRun(b, card)).toBe(false);
  card.enteredColumnAt = "2026-01-01T00:00:02Z";
  expect(needsRun(b, card)).toBe(true);
  card.columnId = "b";
  expect(needsRun(b, card)).toBe(false);
});

test("normalizeBoard keeps a trimmed model and drops empty ones", () => {
  const b = normalizeBoard(
    {
      columns: [
        { id: "a", name: "A", type: "skill", skill: "s", model: " sonnet " },
        { id: "b", name: "B", type: "skill", skill: "s", model: "   " },
        { id: "c", name: "C", type: "inert" },
      ],
      cards: [],
    },
    "x",
  );
  expect(b.columns[0]!.model).toBe("sonnet");
  expect("model" in b.columns[1]!).toBe(false);
  expect("model" in b.columns[2]!).toBe(false);
});

test("resolveModel priority", () => {
  const col = (model?: string): any => ({ id: "a", name: "A", type: "skill", skill: "s", ...(model ? { model } : {}) });
  const settings = (model: string): any => ({ maxParallel: 1, claudePath: "claude", permissionMode: "auto", model, extraArgs: "", recentProjects: [] });
  expect(resolveModel(col("opus"), settings("sonnet"))).toBe("opus");
  expect(resolveModel(col(), settings(" sonnet "))).toBe("sonnet");
  expect(resolveModel(col(), settings(""))).toBeUndefined();
});

test("project skills shadow user skills", () => {
  const proj = mkdtempSync(join(tmpdir(), "ns-proj-"));
  mkdirSync(join(userSkills, "dup"), { recursive: true });
  writeFileSync(join(userSkills, "dup", "SKILL.md"), "---\nname: dup\ndescription: user\n---\n");
  createSkill(proj, "dup", "project one", "body");
  const dup = listSkills(proj).filter((s) => s.name === "dup");
  expect(dup).toHaveLength(1);
  expect(dup[0]!.scope).toBe("project");
  expect(() => createSkill(proj, "Bad Name", "", "")).toThrow();
});

// ---- end to end with the fake claude binary ----------------------------------

let srv: ReturnType<typeof startServer>;
let base = "";
const proj = mkdtempSync(join(tmpdir(), "ns-e2e-"));

beforeAll(() => {
  updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts"), maxParallel: 2 });
  srv = startServer({ port: 0 });
  base = `http://localhost:${srv.server.port}`;
  mkdirSync(join(userSkills, "enrich"), { recursive: true });
  writeFileSync(join(userSkills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
});
afterAll(() => {
  srv.orch.shutdown();
  srv.server.stop(true);
  if (prevArgsLog === undefined) delete process.env.FAKE_ARGS_LOG;
  else process.env.FAKE_ARGS_LOG = prevArgsLog;
});

const post = (path: string, body: object, method = "POST") =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

async function waitFor(fn: () => Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(50);
  }
  throw new Error("timeout");
}

test("pipeline: skill column processes cards in parallel, respects limit, moves them on", async () => {
  const snap = await post("/api/projects/open", { path: proj });
  const [backlog, done] = snap.board.columns;
  const res = await post(
    "/api/board",
    { project: proj, columns: [backlog, { name: "Enrich", type: "skill", skill: "enrich" }, done] },
    "PUT",
  );
  const enrich = res.board.columns[1];
  for (const t of ["one", "two", "three", "fail"]) await post("/api/cards", { project: proj, columnId: enrich.id, title: t });

  let maxRunning = 0;
  await waitFor(async () => {
    const s = await fetch(`${base}/api/project?project=${encodeURIComponent(proj)}`).then((r) => r.json());
    maxRunning = Math.max(maxRunning, Object.values(s.live).filter((v) => v === "running").length);
    return Object.keys(s.live).length === 0;
  });
  expect(maxRunning).toBeLessThanOrEqual(2);
  expect(maxRunning).toBeGreaterThan(0);

  const file = JSON.parse(readFileSync(join(proj, "nightshift.json"), "utf8"));
  const byTitle = Object.fromEntries(file.cards.map((c: any) => [c.title, c]));
  for (const t of ["one ✓", "two ✓", "three ✓"]) {
    expect(byTitle[t].columnId).toBe(done.id);
    expect(byTitle[t].description).toBe("done by fake");
  }
  expect(byTitle["fail"].columnId).toBe(enrich.id);
  expect(byTitle["fail"].lastRun.status).toBe("error");

  // Retry re-queues the failed card.
  await post(`/api/cards/${byTitle["fail"].id}/retry`, { project: proj });
  const log = await fetch(`${base}/api/cards/${byTitle["fail"].id}/log?project=${encodeURIComponent(proj)}`).then((r) => r.json());
  expect(Array.isArray(log)).toBe(true);
});

test("questions: agent asks all at once, answers resume the session", async () => {
  const snap = await post("/api/projects/open", { path: proj });
  const [, enrich, done] = snap.board.columns;
  const { id } = await post("/api/cards", { project: proj, columnId: enrich.id, title: "ask" });
  const get = () => fetch(`${base}/api/project?project=${encodeURIComponent(proj)}`).then((r) => r.json());
  await waitFor(async () => (await get()).board.cards.find((c: any) => c.id === id)?.lastRun?.status === "question");
  let card = (await get()).board.cards.find((c: any) => c.id === id);
  expect(card.lastRun.questions).toEqual(["Color?", "Size?"]);
  expect(card.columnId).toBe(enrich.id);
  await post(`/api/cards/${id}/answer`, { project: proj, answers: ["blue", ""] });
  await waitFor(async () => (await get()).board.cards.find((c: any) => c.id === id)?.columnId === done.id);
  card = (await get()).board.cards.find((c: any) => c.id === id);
  expect(card.description).toContain("A1: blue");
  expect(card.description).toContain("A2: (no answer");
  expect(card.pendingAnswer).toBeUndefined();
});

test("startServer reuses one orchestrator per process (bun --hot safety)", () => {
  const again = startServer({ port: 0 });
  expect(again.orch).toBe(srv.orch);
  again.server.stop(true);
});

test("a project locked by another live process runs no agents", async () => {
  const { createHash } = await import("node:crypto");
  const locked = mkdtempSync(join(tmpdir(), "ns-locked-"));
  mkdirSync(join(home, "locks"), { recursive: true });
  const hash = createHash("sha1").update(locked).digest("hex").slice(0, 12);
  writeFileSync(join(home, "locks", `${hash}.lock`), String(process.ppid));
  const snap = await post("/api/projects/open", { path: locked });
  expect(snap.lockedBy).toBe(process.ppid);
  const res = await post(
    "/api/board",
    { project: locked, columns: [{ name: "Enrich", type: "skill", skill: "enrich" }] },
    "PUT",
  );
  await post("/api/cards", { project: locked, columnId: res.board.columns[0].id, title: "x" });
  await Bun.sleep(400);
  const s = await fetch(`${base}/api/project?project=${encodeURIComponent(locked)}`).then((r) => r.json());
  expect(Object.values(s.live)).not.toContain("running");
  expect(s.board.cards[0].lastRun).toBeUndefined();
});

test("loop guard ignores runs before the last user action", async () => {
  const snap = await post("/api/projects/open", { path: proj });
  const enrich = snap.board.columns[1];
  const { id } = await post("/api/cards", { project: proj, columnId: enrich.id, title: "guarded" });
  const get = async () => (await fetch(`${base}/api/project?project=${encodeURIComponent(proj)}`).then((r) => r.json())).board.cards.find((c: any) => c.id === id);
  await waitFor(async () => (await get()).columnId !== enrich.id);
  // Simulate a burst of stale runs, then move the card back by hand: it must run again.
  srv.orch.get(proj).mutate(() => {
    const card = srv.orch.get(proj).card(id)!;
    for (let i = 0; i < 20; i++) srv.orch.get(proj).addHistory(card, "run", "Enrich: stale");
  });
  await post(`/api/cards/${id}/move`, { project: proj, columnId: enrich.id });
  await waitFor(async () => (await get()).columnId !== enrich.id);
  expect((await get()).lastRun?.error).toBeUndefined();
});

test("removing a column that still holds cards is refused", async () => {
  const snap = await post("/api/projects/open", { path: proj });
  const res = await post("/api/board", { project: proj, columns: [snap.board.columns[0]] }, "PUT");
  expect(res.error).toContain("move them first");
});

// ---- per-column model ---------------------------------------------------------

const argsEntries = (): { title: string; resumed: boolean; model: string | null }[] =>
  readFileSync(argsLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const getProject = (path: string) => fetch(`${base}/api/project?project=${encodeURIComponent(path)}`).then((r) => r.json());

test("PUT /api/board keeps model on an inert column", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-model-inert-"));
  await post("/api/projects/open", { path: dir });
  const res = await post("/api/board", { project: dir, columns: [{ name: "Inbox", type: "inert", model: "opus" }] }, "PUT");
  expect(res.board.columns[0].model).toBe("opus");
  const file = JSON.parse(readFileSync(join(dir, "nightshift.json"), "utf8"));
  expect(file.columns[0].model).toBe("opus");
});

test("run passes the column model to claude", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-model-run-"));
  updateSettings({ model: "sonnet" });
  try {
    await post("/api/projects/open", { path: dir });
    const res = await post(
      "/api/board",
      {
        project: dir,
        columns: [
          { name: "Fast", type: "skill", skill: "enrich", model: "haiku" },
          { name: "Plain", type: "skill", skill: "enrich" },
          { name: "Done", type: "inert" },
        ],
      },
      "PUT",
    );
    const [fast, plain, done] = res.board.columns;
    const { id } = await post("/api/cards", { project: dir, columnId: fast.id, title: "m1" });
    await waitFor(async () => (await getProject(dir)).board.cards.find((c: any) => c.id === id)?.columnId === done.id);
    const entries = argsEntries();
    expect(entries.find((e) => e.title === "m1")?.model).toBe("haiku");
    expect(entries.find((e) => e.title === "m1 ✓")?.model).toBe("sonnet");

    updateSettings({ model: "" });
    const second = await post("/api/cards", { project: dir, columnId: plain.id, title: "m2" });
    await waitFor(async () => (await getProject(dir)).board.cards.find((c: any) => c.id === second.id)?.columnId === done.id);
    const entry = argsEntries().find((e) => e.title === "m2");
    expect(entry).toBeDefined();
    expect(entry!.model).toBeNull();
  } finally {
    updateSettings({ model: "" });
  }
});

test("resume uses the column model at resume time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-model-resume-"));
  await post("/api/projects/open", { path: dir });
  const res = await post(
    "/api/board",
    { project: dir, columns: [{ name: "Ask", type: "skill", skill: "enrich", model: "opus" }, { name: "Done", type: "inert" }] },
    "PUT",
  );
  const [ask, done] = res.board.columns;
  const { id } = await post("/api/cards", { project: dir, columnId: ask.id, title: "ask" });
  await waitFor(async () => (await getProject(dir)).board.cards.find((c: any) => c.id === id)?.lastRun?.status === "question");
  const before = argsEntries().length;
  await post("/api/board", { project: dir, columns: [{ ...ask, model: "haiku" }, done] }, "PUT");
  await post(`/api/cards/${id}/answer`, { project: dir, answers: ["blue", "big"] });
  await waitFor(async () => (await getProject(dir)).board.cards.find((c: any) => c.id === id)?.columnId === done.id);
  const resumed = argsEntries().slice(before).filter((e) => e.resumed);
  expect(resumed).toHaveLength(1);
  expect(resumed[0]!.model).toBe("haiku");
});
