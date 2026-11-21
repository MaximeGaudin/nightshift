import { afterAll, expect, test } from "bun:test";
import { FlowController } from "../src/server/flow.ts";
import { Project } from "../src/server/store.ts";
import type { Card, Column } from "../src/shared/types.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

const projects: Project[] = [];
afterAll(() => {
  for (const p of projects) p.close();
  removeTempDirs();
});

const columns: Column[] = [
  { id: "col_backlog", name: "Backlog", type: "inert" },
  { id: "c_grill", name: "Grill", type: "skill", skill: "x" },
  { id: "c_totest", name: "To Test", type: "inert" },
  { id: "col_done", name: "Done", type: "inert" },
];

function setup(titles: string[], canRun = true) {
  const p = new Project(tempDir("ns-flow-ctl-"));
  projects.push(p);
  p.mutate((board) => {
    board.columns = structuredClone(columns);
    for (const t of titles) {
      const at = new Date().toISOString();
      board.cards.push({
        id: t,
        number: board.nextCardNumber++,
        title: t,
        description: "",
        columnId: "col_backlog",
        createdAt: at,
        updatedAt: at,
        enteredColumnAt: at,
        history: [],
      });
    }
  });
  const calls = { state: 0, resume: 0, changes: 0 };
  const ctl = new FlowController({ canRunAgents: () => canRun, onState: () => calls.state++, onResume: () => calls.resume++ });
  p.onChange(() => {
    calls.changes++;
    ctl.schedule(p);
  });
  const card = (id: string) => p.board.cards.find((c) => c.id === id) as Card;
  const settle = () => new Promise<void>((r) => setTimeout(r, 10));
  return { p, ctl, calls, card, settle };
}

test("fast forward moves every candidate in one mutation and does not loop", async () => {
  const { p, ctl, calls, card, settle } = setup(["A", "B"]);
  ctl.setFastForward(p, true);
  await settle();
  expect(card("A").columnId).toBe("c_grill");
  expect(card("B").columnId).toBe("c_grill");
  expect(card("A").skipColumnIds).toEqual(["c_totest"]);
  expect(calls.changes).toBe(1);
  expect(calls.state).toBe(1);
});

test("pause stops feeding and play resumes it", async () => {
  const { p, ctl, calls, card, settle } = setup(["A"]);
  ctl.setPaused(p, true);
  ctl.setFastForward(p, true);
  await settle();
  expect(card("A").columnId).toBe("col_backlog");
  expect(calls.resume).toBe(0);
  ctl.setPaused(p, false);
  expect(calls.resume).toBe(1);
  expect(card("A").columnId).toBe("c_grill");
  // Same state again: no broadcast.
  ctl.setPaused(p, false);
  expect(calls.state).toBe(3);
});

test("setters refuse an instance that does not run agents", () => {
  const { p, ctl } = setup([], false);
  expect(() => ctl.setFastForward(p, true)).toThrow("This instance does not run agents for this project");
  expect(() => ctl.setPaused(p, true)).toThrow("This instance does not run agents for this project");
  expect(ctl.get(p)).toEqual({ fastForward: false, paused: false });
});

test("turning fast forward on requeues cancelled runs in their own skill column only", async () => {
  const { p, ctl, card, settle } = setup(["A", "B", "C", "D"]);
  const at = new Date(Date.now() + 1000).toISOString();
  p.mutate(() => {
    const set = (id: string, columnId: string, status: "cancelled" | "error", lrCol: string) => {
      const c = card(id);
      c.columnId = columnId;
      c.lastRun = { columnId: lrCol, status, at };
    };
    set("A", "c_grill", "cancelled", "c_grill");
    set("B", "c_grill", "error", "c_grill");
    set("C", "c_totest", "cancelled", "c_totest");
    set("D", "c_grill", "cancelled", "c_totest");
  });
  ctl.setFastForward(p, true);
  await settle();
  expect(card("A").lastRun).toBeUndefined();
  expect(card("A").history.some((h) => h.text === "Fast forward: retry of cancelled run")).toBe(true);
  expect(card("B").lastRun?.status).toBe("error");
  expect(card("C").lastRun?.status).toBe("cancelled");
  expect(card("D").lastRun?.status).toBe("cancelled");
});

test("a second fast forward on does not retry again, and paused still requeues", async () => {
  const { p, ctl, card, settle } = setup(["A"]);
  p.mutate(() => {
    card("A").columnId = "c_grill";
    card("A").lastRun = { columnId: "c_grill", status: "cancelled", at: new Date().toISOString() };
  });
  ctl.setPaused(p, true);
  ctl.setFastForward(p, true);
  await settle();
  expect(card("A").lastRun).toBeUndefined();
  p.mutate(() => {
    card("A").lastRun = { columnId: "c_grill", status: "cancelled", at: new Date().toISOString() };
  });
  ctl.setFastForward(p, true);
  await settle();
  expect(card("A").lastRun?.status).toBe("cancelled");
});
