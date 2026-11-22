import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { waitFor } from "./helpers.ts";
import { g, LINK, OPTIONAL_PENDING, PENDING, prFlowHarness } from "./pr-flow-helpers.ts";

const ctx = await prFlowHarness();
const { fake, setup, agentRuns, prOf, setChecks, mergeCalls } = ctx;

test("e2e: CI watcher, a failing non-required check sends the card back to Review", async () => {
  fake.setState({ prs: [], nextNumber: 230, defaultChecks: OPTIONAL_PENDING, runLogs: { "42": "error: red" } });
  const b = await setup();
  const { id } = await b.card("e2e-watch-optional-fail");
  await waitFor(async () => (await b.get(id)).description.includes("checks en attente"), 30_000);
  setChecks(`nightshift/${id}`, "fail", { required: false });
  await ctx.srv.orch.ci.pass(ctx.srv.orch.open(b.dir));
  const card = await b.get(id);
  expect(card.description).toContain(`## CI\n\n- ci : ${LINK}`);
  expect(card.history.some((h) => h.kind === "moved" && h.text.startsWith("CI:"))).toBe(true);
  expect(mergeCalls(prOf(`nightshift/${id}`)[0].url)).toEqual([]);
}, 60_000);

test("e2e: CI watcher, auto-merge on and no required check: green checks are merged by Nightshift", async () => {
  fake.setState({ prs: [], nextNumber: 240, defaultChecks: OPTIONAL_PENDING });
  const b = await setup({ settings: { autoMerge: true } });
  const { id, sha } = await b.card("e2e-watch-self-merge");
  await waitFor(async () => (await b.get(id)).description.includes("checks en attente"), 30_000);
  setChecks(`nightshift/${id}`, "pass", { required: false });
  await ctx.srv.orch.ci.pass(ctx.srv.orch.open(b.dir));
  const card = await b.get(id);
  const url = prOf(`nightshift/${id}`)[0].url;
  expect(mergeCalls(url).map((c) => c.args)).toEqual([["pr", "merge", url, "--merge", "--delete-branch"]]);
  expect(card.columnId).toBe(b.doneCol.id);
  expect(card.description).toContain(`- PR: ${url} merged (${sha.slice(0, 7)})`);
}, 60_000);

test("CI watcher: a failed check disables auto-merge, writes ## CI and sends the card back to Review", async () => {
  fake.setState({ prs: [], nextNumber: 60, requiredChecks: true, defaultChecks: PENDING, runLogs: { "42": "step 1\nerror: boom" } });
  const b = await setup({ settings: { autoMerge: true } });
  const { id } = await b.card("ci-fail");
  await waitFor(async () => (await b.get(id)).description.includes("auto-merge programmé"), 30_000);
  const head = `nightshift/${id}`;
  setChecks(head, "fail");
  const runsBefore = agentRuns().filter((r) => r.title.includes("ci-fail")).length;
  await ctx.srv.orch.ci.pass(ctx.srv.orch.open(b.dir));
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
  fake.setState({ prs: [], nextNumber: 70, requiredChecks: true, defaultChecks: PENDING });
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
  await ctx.srv.orch.ci.pass(ctx.srv.orch.open(b.dir));
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
  await ctx.srv.orch.ci.pass(ctx.srv.orch.open(b.dir));
  const card = await b.get(id);
  expect(card.columnId).toBe(b.mergeCol.id);
  expect(card.description).toContain("— checks verts, prêt à merger");
  const url = prOf(`nightshift/${id}`)[0].url;
  expect(fake.calls().some((c) => c.args[1] === "merge" && c.args[2] === url)).toBe(false);
}, 60_000);
