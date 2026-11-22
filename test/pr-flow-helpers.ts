// Shared harness of the pull request flow tests (test/pr-flow-*.test.ts): fake claude for the agents, fake gh on the
// PATH, real git with a bare remote that the board reaches through `url.<bare>.insteadOf https://github.com/o/r.git`
// (so origin is GitHub for Nightshift). Each file calls `prFlowHarness()` once, at its top level: it starts its own
// server and its own NIGHTSHIFT_HOME. Not a test file: bun does not collect it.
import { afterAll, beforeAll } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column, LogLine } from "../src/shared/types.ts";
import { installFakeGh, removeTempDirs, restoreEnvAfterAll, tempDir } from "./helpers.ts";

export const GH_URL = "https://github.com/o/r.git";
export const PENDING = [{ name: "ci", state: "PENDING", bucket: "pending", link: "https://github.com/o/r/actions/runs/42/job/1" }];
export const LINK = "https://github.com/o/r/actions/runs/42/job/1";
export const OPTIONAL_FAIL = [{ name: "ci", state: "FAILURE", bucket: "fail", link: LINK, required: false }];
export const OPTIONAL_PENDING = [{ name: "ci", state: "PENDING", bucket: "pending", link: LINK, required: false }];

export function g(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
export function commit(cwd: string, file: string, content: string) {
  writeFileSync(join(cwd, file), content);
  g(cwd, "add", file);
  g(cwd, "commit", "-qm", `edit ${file}`);
  return g(cwd, "rev-parse", "HEAD");
}

/**
 * Template repositories, built once per file and variant: a board with its first commits and a bare remote that
 * already holds `main`. Each test copies them instead of running `git init`, the commits and the first push again.
 * Built on first use, after the git identity is in the environment. The map belongs to one harness (one test file):
 * a file that ends removes every temporary directory, so templates must not outlive it.
 */
function template(templates: Map<boolean, { board: string; remote: string }>, workflows: boolean) {
  const known = templates.get(workflows);
  if (known) return known;
  const root = tempDir("ns-pr-tpl-");
  const remote = join(root, "remote.git");
  g(root, "init", "-q", "--bare", "-b", "main", remote);
  const board = join(root, "board");
  mkdirSync(board);
  g(board, "init", "-q", "-b", "main");
  commit(board, ".gitignore", "nightshift.json\n.claude/\n");
  commit(board, "shared.txt", "one\n");
  if (workflows) {
    mkdirSync(join(board, ".github", "workflows"), { recursive: true });
    commit(board, ".github/workflows/ci.yml", "on: [pull_request]\n");
  }
  // origin is GitHub, reached through the bare remote; the push leaves `origin/main` and the upstream in place for the copies.
  g(board, "remote", "add", "origin", GH_URL);
  g(board, "config", `url.${remote}.insteadOf`, GH_URL);
  g(board, "push", "-q", "-u", "origin", "main");
  g(board, "config", "--unset", `url.${remote}.insteadOf`);
  const made = { board, remote };
  templates.set(workflows, made);
  return made;
}

export async function prFlowHarness() {
  restoreEnvAfterAll("NIGHTSHIFT_HOME", "NIGHTSHIFT_USER_SKILLS");
  process.env.NIGHTSHIFT_HOME = tempDir("ns-home-");
  process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-skills-");
  const argsLog = join(tempDir("ns-args-"), "args.jsonl");

  const { skillsDir } = await import("../src/server/skills.ts");
  const { startServer } = await import("../src/server/server.ts");
  const { updateSettings } = await import("../src/server/settings.ts");
  const { clearPrModeCache } = await import("../src/server/prMode.ts");

  const templates = new Map<boolean, { board: string; remote: string }>();
  const fake = installFakeGh();
  const savedEnv: Record<string, string | undefined> = {};
  let srv: ReturnType<typeof startServer>;
  let base = "";

  beforeAll(() => {
    const cfg = join(tempDir("ns-gitcfg-"), "gitconfig");
    // Nothing here needs durable writes or a background `git maintenance` after a commit: both only cost time.
    writeFileSync(cfg, "[core]\n\tfsync = none\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n");
    const env: Record<string, string> = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: cfg,
      FAKE_ARGS_LOG: argsLog,
      // The fake claude answers after this delay (200 ms by default): none of these tests depends on a long run.
      FAKE_DELAY_MS: "20",
      ...fake.env,
      PATH: `${fake.dir}:${process.env.PATH}`,
    };
    for (const [k, v] of Object.entries(env)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts"), model: "" });
    srv = startServer({ port: 0 });
    base = `http://localhost:${srv.server.port}`;
    for (const name of ["nightshift-review", "nightshift-merge"]) {
      const dir = join(skillsDir("user", ""), name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
    }
  });
  afterAll(async () => {
    await srv.orch.shutdown();
    srv.server.stop(true);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearPrModeCache();
    removeTempDirs();
  });

  const post = (path: string, body: object, method = "POST") =>
    fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

  const agentRuns = (): { title: string; fastMerge: boolean; prompt: string }[] =>
    existsSync(argsLog)
      ? readFileSync(argsLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  /**
   * A board with Backlog, Review, Merge and Done; origin is GitHub (`github`) or the bare path. `workflows` commits a
   * GitHub Actions workflow, so a PR without any check waits for its CI.
   */
  async function setup({ github = true, settings = {} as Record<string, unknown>, workflows = false } = {}) {
    const root = tempDir("ns-pr-");
    const remote = join(root, "remote.git");
    const dir = join(root, "board");
    const tpl = template(templates, workflows);
    cpSync(tpl.remote, remote, { recursive: true });
    cpSync(tpl.board, dir, { recursive: true });
    if (github) g(dir, "config", `url.${remote}.insteadOf`, GH_URL);
    else g(dir, "remote", "set-url", "origin", remote);
    const s = fake.state();
    fake.setState({ ...s, remote, prs: s.prs ?? [] });
    clearPrModeCache();
    const snap = await post("/api/projects/open", { path: dir });
    const [backlog] = snap.board.columns;
    const done = snap.board.columns.at(-1);
    const res = await post(
      "/api/board",
      {
        project: dir,
        columns: [
          backlog,
          { name: "Review", type: "skill", skill: "nightshift-review" },
          { name: "Merge", type: "skill", skill: "nightshift-merge" },
          done,
        ],
      },
      "PUT",
    );
    if (Object.keys(settings).length > 0) await post("/api/pull-requests", { project: dir, ...settings }, "PUT");
    const [, reviewCol, mergeCol, doneCol] = res.board.columns as Column[];
    const get = async (id: string) =>
      ((await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards as Card[]).find(
        (c) => c.id === id,
      ) as Card;
    const logOf = (id: string): Promise<LogLine[]> =>
      fetch(`${base}/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json());
    /**
     * A card with a worktree on nightshift/<id> and one commit, moved to Review. FAKE_KEEP_DESC keeps its note, unless
     * `exact` keeps the title as is (fake claude titles such as "fail" or "ask").
     */
    const card = async (title: string, { exact = false } = {}) => {
      const { id } = await post("/api/cards", { project: dir, columnId: backlog.id, title: exact ? title : `${title} FAKE_KEEP_DESC` });
      const wt = tempDir("ns-pr-wt-");
      g(dir, "worktree", "add", "-q", "-b", `nightshift/${id}`, wt, "main");
      const baseSha = g(dir, "rev-parse", "main");
      const sha = commit(wt, `${id}.txt`, "card\n");
      const description = [
        "# Brief",
        "",
        "## Definition of done",
        "",
        "- [x] it works",
        "",
        "## Result",
        "",
        `- Worktree: ${wt}`,
        `- Base: main at ${baseSha.slice(0, 7)}`,
        `- Commits: ${sha.slice(0, 7)}`,
        "- Tests: bun test → exit 0",
        "",
        "## Review",
        "",
        "- Findings: none",
        "",
      ].join("\n");
      await post(`/api/cards/${id}`, { project: dir, description }, "PATCH");
      await post(`/api/cards/${id}/move`, { project: dir, columnId: reviewCol.id });
      return { id, wt, sha };
    };
    return { dir, remote, backlog: backlog as Column, reviewCol, mergeCol, doneCol, get, logOf, card };
  }

  const prOf = (head: string) => fake.state().prs.filter((p: { head: string }) => p.head === head);
  const setChecks = (head: string, bucket: string, { required = true } = {}) => {
    const s = fake.state();
    for (const p of s.prs) {
      if (p.head === head)
        p.checks = [{ name: "ci", state: bucket.toUpperCase(), bucket, link: LINK, ...(required ? {} : { required: false }) }];
    }
    fake.setState(s);
  };
  const mergeCalls = (url: string) =>
    fake.calls().filter((c) => c.args[1] === "merge" && c.args[2] === url && !c.args.includes("--disable-auto"));
  /** Index of the first fake gh call matching `pred` after index `from`; -1 when none. */
  const callIndex = (pred: (args: string[]) => boolean, from = -1) => fake.calls().findIndex((c, i) => i > from && pred(c.args));
  const isCreate = (head: string) => (a: string[]) => a[1] === "create" && a.includes(head);
  const isReady = (url: string) => (a: string[]) => a[1] === "ready" && a[2] === url && !a.includes("--undo");
  const isUndo = (url: string) => (a: string[]) => a[1] === "ready" && a[2] === url && a.includes("--undo");

  /**
   * What a timed-out wait on a card's PR shows: the card's column and last run, its PR log lines, the gh calls about its
   * branch or PRs, and the PRs of the fake gh state.
   */
  async function prDiagnostic(b: Awaited<ReturnType<typeof setup>>, id: string) {
    const head = `nightshift/${id}`;
    const card = await b.get(id);
    const prs = fake.state().prs as { head: string; number: number; url: string; isDraft?: boolean; state: string }[];
    const urls = prs.filter((p) => p.head === head).map((p) => p.url);
    const calls = fake.calls();
    return {
      column: card.columnId,
      lastRun: card.lastRun,
      prLog: (await b.logOf(id)).filter((l) => /PR/.test(l.text)).map((l) => `${l.kind}: ${l.text}`),
      ghCalls: calls.filter((c) => c.args.some((a) => a.includes(head) || urls.includes(a))).map((c) => c.args.join(" ")),
      ghCallCount: calls.length,
      prs: prs.map((p) => ({ head: p.head, number: p.number, state: p.state, isDraft: p.isDraft === true })),
    };
  }

  return {
    fake,
    post,
    setup,
    agentRuns,
    prOf,
    setChecks,
    mergeCalls,
    callIndex,
    isCreate,
    isReady,
    isUndo,
    prDiagnostic,
    /** The running server, known once `beforeAll` has run. */
    get srv() {
      return srv;
    },
    get base() {
      return base;
    },
  };
}
