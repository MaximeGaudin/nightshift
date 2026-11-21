// The orchestrator tries the fast merge before starting the merge agent (fake claude, real git repositories).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column, LogLine } from "../src/shared/types.ts";
import { removeTempDirs, tempDir, waitFor } from "./helpers.ts";

process.env.NIGHTSHIFT_HOME = tempDir("ns-home-");
process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-skills-");
const argsLog = join(tempDir("ns-args-"), "args.jsonl");
const prevArgsLog = process.env.FAKE_ARGS_LOG;
process.env.FAKE_ARGS_LOG = argsLog;

const { skillsDir } = await import("../src/server/skills.ts");
const { startServer } = await import("../src/server/server.ts");
const { updateSettings } = await import("../src/server/settings.ts");

const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};
const savedEnv: Record<string, string | undefined> = {};

let srv: ReturnType<typeof startServer>;
let base = "";

beforeAll(() => {
  const cfg = join(tempDir("ns-gitcfg-"), "gitconfig");
  writeFileSync(cfg, "");
  for (const [k, v] of Object.entries({ ...GIT_ENV, GIT_CONFIG_GLOBAL: cfg })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts"), model: "" });
  srv = startServer({ port: 0 });
  base = `http://localhost:${srv.server.port}`;
  const dir = join(skillsDir("user", ""), "nightshift-merge");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: nightshift-merge\ndescription: test\n---\n");
});
afterAll(async () => {
  await srv.orch.shutdown();
  srv.server.stop(true);
  if (prevArgsLog === undefined) delete process.env.FAKE_ARGS_LOG;
  else process.env.FAKE_ARGS_LOG = prevArgsLog;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeTempDirs();
});

const post = (path: string, body: object, method = "POST") =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

function g(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function commit(cwd: string, file: string, content: string) {
  writeFileSync(join(cwd, file), content);
  g(cwd, "add", file);
  g(cwd, "commit", "-qm", `edit ${file}`);
  return g(cwd, "rev-parse", "HEAD");
}
const agentRuns = (): { title: string; fastMerge: boolean }[] =>
  existsSync(argsLog)
    ? readFileSync(argsLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** A board repository with a bare remote, opened in Nightshift with Backlog, Merge and Done columns. */
async function setup(merge: Partial<Column> = {}) {
  const root = tempDir("ns-fm-orch-");
  const remote = join(root, "remote.git");
  g(root, "init", "-q", "--bare", "-b", "main", remote);
  const dir = join(root, "board");
  mkdirSync(dir);
  g(dir, "init", "-q", "-b", "main");
  commit(dir, ".gitignore", "nightshift.json\n.claude/\n");
  commit(dir, "shared.txt", "one\ntwo\n");
  g(dir, "remote", "add", "origin", remote);
  g(dir, "push", "-q", "-u", "origin", "main");
  const snap = await post("/api/projects/open", { path: dir });
  const backlog = snap.board.columns[0];
  const done = snap.board.columns.at(-1);
  const res = await post(
    "/api/board",
    { project: dir, columns: [backlog, { name: "Merge", type: "skill", skill: "nightshift-merge", ...merge }, done] },
    "PUT",
  );
  const [, mergeCol, doneCol] = res.board.columns as Column[];
  const get = async (id: string) =>
    ((await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards as Card[]).find(
      (c) => c.id === id,
    ) as Card;
  const logOf = (id: string): Promise<LogLine[]> =>
    fetch(`${base}/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json());

  /** A card in the Backlog with a worktree on nightshift/<id> and one commit, then moved to Merge. */
  const card = async (title: string, file = "card.txt", content = "card\n", beforeMove?: () => void) => {
    const { id } = await post("/api/cards", { project: dir, columnId: backlog.id, title });
    const wt = tempDir("ns-fm-wt-");
    g(dir, "worktree", "add", "-q", "-b", `nightshift/${id}`, wt, "main");
    const baseSha = g(dir, "rev-parse", "main");
    const sha = commit(wt, file, content);
    const description = `## Result\n\n- Worktree: ${wt}\n- Base: main at ${baseSha.slice(0, 7)}\n- Commits: ${sha.slice(0, 7)}\n`;
    await post(`/api/cards/${id}`, { project: dir, description }, "PATCH");
    beforeMove?.();
    await post(`/api/cards/${id}/move`, { project: dir, columnId: mergeCol.id });
    return { id, wt, sha };
  };
  return { dir, remote, mergeCol, doneCol, get, logOf, card };
}

test("orchestrator fast merge success runs no agent", async () => {
  const s = await setup();
  const before = agentRuns().length;
  const c = await s.card("fm-ok");
  await waitFor(async () => (await s.get(c.id)).columnId === s.doneCol.id, 15_000);
  const card = await s.get(c.id);
  expect(agentRuns().length).toBe(before);
  expect(card.lastRun?.status).toBe("success");
  expect(card.lastRun && "costUsd" in card.lastRun).toBe(false);
  expect(card.lastRun && "sessionId" in card.lastRun).toBe(false);
  expect(card.history.some((h) => h.kind === "run" && h.text.includes("merge rapide : main @"))).toBe(true);
  expect(card.description).toContain("## Merge");
  expect(card.description).toContain("- Suite: skipped (base unchanged)");
  expect(g(s.remote, "rev-parse", "main")).toBe(c.sha);
  expect((await s.logOf(c.id)).some((l) => l.text.startsWith("merge rapide : main @"))).toBe(true);
}, 20_000);

test("orchestrator fast merge fallback starts the agent", async () => {
  const s = await setup({ fastMergeMovedBase: "merge" });
  const before = agentRuns().length;
  // The base moves after the card started, on the same line: the merge into the card conflicts.
  const c = await s.card("fm-conflict", "shared.txt", "one\nCARD\n", () => commit(s.dir, "shared.txt", "one\nBASE\n"));
  await waitFor(async () => agentRuns().length > before && (await s.get(c.id)).lastRun !== undefined, 15_000);
  const runs = agentRuns().slice(before);
  expect(runs).toHaveLength(1);
  expect(runs[0].title).toBe("fm-conflict");
  expect(runs[0].fastMerge).toBe(true);
  const log = await s.logOf(c.id);
  expect(log.some((l) => l.text.startsWith("merge rapide abandonné : merge-base-into-card"))).toBe(true);
  expect(g(c.wt, "status", "--porcelain")).toBe("");
}, 20_000);

test("orchestrator fast merge disabled", async () => {
  const s = await setup({ fastMerge: false });
  const before = agentRuns().length;
  const c = await s.card("fm-off");
  await waitFor(async () => agentRuns().length > before && (await s.get(c.id)).lastRun !== undefined, 15_000);
  const runs = agentRuns().slice(before);
  expect(runs).toHaveLength(1);
  expect(runs[0].fastMerge).toBe(false);
  expect(g(s.remote, "rev-parse", "main")).not.toBe(c.sha);
  expect(existsSync(c.wt)).toBe(true);
}, 20_000);
