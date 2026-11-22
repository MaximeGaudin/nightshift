import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BriefingQuestion, BriefingState, BriefingTopic } from "../src/shared/briefing.ts";
import type { Board, Card, ProjectSnapshot } from "../src/shared/types.ts";
import { EasyReview, selectedEasy } from "../src/web/BriefingEasy.tsx";
import { BriefingTopicView } from "../src/web/BriefingTopic.tsx";
import { BriefingView, launchedCardCount, ViewSwitch } from "../src/web/BriefingView.tsx";
import {
  acceptRecommended,
  advancesAfterSend,
  ageLabel,
  allAnswered,
  canSend,
  isCustomAnswer,
  recommendable,
} from "../src/web/briefingUi.ts";
import { buildCommands } from "../src/web/commands.ts";
import { TooltipProvider } from "../src/web/components/ui/tooltip.tsx";
import { getLocale, setLocale } from "../src/web/i18n/index.ts";
import { shortcutFor } from "../src/web/shortcuts.ts";

const before = getLocale();
beforeAll(() => setLocale("en"));
afterAll(() => setLocale(before));

const T0 = "2026-01-01T00:00:00Z";
const mk = (n: number, extra: Partial<Card> = {}): Card => ({
  id: `c${n}`,
  number: n,
  title: `Card ${n}`,
  description: `Description of card ${n}`,
  columnId: "col_backlog",
  createdAt: T0,
  updatedAt: T0,
  enteredColumnAt: T0,
  history: [],
  ...extra,
});
const board = {
  version: 1,
  name: "Demo",
  columns: [
    { id: "col_backlog", name: "Backlog", type: "inert" },
    { id: "col_grill", name: "Grill", type: "skill", skill: "grill" },
    { id: "col_done", name: "Done", type: "inert" },
  ],
  cards: [mk(1), mk(2), mk(3), mk(4, { draft: true })],
  nextCardNumber: 5,
} as Board;
const snap = {
  path: "/tmp/demo",
  board,
  maxParallel: 3,
  live: {},
  testing: [],
  progress: {},
  quickRuns: [],
  flow: { fastForward: false, paused: false },
  proxyWaiting: [],
} as ProjectSnapshot;
const question: BriefingQuestion = {
  id: "q1",
  question: "Dark mode?",
  why: "Changes the theme work",
  options: [{ label: "Yes", detail: "More work" }, { label: "No" }],
  recommended: 1,
  cardIds: ["c2"],
};
const topic = (extra: Partial<BriefingTopic> = {}): BriefingTopic => ({
  id: "t1",
  title: "Theme topic",
  why: "Same screen",
  cardIds: ["c2", "c3"],
  oldestAt: T0,
  status: "waiting",
  messages: [{ role: "agent", text: "Here is **the context**.", at: T0 }],
  questions: [question],
  decisions: [],
  sessionId: "s1",
  costUsd: 0,
  ...extra,
});
const state = (extra: Partial<BriefingState> = {}): BriefingState => ({
  startedAt: T0,
  easy: [{ cardId: "c1", reason: "Nothing to decide here", plan: "Change the label in the sidebar" }],
  topics: [topic()],
  costUsd: 0,
  ...extra,
});
const view = (briefing: BriefingState | null, s: ProjectSnapshot = snap) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <BriefingView snap={s} briefing={briefing} onOpenCard={() => {}} onBack={() => {}} />
    </TooltipProvider>,
  );

test("briefing-ui-intro: counts the cards a briefing would read", () => {
  const html = view(null);
  expect(html).toContain("Start the briefing");
  expect(html).toContain("3 cards ready in Backlog");
  expect(html).toContain("1 draft left out");
  // No agents in this window: the start button is off and says why.
  const off = view(null, { ...snap, agentsDisabled: true });
  expect(off).toContain("This window does not run the agents of this project.");
  expect(off).toMatch(/<button[^>]*briefing-start[^>]*disabled/);
  const empty = view(null, { ...snap, board: { ...board, cards: [] } });
  expect(empty).toContain("The Backlog has no card to brief.");
});

test("briefing-ui-triage: running, then failed", () => {
  const running = view({
    startedAt: T0,
    easy: [],
    topics: [],
    costUsd: 0,
    triage: { status: "running", count: 3, activity: "Read: README.md" },
  });
  expect(running).toContain("Reading 3 cards…");
  expect(running).toContain("Read: README.md");
  const failed = view({ startedAt: T0, easy: [], topics: [], costUsd: 0, triage: { status: "error", count: 3, error: "boom" } });
  expect(failed).toContain("The triage failed: boom");
  expect(failed).toContain("Try again");
});

test("briefing-ui-easy-review: the easy cards are shown in full before anything else", () => {
  const html = view(state());
  // What the user needs to approve a launch: the whole title, the plan, the reason and the description.
  expect(html).toContain("briefing-easy-review");
  expect(html).toContain("Card 1");
  expect(html).toContain("Change the label in the sidebar");
  expect(html).toContain("Nothing to decide here");
  expect(html).toContain("Description of card 1");
  expect(html).toContain("Launch 1 card");
  expect(html).toContain("Discuss first");
  // The conversation is one click away in the rail, not on screen yet.
  expect(html).toContain("Theme topic");
  expect(html).not.toContain("briefing-topic-view");
  expect(selectedEasy([{ cardId: "a" }, { cardId: "b" }], new Set(["a"]))).toEqual(["b"]);
  const noDescription = renderToStaticMarkup(
    <EasyReview
      project="/tmp/demo"
      board={{ ...board, cards: [mk(1, { description: " " })] }}
      ready={[{ cardId: "c1", reason: "" }]}
      disabled={false}
      launching={false}
      onLaunch={() => {}}
      onDiscuss={() => {}}
      onOpenCard={() => {}}
    />,
  );
  expect(noDescription).toContain("the agent only has its title");
});

test("briefing-ui-topic: context, decisions to make and composer", () => {
  const html = view(state({ easy: [{ cardId: "c1", reason: "", launched: true }] }));
  expect(html).toContain('data-status="waiting"');
  expect(html).toContain("<strong>the context</strong>");
  expect(html).toContain("1 decision to make");
  expect(html).toContain("Dark mode?");
  expect(html).toContain("Changes the theme work");
  expect(html).toContain("Recommended");
  // The question concerns one of the two cards: its ref is shown.
  expect(html).toContain("#2");
  expect(html).toContain("Take the recommendations");
  expect(html).toContain("Let the agent decide the rest");
  expect(html).toContain("1 card launched");
  expect(html).toContain("0 of 1 topics settled");
});

test("briefing-ui-topic-states", () => {
  const only = (t: BriefingTopic) => view(state({ easy: [], topics: [t] }));
  // A topic the user picked, whatever its status (the view itself only opens the ones that need them).
  const shown = (t: BriefingTopic) =>
    renderToStaticMarkup(
      <BriefingTopicView
        project="/tmp/demo"
        board={board}
        topic={t}
        draft={{ answers: {}, text: "" }}
        disabled={false}
        hasNext
        onDraft={() => {}}
        onNext={() => {}}
        onOpenCard={() => {}}
      />,
    );
  expect(only(topic({ status: "preparing", messages: [], questions: [], activity: "Read: src/app.ts" }))).toContain("Read: src/app.ts");
  const thinking = shown(topic({ status: "thinking" }));
  expect(thinking).toContain("The agent is working on your answer");
  expect(thinking).not.toContain("briefing-composer");
  const failed = only(topic({ status: "error", error: "kaboom" }));
  expect(failed).toContain("The agent could not answer: kaboom");
  expect(failed).toContain("Retry");
  expect(only(topic({ status: "waiting", questions: [] }))).toContain("No decision is open");
  const finalize = shown(topic({ status: "thinking", messages: [{ role: "user", text: "", at: T0, kind: "finalize" }] }));
  expect(finalize).toContain("Decide the rest yourself and launch.");
  // Nothing left for the user: the summary, with what the session did.
  const done = only(
    topic({
      status: "launched",
      launchedTo: "Grill",
      launchedRefs: ["#2", "#3"],
      decisions: [{ question: "Q", answer: "A", cardIds: [] }],
    }),
  );
  expect(done).toContain("Nothing waits for you");
  expect(done).toContain("2 cards launched");
  expect(done).toContain("Back to the board");
  const launched = shown(topic({ status: "launched", launchedTo: "Grill", launchedRefs: ["#2", "#3"] }));
  expect(launched).toContain("Launched to Grill: #2 #3");
  expect(launched).toContain("Next topic");
  expect(thinking).toContain("Next topic");
  expect(
    launchedCardCount(
      state({ easy: [{ cardId: "c1", reason: "", launched: true }], topics: [topic({ status: "launched", launchedRefs: ["#2"] })] }),
    ),
  ).toBe(2);
});

test("briefing-ui-switch: the briefing side counts the topics waiting for the user", () => {
  const html = renderToStaticMarkup(<ViewSwitch view="board" yourTurn={2} onChange={() => {}} />);
  expect(html).toContain("2 topics wait for you");
  expect(html).toMatch(/aria-checked="true"[^>]*>.*Board/s);
  expect(renderToStaticMarkup(<ViewSwitch view="briefing" yourTurn={0} onChange={() => {}} />)).not.toContain("briefing-your-turn");
});

test("briefing-ui-drafts: recommendations, custom answers and when to move on", () => {
  const q2: BriefingQuestion = { id: "q2", question: "Free?", options: [], cardIds: [] };
  const questions = [question, q2];
  expect(recommendable(questions, {}).map((q) => q.id)).toEqual(["q1"]);
  expect(acceptRecommended(questions, { q2: "mine" })).toEqual({ q1: "No", q2: "mine" });
  // A given answer is never replaced by the recommendation.
  expect(acceptRecommended(questions, { q1: "Yes" })).toEqual({ q1: "Yes" });
  expect(isCustomAnswer(question, "Maybe")).toBe(true);
  expect(isCustomAnswer(question, "Yes")).toBe(false);
  expect(isCustomAnswer(question, " ")).toBe(false);
  expect(allAnswered(questions, { q1: "No" })).toBe(false);
  expect(allAnswered([], {})).toBe(false);
  expect(canSend(questions, { answers: {}, text: " " })).toBe(false);
  expect(canSend(questions, { answers: {}, text: "why?" })).toBe(true);
  expect(canSend(questions, { answers: { q1: "No" }, text: "" })).toBe(true);
  // Everything answered and nothing asked: the user moves to the next topic. A message keeps them here for the reply.
  expect(advancesAfterSend(questions, { answers: { q1: "No", q2: "x" }, text: "" })).toBe(true);
  expect(advancesAfterSend(questions, { answers: { q1: "No", q2: "x" }, text: "but why?" })).toBe(false);
  expect(advancesAfterSend(questions, { answers: { q1: "No" }, text: "" })).toBe(false);
});

test("briefing-ui-age", () => {
  const now = Date.parse("2026-07-01T00:00:00Z");
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  expect(ageLabel(ago(0), now)).toBe("today");
  expect(ageLabel(ago(5), now)).toBe("5 d");
  expect(ageLabel(ago(21), now)).toBe("3 wk");
  expect(ageLabel(ago(100), now)).toBe("3 mo");
  expect(ageLabel(ago(800), now)).toBe("2 y");
});

test("briefing-ui-entry-points: the B key and the palette", () => {
  const key = (k: string, extra = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, target: null, ...extra });
  expect(shortcutFor(key("b"), { dialogOpen: false })).toBe("briefing");
  expect(shortcutFor(key("b"), { dialogOpen: true })).toBeNull();
  expect(shortcutFor(key("b", { metaKey: true }), { dialogOpen: false })).toBeNull();
  const open = buildCommands({ snap, recentProjects: [], skills: [] }).find((c) => c.id === "view");
  expect(open?.label).toBe("Open the briefing");
  expect(open?.action).toEqual({ type: "view", view: "briefing" });
  const back = buildCommands({ snap, recentProjects: [], skills: [], view: "briefing" }).find((c) => c.id === "view");
  expect(back?.action).toEqual({ type: "view", view: "board" });
});
