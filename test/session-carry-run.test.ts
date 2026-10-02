import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column } from "../src/shared/types.ts";
import { type ChildServer, must, removeTempDirs, startChildServer, tempDir, waitFor } from "./helpers.ts";

let srv: ChildServer;
let argsLog: string;
beforeAll(async () => {
  const tmp = tempDir("ns-carry-");
  argsLog = join(tmp, "args.jsonl");
  srv = await startChildServer({
    agents: true,
    settings: { claudePath: join(import.meta.dir, "fake-claude.ts") },
    env: { FAKE_DELAY_MS: "50", FAKE_ARGS_LOG: argsLog },
  });
}, 30000);
afterAll(async () => {
  await srv.stop();
  removeTempDirs();
});

const runsOf = (title: string) =>
  (() => {
    try {
      return readFileSync(argsLog, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  })()
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => String(r.title).startsWith(title));

/** A board of two skill columns (A then B, B in `mode`), then an inert Done; the card starts in A. */
async function setup(title: string, mode: Column["freshSession"] | "absent") {
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  await srv.call("/api/projects/open", { body: { path: dir } });
  const res = await srv
    .call("/api/board", {
      method: "PUT",
      body: {
        project: dir,
        columns: [
          { name: "A", type: "skill", skill: "enrich" },
          { name: "B", type: "skill", skill: "enrich", ...(mode === "absent" ? {} : { freshSession: mode }) },
          { name: "Done", type: "inert" },
        ],
      },
    })
    .then((r) => r.json());
  const cols = res.board.columns as Column[];
  const byName = (n: string) =>
    must(
      cols.find((c) => c.name === n),
      n,
    );
  const { id } = await srv.call("/api/cards", { body: { project: dir, columnId: byName("A").id, title } }).then((r) => r.json());
  const snap = async () => {
    const s = await srv.call(`/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());
    return s.board.cards.find((c: Card) => c.id === id) as Card;
  };
  const log = async () =>
    (await srv.call(`/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json())) as { text: string }[];
  await waitFor(async () => (await snap()).columnId === byName("Done").id, 15000);
  return { dir, id, snap, log };
}

const decisionLines = (lines: { text: string }[]) =>
  lines.map((l) => l.text).filter((t) => /^(Fresh session|Continuing the card's session \()/.test(t));

test("contextTokens: the last own assistant usage wins, subagent usage is ignored, missing fields count as 0", async () => {
  const { snap } = await setup("usage-multi", "absent");
  expect((await snap()).lastRun?.contextTokens).toBe(7);
}, 30000);

test("contextTokens: absent when no assistant message carries usage", async () => {
  const { snap } = await setup("nousage", "absent");
  expect((await snap()).lastRun).toBeDefined();
  expect((await snap()).lastRun?.contextTokens).toBeUndefined();
}, 30000);

test("auto: a small recent context is carried, and the decision is logged", async () => {
  const { log } = await setup("tokens-62000", "auto");
  expect(runsOf("tokens-62000").map((r) => r.continuing)).toEqual([false, true]);
  expect(decisionLines(await log())).toEqual(["Continuing the card's session (62k tokens, 0 min old)"]);
}, 30000);

test("auto: a big context starts fresh, and the decision is logged", async () => {
  const { log } = await setup("tokens-160000", "auto");
  expect(runsOf("tokens-160000").map((r) => [r.continuing, r.resumeId])).toEqual([
    [false, null],
    [false, null],
  ]);
  expect(decisionLines(await log())).toEqual(["Fresh session: carried context 160k > 80k"]);
}, 30000);

test("auto: an unknown context size starts fresh", async () => {
  const { log } = await setup("autonousage", "auto");
  expect(runsOf("autonousage").map((r) => r.continuing)).toEqual([false, false]);
  expect(decisionLines(await log())).toEqual(["Fresh session: carried context size unknown"]);
}, 30000);

test("fixed modes never log a decision: absent continues, true starts fresh", async () => {
  const kept = await setup("tokens-160001", "absent");
  expect(runsOf("tokens-160001").map((r) => r.continuing)).toEqual([false, true]);
  expect(decisionLines(await kept.log())).toEqual([]);
  const fresh = await setup("tokens-1000", true);
  expect(runsOf("tokens-1000").map((r) => r.continuing)).toEqual([false, false]);
  expect(decisionLines(await fresh.log())).toEqual([]);
}, 30000);

test("auto: an answer keeps resuming its own session whatever the context size", async () => {
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  await srv.call("/api/projects/open", { body: { path: dir } });
  const res = await srv
    .call("/api/board", {
      method: "PUT",
      body: {
        project: dir,
        columns: [
          { name: "A", type: "skill", skill: "enrich", freshSession: "auto" },
          { name: "Done", type: "inert" },
        ],
      },
    })
    .then((r) => r.json());
  const cols = res.board.columns as Column[];
  const byName = (n: string) =>
    must(
      cols.find((c) => c.name === n),
      n,
    );
  // "ask" answers with questions; the unknown context size would make auto start fresh if it were consulted.
  const { id } = await srv.call("/api/cards", { body: { project: dir, columnId: byName("A").id, title: "ask" } }).then((r) => r.json());
  const snap = async () => {
    const s = await srv.call(`/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());
    return s.board.cards.find((c: Card) => c.id === id) as Card;
  };
  await waitFor(async () => (await snap()).lastRun?.status === "question", 15000);
  const sessionId = (await snap()).lastRun?.sessionId;
  await srv.call(`/api/cards/${id}/answer`, { body: { project: dir, answers: ["blue", "big"] } });
  const logLines = async () =>
    (await srv.call(`/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json())) as { text: string }[];
  await waitFor(async () => (await logLines()).some((l) => l.text.startsWith("Resuming")));
  // The answer's prompt has no card title, so its run is found by the session it resumes.
  const resumedRuns = () =>
    readFileSync(argsLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((r) => r.resumed && r.resumeId === sessionId);
  await waitFor(() => resumedRuns().length > 0);
  const resumed = resumedRuns();
  expect(resumed.length).toBe(1);
  expect(decisionLines(await logLines())).toEqual([]);
}, 30000);
