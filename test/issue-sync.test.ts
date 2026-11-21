import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueProvider } from "../src/server/issues/provider.ts";
import { ProviderError } from "../src/server/issues/provider.ts";
import { providerFor, registerProvider } from "../src/server/issues/registry.ts";
import { IssueSync } from "../src/server/issues/sync.ts";
import { setToken } from "../src/server/issues/tokens.ts";
import { Project } from "../src/server/store.ts";
import type { ExternalIssue, IssueSource } from "../src/shared/issues.ts";
import { BACKLOG_COLUMN_ID, DONE_COLUMN_ID } from "../src/shared/types.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

afterAll(removeTempDirs);

const realGithub = providerFor("github") as IssueProvider;
const realGitea = providerFor("gitea") as IssueProvider;

/** In-memory provider: issues per repo, recorded write calls, optional failure or gate per call. */
class FakeProvider implements IssueProvider {
  issues = new Map<string, ExternalIssue[]>();
  calls: string[] = [];
  fail?: Error;
  failClose?: Error;
  gate?: Promise<void>;
  async listOpenIssues(src: IssueSource) {
    this.calls.push(`list ${src.repo}`);
    if (this.gate) await this.gate;
    if (this.fail) throw this.fail;
    return (this.issues.get(src.repo) ?? []).filter((i) => i.state === "open").map((i) => ({ ...i }));
  }
  async getIssue(src: IssueSource, _t: string | undefined, n: number) {
    this.calls.push(`get ${src.repo}#${n}`);
    return (this.issues.get(src.repo) ?? []).find((i) => i.number === n) ?? null;
  }
  async comment(src: IssueSource, token: string, n: number, text: string) {
    this.calls.push(`comment ${src.repo}#${n} ${token} ${text}`);
    if (this.gate) await this.gate;
  }
  async close(src: IssueSource, _t: string, n: number) {
    this.calls.push(`close ${src.repo}#${n}`);
    if (this.failClose) throw this.failClose;
    const i = this.issues.get(src.repo)?.find((x) => x.number === n);
    if (i) i.state = "closed";
  }
}

let fake: FakeProvider;
let fakeGitea: FakeProvider;
beforeEach(() => {
  fake = new FakeProvider();
  fakeGitea = new FakeProvider();
  registerProvider("github", fake);
  registerProvider("gitea", fakeGitea);
});
afterEach(() => {
  registerProvider("github", realGithub);
  registerProvider("gitea", realGitea);
});

const issue = (n: number, extra: Partial<ExternalIssue> = {}): ExternalIssue => ({
  externalId: String(n),
  number: n,
  title: `Issue ${n}`,
  body: `Body ${n}`,
  url: `https://github.com/o/r/issues/${n}`,
  labels: [],
  state: "open",
  updatedAt: "2026-01-01T00:00:00Z",
  ...extra,
});

function setup(sources: Partial<IssueSource>[] = [{}]) {
  const p = new Project(tempDir("ns-sync-"));
  p.mutate((b) => {
    b.issueSources = sources.map((s, i) => ({
      id: `src_${i}`,
      provider: "github",
      baseUrl: "https://api.github.com",
      repo: "o/r",
      enabled: true,
      importedIds: [],
      ...s,
    }));
  });
  const purged: string[] = [];
  const sync = new IssueSync({ canRun: () => true, onState: () => {}, purge: (_p, id) => purged.push(id) });
  return { p, sync, purged };
}

const backlog = (p: Project) => p.board.cards.filter((c) => c.columnId === BACKLOG_COLUMN_ID);
const flush = () => new Promise((r) => setTimeout(r, 5));

test("sync-imports-once", async () => {
  const { p, sync } = setup();
  fake.issues.set("o/r", [issue(3), issue(1)]);
  await sync.syncAll(p);
  const cards = backlog(p);
  expect(cards.map((c) => c.title)).toEqual(["Issue 1", "Issue 3"]);
  expect(cards[0]?.description).toBe("Body 1\n\nSource: https://github.com/o/r/issues/1");
  expect(cards[0]?.external).toEqual({
    sourceId: "src_0",
    provider: "github",
    repo: "o/r",
    externalId: "1",
    number: 1,
    url: "https://github.com/o/r/issues/1",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  expect(cards[0]?.history[0]?.text).toBe("Created in Backlog by GitHub o/r#1");
  expect(p.board.issueSources?.[0]?.importedIds).toEqual(["1", "3"]);
  // Persisted in nightshift.json.
  const disk = JSON.parse(readFileSync(join(p.path, "nightshift.json"), "utf8"));
  expect(disk.cards.length).toBe(2);

  await sync.syncAll(p);
  expect(backlog(p).length).toBe(2);
  p.mutate((b) => p.deleteCard(b, cards[0]?.id as string));
  await sync.syncAll(p);
  expect(backlog(p).map((c) => c.title)).toEqual(["Issue 3"]);
});

test("sync-label-filter", async () => {
  const { p, sync } = setup([{ labels: ["Bug"] }]);
  fake.issues.set("o/r", [issue(1, { labels: ["bug"] }), issue(2, { labels: ["feature"] })]);
  await sync.syncAll(p);
  expect(backlog(p).map((c) => c.external?.number)).toEqual([1]);
});

test("sync-upstream-edit-and-close", async () => {
  const { p, sync, purged } = setup();
  fake.issues.set("o/r", [issue(1), issue(2)]);
  await sync.syncAll(p);
  const [a, b] = backlog(p);
  // B leaves Backlog (no write-back pass is scheduled in this test).
  p.mutate((board) => p.moveCard(board, b?.id as string, DONE_COLUMN_ID));
  const bBefore = JSON.stringify(p.card(b?.id as string)?.title);
  fake.issues.set("o/r", [
    issue(1, { title: "Edited 1", body: "New body", updatedAt: "2026-02-01T00:00:00Z" }),
    issue(2, { title: "Edited 2", updatedAt: "2026-02-01T00:00:00Z" }),
  ]);
  await sync.syncAll(p);
  const a2 = p.card(a?.id as string);
  expect(a2?.title).toBe("Edited 1");
  expect(a2?.description).toBe("New body\n\nSource: https://github.com/o/r/issues/1");
  expect(a2?.history.at(-1)?.text).toBe("Updated from GitHub o/r#1");
  expect(JSON.stringify(p.card(b?.id as string)?.title)).toBe(bBefore);

  fake.issues.set("o/r", [issue(1, { state: "closed" }), issue(2, { state: "closed" })]);
  await sync.syncAll(p);
  expect(p.card(a?.id as string)).toBeUndefined();
  expect(purged).toEqual([a?.id as string]);
  expect(p.card(b?.id as string)?.title).toBe("Issue 2");
});

test("sync-failure-leaves-board", async () => {
  const { p, sync } = setup([{}, { provider: "gitea", baseUrl: "https://g.example.com", repo: "x/y" }]);
  fake.fail = new ProviderError("auth", "invalid token", 401);
  fakeGitea.issues.set("x/y", [issue(5)]);
  const before = p.board.issueSources?.[0]?.importedIds.length;
  await sync.syncAll(p);
  expect(p.board.cards.map((c) => c.external?.sourceId)).toEqual(["src_1"]);
  expect(p.board.issueSources?.[0]?.importedIds.length).toBe(before as number);
  const status = sync.status(p);
  expect(status?.src_0?.lastError).toBe("invalid token");
  expect(status?.src_0?.lastErrorAt).toBeString();
  expect(status?.src_1?.lastError).toBeUndefined();
  expect(status?.src_1?.lastSyncAt).toBeString();
});

test("sync-board-changed-during-fetch", async () => {
  const { p, sync } = setup();
  fake.issues.set("o/r", [issue(1)]);
  let release = () => {};
  fake.gate = new Promise<void>((r) => {
    release = r;
  });
  const run = sync.syncAll(p);
  await flush();
  p.mutate((b) => {
    delete b.issueSources;
  });
  release();
  await run;
  expect(p.board.cards.length).toBe(0);

  // A card moved out of Backlog during the fetch is not deleted.
  const s2 = setup();
  fake.gate = undefined;
  fake.issues.set("o/r", [issue(1)]);
  await s2.sync.syncAll(s2.p);
  const card = backlog(s2.p)[0];
  fake.issues.set("o/r", [issue(1, { state: "closed" })]);
  fake.gate = new Promise<void>((r) => {
    release = r;
  });
  const run2 = s2.sync.syncAll(s2.p);
  await flush();
  s2.p.mutate((b) => s2.p.moveCard(b, card?.id as string, "col_done"));
  release();
  await run2;
  expect(s2.p.card(card?.id as string)?.columnId).toBe("col_done");
});

test("sync-not-allowed-does-nothing", async () => {
  const p = new Project(tempDir("ns-sync-"));
  p.mutate((b) => {
    b.issueSources = [{ id: "s", provider: "github", baseUrl: "https://api.github.com", repo: "o/r", enabled: true, importedIds: [] }];
  });
  fake.issues.set("o/r", [issue(1)]);
  const sync = new IssueSync({ canRun: () => false, onState: () => {}, purge: () => {} });
  await sync.syncAll(p);
  sync.scheduleWriteBack(p);
  await flush();
  expect(p.board.cards.length).toBe(0);
  expect(fake.calls).toEqual([]);
});

test("writeback-once", async () => {
  const { p, sync } = setup();
  setToken("github", "https://api.github.com", "tok-wb");
  fake.issues.set("o/r", [issue(1)]);
  await sync.syncAll(p);
  const card = backlog(p)[0];
  let release = () => {};
  fake.gate = new Promise<void>((r) => {
    release = r;
  });
  p.mutate((b) => {
    const c = b.cards.find((x) => x.id === card?.id);
    if (c) c.lastRun = { columnId: "col_x", status: "success", at: "t", summary: "All good." };
    p.moveCard(b, card?.id as string, DONE_COLUMN_ID);
  });
  sync.scheduleWriteBack(p);
  await flush();
  // More board changes while the calls are pending start no second attempt.
  sync.scheduleWriteBack(p);
  p.mutate((b) => {
    b.name = "x";
  });
  sync.scheduleWriteBack(p);
  await flush();
  release();
  await flush();
  const comments = fake.calls.filter((c) => c.startsWith("comment"));
  expect(comments).toEqual([`comment o/r#1 tok-wb Done in Nightshift (#${card?.number}).\n\nAll good.`]);
  expect(fake.calls.filter((c) => c.startsWith("close"))).toEqual(["close o/r#1"]);
  expect(p.card(card?.id as string)?.external?.writeBack).toBe("done");
  sync.scheduleWriteBack(p);
  await flush();
  expect(fake.calls.filter((c) => c.startsWith("comment")).length).toBe(1);
  setToken("github", "https://api.github.com", "");
});

test("writeback-failure", async () => {
  const { p, sync } = setup();
  fake.issues.set("o/r", [issue(1), issue(2)]);
  await sync.syncAll(p);
  const [a, b] = backlog(p);
  // No token: failure recorded, no provider call.
  p.mutate((board) => p.moveCard(board, a?.id as string, DONE_COLUMN_ID));
  sync.scheduleWriteBack(p);
  await flush();
  const ca = p.card(a?.id as string);
  expect(ca?.columnId).toBe(DONE_COLUMN_ID);
  expect(ca?.external?.writeBack).toBe("failed");
  expect(ca?.history.at(-1)?.text).toBe("Write-back to o/r#1 failed: no token");
  expect(fake.calls.some((c) => c.startsWith("comment"))).toBe(false);
  expect(sync.status(p)?.src_0?.writeBackError).toBe("o/r#1: no token");

  // Close refused: failure recorded once, no retry.
  setToken("github", "https://api.github.com", "tok");
  fake.failClose = new ProviderError("auth", "forbidden", 403);
  p.mutate((board) => p.moveCard(board, b?.id as string, DONE_COLUMN_ID));
  sync.scheduleWriteBack(p);
  await flush();
  expect(p.card(b?.id as string)?.external?.writeBack).toBe("failed");
  expect(p.card(b?.id as string)?.history.at(-1)?.text).toBe("Write-back to o/r#2 failed: forbidden");
  sync.scheduleWriteBack(p);
  await flush();
  expect(fake.calls.filter((c) => c.startsWith("close")).length).toBe(1);
  setToken("github", "https://api.github.com", "");
});

test("writeback-skipped-for-disabled-source", async () => {
  const { p, sync } = setup();
  setToken("github", "https://api.github.com", "tok");
  fake.issues.set("o/r", [issue(1)]);
  await sync.syncAll(p);
  const card = backlog(p)[0];
  p.mutate((b) => {
    const s = b.issueSources?.[0];
    if (s) s.enabled = false;
    p.moveCard(b, card?.id as string, DONE_COLUMN_ID);
  });
  sync.scheduleWriteBack(p);
  await flush();
  expect(fake.calls.some((c) => c.startsWith("comment"))).toBe(false);
  expect(p.card(card?.id as string)?.external?.writeBack).toBeUndefined();
  setToken("github", "https://api.github.com", "");
});

test("sync-trigger-during-sync-reruns-with-new-config", async () => {
  const { p, sync } = setup();
  fake.issues.set("o/r", [issue(1, { labels: ["bug"] }), issue(2, { labels: ["ui"] })]);
  let release = () => {};
  fake.gate = new Promise<void>((r) => {
    release = r;
  });
  const first = sync.syncSource(p, "src_0");
  await flush();
  // The filter changes while the first sync runs: its plan is dropped and a follow-up sync applies the new one.
  p.mutate((b) => {
    const s = b.issueSources?.[0];
    if (s) s.labels = ["ui"];
  });
  const second = sync.syncSource(p, "src_0");
  fake.gate = undefined;
  release();
  await first;
  await second;
  expect(backlog(p).map((c) => c.external?.number)).toEqual([2]);
  expect(fake.calls.filter((c) => c.startsWith("list")).length).toBe(2);
});

test("sync-query-and-labels", async () => {
  const { p, sync } = setup([{ query: "is:issue", labels: ["bug"] }]);
  fake.issues.set("o/r", [issue(1, { labels: ["bug"] }), issue(2, { labels: ["feature"] })]);
  await sync.syncAll(p);
  expect(backlog(p).map((c) => c.external?.number)).toEqual([1]);
});

test("sync-stale-plan-query", async () => {
  const { p, sync } = setup([{ query: "is:issue" }]);
  fake.issues.set("o/r", [issue(1), issue(2)]);
  let release = () => {};
  fake.gate = new Promise<void>((r) => {
    release = r;
  });
  const first = sync.syncSource(p, "src_0");
  await flush();
  p.mutate((b) => {
    const s = b.issueSources?.[0];
    if (s) s.query = "is:issue label:x";
  });
  fake.gate = undefined;
  release();
  await first;
  expect(backlog(p).length).toBe(0);
});

// ---- resync (prune) ---------------------------------------------------------

const setLabels = (p: Project, labels: string[]) =>
  p.mutate((b) => {
    const s = b.issueSources?.[0];
    if (s) s.labels = labels;
  });

test("resync-prunes-non-matching", async () => {
  const { p, sync, purged } = setup([{ labels: ["a"] }]);
  fake.issues.set("o/r", [issue(1, { labels: ["a"] }), issue(2, { labels: ["a", "b"] }), issue(3, { labels: ["b"] })]);
  await sync.syncAll(p);
  expect(backlog(p).map((c) => c.external?.number)).toEqual([1, 2]);
  const card1 = backlog(p)[0]?.id as string;

  setLabels(p, ["b"]);
  await sync.syncSource(p, "src_0", { prune: true });
  expect(backlog(p).map((c) => c.external?.number)).toEqual([2, 3]);
  expect(purged).toEqual([card1]);
  expect(p.board.issueSources?.[0]?.importedIds).toEqual(["2", "3"]);

  // resync-reimports-after-widening
  setLabels(p, ["a"]);
  await sync.syncSource(p, "src_0", { prune: true });
  expect(backlog(p).map((c) => c.external?.number)).toEqual([2, 1]);
  expect(p.board.issueSources?.[0]?.importedIds).toEqual(["2", "1"]);
});

test("resync-keeps-hand-deleted-out", async () => {
  const { p, sync } = setup();
  fake.issues.set("o/r", [issue(1), issue(2)]);
  await sync.syncAll(p);
  p.mutate((b) => p.deleteCard(b, backlog(p)[0]?.id as string));
  await sync.syncSource(p, "src_0", { prune: true });
  expect(backlog(p).map((c) => c.external?.number)).toEqual([2]);
});

test("resync-ignores-other-columns", async () => {
  const { p, sync } = setup([{ labels: ["a"] }]);
  fake.issues.set("o/r", [issue(1, { labels: ["a"] }), issue(2, { labels: ["a"] })]);
  await sync.syncAll(p);
  const moved = backlog(p)[0]?.id as string;
  p.mutate((b) => p.moveCard(b, moved, DONE_COLUMN_ID));
  setLabels(p, ["zzz"]);
  await sync.syncSource(p, "src_0", { prune: true });
  expect(backlog(p).length).toBe(0);
  expect(p.card(moved)?.columnId).toBe(DONE_COLUMN_ID);
  expect(p.card(moved)?.external?.number).toBe(1);
});

test("sync-never-prunes", async () => {
  const { p, sync } = setup([{ labels: ["a"] }]);
  fake.issues.set("o/r", [issue(1, { labels: ["a"] })]);
  await sync.syncAll(p);
  setLabels(p, ["b"]);
  await sync.syncSource(p, "src_0");
  await sync.syncAll(p);
  expect(backlog(p).map((c) => c.external?.number)).toEqual([1]);
});

test("resync-provider-error", async () => {
  const { p, sync } = setup([{ labels: ["a"] }]);
  fake.issues.set("o/r", [issue(1, { labels: ["a"] })]);
  await sync.syncAll(p);
  const before = JSON.stringify(p.board.cards);
  setLabels(p, ["b"]);
  fake.fail = new ProviderError("auth", "invalid token", 401);
  await sync.syncSource(p, "src_0", { prune: true });
  expect(JSON.stringify(p.board.cards)).toBe(before);
  expect(p.board.issueSources?.[0]?.importedIds).toEqual(["1"]);
  expect(sync.status(p)?.src_0?.lastError).toBe("invalid token");
});

test("resync-during-sync-prunes-on-followup", async () => {
  const { p, sync } = setup([{ labels: ["bug"] }]);
  fake.issues.set("o/r", [issue(1, { labels: ["bug"] }), issue(2, { labels: ["bug"] })]);
  await sync.syncAll(p);
  // Upstream, #1 loses its label: only a resync removes its card.
  fake.issues.set("o/r", [issue(1), issue(2, { labels: ["bug"] })]);
  let release = () => {};
  fake.gate = new Promise<void>((r) => {
    release = r;
  });
  const first = sync.syncSource(p, "src_0");
  await flush();
  const second = sync.syncSource(p, "src_0", { prune: true });
  let release2 = () => {};
  fake.gate = new Promise<void>((r) => {
    release2 = r;
  });
  release();
  await first;
  // The running sync prunes nothing; the follow-up is still waiting on the provider.
  expect(backlog(p).map((c) => c.external?.number)).toEqual([1, 2]);
  release2();
  await second;
  expect(backlog(p).map((c) => c.external?.number)).toEqual([2]);

  // The request was consumed: a later normal sync does not prune.
  fake.gate = undefined;
  fake.issues.set("o/r", [issue(2)]);
  await sync.syncSource(p, "src_0");
  expect(backlog(p).map((c) => c.external?.number)).toEqual([2]);
});

test("resync-on-disabled-source-is-consumed", async () => {
  const { p, sync } = setup([{ labels: ["a"] }]);
  fake.issues.set("o/r", [issue(1, { labels: ["a"] })]);
  await sync.syncAll(p);
  p.mutate((b) => {
    const s = b.issueSources?.[0];
    if (s) {
      s.enabled = false;
      s.labels = ["b"];
    }
  });
  await sync.syncSource(p, "src_0", { prune: true });
  p.mutate((b) => {
    const s = b.issueSources?.[0];
    if (s) s.enabled = true;
  });
  await sync.syncSource(p, "src_0");
  expect(backlog(p).map((c) => c.external?.number)).toEqual([1]);
});

test("resync-after-repo-change-skips-getIssue", async () => {
  const { p, sync } = setup();
  fake.issues.set("o/r", [issue(1), issue(2)]);
  await sync.syncAll(p);
  fake.issues.set("o/other", [issue(1, { externalId: "b1", url: "https://github.com/o/other/issues/1" })]);
  p.mutate((b) => {
    const s = b.issueSources?.[0];
    if (s) {
      s.repo = "o/other";
      s.importedIds = [];
    }
  });
  fake.calls = [];
  await sync.syncSource(p, "src_0", { prune: true });
  expect(fake.calls.filter((c) => c.startsWith("get"))).toEqual([]);
  expect(backlog(p).map((c) => c.external?.externalId)).toEqual(["b1"]);
});
