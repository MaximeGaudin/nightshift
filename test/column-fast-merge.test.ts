import { afterAll, beforeAll, expect, test } from "bun:test";

import { type ChildServer, removeTempDirs, startChildServer, tempDir } from "./helpers.ts";

const { normalizeBoard, systemColumnsChanged } = await import("../src/server/store.ts");

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer({ settings: { maxParallel: 1 } });
});
afterAll(async () => {
  await srv.stop();
  removeTempDirs();
});

const FIELDS = ["fastMerge", "fastMergeMovedBase", "fastMergeTestCommand"];

test("column fast-merge normalization", async () => {
  const proj = tempDir("ns-fastmerge-proj-");
  const post = (path: string, body: unknown, method = "POST") => srv.call(path, { method, body }).then((r) => r.json());
  await post("/api/projects/open", { path: proj });
  const res = await post(
    "/api/board",
    {
      project: proj,
      columns: [
        {
          name: "Defaults",
          type: "skill",
          skill: "nightshift-merge",
          fastMerge: true,
          fastMergeMovedBase: "test",
          fastMergeTestCommand: "  ",
        },
        { name: "Inert", type: "inert", fastMerge: false, fastMergeMovedBase: "agent", fastMergeTestCommand: "bun test" },
        {
          name: "Set",
          type: "skill",
          skill: "nightshift-merge",
          fastMerge: false,
          fastMergeMovedBase: "agent",
          fastMergeTestCommand: " bun test ",
        },
        { name: "Bad", type: "skill", skill: "nightshift-merge", fastMerge: "no", fastMergeMovedBase: "whatever", fastMergeTestCommand: 3 },
        { id: "col_done", name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  const byName = (n: string) => res.board.columns.find((c: { name: string }) => c.name === n);
  for (const name of ["Defaults", "Inert", "Bad"]) for (const f of FIELDS) expect(f in byName(name)).toBe(false);
  const set = byName("Set");
  expect(set.fastMerge).toBe(false);
  expect(set.fastMergeMovedBase).toBe("agent");
  expect(set.fastMergeTestCommand).toBe("bun test");
});

test("column fast-merge fields survive a reload unchanged", () => {
  const raw = {
    columns: [
      { id: "col_backlog", name: "Backlog", type: "inert" },
      {
        id: "m",
        name: "Merge",
        type: "skill",
        skill: "nightshift-merge",
        fastMerge: false,
        fastMergeMovedBase: "merge",
        fastMergeTestCommand: "bun run check",
      },
      { id: "col_done", name: "Done", type: "inert" },
    ],
    cards: [],
    nextCardNumber: 1,
  };
  const board = normalizeBoard(raw, "x");
  expect(board.columns[1]).toMatchObject({ fastMerge: false, fastMergeMovedBase: "merge", fastMergeTestCommand: "bun run check" });
  // Known keys: they are not copied a second time as unknown fields, and no rewrite is needed.
  expect(systemColumnsChanged(raw, board)).toBe(false);
});
