import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Project } from "../src/server/store.ts";
import {
  BACKLOG_COLUMN_ID,
  type Board,
  type Column,
  DONE_COLUMN_ID,
  ensureBacklogColumn,
  ensureSystemColumns,
} from "../src/shared/types.ts";
import { type ChildServer, removeTempDirs, startChildServer, tempDir } from "./helpers.ts";

const PAST = new Date("2020-01-01T00:00:00Z");
const BACKLOG = { id: "col_backlog", name: "Backlog", type: "inert" };
const DONE = { id: "col_done", name: "Done", type: "inert" };

const write = (dir: string, board: object) => {
  const file = join(dir, "nightshift.json");
  writeFileSync(file, `${JSON.stringify({ version: 1, name: "t", nextCardNumber: 10, ...board }, null, 2)}\n`);
  return file;
};
const load = (dir: string): Board => {
  const p = new Project(dir);
  p.close();
  return JSON.parse(readFileSync(join(dir, "nightshift.json"), "utf8"));
};
const card = (id: string, columnId: string, extra: object = {}) => ({
  id,
  number: Number(id.replace(/\D/g, "")) || 1,
  title: id,
  description: "",
  columnId,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  enteredColumnAt: "2026-01-01T00:00:00.000Z",
  history: [],
  ...extra,
});

test("ensure-backlog-contract: pure rules", () => {
  const skill: Column = { id: "s", name: "S", type: "skill", skill: "x" };
  const inert: Column = { id: "i", name: "I", type: "inert", emoji: "📥" };
  expect(ensureBacklogColumn([])).toEqual({ columns: [BACKLOG] });
  expect(ensureBacklogColumn([skill])).toEqual({ columns: [BACKLOG, skill] });
  expect(ensureBacklogColumn([inert, skill])).toEqual({ columns: [{ ...BACKLOG, emoji: "📥" }, skill], renamedFrom: "i" });
  const dupes = ensureBacklogColumn([skill, { ...BACKLOG, name: "first" }, { ...BACKLOG, name: "second" }]);
  expect(dupes.columns.map((c) => c.id)).toEqual([BACKLOG_COLUMN_ID, "s"]);
  expect(dupes.renamedFrom).toBeUndefined();
  const sys = ensureSystemColumns([skill]);
  expect(sys.columns.map((c) => c.id)).toEqual([BACKLOG_COLUMN_ID, "s", DONE_COLUMN_ID]);
  expect(ensureSystemColumns(sys.columns).columns).toEqual(sys.columns);
  expect(ensureSystemColumns([DONE as Column]).columns).toEqual([BACKLOG, DONE]);
});

test("ensure-backlog-fresh: new project has Backlog first, Done last, and is not rewritten", () => {
  const dir = tempDir("ns-bl-fresh-");
  const p = new Project(dir);
  p.close();
  const file = join(dir, "nightshift.json");
  const disk = JSON.parse(readFileSync(file, "utf8"));
  expect(disk.columns[0]).toEqual(BACKLOG);
  expect(disk.columns.at(-1).id).toBe(DONE_COLUMN_ID);
  expect(disk.columns.filter((c: Column) => c.id === BACKLOG_COLUMN_ID)).toHaveLength(1);
  const text = readFileSync(file, "utf8");
  utimesSync(file, PAST, PAST);
  const mtime = statSync(file).mtimeMs;
  new Project(dir).close();
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(statSync(file).mtimeMs).toBe(mtime);
});

function inertFirstBoard() {
  return {
    columns: [{ id: "col_abc", name: "Inbox", type: "inert", emoji: "📥" }, { id: "col_x", name: "X", type: "skill", skill: "s" }, DONE],
    cards: [
      card("c1", "col_abc", {
        history: [
          { at: "2026-01-01T00:00:00.000Z", kind: "created", text: "Created", columnId: "col_abc" },
          { at: "2026-01-01T00:00:01.000Z", kind: "moved", text: "Moved", columnId: "col_x" },
        ],
        timeBase: {
          totals: [{ columnId: "col_abc", columnName: "Inbox", part: "inert", ms: 5 }],
          cursor: { at: "2026-01-01T00:00:00.000Z", columnId: "col_abc", columnName: "Inbox", part: "inert" },
        },
        lastRun: { columnId: "col_abc", status: "success", at: "2026-01-01T00:00:02.000Z" },
        pendingAnswer: { columnId: "col_abc", text: "t", sessionId: "s", at: "2026-01-01T00:00:03.000Z" },
      }),
      card("c2", "col_abc"),
      card("c3", "col_x", { skipColumnIds: ["col_abc", "col_x"] }),
    ],
  };
}

test("migrate-inert-first: first inert column becomes the Backlog and its cards follow", () => {
  const dir = tempDir("ns-bl-inert-");
  const file = write(dir, inertFirstBoard());
  utimesSync(file, PAST, PAST);
  const before = readFileSync(file, "utf8");
  const b = load(dir);
  expect(b.columns[0]).toEqual({ id: "col_backlog", name: "Backlog", type: "inert", emoji: "📥" });
  expect(b.columns.map((c) => c.id)).toEqual(["col_backlog", "col_x", "col_done"]);
  const [c1, c2, c3] = b.cards;
  expect(c1.columnId).toBe("col_backlog");
  expect(c2.columnId).toBe("col_backlog");
  expect(c1.history.map((h) => h.columnId)).toEqual(["col_backlog", "col_x"]);
  expect(c1.timeBase?.totals[0].columnId).toBe("col_backlog");
  expect(c1.timeBase?.cursor?.columnId).toBe("col_backlog");
  expect(c1.lastRun?.columnId).toBe("col_backlog");
  expect(c1.pendingAnswer?.columnId).toBe("col_backlog");
  expect(c3.columnId).toBe("col_x");
  // The skip list keeps its entry, rewritten (the Backlog is a valid skip target, unlike Done).
  expect(c3.skipColumnIds).toEqual(["col_backlog", "col_x"]);
  // Written once: the file changed, and a reopen does not touch it again.
  const after = readFileSync(file, "utf8");
  expect(after).not.toBe(before);
  expect(statSync(file).mtimeMs).not.toBe(PAST.getTime());
  utimesSync(file, PAST, PAST);
  load(dir);
  expect(readFileSync(file, "utf8")).toBe(after);
  expect(statSync(file).mtimeMs).toBe(PAST.getTime());
});

test("migrate-skill-first: a fresh empty Backlog is inserted, other ids are kept", () => {
  const dir = tempDir("ns-bl-skill-");
  write(dir, {
    columns: [{ id: "col_s", name: "S", type: "skill", skill: "s" }, { id: "col_i", name: "I", type: "inert" }, DONE],
    cards: [card("c1", "col_s"), card("c2", "col_i")],
  });
  const b = load(dir);
  expect(b.columns.map((c) => c.id)).toEqual(["col_backlog", "col_s", "col_i", "col_done"]);
  expect(b.columns[0]).toEqual(BACKLOG as Column);
  expect(b.cards.map((c) => c.columnId)).toEqual(["col_s", "col_i"]);
});

test("migrate-misplaced: col_backlog in third position moves first, nothing else changes", () => {
  const dir = tempDir("ns-bl-misplaced-");
  write(dir, {
    columns: [
      { id: "col_a", name: "A", type: "inert" },
      { id: "col_b", name: "B", type: "skill", skill: "s" },
      { id: "col_backlog", name: "Todo", type: "skill", skill: "s" },
      DONE,
    ],
    cards: [card("c1", "col_a"), card("c2", "col_backlog")],
  });
  const b = load(dir);
  expect(b.columns.map((c) => c.id)).toEqual(["col_backlog", "col_a", "col_b", "col_done"]);
  expect(b.columns[0]).toEqual(BACKLOG as Column);
  expect(b.columns[1]).toEqual({ id: "col_a", name: "A", type: "inert" });
  expect(b.cards.map((c) => c.columnId)).toEqual(["col_a", "col_backlog"]);
});

test("migrate-idempotent: a migrated board on disk is not rewritten", () => {
  const dir = tempDir("ns-bl-idem-");
  const file = write(dir, inertFirstBoard());
  load(dir);
  const text = readFileSync(file, "utf8");
  utimesSync(file, PAST, PAST);
  const mtime = statSync(file).mtimeMs;
  load(dir);
  expect(readFileSync(file, "utf8")).toBe(text);
  expect(statSync(file).mtimeMs).toBe(mtime);
});

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer({ agents: false });
});
afterAll(async () => {
  await srv?.stop();
  removeTempDirs();
});

async function openProject() {
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  const snap = await srv.call("/api/projects/open", { body: { path: dir } }).then((r) => r.json());
  return { dir, snap };
}
const put = (dir: string, columns: object[]) => srv.call("/api/board", { method: "PUT", body: { project: dir, columns } });

test("put-board-forces-backlog: renamed, typed or moved Backlog comes back canonical", async () => {
  const { dir } = await openProject();
  const mid = { id: "col_m", name: "Mid", type: "inert" };
  const variants: object[][] = [
    [{ id: "col_backlog", name: "Todo", type: "inert" }, mid],
    [{ id: "col_backlog", name: "Backlog", type: "skill", skill: "s", instructions: "i", model: "opus", maxParallel: 3 }, mid],
    [mid, { id: "col_backlog", name: "Backlog", type: "inert" }, { id: "col_z", name: "Z", type: "inert" }],
  ];
  for (const columns of variants) {
    const res = await put(dir, columns);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.board.columns[0]).toEqual(BACKLOG);
    expect(body.board.columns.filter((c: Column) => c.id === BACKLOG_COLUMN_ID)).toHaveLength(1);
    expect(body.board.columns.at(-1).id).toBe(DONE_COLUMN_ID);
    const disk = JSON.parse(readFileSync(join(dir, "nightshift.json"), "utf8"));
    expect(disk.columns[0]).toEqual(BACKLOG);
  }
});

test("put-board-old-client: first inert column without col_backlog becomes it; an omitted Backlog keeps its cards, other removed columns holding cards are refused", async () => {
  const { dir } = await openProject();
  // Old client, no cards in the inert first column: it is renamed into the Backlog.
  const first = await put(dir, [
    { id: "col_old", name: "Inbox", type: "inert" },
    { id: "col_s", name: "S", type: "skill", skill: "s" },
  ]);
  expect(first.status).toBe(200);
  const cols = (await first.json()).board.columns as Column[];
  expect(cols.map((c) => c.id)).toEqual(["col_backlog", "col_s", "col_done"]);
  expect(cols[0]).toEqual(BACKLOG as Column);

  // Omitting col_backlog never orphans its cards: the system column is always rebuilt, so the cards stay in it.
  const { dir: dir2 } = await openProject();
  await put(dir2, [
    { id: "col_backlog", name: "Backlog", type: "inert" },
    { id: "col_s", name: "S", type: "skill", skill: "s" },
  ]);
  const created = await srv.call("/api/cards", { body: { project: dir2, columnId: "col_backlog", title: "held" } }).then((r) => r.json());
  const omitted = await put(dir2, [{ id: "col_s", name: "S", type: "skill", skill: "s" }]);
  expect(omitted.status).toBe(200);
  const snap = await srv.call(`/api/project?project=${encodeURIComponent(dir2)}`).then((r) => r.json());
  expect(snap.board.cards.find((c: { id: string }) => c.id === created.id).columnId).toBe("col_backlog");

  // A removed non-system column that still holds cards gets the existing orphan error.
  const { dir: dir3 } = await openProject();
  await put(dir3, [
    { id: "col_backlog", name: "Backlog", type: "inert" },
    { id: "col_s", name: "S", type: "skill", skill: "s" },
    { id: "col_k", name: "K", type: "inert" },
  ]);
  await srv.call("/api/cards", { body: { project: dir3, columnId: "col_k", title: "in k" } });
  const orphan = await put(dir3, [
    { id: "col_backlog", name: "Backlog", type: "inert" },
    { id: "col_s", name: "S", type: "skill", skill: "s" },
  ]);
  expect(orphan.status).toBe(400);
  expect((await orphan.json()).error).toContain("Column still holds cards");
});
