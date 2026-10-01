import { expect, test } from "bun:test";
import { needsRun } from "../src/server/store.ts";
import { type Board, type Card, canSendFeedback } from "../src/shared/types.ts";

const board: Board = {
  version: 1,
  name: "t",
  columns: [
    { id: "s", name: "S", type: "skill", skill: "x" },
    { id: "i", name: "I", type: "inert" },
  ],
  cards: [],
  nextNumber: 2,
} as Board;

const card = (over: Partial<Card> = {}): Card => ({
  id: "c1",
  number: 1,
  title: "t",
  description: "",
  columnId: "i",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  enteredColumnAt: "2026-01-01T00:00:00Z",
  history: [],
  ...over,
});

const lastRun = { columnId: "s", status: "done", at: "2026-01-02T00:00:00Z", sessionId: "sess", skill: "x" } as const;

test("needsRun feedback inerte", () => {
  const pendingAnswer = { text: "fix", sessionId: "sess", at: "2026-01-03T00:00:00Z", kind: "feedback" as const };
  expect(needsRun(board, card({ lastRun, pendingAnswer }))).toBe(true);
  expect(needsRun(board, card({ lastRun }))).toBe(false);
});

test("needsRun inerte sans pendingAnswer", () => {
  expect(needsRun(board, card())).toBe(false);
  expect(needsRun(board, card({ lastRun }))).toBe(false);
});

test("canSendFeedback", () => {
  expect(canSendFeedback(card({ lastRun }))).toBe(true);
  expect(canSendFeedback(card({ lastRun: { ...lastRun, sessionId: undefined } }))).toBe(false);
  expect(canSendFeedback(card())).toBe(false);
  expect(canSendFeedback(card({ lastRun }), "queued")).toBe(false);
  expect(canSendFeedback(card({ lastRun }), "running")).toBe(false);
  expect(canSendFeedback(card({ lastRun, pendingAnswer: { text: "a", sessionId: "sess", at: "x" } }))).toBe(false);
  expect(canSendFeedback(card({ lastRun: { ...lastRun, status: "question", columnId: "i" } }))).toBe(false);
  expect(canSendFeedback(card({ lastRun: { ...lastRun, status: "question", columnId: "s" } }))).toBe(true);
});
