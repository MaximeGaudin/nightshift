import { expect, test } from "bun:test";
import { buildAnswerPrompt, buildFeedbackPrompt, buildPrompt, ESTIMATE_RULE, formatRunDurations, RECOVER_PROMPT } from "../src/server/orchestrator.ts";
import { parseEstimateMarker } from "../src/server/progress.ts";
import { defaultBoard } from "../src/server/store.ts";
import type { Card, Column, HistoryEntry } from "../src/shared/types.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const grill: Column = { id: "grill", name: "Grill", type: "skill", skill: "g" };
const plan: Column = { id: "plan", name: "Plan", type: "skill", skill: "p" };
const base = { ...defaultBoard("x"), columns: [grill, plan] };

function past(id: string, start: number, runS: number): Card {
  const history: HistoryEntry[] = [
    { at: at(start), kind: "created", text: "Created in Grill", columnId: "grill" },
    { at: at(start), kind: "queued", text: "Queued in Grill", columnId: "grill" },
    { at: at(start + 1), kind: "started", text: "Agent started in Grill", columnId: "grill" },
    { at: at(start + 1 + runS), kind: "moved", text: "Agent: Grill → Plan", columnId: "plan" },
  ];
  return { id, number: 1, title: "t", description: "d", columnId: "plan", createdAt: at(start), updatedAt: at(start + 1 + runS), history } as unknown as Card;
}
const current = { id: "cur", number: 2, title: "t", description: "d", columnId: "grill", history: [] } as unknown as Card;

test("estimatePrompt includes the rule and the recent durations", () => {
  const board = { ...base, cards: [past("a", 0, 120), past("b", 1000, 300), past("c", 2000, 600), current] };
  const p = buildPrompt(board, current, grill, undefined, {}, T0 + 100_000_000);
  expect(p).toContain(ESTIMATE_RULE);
  expect(p).toContain("Recent agent run times in this column (most recent first): 10 min, 5 min, 2 min (median 5 min).");
  const f = buildFeedbackPrompt(board, current, grill, "g", undefined, {}, T0 + 100_000_000);
  expect(f).toContain(ESTIMATE_RULE);
  expect(f).toContain("Recent agent run times in this column");
});

test("estimatePrompt without history says so", () => {
  const board = { ...base, cards: [current] };
  expect(buildPrompt(board, current, grill, undefined)).toContain("No past run in this column yet");
  expect(formatRunDurations([])).toContain("No past run in this column yet");
});

test("estimatePrompt keeps the last ten cards only", () => {
  const cards = Array.from({ length: 12 }, (_, i) => past(`p${i}`, i * 1000, 60 * (i + 1)));
  const p = buildPrompt({ ...base, cards: [...cards, current] }, current, grill, undefined, {}, T0 + 100_000_000);
  const line = p.split("\n").find((l) => l.startsWith("Recent agent run times")) ?? "";
  expect(line.split("(median")[0].split(",")).toHaveLength(10);
});

test("estimatePrompt rule is not parseable by the marker parser", () => {
  const board = { ...base, cards: [past("a", 0, 120), current] };
  expect(parseEstimateMarker(ESTIMATE_RULE)).toBeUndefined();
  for (const p of [
    buildPrompt(board, current, grill, undefined),
    buildFeedbackPrompt(board, current, grill, "g", undefined),
    buildAnswerPrompt("t", 'the skill "g"', "yes"),
    RECOVER_PROMPT,
  ]) {
    expect(p).toContain(ESTIMATE_RULE);
    expect(parseEstimateMarker(p)).toBeUndefined();
  }
});
