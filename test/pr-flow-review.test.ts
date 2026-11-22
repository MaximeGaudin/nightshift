import { expect, test } from "bun:test";
import { waitFor } from "./helpers.ts";
import { g, LINK, PENDING, prFlowHarness } from "./pr-flow-helpers.ts";

const ctx = await prFlowHarness();
const { fake, post, setup, agentRuns, prOf, callIndex, isCreate, isReady, isUndo, prDiagnostic } = ctx;

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

test("review: a draft PR opens when the card enters Review, then is updated and marked ready", async () => {
  fake.setState({ prs: [], nextNumber: 100, defaultChecks: PENDING });
  const b = await setup();
  const { id } = await b.card("pr-draft");
  await waitFor(async () => (await b.get(id)).description.includes("checks en attente"), 30_000);
  const head = `nightshift/${id}`;
  const [pr] = prOf(head);
  expect(pr.isDraft).toBe(false);
  const create = callIndex(isCreate(head));
  expect(fake.calls()[create].args).toContain("--draft");
  const edit = callIndex((a) => a[1] === "edit" && a[2] === pr.url, create);
  const ready = callIndex(isReady(pr.url), edit);
  expect(edit).toBeGreaterThan(create);
  expect(ready).toBeGreaterThan(edit);
  expect((await b.get(id)).description).toContain(`- PR: ${pr.url}`);

  // Back to Review: the ready PR becomes a draft again, then ready after the review. A gh call is logged before it
  // writes the state: wait for the write too, or its late write lands in the next test.
  const before = fake.calls().length - 1;
  await post(`/api/cards/${id}/move`, { project: b.dir, columnId: b.reviewCol.id });
  await waitFor(
    async () => {
      const undo = callIndex(isUndo(pr.url), before);
      return undo >= 0 && callIndex(isReady(pr.url), undo) >= 0 && prOf(head)[0]?.isDraft === false;
    },
    30_000,
    () => prDiagnostic(b, id),
  );
  expect(prOf(head)[0].isDraft).toBe(false);
  expect(prOf(head).length).toBe(1);
}, 90_000);

test("review: a failed review leaves the PR in draft", async () => {
  fake.setState({ prs: [], nextNumber: 110, defaultChecks: PENDING });
  const b = await setup();
  const { id } = await b.card("fail", { exact: true });
  const diag = () => prDiagnostic(b, id);
  await waitFor(async () => (await b.get(id)).lastRun?.status === "error", 30_000, diag);
  const head = `nightshift/${id}`;
  await waitFor(async () => prOf(head).length === 1, 20_000, diag);
  const [pr] = prOf(head);
  expect(pr.isDraft).toBe(true);
  expect(callIndex(isReady(pr.url))).toBe(-1);
  expect((await b.get(id)).columnId).toBe(b.reviewCol.id);
}, 60_000);

test("merge: a draft PR is marked ready before it is merged", async () => {
  fake.setState({ prs: [], nextNumber: 120, defaultChecks: PENDING });
  const b = await setup();
  const { id } = await b.card("pr-draft-merge");
  await waitFor(async () => (await b.get(id)).description.includes("checks en attente"), 30_000);
  const head = `nightshift/${id}`;
  const s = fake.state();
  const pr = s.prs.find((p: { head: string }) => p.head === head);
  Object.assign(pr, { isDraft: true, checks: [{ name: "ci", state: "SUCCESS", bucket: "pass", link: LINK }] });
  fake.setState(s);
  const before = fake.calls().length - 1;
  await post(`/api/cards/${id}/move`, { project: b.dir, columnId: b.backlog.id });
  await post(`/api/cards/${id}/move`, { project: b.dir, columnId: b.mergeCol.id });
  await waitFor(async () => (await b.get(id)).columnId === b.doneCol.id, 30_000);
  const ready = callIndex(isReady(pr.url), before);
  const merge = callIndex((a) => a[1] === "merge" && a[2] === pr.url, before);
  expect(ready).toBeGreaterThan(before);
  expect(merge).toBeGreaterThan(ready);
  expect(prOf(head)[0].state).toBe("MERGED");
}, 60_000);

test("review: a draft PR that cannot be created does not block the review; the PR opens ready after it", async () => {
  fake.setState({
    prs: [],
    nextNumber: 130,
    defaultChecks: PENDING,
    draftError: "Draft pull requests are not supported in this repository.",
  });
  const b = await setup();
  const { id } = await b.card("pr-draft-error");
  await waitFor(async () => (await b.get(id)).description.includes("checks en attente"), 30_000);
  const [pr] = prOf(`nightshift/${id}`);
  expect(pr.isDraft).not.toBe(true);
  expect((await b.get(id)).lastRun?.status).toBe("success");
  // The draft attempt failed first; the ready PR came from the review.
  const draftTry = callIndex((a) => isCreate(`nightshift/${id}`)(a) && a.includes("--draft"));
  const created = callIndex((a) => isCreate(`nightshift/${id}`)(a) && !a.includes("--draft"), draftTry);
  expect(draftTry).toBeGreaterThanOrEqual(0);
  expect(created).toBeGreaterThan(draftTry);
  const s = fake.state();
  delete s.draftError;
  fake.setState(s);
}, 60_000);
