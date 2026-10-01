import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import type { Board, Card, Column, LiveStatus, LogLine, ProjectSnapshot, RunStatus, ServerEvent } from "../shared/types.ts";
import { cardRef } from "../shared/types.ts";
import { getSettings, NIGHTSHIFT_HOME, onSettingsChange, rememberProject } from "./settings.ts";
import { needsRun, Project } from "./store.ts";
import { findSkill } from "./skills.ts";

interface Job {
  key: string;
  project: Project;
  cardId: string;
  columnId: string;
  enteredAt: string;
  proc?: Subprocess;
  cancelled: boolean;
  done: boolean;
}

const MAX_LOG_LINES = 3000;
const LOCK_RECHECK_MS = 5000;

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
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
      description: 'Where the card goes next: "next" (following column), "stay" (keep it here), or an explicit column id.',
    },
    summary: { type: "string", description: "One or two sentences describing what you did." },
    questions: {
      type: "array",
      items: { type: "string" },
      description:
        "Only when you cannot continue without human decisions: ALL the questions you need answered, in one go. Set move to \"stay\". The answers will resume this session.",
    },
  },
  required: ["move", "summary"],
  additionalProperties: false,
};

export function buildPrompt(board: Board, card: Card, column: Column, skillPath: string | undefined): string {
  const idx = board.columns.findIndex((c) => c.id === column.id);
  const next = board.columns[idx + 1];
  const columns = board.columns
    .map((c, i) => `  ${i + 1}. ${c.name} (id: ${c.id}, ${c.type === "skill" ? `skill: ${c.skill}` : "inert"})`)
    .join("\n");
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
- Never edit nightshift.json yourself; the board is updated from your structured output.
- When finished, return the structured output:
  - title / description: the updated card content (you may enrich the description with your results, links to files you created, etc.).
  - move: "next" to send the card to ${next ? `"${next.name}"` : "(there is no next column, so this behaves like stay)"}, "stay" to keep it in "${column.name}", or a column id.
  - summary: a short summary of what you did.
  - questions: only when you need the user's input (see above).`;
}

/** Splits a shell-like argument string, honouring single and double quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return name;
  const v = input.command ?? input.file_path ?? input.pattern ?? input.skill ?? input.url ?? input.description ?? input.query;
  return v ? `${name}: ${String(v).slice(0, 200)}` : name;
}

export class Orchestrator {
  private projects = new Map<string, Project>();
  private jobs = new Map<string, Job>();
  private logs = new Map<string, LogLine[]>();
  private listeners = new Set<(e: ServerEvent) => void>();
  private tickScheduled = false;
  /** Projects whose agents are run by another live Nightshift process: path -> its pid. */
  private lockedBy = new Map<string, number>();
  private lockTimer: ReturnType<typeof setInterval>;

  constructor() {
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

  open(rawPath: string): Project {
    const path = resolve(rawPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    let p = this.projects.get(path);
    if (p) return p;
    if (!existsSync(path)) throw new Error(`Folder not found: ${path}`);
    p = new Project(path);
    this.acquireLock(p);
    this.projects.set(path, p);
    p.onChange(() => {
      this.cancelStaleJobs(p!);
      this.broadcast({ type: "board", project: path, snapshot: this.snapshot(p!) });
      this.scheduleTick();
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
    return { path: p.path, board: p.board, live, ...(lockedBy ? { lockedBy } : {}) };
  }

  private key(p: Project, cardId: string) {
    return `${p.path}::${cardId}`;
  }

  // ---- logs --------------------------------------------------------------

  private logFile(p: Project, cardId: string) {
    const dir = join(NIGHTSHIFT_HOME, "logs", createHash("sha1").update(p.path).digest("hex").slice(0, 12));
    mkdirSync(dir, { recursive: true });
    return join(dir, `${cardId}.jsonl`);
  }

  getLog(p: Project, cardId: string): LogLine[] {
    const k = this.key(p, cardId);
    const mem = this.logs.get(k);
    if (mem) return mem;
    try {
      return readFileSync(this.logFile(p, cardId), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  private log(p: Project, cardId: string, kind: LogLine["kind"], text: string) {
    const line: LogLine = { at: new Date().toISOString(), kind, text };
    const k = this.key(p, cardId);
    const arr = this.logs.get(k) ?? [];
    arr.push(line);
    if (arr.length > MAX_LOG_LINES) arr.splice(0, arr.length - MAX_LOG_LINES);
    this.logs.set(k, arr);
    try {
      appendFileSync(this.logFile(p, cardId), JSON.stringify(line) + "\n");
    } catch {}
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
      if (this.jobs.size >= max) break;
      this.start(p, card);
      started = true;
    }
    if (started) for (const p of this.projects.values()) this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) });
  }

  private cancelStaleJobs(p: Project) {
    for (const job of this.jobs.values()) {
      if (job.project !== p || job.cancelled || job.done) continue;
      const card = p.card(job.cardId);
      const col = card && p.column(card.columnId);
      if (!card || card.columnId !== job.columnId || card.enteredColumnAt !== job.enteredAt || col?.type !== "skill") {
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
      }, 5000);
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
      if (!card) throw new Error("Unknown card");
      card.enteredColumnAt = new Date().toISOString();
      delete card.lastRun;
      delete card.pendingAnswer;
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
    });
  }

  private recentRuns(card: Card) {
    const since = new Date(Date.now() - LOOP_WINDOW_MS).toISOString();
    return card.history.filter((h) => h.kind === "run" && h.at > since).length;
  }

  private start(p: Project, card: Card) {
    const column = p.column(card.columnId)!;
    const job: Job = {
      key: this.key(p, card.id),
      project: p,
      cardId: card.id,
      columnId: column.id,
      enteredAt: card.enteredColumnAt,
      cancelled: false,
      done: false,
    };
    this.jobs.set(job.key, job);
    // A resumed session (answer to a question) keeps the log of the run that asked it.
    if (!card.pendingAnswer) {
      this.logs.set(job.key, []);
      try {
        writeFileSync(this.logFile(p, card.id), "");
      } catch {}
    }
    this.run(job, card, column).finally(() => {
      this.jobs.delete(job.key);
      this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) });
      this.scheduleTick();
    });
  }

  private async run(job: Job, card: Card, column: Column) {
    const p = job.project;
    if (this.recentRuns(card) >= LOOP_MAX_RUNS) {
      return this.finish(job, "error", { error: `Stopped: more than ${LOOP_MAX_RUNS} runs in 10 minutes (loop guard).` });
    }
    const skill = findSkill(p.path, column.skill!);
    if (!skill) {
      return this.finish(job, "error", { error: `Skill "${column.skill}" not found in project or user skills.` });
    }
    const settings = getSettings();
    const answer = card.pendingAnswer;
    const prompt = answer
      ? `The user answered your questions:\n\n${answer.text}\n\nContinue processing the card "${card.title}" with the skill "${column.skill}", then return the structured output as before (title, description, move, summary). Only ask new questions if the answers raise new blocking decisions, and then ask them all at once.`
      : buildPrompt(p.board, card, column, skill.path);
    if (answer) this.log(p, card.id, "info", `User answer: ${answer.text}`);
    const args = [
      settings.claudePath || "claude",
      "-p",
      prompt,
      ...(answer ? ["--resume", answer.sessionId] : []),
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
      ...(settings.model ? ["--model", settings.model] : []),
      ...splitArgs(settings.extraArgs),
    ];
    this.log(p, card.id, "info", `${answer ? "Resuming" : "Starting"} skill "${column.skill}" in "${column.name}" (permission mode: ${settings.permissionMode}).`);

    let result: any = null;
    let stderr = "";
    try {
      const proc = Bun.spawn(args, { cwd: p.path, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      job.proc = proc;
      if (job.cancelled) proc.kill();
      const readStderr = new Response(proc.stderr).text().then((t) => (stderr = t));
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            this.log(p, card.id, "text", line);
            continue;
          }
          if (ev.type === "result") result = ev;
          else this.handleEvent(p, card.id, ev);
        }
      }
      await proc.exited;
      await readStderr;
    } catch (e: any) {
      return this.finish(job, "error", { error: `Could not start "${settings.claudePath}": ${e?.message ?? e}` });
    }

    if (job.cancelled) return this.finish(job, "cancelled", {});
    if (!result) {
      return this.finish(job, "error", { error: (stderr.trim() || "Agent exited without a result.").slice(0, 2000) });
    }
    const out = result.structured_output;
    if (result.is_error || !out) {
      return this.finish(job, "error", {
        error: String(result.result || result.subtype || "Agent returned an error").slice(0, 2000),
        costUsd: result.total_cost_usd,
        sessionId: result.session_id,
      });
    }
    const questions = Array.isArray(out.questions) ? out.questions.map(String).map((q: string) => q.trim()).filter(Boolean) : [];
    out.questions = questions;
    const asked = questions.length > 0;
    this.finish(job, asked ? "question" : "success", { output: out, costUsd: result.total_cost_usd, sessionId: result.session_id });
  }

  private handleEvent(p: Project, cardId: string, ev: any) {
    if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) this.log(p, cardId, "text", block.text.trim());
        else if (block.type === "tool_use" && block.name !== "StructuredOutput")
          this.log(p, cardId, "tool", summarizeToolInput(block.name, block.input));
      }
    } else if (ev.type === "system" && ev.subtype === "init") {
      this.log(p, cardId, "info", `Session ${ev.session_id} (model ${ev.model ?? "default"})`);
    }
  }

  private finish(
    job: Job,
    status: RunStatus,
    data: { output?: any; error?: string; costUsd?: number; sessionId?: string },
  ) {
    const p = job.project;
    job.done = true;
    const card = p.card(job.cardId);
    if (!card || card.columnId !== job.columnId || card.enteredColumnAt !== job.enteredAt) {
      this.log(p, job.cardId, "info", "Result discarded: the card changed column during the run.");
      return;
    }
    if (data.error) this.log(p, job.cardId, "error", data.error);
    p.mutate((board) => {
      const now = new Date().toISOString();
      const out = data.output;
      delete card.pendingAnswer;
      card.lastRun = {
        columnId: job.columnId,
        status,
        at: now,
        ...(out?.summary ? { summary: String(out.summary) } : {}),
        ...(status === "question" ? { questions: out.questions as string[] } : {}),
        ...(data.error ? { error: data.error } : {}),
        ...(data.costUsd !== undefined ? { costUsd: data.costUsd } : {}),
        ...(data.sessionId ? { sessionId: data.sessionId } : {}),
      };
      const colName = p.column(job.columnId)?.name ?? "?";
      p.addHistory(
        card,
        "run",
        status === "success"
          ? `${colName}: ${out?.summary ?? "done"}`
          : status === "question"
            ? `${colName}: ${out.questions.length} question(s) for the user`
            : `${colName}: ${status}${data.error ? ` (${data.error.slice(0, 200)})` : ""}`,
      );
      if ((status !== "success" && status !== "question") || !out) return;
      if (typeof out.title === "string" && out.title.trim()) card.title = out.title.trim();
      if (typeof out.description === "string") card.description = out.description;
      card.updatedAt = now;
      if (status === "question") {
        out.questions.forEach((q: string, i: number) => this.log(p, job.cardId, "info", `Question ${i + 1}: ${q}`));
        return;
      }
      this.log(p, job.cardId, "info", `Done: ${out.summary ?? ""}`);
      const move = String(out.move ?? "stay").trim();
      let target: Column | undefined;
      if (move === "next") target = p.nextColumn(job.columnId);
      else if (move !== "stay") target = board.columns.find((c) => c.id === move || c.name === move);
      if (target && target.id !== card.columnId) {
        p.moveCard(board, card.id, target.id, undefined, "Agent");
        this.log(p, job.cardId, "info", `Moved to "${target.name}".`);
      }
    });
  }

  shutdown() {
    clearInterval(this.lockTimer);
    for (const job of this.jobs.values()) this.kill(job);
    for (const p of this.projects.values()) {
      p.close();
      if (!this.lockedBy.has(p.path)) rmSync(this.lockFile(p), { force: true });
    }
  }
}
