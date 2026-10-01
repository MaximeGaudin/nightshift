import { afterAll, expect, test } from "bun:test";
import { SequenceController } from "../src/server/sequence.ts";
import { Project } from "../src/server/store.ts";
import type { Card, Column } from "../src/shared/types.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

const projects: Project[] = [];
afterAll(() => {
  for (const p of projects) p.close();
  removeTempDirs();
});

const columns: Column[] = [
  { id: "c_backlog", name: "Backlog", type: "inert" },
  { id: "c_grill", name: "Grill", type: "skill", skill: "x" },
  { id: "c_totest", name: "To Test", type: "inert" },
  { id: "c_merge", name: "Merge", type: "skill", skill: "x" },
  { id: "col_done", name: "Done", type: "inert" },
];

function setup(titles: string[] = ["A", "B"]) {
  const p = new Project(tempDir("ns-seq-"));
  projects.push(p);
  p.mutate((board) => {
    board.columns = structuredClone(columns);
    for (const t of titles) {
      const n = board.nextCardNumber++;
      const at = new Date().toISOString();
      board.cards.push({
        id: t,
        number: n,
        title: t,
        description: "",
        columnId: "c_backlog",
        createdAt: at,
        updatedAt: at,
        enteredColumnAt: at,
        history: [],
      });
    }
  });
  const calls = { state: 0, attention: [] as string[], running: new Set<string>() };
  const ctl = new SequenceController({
    isRunning: (_p, id) => calls.running.has(id),
    canRunAgents: () => true,
    onState: () => calls.state++,
    onAttention: (_p, id) => calls.attention.push(id),
  });
  // Mirror the orchestrator wiring: any board change schedules a reconcile.
  p.onChange(() => ctl.schedule(p));
  const card = (id: string) => p.board.cards.find((c) => c.id === id) as Card;
  const move = (id: string, col: string) => p.mutate((b) => p.moveCard(b, id, col, undefined, "Test"));
  const tick = () => new Promise<void>((r) => queueMicrotask(() => queueMicrotask(r)));
  return { p, ctl, calls, card, move, tick };
}

test("seq-ctl-play-launch", () => {
  const { p, ctl, card } = setup();
  ctl.play(p);
  expect(card("A").columnId).toBe("c_grill");
  expect(card("A").skipColumnIds).toContain("c_totest");
  expect(ctl.get(p)).toEqual({ status: "active", cardId: "A" });
  expect(card("B").columnId).toBe("c_backlog");
});

test("seq-ctl-empty", () => {
  const { p, ctl, calls } = setup([]);
  ctl.play(p);
  expect(ctl.get(p)).toEqual({ status: "stopped", notice: "Backlog vide" });
  expect(p.board.cards).toHaveLength(0);
  expect(calls.state).toBe(1);
});

test("seq-ctl-chain", async () => {
  const { p, ctl, card, move, tick } = setup();
  ctl.play(p);
  move("A", "col_done");
  await tick();
  expect(card("B").columnId).toBe("c_grill");
  expect(ctl.get(p)).toEqual({ status: "active", cardId: "B" });
  move("B", "col_done");
  await tick();
  expect(ctl.get(p)).toEqual({ status: "stopped", notice: "Séquence terminée : backlog vide" });
});

test("seq-ctl-pause", async () => {
  const { p, ctl, calls, card, move, tick } = setup();
  ctl.play(p);
  calls.running.add("A");
  ctl.pause(p);
  expect(ctl.get(p)).toEqual({ status: "paused", cardId: "A" });
  expect(calls.running.has("A")).toBe(true);
  move("A", "col_done");
  await tick();
  expect(ctl.get(p)).toEqual({ status: "stopped" });
  expect(card("B").columnId).toBe("c_backlog");
  expect(calls.running.has("A")).toBe(true);
});

test("seq-ctl-failure-resume", async () => {
  const { p, ctl, calls, card, move, tick } = setup();
  ctl.play(p);
  move("A", "c_merge");
  await tick();
  expect(ctl.get(p).status).toBe("active");
  p.mutate(() => {
    card("A").lastRun = { columnId: "c_merge", status: "error", error: "boom", at: new Date(Date.now() + 1000).toISOString() };
  });
  await tick();
  const s = ctl.get(p);
  expect(s.status).toBe("stopped");
  expect(s.cardId).toBe("A");
  expect(s.notice).toContain(`#${card("A").number}`);
  expect(calls.attention).toEqual(["A"]);
  p.mutate(() => {
    delete card("A").lastRun;
  });
  ctl.play(p);
  await tick();
  expect(ctl.get(p)).toEqual({ status: "active", cardId: "A" });
  expect(card("B").columnId).toBe("c_backlog");
});

test("seq-ctl-question-waits", async () => {
  const { p, ctl, card, move, tick } = setup();
  ctl.play(p);
  move("A", "c_merge");
  p.mutate(() => {
    card("A").lastRun = { columnId: "c_merge", status: "question", at: new Date(Date.now() + 1000).toISOString() };
  });
  await tick();
  expect(ctl.get(p)).toEqual({ status: "active", cardId: "A" });
});

test("seq-ctl-manual", async () => {
  const one = setup();
  one.ctl.play(one.p);
  one.move("A", "c_backlog");
  await one.tick();
  expect(one.ctl.get(one.p).status).toBe("stopped");
  expect(one.ctl.get(one.p).cardId).toBeUndefined();

  const two = setup();
  two.ctl.play(two.p);
  two.p.mutate((b) => {
    b.cards = b.cards.filter((c) => c.id !== "A");
  });
  await two.tick();
  expect(two.ctl.get(two.p)).toEqual({ status: "stopped", notice: "Séquence arrêtée : carte supprimée" });
});
