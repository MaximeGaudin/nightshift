// Pull request flow end to end: fake claude for the agents, fake gh on the PATH, real git with a bare remote that the
// board reaches through `url.<bare>.insteadOf https://github.com/o/r.git` (so origin is GitHub for Nightshift).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column, LogLine } from "../src/shared/types.ts";
import { installFakeGh, removeTempDirs, tempDir, waitFor } from "./helpers.ts";

process.env.NIGHTSHIFT_HOME = tempDir("ns-home-");
process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-skills-");
const argsLog = join(tempDir("ns-args-"), "args.jsonl");

const { skillsDir } = await import("../src/server/skills.ts");
const { startServer } = await import("../src/server/server.ts");
const { updateSettings } = await import("../src/server/settings.ts");
const { clearPrModeCache } = await import("../src/server/prMode.ts");

const GH_URL = "https://github.com/o/r.git";
const fake = installFakeGh();
const savedEnv: Record<string, string | undefined> = {};
let srv: ReturnType<typeof startServer>;
let base = "";

beforeAll(() => {
  const cfg = join(tempDir("ns-gitcfg-"), "gitconfig");
  writeFileSync(cfg, "");
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: cfg,
    FAKE_ARGS_LOG: argsLog,
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
const agentRuns = (): { title: string; fastMerge: boolean; prompt: string }[] =>
  existsSync(argsLog)
    ? readFileSync(argsLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** A board with Backlog, Review, Merge and Done; origin is GitHub (`github`) or the bare path. */
async function setup({ github = true, settings = {} as Record<string, unknown> } = {}) {
  const root = tempDir("ns-pr-");
  const remote = join(root, "remote.git");
  g(root, "init", "-q", "--bare", "-b", "main", remote);
  const dir = join(root, "board");
  mkdirSync(dir);
  g(dir, "init", "-q", "-b", "main");
  commit(dir, ".gitignore", "nightshift.json\n.claude/\n");
  commit(dir, "shared.txt", "one\n");
  if (github) {
    g(dir, "remote", "add", "origin", GH_URL);
    g(dir, "config", `url.${remote}.insteadOf`, GH_URL);
  } else g(dir, "remote", "add", "origin", remote);
  g(dir, "push", "-q", "-u", "origin", "main");
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
  /** A card with a worktree on nightshift/<id> and one commit, moved to Review. FAKE_KEEP_DESC keeps its note. */
  const card = async (title: string) => {
    const { id } = await post("/api/cards", { project: dir, columnId: backlog.id, title: `${title} FAKE_KEEP_DESC` });
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
  return { dir, remote, reviewCol, mergeCol, doneCol, get, logOf, card };
}

const prOf = (head: string) => fake.state().prs.filter((p: { head: string }) => p.head === head);
const PENDING = [{ name: "ci", state: "PENDING", bucket: "pending", link: "https://github.com/o/r/actions/runs/42/job/1" }];

test("after review: branch pushed, PR opened with the body, PR line on the card; pending checks wait in Merge", async () => {
  fake.setState({ prs: [], defaultChecks: PENDING });
  const b = await setup();
  const { id, sha } = await b.card("pr-create");
  await waitFor(async () => (await b.get(id)).description.includes("checks en attente"), 20_000);
  expect(g(b.remote, "rev-parse", `refs/heads/nightshift/${id}`)).toBe(sha);
  const [pr] = prOf(`nightshift/${id}`);
  expect(pr).toMatchObject({ base: "main", state: "OPEN" });
  expect(pr.title).toContain("pr-create");
  expect(pr.body).toContain("- [x] it works");
  expect(pr.body).toContain("## Review\n\n- Findings: none");
  expect(pr.body).toContain(`(${id})`);
  expect(pr.body).not.toContain("Worktree:");
  const card = await b.get(id);
  expect(card.columnId).toBe(b.mergeCol.id);
  expect(card.description).toContain(`- PR: ${pr.url}`);
  expect(card.description).toContain(`- PR: ${pr.url} — checks en attente`);
  expect(fake.calls().some((c) => c.args[1] === "merge")).toBe(false);
  expect(agentRuns().filter((r) => r.title.includes("pr-create")).length).toBe(1);
  // The review agent was told about the mode.
  expect(agentRuns().find((r) => r.title.includes("pr-create"))?.prompt).toContain(
    "Pull requests: github via gh (merge method: merge, auto-merge: off)",
  );

  // A second review updates the same PR and keeps the screenshots block.
  const shots = "<!-- nightshift-screenshots:start -->\n## Screenshots\n<!-- nightshift-screenshots:end -->";
  const s = fake.state();
  s.prs[0].body = `${s.prs[0].body}\n\n${shots}`;
  fake.setState(s);
  await post(`/api/cards/${id}/move`, { project: b.dir, columnId: b.reviewCol.id });
  await waitFor(async () => fake.calls().some((c) => c.args[1] === "edit"), 20_000);
  await waitFor(async () => {
    const c = await b.get(id);
    return c.columnId === b.mergeCol.id && c.lastRun?.columnId === b.mergeCol.id && c.lastRun.status === "success";
  }, 20_000);
  expect(prOf(`nightshift/${id}`).length).toBe(1);
  expect(prOf(`nightshift/${id}`)[0].body.endsWith(shots)).toBe(true);
}, 60_000);

test("merge: checks green → gh pr merge, remote branch deleted, local base fast-forwarded, cleanup, Done", async () => {
  fake.setState({ prs: [], nextNumber: 10 });
  const b = await setup();
  const { id, wt, sha } = await b.card("pr-merge-ok");
  await waitFor(async () => (await b.get(id)).columnId === b.doneCol.id, 30_000);
  const card = await b.get(id);
  const [pr] = prOf(`nightshift/${id}`);
  expect(pr.state).toBe("MERGED");
  expect(fake.calls().find((c) => c.args[1] === "merge" && c.args[2] === pr.url)?.args).toEqual([
    "pr",
    "merge",
    pr.url,
    "--merge",
    "--delete-branch",
  ]);
  expect(card.description).toContain(`- PR: ${pr.url} merged (${sha.slice(0, 7)})`);
  expect(g(b.remote, "rev-parse", "refs/heads/main")).toBe(sha);
  expect(Bun.spawnSync(["git", "-C", b.remote, "rev-parse", "--verify", "--quiet", `refs/heads/nightshift/${id}`]).exitCode).not.toBe(0);
  expect(g(b.dir, "rev-parse", "main")).toBe(sha);
  expect(existsSync(wt)).toBe(false);
  expect(g(b.dir, "branch", "--list", `nightshift/${id}`)).toBe("");
  expect(agentRuns().filter((r) => r.title.includes("pr-merge-ok")).length).toBe(1);
}, 60_000);

test("merge: squash method is passed and the unmerged-looking branch is deleted with -D", async () => {
  fake.setState({ prs: [], nextNumber: 20 });
  const b = await setup({ settings: { mergeMethod: "squash" } });
  const { id } = await b.card("pr-squash");
  await waitFor(async () => (await b.get(id)).columnId === b.doneCol.id, 30_000);
  expect(fake.calls().find((c) => c.args[1] === "merge" && c.args[2]?.endsWith("/20"))?.args).toContain("--squash");
  expect(g(b.dir, "branch", "--list", `nightshift/${id}`)).toBe("");
}, 60_000);

test("merge: pending checks with auto-merge on schedule gh pr merge --auto", async () => {
  fake.setState({ prs: [], nextNumber: 30, defaultChecks: PENDING });
  const b = await setup({ settings: { autoMerge: true } });
  const { id } = await b.card("pr-auto");
  await waitFor(async () => (await b.get(id)).description.includes("auto-merge programmé"), 30_000);
  const [pr] = prOf(`nightshift/${id}`);
  expect(fake.calls().find((c) => c.args[1] === "merge" && c.args[2] === pr.url)?.args).toEqual([
    "pr",
    "merge",
    pr.url,
    "--merge",
    "--delete-branch",
    "--auto",
  ]);
  expect((await b.get(id)).columnId).toBe(b.mergeCol.id);
}, 60_000);

test("merge: a conflicting PR starts the merge agent with the PR fallback and the mode line", async () => {
  fake.setState({ prs: [], nextNumber: 40, defaultMergeable: "CONFLICTING" });
  const b = await setup();
  const { id } = await b.card("pr-conflict");
  await waitFor(async () => agentRuns().filter((r) => r.title.includes("pr-conflict")).length >= 2, 30_000);
  const mergeRun = agentRuns().filter((r) => r.title.includes("pr-conflict"))[1];
  expect(mergeRun.fastMerge).toBe(true);
  expect(mergeRun.prompt).toContain("Step: pr-conflict");
  expect(mergeRun.prompt).toContain("Pull requests: github via gh");
  expect(fake.calls().some((c) => c.args[1] === "merge" && c.args[2]?.endsWith("/40"))).toBe(false);
  expect(id).toBeTruthy();
}, 60_000);

test("merge: a PR closed without merge starts the agent with the pr-closed fallback", async () => {
  fake.setState({ prs: [], nextNumber: 50, defaultChecks: PENDING });
  const b = await setup();
  const { id } = await b.card("pr-closed");
  await waitFor(async () => (await b.get(id)).description.includes("checks en attente"), 30_000);
  const s = fake.state();
  s.prs.find((p: { head: string }) => p.head === `nightshift/${id}`).state = "CLOSED";
  fake.setState(s);
  await post(`/api/cards/${id}/retry`, { project: b.dir });
  await waitFor(async () => agentRuns().filter((r) => r.title.includes("pr-closed")).length >= 2, 30_000);
  const mergeRun = agentRuns().filter((r) => r.title.includes("pr-closed"))[1];
  expect(mergeRun.prompt).toContain("Step: pr-closed");
}, 60_000);

test("mode off (origin not on GitHub): gh is never called and the local fast merge pushes the base", async () => {
  fake.setState({ prs: [] });
  const before = fake.calls().length;
  const b = await setup({ github: false });
  const { id, sha } = await b.card("pr-off");
  await waitFor(async () => (await b.get(id)).columnId === b.doneCol.id, 30_000);
  expect(fake.calls().length).toBe(before);
  expect(g(b.remote, "rev-parse", "refs/heads/main")).toBe(sha);
  const run = agentRuns().find((r) => r.title.includes("pr-off"));
  expect(run?.prompt).not.toContain("Pull requests:");
  expect((await b.get(id)).description).toContain("merge rapide");
}, 60_000);

const LINK = "https://github.com/o/r/actions/runs/42/job/1";
const setChecks = (head: string, bucket: string) => {
  const s = fake.state();
  for (const p of s.prs) if (p.head === head) p.checks = [{ name: "ci", state: bucket.toUpperCase(), bucket, link: LINK }];
  fake.setState(s);
};

test("CI watcher: a failed check disables auto-merge, writes ## CI and sends the card back to Review", async () => {
  fake.setState({ prs: [], nextNumber: 60, defaultChecks: PENDING, runLogs: { "42": "step 1\nerror: boom" } });
  const b = await setup({ settings: { autoMerge: true } });
  const { id } = await b.card("ci-fail");
  await waitFor(async () => (await b.get(id)).description.includes("auto-merge programmé"), 30_000);
  const head = `nightshift/${id}`;
  setChecks(head, "fail");
  const runsBefore = agentRuns().filter((r) => r.title.includes("ci-fail")).length;
  await srv.orch.ci.pass(srv.orch.open(b.dir));
  const card = await b.get(id);
  expect(card.description).toContain(`## CI\n\n- ci : ${LINK}`);
  expect(card.description).toContain("error: boom");
  const url = prOf(head)[0].url;
  expect(fake.calls().some((c) => c.args[1] === "merge" && c.args[2] === url && c.args.includes("--disable-auto"))).toBe(true);
  expect(card.history.some((h) => h.kind === "moved" && h.text.startsWith("CI:"))).toBe(true);
  // The review runs again; with green checks the card then merges.
  setChecks(head, "pass");
  await waitFor(async () => agentRuns().filter((r) => r.title.includes("ci-fail")).length > runsBefore, 30_000);
  await waitFor(async () => (await b.get(id)).columnId === b.doneCol.id, 30_000);
}, 90_000);

test("CI watcher: a PR merged by auto-merge is cleaned up and the card moves to Done", async () => {
  fake.setState({ prs: [], nextNumber: 70, defaultChecks: PENDING });
  const b = await setup({ settings: { autoMerge: true } });
  const { id, wt, sha } = await b.card("ci-auto-merged");
  await waitFor(async () => (await b.get(id)).description.includes("auto-merge programmé"), 30_000);
  // GitHub merges the PR on its own.
  const s = fake.state();
  const pr = s.prs.find((p: { head: string }) => p.head === `nightshift/${id}`);
  g(b.remote, "update-ref", "refs/heads/main", sha);
  g(b.remote, "update-ref", "-d", `refs/heads/nightshift/${id}`);
  Object.assign(pr, { state: "MERGED", mergeCommit: sha });
  fake.setState(s);
  await srv.orch.ci.pass(srv.orch.open(b.dir));
  const card = await b.get(id);
  expect(card.columnId).toBe(b.doneCol.id);
  expect(card.description).toContain(`- PR: ${pr.url} merged (${sha.slice(0, 7)})`);
  expect(existsSync(wt)).toBe(false);
  expect(g(b.dir, "rev-parse", "main")).toBe(sha);
}, 60_000);

test("CI watcher: green checks without auto-merge mark the card ready, without merging", async () => {
  fake.setState({ prs: [], nextNumber: 80, defaultChecks: PENDING });
  const b = await setup();
  const { id } = await b.card("ci-ready");
  await waitFor(async () => (await b.get(id)).description.includes("checks en attente"), 30_000);
  setChecks(`nightshift/${id}`, "pass");
  await srv.orch.ci.pass(srv.orch.open(b.dir));
  const card = await b.get(id);
  expect(card.columnId).toBe(b.mergeCol.id);
  expect(card.description).toContain("— checks verts, prêt à merger");
  const url = prOf(`nightshift/${id}`)[0].url;
  expect(fake.calls().some((c) => c.args[1] === "merge" && c.args[2] === url)).toBe(false);
}, 60_000);

test("PUT /api/pull-requests stores valid values, never the defaults, and rejects the rest", async () => {
  const b = await setup({ github: false });
  const put = (body: object) =>
    fetch(`${base}/api/pull-requests`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: b.dir, ...body }),
    });
  const ok = await (await put({ pullRequests: "off", mergeMethod: "rebase", autoMerge: true })).json();
  expect(ok.board).toMatchObject({ pullRequests: "off", mergeMethod: "rebase", autoMerge: true });
  await waitFor(() => JSON.parse(readFileSync(join(b.dir, "nightshift.json"), "utf8")).mergeMethod === "rebase");
  const back = await (await put({ pullRequests: "auto", mergeMethod: "merge", autoMerge: false })).json();
  expect(back.board.pullRequests).toBeUndefined();
  expect(back.board.mergeMethod).toBeUndefined();
  expect(back.board.autoMerge).toBeUndefined();
  expect((await put({ mergeMethod: "fast" })).status).toBe(400);
  expect((await put({ pullRequests: "on" })).status).toBe(400);
  expect((await put({ autoMerge: "yes" })).status).toBe(400);
});
