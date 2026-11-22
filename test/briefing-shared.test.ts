import { expect, test } from "bun:test";
import {
  ageDays,
  type BriefingQuestion,
  type BriefingState,
  type BriefingTopic,
  briefingCandidates,
  briefingCounts,
  briefingLeftOut,
  decisionsSection,
  formatUserTurn,
  isUntouched,
  nextTopicId,
  parseTriageOutput,
  parseTurnOutput,
  pickAnswers,
  sortTopics,
  uncoveredCards,
} from "../src/shared/briefing.ts";
import type { Card } from "../src/shared/types.ts";

const card = (n: number, extra: Partial<Card> = {}): Card => ({
  id: `c${n}`,
  number: n,
  title: `Card ${n}`,
  description: "",
  columnId: "col_backlog",
  createdAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`,
  updatedAt: "",
  enteredColumnAt: "",
  history: [],
  ...extra,
});
const topic = (id: string, status: BriefingTopic["status"], extra: Partial<BriefingTopic> = {}): BriefingTopic => ({
  id,
  title: id,
  why: "",
  cardIds: [],
  oldestAt: "",
  status,
  messages: [],
  questions: [],
  decisions: [],
  costUsd: 0,
  ...extra,
});

test("briefing-candidates: Backlog cards that are neither drafts nor held, oldest first", () => {
  const cards = [card(3), card(1), card(2, { draft: true }), card(4, { dependsOn: ["c1"] }), card(5, { columnId: "col_done" })];
  expect(briefingCandidates({ cards }).map((c) => c.id)).toEqual(["c1", "c3"]);
  expect(briefingLeftOut({ cards })).toEqual({ drafts: 1, held: 1 });
  const state: BriefingState = { startedAt: "", easy: [{ cardId: "c1", reason: "" }], topics: [], costUsd: 0 };
  expect(uncoveredCards({ cards }, state).map((c) => c.id)).toEqual(["c3"]);
  expect(uncoveredCards({ cards }, null).map((c) => c.id)).toEqual(["c1", "c3"]);
});

test("briefing-triage-output: every card lands once, unknown or forgotten cards are to decide", () => {
  const cards = [card(1), card(2), card(3), card(4), card(5)];
  const r = parseTriageOutput(
    {
      cards: [
        { ref: "#5", verdict: "easy", reason: "typo" },
        { ref: "#3", verdict: "decide", reason: "scope?" },
        { ref: 2, verdict: "decide", reason: "ux?" },
        { ref: "#4", verdict: "whatever", reason: "?" },
        { ref: "#99", verdict: "easy", reason: "ghost" },
        "junk",
      ],
      topics: [
        { title: "Shared", refs: ["#3", "#2", "#5", "#99"], why: "same screen" },
        { title: "Again", refs: ["#3"], why: "dup" },
      ],
    },
    cards,
  );
  expect(r.easy).toEqual([{ cardId: "c5", reason: "typo" }]);
  // The easy card and the unknown ref are dropped from the group; a card is never in two topics.
  expect(r.topics).toEqual([
    { title: "Card 1", why: "", cardIds: ["c1"], oldestAt: cards[0]?.createdAt as string },
    { title: "Shared", why: "same screen", cardIds: ["c3", "c2"], oldestAt: cards[1]?.createdAt as string },
    { title: "Card 4", why: "?", cardIds: ["c4"], oldestAt: cards[3]?.createdAt as string },
  ]);
  // Garbage: everything is to decide, one topic per card.
  expect(parseTriageOutput("nope", cards).easy).toEqual([]);
  expect(parseTriageOutput(null, cards).topics.map((t) => t.cardIds)).toEqual([["c1"], ["c2"], ["c3"], ["c4"], ["c5"]]);
});

test("briefing-turn-output: questions, decisions and notes are checked one by one", () => {
  const cards = [card(1), card(2)];
  const r = parseTurnOutput(
    {
      reply: "  Hello  ",
      questions: [
        {
          id: "q1",
          question: "Dark mode?",
          why: "theme",
          options: [{ label: "Yes", detail: "more work" }, "No", { label: "Yes" }, 3],
          recommended: 1,
          cards: ["#2"],
        },
        { id: "q1", question: "Same id?", options: [], recommended: 4 },
        { question: "" },
        "junk",
      ],
      decisions: [
        { question: "Q", answer: "A", cards: ["#1"] },
        { question: "", answer: "x" },
        { question: "No cards", answer: "all" },
      ],
      ready: true,
      notes: [{ ref: "#1", sections: [] }],
    },
    cards,
  );
  expect(r?.reply).toBe("Hello");
  expect(r?.questions).toEqual([
    {
      id: "q1",
      question: "Dark mode?",
      why: "theme",
      options: [{ label: "Yes", detail: "more work" }, { label: "No" }],
      recommended: 1,
      cardIds: ["c2"],
    },
    { id: "q1_", question: "Same id?", options: [], cardIds: ["c1", "c2"] },
  ]);
  expect(r?.decisions).toEqual([
    { question: "Q", answer: "A", cardIds: ["c1"] },
    { question: "No cards", answer: "all", cardIds: ["c1", "c2"] },
  ]);
  // Still asking: not ready, whatever the flag says, and no note is kept.
  expect(r?.ready).toBe(false);
  expect(r?.notes).toEqual([]);
  const done = parseTurnOutput(
    { reply: "ok", questions: [], decisions: [], ready: true, notes: [{ ref: "#2", title: " New ", sections: [1] }, { ref: "#9" }] },
    cards,
  );
  expect(done?.ready).toBe(true);
  expect(done?.notes).toEqual([{ cardId: "c2", title: "New", sections: [1] }]);
  expect(parseTurnOutput([], cards)).toBeNull();
  expect(parseTurnOutput({}, cards)).toEqual({ reply: "", questions: [], decisions: [], ready: false, notes: [] });
});

test("briefing-order: topics are worked oldest first, the next one is the oldest still open", () => {
  const sorted = sortTopics([
    { oldestAt: "2026-03-01", id: "c" },
    { oldestAt: "2026-01-01", id: "a" },
    { oldestAt: "2026-01-01", id: "b" },
  ]);
  expect(sorted.map((t) => t.id)).toEqual(["a", "b", "c"]);
  const state: BriefingState = {
    startedAt: "",
    easy: [
      { cardId: "x", reason: "" },
      { cardId: "y", reason: "", launched: true },
    ],
    topics: [
      topic("t1", "launched"),
      topic("t2", "thinking"),
      topic("t3", "pending"),
      topic("t4", "waiting"),
      topic("t5", "skipped"),
      topic("t6", "error"),
    ],
    costUsd: 0,
  };
  expect(nextTopicId(state)).toBe("t3");
  expect(nextTopicId(state, "t3")).toBe("t4");
  expect(nextTopicId({ topics: [topic("t1", "launched"), topic("t2", "thinking")] })).toBeNull();
  expect(briefingCounts(state)).toEqual({
    yourTurn: 2,
    working: 1,
    settled: 2,
    launched: 1,
    skipped: 1,
    topics: 6,
    easyReady: 1,
    easyLaunched: 1,
  });
  expect(isUntouched(topic("a", "waiting", { messages: [{ role: "agent", text: "hi", at: "" }] }))).toBe(true);
  expect(
    isUntouched(
      topic("a", "waiting", {
        messages: [
          { role: "agent", text: "hi", at: "" },
          { role: "user", text: "yo", at: "" },
        ],
      }),
    ),
  ).toBe(false);
  expect(isUntouched(topic("a", "preparing"))).toBe(false);
});

test("briefing-user-turn: answers in question order, blanks left out", () => {
  const q = (id: string, question: string): BriefingQuestion => ({ id, question, options: [], cardIds: [] });
  const questions = [q("q1", "First?"), q("q2", "Second?"), q("q3", "Third?")];
  const picked = pickAnswers(questions, { q3: " C ", q1: "A", q2: "  ", q7: "ghost" });
  expect(picked.map((a) => [a.question.id, a.answer])).toEqual([
    ["q1", "A"],
    ["q3", "C"],
  ]);
  expect(formatUserTurn(picked, "  and why?  ")).toBe("- **First?**\n  A\n- **Third?**\n  C\n\nand why?");
  expect(formatUserTurn([], "just text")).toBe("just text");
  expect(decisionsSection([{ question: "Dark\nmode?", answer: "Yes", cardIds: [] }], "2026-11-22")).toBe(
    "Settled with the owner in a Nightshift briefing on 2026-11-22. Do not ask these again.\n\n- **Dark mode?** Yes",
  );
});

test("briefing-age: whole days, never negative", () => {
  const now = Date.parse("2026-02-01T12:00:00Z");
  expect(ageDays("2026-02-01T00:00:00Z", now)).toBe(0);
  expect(ageDays("2026-01-22T12:00:00Z", now)).toBe(10);
  expect(ageDays("2027-01-01T00:00:00Z", now)).toBe(0);
  expect(ageDays("not a date", now)).toBe(0);
});
