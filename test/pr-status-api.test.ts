// CI status of a card's PR over HTTP: the ci-refresh endpoint and the `ci` map of the snapshot (fake gh, real git).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { PrCiStatus } from "../src/shared/pullRequests.ts";
import type { ProjectSnapshot } from "../src/shared/types.ts";
import { type ChildServer, installFakeGh, removeTempDirs, startChildServer } from "./helpers.ts";

setDefaultTimeout(20_000);

const fake = installFakeGh();
const URL_ = "https://github.com/o/r/pull/7";
let srv: ChildServer;
let dir = "";
let cardId = "";
const q = () => `project=${encodeURIComponent(dir)}`;
const snap = async (): Promise<ProjectSnapshot> => srv.call(`/api/project?${q()}`).then((r) => r.json());

beforeAll(async () => {
  fake.setState({
    prs: [
      {
        number: 7,
        url: URL_,
        head: "x",
        base: "main",
        title: "t",
        body: "",
        state: "OPEN",
        checks: [
          { name: "build", state: "SUCCESS", bucket: "pass", link: "https://github.com/o/r/actions/runs/1/job/1" },
          { name: "lint", state: "FAILURE", bucket: "fail", link: "https://github.com/o/r/actions/runs/1/job/2", required: false },
        ],
      },
    ],
  });
  srv = await startChildServer({ env: { ...fake.env, PATH: `${fake.dir}:${process.env.PATH}`, NIGHTSHIFT_PR_STATUS_POLL_MS: "3600000" } });
  dir = mkdtempSync(join(srv.tmp, "proj-"));
  Bun.spawnSync(["git", "init", "-q", dir]);
  Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", "https://github.com/o/r.git"]);
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
  const created = await srv.call("/api/cards", { body: { project: dir, title: "card", description: `## Review\n\n- PR: ${URL_}\n` } });
  expect(created.status).toBe(200);
  cardId = (await snap()).board.cards[0].id;
});
afterAll(async () => {
  await srv.stop();
  removeTempDirs();
});

test("ci-refresh returns the status counting non-required checks, and the snapshot carries it", async () => {
  const r = await srv.call(`/api/cards/${cardId}/ci-refresh`, { body: { project: dir } });
  expect(r.status).toBe(200);
  const { ci } = (await r.json()) as { ci: PrCiStatus | null };
  expect(ci).toMatchObject({ url: URL_, state: "fail", failed: [{ name: "lint" }] });
  expect((await snap()).ci?.[cardId]).toMatchObject({ url: URL_, state: "fail" });
});

test("ci-refresh on an unknown card is a 404", async () => {
  const r = await srv.call("/api/cards/card_nope/ci-refresh", { body: { project: dir } });
  expect(r.status).toBe(404);
});

test("the status is not written into the card note", async () => {
  const card = (await snap()).board.cards.find((c) => c.id === cardId);
  expect(card?.description).toBe(`## Review\n\n- PR: ${URL_}\n`);
});
