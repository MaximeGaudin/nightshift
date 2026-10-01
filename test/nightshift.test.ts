import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const { defaultBoard, needsRun, normalizeBoard, numberingChanged, Project } = await import("../src/server/store.ts");
const { startServer } = await import("../src/server/server.ts");
const { updateSettings } = await import("../src/server/settings.ts");
const { columnMaxParallel, DONE_COLUMN_ID } = await import("../src/shared/types.ts");

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
  const settings = (model: string): any => ({ maxParallel: 1, claudePath: "claude", permissionMode: "auto", model, extraArgs: "", recentProjects: [], soundNotifications: true });
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

test("pipeline: skill column without maxParallel runs one card at a time, respects limit, moves them on", async () => {
  const snap = await post("/api/projects/open", { path: proj });
  const backlog = snap.board.columns[0];
  const done = snap.board.columns.at(-1);
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
  // No maxParallel on the column: default 1, even though the global cap is 2.
  expect(maxRunning).toBe(1);

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
  const enrich = snap.board.columns.find((c: any) => c.name === "Enrich");
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
}, 20000);

test("column maxParallel caps agents in that column", async () => {
  const p2 = mkdtempSync(join(tmpdir(), "ns-colmax-"));
  await post("/api/projects/open", { path: p2 });
  const res = await post(
    "/api/board",
    { project: p2, columns: [{ name: "Merge", type: "skill", skill: "enrich", maxParallel: 1 }, { name: "Done", type: "inert" }] },
    "PUT",
  );
  expect(res.board.columns[0].maxParallel).toBe(1);
  for (const t of ["cap1", "cap2", "cap3"]) await post("/api/cards", { project: p2, columnId: res.board.columns[0].id, title: t });
  let maxRunning = 0;
  await waitFor(async () => {
    const s = await fetch(`${base}/api/project?project=${encodeURIComponent(p2)}`).then((r) => r.json());
    maxRunning = Math.max(maxRunning, Object.values(s.live).filter((v) => v === "running").length);
    return Object.keys(s.live).length === 0;
  });
  expect(maxRunning).toBe(1);
});

const liveRunning = async (project: string) => {
  const s = await fetch(`${base}/api/project?project=${encodeURIComponent(project)}`).then((r) => r.json());
  return { running: Object.values(s.live).filter((v) => v === "running").length, idle: Object.keys(s.live).length === 0, board: s.board };
};

test("column maxParallel > 1 runs several cards", async () => {
  const p = mkdtempSync(join(tmpdir(), "ns-colpar-"));
  await post("/api/projects/open", { path: p });
  const res = await post(
    "/api/board",
    { project: p, columns: [{ name: "Work", type: "skill", skill: "enrich", maxParallel: 2 }, { name: "Done", type: "inert" }] },
    "PUT",
  );
  expect(res.board.columns[0].maxParallel).toBe(2);
  for (const t of ["par1", "par2", "par3", "par4"]) await post("/api/cards", { project: p, columnId: res.board.columns[0].id, title: t });
  let maxRunning = 0;
  await waitFor(async () => {
    const s = await liveRunning(p);
    maxRunning = Math.max(maxRunning, s.running);
    return s.idle && s.board.cards.every((c: any) => c.columnId === res.board.columns[1].id);
  });
  expect(maxRunning).toBe(2);
});

test("global cap cuts below the sum of column limits", async () => {
  const p = mkdtempSync(join(tmpdir(), "ns-globalcap-"));
  await post("/api/projects/open", { path: p });
  const res = await post(
    "/api/board",
    {
      project: p,
      columns: [
        { name: "A", type: "skill", skill: "enrich", maxParallel: 2 },
        { name: "B", type: "skill", skill: "enrich", maxParallel: 2 },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  const [a, b, done] = res.board.columns;
  for (const t of ["a1", "a2", "a3"]) await post("/api/cards", { project: p, columnId: a.id, title: t });
  for (const t of ["b1", "b2", "b3"]) await post("/api/cards", { project: p, columnId: b.id, title: t });
  let maxRunning = 0;
  await waitFor(async () => {
    const s = await liveRunning(p);
    maxRunning = Math.max(maxRunning, s.running);
    return s.idle && s.board.cards.length === 6 && s.board.cards.every((c: any) => c.columnId === done.id);
  }, 15000);
  // Column limits sum to 4, but the global cap (2) bounds the total.
  expect(maxRunning).toBeLessThanOrEqual(2);
  expect(maxRunning).toBeGreaterThan(0);
});

test("column maxParallel normalization", async () => {
  const p = mkdtempSync(join(tmpdir(), "ns-colnorm-"));
  await post("/api/projects/open", { path: p });
  const cols = [
    { name: "Big", type: "skill", skill: "enrich", maxParallel: 99 },
    { name: "Empty", type: "skill", skill: "enrich", maxParallel: "" },
    { name: "Zero", type: "skill", skill: "enrich", maxParallel: 0 },
    { name: "Text", type: "skill", skill: "enrich", maxParallel: "abc" },
    { name: "Inert", type: "inert", maxParallel: 3 },
  ];
  const check = (columns: any[]) => {
    expect(columns[0].maxParallel).toBe(32);
    for (const c of columns.slice(1)) expect("maxParallel" in c).toBe(false);
  };
  const res = await post("/api/board", { project: p, columns: cols }, "PUT");
  check(res.board.columns);
  check(normalizeBoard({ columns: cols.map((c, i) => ({ id: `c${i}`, ...c })), cards: [] }, "x").columns);
  expect(normalizeBoard({ columns: [{ id: "s", name: "S", type: "skill", skill: "s", maxParallel: "5" }], cards: [] }, "x").columns[0]!.maxParallel).toBe(5);
});

test("columnMaxParallel default", () => {
  expect(columnMaxParallel({})).toBe(1);
  expect(columnMaxParallel({ maxParallel: 5 })).toBe(5);
});

test("agent test command is stored on the card and can be started and stopped", async () => {
  const p3 = mkdtempSync(join(tmpdir(), "ns-test-"));
  await post("/api/projects/open", { path: p3 });
  const res = await post("/api/board", { project: p3, columns: [{ name: "Impl", type: "skill", skill: "enrich" }, { name: "Testing", type: "inert" }] }, "PUT");
  const { id } = await post("/api/cards", { project: p3, columnId: res.board.columns[0].id, title: "with-test" });
  const snap = async () => fetch(`${base}/api/project?project=${encodeURIComponent(p3)}`).then((r) => r.json());
  await waitFor(async () => !!(await snap()).board.cards[0].test);
  expect((await snap()).board.cards[0].test).toEqual({ command: "echo hello-from-test; sleep 30", url: "http://localhost:9999" });
  await post(`/api/cards/${id}/test/start`, { project: p3 });
  expect((await snap()).testing).toEqual([id]);
  const log = () => fetch(`${base}/api/cards/${id}/test?project=${encodeURIComponent(p3)}`).then((r) => r.json());
  await waitFor(async () => (await log()).some((l: any) => l.text === "hello-from-test"));
  await post(`/api/cards/${id}/test/stop`, { project: p3 });
  await waitFor(async () => (await snap()).testing.length === 0);
  expect((await log()).at(-1).text).toContain("Exited");
});

test("column maxParallel caps agents in that column", async () => {
  const p2 = mkdtempSync(join(tmpdir(), "ns-colmax-"));
  await post("/api/projects/open", { path: p2 });
  const res = await post(
    "/api/board",
    { project: p2, columns: [{ name: "Merge", type: "skill", skill: "enrich", maxParallel: 1 }, { name: "Done", type: "inert" }] },
    "PUT",
  );
  expect(res.board.columns[0].maxParallel).toBe(1);
  for (const t of ["cap1", "cap2", "cap3"]) await post("/api/cards", { project: p2, columnId: res.board.columns[0].id, title: t });
  let maxRunning = 0;
  await waitFor(async () => {
    const s = await fetch(`${base}/api/project?project=${encodeURIComponent(p2)}`).then((r) => r.json());
    maxRunning = Math.max(maxRunning, Object.values(s.live).filter((v) => v === "running").length);
    return Object.keys(s.live).length === 0;
  });
  expect(maxRunning).toBe(1);
});

test("agent test command is stored on the card and can be started and stopped", async () => {
  const p3 = mkdtempSync(join(tmpdir(), "ns-test-"));
  await post("/api/projects/open", { path: p3 });
  const res = await post("/api/board", { project: p3, columns: [{ name: "Impl", type: "skill", skill: "enrich" }, { name: "Testing", type: "inert" }] }, "PUT");
  const { id } = await post("/api/cards", { project: p3, columnId: res.board.columns[0].id, title: "with-test" });
  const snap = async () => fetch(`${base}/api/project?project=${encodeURIComponent(p3)}`).then((r) => r.json());
  await waitFor(async () => !!(await snap()).board.cards[0].test);
  expect((await snap()).board.cards[0].test).toEqual({ command: "echo hello-from-test; sleep 30", url: "http://localhost:9999" });
  await post(`/api/cards/${id}/test/start`, { project: p3 });
  expect((await snap()).testing).toEqual([id]);
  const log = () => fetch(`${base}/api/cards/${id}/test?project=${encodeURIComponent(p3)}`).then((r) => r.json());
  await waitFor(async () => (await log()).some((l: any) => l.text === "hello-from-test"));
  await post(`/api/cards/${id}/test/stop`, { project: p3 });
  await waitFor(async () => (await snap()).testing.length === 0);
  expect((await log()).at(-1).text).toContain("Exited");
});

test("fields unknown to this version survive load and PUT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-future-"));
  writeFileSync(
    join(dir, "nightshift.json"),
    JSON.stringify({
      version: 1,
      name: "f",
      futureBoardField: 1,
      columns: [{ id: "c1", name: "A", type: "inert", futureColumnField: "x" }],
      cards: [{ id: "k1", title: "t", columnId: "c1", futureCardField: [1, 2], history: [] }],
    }),
  );
  const snap = await post("/api/projects/open", { path: dir });
  await post("/api/board", { project: dir, columns: snap.board.columns }, "PUT");
  await post(`/api/cards/k1`, { project: dir, title: "t2" }, "PATCH");
  const file = JSON.parse(readFileSync(join(dir, "nightshift.json"), "utf8"));
  expect(file.futureBoardField).toBe(1);
  expect(file.columns[0].futureColumnField).toBe("x");
  expect(file.cards[0].futureCardField).toEqual([1, 2]);
  expect(file.cards[0].title).toBe("t2");
});

test("--no-agents instance never runs agents nor takes the lock", async () => {
  const { Orchestrator } = await import("../src/server/orchestrator.ts");
  const dir = mkdtempSync(join(tmpdir(), "ns-noagents-"));
  writeFileSync(
    join(dir, "nightshift.json"),
    JSON.stringify({ version: 1, name: "n", columns: [{ id: "s", name: "S", type: "skill", skill: "enrich" }], cards: [{ id: "k", title: "t", columnId: "s", history: [] }] }),
  );
  const passive = new Orchestrator({ agents: false });
  const p = passive.open(dir);
  await Bun.sleep(300);
  expect(p.card("k")!.lastRun).toBeUndefined();
  expect(passive.snapshot(p).agentsDisabled).toBe(true);
  expect(passive.snapshot(p).live).toEqual({ k: "queued" });
  const { createHash } = await import("node:crypto");
  const lock = join(home, "locks", `${createHash("sha1").update(dir).digest("hex").slice(0, 12)}.lock`);
  expect(require("node:fs").existsSync(lock)).toBe(false);
  passive.shutdown();
});

test("an agent that stops without its result is resumed once to collect it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-recover-"));
  await post("/api/projects/open", { path: dir });
  const res = await post("/api/board", { project: dir, columns: [{ name: "S", type: "skill", skill: "enrich" }, { name: "D", type: "inert" }] }, "PUT");
  const [s, d] = res.board.columns;
  for (const title of ["no-output", "die"]) await post("/api/cards", { project: dir, columnId: s.id, title });
  const get = async () => (await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards;
  await waitFor(async () => (await get()).every((c: any) => c.columnId === d.id));
  for (const c of await get()) {
    expect(c.title).toBe("answered");
    expect(c.description).toContain("stopped before returning");
  }
});

test("prompt goes through stdin, never argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-stdin-"));
  const argsLog = join(dir, "args.jsonl");
  const previous = process.env.FAKE_ARGS_LOG;
  process.env.FAKE_ARGS_LOG = argsLog;
  try {
    await post("/api/projects/open", { path: dir });
    const res = await post("/api/board", { project: dir, columns: [{ name: "S", type: "skill", skill: "enrich" }, { name: "D", type: "inert" }] }, "PUT");
    await post("/api/cards", { project: dir, columnId: res.board.columns[0].id, title: "argv-check" });
    await waitFor(async () => existsSync(argsLog) && readFileSync(argsLog, "utf8").includes("argv-check"));
  } finally {
    if (previous === undefined) delete process.env.FAKE_ARGS_LOG;
    else process.env.FAKE_ARGS_LOG = previous;
  }
  const entry = readFileSync(argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.title === "argv-check");
  expect(entry.argvHasCard).toBe(false);
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

// ---- card numbers -----------------------------------------------------------

const rawCard = (id: string, createdAt: string, number?: unknown) => ({
  id,
  title: id,
  createdAt,
  ...(number === undefined ? {} : { number }),
});
const numbers = (b: { cards: { id: string; number: number }[] }) => Object.fromEntries(b.cards.map((c) => [c.id, c.number]));

test("numbering: fresh board assigns 1,2,3 and never reuses", async () => {
  const fresh = mkdtempSync(join(tmpdir(), "ns-num-"));
  const snap = await post("/api/projects/open", { path: fresh });
  expect(snap.board.nextCardNumber).toBe(1);
  const ids: string[] = [];
  for (const t of ["a", "b", "c"]) ids.push((await post("/api/cards", { project: fresh, title: t })).id);
  const get = () => fetch(`${base}/api/project?project=${encodeURIComponent(fresh)}`).then((r) => r.json());
  expect(numbers((await get()).board)).toEqual({ [ids[0]!]: 1, [ids[1]!]: 2, [ids[2]!]: 3 });
  await fetch(`${base}/api/cards/${ids[2]}?project=${encodeURIComponent(fresh)}`, { method: "DELETE" });
  const { id, number } = await post("/api/cards", { project: fresh, title: "d" });
  expect(number).toBe(4);
  const file = JSON.parse(readFileSync(join(fresh, "nightshift.json"), "utf8"));
  expect(file.cards.find((c: any) => c.id === id).number).toBe(4);
  expect(file.cards.map((c: any) => c.number)).toEqual([1, 2, 4]);
  expect(file.nextCardNumber).toBe(5);
});

test("numbering: migration in createdAt order", () => {
  const b = normalizeBoard(
    {
      cards: [
        rawCard("late", "2026-01-03T00:00:00Z"),
        rawCard("tieA", "2026-01-02T00:00:00Z"),
        rawCard("early", "2026-01-01T00:00:00Z"),
        rawCard("tieB", "2026-01-02T00:00:00Z"),
      ],
    },
    "x",
  );
  expect(b.cards.map((c) => c.id)).toEqual(["late", "tieA", "early", "tieB"]);
  expect(numbers(b)).toEqual({ early: 1, tieA: 2, tieB: 3, late: 4 });
  expect(b.nextCardNumber).toBe(5);

  const three = normalizeBoard(
    { cards: [rawCard("c", "2026-01-03T00:00:00Z"), rawCard("a", "2026-01-01T00:00:00Z"), rawCard("b", "2026-01-02T00:00:00Z")] },
    "x",
  );
  expect(three.cards.map((c) => c.id)).toEqual(["c", "a", "b"]);
  expect(numbers(three)).toEqual({ a: 1, b: 2, c: 3 });
  expect(three.nextCardNumber).toBe(4);
  expect(normalizeBoard({ cards: [] }, "x").nextCardNumber).toBe(1);
});

test("numbering: partial migration starts after the highest", () => {
  const b = normalizeBoard(
    { cards: [rawCard("old", "2026-01-01T00:00:00Z"), rawCard("five", "2026-01-02T00:00:00Z", 5), rawCard("bad", "2026-01-03T00:00:00Z", 1.5)] },
    "x",
  );
  expect(numbers(b)).toEqual({ five: 5, old: 6, bad: 7 });
  expect(b.nextCardNumber).toBe(8);
  const simple = normalizeBoard({ cards: [rawCard("five", "2026-01-01T00:00:00Z", 5), rawCard("none", "2026-01-02T00:00:00Z")] }, "x");
  expect(numbers(simple)).toEqual({ five: 5, none: 6 });
  expect(simple.nextCardNumber).toBe(7);
});

test("numbering: duplicate repair keeps the older", () => {
  const b = normalizeBoard(
    {
      nextCardNumber: 4,
      cards: [rawCard("newer", "2026-01-02T00:00:00Z", 3), rawCard("older", "2026-01-01T00:00:00Z", 3)],
    },
    "x",
  );
  expect(b.cards.map((c) => c.id)).toEqual(["newer", "older"]);
  expect(numbers(b)).toEqual({ older: 3, newer: 4 });
  expect(b.nextCardNumber).toBe(5);
});

test("numbering: counter too low is raised, higher counter kept", () => {
  const cards = [rawCard("a", "2026-01-01T00:00:00Z", 7), rawCard("b", "2026-01-02T00:00:00Z", 2)];
  expect(normalizeBoard({ nextCardNumber: 2, cards }, "x").nextCardNumber).toBe(8);
  const high = normalizeBoard({ nextCardNumber: 20, cards: [...cards, rawCard("c", "2026-01-03T00:00:00Z")] }, "x");
  expect(numbers(high)).toEqual({ a: 7, b: 2, c: 20 });
  expect(high.nextCardNumber).toBe(21);
  expect(normalizeBoard({ nextCardNumber: 20, cards }, "x").nextCardNumber).toBe(20);
});

test("numbering: load writes back only when changed", async () => {
  const legacy = mkdtempSync(join(tmpdir(), "ns-legacy-"));
  const legacyFile = join(legacy, "nightshift.json");
  writeFileSync(
    legacyFile,
    JSON.stringify({ version: 1, name: "legacy", columns: [{ id: "col", name: "Backlog", type: "inert" }], cards: [rawCard("b", "2026-01-02T00:00:00Z"), rawCard("a", "2026-01-01T00:00:00Z")] }),
  );
  const migrated = new Project(legacy);
  migrated.close();
  const onDisk = JSON.parse(readFileSync(legacyFile, "utf8"));
  expect(numbers(onDisk)).toEqual({ a: 1, b: 2 });
  expect(onDisk.nextCardNumber).toBe(3);
  expect(numberingChanged(onDisk, normalizeBoard(onDisk, "legacy"))).toBe(false);

  const clean = mkdtempSync(join(tmpdir(), "ns-clean-"));
  const cleanFile = join(clean, "nightshift.json");
  writeFileSync(cleanFile, JSON.stringify(onDisk));
  const before = { text: readFileSync(cleanFile, "utf8"), mtime: statSync(cleanFile).mtimeMs };
  await Bun.sleep(20);
  const opened = new Project(clean);
  opened.close();
  expect(opened.board.nextCardNumber).toBe(3);
  expect(readFileSync(cleanFile, "utf8")).toBe(before.text);
  expect(statSync(cleanFile).mtimeMs).toBe(before.mtime);
});

test("screenshot: serves a linked png and rejects the rest", async () => {
  const snap = await post("/api/projects/open", { path: proj });
  const backlog = snap.board.columns.find((c: { type: string }) => c.type === "inert");
  const { id } = await post("/api/cards", { project: proj, columnId: backlog.id, title: "shot" });
  const dir = join(mkdtempSync(join(tmpdir(), "ns-shot-")), "nightshift-screenshots");
  mkdirSync(dir);
  const png = join(dir, "01-home.png");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const outside = join(tmpdir(), `not-a-shot-${Date.now()}.png`);
  writeFileSync(outside, readFileSync(png));
  await post(`/api/cards/${id}`, { project: proj, description: `## Screenshots\n\n![Home](${png})\n![Other](${outside})` }, "PATCH");
  const q = `project=${encodeURIComponent(proj)}`;
  const ok = await fetch(`${base}/api/cards/${id}/screenshot?${q}&file=${encodeURIComponent(png)}`);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toContain("image/png");
  const rejected = await fetch(`${base}/api/cards/${id}/screenshot?${q}&file=${encodeURIComponent(outside)}`);
  expect(rejected.status).toBe(400);
});

test("prompt: includes card ref", async () => {
  const { buildPrompt } = await import("../src/server/orchestrator.ts");
  const column = { id: "col", name: "Work", type: "skill" as const, skill: "s" };
  const card = { id: "card_abc", number: 32, title: "T", description: "D", columnId: "col", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", enteredColumnAt: "2026-01-01T00:00:00Z", history: [] };
  const board = { version: 1 as const, name: "x", columns: [column], cards: [card], nextCardNumber: 33 };
  expect(buildPrompt(board, card, column, undefined)).toContain(`<card id="card_abc" ref="#32">`);
});

test("settings: soundNotifications defaults to true and persists", async () => {
  const { getSettings } = await import("../src/server/settings.ts");
  const file = join(home, "settings.json");
  const old = { maxParallel: 2, claudePath: "claude", permissionMode: "auto", model: "", extraArgs: "", recentProjects: [] };
  writeFileSync(file, JSON.stringify(old));
  (globalThis as any).__nightshiftSettings.current = null;
  expect(getSettings().soundNotifications).toBe(true);
  writeFileSync(file, JSON.stringify({ ...old, soundNotifications: "true" }));
  (globalThis as any).__nightshiftSettings.current = null;
  expect(getSettings().soundNotifications).toBe(true);
  updateSettings({ soundNotifications: false });
  expect(JSON.parse(readFileSync(file, "utf8")).soundNotifications).toBe(false);
  expect(readFileSync(file, "utf8")).toContain('"soundNotifications": false');
  updateSettings({ soundNotifications: null as any });
  expect(JSON.parse(readFileSync(file, "utf8")).soundNotifications).toBe(true);
});

// ---- attention events ---------------------------------------------------------

type AttentionEvent = { type: "attention"; project: string; cardId: string; kind: string };

/** Fresh project with the given columns; collects the attention events of that project only. */
async function attentionBoard(columns: object[]) {
  updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts"), maxParallel: 2 });
  const dir = mkdtempSync(join(tmpdir(), "ns-attn-"));
  await post("/api/projects/open", { path: dir });
  const res = await post("/api/board", { project: dir, columns }, "PUT");
  const events: AttentionEvent[] = [];
  const stop = srv.orch.on((e) => {
    if (e.type === "attention" && e.project === dir) events.push(e);
  });
  const card = async (id: string) => (await getProject(dir)).board.cards.find((c: any) => c.id === id);
  const idle = async (id: string) => !(await getProject(dir)).live[id];
  const forCard = (id: string) => events.filter((e) => e.cardId === id);
  return { dir, cols: res.board.columns as any[], events, stop, card, idle, forCard };
}

test("attention: run ending in an inert column emits inert", async () => {
  const b = await attentionBoard([{ name: "Work", type: "skill", skill: "enrich" }, { name: "Done", type: "inert" }]);
  try {
    const [work, done] = b.cols;
    const { id } = await post("/api/cards", { project: b.dir, columnId: work.id, title: "go" });
    await waitFor(async () => (await b.card(id))?.columnId === done.id && (await b.idle(id)));
    await Bun.sleep(100);
    expect(b.forCard(id)).toEqual([{ type: "attention", project: b.dir, cardId: id, kind: "inert" }]);
  } finally {
    b.stop();
  }
});

test("attention: question emits question", async () => {
  const b = await attentionBoard([{ name: "Work", type: "skill", skill: "enrich" }, { name: "Done", type: "inert" }]);
  try {
    const { id } = await post("/api/cards", { project: b.dir, columnId: b.cols[0].id, title: "ask" });
    await waitFor(async () => (await b.card(id))?.lastRun?.status === "question" && (await b.idle(id)));
    await Bun.sleep(100);
    expect(b.forCard(id)).toEqual([{ type: "attention", project: b.dir, cardId: id, kind: "question" }]);
  } finally {
    b.stop();
  }
});

test("attention: error emits error", async () => {
  const b = await attentionBoard([
    { name: "Work", type: "skill", skill: "enrich" },
    { name: "Missing", type: "skill", skill: "no-such-skill-xyz" },
    { name: "Done", type: "inert" },
  ]);
  try {
    const [work, missing] = b.cols;
    const failed = await post("/api/cards", { project: b.dir, columnId: work.id, title: "fail" });
    const unknown = await post("/api/cards", { project: b.dir, columnId: missing.id, title: "m" });
    for (const id of [failed.id, unknown.id])
      await waitFor(async () => (await b.card(id))?.lastRun?.status === "error" && (await b.idle(id)));
    await Bun.sleep(100);
    expect(b.forCard(failed.id)).toEqual([{ type: "attention", project: b.dir, cardId: failed.id, kind: "error" }]);
    expect(b.forCard(unknown.id)).toEqual([{ type: "attention", project: b.dir, cardId: unknown.id, kind: "error" }]);
  } finally {
    b.stop();
  }
});

test("attention: manual move into inert column emits nothing", async () => {
  const b = await attentionBoard([{ name: "Inbox", type: "inert" }, { name: "Done", type: "inert" }]);
  try {
    const [inbox, done] = b.cols;
    const { id } = await post("/api/cards", { project: b.dir, columnId: inbox.id, title: "manual" });
    await post(`/api/cards/${id}/move`, { project: b.dir, columnId: done.id });
    await Bun.sleep(300);
    expect((await b.card(id)).columnId).toBe(done.id);
    expect(b.forCard(id)).toEqual([]);
  } finally {
    b.stop();
  }
});

test(
  "attention: cancelled run emits nothing",
  async () => {
    const b = await attentionBoard([{ name: "Work", type: "skill", skill: "enrich" }, { name: "Done", type: "inert" }]);
    try {
      const [work, done] = b.cols;
      const running = async (id: string) => (await getProject(b.dir)).live[id] === "running";

      const cancelled = await post("/api/cards", { project: b.dir, columnId: work.id, title: "slow" });
      await waitFor(() => running(cancelled.id));
      expect((await post(`/api/cards/${cancelled.id}/cancel`, { project: b.dir })).cancelled).toBe(true);
      await waitFor(() => b.idle(cancelled.id), 4000);
      expect((await b.card(cancelled.id)).lastRun?.status).toBe("cancelled");

      const moved = await post("/api/cards", { project: b.dir, columnId: work.id, title: "slow" });
      await waitFor(() => running(moved.id));
      await post(`/api/cards/${moved.id}/move`, { project: b.dir, columnId: done.id });
      await waitFor(() => b.idle(moved.id), 4000);
      await Bun.sleep(200);
      expect(b.forCard(cancelled.id)).toEqual([]);
      expect(b.forCard(moved.id)).toEqual([]);
    } finally {
      b.stop();
    }
  },
  15000,
);

test(
  "attention: move into a skill column or stay emits nothing",
  async () => {
    const b = await attentionBoard([
      { name: "A", type: "skill", skill: "enrich" },
      { name: "B", type: "skill", skill: "enrich" },
      { name: "Done", type: "inert" },
    ]);
    try {
      const [a, , done] = b.cols;
      const stay = await post("/api/cards", { project: b.dir, columnId: a.id, title: "stay" });
      const flow = await post("/api/cards", { project: b.dir, columnId: a.id, title: "flow" });
      await waitFor(async () => (await b.card(stay.id))?.lastRun?.status === "success" && (await b.idle(stay.id)));
      await waitFor(async () => (await b.card(flow.id))?.columnId === done.id && (await b.idle(flow.id)));
      await Bun.sleep(100);
      expect((await b.card(stay.id)).columnId).toBe(a.id);
      expect(b.forCard(stay.id)).toEqual([]);
      expect(b.forCard(flow.id)).toEqual([{ type: "attention", project: b.dir, cardId: flow.id, kind: "inert" }]);
    } finally {
      b.stop();
    }
  },
  10000,
);

test(
  "attention: answering emits nothing, resumed run follows the rules",
  async () => {
    const b = await attentionBoard([{ name: "Work", type: "skill", skill: "enrich" }, { name: "Done", type: "inert" }]);
    try {
      const [work, done] = b.cols;
      const { id } = await post("/api/cards", { project: b.dir, columnId: work.id, title: "ask" });
      await waitFor(async () => b.forCard(id).length === 1 && (await b.idle(id)));
      expect(b.forCard(id)[0]!.kind).toBe("question");
      // The resumed run takes at least the fake delay, so any event seen right after the answer came from answer() itself.
      await post(`/api/cards/${id}/answer`, { project: b.dir, answers: ["blue", "big"] });
      expect(b.forCard(id)).toHaveLength(1);
      await waitFor(async () => (await b.card(id))?.columnId === done.id && (await b.idle(id)));
      await Bun.sleep(100);
      expect(b.forCard(id).map((e) => e.kind)).toEqual(["question", "inert"]);
    } finally {
      b.stop();
    }
  },
  10000,
);

// ---- system Done column -------------------------------------------------------

test("defaultBoard has the Nightshift pipeline", () => {
  const b = defaultBoard("x");
  expect(b.columns.map((c) => c.name)).toEqual(["Backlog", "Grill", "Plan", "Implement", "Review", "To Test", "Merged", "Done"]);
  const noId = b.columns.map(({ id: _id, ...rest }) => rest);
  expect(noId).toEqual([
    { name: "Backlog", type: "inert" },
    { name: "Grill", type: "skill", skill: "nightshift-grill", model: "opus", maxParallel: 3 },
    { name: "Plan", type: "skill", skill: "nightshift-plan", model: "opus", maxParallel: 3 },
    { name: "Implement", type: "skill", skill: "nightshift-implement", model: "sonnet", maxParallel: 3 },
    { name: "Review", type: "skill", skill: "nightshift-review", model: "opus", maxParallel: 1 },
    { name: "To Test", type: "inert" },
    { name: "Merged", type: "skill", skill: "nightshift-merge", model: "sonnet", maxParallel: 1 },
    { name: "Done", type: "inert" },
  ]);
  expect(b.columns.at(-1)).toEqual({ id: DONE_COLUMN_ID, name: "Done", type: "inert" });
  for (const c of b.columns) expect("instructions" in c).toBe(false);
  expect(b.cards).toEqual([]);
  expect(b.nextCardNumber).toBe(1);
});

test("defaultBoard ids are fresh", () => {
  const ids = (b: ReturnType<typeof defaultBoard>) => b.columns.slice(0, -1).map((c) => c.id);
  const a = ids(defaultBoard("x"));
  const b = ids(defaultBoard("x"));
  expect(a.length).toBe(7);
  expect(new Set(a).size).toBe(7);
  expect(new Set(b).size).toBe(7);
  for (const id of [...a, ...b]) {
    expect(id.startsWith("col_")).toBe(true);
    expect(id).not.toBe(DONE_COLUMN_ID);
  }
  expect(a.filter((id) => b.includes(id))).toEqual([]);
});

test("opening an empty folder writes the pipeline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-empty-"));
  new Project(dir).close();
  const file = join(dir, "nightshift.json");
  const disk = JSON.parse(readFileSync(file, "utf8"));
  expect(disk.columns.map((c: any) => c.name)).toEqual(["Backlog", "Grill", "Plan", "Implement", "Review", "To Test", "Merged", "Done"]);
  expect(disk.columns.at(-1).id).toBe(DONE_COLUMN_ID);
  const text = readFileSync(file, "utf8");
  const mtime = statSync(file).mtimeMs;
  await Bun.sleep(20);
  new Project(dir).close();
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(statSync(file).mtimeMs).toBe(mtime);
});

test("existing custom columns are untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-custom-"));
  const file = join(dir, "nightshift.json");
  const board = { version: 1, name: "c", columns: [{ id: "a", name: "A", type: "inert" }, { id: DONE_COLUMN_ID, name: "Done", type: "inert" }], cards: [], nextCardNumber: 1 };
  writeFileSync(file, JSON.stringify(board, null, 2) + "\n");
  const text = readFileSync(file, "utf8");
  const mtime = statSync(file).mtimeMs;
  await Bun.sleep(20);
  const p = new Project(dir);
  p.close();
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(statSync(file).mtimeMs).toBe(mtime);
  expect(p.board.columns.map((c) => c.name)).toEqual(["A", "Done"]);
});

test("file without columns gets the pipeline", () => {
  const b = normalizeBoard({ cards: [] }, "x");
  expect(b.columns.map((c) => c.name)).toEqual(["Backlog", "Grill", "Plan", "Implement", "Review", "To Test", "Merged", "Done"]);
});

test("done column: normalizeBoard keeps a user column named Done and puts col_done after it", () => {
  const b = normalizeBoard({ columns: [{ id: "u", name: "Done", type: "inert" }, { id: "w", name: "W", type: "inert" }], cards: [] }, "x");
  expect(b.columns.map((c) => c.id)).toEqual(["u", "w", DONE_COLUMN_ID]);
  expect(b.columns[0]!.name).toBe("Done");
});

test("done column: load writes col_done back once, then leaves the file alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-done-"));
  const file = join(dir, "nightshift.json");
  writeFileSync(file, JSON.stringify({ version: 1, name: "d", columns: [{ id: "a", name: "A", type: "inert" }], cards: [], nextCardNumber: 1 }));
  new Project(dir).close();
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  expect(onDisk.columns.map((c: any) => c.id)).toEqual(["a", DONE_COLUMN_ID]);
  const before = { text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs };
  await Bun.sleep(20);
  new Project(dir).close();
  expect(readFileSync(file, "utf8")).toBe(before.text);
  expect(statSync(file).mtimeMs).toBe(before.mtime);
});

test("done column: PUT /api/board repairs col_done and refuses a board without user columns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-doneput-"));
  const snap = await post("/api/projects/open", { path: dir });
  const [backlog] = snap.board.columns;
  const card = await post("/api/cards", { project: dir, columnId: DONE_COLUMN_ID, title: "finished" });

  const omitted = await post("/api/board", { project: dir, columns: [{ id: backlog.id, name: "Backlog", type: "inert" }] }, "PUT");
  expect(omitted.error).toBeUndefined();
  expect(omitted.board.columns.map((c: any) => c.id)).toEqual([backlog.id, DONE_COLUMN_ID]);

  const renamed = await post(
    "/api/board",
    { project: dir, columns: [{ id: DONE_COLUMN_ID, name: "Shipped", type: "skill", skill: "enrich" }, { id: backlog.id, name: "Backlog", type: "inert" }] },
    "PUT",
  );
  expect(renamed.error).toBeUndefined();
  const last = renamed.board.columns.at(-1);
  expect(renamed.board.columns.map((c: any) => c.id)).toEqual([backlog.id, DONE_COLUMN_ID]);
  expect(last).toEqual({ id: DONE_COLUMN_ID, name: "Done", type: "inert" });
  expect(renamed.board.cards.find((c: any) => c.id === card.id).columnId).toBe(DONE_COLUMN_ID);

  const alone = await post("/api/board", { project: dir, columns: [{ id: DONE_COLUMN_ID, name: "Done", type: "inert" }] }, "PUT");
  expect(alone.error).toBe("A board needs at least one column");
});

test("done column: next from the last user column lands in col_done with no run and no attention", async () => {
  const b = await attentionBoard([{ name: "Work", type: "skill", skill: "enrich" }]);
  try {
    const [work] = b.cols;
    const runs = argsEntries().length;
    const { id } = await post("/api/cards", { project: b.dir, columnId: work.id, title: "go" });
    await waitFor(async () => (await b.card(id))?.columnId === DONE_COLUMN_ID && (await b.idle(id)));
    await Bun.sleep(150);
    expect(argsEntries().length).toBe(runs + 1);
    expect(b.forCard(id)).toEqual([]);
    expect((await b.card(id)).lastRun.columnId).toBe(work.id);
  } finally {
    b.stop();
  }
});

test("done column: nextColumn from col_done is undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-donenext-"));
  const p = new Project(dir);
  p.close();
  expect(p.nextColumn(DONE_COLUMN_ID)).toBeUndefined();
  expect(p.nextColumn(p.board.columns.at(-2)!.id)!.id).toBe(DONE_COLUMN_ID);
});
