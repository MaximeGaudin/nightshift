// CI gate of the PR flow: every check counts, and "no check yet" only counts as green without CI workflows or after
// the grace.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChecksSummary, CodeHost, PrInfo } from "../src/server/codehost/codehost.ts";
import { CI_NO_CHECKS_GRACE_MS, ciVerdict, PrFlow } from "../src/server/prFlow.ts";
import type { Project } from "../src/server/store.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

afterAll(() => removeTempDirs());

const MIN = 60_000;
const failed = [{ name: "ci", link: "https://github.com/o/r/actions/runs/1/job/1" }];
const base = { hasWorkflows: true, noChecksSince: 0, now: 0, graceMs: CI_NO_CHECKS_GRACE_MS };

test("ci-gate: fail, pending and pass are passed through", () => {
  expect(ciVerdict({ ...base, checks: { state: "fail", failed } })).toEqual({ state: "fail", failed });
  expect(ciVerdict({ ...base, checks: { state: "pending", failed: [] } })).toEqual({ state: "pending" });
  expect(ciVerdict({ ...base, checks: { state: "pass", failed: [] } })).toEqual({ state: "pass" });
});

test("ci-gate: no check without workflow is green", () => {
  expect(ciVerdict({ ...base, hasWorkflows: false, checks: { state: "none", failed: [] } })).toEqual({ state: "pass" });
});

test("ci-gate: no check with workflows waits 10 min, then passes without CI", () => {
  const none: ChecksSummary = { state: "none", failed: [] };
  expect(CI_NO_CHECKS_GRACE_MS).toBe(10 * MIN);
  expect(ciVerdict({ ...base, checks: none, noChecksSince: 0, now: 9 * MIN })).toEqual({ state: "pending" });
  expect(ciVerdict({ ...base, checks: none, noChecksSince: 0, now: 10 * MIN })).toEqual({ state: "pass", noCi: true });
});

function repo(workflows: boolean) {
  const dir = tempDir("ns-ci-gate-");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" };
  const g = (...a: string[]) => {
    const r = Bun.spawnSync(["git", ...a], { cwd: dir, env });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
  if (workflows) {
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "on: [pull_request]\n");
  }
  g("add", "-A");
  g("commit", "-qm", "init");
  g("branch", "nightshift/c1");
  return dir;
}

test("ci-gate: the grace runs per PR head and logs once", async () => {
  let now = 0;
  const logs: string[] = [];
  const flow = new PrFlow({ log: (_p, _c, _k, text) => logs.push(text), now: () => now });
  let checks: ChecksSummary = { state: "none", failed: [] };
  const calls: unknown[] = [];
  const host = {
    checks: async (_cwd: string, _url: string, opts?: { all?: boolean }) => {
      calls.push(opts);
      return checks;
    },
  } as unknown as CodeHost;
  const p = { path: repo(true) } as unknown as Project;
  const pr = (headSha: string) => ({ url: "https://github.com/o/r/pull/1", headSha }) as PrInfo;
  expect(await flow.ciGate(p, "c1", "nightshift/c1", pr("a"), host)).toEqual({ state: "pending" });
  expect(calls[0]).toEqual({ all: true });
  now = 9 * MIN;
  expect((await flow.ciGate(p, "c1", "nightshift/c1", pr("a"), host)).state).toBe("pending");
  // A new head (new push) starts its own grace.
  expect((await flow.ciGate(p, "c1", "nightshift/c1", pr("b"), host)).state).toBe("pending");
  now = 10 * MIN;
  expect(await flow.ciGate(p, "c1", "nightshift/c1", pr("a"), host)).toEqual({ state: "pass", noCi: true });
  expect(await flow.ciGate(p, "c1", "nightshift/c1", pr("a"), host)).toEqual({ state: "pass", noCi: true });
  expect(logs).toEqual(["aucun check après 10 min : merge sans CI"]);
  expect((await flow.ciGate(p, "c1", "nightshift/c1", pr("b"), host)).state).toBe("pending");
  checks = { state: "fail", failed };
  expect(await flow.ciGate(p, "c1", "nightshift/c1", pr("b"), host)).toEqual({ state: "fail", failed });
});

test("ci-gate: a repository without workflow merges at once", async () => {
  const flow = new PrFlow({ log: () => {}, now: () => 0 });
  const host = { checks: async () => ({ state: "none", failed: [] }) } as unknown as CodeHost;
  const p = { path: repo(false) } as unknown as Project;
  expect(await flow.ciGate(p, "c1", "nightshift/c1", { url: "u", headSha: "a" } as PrInfo, host)).toEqual({ state: "pass" });
});
