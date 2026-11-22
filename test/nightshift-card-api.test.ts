import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column, HistoryEntry } from "../src/shared/types.ts";
import { must, tempDir, waitFor } from "./helpers.ts";
import { startNightshiftServer } from "./nightshift-helpers.ts";

const { base, post, getProject, openSkillBoard, attentionBoard, argsEntries } = await startNightshiftServer();
const { DONE_COLUMN_ID } = await import("../src/shared/types.ts");

const numbers = (b: { cards: { id: string; number: number }[] }) => Object.fromEntries(b.cards.map((c) => [c.id, c.number]));

test("numbering: fresh board assigns 1,2,3 and never reuses", async () => {
  const fresh = tempDir("ns-num-");
  const snap = await post("/api/projects/open", { path: fresh });
  expect(snap.board.nextCardNumber).toBe(1);
  const ids: string[] = [];
  for (const t of ["a", "b", "c"]) ids.push((await post("/api/cards", { project: fresh, title: t })).id);
  const get = () => fetch(`${base}/api/project?project=${encodeURIComponent(fresh)}`).then((r) => r.json());
  expect(numbers((await get()).board)).toEqual({ [ids[0]]: 1, [ids[1]]: 2, [ids[2]]: 3 });
  await fetch(`${base}/api/cards/${ids[2]}?project=${encodeURIComponent(fresh)}`, { method: "DELETE" });
  const { id, number } = await post("/api/cards", { project: fresh, title: "d" });
  expect(number).toBe(4);
  const file = JSON.parse(readFileSync(join(fresh, "nightshift.json"), "utf8"));
  expect(file.cards.find((c: Card) => c.id === id).number).toBe(4);
  expect(file.cards.map((c: Card) => c.number)).toEqual([1, 2, 4]);
  expect(file.nextCardNumber).toBe(5);
});

test("screenshot: serves a linked png and rejects the rest", async () => {
  const proj = tempDir("ns-screenshot-proj-");
  const snap = await post("/api/projects/open", { path: proj });
  const backlog = snap.board.columns.find((c: { type: string }) => c.type === "inert");
  const { id } = await post("/api/cards", { project: proj, columnId: backlog.id, title: "shot" });
  const dir = join(tempDir("ns-shot-"), "nightshift-screenshots");
  mkdirSync(dir);
  const png = join(dir, "01-home.png");
  writeFileSync(
    png,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
  );
  const outside = join(tempDir("ns-outside-"), "not-a-shot.png");
  writeFileSync(outside, readFileSync(png));
  await post(`/api/cards/${id}`, { project: proj, description: `## Screenshots\n\n![Home](${png})\n![Other](${outside})` }, "PATCH");
  const q = `project=${encodeURIComponent(proj)}`;
  const ok = await fetch(`${base}/api/cards/${id}/screenshot?${q}&file=${encodeURIComponent(png)}`);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toContain("image/png");
  const rejected = await fetch(`${base}/api/cards/${id}/screenshot?${q}&file=${encodeURIComponent(outside)}`);
  expect(rejected.status).toBe(400);
});

test("done column: PUT /api/board repairs col_done and refuses a board without user columns", async () => {
  const dir = tempDir("ns-doneput-");
  const snap = await post("/api/projects/open", { path: dir });
  const [backlog] = snap.board.columns;
  const card = await post("/api/cards", { project: dir, columnId: DONE_COLUMN_ID, title: "finished" });

  const omitted = await post("/api/board", { project: dir, columns: [{ id: backlog.id, name: "Backlog", type: "inert" }] }, "PUT");
  expect(omitted.error).toBeUndefined();
  expect(omitted.board.columns.map((c: Column) => c.id)).toEqual([backlog.id, DONE_COLUMN_ID]);

  const renamed = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        { id: DONE_COLUMN_ID, name: "Shipped", type: "skill", skill: "enrich" },
        { id: backlog.id, name: "Backlog", type: "inert" },
      ],
    },
    "PUT",
  );
  expect(renamed.error).toBeUndefined();
  const last = renamed.board.columns.at(-1);
  expect(renamed.board.columns.map((c: Column) => c.id)).toEqual([backlog.id, DONE_COLUMN_ID]);
  expect(last).toEqual({ id: DONE_COLUMN_ID, name: "Done", type: "inert" });
  expect(renamed.board.cards.find((c: Card) => c.id === card.id).columnId).toBe(DONE_COLUMN_ID);

  const alone = await post("/api/board", { project: dir, columns: [{ id: DONE_COLUMN_ID, name: "Done", type: "inert" }] }, "PUT");
  expect(alone.error).toBe("A board needs at least one column");
});

test("done column: next from the last user column lands in col_done with no run and no attention", async () => {
  const b = await attentionBoard([{ name: "Work", type: "skill", skill: "enrich" }]);
  try {
    const [work] = b.cols;
    const runs = argsEntries().length;
    const { id } = await post("/api/cards", { project: b.dir, columnId: work.id, title: "go" });
    await waitFor(async () => (await b.card(id))?.columnId === DONE_COLUMN_ID && (await b.idle(id)));
    // No wait for a second run: the tick that would start it is scheduled when the job ends (start().finally) and runs
    // in a microtask before the server answers the next request; a started run would show as live, not idle.
    expect(argsEntries().length).toBe(runs + 1);
    expect(b.forCard(id)).toEqual([]);
    expect((await b.card(id)).lastRun.columnId).toBe(work.id);
  } finally {
    b.stop();
  }
});

test("pipeline writes transitions: moved, queued, started, run", async () => {
  const { dir, backlog, enrich } = await openSkillBoard("ns-trans-");
  const { id } = await post("/api/cards", { project: dir, columnId: backlog.id, title: "trans" });
  await post(`/api/cards/${id}/move`, { project: dir, columnId: enrich.id });
  await waitFor(async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === id)?.lastRun?.status === "success");
  const card = (await getProject(dir)).board.cards.find((c: Card) => c.id === id);
  const kinds = card.history.map((h: HistoryEntry) => h.kind).slice(0, 5);
  expect(kinds).toEqual(["created", "moved", "queued", "started", "run"]);
  for (const h of card.history.slice(0, 5)) {
    if (h.kind === "run") expect(h.columnId).toBeUndefined();
    else expect(h.columnId).toBe(h.kind === "created" ? backlog.id : enrich.id);
  }
});

test("queue time is due to the column limit", async () => {
  const { cardTimeSlices } = await import("../src/shared/timeline.ts");
  const { dir, enrich } = await openSkillBoard("ns-queuetime-", 1);
  await post("/api/cards", { project: dir, columnId: enrich.id, title: "q1" });
  await post("/api/cards", { project: dir, columnId: enrich.id, title: "q2" });
  await waitFor(async () => Object.keys((await getProject(dir)).live).length === 0);
  const board = (await getProject(dir)).board;
  const [c1, c2] = board.cards.filter((c: Card) => c.title.startsWith("q"));
  const run1 = c1.history.find((h: HistoryEntry) => h.kind === "run");
  const started2 = c2.history.find((h: HistoryEntry) => h.kind === "started");
  expect(started2.at >= run1.at).toBe(true);
  const slices = cardTimeSlices(c2, board.columns, Date.now());
  expect(must(slices.find((s) => s.columnId === enrich.id && s.part === "queued")).ms).toBeGreaterThan(0);
});

test("answer and retry put the card back in the queue", async () => {
  const { dir, enrich, done } = await openSkillBoard("ns-requeue-");
  const { id } = await post("/api/cards", { project: dir, columnId: enrich.id, title: "ask" });
  const card = async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === id);
  await waitFor(async () => (await card()).lastRun?.status === "question");
  await post(`/api/cards/${id}/answer`, { project: dir, answers: ["blue", ""] });
  await waitFor(async () => (await card()).columnId === done.id);
  let h = (await card()).history;
  const i = h.findIndex((e: HistoryEntry) => e.text.startsWith("Answered"));
  expect(h[i].kind).toBe("edited");
  expect(h[i + 1]).toMatchObject({ kind: "queued", columnId: enrich.id });

  const f = await post("/api/cards", { project: dir, columnId: enrich.id, title: "fail" });
  const failed = async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === f.id);
  await waitFor(async () => (await failed()).lastRun?.status === "error");
  await post(`/api/cards/${f.id}/retry`, { project: dir });
  h = (await failed()).history;
  const r = h.findIndex((e: HistoryEntry) => e.text.startsWith("Retry requested"));
  expect(h[r].kind).toBe("edited");
  expect(h[r + 1]).toMatchObject({ kind: "queued", columnId: enrich.id });
  await waitFor(async () => Object.keys((await getProject(dir)).live).length === 0);
});
