import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BriefingState, BriefingTopic } from "../src/shared/briefing.ts";
import type { ProjectSnapshot, ServerEvent } from "../src/shared/types.ts";
import { removeTempDirs, restoreEnvAfterAll, tempDir, waitFor } from "./helpers.ts";

// settings.ts and skills.ts capture their paths at the first import and the server keeps one orchestrator per
// process (see card-models-run.test.ts): the paths come from the imported modules, the environment is put back after.
restoreEnvAfterAll("NIGHTSHIFT_HOME", "NIGHTSHIFT_USER_SKILLS", "FAKE_DELAY_MS", "FAKE_SLOW_MS", "FAKE_BRIEFING_LOG");
const briefingLog = join(tempDir("ns-brief-log-"), "briefing.jsonl");
process.env.NIGHTSHIFT_HOME = tempDir("ns-brief-home-");
process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-brief-skills-");
process.env.FAKE_DELAY_MS = "60";
process.env.FAKE_SLOW_MS = "1500";
process.env.FAKE_BRIEFING_LOG = briefingLog;

const { startServer } = await import("../src/server/server.ts");
const { updateSettings, NIGHTSHIFT_HOME: home } = await import("../src/server/settings.ts");

let srv: ReturnType<typeof startServer>;
let base = "";
const events: ServerEvent[] = [];

beforeAll(() => {
  updateSettings({
    claudePath: join(import.meta.dir, "fake-claude.ts"),
    model: "",
    effort: "",
    extraArgs: "",
    agentFeatures: {},
    smartMode: false,
  });
  srv = startServer({ port: 0 });
  base = `http://localhost:${srv.server.port}`;
  // A copy: the briefing state is one object the server keeps changing, and a pushed event is what it held when sent.
  srv.orch.on((e) => events.push(JSON.parse(JSON.stringify(e))));
});
afterAll(async () => {
  await srv.orch.shutdown();
  srv.server.stop(true);
  removeTempDirs();
});

const call = (path: string, body: object = {}, method = "POST") =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post = async <T = { briefing: BriefingState | null }>(path: string, body: object = {}): Promise<T> => {
  const r = await call(path, body);
  const data = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${data.error}`);
  return data;
};
const snap = (dir: string): Promise<ProjectSnapshot> =>
  fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());
const state = async (dir: string): Promise<BriefingState | null> =>
  (await fetch(`${base}/api/briefing?project=${encodeURIComponent(dir)}`).then((r) => r.json())).briefing;
const need = async (dir: string): Promise<BriefingState> => {
  const st = await state(dir);
  if (!st) throw new Error("no briefing");
  return st;
};
const topicAction = (dir: string, id: string, action: string, body: object = {}) =>
  post(`/api/briefing/topics/${id}/${action}`, { project: dir, ...body });
const logged = (): { kind: string; argv: string[]; prompt: string }[] =>
  existsSync(briefingLog)
    ? readFileSync(briefingLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** Opens a paused project (its card agents never start) with the given Backlog cards, oldest first. */
async function setup(titles: string[], extra: Record<string, object> = {}) {
  const dir = tempDir("ns-brief-proj-");
  await post("/api/projects/open", { path: dir });
  await post("/api/flow/pause", { project: dir });
  const ids: Record<string, string> = {};
  for (const title of titles) {
    const r = await post<{ id: string }>("/api/cards", { project: dir, title, description: `About ${title}`, ...extra[title] });
    ids[title] = r.id;
    await Bun.sleep(3);
  }
  return { dir, ids };
}

/** Starts the briefing and waits for the triage and the first conversations to be ready. */
async function brief(dir: string): Promise<BriefingState> {
  await post("/api/briefing/start", { project: dir });
  await waitFor(
    async () => {
      const st = await state(dir);
      return !!st && !st.triage && st.topics.every((t) => t.status !== "preparing");
    },
    8000,
    () => state(dir),
  );
  return need(dir);
}

const topicOf = async (dir: string, id: string): Promise<BriefingTopic> => {
  const t = (await need(dir)).topics.find((x) => x.id === id);
  if (!t) throw new Error(`no topic ${id}`);
  return t;
};
const waitStatus = (dir: string, id: string, status: BriefingTopic["status"]) =>
  waitFor(
    async () => (await need(dir)).topics.find((x) => x.id === id)?.status === status,
    8000,
    () => state(dir),
  );
const cardOf = async (dir: string, id: string) => {
  const c = (await snap(dir)).board.cards.find((x) => x.id === id);
  if (!c) throw new Error(`no card ${id}`);
  return c;
};

test("briefing-triage", async () => {
  const { dir, ids } = await setup(["[auth] login flow", "easy typo", "solo redesign", "[auth] logout flow"]);
  const before = events.length;
  const st = await brief(dir);
  expect(st.easy.map((e) => e.cardId)).toEqual([ids["easy typo"] as string]);
  // Related cards are one topic; topics come oldest card first.
  expect(st.topics.map((t) => t.title)).toEqual(["Topic auth", "solo redesign"]);
  expect(st.topics[0]?.cardIds).toEqual([ids["[auth] login flow"] as string, ids["[auth] logout flow"] as string]);
  // Both are prepared ahead of the user (lookahead of two): the first briefing and its questions are there.
  for (const t of st.topics) {
    expect(t.status).toBe("waiting");
    expect(t.messages[0]?.role).toBe("agent");
    expect(t.sessionId).toBeTruthy();
  }
  expect(st.topics[0]?.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
  expect(st.topics[0]?.questions[0]?.recommended).toBe(0);
  expect(st.topics[0]?.questions[0]?.cardIds).toEqual([ids["[auth] login flow"] as string]);
  expect(st.costUsd).toBeGreaterThan(0);
  // Pushed to the clients, and saved outside nightshift.json.
  expect(events.slice(before).some((e) => e.type === "briefing" && e.project === dir && e.briefing?.triage?.status === "running")).toBe(
    true,
  );
  expect(readdirSync(join(home, "briefings")).length).toBeGreaterThan(0);
  expect(readFileSync(join(dir, "nightshift.json"), "utf8")).not.toContain("Topic auth");
  // The agents are read-only and get their prompt on stdin.
  const triage = logged().find((l) => l.kind === "triage" && l.prompt.includes("solo redesign"));
  expect(triage).toBeDefined();
  const argv = triage?.argv ?? [];
  expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("AskUserQuestion,Edit,Write,NotebookEdit");
  expect(argv[argv.indexOf("--effort") + 1]).toBe("low");
  expect(argv.join(" ")).not.toContain("solo redesign");
  expect(triage?.prompt).toContain('<card ref="#1"');
});

test("briefing-leaves-out", async () => {
  const { dir, ids } = await setup(["easy one", "easy draft", "blocker thing", "held thing"], { "easy draft": { draft: true } });
  await call(`/api/cards/${ids["held thing"]}`, { project: dir, dependsOn: [ids["blocker thing"]] }, "PATCH");
  const st = await brief(dir);
  const known = [...st.easy.map((e) => e.cardId), ...st.topics.flatMap((t) => t.cardIds)];
  expect(known.sort()).toEqual([ids["easy one"] as string, ids["blocker thing"] as string].sort());
});

test("briefing-launch-easy", async () => {
  const { dir, ids } = await setup(["easy a", "easy b", "hard c"]);
  await brief(dir);
  const r = await post<{ launched: number; briefing: BriefingState }>("/api/briefing/launch-easy", { project: dir });
  expect(r.launched).toBe(2);
  expect(r.briefing.easy.every((e) => e.launched)).toBe(true);
  const s = await snap(dir);
  const first = s.board.columns[1];
  for (const title of ["easy a", "easy b"]) {
    const card = s.board.cards.find((c) => c.id === ids[title]);
    expect(card?.columnId).toBe(first?.id as string);
    expect(card?.history.some((h) => h.kind === "moved" && h.text.startsWith("Briefing: Backlog →"))).toBe(true);
  }
  expect(s.board.cards.find((c) => c.id === ids["hard c"])?.columnId).toBe("col_backlog");
  // Launched cards stay listed: the reconcile pass only drops the ones that left by other means.
  expect((await need(dir)).easy.length).toBe(2);
});

test("briefing-answer-launches", async () => {
  const { dir, ids } = await setup(["[pay] checkout", "[pay] refunds"]);
  const st = await brief(dir);
  const topic = st.topics[0] as BriefingTopic;
  await topicAction(dir, topic.id, "say", { answers: { q1: "A", q2: "my own words" }, text: "" });
  await waitStatus(dir, topic.id, "launched");
  const done = await topicOf(dir, topic.id);
  expect(done.messages.map((m) => m.role)).toEqual(["agent", "user", "agent"]);
  expect(done.messages[1]?.text).toContain("my own words");
  expect(done.launchedRefs).toEqual(["#1", "#2"]);
  expect(done.decisions.length).toBe(2);
  const s = await snap(dir);
  expect(done.launchedTo).toBe(s.board.columns[1]?.name as string);
  for (const title of ["[pay] checkout", "[pay] refunds"]) {
    const card = await cardOf(dir, ids[title] as string);
    expect(card.columnId).not.toBe("col_backlog");
    expect(card.description).toContain(`About ${title}`);
    expect(card.description).toContain("## Decisions");
    expect(card.description).toContain("my own words");
    expect(card.description).toContain("## Acceptance");
    expect(card.history.some((h) => h.text === "Briefing: 2 decision(s) recorded")).toBe(true);
  }
  // The answer resumed the conversation's session.
  const turn = logged().find((l) => l.kind === "turn" && l.prompt.includes("my own words"));
  expect(turn?.argv[turn.argv.indexOf("--resume") + 1]).toBe(topic.sessionId as string);
  expect(turn?.prompt).toContain("- [q1] Which way for #1?\n  Answer: A");
});

test("briefing-follow-up-finalize", async () => {
  const { dir, ids } = await setup(["needs talk"]);
  const st = await brief(dir);
  const topic = st.topics[0] as BriefingTopic;
  await topicAction(dir, topic.id, "say", { answers: {}, text: "Why? FAKE_BRIEF_ASK" });
  await waitStatus(dir, topic.id, "waiting");
  let cur = await topicOf(dir, topic.id);
  expect(cur.messages.length).toBe(3);
  expect(cur.questions.map((q) => q.id)).toEqual(["q9"]);
  expect((await cardOf(dir, ids["needs talk"] as string)).columnId).toBe("col_backlog");
  await topicAction(dir, topic.id, "finalize");
  await waitStatus(dir, topic.id, "launched");
  cur = await topicOf(dir, topic.id);
  expect(cur.messages[3]?.kind).toBe("finalize");
  expect(cur.decisions[0]?.answer).toContain("Agent's call");
  const card = await cardOf(dir, ids["needs talk"] as string);
  expect(card.columnId).not.toBe("col_backlog");
  expect(card.description).toContain("Agent's call: A");
});

test("briefing-ready-at-once", async () => {
  const { dir, ids } = await setup(["no-questions here"]);
  await post("/api/briefing/start", { project: dir });
  await waitFor(
    async () => (await state(dir))?.topics[0]?.status === "launched",
    8000,
    () => state(dir),
  );
  const card = await cardOf(dir, ids["no-questions here"] as string);
  expect(card.columnId).not.toBe("col_backlog");
  expect(card.description).toContain("## Acceptance");
  expect(card.description).not.toContain("## Decisions");
});

test("briefing-skip-reopen-discuss", async () => {
  const { dir, ids } = await setup(["first hard", "second hard", "third hard", "easy peasy"]);
  await post("/api/briefing/start", { project: dir });
  await waitFor(
    async () => (await state(dir))?.topics.filter((t) => t.status === "waiting").length === 2,
    8000,
    () => state(dir),
  );
  let st = await need(dir);
  // Only two topics are prepared ahead; the third waits its turn.
  expect(st.topics.map((t) => t.status)).toEqual(["waiting", "waiting", "pending"]);
  const [first, , third] = st.topics as [BriefingTopic, BriefingTopic, BriefingTopic];
  await topicAction(dir, first.id, "skip");
  // A skipped topic frees a slot of the lookahead.
  await waitStatus(dir, third.id, "waiting");
  expect((await topicOf(dir, first.id)).status).toBe("skipped");
  expect((await cardOf(dir, ids["first hard"] as string)).columnId).toBe("col_backlog");
  await topicAction(dir, first.id, "reopen");
  expect((await topicOf(dir, first.id)).status).toBe("waiting");
  // An easy card the user wants to talk about becomes a topic, prepared when it is opened.
  const r = await post<{ topicId: string; briefing: BriefingState }>("/api/briefing/discuss", {
    project: dir,
    cardId: ids["easy peasy"],
  });
  expect(r.briefing.easy.length).toBe(0);
  expect(r.briefing.topics.at(-1)?.id).toBe(r.topicId);
  await topicAction(dir, r.topicId, "focus");
  await waitStatus(dir, r.topicId, "waiting");
  st = await need(dir);
  expect(st.topics.length).toBe(4);
});

test("briefing-launch-as-is", async () => {
  const { dir, ids } = await setup(["brief-slow thing"]);
  await post("/api/briefing/start", { project: dir });
  await waitFor(
    async () => (await state(dir))?.topics[0]?.status === "preparing",
    8000,
    () => state(dir),
  );
  const topic = (await need(dir)).topics[0] as BriefingTopic;
  await topicAction(dir, topic.id, "launch");
  const cur = await topicOf(dir, topic.id);
  expect(cur.status).toBe("launched");
  expect(cur.launchedRefs).toEqual(["#1"]);
  const card = await cardOf(dir, ids["brief-slow thing"] as string);
  expect(card.columnId).not.toBe("col_backlog");
  expect(card.description).toBe("About brief-slow thing");
  // The stopped agent's late result changes nothing.
  await Bun.sleep(300);
  expect((await topicOf(dir, topic.id)).status).toBe("launched");
});

test("briefing-errors", async () => {
  const empty = await setup([]);
  expect((await call("/api/briefing/start", { project: empty.dir })).status).toBe(400);
  expect((await call("/api/briefing/end", { project: empty.dir })).status).toBe(200);
  expect((await call("/api/briefing/launch-easy", { project: empty.dir })).status).toBe(404);

  const failing = await setup(["triage-fail thing"]);
  await post("/api/briefing/start", { project: failing.dir });
  await waitFor(
    async () => (await state(failing.dir))?.triage?.status === "error",
    8000,
    () => state(failing.dir),
  );
  expect((await need(failing.dir)).triage?.error).toContain("triage boom");

  const { dir } = await setup(["brief-fail thing", "fine thing"]);
  await post("/api/briefing/start", { project: dir });
  await waitFor(
    async () => (await state(dir))?.topics[0]?.status === "error",
    8000,
    () => state(dir),
  );
  const st = await need(dir);
  const [bad, fine] = st.topics as [BriefingTopic, BriefingTopic];
  expect(bad.error).toContain("brief boom");
  expect((await call(`/api/briefing/topics/${bad.id}/say`, { project: dir, answers: {}, text: "hi" })).status).toBe(409);
  expect((await call(`/api/briefing/topics/${bad.id}/bogus`, { project: dir })).status).toBe(404);
  expect((await call("/api/briefing/topics/topic_nope/skip", { project: dir })).status).toBe(404);
  await topicAction(dir, bad.id, "retry");
  await waitFor(
    async () => (await topicOf(dir, bad.id)).status === "error" && logged().filter((l) => l.prompt.includes("brief-fail")).length >= 3,
  );
  // An empty turn is refused; a failed turn keeps the conversation and can be retried.
  await waitStatus(dir, fine.id, "waiting");
  expect((await call(`/api/briefing/topics/${fine.id}/say`, { project: dir, answers: { q1: "  " }, text: " " })).status).toBe(400);
  expect((await call(`/api/briefing/topics/${fine.id}/say`, { project: dir, answers: { q1: 3 }, text: "" })).status).toBe(400);
  await topicAction(dir, fine.id, "say", { answers: {}, text: "FAKE_BRIEF_FAIL" });
  await waitStatus(dir, fine.id, "error");
  const failed = await topicOf(dir, fine.id);
  expect(failed.error).toContain("turn boom");
  expect(failed.sessionId).toBeTruthy();
  expect(failed.messages.length).toBe(2);
});

test("briefing-follows-board", async () => {
  const { dir, ids } = await setup(["[ui] header", "[ui] footer", "easy gone", "alone"]);
  const st = await brief(dir);
  const s = await snap(dir);
  const first = s.board.columns[1]?.id as string;
  // Cards moved or deleted by hand leave the briefing; a topic with no card left goes with them.
  await post(`/api/cards/${ids["[ui] header"]}/move`, { project: dir, columnId: first });
  await post(`/api/cards/${ids["easy gone"]}/move`, { project: dir, columnId: first });
  await call(`/api/cards/${ids.alone}?project=${encodeURIComponent(dir)}`, {}, "DELETE");
  await waitFor(
    async () => (await need(dir)).topics.length === 1,
    8000,
    () => state(dir),
  );
  const cur = await need(dir);
  expect(cur.easy).toEqual([]);
  expect(cur.topics[0]?.id).toBe(st.topics[0]?.id as string);
  expect(cur.topics[0]?.cardIds).toEqual([ids["[ui] footer"] as string]);
});

test("briefing-new-cards", async () => {
  const { dir } = await setup(["old hard"]);
  const st = await brief(dir);
  const late = await post<{ id: string }>("/api/cards", { project: dir, title: "easy latecomer" });
  await post("/api/briefing/start", { project: dir });
  await waitFor(
    async () => (await need(dir)).easy.length === 1 && !(await need(dir)).triage,
    8000,
    () => state(dir),
  );
  const cur = await need(dir);
  expect(cur.easy[0]?.cardId).toBe(late.id);
  // The conversation already going on is untouched, and only the new card was read.
  expect(cur.topics[0]?.id).toBe(st.topics[0]?.id as string);
  expect(cur.topics[0]?.messages.length).toBe(1);
  const triages = logged().filter((l) => l.kind === "triage" && l.prompt.includes("easy latecomer"));
  expect(triages.length).toBe(1);
  expect(triages[0]?.prompt).not.toContain("old hard");
  // Nothing new to read: a second start is refused.
  expect((await call("/api/briefing/start", { project: dir })).status).toBe(400);
});

test("briefing-end", async () => {
  const { dir, ids } = await setup(["brief-slow talk", "easy stays"]);
  await post("/api/briefing/start", { project: dir });
  await waitFor(
    async () => (await state(dir))?.topics[0]?.status === "preparing",
    8000,
    () => state(dir),
  );
  const before = events.length;
  const r = await post("/api/briefing/end", { project: dir });
  expect(r.briefing).toBeNull();
  expect(await state(dir)).toBeNull();
  expect(events.slice(before).some((e) => e.type === "briefing" && e.project === dir && e.briefing === null)).toBe(true);
  // The cards are still in the Backlog, and the stopped agent never brings the briefing back.
  await Bun.sleep(400);
  expect(await state(dir)).toBeNull();
  for (const id of Object.values(ids)) expect((await cardOf(dir, id)).columnId).toBe("col_backlog");
});
