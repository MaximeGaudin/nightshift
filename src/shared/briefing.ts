// Briefing: a working session on the Backlog. A triage call sorts the cards into "easy" (launch now) and topics
// to decide (related cards, decided together, oldest first); each topic is a conversation with an agent that ends
// by launching its cards. This module holds the pure contract: types, schemas, validation, ordering. No I/O.

import { isHeld } from "./dependencies.ts";
import { BACKLOG_COLUMN_ID, type Board, type Card, cardRef } from "./types.ts";

/** Most cards one triage call reads; the oldest come first, the rest wait for the next triage. */
export const BRIEFING_MAX_CARDS = 120;
/** Topics prepared ahead of the user: being prepared, or prepared and not answered yet. */
export const BRIEFING_LOOKAHEAD = 2;
export const BRIEFING_MAX_QUESTIONS = 12;
export const BRIEFING_MAX_OPTIONS = 5;

export interface BriefingOption {
  label: string;
  /** One line: what choosing it means. */
  detail?: string;
}

/** A product decision the agent needs from the user. */
export interface BriefingQuestion {
  /** Stable across the turns of a topic. */
  id: string;
  question: string;
  /** One line: what the answer changes in what gets built. */
  why?: string;
  options: BriefingOption[];
  /** Index in `options` of the option the agent would pick. */
  recommended?: number;
  /** Cards the decision applies to. */
  cardIds: string[];
}

export interface BriefingDecision {
  question: string;
  answer: string;
  cardIds: string[];
}

export interface BriefingMessage {
  role: "agent" | "user";
  /** Markdown. Empty for a "finalize" message, which the UI words itself. */
  text: string;
  at: string;
  /** The user asked the agent to settle the rest itself. */
  kind?: "finalize";
}

/**
 * pending: not prepared yet. preparing: the agent reads the code and writes the first briefing. waiting: the user's
 * turn. thinking: the agent's turn. launched: decided, its cards left the Backlog. skipped: left in the Backlog.
 */
export type BriefingTopicStatus = "pending" | "preparing" | "waiting" | "thinking" | "launched" | "skipped" | "error";

/** Related cards decided together in one conversation. */
export interface BriefingTopic {
  id: string;
  title: string;
  /** Why these cards need a decision, or how they relate. */
  why: string;
  cardIds: string[];
  /** createdAt of its oldest card when the topic was made: topics are worked oldest first. */
  oldestAt: string;
  status: BriefingTopicStatus;
  messages: BriefingMessage[];
  /** Decisions still open, as of the agent's last turn. */
  questions: BriefingQuestion[];
  decisions: BriefingDecision[];
  /** Claude session of the conversation. */
  sessionId?: string;
  error?: string;
  /** What the agent is doing right now (a tool call); never saved. */
  activity?: string;
  /** Name of the column its cards were sent to. */
  launchedTo?: string;
  /** Refs of the cards that actually left the Backlog. */
  launchedRefs?: string[];
  costUsd: number;
}

/** A card the triage found buildable without a product decision. */
export interface BriefingEasy {
  cardId: string;
  /** Why no decision is needed. */
  reason: string;
  /** What an agent will build, as the triage understood the card: what the user checks before launching. */
  plan?: string;
  launched?: true;
}

export interface BriefingTriage {
  status: "running" | "error";
  /** Cards being read. */
  count: number;
  activity?: string;
  error?: string;
}

/** The briefing of one project. `null` everywhere means there is none. */
export interface BriefingState {
  startedAt: string;
  /** Present while a triage runs, or after it failed. */
  triage?: BriefingTriage;
  easy: BriefingEasy[];
  /** Oldest first. */
  topics: BriefingTopic[];
  costUsd: number;
}

// ---- Backlog ----

/** Backlog cards a briefing works on: not a draft, not held by dependencies; oldest first. */
export function briefingCandidates(board: Pick<Board, "cards">): Card[] {
  return board.cards
    .filter((c) => c.columnId === BACKLOG_COLUMN_ID && !c.draft && !isHeld(c))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Backlog cards a briefing leaves alone. */
export function briefingLeftOut(board: Pick<Board, "cards">): { drafts: number; held: number } {
  const backlog = board.cards.filter((c) => c.columnId === BACKLOG_COLUMN_ID);
  return { drafts: backlog.filter((c) => c.draft).length, held: backlog.filter((c) => !c.draft && isHeld(c)).length };
}

/** Ids of the cards the briefing already knows. */
export function coveredCardIds(state: BriefingState | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const e of state?.easy ?? []) ids.add(e.cardId);
  for (const t of state?.topics ?? []) for (const id of t.cardIds) ids.add(id);
  return ids;
}

/** Candidates the briefing has not triaged yet (new Backlog cards), oldest first. */
export function uncoveredCards(board: Pick<Board, "cards">, state: BriefingState | null | undefined): Card[] {
  const covered = coveredCardIds(state);
  return briefingCandidates(board).filter((c) => !covered.has(c.id));
}

// ---- Topics ----

/** Statuses of a topic that still needs the user or the agent before it is settled. */
const OPEN: BriefingTopicStatus[] = ["waiting", "preparing", "pending", "error"];

export function isSettled(topic: Pick<BriefingTopic, "status">): boolean {
  return topic.status === "launched" || topic.status === "skipped";
}

/** True when the agent prepared the topic and the user has not said anything yet. */
export function isUntouched(topic: Pick<BriefingTopic, "status" | "messages">): boolean {
  return topic.status === "waiting" && !topic.messages.some((m) => m.role === "user");
}

/** Oldest first; equal dates keep their order. */
export function sortTopics<T extends Pick<BriefingTopic, "oldestAt">>(topics: T[]): T[] {
  return topics
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.oldestAt.localeCompare(b.t.oldestAt) || a.i - b.i)
    .map((x) => x.t);
}

/** The topic to show next: the oldest one that still needs the user, never `exceptId`. */
export function nextTopicId(state: Pick<BriefingState, "topics">, exceptId?: string): string | null {
  return state.topics.find((t) => t.id !== exceptId && OPEN.includes(t.status))?.id ?? null;
}

export interface BriefingCounts {
  /** Topics waiting for the user. */
  yourTurn: number;
  /** Topics the agent works on (first briefing or an answer). */
  working: number;
  settled: number;
  launched: number;
  skipped: number;
  topics: number;
  easyReady: number;
  easyLaunched: number;
}

export function briefingCounts(state: BriefingState): BriefingCounts {
  const by = (s: BriefingTopicStatus) => state.topics.filter((t) => t.status === s).length;
  const launched = by("launched");
  const skipped = by("skipped");
  return {
    yourTurn: by("waiting") + by("error"),
    working: by("preparing") + by("thinking"),
    settled: launched + skipped,
    launched,
    skipped,
    topics: state.topics.length,
    easyReady: state.easy.filter((e) => !e.launched).length,
    easyLaunched: state.easy.filter((e) => e.launched).length,
  };
}

/** Whole days between `iso` and `now`, never negative. */
export function ageDays(iso: string, now: number = Date.now()): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : 0;
}

// ---- Agent output ----

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** `#12`, `12` or 12 to the card with that number. */
function cardByRef(cards: Card[], ref: unknown): Card | undefined {
  const n = typeof ref === "number" ? ref : typeof ref === "string" ? Number(ref.trim().replace(/^#/, "")) : Number.NaN;
  return Number.isInteger(n) ? cards.find((c) => c.number === n) : undefined;
}

function cardIdsOf(cards: Card[], refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  const ids: string[] = [];
  for (const ref of refs) {
    const card = cardByRef(cards, ref);
    if (card && !ids.includes(card.id)) ids.push(card.id);
  }
  return ids;
}

/** JSON Schema of the triage call. */
export const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      description: "One entry per card of the prompt.",
      items: {
        type: "object",
        properties: {
          ref: { type: "string", description: 'The card ref, for example "#12".' },
          verdict: { type: "string", enum: ["easy", "decide"] },
          reason: { type: "string", description: "One short sentence: why it is easy, or which decision is missing." },
          plan: {
            type: "string",
            description:
              "Easy cards only: what an agent will build, concretely, in one to three sentences. The owner reads it to approve the launch.",
          },
        },
        required: ["ref", "verdict", "reason"],
        additionalProperties: false,
      },
    },
    topics: {
      type: "array",
      description: 'Groups of related "decide" cards. A "decide" card that fits no group needs no entry.',
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short name of what the cards share." },
          refs: { type: "array", items: { type: "string" } },
          why: { type: "string", description: "One sentence: why they must be decided together." },
        },
        required: ["title", "refs", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["cards", "topics"],
  additionalProperties: false,
} as const;

export interface TriageResult {
  easy: { cardId: string; reason: string; plan?: string }[];
  /** Oldest first. */
  topics: Pick<BriefingTopic, "title" | "why" | "cardIds" | "oldestAt">[];
}

/**
 * Reads the untrusted output of the triage call for `cards`. Every card ends up exactly once, as easy or in one
 * topic: a card the output forgot, or whose verdict is unreadable, is to decide on its own (the safe side).
 */
export function parseTriageOutput(raw: unknown, cards: Card[]): TriageResult {
  const out = isPlainObject(raw) ? raw : {};
  const verdicts = new Map<string, { easy: boolean; reason: string; plan: string }>();
  for (const entry of Array.isArray(out.cards) ? out.cards : []) {
    if (!isPlainObject(entry)) continue;
    const card = cardByRef(cards, entry.ref);
    if (!card || verdicts.has(card.id)) continue;
    verdicts.set(card.id, { easy: entry.verdict === "easy", reason: text(entry.reason, 300), plan: text(entry.plan, 800) });
  }
  const oldest = (ids: string[]) =>
    cards
      .filter((c) => ids.includes(c.id))
      .map((c) => c.createdAt)
      .sort()[0] ?? "";
  const topics: TriageResult["topics"] = [];
  const grouped = new Set<string>();
  for (const entry of Array.isArray(out.topics) ? out.topics : []) {
    if (!isPlainObject(entry)) continue;
    const ids = cardIdsOf(cards, entry.refs).filter((id) => !grouped.has(id) && !verdicts.get(id)?.easy);
    if (ids.length === 0) continue;
    for (const id of ids) grouped.add(id);
    const only = ids.length === 1 ? cards.find((c) => c.id === ids[0]) : undefined;
    topics.push({
      title: text(entry.title, 120) || only?.title || "Untitled topic",
      why: text(entry.why, 300) || (only ? (verdicts.get(only.id)?.reason ?? "") : ""),
      cardIds: ids,
      oldestAt: oldest(ids),
    });
  }
  const easy: TriageResult["easy"] = [];
  for (const card of cards) {
    const v = verdicts.get(card.id);
    if (v?.easy) easy.push({ cardId: card.id, reason: v.reason, ...(v.plan ? { plan: v.plan } : {}) });
    else if (!grouped.has(card.id)) topics.push({ title: card.title, why: v?.reason ?? "", cardIds: [card.id], oldestAt: card.createdAt });
  }
  return { easy, topics: sortTopics(topics) };
}

const QUESTION_ITEM = {
  type: "object",
  properties: {
    id: { type: "string", description: 'Stable across turns, for example "q1".' },
    question: { type: "string", description: "One decision, self-contained and concrete." },
    why: { type: "string", description: "One line: what the answer changes in what gets built." },
    options: {
      type: "array",
      description: "2 to 4 real options.",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Short name of the option." },
          detail: { type: "string", description: "One line: its consequence." },
        },
        required: ["label"],
        additionalProperties: false,
      },
    },
    recommended: { type: "integer", description: "Index in options of the option you would pick." },
    cards: { type: "array", items: { type: "string" }, description: 'Refs of the cards concerned, for example ["#12"].' },
  },
  required: ["id", "question", "options"],
  additionalProperties: false,
} as const;

/** JSON Schema of every turn of a topic conversation. */
export const TURN_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "Markdown shown to the owner." },
    questions: { type: "array", description: "The product decisions still open, most important first.", items: QUESTION_ITEM },
    decisions: {
      type: "array",
      description: "Every decision settled so far in this conversation.",
      items: {
        type: "object",
        properties: { question: { type: "string" }, answer: { type: "string" }, cards: { type: "array", items: { type: "string" } } },
        required: ["question", "answer"],
        additionalProperties: false,
      },
    },
    ready: { type: "boolean", description: "True when no blocking decision remains: the cards go to the agents." },
    notes: {
      type: "array",
      description: "Only with ready true: what to add to each card's note.",
      items: {
        type: "object",
        properties: {
          ref: { type: "string" },
          title: { type: "string", description: "Only to fix a misleading title." },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                heading: { type: "string", description: 'Heading text without the hashes, for example "Acceptance".' },
                content: { type: "string" },
                op: { type: "string", enum: ["replace", "append", "delete"] },
              },
              required: ["heading"],
            },
          },
        },
        required: ["ref", "sections"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "questions", "decisions", "ready"],
  additionalProperties: false,
} as const;

export interface TurnNote {
  cardId: string;
  title?: string;
  /** Untrusted section edits, checked by the section editor when they are applied. */
  sections: unknown;
}

export interface TurnResult {
  reply: string;
  questions: BriefingQuestion[];
  decisions: BriefingDecision[];
  ready: boolean;
  notes: TurnNote[];
}

function parseQuestion(raw: unknown, index: number, cards: Card[], usedIds: Set<string>): BriefingQuestion | null {
  if (!isPlainObject(raw)) return null;
  const question = text(raw.question, 1000);
  if (!question) return null;
  let id = text(raw.id, 40) || `q${index + 1}`;
  while (usedIds.has(id)) id = `${id}_`;
  usedIds.add(id);
  const options: BriefingOption[] = [];
  for (const o of Array.isArray(raw.options) ? raw.options : []) {
    const label = typeof o === "string" ? text(o, 200) : isPlainObject(o) ? text(o.label, 200) : "";
    if (!label || options.some((x) => x.label === label)) continue;
    const detail = isPlainObject(o) ? text(o.detail, 400) : "";
    options.push({ label, ...(detail ? { detail } : {}) });
    if (options.length === BRIEFING_MAX_OPTIONS) break;
  }
  const why = text(raw.why, 400);
  const recommended = Number.isInteger(raw.recommended) && options[raw.recommended as number] ? (raw.recommended as number) : undefined;
  const cardIds = cardIdsOf(cards, raw.cards);
  return {
    id,
    question,
    ...(why ? { why } : {}),
    options,
    ...(recommended !== undefined ? { recommended } : {}),
    cardIds: cardIds.length > 0 ? cardIds : cards.map((c) => c.id),
  };
}

/** Reads the untrusted output of a conversation turn about `cards`; null when it is not an object. */
export function parseTurnOutput(raw: unknown, cards: Card[]): TurnResult | null {
  if (!isPlainObject(raw)) return null;
  const all = cards.map((c) => c.id);
  const usedIds = new Set<string>();
  const questions: BriefingQuestion[] = [];
  for (const [i, q] of (Array.isArray(raw.questions) ? raw.questions : []).entries()) {
    const parsed = parseQuestion(q, i, cards, usedIds);
    if (parsed) questions.push(parsed);
    if (questions.length === BRIEFING_MAX_QUESTIONS) break;
  }
  const decisions: BriefingDecision[] = [];
  for (const d of Array.isArray(raw.decisions) ? raw.decisions : []) {
    if (!isPlainObject(d)) continue;
    const question = text(d.question, 1000);
    const answer = text(d.answer, 2000);
    if (!question || !answer) continue;
    const ids = cardIdsOf(cards, d.cards);
    decisions.push({ question, answer, cardIds: ids.length > 0 ? ids : all });
  }
  const notes: TurnNote[] = [];
  for (const n of Array.isArray(raw.notes) ? raw.notes : []) {
    if (!isPlainObject(n)) continue;
    const card = cardByRef(cards, n.ref);
    if (!card || notes.some((x) => x.cardId === card.id)) continue;
    const title = text(n.title, 300);
    notes.push({ cardId: card.id, ...(title ? { title } : {}), sections: n.sections });
  }
  // A turn that says "ready" while it still asks is not ready: the questions win.
  const ready = raw.ready === true && questions.length === 0;
  return { reply: typeof raw.reply === "string" ? raw.reply.trim() : "", questions, decisions, ready, notes: ready ? notes : [] };
}

// ---- User turn ----

export interface BriefingAnswer {
  question: BriefingQuestion;
  answer: string;
}

/** The answers the user gave to the open questions, in question order; blank ones are left out. */
export function pickAnswers(questions: BriefingQuestion[], answers: Record<string, string>): BriefingAnswer[] {
  return questions.flatMap((question) => {
    const answer = (answers[question.id] ?? "").trim();
    return answer ? [{ question, answer }] : [];
  });
}

/** The user's turn as shown in the conversation. */
export function formatUserTurn(answers: BriefingAnswer[], message: string): string {
  const lines = answers.map((a) => `- **${a.question.question}**\n  ${a.answer}`);
  return [lines.join("\n"), message.trim()].filter(Boolean).join("\n\n");
}

/** `## Decisions` body written into a card when its topic is launched. */
export function decisionsSection(decisions: BriefingDecision[], date: string): string {
  return [
    `Settled with the owner in a Nightshift briefing on ${date}. Do not ask these again.`,
    "",
    ...decisions.map((d) => `- **${d.question.replace(/\s+/g, " ")}** ${d.answer.replace(/\s+/g, " ")}`),
  ].join("\n");
}

/** `#12, #15` for the cards of a topic still on the board. */
export function topicRefs(board: Pick<Board, "cards">, topic: Pick<BriefingTopic, "cardIds">): string[] {
  return topic.cardIds.flatMap((id) => {
    const card = board.cards.find((c) => c.id === id);
    return card ? [cardRef(card)] : [];
  });
}
