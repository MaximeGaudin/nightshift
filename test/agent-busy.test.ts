import { expect, test } from "bun:test";
import { agentBlocker, agentBusy, type Card } from "../src/shared/types.ts";

const card = (over: Partial<Card> = {}): Card => ({
  id: "c1",
  number: 1,
  title: "t",
  description: "",
  columnId: "s",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  enteredColumnAt: "2026-01-01T00:00:00Z",
  history: [],
  ...over,
});

const run = (status: "done" | "error" | "cancelled" | "question", columnId = "s") =>
  ({ columnId, status, at: "2026-01-02T00:00:00Z", sessionId: "sess", skill: "x" }) as const;

test("agent-busy-live", () => {
  const c = card({ lastRun: run("done") });
  for (const live of ["queued", "running"] as const) {
    expect(agentBusy(c, live)).toBe(true);
    expect(agentBlocker(c, live)).toBe("working");
  }
});

test("agent-busy-pending-answer", () => {
  const c = card({
    lastRun: run("question"),
    pendingAnswer: { text: "a", sessionId: "sess", at: "2026-01-03T00:00:00Z" },
  });
  expect(agentBlocker(c)).toBe("working");
  expect(agentBusy(c)).toBe(true);
});

test("agent-busy-question", () => {
  expect(agentBlocker(card({ lastRun: run("question") }))).toBe("question");
  expect(agentBusy(card({ lastRun: run("question") }))).toBe(true);
  expect(agentBusy(card({ lastRun: run("question", "other") }))).toBe(false);
});

test("agent-busy-finished", () => {
  for (const status of ["done", "error", "cancelled"] as const) {
    expect(agentBusy(card({ lastRun: run(status) }))).toBe(false);
  }
  expect(agentBusy(card())).toBe(false);
  expect(agentBlocker(card())).toBeUndefined();
});
