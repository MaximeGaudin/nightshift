import { expect, test } from "bun:test";
import { buildAnswerPrompt, buildFeedbackPrompt, buildPrompt, PROGRESS_RULE, RECOVER_PROMPT } from "../src/server/orchestrator.ts";
import { defaultBoard } from "../src/server/store.ts";
import type { Card, Column } from "../src/shared/types.ts";

const col: Column = { id: "c", name: "Work", type: "skill", skill: "enrich" };
const board = { ...defaultBoard("x"), columns: [col] };
const card = { id: "k", number: 1, title: "t", description: "d", pendingAnswer: { kind: "feedback", text: "fb" } } as unknown as Card;

test("prompts-carry-progress-rule: every prompt embeds the rule verbatim", () => {
  const prompts = {
    new: buildPrompt(board, card, col, undefined),
    feedback: buildFeedbackPrompt(board, card, col, "enrich", undefined),
    answer: buildAnswerPrompt("t", 'the skill "enrich"', "yes"),
    recover: RECOVER_PROMPT,
  };
  for (const [name, p] of Object.entries(prompts)) {
    expect(p, name).toContain(PROGRESS_RULE);
  }
  for (const name of ["feedback", "answer", "recover"] as const) {
    expect(prompts[name], name).toContain("re-emit the marker of the step currently in progress");
  }
});

test("prompts-carry-progress-rule: the rule names the marker and the style priority", () => {
  expect(PROGRESS_RULE).toContain("[nightshift-progress]");
  expect(PROGRESS_RULE).toContain("priority over any style instruction");
});
