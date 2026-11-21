import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSnapshot } from "../src/shared/types.ts";
import { type ChildServer, quiet, removeTempDirs, startChildServer, waitFor } from "./helpers.ts";

// A fake GitHub API in this process: the child servers reach it over http on localhost.
const calls: string[] = [];
let issues = [{ number: 1, title: "First", body: "b", state: "open", labels: [{ name: "bug" }] }];
const fakeGithub = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    calls.push(`${req.method} ${url.pathname} ${req.headers.get("authorization") ?? "-"}`);
    if (url.pathname === "/repos/o/missing/issues") return Response.json({ message: "Not Found" }, { status: 404 });
    if (url.pathname === "/repos/o/r/issues")
      return Response.json(
        issues.map((i) => ({ ...i, html_url: `https://github.com/o/r/issues/${i.number}`, updated_at: "2026-01-01T00:00:00Z" })),
      );
    return Response.json({});
  },
});
const base = `http://127.0.0.1:${fakeGithub.port}`;

let idle: ChildServer;
let agents: ChildServer;

beforeAll(async () => {
  idle = await startChildServer({ agents: false });
  agents = await startChildServer({ agents: true });
});
afterAll(async () => {
  await idle.stop();
  await agents.stop();
  fakeGithub.stop(true);
  removeTempDirs();
});

const snap = async (s: ChildServer, d: string) =>
  (await (await s.call(`/api/project?project=${encodeURIComponent(d)}`)).json()) as ProjectSnapshot;

async function openProject(s: ChildServer, board?: unknown): Promise<string> {
  const d = mkdtempSync(join(s.tmp, "proj-"));
  if (board) writeFileSync(join(d, "nightshift.json"), JSON.stringify(board));
  expect((await s.call("/api/projects/open", { body: { path: d } })).status).toBe(200);
  return d;
}

const source = { provider: "github", baseUrl: base, repo: "o/r", enabled: true };

test("api-sources-roundtrip", async () => {
  const d = await openProject(idle);
  const r = await idle.call("/api/issue-sources", { method: "PUT", body: { project: d, sources: [source] } });
  expect(r.status).toBe(200);
  const s1 = (await r.json()) as ProjectSnapshot;
  const src = s1.board.issueSources?.[0];
  expect(src?.repo).toBe("o/r");
  expect(s1.issueSources?.[src?.id as string]?.hasToken).toBe(false);

  const t = await idle.call("/api/issue-tokens", {
    method: "PUT",
    body: { provider: "github", baseUrl: base, token: "very-secret-token" },
  });
  expect(await t.json()).toEqual({ ok: true });
  const s2 = await snap(idle, d);
  expect(s2.issueSources?.[src?.id as string]?.hasToken).toBe(true);
  expect(JSON.stringify(s2)).not.toContain("very-secret-token");
  expect(readFileSync(join(d, "nightshift.json"), "utf8")).not.toContain("very-secret-token");
  const settings = await (await idle.call("/api/settings")).text();
  expect(settings).not.toContain("very-secret-token");

  // Imported ids survive an edit of the labels, and are reset by a repo change.
  const raw = JSON.parse(readFileSync(join(d, "nightshift.json"), "utf8"));
  raw.issueSources[0].importedIds = ["1"];
  writeFileSync(join(d, "nightshift.json"), JSON.stringify(raw));
  await waitFor(async () => (await snap(idle, d)).board.issueSources?.[0]?.importedIds.length === 1);
  const kept = (await (
    await idle.call("/api/issue-sources", { method: "PUT", body: { project: d, sources: [{ ...source, id: src?.id, labels: ["bug"] }] } })
  ).json()) as ProjectSnapshot;
  expect(kept.board.issueSources?.[0]?.importedIds).toEqual(["1"]);
  const reset = (await (
    await idle.call("/api/issue-sources", { method: "PUT", body: { project: d, sources: [{ ...source, id: src?.id, repo: "o/other" }] } })
  ).json()) as ProjectSnapshot;
  expect(reset.board.issueSources?.[0]?.id).toBe(src?.id as string);
  expect(reset.board.issueSources?.[0]?.importedIds).toEqual([]);

  const bad = await idle.call("/api/issue-sources", { method: "PUT", body: { project: d, sources: [{ ...source, repo: "norepo" }] } });
  expect(bad.status).toBe(400);
  const gitea = await idle.call("/api/issue-sources", {
    method: "PUT",
    body: { project: d, sources: [{ provider: "gitea", repo: "a/b" }] },
  });
  expect(gitea.status).toBe(400);
  const none = (await (
    await idle.call("/api/issue-sources", { method: "PUT", body: { project: d, sources: [] } })
  ).json()) as ProjectSnapshot;
  expect(none.board.issueSources).toBeUndefined();
  expect(none.issueSources).toBeUndefined();
  await idle.call("/api/issue-tokens", { method: "PUT", body: { provider: "github", baseUrl: base, token: "" } });
});

test("api-test-connection", async () => {
  const d = await openProject(idle);
  const ok = await idle.call("/api/issue-sources/test", { body: { project: d, source: { ...source, labels: ["bug"] }, token: "t1" } });
  expect(await ok.json()).toEqual({ count: 1 });
  expect(calls.at(-1)).toBe("GET /repos/o/r/issues Bearer t1");
  const missing = await idle.call("/api/issue-sources/test", { body: { project: d, source: { ...source, repo: "o/missing" } } });
  expect(missing.status).toBe(400);
  expect(((await missing.json()) as { error: string }).error).toContain("not found");
});

test("api-no-agents-never-syncs", async () => {
  const before = calls.length;
  const d = await openProject(idle, {
    version: 1,
    name: "b",
    columns: [],
    cards: [
      {
        id: "card_done",
        number: 1,
        title: "done",
        columnId: "col_done",
        external: { sourceId: "src_a", provider: "github", repo: "o/r", externalId: "1", number: 1, url: "u", updatedAt: "t" },
      },
    ],
    nextCardNumber: 2,
    issueSources: [{ id: "src_a", ...source, importedIds: [] }],
  });
  const sync = await idle.call("/api/issue-sources/sync", { body: { project: d } });
  expect(sync.status).toBe(409);
  await quiet();
  expect(calls.length).toBe(before);
  const s = await snap(idle, d);
  expect(s.board.cards.length).toBe(1);
  expect(s.board.cards[0]?.external?.writeBack).toBeUndefined();
});

test("api-agents-imports-on-open-and-sync-now", async () => {
  issues = [{ number: 1, title: "First", body: "b", state: "open", labels: [] }];
  const d = await openProject(agents, {
    version: 1,
    name: "b",
    columns: [],
    cards: [],
    nextCardNumber: 1,
    issueSources: [{ id: "src_a", ...source, importedIds: [] }],
  });
  await waitFor(async () => (await snap(agents, d)).board.cards.length === 1);
  const card = (await snap(agents, d)).board.cards[0];
  expect(card?.columnId).toBe("col_backlog");
  expect(card?.external?.number).toBe(1);
  issues = [...issues, { number: 2, title: "Second", body: "", state: "open", labels: [] }];
  const r = (await (await agents.call("/api/issue-sources/sync", { body: { project: d, sourceId: "src_a" } })).json()) as ProjectSnapshot;
  expect(r.board.cards.map((c) => c.title)).toEqual(["First", "Second"]);
  expect(r.board.cards[1]?.description).toBe(`Source: https://github.com/o/r/issues/2`);
  expect(r.issueSources?.src_a?.lastSyncAt).toBeString();
});

test("api-query-validation-and-change", async () => {
  const seeded = {
    columns: [],
    cards: [],
    issueSources: [{ id: "src_q", provider: "github", baseUrl: base, repo: "o/r", enabled: true, importedIds: ["1"], query: "is:issue" }],
  };
  const d = await openProject(idle, seeded);
  const put = (sources: unknown[]) => idle.call("/api/issue-sources", { method: "PUT", body: { project: d, sources } });
  expect((await put([{ ...source, query: 5 }])).status).toBe(400);
  expect((await put([{ ...source, query: "x".repeat(257) }])).status).toBe(400);
  const kept = (await (await put([{ ...source, id: "src_q", query: "  is:issue label:x  " }])).json()) as ProjectSnapshot;
  expect(kept.board.issueSources?.[0]?.importedIds).toEqual(["1"]);
  expect(kept.board.issueSources?.[0]?.query).toBe("is:issue label:x");
  const gt = (await (
    await put([{ provider: "gitea", baseUrl: "https://g.example.com", repo: "a/b", query: "x" }])
  ).json()) as ProjectSnapshot;
  expect(gt.board.issueSources?.[0]).not.toHaveProperty("query");
  await put([]);
});

test("api-resync", async () => {
  issues = [{ number: 1, title: "First", body: "b", state: "open", labels: [{ name: "bug" }] }];
  const board = {
    version: 1,
    name: "b",
    columns: [],
    cards: [],
    nextCardNumber: 1,
    issueSources: [{ id: "src_r", ...source, importedIds: [] }],
  };
  const resync = (s: ChildServer, d: string, body: Record<string, unknown>) =>
    s.call("/api/issue-sources/sync", { body: { project: d, ...body } });

  const idleDir = await openProject(idle, board);
  expect((await resync(idle, idleDir, { sourceId: "src_r", prune: true })).status).toBe(409);

  const d = await openProject(agents, board);
  await waitFor(async () => (await snap(agents, d)).board.cards.length === 1);
  expect((await resync(agents, d, { prune: true })).status).toBe(400);
  expect((await resync(agents, d, { sourceId: "src_r", prune: "yes" })).status).toBe(400);
  expect((await resync(agents, d, { sourceId: "nope", prune: true })).status).toBe(404);

  // The filter now excludes #1: a normal sync keeps its card, a resync deletes it.
  await agents.call("/api/issue-sources", { method: "PUT", body: { project: d, sources: [{ ...source, id: "src_r", labels: ["ui"] }] } });
  const kept = (await (await resync(agents, d, { sourceId: "src_r" })).json()) as ProjectSnapshot;
  expect(kept.board.cards.length).toBe(1);
  const r = await resync(agents, d, { sourceId: "src_r", prune: true });
  expect(r.status).toBe(200);
  const s = (await r.json()) as ProjectSnapshot;
  expect(s.board.cards.length).toBe(0);
  expect(s.board.issueSources?.[0]?.importedIds).toEqual([]);
});
