import { expect, test } from "bun:test";
import { buildBackgroundPrompt, buildFeedbackPrompt, buildPrompt, LONG_COMMANDS_RULE } from "../src/server/orchestrator.ts";
import { defaultBoard } from "../src/server/store.ts";
import type { Card, Column } from "../src/shared/types.ts";

const col: Column = { id: "c", name: "Work", type: "skill", skill: "enrich" };
const board = { ...defaultBoard("x"), columns: [col] };
const card = { id: "k", number: 1, title: "t", description: "d", pendingAnswer: { kind: "feedback", text: "fb" } } as unknown as Card;

test("prompt-long-commands: card prompts state the long-command, wait and stay rules", () => {
  const prompts = {
    new: buildPrompt(board, card, col, undefined),
    feedback: buildFeedbackPrompt(board, card, col, "enrich", undefined),
    background: buildBackgroundPrompt(["bun test"]),
  };
  for (const [name, p] of Object.entries(prompts)) {
    expect(p, name).toContain(LONG_COMMANDS_RULE);
    expect(p, name).toContain("`run_in_background: true` and an explicit `timeout` from the first call");
    expect(p, name).toContain("up to 7200000 ms (2 h)");
    expect(p, name).toContain("Never rely on the 120 s default");
    expect(p, name).toContain("Never end your turn while a background command you need is still running");
    expect(p, name).toContain('`move: "stay"` with no questions means the work is not finished');
  }
});

test("prompt-long-commands: the wait prompt lists the commands, cut to 200 characters", () => {
  const p = buildBackgroundPrompt(["bun test", "x".repeat(300)]);
  expect(p).toContain("- bun test\n");
  expect(p).toContain(`- ${"x".repeat(200)}\n`);
  expect(p).not.toContain("x".repeat(201));
});
