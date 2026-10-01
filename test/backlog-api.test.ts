import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSnapshot } from "../src/shared/types.ts";
import { type ChildServer, quiet, removeTempDirs, startChildServer } from "./helpers.ts";

let srv: ChildServer;
let idle: ChildServer;

beforeAll(async () => {
  srv = await startChildServer({ agents: false });
  idle = await startChildServer({ agents: false });
});
afterAll(async () => {
  await srv.stop();
  await idle.stop();
  removeTempDirs();
});

const post = (s: ChildServer, body: unknown) => s.call("/api/backlog", { body });
const snap = async (s: ChildServer, d: string) =>
  (await (await s.call(`/api/project?project=${encodeURIComponent(d)}`)).json()) as ProjectSnapshot;

async function openProject(s: ChildServer): Promise<string> {
  const d = mkdtempSync(join(s.tmp, "proj-"));
  expect((await s.call("/api/projects/open", { body: { path: d } })).status).toBe(200);
  return d;
}

test("api-backlog-open-project", async () => {
  const d = await openProject(srv);
  const r = await post(srv, { project: d, title: "  Fix it ", description: "details", source: "ci-bot" });
  expect(r.status).toBe(201);
  const out = (await r.json()) as { id: string; number: number; ref: string };
  expect(out.ref).toBe(`#${out.number}`);
  const card = (await snap(srv, d)).board.cards.find((c) => c.id === out.id);
  expect(card?.columnId).toBe("col_backlog");
  expect(card?.title).toBe("Fix it");
  expect(card?.description).toBe("details");
  expect(card?.history[0]?.text).toBe("Created in Backlog by ci-bot");
  const r2 = await post(srv, { project: d, title: "Plain" });
  const out2 = (await r2.json()) as { id: string };
  const c2 = (await snap(srv, d)).board.cards.find((c) => c.id === out2.id);
  expect(c2?.history[0]?.text).toBe("Created in Backlog");
});

test("api-backlog-unopened-project", async () => {
  const d = await openProject(srv);
  // A second server only knows the folder from its nightshift.json, not from a session open.
  expect((await idle.call(`/api/project?project=${encodeURIComponent(d)}`)).status).toBe(404);
  const r = await post(idle, { project: d, title: "From outside" });
  expect(r.status).toBe(201);
  const s = await snap(idle, d);
  expect(s.board.cards.some((c) => c.title === "From outside")).toBe(true);
  const settings = (await (await idle.call("/api/settings")).json()) as { recentProjects: string[] };
  expect(settings.recentProjects).toContain(d);
});

test("api-backlog-no-board", async () => {
  const empty = mkdtempSync(join(srv.tmp, "empty-"));
  expect((await post(srv, { project: empty, title: "x" })).status).toBe(404);
  expect(existsSync(join(empty, "nightshift.json"))).toBe(false);
  const missing = join(srv.tmp, "does-not-exist");
  expect((await post(srv, { project: missing, title: "x" })).status).toBe(404);
  expect(existsSync(join(missing, "nightshift.json"))).toBe(false);
  expect(existsSync(missing)).toBe(false);
});

test("api-backlog-validation", async () => {
  const d = await openProject(srv);
  const bad = [
    { project: d },
    { project: d, title: "   " },
    { project: d, title: 3 },
    { title: "x" },
    { project: 5, title: "x" },
    { project: "relative/dir", title: "x" },
    { project: "~/x", title: "x" },
    { project: d, title: "x", description: 4 },
    { project: d, title: "x", source: "a".repeat(101) },
    { project: d, title: "x", source: 7 },
    { project: d, title: "x", skipColumnIds: "col_done" },
  ];
  for (const body of bad) {
    const r = await post(srv, body);
    expect(r.status).toBe(400);
    expect(typeof ((await r.json()) as { error: unknown }).error).toBe("string");
  }
  expect((await post(srv, { project: d, title: "ok", source: ` ${"a".repeat(100)} ` })).status).toBe(201);
  const r = await post(srv, { project: d, title: "sneaky", columnId: "col_done" });
  expect(r.status).toBe(201);
  const { id } = (await r.json()) as { id: string };
  expect((await snap(srv, d)).board.cards.find((c) => c.id === id)?.columnId).toBe("col_backlog");
});

test("api-backlog-guard", async () => {
  const d = await openProject(srv);
  const body = JSON.stringify({ project: d, title: "x" });
  const evil = await fetch(`${srv.base}/api/backlog`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body,
  });
  expect(evil.status).toBe(403);
  const plain = await fetch(`${srv.base}/api/backlog`, { method: "POST", headers: { "content-type": "text/plain" }, body });
  expect(plain.status).toBe(415);
  expect((await snap(srv, d)).board.cards.length).toBe(0);
});

test("api-backlog-no-agents", async () => {
  const d = await openProject(srv);
  const r = await post(srv, { project: d, title: "quiet" });
  expect(r.status).toBe(201);
  await quiet();
  const s = await snap(srv, d);
  expect(s.board.cards.length).toBe(1);
  expect(Object.keys(s.live ?? {}).length).toBe(0);
});
