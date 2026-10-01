import { existsSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { doneColumn, ensureDoneColumn, normalizeColumnParallel, type Board, type Card, type Column, type ColumnType, type HistoryEntry } from "../shared/types.ts";

export const BOARD_FILE = "nightshift.json";

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

const now = () => new Date().toISOString();

export function defaultBoard(name: string): Board {
  return {
    version: 1,
    name,
    columns: [
      { id: newId("col"), name: "Backlog", type: "inert" },
      doneColumn(),
    ],
    cards: [],
    nextCardNumber: 1,
  };
}

const validNumber = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

/**
 * Gives every card a unique number and fixes the counter. Visits cards oldest first (ties by
 * array order) without reordering them: an older card keeps a duplicated number, the newer one
 * and unnumbered cards get fresh numbers after the highest kept one. The counter is never lowered.
 */
function assignNumbers(cards: Card[], rawNumbers: unknown[], rawNext: unknown): number {
  const order = cards.map((_, i) => i);
  order.sort((a, b) => {
    const ca = cards[a]!.createdAt;
    const cb = cards[b]!.createdAt;
    return ca < cb ? -1 : ca > cb ? 1 : a - b;
  });
  const seen = new Set<number>();
  const queue: number[] = [];
  let maxKept = 0;
  for (const i of order) {
    const n = rawNumbers[i];
    if (validNumber(n) && !seen.has(n)) {
      seen.add(n);
      cards[i]!.number = n;
      if (n > maxKept) maxKept = n;
    } else queue.push(i);
  }
  let counter = Math.max(validNumber(rawNext) ? rawNext : 1, maxKept + 1);
  for (const i of queue) cards[i]!.number = counter++;
  return counter;
}

/** True when normalization changed the numbering of a raw board, so it must be written back. */
export function numberingChanged(raw: any, board: Board): boolean {
  if (raw?.nextCardNumber !== board.nextCardNumber) return true;
  const rawById = new Map<string, any>();
  if (Array.isArray(raw?.cards)) for (const c of raw.cards) if (c && typeof c.id === "string" && !rawById.has(c.id)) rawById.set(c.id, c);
  return board.cards.some((c) => rawById.get(c.id)?.number !== c.number);
}

/** True when normalization had to repair the raw columns (missing, duplicated or misplaced Done column). */
export function doneColumnChanged(raw: any, board: Board): boolean {
  const rawCols: any[] = Array.isArray(raw?.columns) ? raw.columns : [];
  return JSON.stringify(rawCols) !== JSON.stringify(board.columns);
}

export const COLUMN_KEYS = ["id", "name", "type", "skill", "instructions", "model", "maxParallel"];
const CARD_KEYS = ["id", "number", "title", "description", "columnId", "createdAt", "updatedAt", "enteredColumnAt", "lastRun", "pendingAnswer", "test", "history"];
const BOARD_KEYS = ["version", "name", "columns", "cards", "nextCardNumber"];

/**
 * Fields this version does not know, kept as they are. Several Nightshift versions write the same file
 * (an instance started from an older worktree, a teammate on another branch): without this, the oldest
 * one would silently delete every newer field (column model, parallelism…) on its next write.
 */
export function unknownFields(raw: any, known: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !known.includes(k)));
}

/** Normalizes a parsed board so the rest of the code can trust its shape. */
export function normalizeBoard(raw: any, fallbackName: string): Board {
  const columns: Column[] = Array.isArray(raw?.columns)
    ? raw.columns
        .filter((c: any) => c && typeof c.id === "string")
        .map((c: any) => {
          const type: ColumnType = c.type === "skill" ? "skill" : "inert";
          const maxParallel = normalizeColumnParallel(type, c.maxParallel);
          return {
            ...unknownFields(c, COLUMN_KEYS),
            id: c.id,
            name: String(c.name ?? "Column"),
            type,
            ...(c.skill ? { skill: String(c.skill) } : {}),
            ...(c.instructions ? { instructions: String(c.instructions) } : {}),
            ...(typeof c.model === "string" && c.model.trim() ? { model: c.model.trim() } : {}),
            ...(maxParallel !== undefined ? { maxParallel } : {}),
          };
        })
    : [];
  if (columns.length === 0) columns.push(...defaultBoard(fallbackName).columns);
  columns.splice(0, columns.length, ...ensureDoneColumn(columns));
  const colIds = new Set(columns.map((c) => c.id));
  const rawCards: any[] = Array.isArray(raw?.cards) ? raw.cards.filter((c: any) => c && typeof c.id === "string") : [];
  const cards: Card[] = rawCards.map((c: any) => ({
    ...unknownFields(c, CARD_KEYS),
    id: c.id,
    number: 0,
    title: String(c.title ?? ""),
    description: String(c.description ?? ""),
    columnId: colIds.has(c.columnId) ? c.columnId : columns[0]!.id,
    createdAt: c.createdAt ?? now(),
    updatedAt: c.updatedAt ?? now(),
    enteredColumnAt: c.enteredColumnAt ?? c.updatedAt ?? now(),
    ...(c.lastRun ? { lastRun: c.lastRun } : {}),
    ...(c.pendingAnswer ? { pendingAnswer: c.pendingAnswer } : {}),
    ...(c.test && typeof c.test.command === "string" && c.test.command.trim()
      ? { test: { command: c.test.command, ...(c.test.url ? { url: String(c.test.url) } : {}) } }
      : {}),
    history: Array.isArray(c.history) ? c.history.slice(-50) : [],
  }));
  const nextCardNumber = assignNumbers(cards, rawCards.map((c) => c.number), raw?.nextCardNumber);
  return { ...unknownFields(raw, BOARD_KEYS), version: 1, name: String(raw?.name ?? fallbackName), columns, cards, nextCardNumber };
}

/**
 * Owns one project's `nightshift.json`. All mutations go through here, are written
 * atomically, and notify listeners. External edits (git pull, editor) are picked up
 * by a file watcher.
 */
export class Project {
  readonly path: string;
  readonly file: string;
  board!: Board;
  private listeners = new Set<() => void>();
  private watcher: FSWatcher | null = null;
  private lastWrittenMtime = 0;

  constructor(path: string) {
    this.path = path;
    this.file = join(path, BOARD_FILE);
    if (existsSync(this.file)) {
      this.read();
    } else {
      this.board = defaultBoard(basename(path));
      this.write();
    }
    this.watch();
  }

  /** Loads the file into `board`. Writes it back at once when numbering had to be migrated or repaired. */
  private read() {
    const raw = JSON.parse(readFileSync(this.file, "utf8"));
    this.board = normalizeBoard(raw, basename(this.path));
    if (numberingChanged(raw, this.board) || doneColumnChanged(raw, this.board)) this.write();
  }

  private write() {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.board, null, 2) + "\n");
    renameSync(tmp, this.file);
    try {
      this.lastWrittenMtime = statSync(this.file).mtimeMs;
    } catch {}
  }

  private watch() {
    try {
      this.watcher = watch(this.path, (_event, filename) => {
        if (filename !== BOARD_FILE) return;
        setTimeout(() => this.reloadIfChanged(), 50);
      });
    } catch {}
  }

  private reloadIfChanged() {
    try {
      const mtime = statSync(this.file).mtimeMs;
      if (mtime === this.lastWrittenMtime) return;
      this.lastWrittenMtime = mtime;
      this.read();
      this.emit();
    } catch {
      // Partial write or invalid JSON: keep the in-memory board.
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
    const result = fn(this.board);
    this.write();
    this.emit();
    return result;
  }

  close() {
    this.watcher?.close();
  }

  // ---- helpers -----------------------------------------------------------

  card(id: string): Card | undefined {
    return this.board.cards.find((c) => c.id === id);
  }

  column(id: string): Column | undefined {
    return this.board.columns.find((c) => c.id === id);
  }

  nextColumn(id: string): Column | undefined {
    const i = this.board.columns.findIndex((c) => c.id === id);
    return i >= 0 ? this.board.columns[i + 1] : undefined;
  }

  addHistory(card: Card, kind: HistoryEntry["kind"], text: string) {
    card.history.push({ at: now(), kind, text });
    if (card.history.length > 50) card.history.splice(0, card.history.length - 50);
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
      this.addHistory(card, "moved", `${reason}: ${from?.name ?? "?"} → ${col.name}`);
    }
  }
}

/** A card needs an agent run when it sits in a skill column and has not been processed since it entered it. */
export function needsRun(board: Board, card: Card): boolean {
  const col = board.columns.find((c) => c.id === card.columnId);
  if (!col || col.type !== "skill" || !col.skill) return false;
  if (card.pendingAnswer) return true;
  const lr = card.lastRun;
  if (!lr || lr.columnId !== card.columnId) return true;
  return lr.at < card.enteredColumnAt;
}
