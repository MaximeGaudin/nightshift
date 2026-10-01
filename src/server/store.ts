import { copyFileSync, existsSync, type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { needsRun } from "../shared/needs-run.ts";
import { normalizeSkipColumnIds, resolveNextColumn } from "../shared/skip.ts";
import { replayHistory } from "../shared/timeline.ts";
import {
  type Board,
  type Card,
  type Column,
  type ColumnType,
  doneColumn,
  ensureDoneColumn,
  type HistoryEntry,
  type LastRun,
  normalizeColumnEmoji,
  normalizeColumnParallel,
  type TimePart,
  type TimeState,
} from "../shared/types.ts";

import { writeFileAtomic } from "./fsutil.ts";

export const BOARD_FILE = "nightshift.json";

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

const now = () => new Date().toISOString();

// Key order matches normalizeBoard's output so a fresh board is not rewritten on reopen.
const DEFAULT_COLUMNS: Omit<Column, "id">[] = [
  { name: "Backlog", type: "inert" },
  { name: "Grill", type: "skill", skill: "nightshift-grill", model: "opus", maxParallel: 3, emoji: "🔥" },
  { name: "Plan", type: "skill", skill: "nightshift-plan", model: "opus", maxParallel: 3, emoji: "🗺️" },
  { name: "Implement", type: "skill", skill: "nightshift-implement", model: "sonnet", maxParallel: 3, emoji: "🧑‍💻" },
  { name: "Review", type: "skill", skill: "nightshift-review", model: "opus", maxParallel: 3, emoji: "🧐" },
  { name: "To Test", type: "inert", emoji: "🪲" },
  { name: "Merge", type: "skill", skill: "nightshift-merge", model: "sonnet", maxParallel: 1, emoji: "🎉" },
];

export function defaultBoard(name: string): Board {
  return {
    version: 1,
    name,
    columns: [...DEFAULT_COLUMNS.map((c) => ({ id: newId("col"), ...c })), doneColumn()],
    cards: [],
    nextCardNumber: 1,
  };
}

/** A JSON object read from disk or from a request: nothing is known about its fields until they are checked. */
export type Raw = Record<string, unknown>;
export const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const validNumber = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

/**
 * Gives every card a unique number and fixes the counter. Visits cards oldest first (ties by
 * array order) without reordering them: an older card keeps a duplicated number, the newer one
 * and unnumbered cards get fresh numbers after the highest kept one. The counter is never lowered.
 */
function assignNumbers(cards: Card[], rawNumbers: unknown[], rawNext: unknown): number {
  const order = cards.map((_, i) => i);
  order.sort((a, b) => {
    const ca = cards[a]?.createdAt;
    const cb = cards[b]?.createdAt;
    return ca < cb ? -1 : ca > cb ? 1 : a - b;
  });
  const seen = new Set<number>();
  const queue: number[] = [];
  let maxKept = 0;
  for (const i of order) {
    const n = rawNumbers[i];
    if (validNumber(n) && !seen.has(n)) {
      seen.add(n);
      cards[i].number = n;
      if (n > maxKept) maxKept = n;
    } else queue.push(i);
  }
  let counter = Math.max(validNumber(rawNext) ? rawNext : 1, maxKept + 1);
  for (const i of queue) cards[i].number = counter++;
  return counter;
}

/** True when normalization changed the numbering of a raw board, so it must be written back. */
export function numberingChanged(raw: unknown, board: Board): boolean {
  const r: Raw = isRaw(raw) ? raw : {};
  if (r.nextCardNumber !== board.nextCardNumber) return true;
  const rawById = new Map<string, Raw>();
  if (Array.isArray(r.cards)) for (const c of r.cards) if (isRaw(c) && typeof c.id === "string" && !rawById.has(c.id)) rawById.set(c.id, c);
  return board.cards.some((c) => rawById.get(c.id)?.number !== c.number);
}

/** True when normalization had to repair the raw columns (missing, duplicated or misplaced Done column). */
export function doneColumnChanged(raw: unknown, board: Board): boolean {
  const rawCols: unknown[] = isRaw(raw) && Array.isArray(raw.columns) ? raw.columns : [];
  return JSON.stringify(rawCols) !== JSON.stringify(board.columns);
}

export const COLUMN_KEYS = ["id", "name", "type", "skill", "instructions", "model", "maxParallel", "emoji"];
const CARD_KEYS = [
  "id",
  "number",
  "title",
  "description",
  "columnId",
  "createdAt",
  "updatedAt",
  "enteredColumnAt",
  "lastRun",
  "pendingAnswer",
  "test",
  "skipColumnIds",
  "history",
  "timeBase",
];
const BOARD_KEYS = ["version", "name", "columns", "cards", "nextCardNumber"];

/**
 * Fields this version does not know, kept as they are. Several Nightshift versions write the same file
 * (an instance started from an older worktree, a teammate on another branch): without this, the oldest
 * one would silently delete every newer field (column model, parallelism…) on its next write.
 */
export function unknownFields(raw: unknown, known: string[]): Record<string, unknown> {
  if (!isRaw(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !known.includes(k)));
}

const TIME_PARTS: readonly string[] = ["inert", "queued", "running", "human", "legacy"];
const validPart = (v: unknown): v is TimePart => typeof v === "string" && TIME_PARTS.includes(v);

function normalizeTimeBase(raw: unknown): TimeState | undefined {
  if (!isRaw(raw) || !Array.isArray(raw.totals)) return undefined;
  const totals: TimeState["totals"] = [];
  for (const t of raw.totals) {
    if (!isRaw(t) || typeof t.columnName !== "string" || !validPart(t.part)) return undefined;
    if (typeof t.ms !== "number" || !Number.isFinite(t.ms) || t.ms < 0) return undefined;
    if (t.columnId !== undefined && typeof t.columnId !== "string") return undefined;
    totals.push({ ...(t.columnId !== undefined ? { columnId: t.columnId } : {}), columnName: t.columnName, part: t.part, ms: t.ms });
  }
  const c = raw.cursor;
  if (c === undefined) return { totals };
  if (!isRaw(c) || typeof c.at !== "string" || typeof c.columnName !== "string") return undefined;
  if (c.part !== null && !validPart(c.part)) return undefined;
  const part: TimePart | null = c.part;
  if (c.columnId !== undefined && typeof c.columnId !== "string") return undefined;
  return {
    totals,
    cursor: { at: c.at, ...(c.columnId !== undefined ? { columnId: c.columnId } : {}), columnName: c.columnName, part },
  };
}

/** Normalizes a parsed board so the rest of the code can trust its shape. */
export function normalizeBoard(raw: unknown, fallbackName: string): Board {
  const r: Raw = isRaw(raw) ? raw : {};
  const columns: Column[] = Array.isArray(r.columns)
    ? r.columns
        .filter((c): c is Raw & { id: string } => isRaw(c) && typeof c.id === "string")
        .map((c) => {
          const type: ColumnType = c.type === "skill" ? "skill" : "inert";
          const maxParallel = normalizeColumnParallel(type, c.maxParallel);
          const emoji = normalizeColumnEmoji(c.emoji);
          return {
            ...unknownFields(c, COLUMN_KEYS),
            id: c.id,
            name: String(c.name ?? "Column"),
            type,
            ...(c.skill ? { skill: String(c.skill) } : {}),
            ...(c.instructions ? { instructions: String(c.instructions) } : {}),
            ...(typeof c.model === "string" && c.model.trim() ? { model: c.model.trim() } : {}),
            ...(maxParallel !== undefined ? { maxParallel } : {}),
            ...(emoji !== undefined ? { emoji } : {}),
          };
        })
    : [];
  if (columns.length === 0) columns.push(...defaultBoard(fallbackName).columns);
  columns.splice(0, columns.length, ...ensureDoneColumn(columns));
  const colIds = new Set(columns.map((c) => c.id));
  const rawCards = Array.isArray(r.cards) ? r.cards.filter((c): c is Raw & { id: string } => isRaw(c) && typeof c.id === "string") : [];
  const cards: Card[] = rawCards.map((c) => {
    const rawHistory: HistoryEntry[] = Array.isArray(c.history) ? c.history : [];
    let timeBase = normalizeTimeBase(c.timeBase);
    // Entries cut by the cap are folded into the checkpoint first, so their time is not lost.
    if (rawHistory.length > 50) timeBase = replayHistory(timeBase, rawHistory.slice(0, -50), asString(c.createdAt) ?? now());
    const skipColumnIds = normalizeSkipColumnIds(columns, c.skipColumnIds);
    return {
      ...unknownFields(c, CARD_KEYS),
      id: c.id,
      number: 0,
      title: String(c.title ?? ""),
      description: String(c.description ?? ""),
      columnId: typeof c.columnId === "string" && colIds.has(c.columnId) ? c.columnId : columns[0]?.id,
      createdAt: asString(c.createdAt) ?? now(),
      updatedAt: asString(c.updatedAt) ?? now(),
      enteredColumnAt: asString(c.enteredColumnAt) ?? asString(c.updatedAt) ?? now(),
      // Kept as found, like the other run fields: they are written by Nightshift itself.
      ...(c.lastRun ? { lastRun: c.lastRun as LastRun } : {}),
      ...(c.pendingAnswer ? { pendingAnswer: c.pendingAnswer as Card["pendingAnswer"] } : {}),
      ...(isRaw(c.test) && typeof c.test.command === "string" && c.test.command.trim()
        ? { test: { command: c.test.command, ...(c.test.url ? { url: String(c.test.url) } : {}) } }
        : {}),
      ...(skipColumnIds ? { skipColumnIds } : {}),
      history: rawHistory.slice(-50),
      ...(timeBase ? { timeBase } : {}),
    };
  });
  const nextCardNumber = assignNumbers(
    cards,
    rawCards.map((c) => c.number),
    r.nextCardNumber,
  );
  return { ...unknownFields(raw, BOARD_KEYS), version: 1, name: String(r.name ?? fallbackName), columns, cards, nextCardNumber };
}

/**
 * Owns one project's `nightshift.json`. All mutations go through here, are written
 * atomically, and notify listeners. External edits (git pull, editor) are picked up
 * by a file watcher.
 */
export class Project {
  readonly path: string;
  readonly file: string;
  /** True only when this instance wrote a brand-new board file. */
  readonly created: boolean;
  board!: Board;
  private listeners = new Set<() => void>();
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private lastWrittenMtime = 0;
  /** Set when a reload failed: the file on disk holds an edit we could not read and must not silently overwrite. */
  private unreadableOnDisk = false;

  constructor(path: string) {
    this.path = path;
    this.file = join(path, BOARD_FILE);
    this.created = !existsSync(this.file);
    if (this.created) {
      this.board = defaultBoard(basename(path));
      this.write();
    } else {
      this.read();
    }
    this.watch();
  }

  /** Loads the file into `board`. Writes it back at once when numbering had to be migrated or repaired. */
  private read() {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (e) {
      throw new Error(`nightshift.json invalide : ${this.file} (${e instanceof Error ? e.message : String(e)})`);
    }
    this.unreadableOnDisk = false;
    this.board = normalizeBoard(raw, basename(this.path));
    if (numberingChanged(raw, this.board) || doneColumnChanged(raw, this.board)) this.write();
  }

  private write() {
    // An external edit we failed to parse is about to be overwritten: keep a copy.
    if (this.unreadableOnDisk) {
      try {
        copyFileSync(this.file, `${this.file}.invalid`);
      } catch {}
    }
    writeFileAtomic(this.file, `${JSON.stringify(this.board, null, 2)}\n`);
    this.unreadableOnDisk = false;
    try {
      this.lastWrittenMtime = statSync(this.file).mtimeMs;
    } catch (e) {
      console.warn(`Could not stat ${this.file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private watch() {
    try {
      this.watcher = watch(this.path, (_event, filename) => {
        if (filename !== BOARD_FILE) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reloadIfChanged(), 50);
      });
      this.watcher.on("error", (e) => console.error(`Watching ${this.path} failed, external edits will not be picked up: ${e.message}`));
    } catch (e) {
      console.error(
        `Cannot watch ${this.path}, external edits of ${BOARD_FILE} will not be picked up: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private reloadIfChanged() {
    try {
      const mtime = statSync(this.file).mtimeMs;
      if (mtime === this.lastWrittenMtime) return;
      const written = this.lastWrittenMtime;
      this.read();
      // read() may rewrite the file (numbering migration), which already recorded the new mtime.
      if (this.lastWrittenMtime === written) this.lastWrittenMtime = mtime;
      this.emit();
    } catch (e) {
      // Partial write or invalid JSON: keep the in-memory board, retry on the next change, and remember that
      // the file holds an edit we did not load so the next write backs it up.
      console.error(e instanceof Error ? e.message : String(e));
      this.unreadableOnDisk = true;
    }
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  /** Applies a mutation, persists, notifies. */
  mutate<T>(fn: (board: Board) => T): T {
    // If the mutation or the write fails, the memory must not run ahead of the file: restore the previous state.
    const before = structuredClone(this.board);
    let result: T;
    try {
      result = fn(this.board);
      this.write();
    } catch (e) {
      for (const key of Object.keys(this.board)) delete (this.board as unknown as Record<string, unknown>)[key];
      Object.assign(this.board, before);
      throw e;
    }
    this.emit();
    return result;
  }

  close() {
    clearTimeout(this.reloadTimer);
    this.watcher?.close();
  }

  // ---- helpers -----------------------------------------------------------

  card(id: string): Card | undefined {
    return this.board.cards.find((c) => c.id === id);
  }

  column(id: string): Column | undefined {
    return this.board.columns.find((c) => c.id === id);
  }

  /** Column "next" sends the card to: the first after its own that it does not skip. */
  nextColumnFor(card: Card): Column | undefined {
    return resolveNextColumn(this.board.columns, card);
  }

  addHistory(card: Card, kind: HistoryEntry["kind"], text: string, columnId?: string) {
    card.history.push({ at: now(), kind, text, ...(columnId !== undefined ? { columnId } : {}) });
    if (card.history.length > 50) {
      // Fold the dropped entries into the checkpoint before they disappear.
      const dropped = card.history.splice(0, card.history.length - 50);
      card.timeBase = replayHistory(card.timeBase, dropped, card.createdAt);
    }
  }

  /** Records that a card waits for an agent, when it is in a skill column and needs a run. */
  addQueued(card: Card, board: Board = this.board) {
    if (!needsRun(board, card)) return;
    this.addHistory(card, "queued", `Queued in ${this.column(card.columnId)?.name}`, card.columnId);
  }

  /** Moves a card to a column at an index (end when omitted). Resets its run state for that column. */
  moveCard(board: Board, cardId: string, columnId: string, index?: number, reason = "Moved") {
    const card = board.cards.find((c) => c.id === cardId);
    const col = board.columns.find((c) => c.id === columnId);
    if (!card || !col) throw new Error("Unknown card or column");
    const from = board.columns.find((c) => c.id === card.columnId);
    board.cards.splice(board.cards.indexOf(card), 1);
    const sameCol = board.cards.filter((c) => c.columnId === columnId);
    const target = index === undefined || index >= sameCol.length ? null : sameCol[Math.max(0, index)];
    if (target) board.cards.splice(board.cards.indexOf(target), 0, card);
    else {
      const last = sameCol[sameCol.length - 1];
      board.cards.splice(last ? board.cards.indexOf(last) + 1 : board.cards.length, 0, card);
    }
    if (card.columnId !== columnId) {
      card.columnId = columnId;
      card.enteredColumnAt = now();
      card.updatedAt = now();
      delete card.pendingAnswer;
      this.addHistory(card, "moved", `${reason}: ${from?.name ?? "?"} → ${col.name}`, columnId);
      this.addQueued(card, board);
    }
  }
}

export { needsRun };
