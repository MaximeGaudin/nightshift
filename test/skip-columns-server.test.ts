import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFeedbackPrompt, buildPrompt } from "../src/server/orchestrator.ts";
import type { Board, Card, Column } from "../src/shared/types.ts";
import { type ChildServer, must, removeTempDirs, startChildServer, tempDir, waitFor } from "./helpers.ts";

// The board of the spec: Backlog, Grill, Plan, Implement, Review, To Test (inert), Merge, Done.
const ids = {
  backlog: "col_backlog",
  review: "col_0fc8f00a6b",
  toTest: "col_2e5738f5a3",
  merge: "col_f95bc1734d",
};
const columns: Column[] = [
  { id: ids.backlog, name: "Backlog", type: "inert" },
  { id: "col_49f412ad26", name: "Grill", type: "skill", skill: "enrich" },
  { id: "col_fd6f5dbde7", name: "Plan", type: "skill", skill: "enrich" },
  { id: "col_dae4813644", name: "Implement", type: "skill", skill: "enrich" },
  { id: ids.review, name: "Review", type: "skill", skill: "enrich" },
  { id: ids.toTest, name: "To Test", type: "inert" },
  { id: ids.merge, name: "Merge", type: "skill", skill: "enrich" },
  { id: "col_done", name: "Done", type: "inert" },
];

// Stand-in for `claude`: a card titled "to=<value>" returns move <value>.
const tmp = tempDir("ns-skip-");
const fake = join(tmp, "fake-claude.ts");
writeFileSync(
  fake,
  `#!/usr/bin/env bun
const prompt = await new Response(Bun.stdin.stream()).text();
const title = prompt.match(/<title>([\\s\\S]*?)<\\/title>/)?.[1] ?? "";
const e = (o) => console.log(JSON.stringify(o));
e({ type: "system", subtype: "init", session_id: "s", model: "fake" });
e({ type: "result", is_error: false, session_id: "s", structured_output: { move: title.replace(/^to=/, ""), summary: "ok" } });
`,
);
chmodSync(fake, 0o755);

let idle: ChildServer;
let live: ChildServer;
let dir = "";
let liveDir = "";
const q = (d: string) => `project=${encodeURIComponent(d)}`;

async function open(srv: ChildServer): Promise<string> {
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
  const d = mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: d } })).status).toBe(200);
  const r = await srv.call("/api/board", { method: "PUT", body: { project: d, columns } });
  expect(r.status).toBe(200);
  return d;
}

beforeAll(async () => {
  idle = await startChildServer({ agents: false });
  dir = await open(idle);
  live = await startChildServer({ agents: true, settings: { claudePath: fake } });
  liveDir = await open(live);
});
afterAll(async () => {
  await idle?.stop();
  await live?.stop();
  removeTempDirs();
});

const snapshot = (srv: ChildServer, d: string) => srv.call(`/api/project?${q(d)}`).then((r) => r.json());
const find = async (srv: ChildServer, d: string, id: string): Promise<Card> =>
  must(
    (await snapshot(srv, d)).board.cards.find((c: Card) => c.id === id),
    "card",
  );
const create = async (body: object) => {
  const r = await idle.call("/api/cards", { body: { project: dir, columnId: ids.backlog, ...body } });
  return { status: r.status, body: await r.json() };
};
const patch = (id: string, body: object) => idle.call(`/api/cards/${id}`, { method: "PATCH", body: { project: dir, ...body } });
const texts = (c: Card) => c.history.filter((h) => h.kind === "edited").map((h) => h.text);

test("skip-create filters Done and unknown ids, refuses a non-array", async () => {
  const ok = await create({ title: "a", skipColumnIds: ["col_done", ids.toTest, "col_gone"] });
  expect(ok.status).toBe(200);
  expect((await find(idle, dir, ok.body.id)).skipColumnIds).toEqual([ids.toTest]);

  for (const bad of ["x", 3, { a: 1 }, [1], ["a", null]]) {
    const r = await create({ title: "bad", skipColumnIds: bad });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("skipColumnIds must be an array of strings");
  }
  const none = await create({ title: "none" });
  expect(Object.hasOwn(await find(idle, dir, none.body.id), "skipColumnIds")).toBe(false);
  const empty = await create({ title: "empty", skipColumnIds: [] });
  expect(Object.hasOwn(await find(idle, dir, empty.body.id), "skipColumnIds")).toBe(false);
});

test("skip-patch history entries follow what changed", async () => {
  const { body } = await create({ title: "p" });
  const id = body.id as string;

  expect((await patch(id, { skipColumnIds: [ids.merge, ids.toTest] })).status).toBe(200);
  let card = await find(idle, dir, id);
  expect(card.skipColumnIds).toEqual([ids.toTest, ids.merge]);
  expect(texts(card)).toEqual(["Skipped columns: To Test, Merge"]);
  const entered = card.enteredColumnAt;

  // Same value: no new entry.
  await patch(id, { skipColumnIds: [ids.toTest, ids.merge] });
  expect(texts(await find(idle, dir, id))).toEqual(["Skipped columns: To Test, Merge"]);

  // Title only: the usual entry, no skip entry, skip untouched.
  await patch(id, { title: "renamed" });
  card = await find(idle, dir, id);
  expect(card.skipColumnIds).toEqual([ids.toTest, ids.merge]);
  expect(texts(card)).toEqual(["Skipped columns: To Test, Merge", "Edited by user"]);

  // Both: two entries.
  await patch(id, { description: "d", skipColumnIds: [ids.toTest] });
  expect(texts(await find(idle, dir, id)).slice(2)).toEqual(["Edited by user", "Skipped columns: To Test"]);

  // [] clears the field.
  await patch(id, { skipColumnIds: [] });
  card = await find(idle, dir, id);
  expect(Object.hasOwn(card, "skipColumnIds")).toBe(false);
  expect(texts(card).at(-1)).toBe("Skipped columns cleared");
  expect(card.enteredColumnAt).toBe(entered);

  const bad = await patch(id, { skipColumnIds: "x" });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBe("skipColumnIds must be an array of strings");
});

test("skip-agent next from Review skips To Test and queues the card in Merge", async () => {
  const made = await live.call("/api/cards", {
    body: { project: liveDir, columnId: ids.review, title: "to=next", skipColumnIds: [ids.toTest] },
  });
  const id = (await made.json()).id as string;
  await waitFor(async () => (await find(live, liveDir, id)).history.some((h) => h.kind === "queued" && h.text === "Queued in Merge"));
  const card = await find(live, liveDir, id);
  expect(card.history.some((h) => h.kind === "moved" && h.text.includes("Review → Merge"))).toBe(true);
  expect(card.history.some((h) => h.text.includes("To Test"))).toBe(false);
});

test("skip-agent explicit column name or id to a skipped column is respected", async () => {
  for (const move of ["To Test", ids.toTest]) {
    const made = await live.call("/api/cards", {
      body: { project: liveDir, columnId: ids.review, title: `to=${move}`, skipColumnIds: [ids.toTest] },
    });
    const id = (await made.json()).id as string;
    await waitFor(async () => (await find(live, liveDir, id)).columnId === ids.toTest);
  }
});

test("skip-prompts name the effective next column", () => {
  const board = { version: 1, name: "t", columns, cards: [], nextCardNumber: 2 } as Board;
  const review = must(columns.find((c) => c.id === ids.review));
  const card = (skipColumnIds?: string[]): Card =>
    ({
      id: "k",
      number: 1,
      title: "t",
      description: "",
      columnId: ids.review,
      history: [],
      pendingAnswer: { text: "fb", sessionId: "s", at: "x" },
      ...(skipColumnIds ? { skipColumnIds } : {}),
    }) as unknown as Card;

  const skipping = card([ids.toTest]);
  expect(buildPrompt(board, skipping, review, undefined)).toContain('"next" to send the card to "Merge"');
  expect(buildFeedbackPrompt(board, skipping, review, "enrich", undefined)).toContain('sends it to "Merge"');
  expect(buildPrompt(board, card(), review, undefined)).toContain('"next" to send the card to "To Test"');
  expect(buildFeedbackPrompt(board, card(), review, "enrich", undefined)).toContain('sends it to "To Test"');

  // Done has no next column, whatever the skip list says.
  const done = must(columns.find((c) => c.id === "col_done"));
  expect(buildPrompt(board, skipping, done, undefined)).toContain("there is no next column");
});

test("skip-board removing a column cleans the cards without history", async () => {
  const d = await open(idle);
  const made = await idle.call("/api/cards", {
    body: { project: d, columnId: ids.backlog, title: "c", skipColumnIds: [ids.toTest, ids.merge] },
  });
  const id = (await made.json()).id as string;
  const before = await find(idle, d, id);

  const without = columns.filter((c) => c.id !== ids.toTest);
  const r = await idle.call("/api/board", { method: "PUT", body: { project: d, columns: without } });
  expect(r.status).toBe(200);
  const card = await find(idle, d, id);
  expect(card.skipColumnIds).toEqual([ids.merge]);
  expect(card.history).toHaveLength(before.history.length);

  // Dropping the last skipped column removes the field.
  const none = await idle.call("/api/board", { method: "PUT", body: { project: d, columns: without.filter((c) => c.id !== ids.merge) } });
  expect(none.status).toBe(200);
  expect(Object.hasOwn(await find(idle, d, id), "skipColumnIds")).toBe(false);
});

test("skip-board with To Test removed, an agent next from Review goes to the remaining column", async () => {
  const d = await open(live);
  const without = columns.filter((c) => c.id !== ids.toTest);
  expect((await live.call("/api/board", { method: "PUT", body: { project: d, columns: without } })).status).toBe(200);
  const made = await live.call("/api/cards", { body: { project: d, columnId: ids.review, title: "to=next" } });
  const id = (await made.json()).id as string;
  await waitFor(async () => (await find(live, d, id)).history.some((h) => h.kind === "moved" && h.text.includes("Review → Merge")));
});

test("skip-drag into a skipped column lands there and is queued", async () => {
  const { body } = await create({ title: "drag", skipColumnIds: [ids.merge] });
  const r = await idle.call(`/api/cards/${body.id}/move`, { body: { project: dir, columnId: ids.merge } });
  expect(r.status).toBe(200);
  const card = await find(idle, dir, body.id);
  expect(card.columnId).toBe(ids.merge);
  expect(card.history.some((h) => h.kind === "queued" && h.text === "Queued in Merge")).toBe(true);
});
