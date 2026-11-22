// GitHub code host driven against the fake gh: argv, stdin bodies, state parsing and error classes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { CodeHostError } from "../src/server/codehost/codehost.ts";
import { github } from "../src/server/codehost/github.ts";
import { installFakeGh, removeTempDirs, tempDir } from "./helpers.ts";

const fake = installFakeGh();
const saved: Record<string, string | undefined> = {};
const cwd = tempDir("ns-codehost-");

beforeAll(() => {
  for (const [k, v] of Object.entries({ ...fake.env, PATH: `${fake.dir}:${process.env.PATH}` })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeTempDirs();
});

test("available reports a missing auth", async () => {
  expect(await github.available(cwd)).toEqual({ ok: true });
  fake.setState({ auth: false, prs: [] });
  expect((await github.available(cwd)).ok).toBe(false);
  fake.setState({ prs: [] });
});

test("create, find and update a PR, bodies through stdin", async () => {
  expect(await github.findPr(cwd, "nightshift/c1")).toBeNull();
  const body = "--title injected\n## Summary";
  const url = await github.createPr(cwd, { base: "main", head: "nightshift/c1", title: "-t weird", body });
  expect(url).toBe("https://github.com/o/r/pull/1");
  const create = fake.calls().find((c) => c.args[1] === "create");
  expect(create?.args).toEqual(["pr", "create", "--base", "main", "--head", "nightshift/c1", "--title", "-t weird", "--body-file", "-"]);
  expect(create?.stdin).toBe(body);
  const pr = await github.findPr(cwd, "nightshift/c1");
  expect(pr).toMatchObject({ url, number: 1, state: "OPEN", mergeable: "MERGEABLE", baseRefName: "main", body });
  await github.updatePr(cwd, url, { title: "T2", body: "new" });
  expect(fake.state().prs[0]).toMatchObject({ title: "T2", body: "new" });
});

test("draft PRs: created with --draft, marked ready, converted back", async () => {
  const saved = fake.state();
  const url = await github.createPr(cwd, { base: "main", head: "nightshift/d1", title: "T", body: "b", draft: true });
  expect(fake.calls().findLast((c) => c.args[1] === "create")?.args).toEqual([
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    "nightshift/d1",
    "--title",
    "T",
    "--body-file",
    "-",
    "--draft",
  ]);
  expect((await github.findPr(cwd, "nightshift/d1"))?.isDraft).toBe(true);
  await github.markReady(cwd, url);
  expect(fake.calls().at(-1)?.args).toEqual(["pr", "ready", url]);
  expect((await github.prState(cwd, url))?.isDraft).toBe(false);
  await github.markDraft(cwd, url);
  expect(fake.calls().at(-1)?.args).toEqual(["pr", "ready", url, "--undo"]);
  expect((await github.prState(cwd, url))?.isDraft).toBe(true);
  await expect(github.markReady(cwd, "https://github.com/o/r/pull/99")).rejects.toBeInstanceOf(CodeHostError);
  fake.setState(saved);
});

test("checks: none, pending, fail, pass", async () => {
  const url = "https://github.com/o/r/pull/1";
  expect(await github.checks(cwd, url)).toEqual({ state: "none", failed: [] });
  const s = fake.state();
  const link = "https://github.com/o/r/actions/runs/42/job/1";
  s.prs[0].checks = [{ name: "ci", state: "PENDING", bucket: "pending", link }];
  fake.setState(s);
  expect((await github.checks(cwd, url)).state).toBe("pending");
  s.prs[0].checks = [{ name: "ci", state: "FAILURE", bucket: "fail", link }];
  fake.setState(s);
  expect(await github.checks(cwd, url)).toEqual({ state: "fail", failed: [{ name: "ci", link }] });
  s.prs[0].checks = [{ name: "ci", state: "SUCCESS", bucket: "pass", link }];
  s.runLogs = { "42": "a\nb\nc" };
  fake.setState(s);
  expect((await github.checks(cwd, url)).state).toBe("pass");
  expect(await github.failedLogs(cwd, link, 2)).toBe("b\nc");
  expect(await github.failedLogs(cwd, "https://example.com/x", 2)).toBe("");
});

test("checks all vs required: a failing non-required check", async () => {
  const url = "https://github.com/o/r/pull/1";
  const s = fake.state();
  const saved = structuredClone(s);
  const link = "https://github.com/o/r/actions/runs/42/job/1";
  s.prs[0].checks = [
    { name: "build", state: "SUCCESS", bucket: "pass", link },
    { name: "lint", state: "FAILURE", bucket: "fail", link, required: false },
  ];
  fake.setState(s);
  expect((await github.checks(cwd, url)).state).toBe("pass");
  expect(await github.checks(cwd, url, { all: true })).toEqual({ state: "fail", failed: [{ name: "lint", link }] });
  s.prs[0].checks = [];
  fake.setState(s);
  expect(await github.checks(cwd, url, { all: true })).toEqual({ state: "none", failed: [] });
  fake.setState(saved);
});

test("merge: method flags, auto, conflict, protected", async () => {
  const url = "https://github.com/o/r/pull/1";
  const s = fake.state();
  s.prs[0].mergeable = "CONFLICTING";
  fake.setState(s);
  expect(await github.mergePr(cwd, url, { method: "merge", auto: false })).toMatchObject({ ok: false, kind: "conflict" });
  s.prs[0].mergeable = "MERGEABLE";
  s.mergeError = "GraphQL: Base branch policy prohibits the merge: protected branch requires review";
  fake.setState(s);
  expect(await github.mergePr(cwd, url, { method: "merge", auto: false })).toMatchObject({ ok: false, kind: "protected" });
  delete s.mergeError;
  fake.setState(s);
  expect(await github.mergePr(cwd, url, { method: "squash", auto: true })).toEqual({ ok: true });
  expect(fake.calls().at(-1)?.args).toEqual(["pr", "merge", url, "--squash", "--delete-branch", "--auto"]);
  await github.disableAutoMerge(cwd, url);
  expect(fake.state().prs[0].autoMerge).toBe(false);
  expect(await github.mergePr(cwd, url, { method: "merge", auto: false })).toEqual({ ok: true });
  expect((await github.prState(cwd, url))?.state).toBe("MERGED");
});

test("a missing gh is a CodeHostError of kind missing", async () => {
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    await expect(github.findPr(cwd, "x")).rejects.toBeInstanceOf(CodeHostError);
    expect((await github.available(cwd)).ok).toBe(false);
  } finally {
    process.env.PATH = path;
  }
});
