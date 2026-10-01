// Sequential mode: pure helpers shared by the server and the web client. No I/O.

import { needsRun } from "./needs-run.ts";
import { normalizeSkipColumnIds } from "./skip.ts";
import { type Board, type Card, type Column, cardRef, DONE_COLUMN_ID } from "./types.ts";

export type SequenceStatus = "stopped" | "active" | "paused";

export interface SequenceState {
  status: SequenceStatus;
  /** Card currently going through the sequence. */
  cardId?: string;
  /** Why the sequence stopped; the web client turns it into text in the user's language. */
  notice?: SequenceNotice;
}

/** Structured reason so the wording stays on the client, which knows the UI language. */
export type SequenceNotice =
  | { code: "backlogEmpty" | "finished" | "cardDeleted" }
  | { code: "cardReturned" | "kept"; ref: string; column: string }
  | { code: "error"; ref: string; error: string }
  | { code: "cancelled"; ref: string };

export type SequenceFailure = { code: "error"; error: string } | { code: "cancelled" } | { code: "kept"; column: string };

export function sameNotice(a?: SequenceNotice, b?: SequenceNotice): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const ERROR_MAX = 120;

/** Source (first) and entry (second) columns; undefined when the source is Done or there is no entry column. */
export function sequenceColumns(columns: Column[]): { source: Column; entry: Column } | undefined {
  const source = columns[0];
  const entry = columns[1];
  if (!source || !entry || source.id === DONE_COLUMN_ID) return undefined;
  return { source, entry };
}

/** First card (array order) sitting in the source column. */
export function topSourceCard(board: Board): Card | undefined {
  const cols = sequenceColumns(board.columns);
  if (!cols) return undefined;
  return board.cards.find((c) => c.columnId === cols.source.id);
}

/** Skip list of a card in the sequence: its own skips plus the inert columns after the source (never Done). */
export function autoMergeSkipIds(columns: Column[], card: Pick<Card, "skipColumnIds">): string[] | undefined {
  const inert = columns
    .slice(1)
    .filter((c) => c.type === "inert" && c.id !== DONE_COLUMN_ID)
    .map((c) => c.id);
  return normalizeSkipColumnIds(columns, [...(card.skipColumnIds ?? []), ...inert]);
}

/** Why the card stalled in its column, or undefined when the sequence can go on. */
export function sequenceFailure(board: Board, card: Card, running: boolean): SequenceFailure | undefined {
  if (running || card.pendingAnswer || needsRun(board, card)) return undefined;
  const lr = card.lastRun;
  if (!lr || lr.columnId !== card.columnId || lr.at < card.enteredColumnAt) return undefined;
  const col = board.columns.find((c) => c.id === card.columnId);
  if (lr.status === "error") {
    const err = (lr.error ?? "").trim();
    return { code: "error", error: err.length > ERROR_MAX ? err.slice(0, ERROR_MAX) : err };
  }
  if (lr.status === "cancelled") return { code: "cancelled" };
  if (lr.status === "success" && col?.type === "skill") return { code: "kept", column: col.name };
  return undefined;
}

/** Wording of the sequence tooltip; the web passes translated pieces, the default is the original French. */
export interface SequenceLabels {
  stopped: string;
  active: string;
  /** Text after the card reference when the sequence is paused. */
  paused: string;
  pausedHint: string;
}

export const FR_SEQUENCE_LABELS: SequenceLabels = {
  stopped: "Mode séquentiel : arrêté",
  active: "Mode séquentiel : actif",
  paused: "Mode séquentiel : en pause",
  pausedHint: "(la suivante ne partira pas)",
};

/** Tooltip of the sequence control. */
export function sequenceLabel(state: SequenceState, board: Board, labels: SequenceLabels = FR_SEQUENCE_LABELS): string {
  if (state.status === "stopped") return labels.stopped;
  const card = state.cardId ? board.cards.find((c) => c.id === state.cardId) : undefined;
  const ref = card ? ` — ${cardRef(card)}` : "";
  if (state.status === "active") return `${labels.active}${ref}`;
  return `${labels.paused}${ref} ${labels.pausedHint}`;
}
