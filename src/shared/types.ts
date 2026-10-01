// Types shared by the server and the web client.

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
}

export interface HistoryEntry {
  at: string;
  kind: "created" | "moved" | "run" | "edited";
  text: string;
}

export interface Card {
  id: string;
  title: string;
  description: string;
  columnId: string;
  createdAt: string;
  updatedAt: string;
  /** When the card entered its current column. A run older than this means the card must be (re)processed. */
  enteredColumnAt: string;
  lastRun?: LastRun;
  /** User answer to the agent's question, waiting to be sent by resuming the session. */
  pendingAnswer?: { text: string; sessionId: string; at: string };
  history: HistoryEntry[];
}

/** Content of `nightshift.json`, the single committable file at the project root. */
export interface Board {
  version: 1;
  name: string;
  columns: Column[];
  cards: Card[];
}

/** Values accepted by `claude --permission-mode`. */
export const PERMISSION_MODES = ["auto", "acceptEdits", "dontAsk", "bypassPermissions", "manual", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface Settings {
  maxParallel: number;
  claudePath: string;
  permissionMode: PermissionMode;
  model: string;
  extraArgs: string;
  recentProjects: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  scope: "project" | "user";
  path: string;
}

/** Live (non-persisted) state of a card in the run queue. */
export type LiveStatus = "queued" | "running";

export interface LogLine {
  at: string;
  kind: "text" | "tool" | "info" | "error";
  text: string;
}

export interface ProjectSnapshot {
  path: string;
  board: Board;
  live: Record<string, LiveStatus>;
  /** Pid of another Nightshift process that runs this project's agents; this one does not. */
  lockedBy?: number;
}

export type ServerEvent =
  | { type: "board"; project: string; snapshot: ProjectSnapshot }
  | { type: "log"; project: string; cardId: string; line: LogLine }
  | { type: "settings"; settings: Settings };
