import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { resolveNextColumn } from "../shared/skip.ts";
import type {
  AttentionKind,
  Board,
  Card,
  Column,
  LiveStatus,
  LogLine,
  ProjectSnapshot,
  RunProgress,
  RunStatus,
  ServerEvent,
  Settings,
} from "../shared/types.ts";
import { canSendFeedback, cardRef, columnMaxParallel, isDoneColumn } from "../shared/types.ts";
import { safeHttpUrl } from "../shared/urls.ts";
import { HttpError } from "./guard.ts";
import { parseProgressMarker, progressFromTodos } from "./progress.ts";
import { persistScreenshots } from "./screenshots.ts";
import { SequenceController } from "./sequence.ts";
import { getSettings, NIGHTSHIFT_HOME, onSettingsChange, rememberProject } from "./settings.ts";
import { findSkill } from "./skills.ts";
import { isRaw, needsRun, Project, type Raw } from "./store.ts";
import { copyTemplateSkills } from "./templates.ts";

/** One block of an assistant message in `claude -p --output-format stream-json` (only what Nightshift reads). */
interface StreamBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

/** One line of the stream-json output (only what Nightshift reads). The `result` event carries the structured output. */
interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: StreamBlock[] };
  is_error?: boolean;
  result?: unknown;
  total_cost_usd?: number;
  structured_output?: unknown;
}

/** Structured output of an agent (--json-schema). Untrusted: every field is checked before use; `questions` is normalized. */
type AgentOutput = Raw & { questions: string[] };

interface Job {
  key: string;
  project: Project;
  cardId: string;
  columnId: string;
  enteredAt: string;
  proc?: Subprocess;
  cancelled: boolean;
  done: boolean;
  /** Skill of the session this job runs (column skill for a new run, session skill when resuming). */
  skill?: string;
  /** Started in a skill column: such a job is stopped if the column stops being a skill column. */
  startedInSkillColumn: boolean;
  /** Claude session of the current process, from its init event (known even if it dies before a result). */
  sessionId?: string;
  /** Live progress of the current process; reset at each spawn, never persisted. */
  progress?: RunProgress;
  /** A valid marker was seen in the current process: TodoWrite no longer counts. */
  markerSeen?: boolean;
}

const MAX_LOG_LINES = 3000;
const LOCK_RECHECK_MS = 5000;

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
/** Safety net against skills bouncing a card between columns forever. */
const LOOP_WINDOW_MS = 10 * 60_000;
const LOOP_MAX_RUNS = 12;

export const RESULT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Updated card title. Repeat the current title if unchanged." },
    description: {
      type: "string",
      description: "Updated full card description (markdown). Repeat the current description if unchanged.",
    },
    move: {
      type: "string",
      description:
        'Where the card goes next: "next" (the next column for this card, which skips the card\'s skipped columns), "stay" (keep it here), or an explicit column id.',
    },
    summary: { type: "string", description: "One or two sentences describing what you did." },
    test: {
      type: "object",
      description:
        "Optional: how a human can try your result. command is a shell command run with sh -c from the project folder; url is where to look once it runs. Omit to keep the card's current test.",
      properties: { command: { type: "string" }, url: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    questions: {
      type: "array",
      items: { type: "string" },
      description:
        'Only when you cannot continue without human decisions: ALL the questions you need answered, in one go. Set move to "stay". The answers will resume this session.',
    },
  },
  required: ["move", "summary"],
  additionalProperties: false,
};

const PROGRESS_MARKER = "[nightshift-progress]";

/** Sent when resuming a session that stopped before returning its structured result. */
export const RECOVER_PROMPT = `Your previous run in this session stopped before returning Nightshift's structured output (it may have been interrupted, or it only returned interim results while background work was running).
Check the actual state of your work first (worktrees, branches, commits, background tasks). If work remains, finish it. Then return the structured output exactly once, describing the final state.
Progress: on resume, emit the progress marker again (a line \`${PROGRESS_MARKER} N/M label\`) at the start of the step you are on, and at each following step.`;

function formatColumns(board: Board): string {
  return board.columns
    .map((c, i) => `  ${i + 1}. ${c.name} (id: ${c.id}, ${c.type === "skill" ? `skill: ${c.skill}` : "inert"})`)
    .join("\n");
}

export function buildPrompt(board: Board, card: Card, column: Column, skillPath: string | undefined): string {
  const next = resolveNextColumn(board.columns, { columnId: column.id, skipColumnIds: card.skipColumnIds });
  const columns = formatColumns(board);
  return `You are an automated worker driven by Nightshift, a kanban board that orchestrates AI agents.
A card has landed in the column "${column.name}". Your job is to process this card by applying the skill "${column.skill}".

Invoke the skill with the Skill tool (skill name: "${column.skill}")${skillPath ? `; its definition lives at ${skillPath}` : ""}. Follow its instructions, using the card below as your input.
${column.instructions ? `\nAdditional instructions for this column:\n${column.instructions}\n` : ""}
<card id="${card.id}" ref="${cardRef(card)}">
<title>${card.title}</title>
<description>
${card.description}
</description>
</card>

Board columns, in order:
${columns}

Rules:
- Work autonomously and pick sensible defaults. Do not use the AskUserQuestion tool.
- If you truly cannot continue without human decisions, first explore everything you can on your own, then return the structured output with "questions" (and move "stay"); the answers will be sent back to you in this same session.
- Each round-trip with the user is slow: put EVERY question you need answered in that single list (self-contained, one decision per question, suggest a default when you have one). Never ask one question now and keep others for later.
- Progress: at the start, split your work into steps. At the start of each step, write a line on its own, exactly \`${PROGRESS_MARKER} N/M label\` (N = current step, M = total steps, label = short description). If the card description has a numbered \`## Progress\` section, use its numbering and total.
- Never edit nightshift.json yourself; the board is updated from your structured output.
- Never kill processes by name or pattern (pkill -f, killall, kill $(pgrep …)): other agents run on this machine and their processes can match. Only kill PIDs you started yourself.
- Return the structured output exactly once, at the very end. If you started background work (subagents, background shells), wait until all of it has finished first. Never return an interim or "in progress" result.
- When finished, return the structured output:
  - title / description: the updated card content (you may enrich the description with your results, links to files you created, etc.).
  - move: "next" to send the card to ${next ? `"${next.name}"` : "(there is no next column, so this behaves like stay)"}, "stay" to keep it in "${column.name}", or a column id.
  - summary: a short summary of what you did.
  - questions: only when you need the user's input (see above).
  - test: optional, a command (and url) a human can run to try what you produced; the card shows a "Tester" button that runs it.`;
}

/** Prompt resuming a session with free feedback from the user, in whatever column the card is now. */
export function buildFeedbackPrompt(
  board: Board,
  card: Card,
  column: Column,
  skill: string | undefined,
  skillPath: string | undefined,
): string {
  const next = resolveNextColumn(board.columns, { columnId: column.id, skipColumnIds: card.skipColumnIds });
  const skillName = skill ? `the skill "${skill}"` : "the skill you applied earlier in this session";
  return `You are an automated worker driven by Nightshift, a kanban board that orchestrates AI agents.
The user sent you feedback on the work you did earlier in this session:

<feedback>
${card.pendingAnswer?.text ?? ""}
</feedback>

Address this feedback on the card below. Follow ${skillName}${skill && skillPath ? ` (its definition lives at ${skillPath})` : ""}, as in your earlier work in this session.

<card id="${card.id}" ref="${cardRef(card)}">
<title>${card.title}</title>
<description>
${card.description}
</description>
</card>

The card may have moved since your session ran; it is now in column "${column.name}" (id: ${column.id}, ${column.type === "skill" ? `skill: ${column.skill}` : "inert"}).
${column.instructions ? `\nAdditional instructions for this column:\n${column.instructions}\n` : ""}
Board columns, in order:
${formatColumns(board)}

Rules:
- Work autonomously and pick sensible defaults. Do not use the AskUserQuestion tool.
- If you truly cannot continue without human decisions, first explore everything you can on your own, then return the structured output with "questions" (and move "stay"); the answers will be sent back to you in this same session.
- Each round-trip with the user is slow: put EVERY question you need answered in that single list (self-contained, one decision per question, suggest a default when you have one). Never ask one question now and keep others for later.
- Never edit nightshift.json yourself; the board is updated from your structured output.
- Never kill processes by name or pattern (pkill -f, killall, kill $(pgrep …)): other agents run on this machine and their processes can match. Only kill PIDs you started yourself.
- Return the structured output exactly once, at the very end. If you started background work (subagents, background shells), wait until all of it has finished first. Never return an interim or "in progress" result.
- When finished, return the structured output:
  - title / description: the updated card content.
  - move: "stay" keeps the card in "${column.name}", "next" sends it to ${next ? `"${next.name}"` : "(there is no next column, so this behaves like stay)"}, or give a column id.
  - summary: a short summary of what you did.
  - questions: only when you need the user's input (see above).
  - test: optional, a command (and url) a human can run to try what you produced.`;
}

/** Splits a shell-like argument string, honouring single and double quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!isRaw(input)) return name;
  const v = input.command ?? input.file_path ?? input.pattern ?? input.skill ?? input.url ?? input.description ?? input.query;
  return v ? `${name}: ${String(v).slice(0, 200)}` : name;
}

// Column model wins over the global setting; neither means no --model (CLI default).
/** How long shutdown() waits for agents and test commands to exit after SIGTERM before sending SIGKILL. */
const SHUTDOWN_GRACE_MS = 2000;
/** How long a finished test command may take to flush its output pipes before "Exited" is reported anyway. */
const STREAM_DRAIN_MS = 500;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour escape sequences (ESC is the point)
const ANSI_COLOR_RE = /\x1b\[[0-9;]*m/g;
const CARD_ID_RE = /^[A-Za-z0-9_-]+$/;

export function resolveModel(column: Column, settings: Settings): string | undefined {
  return column.model?.trim() || settings.model.trim() || undefined;
}

export class Orchestrator {
  private projects = new Map<string, Project>();
  /** Template skills that could not be copied into a new project, reported once by the next open response. */
  private templateFailures = new Map<string, string[]>();
  private jobs = new Map<string, Job>();
  private logs = new Map<string, LogLine[]>();
  private listeners = new Set<(e: ServerEvent) => void>();
  private tickScheduled = false;
  /** Projects whose agents are run by another live Nightshift process: path -> its pid. */
  private lockedBy = new Map<string, number>();
  private lockTimer: ReturnType<typeof setInterval>;
  /** Sequential mode state, per project. */
  readonly sequence = new SequenceController({
    isRunning: (p, cardId) => this.jobs.has(this.key(p, cardId)),
    canRunAgents: (p) => this.agents && !this.lockedBy.has(p.path),
    onState: (p) => this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) }),
    onAttention: (p, cardId) => this.broadcast({ type: "attention", project: p.path, cardId, kind: "error" }),
  });
  private tests = new Map<string, { project: Project; cardId: string; proc: ChildProcess; lines: LogLine[] }>();
  private lastTestLines = new Map<string, LogLine[]>();

  /** False for a test instance (`--no-agents`): it shows and edits boards but never runs agents nor takes locks. */
  readonly agents: boolean;

  constructor({ agents = true }: { agents?: boolean } = {}) {
    this.agents = agents;
    onSettingsChange((settings) => {
      this.broadcast({ type: "settings", settings });
      this.scheduleTick();
    });
    // Pick up projects released by another process (it exited or crashed).
    this.lockTimer = setInterval(() => {
      if (this.lockedBy.size === 0) return;
      for (const p of this.projects.values()) this.acquireLock(p);
    }, LOCK_RECHECK_MS);
    this.lockTimer.unref?.();
  }

  // ---- cross-process lock ------------------------------------------------
  // Two Nightshift processes on the same folder would each run every card. Only the lock holder runs agents;
  // the others still show and edit the board.

  private lockFile(p: Project) {
    const dir = join(NIGHTSHIFT_HOME, "locks");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${createHash("sha1").update(p.path).digest("hex").slice(0, 12)}.lock`);
  }

  private acquireLock(p: Project) {
    const file = this.lockFile(p);
    const wasLocked = this.lockedBy.has(p.path);
    let holder = 0;
    try {
      holder = Number(readFileSync(file, "utf8").trim()) || 0;
    } catch {}
    if (holder && holder !== process.pid && isAlive(holder)) {
      this.lockedBy.set(p.path, holder);
    } else {
      if (holder !== process.pid) writeFileSync(file, String(process.pid));
      this.lockedBy.delete(p.path);
    }
    if (wasLocked !== this.lockedBy.has(p.path)) {
      this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) });
      this.scheduleTick();
    }
  }

  on(fn: (e: ServerEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private broadcast(e: ServerEvent) {
    for (const l of this.listeners) l(e);
  }

  /** Returns the template skills not copied for this project, once: the list is cleared by the call. */
  takeTemplateFailures(path: string): string[] {
    const failed = this.templateFailures.get(path) ?? [];
    this.templateFailures.delete(path);
    return failed;
  }

  open(rawPath: string): Project {
    const path = resolve(rawPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    let p = this.projects.get(path);
    if (p) return p;
    if (!existsSync(path)) throw new Error(`Folder not found: ${path}`);
    p = new Project(path);
    if (p.created) {
      const { failed } = copyTemplateSkills(path);
      if (failed.length > 0) this.templateFailures.set(path, failed);
    }
    if (this.agents) this.acquireLock(p);
    this.projects.set(path, p);
    p.onChange(() => {
      this.cancelStaleJobs(p);
      this.broadcast({ type: "board", project: path, snapshot: this.snapshot(p) });
      this.scheduleTick();
      this.sequence.schedule(p);
    });
    rememberProject(path);
    this.scheduleTick();
    return p;
  }

  get(path: string): Project {
    const p = this.projects.get(resolve(path)) ?? this.open(path);
    return p;
  }

  snapshot(p: Project): ProjectSnapshot {
    const live: Record<string, LiveStatus> = {};
    for (const card of p.board.cards) {
      if (this.jobs.has(this.key(p, card.id))) live[card.id] = "running";
      else if (needsRun(p.board, card)) live[card.id] = "queued";
    }
    const lockedBy = this.lockedBy.get(p.path);
    const testing = [...this.tests.values()].filter((t) => t.project === p).map((t) => t.cardId);
    const progress: Record<string, RunProgress> = {};
    for (const card of p.board.cards) {
      const job = this.jobs.get(this.key(p, card.id));
      if (job?.progress && !job.done) progress[card.id] = job.progress;
    }
    return {
      path: p.path,
      board: p.board,
      live,
      testing,
      progress,
      sequence: this.sequence.get(p),
      ...(lockedBy ? { lockedBy } : {}),
      ...(this.agents ? {} : { agentsDisabled: true }),
    };
  }

  private key(p: Project, cardId: string) {
    return `${p.path}::${cardId}`;
  }

  // ---- logs --------------------------------------------------------------

  /** Log file of a card, or null for an id that is not a plain card id. Creates the directory only when asked. */
  private logFile(p: Project, cardId: string, create = false): string | null {
    if (!CARD_ID_RE.test(cardId)) return null;
    const dir = join(NIGHTSHIFT_HOME, "logs", createHash("sha1").update(p.path).digest("hex").slice(0, 12));
    if (create) mkdirSync(dir, { recursive: true });
    return join(dir, `${cardId}.jsonl`);
  }

  getLog(p: Project, cardId: string): LogLine[] {
    const k = this.key(p, cardId);
    const mem = this.logs.get(k);
    if (mem) return mem;
    const file = this.logFile(p, cardId);
    if (!file) return [];
    try {
      return readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  /** Drops everything kept for a deleted card: in-memory logs, last test output and the log file. */
  purgeCard(p: Project, cardId: string) {
    const k = this.key(p, cardId);
    this.logs.delete(k);
    this.lastTestLines.delete(k);
    const file = this.logFile(p, cardId);
    if (file) rmSync(file, { force: true });
  }

  private logWriteFailed = false;

  private log(p: Project, cardId: string, kind: LogLine["kind"], text: string) {
    // A deleted card keeps no log (late messages of its stopped agent would recreate the file).
    if (!p.card(cardId)) return;
    const line: LogLine = { at: new Date().toISOString(), kind, text };
    const k = this.key(p, cardId);
    const arr = this.logs.get(k) ?? [];
    arr.push(line);
    if (arr.length > MAX_LOG_LINES) arr.splice(0, arr.length - MAX_LOG_LINES);
    this.logs.set(k, arr);
    try {
      const file = this.logFile(p, cardId, true);
      if (file) appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch (e) {
      if (!this.logWriteFailed) {
        this.logWriteFailed = true;
        console.error(`Could not write the agent log (further failures are not reported): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.broadcast({ type: "log", project: p.path, cardId, line });
  }

  // ---- scheduling --------------------------------------------------------

  scheduleTick() {
    if (this.tickScheduled) return;
    this.tickScheduled = true;
    queueMicrotask(() => {
      this.tickScheduled = false;
      this.tick();
    });
  }

  private tick() {
    if (!this.agents) return;
    const max = getSettings().maxParallel;
    if (this.jobs.size >= max) return;
    const candidates: { p: Project; card: Card }[] = [];
    for (const p of this.projects.values()) {
      if (this.lockedBy.has(p.path)) continue;
      for (const card of p.board.cards) {
        if (!this.jobs.has(this.key(p, card.id)) && needsRun(p.board, card)) candidates.push({ p, card });
      }
    }
    candidates.sort((a, b) => a.card.enteredColumnAt.localeCompare(b.card.enteredColumnAt));
    let started = false;
    for (const { p, card } of candidates) {
      // Global cap over all projects: nothing else can start.
      if (this.jobs.size >= max) break;
      // Full column: this card waits, cards of other columns can still start.
      const column = p.column(card.columnId);
      if (!column) continue;
      // The per-column limit only concerns skill columns; a job in an inert column (feedback) only counts globally.
      if (column.type === "skill" && this.runningIn(p, card.columnId) >= columnMaxParallel(column)) continue;
      this.start(p, card);
      started = true;
    }
    if (started) for (const p of this.projects.values()) this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) });
  }

  private runningIn(p: Project, columnId: string) {
    let n = 0;
    for (const job of this.jobs.values()) if (job.project === p && job.columnId === columnId) n++;
    return n;
  }

  private cancelStaleJobs(p: Project) {
    for (const job of this.jobs.values()) {
      if (job.project !== p || job.cancelled || job.done) continue;
      const card = p.card(job.cardId);
      const col = card && p.column(card.columnId);
      if (
        !card ||
        card.columnId !== job.columnId ||
        card.enteredColumnAt !== job.enteredAt ||
        (job.startedInSkillColumn && col?.type !== "skill")
      ) {
        this.log(p, job.cardId, "info", "Card moved or deleted during the run: stopping agent.");
        this.kill(job);
      }
    }
  }

  private kill(job: Job) {
    job.cancelled = true;
    try {
      job.proc?.kill("SIGTERM");
      setTimeout(() => {
        if (job.proc && job.proc.exitCode === null) job.proc.kill("SIGKILL");
      }, 5000).unref?.();
    } catch {}
  }

  cancel(p: Project, cardId: string) {
    const job = this.jobs.get(this.key(p, cardId));
    if (!job) return false;
    this.log(p, cardId, "info", "Run cancelled by user.");
    this.kill(job);
    return true;
  }

  /** Forces a new run of a card in its current column. */
  retry(p: Project, cardId: string) {
    p.mutate(() => {
      const card = p.card(cardId);
      if (!card) throw new HttpError(404, "Unknown card");
      card.enteredColumnAt = new Date().toISOString();
      delete card.lastRun;
      delete card.pendingAnswer;
      p.addHistory(card, "edited", "Retry requested by user");
      p.addQueued(card);
    });
  }

  /** Stores the user's answer to the agent's question; the scheduler then resumes the session. */
  answer(p: Project, cardId: string, answers: string[]) {
    if (!answers.some((a) => a.trim())) throw new Error("Empty answer");
    let text = "";
    p.mutate(() => {
      const card = p.card(cardId);
      const lr = card?.lastRun;
      if (!card || lr?.status !== "question" || lr.columnId !== card.columnId || !lr.sessionId)
        throw new Error("This card has no pending question");
      text = (lr.questions ?? [])
        .map((q, i) => `Q${i + 1}: ${q}\nA${i + 1}: ${answers[i]?.trim() || "(no answer: use your best judgement)"}`)
        .join("\n\n");
      card.pendingAnswer = { text, sessionId: lr.sessionId, at: new Date().toISOString() };
      p.addHistory(card, "edited", `Answered ${answers.filter((a) => a.trim()).length} question(s)`);
      p.addQueued(card);
    });
  }

  /** Sends free feedback to the card's last session, whatever the column. The agent decides where the card goes. */
  feedback(p: Project, cardId: string, text: string) {
    const trimmed = (text ?? "").trim();
    if (!trimmed) throw new Error("Empty feedback");
    p.mutate(() => {
      const card = p.card(cardId);
      if (!card) throw new HttpError(404, "Unknown card");
      const live: LiveStatus | undefined = this.jobs.has(this.key(p, cardId)) ? "running" : needsRun(p.board, card) ? "queued" : undefined;
      const sessionId = card.lastRun?.sessionId;
      if (!sessionId || !canSendFeedback(card, live)) throw new Error("This card has no session to send feedback to");
      card.pendingAnswer = { text: trimmed, sessionId, at: new Date().toISOString(), kind: "feedback" };
      p.addHistory(card, "edited", "Feedback sent to agent");
    });
  }

  /** Skill of the session being resumed: the one recorded by its last run, else the skill column it ran in, else the current one. */
  private sessionSkill(p: Project, card: Card): string | undefined {
    const skillOf = (id: string | undefined) => {
      const c = id ? p.column(id) : undefined;
      return c?.type === "skill" ? c.skill : undefined;
    };
    return card.lastRun?.skill ?? skillOf(card.lastRun?.columnId) ?? skillOf(card.columnId);
  }

  /**
   * Agent runs in the loop window since the user last touched the card (create, move, edit, answer, retry).
   * Runs stopped by the guard itself are not counted, so a retry is never blocked by stale history.
   */
  /** Resumes the session of a failed run so the agent finishes its work, instead of starting over. */
  resumeSession(p: Project, cardId: string) {
    p.mutate(() => {
      const card = p.card(cardId);
      const lr = card?.lastRun;
      if (!card || !lr?.sessionId || lr.columnId !== card.columnId || lr.status === "success")
        throw new Error("This card has no interrupted session to resume");
      card.pendingAnswer = {
        text: "Resume the interrupted session",
        sessionId: lr.sessionId,
        at: new Date().toISOString(),
        kind: "resume",
      };
      p.addHistory(card, "edited", "Session resume requested by user");
      p.addQueued(card);
    });
  }

  private recentRuns(card: Card) {
    let since = new Date(Date.now() - LOOP_WINDOW_MS).toISOString();
    for (const h of card.history) {
      const byUser = h.kind === "created" || h.kind === "edited" || (h.kind === "moved" && !h.text.startsWith("Agent"));
      if (byUser && h.at > since) since = h.at;
    }
    return card.history.filter((h) => h.kind === "run" && h.at >= since && !h.text.includes("(loop guard)")).length;
  }

  private start(p: Project, card: Card) {
    const column = p.column(card.columnId);
    if (!column) return;
    const job: Job = {
      key: this.key(p, card.id),
      project: p,
      cardId: card.id,
      columnId: column.id,
      enteredAt: card.enteredColumnAt,
      skill: card.pendingAnswer ? this.sessionSkill(p, card) : column.skill,
      startedInSkillColumn: column.type === "skill",
      cancelled: false,
      done: false,
    };
    this.jobs.set(job.key, job);
    p.mutate(() => p.addHistory(card, "started", `Agent started in ${column.name}`, column.id));
    // A resumed session (answer to a question) keeps the log of the run that asked it.
    if (!card.pendingAnswer) {
      this.logs.set(job.key, []);
      try {
        const file = this.logFile(p, card.id, true);
        if (file) writeFileSync(file, "");
      } catch {}
    }
    this.run(job, card, column)
      .catch((e) => {
        // An exception inside run/finish must never become an unhandled rejection: Bun would exit the process.
        const error = e instanceof Error ? e.message : String(e);
        console.error(`Agent run failed for card ${card.id}:`, e);
        try {
          this.finish(job, "error", { error });
        } catch (e2) {
          console.error(`Could not record the failure of card ${card.id}:`, e2);
        }
      })
      .finally(() => {
        this.jobs.delete(job.key);
        this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) });
        this.scheduleTick();
        this.sequence.schedule(p);
      });
  }

  private async run(job: Job, card: Card, column: Column) {
    const p = job.project;
    if (this.recentRuns(card) >= LOOP_MAX_RUNS) {
      return this.finish(job, "error", {
        error: `Stopped: ${LOOP_MAX_RUNS} agent runs in 10 minutes without user action (loop guard). Click retry to run again.`,
      });
    }
    const answer = card.pendingAnswer;
    // A new run needs its column's skill; a resumed session only uses it to tell the agent where the definition lives.
    const skill = job.skill ? findSkill(p.path, job.skill) : undefined;
    if (!answer && !skill) {
      return this.finish(job, "error", { error: `Skill "${column.skill}" not found in project or user skills.` });
    }
    const skillRef = job.skill ? `the skill "${job.skill}"` : "the skill you applied earlier in this session";
    let prompt = !answer
      ? buildPrompt(p.board, card, column, skill?.path)
      : answer.kind === "resume"
        ? RECOVER_PROMPT
        : answer.kind === "feedback"
          ? buildFeedbackPrompt(p.board, card, column, job.skill, skill?.path)
          : `The user answered your questions:\n\n${answer.text}\n\nRe-emit the progress marker (\`${PROGRESS_MARKER} N/M label\`) as you resume and at each step. Continue processing the card "${card.title}" with ${skillRef}, then return the structured output as before (title, description, move, summary). Only ask new questions if the answers raise new blocking decisions, and then ask them all at once.`;
    if (answer?.kind === "feedback") this.log(p, card.id, "info", `Retour utilisateur : ${answer.text}`);
    else if (answer && answer.kind !== "resume") this.log(p, card.id, "info", `User answer: ${answer.text}`);
    let resumeId = answer?.sessionId;
    let costUsd = 0;

    // One automatic recovery: an agent that stops without its structured result (interrupted, or it
    // returned only interim results while background work was running) is resumed once to collect it.
    for (let attempt = 0; ; attempt++) {
      const verb = attempt > 0 ? "Recovering" : !answer ? "Starting" : "Resuming";
      const r = await this.spawnAgent(job, card, column, prompt, resumeId, verb);
      if ("startError" in r) return this.finish(job, "error", { error: r.startError });
      if (job.cancelled) return this.finish(job, "cancelled", {});
      const result = r.result;
      costUsd += Number(result?.total_cost_usd) || 0;
      const sessionId: string | undefined = result?.session_id ?? job.sessionId;
      const out = result?.structured_output;
      if (result && !result.is_error && isRaw(out)) {
        const questions = Array.isArray(out.questions)
          ? out.questions
              .map(String)
              .map((q) => q.trim())
              .filter(Boolean)
          : [];
        const output: AgentOutput = { ...out, questions };
        return this.finish(job, questions.length > 0 ? "question" : "success", {
          output,
          costUsd,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      const reason = !result
        ? `Agent exited without a result (${r.exit}).${r.stderr.trim() ? ` ${r.stderr.trim()}` : ""}`
        : result.is_error
          ? String(result.result || result.subtype || "Agent returned an error")
          : "Agent finished without returning its structured result.";
      if (attempt === 0 && sessionId && !result?.is_error) {
        this.log(p, card.id, "info", `${reason} Resuming the session once to collect it.`);
        prompt = RECOVER_PROMPT;
        resumeId = sessionId;
        continue;
      }
      return this.finish(job, "error", {
        error: reason.slice(0, 2000),
        ...(costUsd ? { costUsd } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
    }
  }

  /** Runs one `claude -p` process to completion. The prompt goes through stdin, never argv: see below. */
  private async spawnAgent(
    job: Job,
    card: Card,
    column: Column,
    prompt: string,
    resumeId: string | undefined,
    verb: string,
  ): Promise<{ startError: string } | { result: StreamEvent | null; stderr: string; exit: string }> {
    const p = job.project;
    job.progress = undefined;
    job.markerSeen = false;
    const settings = getSettings();
    const model = resolveModel(column, settings);
    // The prompt holds the card text. Passed as an argument it would show in every process list, and an
    // agent running `pkill -f "bun test"` would kill any sibling agent whose card mentions `bun test`.
    const args = [
      settings.claudePath || "claude",
      "-p",
      ...(resumeId ? ["--resume", resumeId] : []),
      "--disallowedTools",
      "AskUserQuestion",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      JSON.stringify(RESULT_SCHEMA),
      "--permission-mode",
      settings.permissionMode,
      "--name",
      `nightshift: ${card.title}`.slice(0, 80),
      ...(model ? ["--model", model] : []),
      ...splitArgs(settings.extraArgs),
    ];
    this.log(
      p,
      card.id,
      "info",
      `${verb} ${job.skill ? `skill "${job.skill}"` : "session"} in "${column.name}" (permission mode: ${settings.permissionMode}, model: ${model ?? "default"}).`,
    );

    let result: StreamEvent | null = null;
    let stderr = "";
    try {
      const proc = Bun.spawn(args, {
        cwd: p.path,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: new TextEncoder().encode(prompt),
      });
      job.proc = proc;
      if (job.cancelled) proc.kill();
      const readStderr = new Response(proc.stderr).text().then((t) => (stderr = t));
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: StreamEvent;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!isRaw(parsed)) throw new Error("not an event");
            ev = parsed as StreamEvent;
          } catch {
            this.log(p, card.id, "text", line);
            continue;
          }
          if (ev.type === "result") result = ev;
          else this.handleEvent(job, ev);
        }
      }
      await proc.exited;
      await readStderr;
      const exit = proc.signalCode ? `signal ${proc.signalCode}` : `exit code ${proc.exitCode}`;
      return { result, stderr, exit };
    } catch (e) {
      return { startError: `Could not start "${settings.claudePath}": ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  private handleEvent(job: Job, ev: StreamEvent) {
    const p = job.project;
    const cardId = job.cardId;
    if (ev.type === "assistant") {
      // Subagent messages carry parent_tool_use_id: they are logged but never drive the card's progress.
      const own = !ev.parent_tool_use_id;
      for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (block.type === "text" && block.text?.trim()) {
          this.log(p, cardId, "text", block.text.trim());
          const m = own ? parseProgressMarker(block.text) : undefined;
          if (m) {
            job.markerSeen = true;
            this.setProgress(job, m, "marker");
          }
        } else if (block.type === "tool_use" && block.name !== "StructuredOutput") {
          this.log(p, cardId, "tool", summarizeToolInput(block.name ?? "tool", block.input));
          if (own && block.name === "TodoWrite" && !job.markerSeen) {
            const t = progressFromTodos(block.input);
            if (t) this.setProgress(job, t, "todo");
          }
        }
      }
    } else if (ev.type === "system" && ev.subtype === "init") {
      if (ev.session_id) job.sessionId = ev.session_id;
      this.log(p, cardId, "info", `Session ${ev.session_id} (model ${ev.model ?? "default"})`);
    }
  }

  /** Stores a new progress value and broadcasts the board, unless nothing changed. */
  private setProgress(job: Job, v: { step: number; total: number; label: string }, source: RunProgress["source"]) {
    const cur = job.progress;
    if (cur && cur.step === v.step && cur.total === v.total && cur.label === v.label) return;
    job.progress = { step: v.step, total: v.total, label: v.label, source, at: new Date().toISOString() };
    this.broadcast({ type: "board", project: job.project.path, snapshot: this.snapshot(job.project) });
  }

  private finish(job: Job, status: RunStatus, data: { output?: AgentOutput; error?: string; costUsd?: number; sessionId?: string }) {
    const p = job.project;
    job.done = true;
    const card = p.card(job.cardId);
    if (!card || card.columnId !== job.columnId || card.enteredColumnAt !== job.enteredAt) {
      this.log(p, job.cardId, "info", "Result discarded: the card changed column during the run.");
      return;
    }
    if (data.error) this.log(p, job.cardId, "error", data.error);
    // Decided inside the mutation, broadcast only once it has been applied.
    let attention: AttentionKind | undefined = status === "error" ? "error" : status === "question" ? "question" : undefined;
    p.mutate((board) => {
      const now = new Date().toISOString();
      const out = data.output;
      // A resumed run that dies without a session id (cancelled, failed to start) keeps the session it resumed,
      // so feedback or answers can be sent again.
      const sessionId = data.sessionId ?? (card.pendingAnswer ? (job.sessionId ?? card.pendingAnswer.sessionId) : undefined);
      delete card.pendingAnswer;
      card.lastRun = {
        columnId: job.columnId,
        status,
        at: now,
        ...(out?.summary ? { summary: String(out.summary) } : {}),
        ...(status === "question" ? { questions: out?.questions ?? [] } : {}),
        ...(data.error ? { error: data.error } : {}),
        ...(data.costUsd !== undefined ? { costUsd: data.costUsd } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(job.skill ? { skill: job.skill } : {}),
      };
      const colName = p.column(job.columnId)?.name ?? "?";
      p.addHistory(
        card,
        "run",
        status === "success"
          ? `${colName}: ${out?.summary ?? "done"}`
          : status === "question"
            ? `${colName}: ${out?.questions.length ?? 0} question(s) for the user`
            : `${colName}: ${status}${data.error ? ` (${data.error.slice(0, 200)})` : ""}`,
      );
      if ((status !== "success" && status !== "question") || !out) return;
      if (typeof out.title === "string" && out.title.trim()) card.title = out.title.trim();
      if (typeof out.description === "string") card.description = persistScreenshots(card.id, out.description);
      if (isRaw(out.test) && typeof out.test.command === "string" && out.test.command.trim()) {
        // A url from the agent is only kept when it is a plain http(s) URL (it ends up in a link).
        const testUrl = typeof out.test.url === "string" ? safeHttpUrl(out.test.url.trim()) : null;
        card.test = { command: out.test.command.trim(), ...(testUrl ? { url: testUrl } : {}) };
      }
      card.updatedAt = now;
      if (status === "question") {
        out.questions.forEach((q, i) => {
          this.log(p, job.cardId, "info", `Question ${i + 1}: ${q}`);
        });
        return;
      }
      this.log(p, job.cardId, "info", `Done: ${out.summary ?? ""}`);
      const move = String(out.move ?? "stay").trim();
      let target: Column | undefined;
      if (move === "next") target = p.nextColumnFor(card);
      else if (move !== "stay") target = board.columns.find((c) => c.id === move || c.name === move);
      if (target && target.id !== card.columnId) {
        p.moveCard(board, card.id, target.id, undefined, "Agent");
        this.log(p, job.cardId, "info", `Moved to "${target.name}".`);
        if (target.type === "inert" && !isDoneColumn(target)) attention = "inert";
      }
    });
    if (attention) this.broadcast({ type: "attention", project: p.path, cardId: job.cardId, kind: attention });
  }

  // ---- test commands -------------------------------------------------------
  // A card's test command (e.g. run the app from the card's worktree) is started and stopped by the user.
  // It runs in its own process group so stopping it also stops what it launched.

  testLog(p: Project, cardId: string): LogLine[] {
    const key = this.key(p, cardId);
    return this.tests.get(key)?.lines ?? this.lastTestLines.get(key) ?? [];
  }

  private testLine(p: Project, cardId: string, lines: LogLine[], kind: LogLine["kind"], text: string) {
    const line: LogLine = { at: new Date().toISOString(), kind, text };
    lines.push(line);
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
    this.broadcast({ type: "testlog", project: p.path, cardId, line });
  }

  startTest(p: Project, cardId: string) {
    const card = p.card(cardId);
    if (!card?.test) throw new Error("This card has no test command");
    const key = this.key(p, cardId);
    if (this.tests.has(key)) throw new Error("The test is already running");
    const lines: LogLine[] = [];
    const proc = spawn("sh", ["-c", card.test.command], { cwd: p.path, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const entry = { project: p, cardId, proc, lines };
    this.tests.set(key, entry);
    this.testLine(p, cardId, lines, "info", `$ ${card.test.command}`);
    const ended: Promise<void>[] = [];
    for (const [stream, kind] of [
      [proc.stdout, "text"],
      [proc.stderr, "error"],
    ] as const) {
      let buf = "";
      const emit = (raw: string) => {
        const line = raw.replace(ANSI_COLOR_RE, "");
        if (line.trim()) this.testLine(p, cardId, lines, kind, line);
      };
      stream?.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          emit(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      // The last line has no trailing newline (printf, final error message): flush it when the stream ends.
      if (stream)
        ended.push(
          new Promise((resolve) => {
            stream.on("end", () => {
              emit(buf);
              buf = "";
              resolve();
            });
            stream.on("error", () => resolve());
          }),
        );
    }
    const done = (text: string) => {
      if (this.tests.get(key) !== entry) return;
      this.testLine(p, cardId, lines, "info", text);
      this.tests.delete(key);
      this.lastTestLines.set(key, lines);
      this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) });
    };
    proc.on("error", (e) => done(`Could not start: ${e.message}`));
    proc.on("exit", (code, signal) => {
      // Let the streams drain so the "Exited" line comes after the last output; a background child holding the pipes cannot block it.
      const drained = Promise.race([Promise.all(ended), new Promise((r) => setTimeout(r, STREAM_DRAIN_MS).unref?.())]);
      void drained.then(() => done(`Exited (${signal ?? `code ${code}`}).`));
    });
    this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) });
  }

  stopTest(p: Project, cardId: string) {
    const pid = this.tests.get(this.key(p, cardId))?.proc.pid;
    if (!pid) return false;
    const signal = (s: NodeJS.Signals) => {
      try {
        process.kill(-pid, s);
      } catch {}
    };
    signal("SIGTERM");
    setTimeout(() => this.tests.has(this.key(p, cardId)) && signal("SIGKILL"), 3000).unref?.();
    return true;
  }

  /**
   * Stops every agent and test command: SIGTERM, a short grace period, then SIGKILL for whatever is left.
   * The caller must await it before exiting the process, otherwise a process that ignores SIGTERM would be orphaned.
   */
  async shutdown(graceMs = SHUTDOWN_GRACE_MS) {
    clearInterval(this.lockTimer);
    const groups = [...this.tests.values()].map((t) => t.proc.pid).filter((pid): pid is number => !!pid);
    const jobs = [...this.jobs.values()];
    for (const t of this.tests.values()) this.stopTest(t.project, t.cardId);
    for (const job of jobs) this.kill(job);
    const groupAlive = (pid: number) => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const jobAlive = (job: Job) => !!job.proc && job.proc.exitCode === null && job.proc.signalCode === null;
    const end = Date.now() + graceMs;
    while (Date.now() < end && (groups.some(groupAlive) || jobs.some(jobAlive))) await new Promise((r) => setTimeout(r, 25));
    for (const pid of groups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
    for (const job of jobs) {
      try {
        if (jobAlive(job)) job.proc?.kill("SIGKILL");
      } catch {}
    }
    for (const p of this.projects.values()) {
      p.close();
      if (!this.lockedBy.has(p.path)) rmSync(this.lockFile(p), { force: true });
    }
  }
}
