import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column, HistoryEntry, LogLine, Settings } from "../src/shared/types.ts";
import { must, quiet, removeTempDirs, settingsGlobal, tempDir, waitFor } from "./helpers.ts";

/** An mtime long ago: a file that is rewritten gets a later one. */
const PAST = new Date("2020-01-01T00:00:00Z");

// bun test shares one module cache across files: settings.ts and skills.ts capture NIGHTSHIFT_HOME and
// NIGHTSHIFT_USER_SKILLS once, at the first import. If another file (e.g. progress-prompts.test.ts, through
// orchestrator.ts) imported them first, the paths set below are ignored. So the home and the user skills
// directory used by this file are read back from the modules, never from the variables set here.
process.env.NIGHTSHIFT_HOME = tempDir("ns-home-");
process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-skills-");
// Read by the fake claude binary, which inherits the server's environment.
const argsLog = join(tempDir("ns-args-"), "args.jsonl");
const prevArgsLog = process.env.FAKE_ARGS_LOG;
process.env.FAKE_ARGS_LOG = argsLog;

const { parseFrontmatter, listSkills, createSkill, skillsDir } = await import("../src/server/skills.ts");
const { splitArgs, resolveModel } = await import("../src/server/orchestrator.ts");
const { defaultBoard, needsRun, normalizeBoard, numberingChanged, Project } = await import("../src/server/store.ts");
const { startServer } = await import("../src/server/server.ts");
const { updateSettings, NIGHTSHIFT_HOME } = await import("../src/server/settings.ts");
const home = NIGHTSHIFT_HOME;
const userSkills = skillsDir("user", "");
const { BACKLOG_COLUMN_ID, columnMaxParallel, DONE_COLUMN_ID } = await import("../src/shared/types.ts");

test("parseFrontmatter handles folded descriptions", () => {
  const fm = parseFrontmatter("---\nname: x\ndescription: >\n  hello\n  world\n---\nbody");
  expect(fm).toEqual({ name: "x", description: "hello world" });
});

test("splitArgs honours quotes", () => {
  expect(splitArgs(`--allowedTools "Bash(git *)" --x 'a b' c`)).toEqual(["--allowedTools", "Bash(git *)", "--x", "a b", "c"]);
});

test("needsRun logic", () => {
  const b = normalizeBoard(
    {
      columns: [
        { id: "a", name: "A", type: "skill", skill: "s" },
        { id: "b", name: "B", type: "inert" },
      ],
      cards: [],
    },
    "x",
  );
  const card = { id: "c", columnId: "a", enteredColumnAt: "2026-01-01T00:00:00Z", history: [] } as unknown as Card;
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
  expect(b.columns[1].model).toBe("sonnet");
  expect("model" in b.columns[2]).toBe(false);
  expect("model" in b.columns[3]).toBe(false);
});

test("resolveModel priority", () => {
  const col = (model?: string): Column => ({ id: "a", name: "A", type: "skill", skill: "s", ...(model ? { model } : {}) });
  const settings = (model: string): Settings => ({
    maxParallel: 1,
    claudePath: "claude",
    permissionMode: "auto",
    model,
    extraArgs: "",
    recentProjects: [],
    soundNotifications: true,
    language: "auto",
  });
  expect(resolveModel(col("opus"), settings("sonnet"))).toBe("opus");
  expect(resolveModel(col(), settings(" sonnet "))).toBe("sonnet");
  expect(resolveModel(col(), settings(""))).toBeUndefined();
});

test("project skills shadow user skills", () => {
  const proj = tempDir("ns-proj-");
  mkdirSync(join(userSkills, "dup"), { recursive: true });
  writeFileSync(join(userSkills, "dup", "SKILL.md"), "---\nname: dup\ndescription: user\n---\n");
  createSkill(proj, "dup", "project one", "body");
  const dup = listSkills(proj).filter((s) => s.name === "dup");
  expect(dup).toHaveLength(1);
  expect(dup[0].scope).toBe("project");
  expect(() => createSkill(proj, "Bad Name", "", "")).toThrow();
});

// ---- end to end with the fake claude binary ----------------------------------

let srv: ReturnType<typeof startServer>;
let base = "";
const proj = tempDir("ns-e2e-");

beforeAll(() => {
  updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts"), maxParallel: 2 });
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
  const byTitle = Object.fromEntries(file.cards.map((c: Card) => [c.title, c]));
  for (const t of ["one ✓", "two ✓", "three ✓"]) {
    expect(byTitle[t].columnId).toBe(done.id);
    expect(byTitle[t].description).toBe("done by fake");
  }
  expect(byTitle.fail.columnId).toBe(enrich.id);
  expect(byTitle.fail.lastRun.status).toBe("error");

  // Retry re-queues the failed card.
  await post(`/api/cards/${byTitle.fail.id}/retry`, { project: proj });
  const log = await fetch(`${base}/api/cards/${byTitle.fail.id}/log?project=${encodeURIComponent(proj)}`).then((r) => r.json());
  expect(Array.isArray(log)).toBe(true);
});

test("questions: agent asks all at once, answers resume the session", async () => {
  const snap = await post("/api/projects/open", { path: proj });
  const [, enrich, done] = snap.board.columns;
  const { id } = await post("/api/cards", { project: proj, columnId: enrich.id, title: "ask" });
  const get = () => fetch(`${base}/api/project?project=${encodeURIComponent(proj)}`).then((r) => r.json());
  await waitFor(async () => (await get()).board.cards.find((c: Card) => c.id === id)?.lastRun?.status === "question");
  let card = (await get()).board.cards.find((c: Card) => c.id === id);
  expect(card.lastRun.questions).toEqual(["Color?", "Size?"]);
  expect(card.columnId).toBe(enrich.id);
  await post(`/api/cards/${id}/answer`, { project: proj, answers: ["blue", ""] });
  await waitFor(async () => (await get()).board.cards.find((c: Card) => c.id === id)?.columnId === done.id);
  card = (await get()).board.cards.find((c: Card) => c.id === id);
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
  const locked = tempDir("ns-locked-");
  mkdirSync(join(home, "locks"), { recursive: true });
  const hash = createHash("sha1").update(locked).digest("hex").slice(0, 12);
  writeFileSync(join(home, "locks", `${hash}.lock`), String(process.ppid));
  const snap = await post("/api/projects/open", { path: locked });
  expect(snap.lockedBy).toBe(process.ppid);
  const res = await post("/api/board", { project: locked, columns: [{ name: "Enrich", type: "skill", skill: "enrich" }] }, "PUT");
  await post("/api/cards", { project: locked, columnId: res.board.columns[1].id, title: "x" });
  await quiet(400); // no agent may start in a project locked by another process
  const s = await fetch(`${base}/api/project?project=${encodeURIComponent(locked)}`).then((r) => r.json());
  expect(Object.values(s.live)).not.toContain("running");
  expect(s.board.cards[0].lastRun).toBeUndefined();
});

test("loop guard ignores runs before the last user action", async () => {
  const snap = await post("/api/projects/open", { path: proj });
  const enrich = snap.board.columns.find((c: Column) => c.name === "Enrich");
  const { id } = await post("/api/cards", { project: proj, columnId: enrich.id, title: "guarded" });
  const get = async () =>
    (await fetch(`${base}/api/project?project=${encodeURIComponent(proj)}`).then((r) => r.json())).board.cards.find(
      (c: Card) => c.id === id,
    );
  await waitFor(async () => (await get()).columnId !== enrich.id);
  // Simulate a burst of stale runs, then move the card back by hand: it must run again.
  srv.orch.get(proj).mutate(() => {
    const card = must(srv.orch.get(proj).card(id), "the card");
    for (let i = 0; i < 20; i++) srv.orch.get(proj).addHistory(card, "run", "Enrich: stale");
  });
  // The user move must be strictly later than the stale runs (same-millisecond entries count as recent).
  const stamp = Date.now();
  while (Date.now() === stamp); // the next millisecond
  await post(`/api/cards/${id}/move`, { project: proj, columnId: enrich.id });
  await waitFor(async () => (await get()).columnId !== enrich.id);
  expect((await get()).lastRun?.error).toBeUndefined();
}, 20000);

test("column maxParallel caps agents in that column", async () => {
  const p2 = tempDir("ns-colmax-");
  await post("/api/projects/open", { path: p2 });
  const res = await post(
    "/api/board",
    {
      project: p2,
      columns: [
        { name: "Merge", type: "skill", skill: "enrich", maxParallel: 1 },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  expect(res.board.columns[1].maxParallel).toBe(1);
  for (const t of ["cap1", "cap2", "cap3"]) await post("/api/cards", { project: p2, columnId: res.board.columns[1].id, title: t });
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
  const p = tempDir("ns-colpar-");
  await post("/api/projects/open", { path: p });
  const res = await post(
    "/api/board",
    {
      project: p,
      columns: [
        { name: "Work", type: "skill", skill: "enrich", maxParallel: 2 },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  expect(res.board.columns[1].maxParallel).toBe(2);
  for (const t of ["par1", "par2", "par3", "par4"]) await post("/api/cards", { project: p, columnId: res.board.columns[1].id, title: t });
  let maxRunning = 0;
  await waitFor(async () => {
    const s = await liveRunning(p);
    maxRunning = Math.max(maxRunning, s.running);
    return s.idle && s.board.cards.every((c: Card) => c.columnId === res.board.columns[2].id);
  });
  expect(maxRunning).toBe(2);
});

test("global cap cuts below the sum of column limits", async () => {
  const p = tempDir("ns-globalcap-");
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
  const [, a, b, done] = res.board.columns;
  for (const t of ["a1", "a2", "a3"]) await post("/api/cards", { project: p, columnId: a.id, title: t });
  for (const t of ["b1", "b2", "b3"]) await post("/api/cards", { project: p, columnId: b.id, title: t });
  let maxRunning = 0;
  await waitFor(async () => {
    const s = await liveRunning(p);
    maxRunning = Math.max(maxRunning, s.running);
    return s.idle && s.board.cards.length === 6 && s.board.cards.every((c: Card) => c.columnId === done.id);
  }, 15000);
  // Column limits sum to 4, but the global cap (2) bounds the total.
  expect(maxRunning).toBeLessThanOrEqual(2);
  expect(maxRunning).toBeGreaterThan(0);
});

test("column maxParallel normalization", async () => {
  const p = tempDir("ns-colnorm-");
  await post("/api/projects/open", { path: p });
  const cols = [
    { name: "Big", type: "skill", skill: "enrich", maxParallel: 99 },
    { name: "Empty", type: "skill", skill: "enrich", maxParallel: "" },
    { name: "Zero", type: "skill", skill: "enrich", maxParallel: 0 },
    { name: "Text", type: "skill", skill: "enrich", maxParallel: "abc" },
    { name: "Inert", type: "inert", maxParallel: 3 },
  ];
  const check = (columns: Column[]) => {
    expect(columns[1].maxParallel).toBe(32);
    for (const c of columns.slice(2)) expect("maxParallel" in c).toBe(false);
  };
  const res = await post("/api/board", { project: p, columns: cols }, "PUT");
  check(res.board.columns);
  check(normalizeBoard({ columns: cols.map((c, i) => ({ id: `c${i}`, ...c })), cards: [] }, "x").columns);
  expect(
    normalizeBoard({ columns: [{ id: "s", name: "S", type: "skill", skill: "s", maxParallel: "5" }], cards: [] }, "x").columns[1]
      .maxParallel,
  ).toBe(5);
});

test("columnMaxParallel default", () => {
  expect(columnMaxParallel({})).toBe(1);
  expect(columnMaxParallel({ maxParallel: 5 })).toBe(5);
});

test("agent test command is stored on the card and can be started and stopped", async () => {
  const p3 = tempDir("ns-test-");
  await post("/api/projects/open", { path: p3 });
  const res = await post(
    "/api/board",
    {
      project: p3,
      columns: [
        { name: "Impl", type: "skill", skill: "enrich" },
        { name: "Testing", type: "inert" },
      ],
    },
    "PUT",
  );
  const { id } = await post("/api/cards", { project: p3, columnId: res.board.columns[1].id, title: "with-test" });
  const snap = async () => fetch(`${base}/api/project?project=${encodeURIComponent(p3)}`).then((r) => r.json());
  await waitFor(async () => !!(await snap()).board.cards[0].test);
  expect((await snap()).board.cards[0].test).toEqual({ command: "echo hello-from-test; sleep 30", url: "http://localhost:9999" });
  await post(`/api/cards/${id}/test/start`, { project: p3 });
  expect((await snap()).testing).toEqual([id]);
  const log = () => fetch(`${base}/api/cards/${id}/test?project=${encodeURIComponent(p3)}`).then((r) => r.json());
  await waitFor(async () => (await log()).some((l: LogLine) => l.text === "hello-from-test"));
  await post(`/api/cards/${id}/test/stop`, { project: p3 });
  await waitFor(async () => (await snap()).testing.length === 0);
  expect((await log()).at(-1).text).toContain("Exited");
});

test("column maxParallel caps agents in that column", async () => {
  const p2 = tempDir("ns-colmax-");
  await post("/api/projects/open", { path: p2 });
  const res = await post(
    "/api/board",
    {
      project: p2,
      columns: [
        { name: "Merge", type: "skill", skill: "enrich", maxParallel: 1 },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  expect(res.board.columns[1].maxParallel).toBe(1);
  for (const t of ["cap1", "cap2", "cap3"]) await post("/api/cards", { project: p2, columnId: res.board.columns[1].id, title: t });
  let maxRunning = 0;
  await waitFor(async () => {
    const s = await fetch(`${base}/api/project?project=${encodeURIComponent(p2)}`).then((r) => r.json());
    maxRunning = Math.max(maxRunning, Object.values(s.live).filter((v) => v === "running").length);
    return Object.keys(s.live).length === 0;
  });
  expect(maxRunning).toBe(1);
});

test("agent test command is stored on the card and can be started and stopped", async () => {
  const p3 = tempDir("ns-test-");
  await post("/api/projects/open", { path: p3 });
  const res = await post(
    "/api/board",
    {
      project: p3,
      columns: [
        { name: "Impl", type: "skill", skill: "enrich" },
        { name: "Testing", type: "inert" },
      ],
    },
    "PUT",
  );
  const { id } = await post("/api/cards", { project: p3, columnId: res.board.columns[1].id, title: "with-test" });
  const snap = async () => fetch(`${base}/api/project?project=${encodeURIComponent(p3)}`).then((r) => r.json());
  await waitFor(async () => !!(await snap()).board.cards[0].test);
  expect((await snap()).board.cards[0].test).toEqual({ command: "echo hello-from-test; sleep 30", url: "http://localhost:9999" });
  await post(`/api/cards/${id}/test/start`, { project: p3 });
  expect((await snap()).testing).toEqual([id]);
  const log = () => fetch(`${base}/api/cards/${id}/test?project=${encodeURIComponent(p3)}`).then((r) => r.json());
  await waitFor(async () => (await log()).some((l: LogLine) => l.text === "hello-from-test"));
  await post(`/api/cards/${id}/test/stop`, { project: p3 });
  await waitFor(async () => (await snap()).testing.length === 0);
  expect((await log()).at(-1).text).toContain("Exited");
});

test("fields unknown to this version survive load and PUT", async () => {
  const dir = tempDir("ns-future-");
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
  const dir = tempDir("ns-noagents-");
  writeFileSync(
    join(dir, "nightshift.json"),
    JSON.stringify({
      version: 1,
      name: "n",
      columns: [{ id: "s", name: "S", type: "skill", skill: "enrich" }],
      cards: [{ id: "k", title: "t", columnId: "s", history: [] }],
    }),
  );
  const passive = new Orchestrator({ agents: false });
  const p = passive.open(dir);
  await quiet(); // a passive orchestrator never starts the card
  expect(must(p.card("k")).lastRun).toBeUndefined();
  expect(passive.snapshot(p).agentsDisabled).toBe(true);
  expect(passive.snapshot(p).live).toEqual({ k: "queued" });
  const { createHash } = await import("node:crypto");
  const lock = join(home, "locks", `${createHash("sha1").update(dir).digest("hex").slice(0, 12)}.lock`);
  expect(require("node:fs").existsSync(lock)).toBe(false);
  passive.shutdown();
});

test("an agent that stops without its result is resumed once to collect it", async () => {
  const dir = tempDir("ns-recover-");
  await post("/api/projects/open", { path: dir });
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        { name: "S", type: "skill", skill: "enrich" },
        { name: "D", type: "inert" },
      ],
    },
    "PUT",
  );
  const [, s, d] = res.board.columns;
  for (const title of ["no-output", "die"]) await post("/api/cards", { project: dir, columnId: s.id, title });
  const get = async () => (await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards;
  await waitFor(async () => (await get()).every((c: Card) => c.columnId === d.id));
  for (const c of await get()) {
    expect(c.title).toBe("answered");
    expect(c.description).toContain("stopped before returning");
  }
});

test("prompt goes through stdin, never argv", async () => {
  const dir = tempDir("ns-stdin-");
  const argsLog = join(dir, "args.jsonl");
  const previous = process.env.FAKE_ARGS_LOG;
  process.env.FAKE_ARGS_LOG = argsLog;
  try {
    await post("/api/projects/open", { path: dir });
    const res = await post(
      "/api/board",
      {
        project: dir,
        columns: [
          { name: "S", type: "skill", skill: "enrich" },
          { name: "D", type: "inert" },
        ],
      },
      "PUT",
    );
    await post("/api/cards", { project: dir, columnId: res.board.columns[1].id, title: "argv-check" });
    await waitFor(async () => existsSync(argsLog) && readFileSync(argsLog, "utf8").includes("argv-check"));
  } finally {
    if (previous === undefined) delete process.env.FAKE_ARGS_LOG;
    else process.env.FAKE_ARGS_LOG = previous;
  }
  const entry = readFileSync(argsLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .find((e) => e.title === "argv-check");
  expect(entry.argvHasCard).toBe(false);
});

test("removing a column that still holds cards is refused", async () => {
  const snap = await post("/api/projects/open", { path: proj });
  const res = await post("/api/board", { project: proj, columns: [snap.board.columns[0]] }, "PUT");
  expect(res.error).toContain("move them first");
});

// ---- per-column model ---------------------------------------------------------

const argsEntries = (): { title: string; resumed: boolean; model: string | null }[] =>
  readFileSync(argsLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const getProject = (path: string) => fetch(`${base}/api/project?project=${encodeURIComponent(path)}`).then((r) => r.json());

test("PUT /api/board keeps model on an inert column", async () => {
  const dir = tempDir("ns-model-inert-");
  await post("/api/projects/open", { path: dir });
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        { name: "Inbox", type: "inert" },
        { name: "Hold", type: "inert", model: "opus" },
      ],
    },
    "PUT",
  );
  expect(res.board.columns[1].model).toBe("opus");
  const file = JSON.parse(readFileSync(join(dir, "nightshift.json"), "utf8"));
  expect(file.columns[1].model).toBe("opus");
});

test("run passes the column model to claude", async () => {
  const dir = tempDir("ns-model-run-");
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
    const [, fast, plain, done] = res.board.columns;
    const { id } = await post("/api/cards", { project: dir, columnId: fast.id, title: "m1" });
    await waitFor(async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === id)?.columnId === done.id);
    const entries = argsEntries();
    expect(entries.find((e) => e.title === "m1")?.model).toBe("haiku");
    expect(entries.find((e) => e.title === "m1 ✓")?.model).toBe("sonnet");

    updateSettings({ model: "" });
    const second = await post("/api/cards", { project: dir, columnId: plain.id, title: "m2" });
    await waitFor(async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === second.id)?.columnId === done.id);
    const entry = argsEntries().find((e) => e.title === "m2");
    expect(entry).toBeDefined();
    expect(must(entry).model).toBeNull();
  } finally {
    updateSettings({ model: "" });
  }
});

test("resume uses the column model at resume time", async () => {
  const dir = tempDir("ns-model-resume-");
  await post("/api/projects/open", { path: dir });
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        { name: "Ask", type: "skill", skill: "enrich", model: "opus" },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  const [backlog, ask, done] = res.board.columns;
  const { id } = await post("/api/cards", { project: dir, columnId: ask.id, title: "ask" });
  await waitFor(async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === id)?.lastRun?.status === "question");
  const before = argsEntries().length;
  await post("/api/board", { project: dir, columns: [backlog, { ...ask, model: "haiku" }, done] }, "PUT");
  await post(`/api/cards/${id}/answer`, { project: dir, answers: ["blue", "big"] });
  await waitFor(async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === id)?.columnId === done.id);
  const resumed = argsEntries()
    .slice(before)
    .filter((e) => e.resumed);
  expect(resumed).toHaveLength(1);
  expect(resumed[0].model).toBe("haiku");
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
  const fresh = tempDir("ns-num-");
  const snap = await post("/api/projects/open", { path: fresh });
  expect(snap.board.nextCardNumber).toBe(1);
  const ids: string[] = [];
  for (const t of ["a", "b", "c"]) ids.push((await post("/api/cards", { project: fresh, title: t })).id);
  const get = () => fetch(`${base}/api/project?project=${encodeURIComponent(fresh)}`).then((r) => r.json());
  expect(numbers((await get()).board)).toEqual({ [ids[0]]: 1, [ids[1]]: 2, [ids[2]]: 3 });
  await fetch(`${base}/api/cards/${ids[2]}?project=${encodeURIComponent(fresh)}`, { method: "DELETE" });
  const { id, number } = await post("/api/cards", { project: fresh, title: "d" });
  expect(number).toBe(4);
  const file = JSON.parse(readFileSync(join(fresh, "nightshift.json"), "utf8"));
  expect(file.cards.find((c: Card) => c.id === id).number).toBe(4);
  expect(file.cards.map((c: Card) => c.number)).toEqual([1, 2, 4]);
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
    {
      cards: [
        rawCard("old", "2026-01-01T00:00:00Z"),
        rawCard("five", "2026-01-02T00:00:00Z", 5),
        rawCard("bad", "2026-01-03T00:00:00Z", 1.5),
      ],
    },
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
  const legacy = tempDir("ns-legacy-");
  const legacyFile = join(legacy, "nightshift.json");
  writeFileSync(
    legacyFile,
    JSON.stringify({
      version: 1,
      name: "legacy",
      columns: [{ id: "col", name: "Backlog", type: "inert" }],
      cards: [rawCard("b", "2026-01-02T00:00:00Z"), rawCard("a", "2026-01-01T00:00:00Z")],
    }),
  );
  const migrated = new Project(legacy);
  migrated.close();
  const onDisk = JSON.parse(readFileSync(legacyFile, "utf8"));
  expect(numbers(onDisk)).toEqual({ a: 1, b: 2 });
  expect(onDisk.nextCardNumber).toBe(3);
  expect(numberingChanged(onDisk, normalizeBoard(onDisk, "legacy"))).toBe(false);

  const clean = tempDir("ns-clean-");
  const cleanFile = join(clean, "nightshift.json");
  writeFileSync(cleanFile, JSON.stringify(onDisk));
  // Pin the mtime in the past: a rewrite would move it to now.
  utimesSync(cleanFile, PAST, PAST);
  const before = { text: readFileSync(cleanFile, "utf8"), mtime: statSync(cleanFile).mtimeMs };
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
  const dir = join(tempDir("ns-shot-"), "nightshift-screenshots");
  mkdirSync(dir);
  const png = join(dir, "01-home.png");
  writeFileSync(
    png,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
  );
  const outside = join(tempDir("ns-outside-"), "not-a-shot.png");
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
  const card = {
    id: "card_abc",
    number: 32,
    title: "T",
    description: "D",
    columnId: "col",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    enteredColumnAt: "2026-01-01T00:00:00Z",
    history: [],
  };
  const board = { version: 1 as const, name: "x", columns: [column], cards: [card], nextCardNumber: 33 };
  expect(buildPrompt(board, card, column, undefined)).toContain(`<card id="card_abc" ref="#32">`);
});

test("settings: soundNotifications defaults to true and persists", async () => {
  const { getSettings } = await import("../src/server/settings.ts");
  const file = join(home, "settings.json");
  const old = { maxParallel: 2, claudePath: "claude", permissionMode: "auto", model: "", extraArgs: "", recentProjects: [] };
  writeFileSync(file, JSON.stringify(old));
  must(settingsGlobal().__nightshiftSettings).current = null;
  expect(getSettings().soundNotifications).toBe(true);
  writeFileSync(file, JSON.stringify({ ...old, soundNotifications: "true" }));
  must(settingsGlobal().__nightshiftSettings).current = null;
  expect(getSettings().soundNotifications).toBe(true);
  updateSettings({ soundNotifications: false });
  expect(JSON.parse(readFileSync(file, "utf8")).soundNotifications).toBe(false);
  expect(readFileSync(file, "utf8")).toContain('"soundNotifications": false');
  updateSettings({ soundNotifications: null as unknown as boolean });
  expect(JSON.parse(readFileSync(file, "utf8")).soundNotifications).toBe(true);
});

// ---- attention events ---------------------------------------------------------

type AttentionEvent = { type: "attention"; project: string; cardId: string; kind: string };

/** Fresh project with the given columns; collects the attention events of that project only. */
async function attentionBoard(columns: object[]) {
  updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts"), maxParallel: 2 });
  const dir = tempDir("ns-attn-");
  await post("/api/projects/open", { path: dir });
  const res = await post("/api/board", { project: dir, columns }, "PUT");
  const events: AttentionEvent[] = [];
  const stop = srv.orch.on((e) => {
    if (e.type === "attention" && e.project === dir) events.push(e);
  });
  const card = async (id: string) => (await getProject(dir)).board.cards.find((c: Card) => c.id === id);
  const idle = async (id: string) => !(await getProject(dir)).live[id];
  const forCard = (id: string) => events.filter((e) => e.cardId === id);
  return {
    dir, // Without the Backlog the server puts first: the tests address the columns they sent.
    cols: (res.board.columns as Column[]).slice(1),
    events,
    stop,
    card,
    idle,
    forCard,
  };
}

test("attention: run ending in an inert column emits inert", async () => {
  const b = await attentionBoard([
    { name: "Work", type: "skill", skill: "enrich" },
    { name: "Done", type: "inert" },
  ]);
  try {
    const [work, done] = b.cols;
    const { id } = await post("/api/cards", { project: b.dir, columnId: work.id, title: "go" });
    await waitFor(async () => (await b.card(id))?.columnId === done.id && (await b.idle(id)));
    await waitFor(() => b.forCard(id).length > 0);
    expect(b.forCard(id)).toEqual([{ type: "attention", project: b.dir, cardId: id, kind: "inert" }]);
  } finally {
    b.stop();
  }
});

test("attention: question emits question", async () => {
  const b = await attentionBoard([
    { name: "Work", type: "skill", skill: "enrich" },
    { name: "Done", type: "inert" },
  ]);
  try {
    const { id } = await post("/api/cards", { project: b.dir, columnId: b.cols[0].id, title: "ask" });
    await waitFor(async () => (await b.card(id))?.lastRun?.status === "question" && (await b.idle(id)));
    await waitFor(() => b.forCard(id).length > 0);
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
    await waitFor(() => b.forCard(failed.id).length > 0 && b.forCard(unknown.id).length > 0);
    expect(b.forCard(failed.id)).toEqual([{ type: "attention", project: b.dir, cardId: failed.id, kind: "error" }]);
    expect(b.forCard(unknown.id)).toEqual([{ type: "attention", project: b.dir, cardId: unknown.id, kind: "error" }]);
  } finally {
    b.stop();
  }
});

test("attention: manual move into inert column emits nothing", async () => {
  const b = await attentionBoard([
    { name: "Inbox", type: "inert" },
    { name: "Done", type: "inert" },
  ]);
  try {
    const [inbox, done] = b.cols;
    const { id } = await post("/api/cards", { project: b.dir, columnId: inbox.id, title: "manual" });
    await post(`/api/cards/${id}/move`, { project: b.dir, columnId: done.id });
    await quiet(); // a manual move emits no attention event
    expect((await b.card(id)).columnId).toBe(done.id);
    expect(b.forCard(id)).toEqual([]);
  } finally {
    b.stop();
  }
});

test("attention: cancelled run emits nothing", async () => {
  const b = await attentionBoard([
    { name: "Work", type: "skill", skill: "enrich" },
    { name: "Done", type: "inert" },
  ]);
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
    await quiet(200); // a cancelled or moved run emits no attention event
    expect(b.forCard(cancelled.id)).toEqual([]);
    expect(b.forCard(moved.id)).toEqual([]);
  } finally {
    b.stop();
  }
}, 15000);

test("attention: move into a skill column or stay emits nothing", async () => {
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
    await waitFor(() => b.forCard(flow.id).length > 0);
    await quiet(100); // the stay card emits nothing
    expect((await b.card(stay.id)).columnId).toBe(a.id);
    expect(b.forCard(stay.id)).toEqual([]);
    expect(b.forCard(flow.id)).toEqual([{ type: "attention", project: b.dir, cardId: flow.id, kind: "inert" }]);
  } finally {
    b.stop();
  }
}, 10000);

test("attention: answering emits nothing, resumed run follows the rules", async () => {
  const b = await attentionBoard([
    { name: "Work", type: "skill", skill: "enrich" },
    { name: "Done", type: "inert" },
  ]);
  try {
    const [work, done] = b.cols;
    const { id } = await post("/api/cards", { project: b.dir, columnId: work.id, title: "ask" });
    await waitFor(async () => b.forCard(id).length === 1 && (await b.idle(id)));
    expect(b.forCard(id)[0].kind).toBe("question");
    // The resumed run takes at least the fake delay, so any event seen right after the answer came from answer() itself.
    await post(`/api/cards/${id}/answer`, { project: b.dir, answers: ["blue", "big"] });
    expect(b.forCard(id)).toHaveLength(1);
    await waitFor(async () => (await b.card(id))?.columnId === done.id && (await b.idle(id)));
    await waitFor(() => b.forCard(id).length > 1);
    expect(b.forCard(id).map((e) => e.kind)).toEqual(["question", "inert"]);
  } finally {
    b.stop();
  }
}, 10000);

// ---- system Done column -------------------------------------------------------

test("defaultBoard has the Nightshift pipeline", () => {
  const b = defaultBoard("x");
  expect(b.columns.map((c) => c.name)).toEqual(["Backlog", "Grill", "Plan", "Implement", "Review", "To Test", "Merge", "Done"]);
  const noId = b.columns.map(({ id: _id, ...rest }) => rest);
  expect(noId).toEqual([
    { name: "Backlog", type: "inert" },
    { name: "Grill", type: "skill", skill: "nightshift-grill", model: "opus", maxParallel: 3, emoji: "🔥" },
    { name: "Plan", type: "skill", skill: "nightshift-plan", model: "opus", maxParallel: 3, emoji: "🗺️" },
    { name: "Implement", type: "skill", skill: "nightshift-implement", model: "sonnet", maxParallel: 3, emoji: "🧑‍💻" },
    { name: "Review", type: "skill", skill: "nightshift-review", model: "opus", maxParallel: 3, emoji: "🧐" },
    { name: "To Test", type: "inert", emoji: "🪲" },
    { name: "Merge", type: "skill", skill: "nightshift-merge", model: "sonnet", maxParallel: 1, emoji: "🎉" },
    { name: "Done", type: "inert" },
  ]);
  expect(b.columns.at(-1)).toEqual({ id: DONE_COLUMN_ID, name: "Done", type: "inert" });
  for (const c of b.columns) expect("instructions" in c).toBe(false);
  expect(b.cards).toEqual([]);
  expect(b.nextCardNumber).toBe(1);
});

test("defaultBoard emojis match nightshift.json and survive normalization", () => {
  const b = defaultBoard("x");
  expect(b.columns.map((c) => c.emoji)).toEqual([
    undefined,
    "\u{1F525}",
    "\u{1F5FA}\uFE0F",
    "\u{1F9D1}\u200D\u{1F4BB}",
    "\u{1F9D0}",
    "\u{1FAB2}",
    "\u{1F389}",
    undefined,
  ]);
  expect(JSON.stringify(normalizeBoard(b, "x"))).toBe(JSON.stringify(b));
});

test("defaultBoard ids are fresh", () => {
  const ids = (b: ReturnType<typeof defaultBoard>) => b.columns.slice(1, -1).map((c) => c.id);
  const a = ids(defaultBoard("x"));
  const b = ids(defaultBoard("x"));
  expect(a.length).toBe(6);
  expect(new Set(a).size).toBe(6);
  expect(new Set(b).size).toBe(6);
  for (const id of [...a, ...b]) {
    expect(id.startsWith("col_")).toBe(true);
    expect(id).not.toBe(DONE_COLUMN_ID);
  }
  expect(a.filter((id) => b.includes(id))).toEqual([]);
});

test("opening an empty folder writes the pipeline", async () => {
  const dir = tempDir("ns-empty-");
  new Project(dir).close();
  const file = join(dir, "nightshift.json");
  const disk = JSON.parse(readFileSync(file, "utf8"));
  expect(disk.columns.map((c: Column) => c.name)).toEqual(["Backlog", "Grill", "Plan", "Implement", "Review", "To Test", "Merge", "Done"]);
  expect(disk.columns.at(-1).id).toBe(DONE_COLUMN_ID);
  const text = readFileSync(file, "utf8");
  utimesSync(file, PAST, PAST);
  const mtime = statSync(file).mtimeMs;
  new Project(dir).close();
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(statSync(file).mtimeMs).toBe(mtime);
});

test("existing custom columns are untouched", async () => {
  const dir = tempDir("ns-custom-");
  const file = join(dir, "nightshift.json");
  const board = {
    version: 1,
    name: "c",
    columns: [
      { id: BACKLOG_COLUMN_ID, name: "Backlog", type: "inert" },
      { id: "a", name: "A", type: "inert" },
      { id: DONE_COLUMN_ID, name: "Done", type: "inert" },
    ],
    cards: [],
    nextCardNumber: 1,
  };
  writeFileSync(file, `${JSON.stringify(board, null, 2)}\n`);
  const text = readFileSync(file, "utf8");
  utimesSync(file, PAST, PAST);
  const mtime = statSync(file).mtimeMs;
  const p = new Project(dir);
  p.close();
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(statSync(file).mtimeMs).toBe(mtime);
  expect(p.board.columns.map((c) => c.name)).toEqual(["Backlog", "A", "Done"]);
});

test("file without columns gets the pipeline", () => {
  const b = normalizeBoard({ cards: [] }, "x");
  expect(b.columns.map((c) => c.name)).toEqual(["Backlog", "Grill", "Plan", "Implement", "Review", "To Test", "Merge", "Done"]);
});

test("done column: normalizeBoard keeps a user column named Done and puts col_done after it", () => {
  const b = normalizeBoard(
    {
      columns: [
        { id: "u", name: "Done", type: "skill", skill: "s" },
        { id: "w", name: "W", type: "inert" },
      ],
      cards: [],
    },
    "x",
  );
  expect(b.columns.map((c) => c.id)).toEqual([BACKLOG_COLUMN_ID, "u", "w", DONE_COLUMN_ID]);
  expect(b.columns[1].name).toBe("Done");
});

test("done column: load writes col_done back once, then leaves the file alone", async () => {
  const dir = tempDir("ns-done-");
  const file = join(dir, "nightshift.json");
  writeFileSync(
    file,
    JSON.stringify({ version: 1, name: "d", columns: [{ id: "a", name: "A", type: "inert" }], cards: [], nextCardNumber: 1 }),
  );
  new Project(dir).close();
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  expect(onDisk.columns.map((c: Column) => c.id)).toEqual([BACKLOG_COLUMN_ID, DONE_COLUMN_ID]);
  utimesSync(file, PAST, PAST);
  const before = { text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs };
  new Project(dir).close();
  expect(readFileSync(file, "utf8")).toBe(before.text);
  expect(statSync(file).mtimeMs).toBe(before.mtime);
});

test("done column: PUT /api/board repairs col_done and refuses a board without user columns", async () => {
  const dir = tempDir("ns-doneput-");
  const snap = await post("/api/projects/open", { path: dir });
  const [backlog] = snap.board.columns;
  const card = await post("/api/cards", { project: dir, columnId: DONE_COLUMN_ID, title: "finished" });

  const omitted = await post("/api/board", { project: dir, columns: [{ id: backlog.id, name: "Backlog", type: "inert" }] }, "PUT");
  expect(omitted.error).toBeUndefined();
  expect(omitted.board.columns.map((c: Column) => c.id)).toEqual([backlog.id, DONE_COLUMN_ID]);

  const renamed = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        { id: DONE_COLUMN_ID, name: "Shipped", type: "skill", skill: "enrich" },
        { id: backlog.id, name: "Backlog", type: "inert" },
      ],
    },
    "PUT",
  );
  expect(renamed.error).toBeUndefined();
  const last = renamed.board.columns.at(-1);
  expect(renamed.board.columns.map((c: Column) => c.id)).toEqual([backlog.id, DONE_COLUMN_ID]);
  expect(last).toEqual({ id: DONE_COLUMN_ID, name: "Done", type: "inert" });
  expect(renamed.board.cards.find((c: Card) => c.id === card.id).columnId).toBe(DONE_COLUMN_ID);

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
    await quiet(150); // no second run may start
    expect(argsEntries().length).toBe(runs + 1);
    expect(b.forCard(id)).toEqual([]);
    expect((await b.card(id)).lastRun.columnId).toBe(work.id);
  } finally {
    b.stop();
  }
});

test("done column: nextColumn from col_done is undefined", () => {
  const dir = tempDir("ns-donenext-");
  const p = new Project(dir);
  p.close();
  expect(p.nextColumnFor({ columnId: DONE_COLUMN_ID } as Card)).toBeUndefined();
  expect(p.nextColumnFor({ columnId: must(p.board.columns.at(-2)).id } as Card)?.id).toBe(DONE_COLUMN_ID);
});

// ---- user feedback ----------------------------------------------------------

/** Project where a card runs through "Work" and lands in the inert "To Test", ready to receive feedback. */
async function feedbackBoard(extra: object[] = []) {
  const b = await attentionBoard([
    { name: "Work", type: "skill", skill: "enrich" },
    { name: "To Test", type: "inert", emoji: "🪲" },
    ...extra,
  ]);
  const [work, toTest] = b.cols;
  const landed = async (title: string) => {
    const { id } = await post("/api/cards", { project: b.dir, columnId: work.id, title });
    await waitFor(async () => (await b.card(id))?.columnId === toTest.id && (await b.idle(id)));
    return id as string;
  };
  const send = (id: string, text: string) => post(`/api/cards/${id}/feedback`, { project: b.dir, text });
  const settled = (id: string, ok: (c: Card) => boolean) => waitFor(async () => ok(await b.card(id)) && (await b.idle(id)));
  return { ...b, work, toTest, landed, send, settled };
}

test("feedback in inert column resumes the session and applies move", async () => {
  const b = await feedbackBoard();
  try {
    const id = await b.landed("go");
    const before = argsEntries().length;
    expect((await b.send(id, "fix FAKE_MOVE=stay")).error).toBeUndefined();
    await b.settled(id, (c) => c.title === "feedback done");
    const card = await b.card(id);
    expect(
      argsEntries()
        .slice(before)
        .filter((e) => e.resumed),
    ).toHaveLength(1);
    expect(card.columnId).toBe(b.toTest.id);
    expect(card.lastRun.columnId).toBe(b.toTest.id);
    expect(card.lastRun.status).toBe("success");
    expect(card.lastRun.sessionId).toBeDefined();
    expect(card.lastRun.skill).toBe("enrich");
    expect(card.pendingAnswer).toBeUndefined();
    expect(card.description).toContain("<feedback>\nfix FAKE_MOVE=stay\n</feedback>");
    expect(card.description).toContain(`(id: ${b.toTest.id}, inert)`);
    expect(card.description).toContain("Board columns, in order:");
    expect(card.description).toContain(`2. Work (id: ${b.work.id}, skill: enrich)`);
    expect(card.description).toContain('the skill "enrich"');
    expect(card.history.some((h: HistoryEntry) => h.text === "Feedback sent to agent")).toBe(true);
    const log = await fetch(`${base}/api/cards/${id}/log?project=${encodeURIComponent(b.dir)}`).then((r) => r.json());
    expect(log.some((l: LogLine) => l.text.startsWith("Retour utilisateur : fix"))).toBe(true);
  } finally {
    b.stop();
  }
});

test("feedback move next goes to the column after the current one", async () => {
  const b = await feedbackBoard([{ name: "Review", type: "skill", skill: "enrich" }]);
  try {
    const review = b.cols[2];
    const id = await b.landed("go");
    await b.send(id, "ship it FAKE_MOVE=next");
    await b.settled(id, (c) => c.columnId !== b.toTest.id && c.lastRun?.columnId === review.id);
    const entries = argsEntries().filter((e) => e.title === "feedback done ✓" || e.title === "feedback done");
    expect(entries.some((e) => !e.resumed)).toBe(true);
    expect((await b.card(id)).history.some((h: HistoryEntry) => h.kind === "run" && h.text.startsWith("Review:"))).toBe(true);
  } finally {
    b.stop();
  }
});

test("second feedback keeps the session skill", async () => {
  const b = await feedbackBoard();
  try {
    const id = await b.landed("go");
    await b.send(id, "one FAKE_MOVE=stay");
    await b.settled(id, (c) => c.lastRun?.summary === "feedback applied");
    await b.send(id, "two FAKE_MOVE=stay");
    await b.settled(id, (c) => c.description.includes("<feedback>\ntwo"));
    const card = await b.card(id);
    expect(card.columnId).toBe(b.toTest.id);
    expect(card.description).toContain('Follow the skill "enrich"');
    expect(card.lastRun.skill).toBe("enrich");
  } finally {
    b.stop();
  }
});

test("feedback question in inert column can be answered", async () => {
  const b = await feedbackBoard();
  try {
    const id = await b.landed("go");
    await b.send(id, "hmm FAKE_ASK");
    await b.settled(id, (c) => c.lastRun?.status === "question");
    let card = await b.card(id);
    expect(card.columnId).toBe(b.toTest.id);
    expect(card.lastRun.questions).toEqual(["Which one?"]);
    const before = argsEntries().length;
    expect((await post(`/api/cards/${id}/answer`, { project: b.dir, answers: ["the blue one"] })).error).toBeUndefined();
    await b.settled(id, (c) => c.lastRun?.status === "success" && c.lastRun.summary === "resumed");
    card = await b.card(id);
    expect(
      argsEntries()
        .slice(before)
        .filter((e) => e.resumed),
    ).toHaveLength(1);
    expect(card.description).toContain("A1: the blue one");
    expect(card.description).toContain('with the skill "enrich"');
  } finally {
    b.stop();
  }
});

test("feedback in inert column ignores the column limit and survives cancelStaleJobs", async () => {
  updateSettings({ maxParallel: 3 });
  const b = await feedbackBoard();
  try {
    const ids = [await b.landed("go1"), await b.landed("go2")];
    let maxRunning = 0;
    await Promise.all(ids.map((id) => b.send(id, "both FAKE_MOVE=stay")));
    await waitFor(async () => {
      const s = await getProject(b.dir);
      maxRunning = Math.max(maxRunning, Object.values(s.live).filter((v) => v === "running").length);
      return Object.keys(s.live).length === 0;
    });
    expect(maxRunning).toBe(2);
    for (const id of ids) {
      const card = await b.card(id);
      expect(card.lastRun.status).toBe("success");
      expect(card.lastRun.summary).toBe("feedback applied");
      expect(card.columnId).toBe(b.toTest.id);
      const log = await fetch(`${base}/api/cards/${id}/log?project=${encodeURIComponent(b.dir)}`).then((r) => r.json());
      expect(log.some((l: LogLine) => l.text.includes("stopping agent"))).toBe(false);
    }
  } finally {
    updateSettings({ maxParallel: 2 });
    b.stop();
  }
});

test("feedback is refused without session or while queued", async () => {
  const b = await feedbackBoard();
  try {
    const fresh = await post("/api/cards", { project: b.dir, columnId: b.toTest.id, title: "fresh" });
    expect((await b.send(fresh.id, "hello")).error).toBe("This card has no session to send feedback to");
    const id = await b.landed("go");
    expect((await b.send(id, "   ")).error).toBe("Empty feedback");
    expect((await b.send(id, "first FAKE_MOVE=stay")).error).toBeUndefined();
    expect((await b.send(id, "second")).error).toBe("This card has no session to send feedback to");
    await b.settled(id, (c) => c.lastRun?.summary === "feedback applied");
    expect((await b.send(id, "third FAKE_MOVE=stay")).error).toBeUndefined();
    await b.settled(id, (c) => c.description.includes("<feedback>\nthird"));
  } finally {
    b.stop();
  }
});

test("failed feedback leaves the card in place", async () => {
  const b = await feedbackBoard();
  try {
    const id = await b.landed("go");
    await b.send(id, "break FAKE_FAIL");
    await b.settled(id, (c) => c.lastRun?.status === "error");
    let card = await b.card(id);
    expect(card.columnId).toBe(b.toTest.id);
    expect(card.pendingAnswer).toBeUndefined();
    expect(card.lastRun.sessionId).toBeDefined();
    expect((await b.send(id, "again FAKE_MOVE=stay")).error).toBeUndefined();
    await b.settled(id, (c) => c.lastRun?.status === "success");
    card = await b.card(id);
    expect(card.columnId).toBe(b.toTest.id);
  } finally {
    b.stop();
  }
});

test("cancelled feedback keeps the session so feedback can be sent again", async () => {
  const b = await feedbackBoard();
  try {
    const id = await b.landed("go");
    await b.send(id, "wait FAKE_SLOW FAKE_MOVE=stay");
    await waitFor(async () => (await getProject(b.dir)).live[id] === "running");
    expect((await post(`/api/cards/${id}/cancel`, { project: b.dir })).cancelled).toBe(true);
    await b.settled(id, (c) => c.lastRun?.status === "cancelled");
    const card = await b.card(id);
    expect(card.columnId).toBe(b.toTest.id);
    expect(card.lastRun.sessionId).toBeDefined();
    expect((await b.send(id, "again FAKE_MOVE=stay")).error).toBeUndefined();
    await b.settled(id, (c) => c.lastRun?.status === "success");
  } finally {
    b.stop();
  }
});

// ---- time transitions recorded in card history ---------------------------------

async function openSkillBoard(prefix: string, maxParallel?: number) {
  const dir = tempDir(prefix);
  await post("/api/projects/open", { path: dir });
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        { name: "Backlog", type: "inert" },
        { name: "Enrich", type: "skill", skill: "enrich", ...(maxParallel ? { maxParallel } : {}) },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  return { dir, backlog: res.board.columns[0], enrich: res.board.columns[1], done: res.board.columns[2] };
}

test("pipeline writes transitions: moved, queued, started, run", async () => {
  const { dir, backlog, enrich } = await openSkillBoard("ns-trans-");
  const { id } = await post("/api/cards", { project: dir, columnId: backlog.id, title: "trans" });
  await post(`/api/cards/${id}/move`, { project: dir, columnId: enrich.id });
  await waitFor(async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === id)?.lastRun?.status === "success");
  const card = (await getProject(dir)).board.cards.find((c: Card) => c.id === id);
  const kinds = card.history.map((h: HistoryEntry) => h.kind).slice(0, 5);
  expect(kinds).toEqual(["created", "moved", "queued", "started", "run"]);
  for (const h of card.history.slice(0, 5)) {
    if (h.kind === "run") expect(h.columnId).toBeUndefined();
    else expect(h.columnId).toBe(h.kind === "created" ? backlog.id : enrich.id);
  }
});

test("queue time is due to the column limit", async () => {
  const { cardTimeSlices } = await import("../src/shared/timeline.ts");
  const { dir, enrich } = await openSkillBoard("ns-queuetime-", 1);
  await post("/api/cards", { project: dir, columnId: enrich.id, title: "q1" });
  await post("/api/cards", { project: dir, columnId: enrich.id, title: "q2" });
  await waitFor(async () => Object.keys((await getProject(dir)).live).length === 0);
  const board = (await getProject(dir)).board;
  const [c1, c2] = board.cards.filter((c: Card) => c.title.startsWith("q"));
  const run1 = c1.history.find((h: HistoryEntry) => h.kind === "run");
  const started2 = c2.history.find((h: HistoryEntry) => h.kind === "started");
  expect(started2.at >= run1.at).toBe(true);
  const slices = cardTimeSlices(c2, board.columns, Date.now());
  expect(must(slices.find((s) => s.columnId === enrich.id && s.part === "queued")).ms).toBeGreaterThan(0);
});

test("answer and retry put the card back in the queue", async () => {
  const { dir, enrich, done } = await openSkillBoard("ns-requeue-");
  const { id } = await post("/api/cards", { project: dir, columnId: enrich.id, title: "ask" });
  const card = async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === id);
  await waitFor(async () => (await card()).lastRun?.status === "question");
  await post(`/api/cards/${id}/answer`, { project: dir, answers: ["blue", ""] });
  await waitFor(async () => (await card()).columnId === done.id);
  let h = (await card()).history;
  const i = h.findIndex((e: HistoryEntry) => e.text.startsWith("Answered"));
  expect(h[i].kind).toBe("edited");
  expect(h[i + 1]).toMatchObject({ kind: "queued", columnId: enrich.id });

  const f = await post("/api/cards", { project: dir, columnId: enrich.id, title: "fail" });
  const failed = async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === f.id);
  await waitFor(async () => (await failed()).lastRun?.status === "error");
  await post(`/api/cards/${f.id}/retry`, { project: dir });
  h = (await failed()).history;
  const r = h.findIndex((e: HistoryEntry) => e.text.startsWith("Retry requested"));
  expect(h[r].kind).toBe("edited");
  expect(h[r + 1]).toMatchObject({ kind: "queued", columnId: enrich.id });
  await waitFor(async () => Object.keys((await getProject(dir)).live).length === 0);
});

test("history cap keeps the time in timeBase", async () => {
  const { cardTimeSlices } = await import("../src/shared/timeline.ts");
  const dir = tempDir("ns-cap-");
  const p = new Project(dir);
  const [a, b] = p.board.columns.filter((c) => c.type === "inert");
  const seed = () => {
    p.mutate((bd) => {
      bd.cards.push({
        id: "k",
        number: 1,
        title: "t",
        description: "",
        columnId: a.id,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        enteredColumnAt: "2026-01-01T00:00:00.000Z",
        history: [],
      });
    });
    return p.card("k");
  };
  const card = p.board.cards[0] ?? seed();
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (i: number) => new Date(t0 + i * 60_000).toISOString();
  const full: HistoryEntry[] = [{ at: at(0), kind: "created", text: `Created in ${a.name}`, columnId: a.id }];
  for (let i = 1; i <= 60; i++) {
    const [from, to] = i % 2 ? [a, b] : [b, a];
    full.push({ at: at(i), kind: "moved", text: `Moved by user: ${from.name} → ${to.name}`, columnId: to.id });
  }
  const before = cardTimeSlices(
    { ...card, createdAt: at(0), history: full, timeBase: undefined } as unknown as Card,
    p.board.columns,
    t0 + 100 * 60_000,
  );
  card.createdAt = at(0);
  card.history = [];
  for (const e of full) {
    p.addHistory(card, e.kind, e.text, e.columnId);
    card.history[card.history.length - 1].at = e.at;
  }
  expect(card.history.length).toBeLessThanOrEqual(50);
  expect(card.timeBase).toBeDefined();
  const after = cardTimeSlices(card, p.board.columns, t0 + 100 * 60_000);
  expect(after).toEqual(before);
  p.close();
});

test("--no-agents instance records queued but never started", async () => {
  const { Orchestrator } = await import("../src/server/orchestrator.ts");
  const dir = tempDir("ns-noagents-hist-");
  writeFileSync(
    join(dir, "nightshift.json"),
    JSON.stringify({
      version: 1,
      name: "n",
      columns: [
        { id: "i", name: "I", type: "inert" },
        { id: "s", name: "S", type: "skill", skill: "enrich" },
      ],
      cards: [{ id: "k", title: "t", columnId: "i", history: [] }],
    }),
  );
  const passive = new Orchestrator({ agents: false });
  const p = passive.open(dir);
  p.mutate((board) => p.moveCard(board, "k", "s", undefined, "Moved by user"));
  await quiet(); // nothing may start
  const kinds = must(p.card("k")).history.map((h) => h.kind);
  expect(kinds).toContain("queued");
  expect(kinds).not.toContain("started");
  passive.shutdown();
});
