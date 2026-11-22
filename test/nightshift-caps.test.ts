import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column, LogLine } from "../src/shared/types.ts";
import { tempDir, waitFor } from "./helpers.ts";
import { startNightshiftServer } from "./nightshift-helpers.ts";

const { base, post, liveRunning } = await startNightshiftServer();
const { normalizeBoard } = await import("../src/server/store.ts");

test("column maxParallel caps agents in that column", async () => {
  const p2 = tempDir("ns-colmax-");
  await post("/api/projects/open", { path: p2 });
  const res = await post(
    "/api/board",
    {
      project: p2,
      columns: [
        { name: "Merge", type: "skill", skill: "enrich", maxParallel: 1 },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  expect(res.board.columns[1].maxParallel).toBe(1);
  for (const t of ["cap1", "cap2", "cap3"]) await post("/api/cards", { project: p2, columnId: res.board.columns[1].id, title: t });
  let maxRunning = 0;
  await waitFor(async () => {
    const s = await fetch(`${base}/api/project?project=${encodeURIComponent(p2)}`).then((r) => r.json());
    maxRunning = Math.max(maxRunning, Object.values(s.live).filter((v) => v === "running").length);
    return Object.keys(s.live).length === 0;
  });
  expect(maxRunning).toBe(1);
});

test("column maxParallel > 1 runs several cards", async () => {
  const p = tempDir("ns-colpar-");
  await post("/api/projects/open", { path: p });
  const res = await post(
    "/api/board",
    {
      project: p,
      columns: [
        { name: "Work", type: "skill", skill: "enrich", maxParallel: 2 },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  expect(res.board.columns[1].maxParallel).toBe(2);
  for (const t of ["par1", "par2", "par3", "par4"]) await post("/api/cards", { project: p, columnId: res.board.columns[1].id, title: t });
  let maxRunning = 0;
  await waitFor(async () => {
    const s = await liveRunning(p);
    maxRunning = Math.max(maxRunning, s.running);
    return s.idle && s.board.cards.every((c: Card) => c.columnId === res.board.columns[2].id);
  });
  expect(maxRunning).toBe(2);
});

test("project cap cuts below the sum of column limits", async () => {
  const p = tempDir("ns-projectcap-");
  await post("/api/projects/open", { path: p });
  const res = await post(
    "/api/board",
    {
      project: p,
      maxParallel: 2,
      columns: [
        { name: "A", type: "skill", skill: "enrich", maxParallel: 2 },
        { name: "B", type: "skill", skill: "enrich", maxParallel: 2 },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  const [, a, b, done] = res.board.columns;
  for (const t of ["a1", "a2", "a3"]) await post("/api/cards", { project: p, columnId: a.id, title: t });
  for (const t of ["b1", "b2", "b3"]) await post("/api/cards", { project: p, columnId: b.id, title: t });
  let maxRunning = 0;
  await waitFor(async () => {
    const s = await liveRunning(p);
    maxRunning = Math.max(maxRunning, s.running);
    return s.idle && s.board.cards.length === 6 && s.board.cards.every((c: Card) => c.columnId === done.id);
  }, 15000);
  // Column limits sum to 4, but the project cap (2) bounds the total.
  expect(maxRunning).toBeLessThanOrEqual(2);
  expect(maxRunning).toBeGreaterThan(0);
});

test("column maxParallel normalization", async () => {
  const p = tempDir("ns-colnorm-");
  await post("/api/projects/open", { path: p });
  const cols = [
    { name: "Big", type: "skill", skill: "enrich", maxParallel: 99 },
    { name: "Empty", type: "skill", skill: "enrich", maxParallel: "" },
    { name: "Zero", type: "skill", skill: "enrich", maxParallel: 0 },
    { name: "Text", type: "skill", skill: "enrich", maxParallel: "abc" },
    { name: "Inert", type: "inert", maxParallel: 3 },
  ];
  const check = (columns: Column[]) => {
    expect(columns[1].maxParallel).toBe(32);
    for (const c of columns.slice(2)) expect("maxParallel" in c).toBe(false);
  };
  const res = await post("/api/board", { project: p, columns: cols }, "PUT");
  check(res.board.columns);
  check(normalizeBoard({ columns: cols.map((c, i) => ({ id: `c${i}`, ...c })), cards: [] }, "x").columns);
  expect(
    normalizeBoard({ columns: [{ id: "s", name: "S", type: "skill", skill: "s", maxParallel: "5" }], cards: [] }, "x").columns[1]
      .maxParallel,
  ).toBe(5);
});

test("agent test command is stored on the card and can be started and stopped", async () => {
  const p3 = tempDir("ns-test-");
  await post("/api/projects/open", { path: p3 });
  const res = await post(
    "/api/board",
    {
      project: p3,
      columns: [
        { name: "Impl", type: "skill", skill: "enrich" },
        { name: "Testing", type: "inert" },
      ],
    },
    "PUT",
  );
  const { id } = await post("/api/cards", { project: p3, columnId: res.board.columns[1].id, title: "with-test" });
  const snap = async () => fetch(`${base}/api/project?project=${encodeURIComponent(p3)}`).then((r) => r.json());
  await waitFor(async () => !!(await snap()).board.cards[0].test);
  expect((await snap()).board.cards[0].test).toEqual({ command: "echo hello-from-test; sleep 30", url: "http://localhost:9999" });
  await post(`/api/cards/${id}/test/start`, { project: p3 });
  expect((await snap()).testing).toEqual([id]);
  const log = () => fetch(`${base}/api/cards/${id}/test?project=${encodeURIComponent(p3)}`).then((r) => r.json());
  await waitFor(async () => (await log()).some((l: LogLine) => l.text === "hello-from-test"));
  await post(`/api/cards/${id}/test/stop`, { project: p3 });
  await waitFor(async () => (await snap()).testing.length === 0);
  expect((await log()).at(-1).text).toContain("Exited");
});

test("column maxParallel caps agents in that column", async () => {
  const p2 = tempDir("ns-colmax-");
  await post("/api/projects/open", { path: p2 });
  const res = await post(
    "/api/board",
    {
      project: p2,
      columns: [
        { name: "Merge", type: "skill", skill: "enrich", maxParallel: 1 },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  expect(res.board.columns[1].maxParallel).toBe(1);
  for (const t of ["cap1", "cap2", "cap3"]) await post("/api/cards", { project: p2, columnId: res.board.columns[1].id, title: t });
  let maxRunning = 0;
  await waitFor(async () => {
    const s = await fetch(`${base}/api/project?project=${encodeURIComponent(p2)}`).then((r) => r.json());
    maxRunning = Math.max(maxRunning, Object.values(s.live).filter((v) => v === "running").length);
    return Object.keys(s.live).length === 0;
  });
  expect(maxRunning).toBe(1);
});

test("agent test command is stored on the card and can be started and stopped", async () => {
  const p3 = tempDir("ns-test-");
  await post("/api/projects/open", { path: p3 });
  const res = await post(
    "/api/board",
    {
      project: p3,
      columns: [
        { name: "Impl", type: "skill", skill: "enrich" },
        { name: "Testing", type: "inert" },
      ],
    },
    "PUT",
  );
  const { id } = await post("/api/cards", { project: p3, columnId: res.board.columns[1].id, title: "with-test" });
  const snap = async () => fetch(`${base}/api/project?project=${encodeURIComponent(p3)}`).then((r) => r.json());
  await waitFor(async () => !!(await snap()).board.cards[0].test);
  expect((await snap()).board.cards[0].test).toEqual({ command: "echo hello-from-test; sleep 30", url: "http://localhost:9999" });
  await post(`/api/cards/${id}/test/start`, { project: p3 });
  expect((await snap()).testing).toEqual([id]);
  const log = () => fetch(`${base}/api/cards/${id}/test?project=${encodeURIComponent(p3)}`).then((r) => r.json());
  await waitFor(async () => (await log()).some((l: LogLine) => l.text === "hello-from-test"));
  await post(`/api/cards/${id}/test/stop`, { project: p3 });
  await waitFor(async () => (await snap()).testing.length === 0);
  expect((await log()).at(-1).text).toContain("Exited");
});

test("fields unknown to this version survive load and PUT", async () => {
  const dir = tempDir("ns-future-");
  writeFileSync(
    join(dir, "nightshift.json"),
    JSON.stringify({
      version: 1,
      name: "f",
      futureBoardField: 1,
      columns: [{ id: "c1", name: "A", type: "inert", futureColumnField: "x" }],
      cards: [{ id: "k1", title: "t", columnId: "c1", futureCardField: [1, 2], history: [] }],
    }),
  );
  const snap = await post("/api/projects/open", { path: dir });
  await post("/api/board", { project: dir, columns: snap.board.columns }, "PUT");
  await post(`/api/cards/k1`, { project: dir, title: "t2" }, "PATCH");
  const file = JSON.parse(readFileSync(join(dir, "nightshift.json"), "utf8"));
  expect(file.futureBoardField).toBe(1);
  expect(file.columns[0].futureColumnField).toBe("x");
  expect(file.cards[0].futureCardField).toEqual([1, 2]);
  expect(file.cards[0].title).toBe("t2");
});
