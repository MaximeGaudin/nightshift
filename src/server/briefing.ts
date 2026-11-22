// Briefing, server side: the triage call, one conversation per topic, and the launch of the cards. The state of a
// project's briefing is kept in memory and saved under NIGHTSHIFT_HOME (never in nightshift.json): a restart keeps
// the conversations. Agents run outside the card queue, so a turn of the conversation never waits for a worker.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ageDays,
  BRIEFING_LOOKAHEAD,
  BRIEFING_MAX_CARDS,
  type BriefingAnswer,
  type BriefingState,
  type BriefingTopic,
  decisionsSection,
  formatUserTurn,
  isSettled,
  isUntouched,
  parseTriageOutput,
  parseTurnOutput,
  pickAnswers,
  sortTopics,
  TRIAGE_SCHEMA,
  TURN_SCHEMA,
  type TurnNote,
  uncoveredCards,
} from "../shared/briefing.ts";
import { isHeld, releaseTarget } from "../shared/dependencies.ts";
import type { EffortLevel } from "../shared/effort.ts";
import { BACKLOG_COLUMN_ID, type Board, type Card, cardRef, type LogLine } from "../shared/types.ts";
import { writeFileAtomic } from "./fsutil.ts";
import { HttpError } from "./guard.ts";
import { applySections, parseSections } from "./sections.ts";
import { NIGHTSHIFT_HOME } from "./settings.ts";
import { isRaw, newId, type Project, type Raw } from "./store.ts";

/** One `claude -p` run outside the card queue. */
export interface AsideRun {
  /** Session name (--name). */
  name: string;
  /** How the run is listed while it waits for the teamclaude proxy. */
  title: string;
  prompt: string;
  schema: object;
  resumeId?: string;
  /** Absent = the settings (or the skill-less default). */
  effort?: EffortLevel;
  /** Nothing of the user's setup is loaded (MCP, Chrome, hooks, user skills): the fastest start. */
  lean?: boolean;
  /** The file-editing tools are denied. */
  readOnly?: boolean;
  onLog?(kind: LogLine["kind"], text: string): void;
}

export type AsideResult =
  | { ok: true; output: Raw; sessionId?: string; costUsd: number }
  | { ok: false; error: string; cancelled: boolean; sessionId?: string; costUsd: number };

export interface AsideHandle {
  /** Never rejects. */
  done: Promise<AsideResult>;
  cancel(): void;
}

export interface BriefingDeps {
  /** True when this process runs the project's agents. */
  canRun(p: Project): boolean;
  /** The briefing changed: tell the clients. */
  onState(p: Project, state: BriefingState | null): void;
  run(p: Project, run: AsideRun): AsideHandle;
}

/** First line of each briefing prompt: tells the calls apart (the test stand-in for claude reads it). */
export const TRIAGE_MARKER = "<nightshift-briefing-triage>";
export const TOPIC_MARKER = "<nightshift-briefing-topic>";
export const TURN_MARKER = "<nightshift-briefing-turn>";

const TRIAGE_DESCRIPTION_MAX = 1200;
const TOPIC_DESCRIPTION_MAX = 12_000;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…[truncated]` : s);

function cardBlock(card: Card, max: number, now: number): string {
  return `<card ref="${cardRef(card)}" created="${card.createdAt.slice(0, 10)}" age_days="${ageDays(card.createdAt, now)}">
<title>${card.title}</title>
<description>
${clip(card.description, max)}
</description>
</card>`;
}

export function buildTriagePrompt(cards: Card[], now: number = Date.now()): string {
  return `${TRIAGE_MARKER}
You triage the backlog of a software project for its owner, who is about to start a working session. Agents will
build the cards. Sort the cards so the owner only spends time where a decision is really theirs.

For each card, give a verdict:
- "easy": an agent can build it without asking the owner anything. There is no product decision, or only ones any
  careful engineer would settle the same way: a bug with a clear expected behaviour, a mechanical change, a refactor,
  a copy fix, a dependency bump, a feature whose behaviour the note already states.
- "decide": building it needs at least one product decision the note does not settle (behaviour, scope, UX, wording
  users see, a trade-off with visible consequences), or the note is too vague to know what to build.
When in doubt, answer "decide": a wrong "easy" wastes an agent run on a guess.

Then group the "decide" cards into topics: cards that touch the same feature, screen or concept, or whose decisions
must stay consistent, go together so the owner decides once. At most 5 cards per topic. A card on its own needs no
topic entry. Never put an "easy" card in a topic.

You may look at the code when a card cannot be judged from its text, a few lookups at most: this must be fast.
Never change a file.

${cards.map((c) => cardBlock(c, TRIAGE_DESCRIPTION_MAX, now)).join("\n\n")}

Return the structured output: one "cards" entry per card (ref, verdict, one short reason), and the "topics".
For each "easy" card also give "plan": what an agent will build, concretely, in one to three sentences (what changes,
where, and what the result looks like). The owner approves the launch from it, so never just restate the title.
Write the reasons, the plans and the topic titles in the language of the cards.`;
}

const TURN_OUTPUT_RULES = `Structured output, on every turn:
- reply: markdown shown to the owner. On the first turn it is the briefing: what this is about in plain language
  (2 to 5 sentences), what exists today in the code (name the files as \`path\`), how the cards relate when there are
  several, and any constraint or risk worth knowing. Later it answers what the owner asked and says what you recorded.
  Keep it short. Never repeat the questions in it: they are shown separately, from "questions".
- questions: the product decisions still open, most important first. Each one has an id that stays the same across
  turns ("q1", "q2"…), the question (one decision, self-contained, concrete), why (one line: what the answer changes
  in what gets built), options (2 to 4 real options: a short label and one line of consequence), recommended (the
  index of the option you would pick) and cards (the refs it concerns).
  Ask only what changes what gets built and belongs to the owner: behaviour, scope, UX, wording users see, trade-offs
  with visible consequences. Decide technical matters yourself (file layout, libraries, internal names) and never ask
  them. Never ask what the cards or the code already answer. Ask everything at once, never keep a question for later.
- decisions: every decision settled so far in this conversation (question, answer, cards). The list is cumulative.
- ready: true when no blocking decision remains. Also on the first turn, when the cards need none.
- notes: only with ready true. For each card, the sections to add to its note so an agent builds it without asking
  again: at least "Acceptance" (checkable criteria, each one observable in a test or on a screen), and any other
  "## " section the decisions change (scope, behaviour). Do not write a "Decisions" section: Nightshift writes it
  from "decisions". Do not repeat text the card already holds.

Rules:
- Read-only: never create, edit or delete a file, never run a command that changes anything (no commit, no checkout,
  no install). Never edit nightshift.json.
- Do not use the AskUserQuestion tool: questions go in the structured output.
- Write in the language of the cards; when the owner writes in another language, follow the owner.
- Return the structured output exactly once, at the end of the turn.`;

export function buildTopicPrompt(topic: Pick<BriefingTopic, "title" | "why">, cards: Card[], now: number = Date.now()): string {
  return `${TOPIC_MARKER}
You are the briefing partner of the owner of this software project, inside Nightshift, a kanban board whose columns
are worked by AI agents. The owner is going through the backlog in a working session. The cards below cannot be built
yet: they wait for product decisions. ${cards.length > 1 ? "They were grouped because they are related: their decisions must be consistent." : ""}

Topic: ${topic.title}${topic.why ? `\nWhy it needs the owner: ${topic.why}` : ""}

${cards.map((c) => cardBlock(c, TOPIC_DESCRIPTION_MAX, now)).join("\n\n")}

Your job over this conversation:
1. Make the owner understand the context fast: what each card asks for, what exists today, how the cards relate.
2. Surface every product decision that blocks building them and settle each with the owner. A decision shared by
   several cards is asked once.
3. When nothing blocks any more, hand the cards over to the agents (ready: true).

This is the first turn. Explore first, read-only: the code the cards touch (screens, modules, current behaviour) and
the project documents that matter (README, docs). Be quick, this is a briefing and not an implementation plan: a dozen
lookups is usually enough. Then return the structured output.

${TURN_OUTPUT_RULES}`;
}

export function buildTurnPrompt(
  refs: string[],
  answers: BriefingAnswer[],
  open: { id: string; question: string }[],
  message: string,
): string {
  const answered = answers.map((a) => `- [${a.question.id}] ${a.question.question}\n  Answer: ${a.answer}`).join("\n");
  const left = open.map((q) => `- [${q.id}] ${q.question}`).join("\n");
  return `${TURN_MARKER}
The owner replied.
${answered ? `\nAnswers:\n${answered}\n` : ""}${left ? `\nLeft open by the owner (still to settle):\n${left}\n` : ""}${message.trim() ? `\nMessage from the owner:\n<message>\n${message.trim()}\n</message>\n` : ""}
Continue the briefing of ${refs.join(", ")}. Answer the owner's message when it asks something (look at the code again
when needed, read-only). Record the answers in "decisions" and drop the answered questions from "questions". Add a
question only when an answer opens a new blocking decision, and then ask every new one at once. When no blocking
decision remains, set ready to true and return "notes". Return the structured output as before.`;
}

export function buildFinalizePrompt(refs: string[]): string {
  return `${TURN_MARKER}
The owner asks you to settle the rest yourself.

Decide every question still open with the option you recommended, and add each to "decisions" with an answer that
starts with "Agent's call: ". Then set ready to true, return an empty "questions" list and the "notes" of ${refs.join(", ")}.
In "reply", list in one line each what you decided. Return the structured output as before.`;
}

/** Sent when a turn is retried and its prompt is no longer known (the server restarted). */
export const TURN_RETRY_PROMPT = `${TURN_MARKER}
Your last turn in this briefing did not reach the owner. Return the structured output for the current state of the
conversation: the reply, the questions still open, the decisions settled so far, ready and notes as before.`;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nowIso = () => new Date().toISOString();

export class Briefing {
  private states = new Map<string, BriefingState>();
  /** Running agents, by `<project>::triage` or `<project>::<topic id>`. */
  private runs = new Map<string, AsideHandle>();
  /** Prompt of the turn in flight for a topic: a retry sends it again. */
  private prompts = new Map<string, string>();
  /** Projects waiting for a reconcile pass (coalesced per microtask). */
  private pending = new Map<string, Project>();

  constructor(private deps: BriefingDeps) {}

  state(p: Project): BriefingState | null {
    return this.states.get(p.path) ?? null;
  }

  // ---- persistence ----

  private file(p: Project, create = false): string {
    const dir = join(NIGHTSHIFT_HOME, "briefings");
    if (create) mkdirSync(dir, { recursive: true });
    return join(dir, `${createHash("sha1").update(p.path).digest("hex").slice(0, 12)}.json`);
  }

  private saveFailed = false;

  /** Tells the clients, and saves unless only live activity changed. */
  private commit(p: Project, { save = true }: { save?: boolean } = {}) {
    const st = this.states.get(p.path) ?? null;
    if (save) {
      try {
        if (st) {
          const { triage: _triage, ...rest } = st;
          const stored = { ...rest, topics: st.topics.map(({ activity: _activity, ...t }) => t) };
          writeFileAtomic(this.file(p, true), `${JSON.stringify(stored)}\n`);
        } else rmSync(this.file(p), { force: true });
      } catch (e) {
        if (!this.saveFailed) {
          this.saveFailed = true;
          console.error(`Could not save the briefing of ${p.path} (further failures are not reported): ${errorMessage(e)}`);
        }
      }
    }
    this.deps.onState(p, st);
  }

  /** Reads the saved briefing of a project being opened. A turn that was in flight is lost: its topic can be retried. */
  load(p: Project) {
    if (this.states.has(p.path)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file(p), "utf8"));
    } catch {
      return;
    }
    if (!isRaw(raw) || !Array.isArray(raw.easy) || !Array.isArray(raw.topics) || typeof raw.startedAt !== "string") return;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const topics: BriefingTopic[] = [];
    for (const t of raw.topics) {
      if (!isRaw(t) || typeof t.id !== "string" || !Array.isArray(t.cardIds)) continue;
      const messages = (Array.isArray(t.messages) ? t.messages : []).filter(
        (m): m is BriefingTopic["messages"][number] => isRaw(m) && (m.role === "agent" || m.role === "user") && typeof m.text === "string",
      );
      const status = str(t.status) as BriefingTopic["status"];
      const interrupted = status === "thinking";
      topics.push({
        id: t.id,
        title: str(t.title) || "Untitled topic",
        why: str(t.why),
        cardIds: t.cardIds.filter((id): id is string => typeof id === "string"),
        oldestAt: str(t.oldestAt),
        status: status === "preparing" ? "pending" : interrupted ? "error" : status || "pending",
        messages,
        questions: Array.isArray(t.questions) ? (t.questions as BriefingTopic["questions"]) : [],
        decisions: Array.isArray(t.decisions) ? (t.decisions as BriefingTopic["decisions"]) : [],
        ...(typeof t.sessionId === "string" ? { sessionId: t.sessionId } : {}),
        ...(interrupted
          ? { error: "Nightshift restarted before the agent answered." }
          : typeof t.error === "string"
            ? { error: t.error }
            : {}),
        ...(typeof t.launchedTo === "string" ? { launchedTo: t.launchedTo } : {}),
        ...(Array.isArray(t.launchedRefs) ? { launchedRefs: t.launchedRefs.filter((r): r is string => typeof r === "string") } : {}),
        costUsd: Number(t.costUsd) || 0,
      });
    }
    const easy = raw.easy.flatMap((e) =>
      isRaw(e) && typeof e.cardId === "string"
        ? [
            {
              cardId: e.cardId,
              reason: str(e.reason),
              ...(typeof e.plan === "string" && e.plan ? { plan: e.plan } : {}),
              ...(e.launched === true ? { launched: true as const } : {}),
            },
          ]
        : [],
    );
    if (topics.length === 0 && easy.length === 0) return;
    this.states.set(p.path, { startedAt: raw.startedAt, easy, topics, costUsd: Number(raw.costUsd) || 0 });
    this.reconcile(p);
  }

  // ---- helpers ----

  private need(p: Project): BriefingState {
    const st = this.states.get(p.path);
    if (!st) throw new HttpError(404, "No briefing in this project");
    return st;
  }

  private topic(p: Project, topicId: string): { st: BriefingState; topic: BriefingTopic } {
    const st = this.need(p);
    const topic = st.topics.find((t) => t.id === topicId);
    if (!topic) throw new HttpError(404, "Unknown topic");
    return { st, topic };
  }

  private requireAgents(p: Project) {
    if (!this.deps.canRun(p)) throw new HttpError(409, "This instance does not run this project's agents");
  }

  private key(p: Project, id: string) {
    return `${p.path}::${id}`;
  }

  /** Cards of a topic still in the Backlog, oldest first. */
  private cards(board: Pick<Board, "cards">, topic: Pick<BriefingTopic, "cardIds">): Card[] {
    return board.cards
      .filter((c) => topic.cardIds.includes(c.id) && c.columnId === BACKLOG_COLUMN_ID)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private stop(p: Project, id: string) {
    const key = this.key(p, id);
    const handle = this.runs.get(key);
    this.runs.delete(key);
    this.prompts.delete(key);
    handle?.cancel();
  }

  // ---- triage ----

  /** Starts a briefing, or triages the Backlog cards that arrived since the last triage. */
  start(p: Project) {
    this.requireAgents(p);
    let st = this.states.get(p.path);
    if (st?.triage?.status === "running") return;
    const cards = uncoveredCards(p.board, st).slice(0, BRIEFING_MAX_CARDS);
    if (cards.length === 0) throw new HttpError(400, "No Backlog card to triage");
    if (!st) {
      st = { startedAt: nowIso(), easy: [], topics: [], costUsd: 0 };
      this.states.set(p.path, st);
    }
    st.triage = { status: "running", count: cards.length };
    this.commit(p);
    const key = this.key(p, "triage");
    const ids = cards.map((c) => c.id);
    const handle = this.deps.run(p, {
      name: "nightshift briefing: triage",
      title: "Briefing triage",
      prompt: buildTriagePrompt(cards),
      schema: TRIAGE_SCHEMA,
      effort: "low",
      lean: true,
      readOnly: true,
      onLog: (kind, text) => {
        const cur = this.states.get(p.path);
        if (kind !== "tool" || cur?.triage?.status !== "running" || this.runs.get(key) !== handle) return;
        cur.triage.activity = text.slice(0, 160);
        this.commit(p, { save: false });
      },
    });
    this.runs.set(key, handle);
    void handle.done.then((r) => {
      if (this.runs.get(key) !== handle) return;
      this.runs.delete(key);
      const cur = this.states.get(p.path);
      if (!cur) return;
      cur.costUsd += r.costUsd;
      if (!r.ok) {
        cur.triage = { status: "error", count: ids.length, error: r.error };
        this.commit(p);
        return;
      }
      delete cur.triage;
      // Cards that left the Backlog, or were covered meanwhile, are no longer the triage's to place.
      const still = uncoveredCards(p.board, cur).filter((c) => ids.includes(c.id));
      const parsed = parseTriageOutput(r.output, still);
      cur.easy.push(...parsed.easy);
      cur.topics = sortTopics([...cur.topics, ...parsed.topics.map((t) => this.newTopic(t))]);
      this.commit(p);
      this.pump(p);
    });
  }

  private newTopic(t: Pick<BriefingTopic, "title" | "why" | "cardIds" | "oldestAt">): BriefingTopic {
    return { id: newId("topic"), ...t, status: "pending", messages: [], questions: [], decisions: [], costUsd: 0 };
  }

  // ---- conversations ----

  /** Prepares topics ahead of the user, oldest first, so the next conversation is ready when the current one ends. */
  private pump(p: Project) {
    const st = this.states.get(p.path);
    if (!st || !this.deps.canRun(p)) return;
    let room = BRIEFING_LOOKAHEAD - st.topics.filter((t) => t.status === "preparing" || isUntouched(t)).length;
    for (const topic of st.topics) {
      if (room <= 0) break;
      if (topic.status !== "pending") continue;
      this.prepare(p, topic);
      room--;
    }
  }

  private prepare(p: Project, topic: BriefingTopic) {
    const cards = this.cards(p.board, topic);
    if (cards.length === 0) return;
    topic.status = "preparing";
    delete topic.error;
    delete topic.sessionId;
    this.commit(p);
    this.runTurn(p, topic, buildTopicPrompt(topic, cards), undefined);
  }

  private runTurn(p: Project, topic: BriefingTopic, prompt: string, resumeId: string | undefined) {
    const key = this.key(p, topic.id);
    this.prompts.set(key, prompt);
    const handle = this.deps.run(p, {
      name: `nightshift briefing: ${topic.title}`.slice(0, 80),
      title: `Briefing: ${topic.title}`.slice(0, 120),
      prompt,
      schema: TURN_SCHEMA,
      resumeId,
      readOnly: true,
      onLog: (kind, text) => {
        if (kind !== "tool" || this.runs.get(key) !== handle) return;
        topic.activity = text.slice(0, 160);
        this.commit(p, { save: false });
      },
    });
    this.runs.set(key, handle);
    void handle.done.then((r) => {
      try {
        this.onTurn(p, topic.id, handle, r);
      } catch (e) {
        console.error(`Briefing turn of ${p.path} could not be recorded: ${errorMessage(e)}`);
      }
    });
  }

  private onTurn(p: Project, topicId: string, handle: AsideHandle, r: AsideResult) {
    const key = this.key(p, topicId);
    if (this.runs.get(key) !== handle) return;
    this.runs.delete(key);
    const st = this.states.get(p.path);
    const topic = st?.topics.find((t) => t.id === topicId);
    if (!st || !topic) return;
    st.costUsd += r.costUsd;
    topic.costUsd += r.costUsd;
    delete topic.activity;
    if (r.sessionId) topic.sessionId = r.sessionId;
    const fail = (error: string) => {
      topic.status = "error";
      topic.error = error;
      // A session claude no longer has cannot be resumed: the retry prepares the topic again.
      if (/no conversation found/i.test(error)) delete topic.sessionId;
      this.commit(p);
    };
    if (!r.ok) return fail(r.error);
    const cards = this.cards(p.board, topic);
    const out = parseTurnOutput(r.output, cards);
    if (!out) return fail("The agent returned an output Nightshift could not read.");
    this.prompts.delete(key);
    delete topic.error;
    if (out.reply) topic.messages.push({ role: "agent", text: out.reply, at: nowIso() });
    topic.questions = out.questions;
    // The agent sends the whole list each turn; an empty one never erases what was settled.
    if (out.decisions.length > 0) topic.decisions = out.decisions;
    if (out.ready) this.launch(p, topic, out.notes);
    else {
      topic.status = "waiting";
      this.commit(p);
    }
    this.pump(p);
  }

  /** The user's turn: answers to open questions and/or a free message. The agent answers in the same session. */
  say(p: Project, topicId: string, answers: Record<string, string>, message: string) {
    this.requireAgents(p);
    const { topic } = this.topic(p, topicId);
    if (topic.status !== "waiting" || !topic.sessionId) throw new HttpError(409, "This topic does not wait for you");
    const picked = pickAnswers(topic.questions, answers);
    if (picked.length === 0 && !message.trim()) throw new Error("Empty message");
    const cards = this.cards(p.board, topic);
    const answered = new Set(picked.map((a) => a.question.id));
    const open = topic.questions.filter((q) => !answered.has(q.id));
    topic.messages.push({ role: "user", text: formatUserTurn(picked, message), at: nowIso() });
    topic.status = "thinking";
    this.commit(p);
    this.runTurn(p, topic, buildTurnPrompt(cards.map(cardRef), picked, open, message), topic.sessionId);
    this.pump(p);
  }

  /** The user lets the agent settle what is still open; the cards are launched when it answers. */
  finalize(p: Project, topicId: string) {
    this.requireAgents(p);
    const { topic } = this.topic(p, topicId);
    if (topic.status !== "waiting" || !topic.sessionId) throw new HttpError(409, "This topic does not wait for you");
    topic.messages.push({ role: "user", text: "", at: nowIso(), kind: "finalize" });
    topic.status = "thinking";
    this.commit(p);
    this.runTurn(p, topic, buildFinalizePrompt(this.cards(p.board, topic).map(cardRef)), topic.sessionId);
    this.pump(p);
  }

  /** Runs a failed turn again; a topic without a session is prepared from scratch. */
  retry(p: Project, topicId: string) {
    this.requireAgents(p);
    const { topic } = this.topic(p, topicId);
    if (topic.status !== "error") throw new HttpError(409, "This topic has no failed turn");
    if (!topic.sessionId) return this.prepare(p, topic);
    const prompt = this.prompts.get(this.key(p, topicId)) ?? TURN_RETRY_PROMPT;
    topic.status = topic.messages.some((m) => m.role === "agent") ? "thinking" : "preparing";
    delete topic.error;
    this.commit(p);
    this.runTurn(p, topic, prompt, topic.sessionId);
  }

  /** The user opened a topic: prepare it now, whatever the lookahead. */
  focus(p: Project, topicId: string) {
    const { topic } = this.topic(p, topicId);
    if (topic.status === "pending" && this.deps.canRun(p)) this.prepare(p, topic);
  }

  /** Leaves the cards of a topic in the Backlog. */
  skip(p: Project, topicId: string) {
    const { topic } = this.topic(p, topicId);
    if (isSettled(topic)) return;
    this.stop(p, topicId);
    delete topic.activity;
    delete topic.error;
    topic.status = "skipped";
    this.commit(p);
    this.pump(p);
  }

  /** Takes a skipped topic back; its conversation goes on where it stopped. */
  reopen(p: Project, topicId: string) {
    const { topic } = this.topic(p, topicId);
    if (topic.status !== "skipped") return;
    topic.status = topic.sessionId && topic.messages.some((m) => m.role === "agent") ? "waiting" : "pending";
    this.commit(p);
  }

  /** Launches the cards of a topic as they are, with the decisions settled so far. */
  launchTopic(p: Project, topicId: string) {
    this.requireAgents(p);
    const { topic } = this.topic(p, topicId);
    if (topic.status === "launched") return;
    this.stop(p, topicId);
    this.launch(p, topic, []);
    this.pump(p);
  }

  /**
   * Writes the decisions into the cards of a topic and sends them to the first column after the Backlog. The status
   * is set first: the board change must not make the reconcile pass drop the topic.
   */
  private launch(p: Project, topic: BriefingTopic, notes: TurnNote[]) {
    topic.status = "launched";
    topic.questions = [];
    delete topic.activity;
    delete topic.error;
    const refs: string[] = [];
    let column: string | undefined;
    try {
      p.mutate((board) => {
        for (const id of topic.cardIds) {
          const card = board.cards.find((c) => c.id === id);
          if (!card || card.columnId !== BACKLOG_COLUMN_ID) continue;
          const note = notes.find((n) => n.cardId === id);
          if (note?.title) card.title = note.title;
          const edits = parseSections(note?.sections).edits;
          const own = topic.decisions.filter((d) => d.cardIds.includes(id));
          if (own.length > 0 && !edits.some((e) => e.heading.toLowerCase() === "decisions"))
            edits.push({ heading: "Decisions", op: "replace", content: decisionsSection(own, nowIso().slice(0, 10)) });
          if (edits.length > 0 || note?.title) {
            card.description = applySections(card.description, edits).text;
            card.updatedAt = nowIso();
            p.addHistory(card, "edited", `Briefing: ${own.length} decision(s) recorded`);
          }
          // Set as a draft or given dependencies during the briefing: its note is ready, the card stays.
          if (card.draft || isHeld(card)) continue;
          const target = releaseTarget(board.columns, card);
          if (!target) continue;
          p.moveCard(board, card.id, target.id, undefined, "Briefing");
          refs.push(cardRef(card));
          column ??= target.name;
        }
      });
    } catch (e) {
      topic.status = "error";
      topic.error = `Could not launch the cards: ${errorMessage(e)}`;
      this.commit(p);
      return;
    }
    topic.launchedRefs = refs;
    if (column) topic.launchedTo = column;
    this.commit(p);
  }

  // ---- easy cards ----

  /** Sends the easy cards (all of them, or the given ones) out of the Backlog. Returns how many left. */
  launchEasy(p: Project, cardIds?: string[]): number {
    this.requireAgents(p);
    const st = this.need(p);
    const targets = st.easy.filter((e) => !e.launched && (!cardIds || cardIds.includes(e.cardId)));
    // Marked first: the board change must not make the reconcile pass drop them.
    for (const e of targets) e.launched = true;
    let moved = 0;
    try {
      p.mutate((board) => {
        for (const e of targets) {
          const card = board.cards.find((c) => c.id === e.cardId);
          if (!card || card.columnId !== BACKLOG_COLUMN_ID || card.draft || isHeld(card)) continue;
          const target = releaseTarget(board.columns, card);
          if (!target) continue;
          p.moveCard(board, card.id, target.id, undefined, "Briefing");
          moved++;
        }
      });
    } catch (e) {
      for (const t of targets) delete t.launched;
      this.commit(p);
      throw e;
    }
    this.commit(p);
    return moved;
  }

  /** The user wants to talk about an easy card first: it becomes a topic of its own. Returns the topic id. */
  discuss(p: Project, cardId: string): string {
    const st = this.need(p);
    const entry = st.easy.find((e) => e.cardId === cardId && !e.launched);
    const card = p.card(cardId);
    if (!entry || !card) throw new HttpError(404, "This card is not waiting to be launched");
    st.easy = st.easy.filter((e) => e !== entry);
    const topic = this.newTopic({ title: card.title, why: "", cardIds: [card.id], oldestAt: card.createdAt });
    st.topics = sortTopics([...st.topics, topic]);
    this.commit(p);
    return topic.id;
  }

  // ---- lifecycle ----

  /** Ends the briefing: its agents stop, its conversations are forgotten. Cards keep whatever was written to them. */
  end(p: Project) {
    for (const key of [...this.runs.keys()]) {
      if (!key.startsWith(`${p.path}::`)) continue;
      this.runs.get(key)?.cancel();
      this.runs.delete(key);
      this.prompts.delete(key);
    }
    if (!this.states.delete(p.path)) return;
    this.commit(p);
  }

  /** Coalesced like Orchestrator.scheduleTick: one pass per project per microtask, never inside an emit. */
  schedule(p: Project) {
    if (!this.states.has(p.path) || this.pending.has(p.path)) return;
    this.pending.set(p.path, p);
    queueMicrotask(() => {
      this.pending.delete(p.path);
      this.reconcile(p);
    });
  }

  /** Follows the board: a card that left the Backlog by other means leaves the briefing, an emptied topic goes with it. */
  reconcile(p: Project) {
    const st = this.states.get(p.path);
    if (!st) return;
    const inBacklog = new Set(p.board.cards.filter((c) => c.columnId === BACKLOG_COLUMN_ID).map((c) => c.id));
    let changed = false;
    const easy = st.easy.filter((e) => e.launched || inBacklog.has(e.cardId));
    if (easy.length !== st.easy.length) {
      st.easy = easy;
      changed = true;
    }
    const topics: BriefingTopic[] = [];
    for (const topic of st.topics) {
      if (topic.status === "launched") {
        topics.push(topic);
        continue;
      }
      const ids = topic.cardIds.filter((id) => inBacklog.has(id));
      if (ids.length !== topic.cardIds.length) changed = true;
      if (ids.length === 0) {
        this.stop(p, topic.id);
        continue;
      }
      topic.cardIds = ids;
      topics.push(topic);
    }
    st.topics = topics;
    if (changed) this.commit(p);
  }

  /** Stops every agent; the saved conversations stay for the next start. */
  shutdown() {
    for (const handle of this.runs.values()) handle.cancel();
    this.runs.clear();
  }
}
