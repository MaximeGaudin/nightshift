// The fast merge on real git repositories: a bare remote, a board clone and a card worktree.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type FastMergeInput, type FastMergeOutcome, fallbackBlock, tryFastMerge } from "../src/server/fastMerge.ts";
import type { Column } from "../src/shared/types.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

const ENV_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
];
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const cfg = join(tempDir("ns-gitcfg-"), "gitconfig");
  writeFileSync(cfg, "");
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: cfg,
    GIT_CONFIG_NOSYSTEM: "1",
  });
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  removeTempDirs();
});

function g(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
const ok = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: process.env }).exitCode === 0;

function commit(cwd: string, file: string, content: string, msg = `edit ${file}`) {
  writeFileSync(join(cwd, file), content);
  g(cwd, "add", file);
  g(cwd, "commit", "-qm", msg);
  return g(cwd, "rev-parse", "HEAD");
}

interface Repo {
  remote: string;
  board: string;
}

function repo(): Repo {
  const root = tempDir("ns-fastmerge-");
  const remote = join(root, "remote.git");
  g(root, "init", "-q", "--bare", "-b", "main", remote);
  const board = join(root, "board");
  mkdirSync(board);
  g(board, "init", "-q", "-b", "main");
  writeFileSync(join(board, ".gitignore"), "nightshift.json\nignored.txt\n");
  commit(board, ".gitignore", "nightshift.json\nignored.txt\n");
  commit(board, "shared.txt", "one\ntwo\nthree\n", "initial");
  g(board, "remote", "add", "origin", remote);
  g(board, "push", "-q", "-u", "origin", "main");
  return { remote, board };
}

function addCard(r: Repo, id: string, file = "card.txt", content = "card\n") {
  const wt = tempDir("ns-card-wt-");
  g(r.board, "worktree", "add", "-q", "-b", `nightshift/${id}`, wt, "main");
  const base = g(r.board, "rev-parse", "main");
  const sha = commit(wt, file, content);
  const description = `## Brief\n\nx\n\n## Result\n\n- Worktree: ${wt}\n- Branch: nightshift/${id}\n- Base: main at ${base.slice(0, 7)}\n- Commits: ${sha.slice(0, 7)}\n`;
  return { wt, sha, description };
}

const MERGE_COLUMN: Column = { id: "col_m", name: "Merge", type: "skill", skill: "nightshift-merge" };

function input(r: Repo, cardId: string, description: string, extra: Partial<FastMergeInput> = {}): FastMergeInput {
  return {
    projectPath: r.board,
    cardId,
    description,
    column: MERGE_COLUMN,
    stopTest: () => {},
    isCancelled: () => false,
    sleep: async () => {},
    ...extra,
  };
}

const lockDir = (r: Repo) => join(r.board, ".git", "nightshift-merge.lock");
const remoteHead = (r: Repo) => g(r.remote, "rev-parse", "main");

function expectFallback(o: FastMergeOutcome, step: string) {
  if (o.kind !== "fallback") throw new Error(`expected fallback at ${step}, got ${JSON.stringify(o)}`);
  expect(o.step).toBe(step);
  return o;
}

function expectMerged(o: FastMergeOutcome) {
  if (o.kind !== "merged") throw new Error(`expected merged, got ${JSON.stringify(o)}`);
  return o;
}

test("fastMerge base unchanged", async () => {
  const r = repo();
  const card = addCard(r, "card_a");
  writeFileSync(join(card.wt, "ignored.txt"), "ignored files do not block the worktree removal");
  const o = expectMerged(await tryFastMerge(input(r, "card_a", card.description)));
  expect(g(r.board, "rev-parse", "main")).toBe(card.sha);
  expect(remoteHead(r)).toBe(card.sha);
  expect(existsSync(card.wt)).toBe(false);
  expect(ok(r.board, "rev-parse", "--verify", "--quiet", "refs/heads/nightshift/card_a")).toBe(false);
  expect(existsSync(lockDir(r))).toBe(false);
  expect(o.summary).toBe(`merge rapide : main @ ${card.sha.slice(0, 7)}`);
  for (const line of [
    "- Into: main",
    "- Test environment: none running",
    `- Merge commit: ${card.sha} (fast-forward`,
    `- Pushed: origin/main at ${card.sha.slice(0, 7)}`,
    `- Worktree removed: `,
    "- Card branch deleted: nightshift/card_a",
    "- Suite: skipped (base unchanged)",
  ]) {
    expect(o.merge).toContain(line);
  }
});

test("fastMerge moved base, test passes", async () => {
  const r = repo();
  const card = addCard(r, "card_b");
  commit(r.board, "base.txt", "base moved\n");
  const column: Column = { ...MERGE_COLUMN, fastMergeTestCommand: "test -f base.txt && test -f card.txt" };
  const o = expectMerged(await tryFastMerge(input(r, "card_b", card.description, { column })));
  const head = g(r.board, "rev-parse", "main");
  expect(head).not.toBe(card.sha);
  expect(g(r.board, "log", "-1", "--format=%P", head).split(" ").length).toBe(2);
  expect(remoteHead(r)).toBe(head);
  expect(o.merge).toContain("- Suite: test -f base.txt && test -f card.txt → exit 0");
  expect(existsSync(lockDir(r))).toBe(false);
});

test("fastMerge moved base, test fails", async () => {
  const r = repo();
  const card = addCard(r, "card_c");
  const moved = commit(r.board, "base.txt", "base moved\n");
  const remoteBefore = remoteHead(r);
  const column: Column = { ...MERGE_COLUMN, fastMergeTestCommand: "echo boom-output; exit 3" };
  const o = expectFallback(await tryFastMerge(input(r, "card_c", card.description, { column })), "test");
  expect(o.error).toContain("exit 3");
  expect(o.error).toContain("boom-output");
  expect(o.state).toContain("stays on nightshift/card_c");
  expect(g(r.board, "rev-parse", "main")).toBe(moved);
  expect(remoteHead(r)).toBe(remoteBefore);
  expect(existsSync(card.wt)).toBe(true);
  expect(existsSync(lockDir(r))).toBe(false);
  const block = fallbackBlock(o);
  for (const s of ["<fast-merge>", "Step: test", "Command: echo boom-output; exit 3", "boom-output", "State left:"])
    expect(block).toContain(s);
});

test("fastMerge moved base, empty command", async () => {
  const r = repo();
  const card = addCard(r, "card_d");
  commit(r.board, "base.txt", "base moved\n");
  expectFallback(await tryFastMerge(input(r, "card_d", card.description)), "moved-base");
  expect(g(card.wt, "rev-parse", "HEAD")).toBe(card.sha);
  expect(existsSync(lockDir(r))).toBe(false);
});

test("fastMerge setting merge", async () => {
  const r = repo();
  const card = addCard(r, "card_e");
  commit(r.board, "base.txt", "base moved\n");
  const column: Column = { ...MERGE_COLUMN, fastMergeMovedBase: "merge" };
  const o = expectMerged(await tryFastMerge(input(r, "card_e", card.description, { column })));
  expect(o.merge).toContain("- Suite: skipped (setting merge)");
  expect(remoteHead(r)).toBe(g(r.board, "rev-parse", "main"));
});

test("fastMerge setting agent", async () => {
  const r = repo();
  const card = addCard(r, "card_f");
  const moved = commit(r.board, "base.txt", "base moved\n");
  const column: Column = { ...MERGE_COLUMN, fastMergeMovedBase: "agent", fastMergeTestCommand: "true" };
  expectFallback(await tryFastMerge(input(r, "card_f", card.description, { column })), "moved-base");
  expect(g(r.board, "rev-parse", "main")).toBe(moved);
  expect(g(card.wt, "rev-parse", "HEAD")).toBe(card.sha);
});

test("fastMerge conflict", async () => {
  const r = repo();
  const card = addCard(r, "card_g", "shared.txt", "one\nCARD\nthree\n");
  const moved = commit(r.board, "shared.txt", "one\nBASE\nthree\n");
  const column: Column = { ...MERGE_COLUMN, fastMergeMovedBase: "merge" };
  const o = expectFallback(await tryFastMerge(input(r, "card_g", card.description, { column })), "merge-base-into-card");
  expect(o.command).toContain("merge --no-edit main");
  expect(ok(card.wt, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")).toBe(false);
  expect(g(card.wt, "status", "--porcelain")).toBe("");
  expect(g(card.wt, "rev-parse", "HEAD")).toBe(card.sha);
  expect(g(r.board, "rev-parse", "main")).toBe(moved);
  expect(existsSync(lockDir(r))).toBe(false);
});

test("fastMerge dirty base checkout", async () => {
  const r = repo();
  const card = addCard(r, "card_h");
  writeFileSync(join(r.board, "shared.txt"), "uncommitted\n");
  expectFallback(await tryFastMerge(input(r, "card_h", card.description)), "base-checkout");
  expect(readFileSync(join(r.board, "shared.txt"), "utf8")).toBe("uncommitted\n");
  expect(existsSync(card.wt)).toBe(true);
  expect(existsSync(lockDir(r))).toBe(false);
});

test("fastMerge Worktree none", async () => {
  const r = repo();
  const sha = commit(r.board, "direct.txt", "on main\n");
  const description = `## Result\n\n- Worktree: none\n- Branch: main\n- Base: main at abc1234\n- Commits: ${sha.slice(0, 7)}\n`;
  const o = expectMerged(await tryFastMerge(input(r, "card_i", description)));
  expect(remoteHead(r)).toBe(sha);
  expect(o.merge).toContain("- Merge commit: none (committed on main");
  expect(o.merge).toContain("- Worktree removed: none");

  const missing = `## Result\n\n- Worktree: none\n- Base: main at abc1234\n- Commits: ${"f".repeat(40)}\n`;
  expectFallback(await tryFastMerge(input(r, "card_j", missing)), "check-commits");
  expect(existsSync(lockDir(r))).toBe(false);
});

test("fastMerge push rejected", async () => {
  const r = repo();
  const card = addCard(r, "card_k");
  const hook = join(r.remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho refused by hook >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const before = remoteHead(r);
  const o = expectFallback(await tryFastMerge(input(r, "card_k", card.description)), "push");
  expect(o.state).toContain("not pushed");
  expect(o.merge).toContain("- Into: main");
  expect(remoteHead(r)).toBe(before);
  expect(g(r.board, "rev-parse", "main")).toBe(card.sha);
  expect(existsSync(lockDir(r))).toBe(false);
});

test("fastMerge without upstream skips the push", async () => {
  const r = repo();
  g(r.board, "branch", "--unset-upstream", "main");
  const card = addCard(r, "card_l");
  const o = expectMerged(await tryFastMerge(input(r, "card_l", card.description)));
  expect(o.merge).toContain("- Pushed: skipped, no upstream");
});

test("lock held by another card", async () => {
  const r = repo();
  const card = addCard(r, "card_m");
  mkdirSync(lockDir(r));
  const owner = `card_other ${new Date(Date.now() - 60_000).toISOString()}`;
  writeFileSync(join(lockDir(r), "owner"), owner);
  let sleeps = 0;
  const o = await tryFastMerge(input(r, "card_m", card.description, { sleep: async () => void sleeps++ }));
  expect(o.kind).toBe("busy");
  if (o.kind !== "busy") return;
  expect(o.merge).toBe(`- the target is busy: lock held by ${owner}`);
  expect(sleeps).toBe(5);
  expect(readFileSync(join(lockDir(r), "owner"), "utf8")).toBe(owner);
  expect(g(r.board, "rev-parse", "main")).not.toBe(card.sha);
});

test("stale lock is replaced", async () => {
  const r = repo();
  for (const [id, owner] of [
    ["card_n", `card_other ${new Date(Date.now() - 31 * 60_000).toISOString()}`],
    ["card_o", `card_o ${new Date().toISOString()}`],
  ]) {
    const card = addCard(r, id, `${id}.txt`);
    mkdirSync(lockDir(r));
    writeFileSync(join(lockDir(r), "owner"), owner);
    const o = expectMerged(await tryFastMerge(input(r, id, card.description)));
    expect(o.merge).toContain(`- removed stale lock: ${owner}`);
    expect(existsSync(lockDir(r))).toBe(false);
  }
});

test("stops worktree processes", async () => {
  const r = repo();
  const card = addCard(r, "card_p");
  // `sleep 60; true` keeps sh alive with the worktree path in its argv.
  const proc = spawn("sh", ["-c", "sleep 60; true", join(card.wt, "server.js")], { detached: true, stdio: "ignore" });
  const pid = proc.pid as number;
  let stopCalls = 0;
  try {
    await Bun.sleep(100);
    const o = expectMerged(await tryFastMerge(input(r, "card_p", card.description, { stopTest: () => void stopCalls++ })));
    expect(o.merge).toContain(`- Test environment: stopped ${pid}`);
    expect(stopCalls).toBe(1);
    await Bun.sleep(100);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  } finally {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
});

test("fastMerge cancelled before touching anything", async () => {
  const r = repo();
  const card = addCard(r, "card_q");
  const o = await tryFastMerge(input(r, "card_q", card.description, { isCancelled: () => true }));
  expect(o.kind).toBe("cancelled");
  expect(existsSync(lockDir(r))).toBe(false);
  expect(g(r.board, "rev-parse", "main")).not.toBe(card.sha);
});

test("fastMerge base checked out nowhere uses a temporary worktree", async () => {
  const r = repo();
  const card = addCard(r, "card_r");
  g(r.board, "checkout", "-q", "-b", "other");
  const o = expectMerged(await tryFastMerge(input(r, "card_r", card.description)));
  expect(g(r.board, "rev-parse", "main")).toBe(card.sha);
  expect(o.merge).toContain("- Card branch deleted: nightshift/card_r");
  expect(g(r.board, "worktree", "list").split("\n").length).toBe(1);
});
