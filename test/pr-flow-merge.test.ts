import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { waitFor } from "./helpers.ts";
import { g, PENDING, prFlowHarness } from "./pr-flow-helpers.ts";

const ctx = await prFlowHarness();
const { fake, post, setup, agentRuns, prOf } = ctx;

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
  fake.setState({ prs: [], nextNumber: 30, requiredChecks: true, defaultChecks: PENDING });
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

test("merge: a required check that has not reported yet makes the card wait, not escalate", async () => {
  fake.setState({ prs: [], nextNumber: 90, mergeError: 'GraphQL: Required status check "ci" is expected. (mergePullRequest)' });
  const b = await setup();
  const { id } = await b.card("pr-not-reported");
  await waitFor(async () => (await b.get(id)).description.includes("checks en attente"), 30_000);
  expect((await b.get(id)).columnId).toBe(b.mergeCol.id);
  expect(agentRuns().filter((r) => r.title.includes("pr-not-reported")).length).toBe(1);
}, 60_000);
