// Briefing view: pure helpers (drafts, ages, selection). The components own the React state.

import { ageDays, type BriefingQuestion } from "../shared/briefing.ts";
import { t, tn } from "./i18n/index.ts";

/** What the user is typing for a topic, kept while they look at another one. */
export interface TopicDraft {
  /** Answer per question id; "" or absent = not answered. */
  answers: Record<string, string>;
  text: string;
}

export const EMPTY_DRAFT: TopicDraft = { answers: {}, text: "" };

/** "today", "5 d", "3 wk", "4 mo", "2 y": how long a card has waited. */
export function ageLabel(iso: string, now: number = Date.now()): string {
  const days = ageDays(iso, now);
  if (days < 1) return t("briefing.age.today");
  if (days < 14) return t("briefing.age.days", { count: days });
  if (days < 60) return t("briefing.age.weeks", { count: Math.floor(days / 7) });
  if (days < 365) return t("briefing.age.months", { count: Math.floor(days / 30) });
  return tn("briefing.age.years", Math.floor(days / 365));
}

const answered = (answers: Record<string, string>, id: string) => (answers[id] ?? "").trim() !== "";

export function answeredCount(questions: BriefingQuestion[], answers: Record<string, string>): number {
  return questions.filter((q) => answered(answers, q.id)).length;
}

/** True when there are questions and each one has an answer. */
export function allAnswered(questions: BriefingQuestion[], answers: Record<string, string>): boolean {
  return questions.length > 0 && answeredCount(questions, answers) === questions.length;
}

/** Questions without an answer for which the agent recommends an option. */
export function recommendable(questions: BriefingQuestion[], answers: Record<string, string>): BriefingQuestion[] {
  return questions.filter((q) => !answered(answers, q.id) && q.recommended !== undefined && q.options[q.recommended]);
}

/** Fills every unanswered question with the agent's recommended option; given answers are kept. */
export function acceptRecommended(questions: BriefingQuestion[], answers: Record<string, string>): Record<string, string> {
  const next = { ...answers };
  for (const q of recommendable(questions, answers)) next[q.id] = q.options[q.recommended as number]?.label ?? "";
  return next;
}

/** True when the answer is the user's own words, not one of the options. */
export function isCustomAnswer(question: BriefingQuestion, answer: string | undefined): boolean {
  return !!answer?.trim() && !question.options.some((o) => o.label === answer);
}

/** Whether the composer may send: an answer or some text. */
export function canSend(questions: BriefingQuestion[], draft: TopicDraft): boolean {
  return answeredCount(questions, draft.answers) > 0 || draft.text.trim() !== "";
}

/**
 * After a send, the user moves to the next topic when they answered everything and asked nothing: the agent only
 * has to write the cards. With an open question or a message, they wait for the reply.
 */
export function advancesAfterSend(questions: BriefingQuestion[], draft: TopicDraft): boolean {
  return allAnswered(questions, draft.answers) && draft.text.trim() === "";
}
