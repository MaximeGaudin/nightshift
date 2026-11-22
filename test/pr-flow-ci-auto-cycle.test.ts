// CI watcher with auto-merge: a merged PR moves the card to Done even with nothing local to clean, and a PR that can
// no longer merge on its own (auto-merge cancelled, conflict, closed, merge refused) gets a new merge cycle, at most
// MAX_AUTO_MERGE_CYCLES times before the card needs a human.
import { expect, test } from "bun:test";
import { MERGE_RELAUNCH_PREFIX } from "../src/server/ciWatcher.ts";
import { waitFor } from "./helpers.ts";
import { g, OPTIONAL_PENDING, PENDING, prFlowHarness } from "./pr-flow-helpers.ts";

const ctx = await prFlowHarness();
const { fake, setup, agentRuns, prOf, setChecks, mergeCalls, post } = ctx;

type B = Awaited<ReturnType<typeof setup>>;
const pass = (b: B) => ctx.srv.orch.ci.pass(ctx.srv.orch.open(b.dir));
const relaunches = async (b: B, id: string) => (await b.get(id)).history.filter((h) => h.text.startsWith(MERGE_RELAUNCH_PREFIX));
const runsOf = (title: string) => agentRuns().filter((r) => r.title.includes(title)).length;

/** A card waiting in Merge on `auto-merge programmé` (required pending check). */
async function scheduled(title: string, nextNumber: number) {
  fake.setState({ prs: [], nextNumber, requiredChecks: true, defaultChecks: PENDING });
  const b = await setup({ settings: { autoMerge: true } });
  const c = await b.card(title);
  await waitFor(async () => (await b.get(c.id)).description.includes("auto-merge programmé"), 30_000);
  const editPr = (patch: Record<string, unknown>) => {
    const s = fake.state();
    Object.assign(
      s.prs.find((p: { head: string }) => p.head === `nightshift/${c.id}`),
      patch,
    );
    fake.setState(s);
  };
  return { b, ...c, url: prOf(`nightshift/${c.id}`)[0].url as string, editPr };
}

test("auto-merge cancelled by GitHub: a new merge cycle merges the PR without an agent", async () => {
  const { b, id, sha, url, editPr } = await scheduled("cyc-cancelled", 300);
  const runs = runsOf("cyc-cancelled");
  setChecks(`nightshift/${id}`, "pass");
  editPr({ autoMerge: false });
  await pass(b);
  expect((await relaunches(b, id)).map((h) => h.text)).toEqual([`${MERGE_RELAUNCH_PREFIX} (1/3) — auto-merge annulé par GitHub`]);
  await waitFor(async () => (await b.get(id)).columnId === b.doneCol.id, 30_000);
  expect((await b.get(id)).description).toContain(`- PR: ${url} merged (${sha.slice(0, 7)})`);
  expect(mergeCalls(url).at(-1)?.args).toEqual(["pr", "merge", url, "--merge", "--delete-branch"]);
  expect(runsOf("cyc-cancelled")).toBe(runs);
}, 90_000);

test("conflict while auto-merge is scheduled: auto-merge disabled, Problème written, the merge agent runs", async () => {
  const { b, id, url, editPr } = await scheduled("cyc-conflict", 310);
  const runs = runsOf("cyc-conflict");
  editPr({ mergeable: "CONFLICTING" });
  await pass(b);
  expect(fake.calls().some((c) => c.args[1] === "merge" && c.args[2] === url && c.args.includes("--disable-auto"))).toBe(true);
  expect((await relaunches(b, id)).length).toBe(1);
  await waitFor(async () => runsOf("cyc-conflict") > runs, 30_000);
  const merge = (await b.get(id)).history.find((h) => h.text.startsWith(MERGE_RELAUNCH_PREFIX))?.text;
  expect(merge).toContain("conflit avec main");
}, 90_000);

test("PR closed while auto-merge is scheduled: Problème and a new merge run", async () => {
  const { b, id, url, editPr } = await scheduled("cyc-closed", 320);
  const runs = runsOf("cyc-closed");
  // Paused: the relaunched run waits, so the note written by the watcher can be read before any run rewrites it.
  await post("/api/flow/pause", { project: b.dir });
  editPr({ state: "CLOSED", autoMerge: false });
  await pass(b);
  const card = await b.get(id);
  expect(card.description).toContain(`- PR: ${url} — fermée sans merge\n- Problème : PR fermée sans merge`);
  expect((await relaunches(b, id)).length).toBe(1);
  // Queued while paused: further passes leave it alone.
  await pass(b);
  await pass(b);
  expect((await relaunches(b, id)).length).toBe(1);
  expect(runsOf("cyc-closed")).toBe(runs);
  await post("/api/flow/play", { project: b.dir });
  await waitFor(async () => runsOf("cyc-closed") > runs, 30_000);
}, 90_000);

test("Nightshift's own merge refused: Problème and a new merge run instead of 'prêt à merger'", async () => {
  fake.setState({ prs: [], nextNumber: 330, defaultChecks: OPTIONAL_PENDING });
  const b = await setup({ settings: { autoMerge: true } });
  const { id } = await b.card("cyc-refused");
  await waitFor(async () => (await b.get(id)).description.includes("checks en attente"), 30_000);
  await post("/api/flow/pause", { project: b.dir });
  setChecks(`nightshift/${id}`, "pass", { required: false });
  fake.setState({ ...fake.state(), mergeError: "GraphQL: something went wrong" });
  await pass(b);
  const card = await b.get(id);
  expect(card.description).toContain("- Problème : merge refusé : GraphQL: something went wrong");
  expect(card.description).not.toContain("prêt à merger");
  expect((await relaunches(b, id)).length).toBe(1);
  const s = fake.state();
  delete s.mergeError;
  fake.setState(s);
  await post("/api/flow/play", { project: b.dir });
  await waitFor(async () => (await b.get(id)).columnId === b.doneCol.id, 30_000);
}, 90_000);

test("after 3 automatic cycles the card needs a human, and the watcher leaves it alone", async () => {
  const { b, id, editPr } = await scheduled("cyc-limit", 340);
  const p = ctx.srv.orch.open(b.dir);
  p.mutate(() => {
    const card = p.card(id);
    if (!card) throw new Error("no card");
    for (const n of [1, 2, 3]) p.addHistory(card, "edited", `${MERGE_RELAUNCH_PREFIX} (${n}/3) — auto-merge annulé par GitHub`);
  });
  const runs = runsOf("cyc-limit");
  editPr({ autoMerge: false });
  await pass(b);
  const card = await b.get(id);
  expect(card.columnId).toBe(b.mergeCol.id);
  expect(card.lastRun?.status).toBe("attention");
  expect(card.description).toContain("- Problème : 3 relances automatiques sans merge, intervention requise");
  expect((await relaunches(b, id)).length).toBe(3);
  const calls = fake.calls().length;
  await pass(b);
  expect(fake.calls().length).toBe(calls);
  expect(runsOf("cyc-limit")).toBe(runs);
}, 90_000);

test("a PR merged by GitHub on a card with no local branch to clean still moves the card to Done", async () => {
  const { b, id, wt, sha, editPr } = await scheduled("cyc-no-worktree", 350);
  // `Worktree: none`: the card is not eligible for the local cleanup.
  const description = (await b.get(id)).description.replace(`- Worktree: ${wt}`, "- Worktree: none");
  await post(`/api/cards/${id}`, { project: b.dir, description }, "PATCH");
  g(b.remote, "update-ref", "refs/heads/main", sha);
  editPr({ state: "MERGED", mergeCommit: sha });
  await pass(b);
  const card = await b.get(id);
  expect(card.columnId).toBe(b.doneCol.id);
  expect(card.description).toContain(`merged (${sha.slice(0, 7)})`);
  expect(card.description).toContain("- Nettoyage local : rien à nettoyer");
}, 90_000);
