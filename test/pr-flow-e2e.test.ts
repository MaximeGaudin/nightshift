import { expect, test } from "bun:test";
import { waitFor } from "./helpers.ts";
import { LINK, OPTIONAL_FAIL, OPTIONAL_PENDING, prFlowHarness } from "./pr-flow-helpers.ts";

const ctx = await prFlowHarness();
const { fake, setup, prOf, mergeCalls } = ctx;

test("e2e: a failing non-required check on an unprotected base sends the card back to Review", async () => {
  fake.setState({ prs: [], nextNumber: 200, defaultChecks: OPTIONAL_FAIL, runLogs: { "42": "error: red" } });
  const b = await setup();
  const { id } = await b.card("e2e-optional-fail");
  await waitFor(async () => (await b.get(id)).description.includes("## CI"), 30_000);
  const card = await b.get(id);
  expect(card.description).toContain(`## CI\n\n- ci : ${LINK}`);
  expect(mergeCalls(prOf(`nightshift/${id}`)[0].url)).toEqual([]);
}, 60_000);

test("e2e: a running non-required check with auto-merge on an unprotected base waits without --auto", async () => {
  fake.setState({ prs: [], nextNumber: 210, defaultChecks: OPTIONAL_PENDING });
  const b = await setup({ settings: { autoMerge: true } });
  const { id } = await b.card("e2e-optional-pending");
  await waitFor(async () => (await b.get(id)).description.includes("checks en attente"), 30_000);
  expect((await b.get(id)).columnId).toBe(b.mergeCol.id);
  expect(mergeCalls(prOf(`nightshift/${id}`)[0].url)).toEqual([]);
}, 60_000);

test("e2e: CI workflows and no check reported yet: the card waits instead of merging", async () => {
  fake.setState({ prs: [], nextNumber: 220 });
  const b = await setup({ workflows: true });
  const { id } = await b.card("e2e-no-checks-yet");
  await waitFor(async () => (await b.get(id)).description.includes("checks en attente"), 30_000);
  expect((await b.get(id)).columnId).toBe(b.mergeCol.id);
  expect(mergeCalls(prOf(`nightshift/${id}`)[0].url)).toEqual([]);
}, 60_000);
