import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { waitFor } from "./helpers.ts";
import { g, prFlowHarness } from "./pr-flow-helpers.ts";

const ctx = await prFlowHarness();
const { fake, setup, agentRuns } = ctx;

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

test("PUT /api/pull-requests stores valid values, never the defaults, and rejects the rest", async () => {
  const b = await setup({ github: false });
  const put = (body: object) =>
    fetch(`${ctx.base}/api/pull-requests`, {
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
