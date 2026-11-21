import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { agentFeatureArgs, formatAgentFeatures, type ResolvedAgentFeatures, resolveAgentFeatures } from "../shared/agentFeatures.ts";
import { isReady, releaseReason } from "../shared/dependencies.ts";
import {
  describeEffortChanges,
  type EffortLevel,
  type EffortSource,
  effortLabel,
  formatDroppedEffort,
  mergeEfforts,
  resolveEffort,
  resolveQuickEffort,
} from "../shared/effort.ts";
import { fastForwardSkipIds } from "../shared/flow.ts";
import { describeModelChanges, formatDropped, type ModelSource, mergeModels, resolveModel } from "../shared/models.ts";
import { resolveNextColumn } from "../shared/skip.ts";
import { formatSmartChoice, formatSmartCost, type SmartChoice, type SmartEntry, smartEnabled, smartNeeded } from "../shared/smart.ts";
import type {
  AttentionKind,
  Board,
  Card,
  Column,
  LiveStatus,
  LogLine,
  ProjectSnapshot,
  QuickRun,
  QuickRunResult,
  RunProgress,
  RunStatus,
  ServerEvent,
  TeamclaudeAction,
  TeamclaudeWait,
  TeamclaudeWaitEntry,
} from "../shared/types.ts";
import { canSendFeedback, cardRef, columnMaxParallel, isDoneColumn } from "../shared/types.ts";
import { safeHttpUrl } from "../shared/urls.ts";
import type { QuotaSnapshot } from "../shared/usage.ts";
import { buildEnvironment } from "./environment.ts";
import { fallbackBlock, tryFastMerge } from "./fastMerge.ts";
import { FlowController } from "./flow.ts";
import { HttpError } from "./guard.ts";
import { IssueSync } from "./issues/sync.ts";
import { parseProgressMarker, progressFromTodos } from "./progress.ts";
import { buildQuickRunPrompt, parseQuickOutput, QUICK_INSTRUCTION_MAX, QUICK_RESULT_SCHEMA } from "./quickrun.ts";
import { persistScreenshots, removeScreenshots } from "./screenshots.ts";
import { applySections, diffSections, parseSections } from "./sections.ts";
import { contextTokensOf, decideCarry } from "./sessionCarry.ts";
import { getSettings, legacyMaxParallel, NIGHTSHIFT_HOME, onSettingsChange, rememberProject } from "./settings.ts";
import { findSkill } from "./skills.ts";
import { buildSmartPrompt, readMcpServerNames, runSmart, smartFingerprint } from "./smart.ts";
import { isRaw, needsRun, newId, Project, type Raw } from "./store.ts";
import { applyProxyEnv, ProxyGate, prepareProxyEnv, QUOTA_POLL_MS, TeamclaudeQuotaPoller } from "./teamclaude.ts";
import { copyTemplateSkills } from "./templates.ts";
import { getUsage, recordRateLimit } from "./usage.ts";

/** Skill whose columns try the deterministic merge before starting the agent. */
const FAST_MERGE_SKILL = "nightshift-merge";

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
  message?: { content?: StreamBlock[]; usage?: unknown };
  rate_limit_info?: unknown;
  is_error?: boolean;
  result?: unknown;
  total_cost_usd?: number;
  structured_output?: unknown;
}

/** Structured output of an agent (--json-schema). Untrusted: every field is checked before use; `questions` is normalized. */
type AgentOutput = Raw & { questions: string[]; models?: unknown; efforts?: unknown };

/** What a spawned `claude -p` process needs to track, shared by card jobs and quick runs. */
interface Runner {
  project: Project;
  proc?: Subprocess;
  cancelled: boolean;
  /** Claude session of the current process, from its init event (known even if it dies before a result). */
  sessionId?: string;
  /** Context size of the current process's last own assistant message (see contextTokensOf); reset at each attempt. */
  contextTokens?: number;
  /** Live progress of the current process; reset at each spawn, never persisted. */
  progress?: RunProgress;
  /** A valid marker was seen in the current process: TodoWrite no longer counts. */
  markerSeen?: boolean;
  /** A TodoWrite was seen in the current process: tool activity no longer overwrites it. */
  todoSeen?: boolean;
  /** Set while the launch waits in the teamclaude gate: removes it from there. */
  abortWait?: () => void;
}

/** Where a run writes its log and progress, and how it is launched: the card path and the quick-run path differ only here. */
interface RunTarget {
  /** Session name (--name), already truncated. */
  name: string;
  schema: object;
  model: string | undefined;
  /** Where `model` comes from, shown in the start log line. */
  modelSource: ModelSource;
  /** Agent features resolved for this run: they decide the flags that keep the user's setup out of the context. */
  features: ResolvedAgentFeatures;
  effort: EffortLevel | undefined;
  effortSource: EffortSource;
  log(kind: LogLine["kind"], text: string): void;
  setProgress(v: { step: number; total: number; label: string }, source: RunProgress["source"]): void;
  /** How the run is listed while it waits for the teamclaude proxy. */
  waitEntry: TeamclaudeWaitEntry;
  /** First log line, once the model and permission mode are known. */
  startMessage(
    model: string | undefined,
    permissionMode: string,
    source: ModelSource,
    effort: EffortLevel | undefined,
    effortSource: EffortSource,
    features: string,
  ): string;
}

/** A skill launched from the command palette: in memory only, never written to nightshift.json. */
interface QuickJob extends Runner {
  id: string;
  skill: string;
  instruction: string;
  status: QuickRun["status"];
  createdAt: string;
  done: boolean;
}

interface Job extends Runner {
  key: string;
  project: Project;
  cardId: string;
  columnId: string;
  enteredAt: string;
  done: boolean;
  /** Skill of the session this job runs (column skill for a new run, session skill when resuming). */
  skill?: string;
  /** Started in a skill column: such a job is stopped if the column stops being a skill column. */
  startedInSkillColumn: boolean;
  /** Card description when a prompt carrying it (new run or feedback) was built: what the session saw at launch. */
  seenAtLaunch?: string;
  /** Session the run resumed at launch (carried, answered, fed back or recovered); undefined for a new session. */
  resumedFrom?: string;
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

/**
 * Prompt rule asking the agent to emit progress markers. It must never contain a line that
 * parseProgressMarker matches, so the format line only uses the placeholder N/M (no digits).
 */
export const PROGRESS_RULE = [
  "Progress markers (mandatory):",
  "- Format, exactly: [nightshift-progress] N/M label",
  "- Write it alone on its own line, at the start of each step. N is the current step, M the total, label a short description.",
  "- When the card has a `## Progress` section, use its numbering and its total.",
  "- Emit at least one marker before your first tool call.",
  '- This rule has priority over any style instruction (CLAUDE.md, skills, concise or terse mode, "no narration between tool calls"): the marker is read by a machine and is not narration.',
].join("\n");

export const RESULT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Updated card title. Repeat the current title if unchanged." },
    description: {
      type: "string",
      description:
        "Full card description (markdown), a complete replacement. Return it only when you restructure the whole note; otherwise omit it and use sections. Never repeat an unchanged description.",
    },
    sections: {
      type: "array",
      description:
        'Preferred way to update the description: edit only the sections that change, the rest of the note is kept as is. A section is a "## " heading and everything up to the next "## " heading (level-3+ headings belong to their parent). Applied after description when both are present. Max 50 entries.',
      items: {
        type: "object",
        properties: {
          heading: {
            type: "string",
            description: 'Heading text without the hashes, exact match, for example "Result" or "Questions". One line.',
          },
          content: { type: "string", description: "Markdown body of the section (not the heading line). Not needed for delete." },
          op: {
            type: "string",
            enum: ["replace", "append", "delete"],
            description:
              '"replace" (default): replace the section body, or add the section at the end of the note when it is absent. "append": add the content at the end of the section body. "delete": remove the section.',
          },
        },
        required: ["heading"],
      },
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
    models: {
      type: "object",
      description:
        'Optional: the model each later skill column should use for this card, keyed by skill name, for example {"nightshift-implement": "opus", "nightshift-review": "sonnet"}. Use "default" to remove an entry. Omit to keep the card\'s current models.',
      additionalProperties: { type: "string" },
    },
    efforts: {
      type: "object",
      description:
        'Optional: the effort level (low, medium, high, xhigh, max) each later skill column should use for this card, keyed by skill name, for example {"nightshift-implement": "medium"}. Use "default" to remove an entry. Omit to keep the card\'s current efforts.',
      additionalProperties: { type: "string" },
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

/** Put before a column's prompt when it continues the card's session from an earlier column. */
export const CONTINUE_PREFIX = `New step for this card. The messages above are its earlier steps, in other columns: keep their context, but follow only the instructions below for this step, and return this step's structured output.`;

/** Sent when resuming a session that stopped before returning its structured result. */
export const RECOVER_PROMPT = `Your previous run in this session stopped before returning Nightshift's structured output (it may have been interrupted, or it only returned interim results while background work was running).
Check the actual state of your work first (worktrees, branches, commits, background tasks). If work remains, finish it. Then return the structured output exactly once, describing the final state.
${PROGRESS_RULE}
When resuming, re-emit the marker of the step currently in progress before anything else.`;

function formatColumns(board: Board): string {
  return board.columns
    .map((c, i) => `  ${i + 1}. ${c.name} (id: ${c.id}, ${c.type === "skill" ? `skill: ${c.skill}` : "inert"})`)
    .join("\n");
}

/** Said instead of the description when a resumed session already saw it as it is. */
export const DESCRIPTION_UNCHANGED = "The card description has not changed since your last run in this session.";
/** First line of the changes block sent instead of the description when a resumed session saw an older version. */
export const DESCRIPTION_CHANGED =
  "The card description changed since your last run in this session. Only the changed parts are below; every other section is unchanged.";

/**
 * The card description in a prompt. `seen` is the description as the resumed session last saw it (absent for a new
 * session): then only what changed since is sent, unless the diff cannot be trusted (duplicate headings) or is no shorter.
 */
export function descriptionBlock(description: string, seen?: string): string {
  const full = `<description>\n${description}\n</description>`;
  if (seen === undefined) return full;
  const diff = diffSections(seen, description);
  if (!diff) return full;
  if (diff.unchanged) return `<description unchanged="true">\n${DESCRIPTION_UNCHANGED}\n</description>`;
  const parts = [
    DESCRIPTION_CHANGED,
    ...(diff.preamble !== undefined
      ? [diff.preamble ? `Text before the first section:\n${diff.preamble}` : "Text before the first section: removed."]
      : []),
    ...diff.changed,
    ...(diff.deleted.length > 0 ? [`Deleted sections: ${diff.deleted.join(", ")}`] : []),
  ];
  const changes = parts.join("\n\n");
  if (changes.length > description.length) return full;
  return `<description-changes>\n${changes}\n</description-changes>`;
}

export function buildPrompt(
  board: Board,
  card: Card,
  column: Column,
  skillPath: string | undefined,
  live: Record<string, LiveStatus> = {},
  seen?: string,
): string {
  const next = resolveNextColumn(board.columns, { columnId: column.id, skipColumnIds: card.skipColumnIds });
  const columns = formatColumns(board);
  return `You are an automated worker driven by Nightshift, a kanban board that orchestrates AI agents.
A card has landed in the column "${column.name}". Your job is to process this card by applying the skill "${column.skill}".

Invoke the skill with the Skill tool (skill name: "${column.skill}")${skillPath ? `; its definition lives at ${skillPath}` : ""}. Follow its instructions, using the card below as your input.
${column.instructions ? `\nAdditional instructions for this column:\n${column.instructions}\n` : ""}
<card id="${card.id}" ref="${cardRef(card)}">
<title>${card.title}</title>
${descriptionBlock(card.description, seen)}
</card>

${buildEnvironment(board, card, live)}

Board columns, in order:
${columns}

Rules:
- Work autonomously and pick sensible defaults. Do not use the AskUserQuestion tool.
- If you truly cannot continue without human decisions, first explore everything you can on your own, then return the structured output with "questions" (and move "stay"); the answers will be sent back to you in this same session.
- Each round-trip with the user is slow: put EVERY question you need answered in that single list (self-contained, one decision per question, suggest a default when you have one). Never ask one question now and keep others for later.
${PROGRESS_RULE}
- Never edit nightshift.json yourself; the board is updated from your structured output.
- Never kill processes by name or pattern (pkill -f, killall, kill $(pgrep …)): other agents run on this machine and their processes can match. Only kill PIDs you started yourself.
- Return the structured output exactly once, at the very end. If you started background work (subagents, background shells), wait until all of it has finished first. Never return an interim or "in progress" result.
- When finished, return the structured output:
  - title: the card title (repeat it if unchanged).
  - sections: preferred way to update the card content: [{heading, content, op}] edits only the "## " sections that change ("replace" is the default, "append" adds lines at the end of a section, "delete" removes it); the rest of the note is kept untouched. Use it to add your results, links to files you created, etc.
  - description: the full card description, a complete replacement. Return it only when you restructure the whole note; otherwise omit it. When both are present, description is applied first, then sections.
  - move: "next" to send the card to ${next ? `"${next.name}"` : "(there is no next column, so this behaves like stay)"}, "stay" to keep it in "${column.name}", or a column id.
  - summary: a short summary of what you did.
  - questions: only when you need the user's input (see above).
  - test: optional, a command (and url) a human can run to try what you produced; the card shows a "Tester" button that runs it.
  - models: optional, the model each later skill column should use for this card, keyed by skill name (e.g. {"nightshift-implement": "opus"}); "default" removes an entry. The plan agent should set it from the task's complexity; other agents usually omit it.
  - efforts: optional, the effort level (low, medium, high, xhigh, max) each later skill column should use for this card, keyed by skill name; "default" removes an entry. The plan agent may set it from the task's complexity; other agents usually omit it.`;
}

/** Prompt resuming a session with free feedback from the user, in whatever column the card is now. */
export function buildFeedbackPrompt(
  board: Board,
  card: Card,
  column: Column,
  skill: string | undefined,
  skillPath: string | undefined,
  live: Record<string, LiveStatus> = {},
  seen?: string,
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
${descriptionBlock(card.description, seen)}
</card>

${buildEnvironment(board, card, live)}

The card may have moved since your session ran; it is now in column "${column.name}" (id: ${column.id}, ${column.type === "skill" ? `skill: ${column.skill}` : "inert"}).
${column.instructions ? `\nAdditional instructions for this column:\n${column.instructions}\n` : ""}
Board columns, in order:
${formatColumns(board)}

Rules:
- Work autonomously and pick sensible defaults. Do not use the AskUserQuestion tool.
- If you truly cannot continue without human decisions, first explore everything you can on your own, then return the structured output with "questions" (and move "stay"); the answers will be sent back to you in this same session.
- Each round-trip with the user is slow: put EVERY question you need answered in that single list (self-contained, one decision per question, suggest a default when you have one). Never ask one question now and keep others for later.
${PROGRESS_RULE}
When resuming, re-emit the marker of the step currently in progress before anything else.
- Never edit nightshift.json yourself; the board is updated from your structured output.
- Never kill processes by name or pattern (pkill -f, killall, kill $(pgrep …)): other agents run on this machine and their processes can match. Only kill PIDs you started yourself.
- Return the structured output exactly once, at the very end. If you started background work (subagents, background shells), wait until all of it has finished first. Never return an interim or "in progress" result.
- When finished, return the structured output:
  - title: the card title (repeat it if unchanged).
  - sections: preferred way to update the card content: [{heading, content, op}] edits only the "## " sections that change ("replace" is the default, "append" adds lines at the end of a section, "delete" removes it); the rest of the note is kept untouched.
  - description: the full card description, a complete replacement. Return it only when you restructure the whole note; otherwise omit it.
  - move: "stay" keeps the card in "${column.name}", "next" sends it to ${next ? `"${next.name}"` : "(there is no next column, so this behaves like stay)"}, or give a column id.
  - summary: a short summary of what you did.
  - questions: only when you need the user's input (see above).
  - test: optional, a command (and url) a human can run to try what you produced.
  - models: optional, the model each later skill column should use for this card, keyed by skill name (e.g. {"nightshift-implement": "opus"}); "default" removes an entry. The plan agent should set it from the task's complexity; other agents usually omit it.
  - efforts: optional, the effort level (low, medium, high, xhigh, max) each later skill column should use for this card, keyed by skill name; "default" removes an entry. The plan agent may set it from the task's complexity; other agents usually omit it.`;
}

/** Prompt resuming a session with the user's answers to its questions. */
export function buildAnswerPrompt(title: string, skillRef: string, answerText: string): string {
  return `The user answered your questions:

${answerText}

${PROGRESS_RULE}
When resuming, re-emit the marker of the step currently in progress before anything else.

Continue processing the card "${title}" with ${skillRef}, then return the structured output as before (title, sections or description, move, summary). Only ask new questions if the answers raise new blocking decisions, and then ask them all at once.`;
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

/** One-line label of a tool call for the activity progress: its description, else a summary of its input. */
export function activityLabel(name: string, input: unknown): string {
  const d = isRaw(input) ? input.description : undefined;
  const raw = typeof d === "string" && d.trim() ? d : summarizeToolInput(name, input);
  return raw.replace(/\s+/g, " ").trim().slice(0, 120);
}

// Column model wins over the global setting; neither means no --model (CLI default).
/** How long shutdown() waits for agents and test commands to exit after SIGTERM before sending SIGKILL. */
const SHUTDOWN_GRACE_MS = 2000;
/** How long a finished test command may take to flush its output pipes before "Exited" is reported anyway. */
const STREAM_DRAIN_MS = 500;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour escape sequences (ESC is the point)
const ANSI_COLOR_RE = /\x1b\[[0-9;]*m/g;
// Not "quick-…": those are the log files of quick runs, never served as a card log.
const CARD_ID_RE = /^(?!quick-)[A-Za-z0-9_-]+$/;

/** "opus (card)", or "default" when no --model is passed. */
function modelLabel(model: string | undefined, source: ModelSource): string {
  return model ? `${model} (${source})` : "default";
}

export { resolveModel } from "../shared/models.ts";

export class Orchestrator {
  private projects = new Map<string, Project>();
  /** Template skills that could not be copied into a new project, reported once by the next open response. */
  private templateFailures = new Map<string, string[]>();
  private jobs = new Map<string, Job>();
  private quickRuns = new Map<string, QuickJob>();
  private logs = new Map<string, LogLine[]>();
  private listeners = new Set<(e: ServerEvent) => void>();
  private tickScheduled = false;
  /** Projects waiting for a dependency pass (coalesced per microtask). */
  private dependencyPending = new Map<string, Project>();
  /** Projects whose agents are run by another live Nightshift process: path -> its pid. */
  private lockedBy = new Map<string, number>();
  private lockTimer: ReturnType<typeof setInterval>;
  /** Fast forward and pause, per project. */
  readonly flow = new FlowController({
    canRunAgents: (p) => this.agents && !this.lockedBy.has(p.path),
    onState: (p) => this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) }),
    onResume: () => this.scheduleTick(),
  });
  /** Cards retried by the user while paused may start anyway: job key -> the enteredColumnAt the retry wrote. */
  private explicitRetries = new Map<string, string>();
  private tests = new Map<string, { project: Project; cardId: string; proc: ChildProcess; lines: LogLine[] }>();
  private lastTestLines = new Map<string, LogLine[]>();

  /** False for a test instance (`--no-agents`): it shows and edits boards but never runs agents nor takes locks. */
  readonly agents: boolean;

  /** Issue sources: imports issues into Backlog and writes back on Done, only where this process runs the agents. */
  readonly issues = new IssueSync({
    canRun: (p) => this.canRunAgents(p),
    onState: (p) => {
      if (this.projects.get(p.path) === p) this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) });
    },
    purge: (p, cardId) => {
      removeScreenshots(cardId);
      this.purgeCard(p, cardId);
    },
  });

  /** True when this process runs the project's agents: started with agents and holding the project's lock. */
  canRunAgents(p: Project): boolean {
    return this.agents && !this.lockedBy.has(p.path);
  }

  /** Agent launches held while the teamclaude proxy is unreachable, until a human chooses. */
  private readonly gate = new ProxyGate({
    onChange: (projects) => {
      this.broadcast({ type: "teamclaude", wait: this.gate.state() });
      for (const path of projects) {
        const p = this.projects.get(path);
        if (p) this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) });
      }
    },
    prepare: () => prepareProxyEnv(getSettings().teamclaudeUrl),
  });

  /** Pooled quota of the teamclaude accounts, polled only while teamclaude is on. */
  private readonly quotaPoller = new TeamclaudeQuotaPoller({
    intervalMs: Number(process.env.NIGHTSHIFT_TEAMCLAUDE_POLL_MS) || QUOTA_POLL_MS,
    onChange: () => this.broadcast({ type: "usage", usage: this.usage() }),
  });

  constructor({ agents = true }: { agents?: boolean } = {}) {
    this.agents = agents;
    onSettingsChange((settings) => {
      // Turning teamclaude off while launches wait for it lets them go on directly.
      if (!settings.teamclaudeEnabled) this.gate.releaseAll({ mode: "direct" });
      this.quotaPoller.configure(settings.teamclaudeEnabled, settings.teamclaudeUrl);
      this.broadcast({ type: "settings", settings });
      this.scheduleTick();
    });
    // Pick up projects released by another process (it exited or crashed).
    this.lockTimer = setInterval(() => {
      if (this.lockedBy.size === 0) return;
      for (const p of this.projects.values()) this.acquireLock(p);
    }, LOCK_RECHECK_MS);
    this.lockTimer.unref?.();
    const settings = getSettings();
    this.quotaPoller.configure(settings.teamclaudeEnabled, settings.teamclaudeUrl);
  }

  /** The quota the header shows: the teamclaude pool while teamclaude is on, else the agents' own `rate_limit_info`. */
  usage(): QuotaSnapshot | null {
    return getSettings().teamclaudeEnabled ? this.quotaPoller.current() : getUsage();
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
      // Just took the lock over: release the cards whose dependencies finished meanwhile, and sync the issues.
      if (!this.lockedBy.has(p.path)) {
        this.scheduleDependencies(p);
        if (this.projects.get(p.path) === p) this.issues.start(p);
      }
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
      this.flow.schedule(p);
      this.scheduleDependencies(p);
      this.issues.scheduleWriteBack(p);
    });
    rememberProject(path);
    this.scheduleTick();
    this.scheduleDependencies(p);
    if (this.agents) this.issues.start(p);
    return p;
  }

  get(path: string): Project {
    const p = this.projects.get(resolve(path)) ?? this.open(path);
    return p;
  }

  /** Agents allowed at once in this project: the board's cap, else the legacy global setting, else the default. */
  projectMaxParallel(p: Project): number {
    return p.board.maxParallel ?? legacyMaxParallel();
  }

  /** Run state of the cards that have an agent running or waiting to run. */
  private liveStatuses(p: Project): Record<string, LiveStatus> {
    const live: Record<string, LiveStatus> = {};
    for (const card of p.board.cards) {
      if (this.jobs.has(this.key(p, card.id))) live[card.id] = "running";
      else if (needsRun(p.board, card)) live[card.id] = this.waitsForPlay(p, card) ? "paused" : "queued";
    }
    return live;
  }

  /**
   * True when the project is paused and nothing explicit asked for this card's run: an answer, feedback or session
   * resume (pendingAnswer), or a retry still matching the column entry it wrote. The scheduler and the live
   * statuses both use it, so a card shown "paused" never starts and a card shown "queued" does.
   */
  private waitsForPlay(p: Project, card: Card): boolean {
    if (!this.flow.isPaused(p) || card.pendingAnswer) return false;
    const key = this.key(p, card.id);
    const retried = this.explicitRetries.get(key);
    if (retried === undefined) return true;
    if (retried === card.enteredColumnAt) return false;
    this.explicitRetries.delete(key);
    return true;
  }

  snapshot(p: Project): ProjectSnapshot {
    const live = this.liveStatuses(p);
    const lockedBy = this.lockedBy.get(p.path);
    const issueSources = this.issues.status(p);
    const testing = [...this.tests.values()].filter((t) => t.project === p).map((t) => t.cardId);
    const progress: Record<string, RunProgress> = {};
    for (const card of p.board.cards) {
      const job = this.jobs.get(this.key(p, card.id));
      if (job?.progress && !job.done) progress[card.id] = job.progress;
    }
    return {
      path: p.path,
      // The description a session saw stays on the server: several KB per card, of no use to the UI.
      board: { ...p.board, cards: p.board.cards.map(({ seenDescription: _seen, ...card }) => card) },
      maxParallel: this.projectMaxParallel(p),
      live,
      testing,
      progress,
      quickRuns: [...this.quickRuns.values()]
        .filter((q) => q.project === p)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((q) => ({
          id: q.id,
          skill: q.skill,
          instruction: q.instruction,
          status: q.status,
          createdAt: q.createdAt,
          ...(q.status === "running" && q.progress ? { progress: q.progress } : {}),
        })),
      flow: this.flow.get(p),
      proxyWaiting: this.gate.waitingCards(p.path),
      ...(lockedBy ? { lockedBy } : {}),
      ...(this.agents ? {} : { agentsDisabled: true }),
      ...(issueSources ? { issueSources } : {}),
    };
  }

  private key(p: Project, cardId: string) {
    return `${p.path}::${cardId}`;
  }

  // ---- logs --------------------------------------------------------------

  /** Log file of a card, or null for an id that is not a plain card id. Creates the directory only when asked. */
  private logFile(p: Project, cardId: string, create = false): string | null {
    if (!CARD_ID_RE.test(cardId)) return null;
    return join(this.logDir(p, create), `${cardId}.jsonl`);
  }

  private logDir(p: Project, create = false): string {
    const dir = join(NIGHTSHIFT_HOME, "logs", createHash("sha1").update(p.path).digest("hex").slice(0, 12));
    if (create) mkdirSync(dir, { recursive: true });
    return dir;
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

  // ---- dependencies ------------------------------------------------------
  // A card held in Backlog by its dependencies leaves it once they are all in Done. Only the instance that runs
  // the project's agents does it, so two processes never release the same card.

  /** Coalesced like scheduleTick: one dependency pass per project per microtask, never inside an emit. */
  scheduleDependencies(p: Project) {
    if (this.dependencyPending.has(p.path)) return;
    this.dependencyPending.set(p.path, p);
    queueMicrotask(() => {
      this.dependencyPending.delete(p.path);
      this.releaseReadyCards(p);
    });
  }

  private releaseReadyCards(p: Project) {
    if (!this.agents || this.lockedBy.has(p.path) || this.projects.get(p.path) !== p) return;
    // No ready card, no mutation: every mutation emits a change that schedules another pass.
    if (!p.board.cards.some((c) => isReady(p.board, c))) return;
    try {
      p.mutate((board) => {
        const fastForward = this.flow.isFastForward(p);
        for (const card of board.cards.filter((c) => isReady(board, c))) {
          // Fast forward on: the released card skips the inert columns too, before its target is resolved.
          if (fastForward) {
            const skips = fastForwardSkipIds(board.columns, card);
            if (skips) card.skipColumnIds = skips;
            else delete card.skipColumnIds;
          }
          p.releaseDependencies(board, card, releaseReason(board, card));
        }
      });
    } catch (e) {
      console.error(`Could not release the cards of ${p.path} whose dependencies are done: ${e instanceof Error ? e.message : String(e)}`);
    }
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
    // Each project has its own cap: a full project only makes its own cards and quick runs wait.
    const full = (p: Project) => this.runningInProject(p) >= this.projectMaxParallel(p);
    let started = this.startQueuedQuickRuns(full);
    const candidates: { p: Project; card: Card }[] = [];
    for (const p of this.projects.values()) {
      if (this.lockedBy.has(p.path)) continue;
      for (const card of p.board.cards) {
        if (!this.jobs.has(this.key(p, card.id)) && needsRun(p.board, card) && !this.waitsForPlay(p, card)) candidates.push({ p, card });
      }
    }
    candidates.sort((a, b) => a.card.enteredColumnAt.localeCompare(b.card.enteredColumnAt));
    for (const { p, card } of candidates) {
      // Full project or full column: this card waits, cards of other projects and columns can still start.
      if (full(p)) continue;
      const column = p.column(card.columnId);
      if (!column) continue;
      // The per-column limit only concerns skill columns; a job in an inert column (feedback) only counts for its project.
      if (column.type === "skill" && this.runningIn(p, card.columnId) >= columnMaxParallel(column)) continue;
      this.start(p, card);
      started = true;
    }
    if (started) this.broadcastAll();
  }

  /** Sends a fresh snapshot of every open project (e.g. after a token change, which changes `hasToken`). */
  broadcastAll() {
    for (const p of this.projects.values()) this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) });
  }

  /** Agents running now in this project: its card jobs and its running quick runs share the project's cap. */
  private runningInProject(p: Project) {
    let n = 0;
    for (const job of this.jobs.values()) if (job.project === p) n++;
    for (const q of this.quickRuns.values()) if (q.project === p && q.status === "running") n++;
    return n;
  }

  /**
   * Starts queued quick runs, oldest first, before any card of their project. They ignore column caps but not
   * their project's cap. Returns whether one started.
   */
  private startQueuedQuickRuns(full: (p: Project) => boolean): boolean {
    const queued = [...this.quickRuns.values()]
      .filter((q) => q.status === "queued" && !this.lockedBy.has(q.project.path))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let started = false;
    for (const q of queued) {
      if (full(q.project)) continue;
      this.startQuick(q);
      started = true;
    }
    return started;
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

  private kill(job: Runner) {
    job.cancelled = true;
    job.abortWait?.();
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

  // ---- quick runs --------------------------------------------------------
  // A favorite skill run once from the command palette, without a card. Kept in memory only.

  /** Queues a quick run; the scheduler starts it. Returns its id. */
  queueQuickRun(p: Project, skill: string, instruction: string): string {
    if (!this.agents) throw new HttpError(409, "Agents are disabled on this instance");
    if (this.lockedBy.has(p.path)) throw new HttpError(409, "This project's agents are run by another Nightshift process");
    if (!p.board.favoriteSkills?.includes(skill)) throw new HttpError(400, `"${skill}" is not a favorite skill`);
    const text = instruction.trim();
    if (text.length > QUICK_INSTRUCTION_MAX) throw new HttpError(400, `instruction must be at most ${QUICK_INSTRUCTION_MAX} characters`);
    const q: QuickJob = {
      id: newId("qr"),
      project: p,
      skill,
      instruction: text,
      status: "queued",
      createdAt: new Date().toISOString(),
      cancelled: false,
      done: false,
    };
    this.quickRuns.set(q.id, q);
    this.broadcast({ type: "board", project: p.path, snapshot: this.snapshot(p) });
    this.scheduleTick();
    return q.id;
  }

  /** Cancels a queued or running quick run. False when this project has no such run. */
  cancelQuickRun(p: Project, id: string): boolean {
    const q = this.quickRuns.get(id);
    if (!q || q.project !== p || q.done) return false;
    if (q.status === "queued") {
      this.endQuick(q, { status: "cancelled" });
      return true;
    }
    this.kill(q);
    return true;
  }

  private quickLogFile(q: QuickJob, create = false): string {
    return join(this.logDir(q.project, create), `quick-${this.skillHash(q.skill)}-${q.id}.jsonl`);
  }

  private skillHash(skill: string) {
    return createHash("sha1").update(skill).digest("hex").slice(0, 8);
  }

  /** Deletes the earlier log files of this skill, except those of runs still going. */
  private pruneQuickLogs(q: QuickJob) {
    const prefix = `quick-${this.skillHash(q.skill)}-`;
    const live = new Set<string>();
    for (const o of this.quickRuns.values()) {
      if (o.project === q.project && o.skill === q.skill && o.status === "running") live.add(`${prefix}${o.id}.jsonl`);
    }
    try {
      for (const name of readdirSync(this.logDir(q.project))) {
        if (name.startsWith(prefix) && name.endsWith(".jsonl") && !live.has(name))
          rmSync(join(this.logDir(q.project), name), { force: true });
      }
    } catch {}
  }

  private startQuick(q: QuickJob) {
    q.status = "running";
    this.pruneQuickLogs(q);
    this.runQuick(q).catch((e) => {
      // An exception must never become an unhandled rejection: Bun would exit the process.
      console.error(`Quick run ${q.id} failed:`, e);
      this.endQuick(q, { status: "error", error: e instanceof Error ? e.message : String(e) });
    });
  }

  private quickTarget(q: QuickJob): RunTarget {
    return {
      name: `nightshift quick: ${q.skill}`.slice(0, 80),
      schema: QUICK_RESULT_SCHEMA,
      model: getSettings().model.trim() || undefined,
      modelSource: getSettings().model.trim() ? "settings" : "default",
      // No card and no column: global > default.
      features: resolveAgentFeatures({ settings: getSettings() }),
      ...(() => {
        const r = resolveQuickEffort(q.skill, getSettings());
        return { effort: r.effort, effortSource: r.source };
      })(),
      log: (kind, text) => {
        const line: LogLine = { at: new Date().toISOString(), kind, text };
        try {
          appendFileSync(this.quickLogFile(q, true), `${JSON.stringify(line)}\n`);
        } catch {}
      },
      setProgress: (v, source) => this.setProgress(q, v, source),
      waitEntry: { project: q.project.path, quickRunId: q.id, title: q.skill },
      startMessage: (model, permissionMode, source, effort, effortSource, features) =>
        `Starting quick run of skill "${q.skill}" (permission mode: ${permissionMode}, model: ${modelLabel(model, source)}, effort: ${effortLabel(effort, effortSource)}, ${features}).`,
    };
  }

  private async runQuick(q: QuickJob) {
    const skill = findSkill(q.project.path, q.skill);
    if (!skill) return this.endQuick(q, { status: "error", error: `Skill "${q.skill}" not found in project or user skills.` });
    const target = this.quickTarget(q);
    const r = await this.spawnAgent(q, target, buildQuickRunPrompt(q.skill, skill.path, q.instruction), undefined);
    if ("startError" in r) return this.endQuick(q, { status: "error", error: r.startError });
    if (q.cancelled) return this.endQuick(q, { status: "cancelled" });
    const { result } = r;
    if (!result) {
      const error = `Agent exited without a result (${r.exit}).${r.stderr.trim() ? ` ${r.stderr.trim()}` : ""}`;
      return this.endQuick(q, { status: "error", error });
    }
    if (result.is_error) {
      return this.endQuick(q, { status: "error", error: String(result.result || result.subtype || "Agent returned an error") });
    }
    const out = parseQuickOutput(result.structured_output);
    if (!out) return this.endQuick(q, { status: "error", error: "Agent finished without returning its structured result." });
    if (out.status === "error") {
      return this.endQuick(q, { status: "error", error: out.summary || "The skill reported an error without explanation." });
    }
    return this.endQuick(q, { status: "success", summary: out.summary });
  }

  /** Emits the result first, then the board without the run. */
  private endQuick(q: QuickJob, r: { status: QuickRunResult["status"]; summary?: string; error?: string }) {
    if (q.done) return;
    q.done = true;
    // Cancelled wins over whatever the process returned while it was being stopped.
    const status = q.cancelled ? "cancelled" : r.status;
    const text = (v: string | undefined) => (v ? v.slice(0, 2000) : undefined);
    const summary = status === "success" ? text(r.summary) : undefined;
    const error = status === "error" ? text(r.error) : undefined;
    const result: QuickRunResult = {
      id: q.id,
      skill: q.skill,
      instruction: q.instruction,
      status,
      ...(summary ? { summary } : {}),
      ...(error ? { error } : {}),
    };
    this.broadcast({ type: "quickrun", project: q.project.path, result });
    this.quickRuns.delete(q.id);
    this.broadcast({ type: "board", project: q.project.path, snapshot: this.snapshot(q.project) });
    this.scheduleTick();
  }

  /** Forces a new run of a card in its current column. */
  retry(p: Project, cardId: string) {
    p.mutate(() => {
      const card = p.card(cardId);
      if (!card) throw new HttpError(404, "Unknown card");
      card.enteredColumnAt = new Date().toISOString();
      // Explicit action: starts even while the project is paused (set before the change schedules a tick).
      this.explicitRetries.set(this.key(p, card.id), card.enteredColumnAt);
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
    this.explicitRetries.delete(job.key);
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
    // Merge column: try the deterministic merge first; the agent only runs when it stops (fallback).
    let fastMergeNote = "";
    if (!answer && column.skill === FAST_MERGE_SKILL && column.fastMerge !== false) {
      const o = await tryFastMerge({
        projectPath: p.path,
        cardId: card.id,
        description: p.card(card.id)?.description ?? card.description,
        column,
        stopTest: () => this.stopTest(p, card.id),
        isCancelled: () => job.cancelled,
      });
      if (o.kind === "cancelled") return this.finish(job, "cancelled", {});
      if (o.kind === "merged" || o.kind === "busy") {
        this.log(p, card.id, "info", o.kind === "merged" ? o.summary : `merge rapide abandonné : verrou tenu par ${o.owner}`);
        return this.finish(job, "success", {
          output: {
            summary: o.summary,
            move: o.kind === "merged" ? "next" : "stay",
            questions: [],
            sections: [{ heading: "Merge", content: o.merge }],
          },
        });
      }
      this.log(p, card.id, "info", `merge rapide abandonné : ${o.step} — ${o.error.replace(/\s+/g, " ").slice(0, 300)}`);
      fastMergeNote = `\n\n${fallbackBlock(o)}`;
    }
    // A new run needs its column's skill; a resumed session only uses it to tell the agent where the definition lives.
    const skill = job.skill ? findSkill(p.path, job.skill) : undefined;
    if (!answer && !skill) {
      return this.finish(job, "error", { error: `Skill "${column.skill}" not found in project or user skills.` });
    }
    const skillRef = job.skill ? `the skill "${job.skill}"` : "the skill you applied earlier in this session";
    if (answer?.kind === "feedback") this.log(p, card.id, "info", `Retour utilisateur : ${answer.text}`);
    else if (answer && answer.kind !== "resume") this.log(p, card.id, "info", `User answer: ${answer.text}`);
    // A new run continues the card's session (the previous columns' context), unless its column asks for a fresh one
    // or, in auto mode, the carried context is too big or too old to be worth re-reading.
    // Decided before the prompt is built: a resumed session only gets what changed in the description since it saw it.
    let carried: string | undefined;
    const previousSession = !answer ? (card.sessionId ?? card.lastRun?.sessionId) : undefined;
    if (previousSession) {
      const decision = decideCarry(column.freshSession, card.lastRun, getSettings(), Date.now());
      if (decision.log) this.log(p, card.id, "info", decision.log);
      if (decision.carry) carried = previousSession;
    }
    let resumeId = answer?.sessionId ?? carried;
    const seen = resumeId && card.seenDescription?.sessionId === resumeId ? card.seenDescription.text : undefined;
    job.resumedFrom = resumeId;
    job.seenAtLaunch = !answer || answer.kind === "feedback" ? card.description : undefined;
    let prompt = !answer
      ? buildPrompt(p.board, card, column, skill?.path, this.liveStatuses(p), seen) + fastMergeNote
      : answer.kind === "resume"
        ? RECOVER_PROMPT
        : answer.kind === "feedback"
          ? buildFeedbackPrompt(p.board, card, column, job.skill, skill?.path, this.liveStatuses(p), seen)
          : buildAnswerPrompt(card.title, skillRef, answer.text);
    if (carried) prompt = `${CONTINUE_PREFIX}\n\n${prompt}`;
    // Smart mode: resolved once per run, before the first spawn. A recovery or a fresh restart below reuses it.
    const smart = await this.resolveSmart(job, card, column, !!answer);
    let costUsd = smart.costUsd;
    if (job.cancelled) return this.finish(job, "cancelled", costUsd ? { costUsd } : {});

    // One automatic recovery: an agent that stops without its structured result (interrupted, or it
    // returned only interim results while background work was running) is resumed once to collect it.
    for (let attempt = 0; ; attempt++) {
      const verb = attempt > 0 ? "Recovering" : carried ? "Continuing the card's session with" : !answer ? "Starting" : "Resuming";
      job.sessionId = undefined;
      job.contextTokens = undefined;
      const r = await this.spawnAgent(job, this.cardTarget(job, card, column, verb, smart.choice), prompt, resumeId);
      if ("startError" in r) return this.finish(job, "error", { error: r.startError, ...(costUsd ? { costUsd } : {}) });
      if (job.cancelled) return this.finish(job, "cancelled", costUsd ? { costUsd } : {});
      const result = r.result;
      // The card's session could not be resumed (deleted, or from another machine): start this step fresh, once.
      if (carried && !job.sessionId && (!result || result.is_error)) {
        this.log(p, card.id, "info", `Could not continue the card's session ${carried}: starting a new one.`);
        carried = undefined;
        resumeId = undefined;
        // A new session has seen nothing: the whole description again.
        job.resumedFrom = undefined;
        job.seenAtLaunch = card.description;
        prompt = buildPrompt(p.board, card, column, skill?.path, this.liveStatuses(p)) + fastMergeNote;
        attempt--;
        continue;
      }
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

  /**
   * The smart choice of this run. A new run calls haiku (or reads the card's cache for this column); a resumed session
   * (answer, feedback, resume) never calls: it reuses the choice cached for the column its session ran in.
   * Never fails the run: any failure resolves without smart.
   */
  private async resolveSmart(job: Job, card: Card, column: Column, resumed: boolean): Promise<{ choice?: SmartChoice; costUsd: number }> {
    const p = job.project;
    const settings = getSettings();
    const fresh = p.card(job.cardId) ?? card;
    if (resumed) {
      const sessionColumnId = fresh.lastRun?.columnId ?? column.id;
      const sessionColumn = p.column(sessionColumnId) ?? column;
      if (!smartEnabled(sessionColumn, settings)) return { costUsd: 0 };
      const entry = fresh.smartChoices?.[sessionColumnId];
      return entry ? { choice: entry, costUsd: 0 } : { costUsd: 0 };
    }
    if (!smartEnabled(column, settings)) {
      if (column.type === "skill") this.log(p, card.id, "info", "Smart off for this column.");
      return { costUsd: 0 };
    }
    if (!smartNeeded(fresh, column)) {
      this.log(p, card.id, "info", "Smart skipped: the card and column set every feature and the effort.");
      return { costUsd: 0 };
    }
    const fingerprint = smartFingerprint(fresh.title, fresh.description, column.skill);
    const cached = fresh.smartChoices?.[column.id];
    if (cached && cached.fingerprint === fingerprint) {
      this.log(p, card.id, "info", `Smart (cached): ${formatSmartChoice(cached)} — ${cached.reason}`);
      return { choice: cached, costUsd: 0 };
    }
    const unavailable = (reason: string, costUsd: number) => {
      this.log(p, card.id, "info", `Smart unavailable (${reason}): resolving without smart.`);
      return { costUsd };
    };
    let env: Record<string, string | undefined> = process.env;
    if (settings.teamclaudeEnabled) {
      // Never wait in the teamclaude gate for the smart call: the run itself handles an unreachable proxy.
      const proxy = await prepareProxyEnv(settings.teamclaudeUrl);
      if (!proxy.ok) return unavailable("teamclaude unreachable", 0);
      env = applyProxyEnv(process.env, proxy.env);
    }
    if (job.cancelled) return { costUsd: 0 };
    const r = await runSmart({
      claudePath: settings.claudePath,
      cwd: p.path,
      env,
      prompt: buildSmartPrompt({
        title: fresh.title,
        description: fresh.description,
        columnName: column.name,
        skill: column.skill,
        mcpServers: readMcpServerNames(p.path),
      }),
      onSpawn: (proc) => {
        job.proc = proc;
        if (job.cancelled) proc.kill();
      },
    });
    job.proc = undefined;
    if (job.cancelled) return { costUsd: r.costUsd };
    if (!r.ok) return unavailable(r.reason, r.costUsd);
    const entry: SmartEntry = { ...r.choice, fingerprint, costUsd: r.costUsd, durationMs: r.durationMs, at: new Date().toISOString() };
    p.mutate(() => {
      const c = p.card(job.cardId);
      // Only the run still current for this card and column writes the cache.
      if (!c || c.columnId !== job.columnId || c.enteredColumnAt !== job.enteredAt) return;
      c.smartChoices = { ...c.smartChoices, [column.id]: entry };
    });
    this.log(
      p,
      card.id,
      "info",
      `Smart: ${formatSmartChoice(r.choice)} — ${r.choice.reason} (haiku, ${formatSmartCost(r.costUsd)}, ${(r.durationMs / 1000).toFixed(1)} s).`,
    );
    return { choice: r.choice, costUsd: r.costUsd };
  }

  private cardTarget(job: Job, card: Card, column: Column, verb: string, smart?: SmartChoice): RunTarget {
    const p = job.project;
    // Read the card again at each spawn: the previous column's run may have set its models.
    const fresh = p.card(job.cardId) ?? card;
    const resolved = resolveModel(column, getSettings(), fresh);
    const effort = resolveEffort(column, getSettings(), fresh, smart?.effort);
    return {
      name: `nightshift: ${card.title}`.slice(0, 80),
      schema: RESULT_SCHEMA,
      model: resolved.model,
      modelSource: resolved.source,
      features: resolveAgentFeatures({ card: fresh, column, settings: getSettings(), smart: smart?.features }),
      effort: effort.effort,
      effortSource: effort.source,
      log: (kind, text) => this.log(p, card.id, kind, text),
      setProgress: (v, source) => this.setProgress(job, v, source),
      waitEntry: { project: p.path, cardId: card.id, ref: cardRef(fresh), title: fresh.title },
      startMessage: (model, permissionMode, source, effort, effortSource, features) =>
        `${verb} ${job.skill ? `skill "${job.skill}"` : "session"} in "${column.name}" (permission mode: ${permissionMode}, model: ${modelLabel(model, source)}, effort: ${effortLabel(effort, effortSource)}, ${features}).`,
    };
  }

  /** Runs one `claude -p` process to completion. The prompt goes through stdin, never argv: see below. */
  private async spawnAgent(
    job: Runner,
    target: RunTarget,
    prompt: string,
    resumeId: string | undefined,
  ): Promise<{ startError: string } | { result: StreamEvent | null; stderr: string; exit: string }> {
    const p = job.project;
    job.progress = undefined;
    job.markerSeen = false;
    job.todoSeen = false;
    const settings = getSettings();
    const model = target.model;
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
      JSON.stringify(target.schema),
      "--permission-mode",
      settings.permissionMode,
      "--name",
      target.name,
      ...(model ? ["--model", model] : []),
      ...agentFeatureArgs(target.features),
      ...(target.effort ? ["--effort", target.effort] : []),
      ...splitArgs(settings.extraArgs),
    ];
    target.log(
      "info",
      target.startMessage(
        model,
        settings.permissionMode,
        target.modelSource,
        target.effort,
        target.effortSource,
        formatAgentFeatures(target.features),
      ),
    );

    let env: Record<string, string | undefined> = process.env;
    if (settings.teamclaudeEnabled) {
      const r = await this.teamclaudeEnv(job, target, settings.teamclaudeUrl);
      if ("startError" in r || "aborted" in r) {
        return "startError" in r ? r : { result: null, stderr: "", exit: "cancelled while waiting for teamclaude" };
      }
      env = r.env;
    }
    // The run may have been stopped while it waited: never launch claude after that.
    if (job.cancelled) return { result: null, stderr: "", exit: "cancelled before start" };

    let result: StreamEvent | null = null;
    let stderr = "";
    try {
      const proc = Bun.spawn(args, {
        cwd: p.path,
        env,
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
            target.log("text", line);
            continue;
          }
          if (ev.type === "result") result = ev;
          else this.handleEvent(job, target, ev);
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

  /**
   * The environment of a launch through teamclaude. When the proxy cannot be reached, the launch waits in the gate
   * until a human chooses: retry (proxy env), launch directly, or cancel (start error). A run stopped meanwhile is aborted.
   */
  private async teamclaudeEnv(
    job: Runner,
    target: RunTarget,
    url: string,
  ): Promise<{ env: Record<string, string | undefined> } | { startError: string } | { aborted: true }> {
    const first = await prepareProxyEnv(url);
    if (job.cancelled) return { aborted: true };
    if (first.ok) {
      target.log("info", `Running via teamclaude (${url}).`);
      return { env: applyProxyEnv(process.env, first.env) };
    }
    // Turned off during the check: nothing would ever release the gate for this run, so it goes on directly.
    if (!getSettings().teamclaudeEnabled) {
      target.log("info", "teamclaude was turned off: running without it.");
      return { env: process.env };
    }
    target.log("info", "The teamclaude proxy cannot be reached: waiting for a choice in the board.");
    const { promise, abort } = this.gate.wait(target.waitEntry, first.failure);
    job.abortWait = abort;
    let outcome: Awaited<typeof promise>;
    try {
      outcome = await promise;
    } finally {
      job.abortWait = undefined;
    }
    if (outcome.mode === "aborted" || job.cancelled) return { aborted: true };
    if (outcome.mode === "cancel") return { startError: `teamclaude proxy unreachable at ${getSettings().teamclaudeUrl}` };
    if (outcome.mode === "direct") {
      target.log("info", "Running without teamclaude (user choice).");
      return { env: process.env };
    }
    target.log("info", `Running via teamclaude (${getSettings().teamclaudeUrl}).`);
    return { env: applyProxyEnv(process.env, outcome.env) };
  }

  /** Runs held for the teamclaude proxy, or null. */
  teamclaudeWait(): TeamclaudeWait | null {
    return this.gate.state();
  }

  /** Applies a human choice to the runs held for the teamclaude proxy. */
  teamclaudeDecide(action: TeamclaudeAction): Promise<TeamclaudeWait | null> {
    return this.gate.decide(action);
  }

  private handleEvent(job: Runner, target: RunTarget, ev: StreamEvent) {
    if (ev.type === "assistant") {
      // Subagent messages carry parent_tool_use_id: they are logged but never drive the card's progress.
      const own = !ev.parent_tool_use_id;
      // Subagents run in their own context: only the card's session counts toward what a next column would carry.
      const tokens = own ? contextTokensOf(ev.message?.usage) : undefined;
      if (tokens !== undefined) job.contextTokens = tokens;
      for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (block.type === "text" && block.text?.trim()) {
          target.log("text", block.text.trim());
          const m = own ? parseProgressMarker(block.text) : undefined;
          if (m) {
            job.markerSeen = true;
            target.setProgress(m, "marker");
          }
        } else if (block.type === "tool_use" && block.name !== "StructuredOutput") {
          target.log("tool", summarizeToolInput(block.name ?? "tool", block.input));
          if (!own) continue;
          if (block.name === "TodoWrite") {
            if (job.markerSeen) continue;
            const t = progressFromTodos(block.input);
            if (t) {
              job.todoSeen = true;
              target.setProgress(t, "todo");
            }
          } else if (!job.markerSeen && !job.todoSeen) {
            target.setProgress({ step: 0, total: 0, label: activityLabel(block.name ?? "tool", block.input) }, "activity");
          }
        }
      }
    } else if (ev.type === "rate_limit_event") {
      // The quota belongs to the account: any agent's event counts, subagents included.
      const usage = recordRateLimit(ev.rate_limit_info);
      // Still recorded while teamclaude is on, but the header then shows the pool.
      if (usage && !getSettings().teamclaudeEnabled) this.broadcast({ type: "usage", usage });
    } else if (ev.type === "system" && ev.subtype === "init") {
      if (ev.session_id) job.sessionId = ev.session_id;
      target.log("info", `Session ${ev.session_id} (model ${ev.model ?? "default"})`);
    }
  }

  /** Stores a new progress value and broadcasts the board, unless nothing changed. */
  private setProgress(job: Runner, v: { step: number; total: number; label: string }, source: RunProgress["source"]) {
    const cur = job.progress;
    if (cur && cur.step === v.step && cur.total === v.total && cur.label === v.label && cur.source === source) return;
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
        ...(job.contextTokens !== undefined ? { contextTokens: job.contextTokens } : {}),
        ...(job.skill ? { skill: job.skill } : {}),
      };
      // The next column continues from here.
      if (sessionId) card.sessionId = sessionId;
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
      // The description as this session believes it is: what it saw at launch (or last time, for a resume without
      // the description), plus its own edits. Not card.description: a human edit made during the run was never seen.
      let seenText =
        job.seenAtLaunch ??
        (job.resumedFrom && card.seenDescription?.sessionId === job.resumedFrom ? card.seenDescription.text : undefined);
      const rememberSeen = () => {
        if (sessionId && seenText !== undefined) card.seenDescription = { sessionId, text: seenText };
      };
      if ((status !== "success" && status !== "question") || !out) return rememberSeen();
      if (typeof out.title === "string" && out.title.trim()) card.title = out.title.trim();
      if (typeof out.description === "string") {
        card.description = persistScreenshots(card.id, out.description);
        seenText = card.description;
      }
      if (out.sections !== undefined) {
        try {
          const parsed = parseSections(out.sections);
          const edits = parsed.edits.map((e) => ({ ...e, content: persistScreenshots(card.id, e.content) }));
          const res = applySections(card.description, edits);
          card.description = res.text;
          if (seenText !== undefined) seenText = applySections(seenText, edits).text;
          for (const l of [...parsed.logs, ...res.logs]) this.log(p, job.cardId, "info", l);
          if (res.applied.length > 0) p.addHistory(card, "edited", `sections: ${res.applied.join(", ")}`);
        } catch (e) {
          this.log(p, job.cardId, "error", `sections not applied: ${(e as Error).message}`);
        }
      }
      if (isRaw(out.test) && typeof out.test.command === "string" && out.test.command.trim()) {
        // A url from the agent is only kept when it is a plain http(s) URL (it ends up in a link).
        const testUrl = typeof out.test.url === "string" ? safeHttpUrl(out.test.url.trim()) : null;
        card.test = { command: out.test.command.trim(), ...(testUrl ? { url: testUrl } : {}) };
      }
      const merged = mergeModels(card.models, out.models);
      if (merged.models) card.models = merged.models;
      else delete card.models;
      if (merged.changes.length > 0) p.addHistory(card, "edited", describeModelChanges(merged.changes, "agent"));
      if (merged.dropped.length > 0) this.log(p, job.cardId, "info", merged.dropped.map(formatDropped).join("; "));
      const mergedEfforts = mergeEfforts(card.efforts, out.efforts);
      if (mergedEfforts.efforts) card.efforts = mergedEfforts.efforts;
      else delete card.efforts;
      if (mergedEfforts.changes.length > 0) p.addHistory(card, "edited", describeEffortChanges(mergedEfforts.changes, "agent"));
      if (mergedEfforts.dropped.length > 0) this.log(p, job.cardId, "info", mergedEfforts.dropped.map(formatDroppedEffort).join("; "));
      rememberSeen();
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
    this.issues.shutdown();
    this.quotaPoller.stop();
    const groups = [...this.tests.values()].map((t) => t.proc.pid).filter((pid): pid is number => !!pid);
    // Queued quick runs are dropped; the running ones are stopped like jobs.
    for (const q of [...this.quickRuns.values()]) if (q.status === "queued") this.quickRuns.delete(q.id);
    const jobs: Runner[] = [...this.jobs.values(), ...this.quickRuns.values()];
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
    const jobAlive = (job: Runner) => !!job.proc && job.proc.exitCode === null && job.proc.signalCode === null;
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
