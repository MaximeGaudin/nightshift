// Types shared by the server and the web client.

import type { SequenceState } from "./sequence.ts";

export type ColumnType = "inert" | "skill";

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  /** Skill name (folder name under .claude/skills), only for "skill" columns. */
  skill?: string;
  /** Extra instructions appended to the agent prompt for this column. */
  instructions?: string;
  /** Modèle Claude (alias ou ID) pour les runs de cette colonne ; absent = réglage global. */
  model?: string;
  /** Skill columns only: the column model wins over the card's per-skill model. Never stored as false. */
  lockModel?: true;
  /** Max agents running at once in this column; absent = 1. The global setting still caps the total. */
  maxParallel?: number;
  /** Single grapheme shown instead of the type icon; absent = type icon. */
  emoji?: string;
}

export type RunStatus = "success" | "error" | "cancelled" | "question";

/** Outcome of the last agent run on a card. Persisted so a processed card is not re-run. */
export interface LastRun {
  columnId: string;
  status: RunStatus;
  at: string;
  summary?: string;
  error?: string;
  /** Questions the agent asked the user, all at once (status "question"). Answering resumes the same session. */
  questions?: string[];
  costUsd?: number;
  sessionId?: string;
  /** Skill name applied in the session; needed so a second feedback in an inert column keeps the reference skill. */
  skill?: string;
}

export interface HistoryEntry {
  at: string;
  kind: "created" | "moved" | "run" | "edited" | "queued" | "started";
  text: string;
  /**
   * Column the card arrived in (created, moved) or sits in (queued, started). Absent on old entries;
   * its presence on a created/moved entry marks detailed time data.
   */
  columnId?: string;
}

/** What a card is doing during an interval: waiting in an inert column, queued, agent running, waiting for a human, or unknown (old data). */
export type TimePart = "inert" | "queued" | "running" | "human" | "legacy";

/** Open interval of a card: since `at`, it sits in a column in a given part. `part` null = not counted (Done, unknown column). */
export interface TimeCursor {
  at: string;
  columnId?: string;
  columnName: string;
  part: TimePart | null;
}

/** Accumulated time of a card in one (column, part). */
export interface TimeSlice {
  columnId?: string;
  columnName: string;
  part: TimePart;
  ms: number;
}

/** Closed totals plus the open interval. Bounded: one slice per column and part. */
export interface TimeState {
  totals: TimeSlice[];
  cursor?: TimeCursor;
}

export interface CardTest {
  /** Shell command, run with `sh -c` from the project folder. */
  command: string;
  /** Where to look once it runs, e.g. http://localhost:4546. */
  url?: string;
}

export interface Card {
  id: string;
  /** Short human ref (`#32`): positive integer, unique per board, never changes, never reused. */
  number: number;
  title: string;
  description: string;
  columnId: string;
  createdAt: string;
  updatedAt: string;
  /** When the card entered its current column. A run older than this means the card must be (re)processed. */
  enteredColumnAt: string;
  lastRun?: LastRun;
  /** User answer to the agent's question, waiting to be sent by resuming the session. */
  /** "resume" asks the agent to finish an interrupted session; "feedback" sends free feedback; absent = answer to questions. */
  pendingAnswer?: { text: string; sessionId: string; at: string; kind?: "resume" | "feedback" };
  /** How a human tries the card's result, set by an agent (e.g. run the app from the card's worktree). */
  test?: CardTest;
  /** Ids of the columns "next" jumps over for this card. Canonical form: see `normalizeSkipColumnIds`. Absent = none. */
  skipColumnIds?: string[];
  /** Per-skill model overrides (skill name -> alias or ID). Never `{}`; "default" is never stored. */
  models?: Record<string, string>;
  history: HistoryEntry[];
  /** Time checkpoint of the history entries dropped by the history cap. */
  timeBase?: TimeState;
}

/** Content of `nightshift.json`, the single committable file at the project root. */
export interface Board {
  version: 1;
  name: string;
  columns: Column[];
  cards: Card[];
  /** Number the next created card receives. Always greater than every card number. */
  nextCardNumber: number;
  /** Skill names pinned in the command palette for quick runs. Absent when none. */
  favoriteSkills?: string[];
}

/** Quick human ref of a card, e.g. `#32`. */
export function cardRef(card: Pick<Card, "number">): string {
  return `#${card.number}`;
}

/** Parallel agents in a skill column when `maxParallel` is absent. */
export const DEFAULT_COLUMN_PARALLEL = 1;
/** Upper bound for any parallel limit (column or global). */
export const MAX_PARALLEL = 32;

/** Max agents running at once in a column. Never reads the global settings. */
export function columnMaxParallel(col: Pick<Column, "maxParallel">): number {
  return col.maxParallel ?? DEFAULT_COLUMN_PARALLEL;
}

/**
 * Normalizes a raw `maxParallel` value for a column of the given type.
 * Returns undefined (field absent) for inert columns and for empty, non-numeric, non-integer or < 1 values;
 * clamps integers above MAX_PARALLEL. Never produces a default value.
 */
export function normalizeColumnParallel(type: ColumnType, raw: unknown): number | undefined {
  if (type !== "skill") return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") return undefined;
  if (typeof raw === "string" && !raw.trim()) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return Math.min(n, MAX_PARALLEL);
}

/**
 * Normalizes a raw column emoji: non-string, empty or blank => undefined; otherwise the first grapheme
 * of the trimmed value. Does not check that the grapheme is an emoji.
 */
export function normalizeColumnEmoji(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  const first = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)[Symbol.iterator]().next();
  return first.done ? undefined : first.value.segment;
}

/** The emoji to display for a column, or undefined to fall back on the type icon. */
export function columnEmoji(col: Pick<Column, "emoji">): string | undefined {
  return normalizeColumnEmoji(col.emoji);
}

export const DONE_COLUMN_ID = "col_done";
export const DONE_COLUMN_NAME = "Done";

/** The canonical Done column. */
export function doneColumn(): Column {
  return { id: DONE_COLUMN_ID, name: DONE_COLUMN_NAME, type: "inert" };
}

export function isDoneColumn(colOrId: Pick<Column, "id"> | string): boolean {
  return (typeof colOrId === "string" ? colOrId : colOrId.id) === DONE_COLUMN_ID;
}

/**
 * Returns columns with exactly one Done column, last. Pure and idempotent.
 * Extra unknown fields of the first existing Done column are kept; skill fields are dropped, emoji is kept.
 */
export function ensureDoneColumn(columns: Column[]): Column[] {
  const existing = columns.find(isDoneColumn);
  const done: Column = { ...(existing ?? {}), ...doneColumn() };
  delete done.skill;
  delete done.instructions;
  delete done.model;
  delete done.lockModel;
  delete done.maxParallel;
  return [...columns.filter((c) => !isDoneColumn(c)), done];
}

export const BACKLOG_COLUMN_ID = "col_backlog";
export const BACKLOG_COLUMN_NAME = "Backlog";

/** The canonical Backlog column. */
export function backlogColumn(): Column {
  return { id: BACKLOG_COLUMN_ID, name: BACKLOG_COLUMN_NAME, type: "inert" };
}

export function isBacklogColumn(colOrId: Pick<Column, "id"> | string): boolean {
  return (typeof colOrId === "string" ? colOrId : colOrId.id) === BACKLOG_COLUMN_ID;
}

/** Backlog or Done: columns the user cannot rename, retype, remove or move. */
export function isSystemColumn(colOrId: Pick<Column, "id"> | string): boolean {
  return isBacklogColumn(colOrId) || isDoneColumn(colOrId);
}

/**
 * Returns columns with exactly one Backlog column, first. Pure and idempotent.
 * 1. A `col_backlog` exists: the first one is kept (others dropped) and moved first.
 * 2. Else the first non-Done column, when inert, becomes the Backlog (`renamedFrom` = its old id).
 * 3. Else a fresh Backlog is inserted first.
 * Unknown fields and emoji of the existing column are kept; skill fields are dropped.
 */
export function ensureBacklogColumn(columns: Column[]): { columns: Column[]; renamedFrom?: string } {
  const existing = columns.find(isBacklogColumn);
  let source: Column | undefined = existing;
  let renamedFrom: string | undefined;
  if (!existing) {
    const first = columns.find((c) => !isDoneColumn(c));
    if (first && first.type === "inert") {
      source = first;
      renamedFrom = first.id;
    }
  }
  const backlog: Column = { ...(source ?? {}), ...backlogColumn() };
  delete backlog.skill;
  delete backlog.instructions;
  delete backlog.model;
  delete backlog.lockModel;
  delete backlog.maxParallel;
  const rest = columns.filter((c) => c !== source && !isBacklogColumn(c));
  return { columns: [backlog, ...rest], ...(renamedFrom !== undefined ? { renamedFrom } : {}) };
}

/** Backlog first, Done last. Every caller uses this, never the two ensure functions separately. */
export function ensureSystemColumns(columns: Column[]): { columns: Column[]; renamedFrom?: string } {
  const b = ensureBacklogColumn(columns);
  return { ...b, columns: ensureDoneColumn(b.columns) };
}

/** Values accepted by `claude --permission-mode`. */
export const PERMISSION_MODES = ["auto", "acceptEdits", "dontAsk", "bypassPermissions", "manual", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** UI language: "auto" follows the browser. */
export const LANGUAGE_SETTINGS = ["auto", "en", "fr"] as const;
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number];

export interface Settings {
  maxParallel: number;
  claudePath: string;
  permissionMode: PermissionMode;
  model: string;
  extraArgs: string;
  recentProjects: string[];
  /** Play a sound when a card needs human attention. */
  soundNotifications: boolean;
  language: LanguageSetting;
}

export interface SkillInfo {
  name: string;
  description: string;
  scope: "project" | "user";
  path: string;
}

/** Live (non-persisted) state of a card in the run queue. */
export type LiveStatus = "queued" | "running";

/** Whether the user may send free feedback to the card's last session. */
export function canSendFeedback(card: Card, live?: LiveStatus): boolean {
  return (
    !!card.lastRun?.sessionId &&
    !live &&
    !card.pendingAnswer &&
    !(card.lastRun.status === "question" && card.lastRun.columnId === card.columnId)
  );
}

/**
 * What keeps the agent from taking new work on the card: "working" when it is queued, running or has an answer
 * waiting to be sent (wins over "question"), "question" when it asked something in the current column.
 */
export function agentBlocker(card: Card, live?: LiveStatus): "working" | "question" | undefined {
  if (live || card.pendingAnswer) return "working";
  if (card.lastRun?.status === "question" && card.lastRun.columnId === card.columnId) return "question";
  return undefined;
}

/** Whether the agent is busy on the card: see `agentBlocker`. */
export function agentBusy(card: Card, live?: LiveStatus): boolean {
  return agentBlocker(card, live) !== undefined;
}

export interface LogLine {
  at: string;
  kind: "text" | "tool" | "info" | "error";
  text: string;
}

/**
 * Live progress of a running card: a step out of a total, from an agent marker, its todo list,
 * or plain agent activity.
 * Invariant: source === "activity" <=> step === 0 && total === 0 (indeterminate, no known steps);
 * for "marker" and "todo", 1 <= step <= total.
 */
export interface RunProgress {
  step: number;
  total: number;
  label: string;
  source: "marker" | "todo" | "activity";
  /** ISO timestamp of the last update. */
  at: string;
}

/** A skill launched from the command palette without a card. */
export interface QuickRun {
  id: string;
  skill: string;
  /** Free text given with the skill; "" when none. */
  instruction: string;
  status: "queued" | "running";
  /** ISO timestamp. */
  createdAt: string;
  /** Only while running; same invariant as a card's RunProgress. */
  progress?: RunProgress;
}

/** Outcome of a finished quick run. */
export interface QuickRunResult {
  id: string;
  skill: string;
  instruction: string;
  status: "success" | "error" | "cancelled";
  summary?: string;
  error?: string;
}

export interface ProjectSnapshot {
  path: string;
  /** Template skills that could not be copied into a newly created project; only in the open response. */
  templateSkillsNotCopied?: string[];
  board: Board;
  live: Record<string, LiveStatus>;
  /** Pid of another Nightshift process that runs this project's agents; this one does not. */
  lockedBy?: number;
  /** Started with `--no-agents`: this instance never runs agents. */
  agentsDisabled?: boolean;
  /** Cards whose test command is running. */
  testing: string[];
  /** Progress per card id; only for cards that are live "running". */
  progress: Record<string, RunProgress>;
  /** Quick runs not finished yet, sorted by createdAt. */
  quickRuns: QuickRun[];
  /** Sequential mode: cards of the first column are fed one at a time into the second. */
  sequence: SequenceState;
}

/** Why a card needs a human: it reached an inert column, asks questions, or its run failed. */
export type AttentionKind = "inert" | "question" | "error";

/** Higher wins when several attention events are batched into one sound. */
export const ATTENTION_PRIORITY: Record<AttentionKind, number> = { inert: 1, question: 2, error: 3 };

export type ServerEvent =
  | { type: "board"; project: string; snapshot: ProjectSnapshot }
  | { type: "log"; project: string; cardId: string; line: LogLine }
  | { type: "testlog"; project: string; cardId: string; line: LogLine }
  | { type: "settings"; settings: Settings }
  | { type: "attention"; project: string; cardId: string; kind: AttentionKind }
  | { type: "quickrun"; project: string; result: QuickRunResult };
