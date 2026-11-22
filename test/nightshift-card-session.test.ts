import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column } from "../src/shared/types.ts";
import { must, tempDir, waitFor } from "./helpers.ts";
import { startNightshiftServer } from "./nightshift-helpers.ts";

const { srv, base, argsLog, post, getProject, argsEntries } = await startNightshiftServer();
const { updateSettings } = await import("../src/server/settings.ts");

test("an agent that stops without its result is resumed once to collect it", async () => {
  const dir = tempDir("ns-recover-");
  await post("/api/projects/open", { path: dir });
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        { name: "S", type: "skill", skill: "enrich" },
        { name: "D", type: "inert" },
      ],
    },
    "PUT",
  );
  const [, s, d] = res.board.columns;
  for (const title of ["no-output", "die"]) await post("/api/cards", { project: dir, columnId: s.id, title });
  const get = async () => (await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards;
  await waitFor(async () => (await get()).every((c: Card) => c.columnId === d.id));
  for (const c of await get()) {
    expect(c.title).toBe("answered");
    expect(c.description).toContain("stopped before returning");
  }
});

test("prompt goes through stdin, never argv", async () => {
  const dir = tempDir("ns-stdin-");
  const argsLog = join(dir, "args.jsonl");
  const previous = process.env.FAKE_ARGS_LOG;
  process.env.FAKE_ARGS_LOG = argsLog;
  try {
    await post("/api/projects/open", { path: dir });
    const res = await post(
      "/api/board",
      {
        project: dir,
        columns: [
          { name: "S", type: "skill", skill: "enrich" },
          { name: "D", type: "inert" },
        ],
      },
      "PUT",
    );
    await post("/api/cards", { project: dir, columnId: res.board.columns[1].id, title: "argv-check" });
    await waitFor(async () => existsSync(argsLog) && readFileSync(argsLog, "utf8").includes("argv-check"));
  } finally {
    if (previous === undefined) delete process.env.FAKE_ARGS_LOG;
    else process.env.FAKE_ARGS_LOG = previous;
  }
  const entry = readFileSync(argsLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .find((e) => e.title === "argv-check");
  expect(entry.argvHasCard).toBe(false);
});

test("card session: each column continues the card's session, a fresh-session column starts a new one", async () => {
  const dir = tempDir("ns-session-");
  await post("/api/projects/open", { path: dir });
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        { name: "A", type: "skill", skill: "enrich" },
        { name: "B", type: "skill", skill: "enrich" },
        { name: "C", type: "skill", skill: "enrich", freshSession: true },
        { name: "D", type: "skill", skill: "enrich" },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  const col = (name: string) =>
    must(
      (res.board.columns as Column[]).find((c) => c.name === name),
      name,
    );
  expect(col("C").freshSession).toBe(true);
  expect(col("B").freshSession).toBeUndefined();
  const { id } = await post("/api/cards", { project: dir, columnId: col("A").id, title: "session-chain" });
  const get = async () => (await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards;
  await waitFor(async () => (await get()).find((c: Card) => c.id === id)?.columnId === col("Done").id, 15000);
  const mine = readFileSync(argsLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((r) => String(r.title).startsWith("session-chain"));
  // A: new session. B: continues it. C: fresh (no --resume). D: continues C's session.
  expect(mine.map((r) => [r.continuing, r.resumeId !== null])).toEqual([
    [false, false],
    [true, true],
    [false, false],
    [true, true],
  ]);
  expect((await get()).find((c: Card) => c.id === id)?.sessionId).toBe("sess-1");
});

test("card session: an unknown session falls back to a new one", async () => {
  const dir = tempDir("ns-session-gone-");
  await post("/api/projects/open", { path: dir });
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        { name: "A", type: "skill", skill: "enrich" },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  const col = (name: string) =>
    must(
      (res.board.columns as Column[]).find((c) => c.name === name),
      name,
    );
  const { id } = await post("/api/cards", { project: dir, columnId: col("Done").id, title: "gone FAKE_UNKNOWN_SESSION" });
  // Pretend an earlier column left a session this machine does not have, then send the card to A.
  srv.orch.get(dir).mutate(() => {
    const c = must(srv.orch.get(dir).card(id));
    c.sessionId = "sess-deleted";
  });
  await post(`/api/cards/${id}/move`, { project: dir, columnId: col("A").id });
  const get = async () => (await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards;
  await waitFor(async () => (await get()).find((c: Card) => c.id === id)?.columnId === col("Done").id, 15000);
  const card = (await get()).find((c: Card) => c.id === id);
  expect(card.lastRun.status).toBe("success");
  expect(card.sessionId).toBe("sess-1");
});

test("removing a column that still holds cards is refused", async () => {
  const proj = tempDir("ns-remove-column-");
  const snap = await post("/api/projects/open", { path: proj });
  const [backlog] = snap.board.columns;
  const kept = await post("/api/board", { project: proj, columns: [backlog, { name: "Hold", type: "inert" }] }, "PUT");
  await post("/api/cards", { project: proj, columnId: kept.board.columns[1].id, title: "held" });
  const res = await post("/api/board", { project: proj, columns: [backlog] }, "PUT");
  expect(res.error).toContain("move them first");
});

test("PUT /api/board keeps model on an inert column", async () => {
  const dir = tempDir("ns-model-inert-");
  await post("/api/projects/open", { path: dir });
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        { name: "Inbox", type: "inert" },
        { name: "Hold", type: "inert", model: "opus" },
      ],
    },
    "PUT",
  );
  expect(res.board.columns[1].model).toBe("opus");
  const file = JSON.parse(readFileSync(join(dir, "nightshift.json"), "utf8"));
  expect(file.columns[1].model).toBe("opus");
});

test("run passes the column model to claude", async () => {
  const dir = tempDir("ns-model-run-");
  updateSettings({ model: "sonnet" });
  try {
    await post("/api/projects/open", { path: dir });
    const res = await post(
      "/api/board",
      {
        project: dir,
        columns: [
          { name: "Fast", type: "skill", skill: "enrich", model: "haiku" },
          { name: "Plain", type: "skill", skill: "enrich" },
          { name: "Done", type: "inert" },
        ],
      },
      "PUT",
    );
    const [, fast, plain, done] = res.board.columns;
    const { id } = await post("/api/cards", { project: dir, columnId: fast.id, title: "m1" });
    await waitFor(async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === id)?.columnId === done.id);
    const entries = argsEntries();
    expect(entries.find((e) => e.title === "m1")?.model).toBe("haiku");
    expect(entries.find((e) => e.title === "m1 ✓")?.model).toBe("sonnet");

    updateSettings({ model: "" });
    const second = await post("/api/cards", { project: dir, columnId: plain.id, title: "m2" });
    await waitFor(async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === second.id)?.columnId === done.id);
    const entry = argsEntries().find((e) => e.title === "m2");
    expect(entry).toBeDefined();
    expect(must(entry).model).toBeNull();
  } finally {
    updateSettings({ model: "" });
  }
});

test("resume uses the column model at resume time", async () => {
  const dir = tempDir("ns-model-resume-");
  await post("/api/projects/open", { path: dir });
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        { name: "Ask", type: "skill", skill: "enrich", model: "opus" },
        { name: "Done", type: "inert" },
      ],
    },
    "PUT",
  );
  const [backlog, ask, done] = res.board.columns;
  const { id } = await post("/api/cards", { project: dir, columnId: ask.id, title: "ask" });
  await waitFor(async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === id)?.lastRun?.status === "question");
  const before = argsEntries().length;
  await post("/api/board", { project: dir, columns: [backlog, { ...ask, model: "haiku" }, done] }, "PUT");
  await post(`/api/cards/${id}/answer`, { project: dir, answers: ["blue", "big"] });
  await waitFor(async () => (await getProject(dir)).board.cards.find((c: Card) => c.id === id)?.columnId === done.id);
  const resumed = argsEntries()
    .slice(before)
    .filter((e) => e.resumed);
  expect(resumed).toHaveLength(1);
  expect(resumed[0].model).toBe("haiku");
});
