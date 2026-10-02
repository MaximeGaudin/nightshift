import { expect, test } from "bun:test";
import { buildEnvironment, WORKTREE_POLICY_TEXT } from "../src/server/environment.ts";
import { buildAnswerPrompt, buildFeedbackPrompt, buildPrompt } from "../src/server/orchestrator.ts";
import { buildQuickRunPrompt } from "../src/server/quickrun.ts";
import { defaultBoard } from "../src/server/store.ts";
import { BACKLOG_COLUMN_ID, type Board, type Card, type Column, DONE_COLUMN_ID, WORKTREE_POLICIES } from "../src/shared/types.ts";

const cols: Column[] = [
  { id: BACKLOG_COLUMN_ID, name: "Backlog", type: "inert" },
  { id: "grill", name: "Grill", type: "skill", skill: "nightshift-grill" },
  { id: "plan", name: "Plan", type: "skill", skill: "nightshift-plan" },
  { id: "impl", name: "Implement", type: "skill", skill: "nightshift-implement" },
  { id: "rev", name: "Review", type: "skill", skill: "nightshift-review" },
  { id: DONE_COLUMN_ID, name: "Done", type: "inert" },
];

function mk(id: string, number: number, columnId: string, extra: Partial<Card> = {}): Card {
  return { id, number, title: `title ${number}`, description: `SECRET-${number}`, columnId, history: [], ...extra } as unknown as Card;
}

function boardWith(cards: Card[], extra: Partial<Board> = {}): Board {
  return { ...defaultBoard("x"), columns: cols, cards, ...extra };
}

test("environment path with skips: lists remaining columns, marks the current one, names skipped ones", () => {
  const current = mk("c", 1, "plan", { skipColumnIds: ["rev", "grill"] });
  const out = buildEnvironment(boardWith([current]), current, {});
  const path = out.split("\n").filter((l) => /^ {2}\d+\./.test(l));
  expect(path).toEqual([
    "  1. Plan (id: plan, skill: nightshift-plan) ← current",
    "  2. Implement (id: impl, skill: nightshift-implement)",
    "  3. Done (id: col_done, inert)",
  ]);
  expect(out).toContain("Skipped for this card: Review (id: rev, skill: nightshift-review)");
  expect(out).not.toContain("Grill (id: grill, skill: nightshift-grill),");
  const none = mk("d", 2, "plan");
  expect(buildEnvironment(boardWith([none]), none, {})).not.toContain("Skipped for this card");
});

test("environment other cards: caps at 20, marks states, hides current card, Done and descriptions", () => {
  const cards = [
    ...Array.from({ length: 25 }, (_, i) => mk(`b${i}`, 100 + i, BACKLOG_COLUMN_ID)),
    mk("run", 1, "impl"),
    mk("ask", 2, "impl", { lastRun: { status: "question", columnId: "impl" } as Card["lastRun"] }),
    mk("done", 3, DONE_COLUMN_ID),
    mk("wait", 5, "impl"),
  ];
  const current = mk("cur", 4, "plan");
  const out = buildEnvironment(boardWith([...cards, current]), current, { run: "running", wait: "paused" });
  expect(out).toContain("#100 title 100");
  expect(out).toContain("#119 title 119");
  expect(out).not.toContain("#120 ");
  expect(out).toContain("… and 5 more");
  expect(out).toContain("#1 title 1 [running]");
  expect(out).toContain("#5 title 5 [paused]");
  expect(out).toContain("#2 title 2 [question]");
  expect(out).not.toContain("#3 title 3");
  expect(out).not.toContain("#4 title 4");
  expect(out).not.toContain("SECRET");
});

test("environment other cards: none", () => {
  const current = mk("cur", 4, "plan");
  expect(buildEnvironment(boardWith([current]), current, {})).toContain("Other cards on the board: none");
});

test("environment policy line: fixed text per policy, required when the board has none", () => {
  const current = mk("cur", 4, "plan");
  for (const policy of WORKTREE_POLICIES) {
    const out = buildEnvironment(boardWith([current], { worktreePolicy: policy }), current, {});
    expect(out).toContain(`Worktree policy: ${policy} — ${WORKTREE_POLICY_TEXT[policy]}`);
  }
  expect(buildEnvironment(boardWith([current]), current, {})).toContain(`Worktree policy: required — ${WORKTREE_POLICY_TEXT.required}`);
});

test("prompts include environment after the card; answer and quick-run prompts do not", () => {
  const current = mk("cur", 4, "plan", { pendingAnswer: { kind: "feedback", text: "fb", sessionId: "s", at: "" } });
  const board = boardWith([current]);
  const column = cols[2] as Column;
  for (const prompt of [
    buildPrompt(board, current, column, undefined),
    buildFeedbackPrompt(board, current, column, "nightshift-plan", undefined),
  ]) {
    expect(prompt).toContain("<environment>");
    expect(prompt.indexOf("<environment>")).toBeGreaterThan(prompt.indexOf("</card>"));
  }
  expect(buildAnswerPrompt("t", "the skill", "yes")).not.toContain("<environment>");
  expect(buildQuickRunPrompt("s", undefined, "do it")).not.toContain("<environment>");
});
