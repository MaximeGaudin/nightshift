// PR status poller: CI state of each card's pull request, in memory, display only.
import { beforeEach, expect, spyOn, test } from "bun:test";
import type { CodeHost, PrInfo } from "../src/server/codehost/codehost.ts";
import type { PrMode } from "../src/server/prMode.ts";
import { PrStatusPoller } from "../src/server/prStatus.ts";
import type { Project } from "../src/server/store.ts";
import { DONE_COLUMN_ID } from "../src/shared/types.ts";

const urlA = "https://github.com/o/r/pull/1";
const urlB = "https://github.com/o/r/pull/2";
const note = (url?: string) => (url ? `## Review\n\n- PR: ${url}\n` : "just a note");

let hostState: { pr: Record<string, PrInfo["state"]>; mergeable: Record<string, PrInfo["mergeable"]>; checks: Record<string, Awaited<ReturnType<CodeHost["checks"]>>>; throws: boolean };
let calls: { prState: number; checks: number; all: (boolean | undefined)[] };
let cards: { id: string; columnId: string; description: string }[];
let changes: number;
let now: number;
let active: boolean;

const host: CodeHost = {
  prState: async (_cwd, url) => {
    calls.prState++;
    if (hostState.throws) throw new Error("boom");
    return { url, number: 1, state: hostState.pr[url] ?? "OPEN", body: "", mergeable: hostState.mergeable[url] ?? "UNKNOWN", baseRefName: "main", isDraft: false };
  },
  checks: async (_cwd, url, opts) => {
    calls.checks++;
    calls.all.push(opts?.all);
    return hostState.checks[url] ?? { state: "none", failed: [] };
  },
} as unknown as CodeHost;

const project = {
  path: "/p",
  get board() {
    return { cards };
  },
  card: (id: string) => cards.find((c) => c.id === id),
} as unknown as Project;

const poller = () =>
  new PrStatusPoller(
    {
      detect: async () =>
        active
          ? ({ active: true, hostId: "github", host, mergeMethod: "merge", autoMerge: false } as PrMode)
          : { active: false, reason: "off" },
      onChange: () => {
        changes++;
      },
    },
    60_000,
    () => now,
  );

beforeEach(() => {
  hostState = { pr: {}, mergeable: {}, checks: {}, throws: false };
  calls = { prState: 0, checks: 0, all: [] };
  cards = [{ id: "c1", columnId: "col_x", description: note(urlA) }];
  changes = 0;
  now = Date.parse("2026-01-01T00:00:00Z");
  active = true;
  spyOn(console, "error").mockImplementation(() => {});
});

test("poller records states with the PR url and fires onChange once", async () => {
  const link = "https://github.com/o/r/actions/runs/1/job/1";
  cards.push({ id: "c2", columnId: "col_x", description: note(urlB) });
  hostState.checks[urlA] = { state: "pass", failed: [] };
  hostState.checks[urlB] = { state: "fail", failed: [{ name: "lint", link }] };
  const p = poller();
  await p.pass(project);
  const s = p.status(project);
  expect(s.c1).toMatchObject({ url: urlA, state: "pass", failed: [] });
  expect(s.c2).toMatchObject({ url: urlB, state: "fail", failed: [{ name: "lint", link }] });
  expect(changes).toBe(1);
  expect(calls.all.every((a) => a === true)).toBe(true);
});

test("a second pass with the same status does not fire onChange", async () => {
  hostState.checks[urlA] = { state: "pending", failed: [] };
  const p = poller();
  await p.pass(project);
  now += 120_000;
  await p.pass(project);
  expect(changes).toBe(1);
  expect(p.status(project).c1.state).toBe("pending");
  hostState.checks[urlA] = { state: "pass", failed: [] };
  await p.pass(project);
  expect(changes).toBe(2);
});

test("a merged PR stops being polled", async () => {
  hostState.pr[urlA] = "MERGED";
  const p = poller();
  await p.pass(project);
  await p.pass(project);
  expect(p.status(project).c1.state).toBe("merged");
  expect(calls.prState).toBe(1);
  expect(calls.checks).toBe(0);
});

test("Done cards and cards without a PR are never fetched", async () => {
  cards = [
    { id: "d", columnId: DONE_COLUMN_ID, description: note(urlA) },
    { id: "n", columnId: "col_x", description: note() },
  ];
  const p = poller();
  await p.pass(project);
  expect(calls.prState).toBe(0);
  expect(p.status(project)).toEqual({});
});

test("a changed PR url drops the old status and fetches the new one", async () => {
  hostState.checks[urlA] = { state: "pass", failed: [] };
  hostState.checks[urlB] = { state: "pending", failed: [] };
  const p = poller();
  await p.pass(project);
  cards[0].description = note(urlB);
  await p.pass(project);
  expect(p.status(project).c1).toMatchObject({ url: urlB, state: "pending" });
});

test("one failed fetch keeps the status, a second drops it", async () => {
  hostState.checks[urlA] = { state: "pass", failed: [] };
  const p = poller();
  await p.pass(project);
  hostState.throws = true;
  await p.pass(project);
  expect(p.status(project).c1.state).toBe("pass");
  await p.pass(project);
  expect(p.status(project).c1).toBeUndefined();
});

test("inactive PR mode: no host call, statuses cleared", async () => {
  hostState.checks[urlA] = { state: "pass", failed: [] };
  const p = poller();
  await p.pass(project);
  active = false;
  await p.pass(project);
  expect(p.status(project)).toEqual({});
  const before = calls.prState;
  await p.pass(project);
  expect(calls.prState).toBe(before);
});

test("refresh fetches only a status older than 30 s", async () => {
  hostState.checks[urlA] = { state: "pass", failed: [] };
  const p = poller();
  await p.pass(project);
  const base = calls.checks;
  now += 10_000;
  expect((await p.refresh(project, "c1"))?.state).toBe("pass");
  expect(calls.checks).toBe(base);
  now += 21_000;
  await p.refresh(project, "c1");
  expect(calls.checks).toBe(base + 1);
  expect(await p.refresh(project, "unknown")).toBeNull();
});

test("CONFLICTING wins over the checks, MERGEABLE and UNKNOWN keep the checks state", async () => {
  hostState.checks[urlA] = { state: "pass", failed: [] };
  hostState.mergeable[urlA] = "CONFLICTING";
  const p = poller();
  await p.pass(project);
  expect(p.status(project).c1).toMatchObject({ state: "conflict", failed: [] });
  hostState.mergeable[urlA] = "MERGEABLE";
  await p.pass(project);
  expect(p.status(project).c1.state).toBe("pass");
  hostState.mergeable[urlA] = "UNKNOWN";
  hostState.checks[urlA] = { state: "pending", failed: [] };
  await p.pass(project);
  expect(p.status(project).c1.state).toBe("pending");
});

test("CONFLICTING also wins over failing checks, without failed checks", async () => {
  hostState.checks[urlA] = { state: "fail", failed: [{ name: "lint", link: "l" }] };
  hostState.mergeable[urlA] = "CONFLICTING";
  const p = poller();
  await p.pass(project);
  expect(p.status(project).c1).toMatchObject({ state: "conflict", failed: [] });
});

test("mergeable to conflicting with unchanged checks fires onChange, and back", async () => {
  hostState.checks[urlA] = { state: "pass", failed: [] };
  hostState.mergeable[urlA] = "MERGEABLE";
  const p = poller();
  await p.pass(project);
  expect(p.status(project).c1.state).toBe("pass");
  changes = 0;
  hostState.mergeable[urlA] = "CONFLICTING";
  await p.pass(project);
  expect(p.status(project).c1.state).toBe("conflict");
  expect(changes).toBe(1);
  hostState.mergeable[urlA] = "MERGEABLE";
  await p.pass(project);
  expect(p.status(project).c1.state).toBe("pass");
  expect(changes).toBe(2);
});
