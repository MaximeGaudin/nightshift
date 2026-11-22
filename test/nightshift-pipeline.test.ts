import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "../src/shared/types.ts";
import { must, tempDir, waitFor } from "./helpers.ts";
import { startNightshiftServer } from "./nightshift-helpers.ts";

const { srv, base, home, post, openSkillBoard } = await startNightshiftServer();
const { startServer } = await import("../src/server/server.ts");

test("pipeline: skill column without maxParallel runs one card at a time, respects limit, moves them on", async () => {
  const proj = tempDir("ns-e2e-");
  const snap = await post("/api/projects/open", { path: proj });
  const backlog = snap.board.columns[0];
  const done = snap.board.columns.at(-1);
  const res = await post(
    "/api/board",
    { project: proj, columns: [backlog, { name: "Enrich", type: "skill", skill: "enrich" }, done] },
    "PUT",
  );
  const enrich = res.board.columns[1];
  for (const t of ["one", "two", "three", "fail"]) await post("/api/cards", { project: proj, columnId: enrich.id, title: t });

  let maxRunning = 0;
  await waitFor(async () => {
    const s = await fetch(`${base}/api/project?project=${encodeURIComponent(proj)}`).then((r) => r.json());
    maxRunning = Math.max(maxRunning, Object.values(s.live).filter((v) => v === "running").length);
    return Object.keys(s.live).length === 0;
  });
  // No maxParallel on the column: default 1, even though the project cap is higher.
  expect(maxRunning).toBe(1);

  const file = JSON.parse(readFileSync(join(proj, "nightshift.json"), "utf8"));
  const byTitle = Object.fromEntries(file.cards.map((c: Card) => [c.title, c]));
  for (const t of ["one ✓", "two ✓", "three ✓"]) {
    expect(byTitle[t].columnId).toBe(done.id);
    expect(byTitle[t].description).toBe("done by fake");
  }
  expect(byTitle.fail.columnId).toBe(enrich.id);
  expect(byTitle.fail.lastRun.status).toBe("error");

  // Retry re-queues the failed card.
  await post(`/api/cards/${byTitle.fail.id}/retry`, { project: proj });
  const log = await fetch(`${base}/api/cards/${byTitle.fail.id}/log?project=${encodeURIComponent(proj)}`).then((r) => r.json());
  expect(Array.isArray(log)).toBe(true);
});

test("questions: agent asks all at once, answers resume the session", async () => {
  const { dir: proj, enrich, done } = await openSkillBoard("ns-questions-");
  const { id } = await post("/api/cards", { project: proj, columnId: enrich.id, title: "ask" });
  const get = () => fetch(`${base}/api/project?project=${encodeURIComponent(proj)}`).then((r) => r.json());
  await waitFor(async () => (await get()).board.cards.find((c: Card) => c.id === id)?.lastRun?.status === "question");
  let card = (await get()).board.cards.find((c: Card) => c.id === id);
  expect(card.lastRun.questions).toEqual(["Color?", "Size?"]);
  expect(card.columnId).toBe(enrich.id);
  await post(`/api/cards/${id}/answer`, { project: proj, answers: ["blue", ""] });
  await waitFor(async () => (await get()).board.cards.find((c: Card) => c.id === id)?.columnId === done.id);
  card = (await get()).board.cards.find((c: Card) => c.id === id);
  expect(card.description).toContain("A1: blue");
  expect(card.description).toContain("A2: (no answer");
  expect(card.pendingAnswer).toBeUndefined();
});

test("startServer reuses one orchestrator per process (bun --hot safety)", () => {
  const again = startServer({ port: 0 });
  expect(again.orch).toBe(srv.orch);
  again.server.stop(true);
});

test("a project locked by another live process runs no agents", async () => {
  const { createHash } = await import("node:crypto");
  const locked = tempDir("ns-locked-");
  mkdirSync(join(home, "locks"), { recursive: true });
  const hash = createHash("sha1").update(locked).digest("hex").slice(0, 12);
  writeFileSync(join(home, "locks", `${hash}.lock`), String(process.ppid));
  const snap = await post("/api/projects/open", { path: locked });
  expect(snap.lockedBy).toBe(process.ppid);
  const res = await post("/api/board", { project: locked, columns: [{ name: "Enrich", type: "skill", skill: "enrich" }] }, "PUT");
  await post("/api/cards", { project: locked, columnId: res.board.columns[1].id, title: "x" });
  // No wait: the tick of the new card runs in a microtask before the server answers the next request, and it skips
  // projects locked by another process (Orchestrator.tick).
  const s = await fetch(`${base}/api/project?project=${encodeURIComponent(locked)}`).then((r) => r.json());
  expect(Object.values(s.live)).not.toContain("running");
  expect(s.board.cards[0].lastRun).toBeUndefined();
});

test("loop guard ignores runs before the last user action", async () => {
  const { dir: proj, enrich } = await openSkillBoard("ns-loopguard-");
  const { id } = await post("/api/cards", { project: proj, columnId: enrich.id, title: "guarded" });
  const get = async () =>
    (await fetch(`${base}/api/project?project=${encodeURIComponent(proj)}`).then((r) => r.json())).board.cards.find(
      (c: Card) => c.id === id,
    );
  await waitFor(async () => (await get()).columnId !== enrich.id);
  // Simulate a burst of stale runs, then move the card back by hand: it must run again.
  srv.orch.get(proj).mutate(() => {
    const card = must(srv.orch.get(proj).card(id), "the card");
    for (let i = 0; i < 20; i++) srv.orch.get(proj).addHistory(card, "run", "Enrich: stale");
  });
  // The user move must be strictly later than the stale runs (same-millisecond entries count as recent).
  const stamp = Date.now();
  while (Date.now() === stamp); // the next millisecond
  await post(`/api/cards/${id}/move`, { project: proj, columnId: enrich.id });
  await waitFor(async () => (await get()).columnId !== enrich.id);
  expect((await get()).lastRun?.error).toBeUndefined();
}, 20000);
