// Fast forward and pause: pure helpers shared by the server and the web client. No I/O.

import { isHeld } from "./dependencies.ts";
import { normalizeSkipColumnIds, resolveNextColumn } from "./skip.ts";
import { BACKLOG_COLUMN_ID, type Board, type Card, type Column, DONE_COLUMN_ID } from "./types.ts";

/** Per-project run flow, held in memory by the server (never written to nightshift.json). */
export interface FlowState {
  /** Every ready Backlog card is moved out at once, and new ones as soon as they appear. */
  fastForward: boolean;
  /** No automatic agent run starts; explicit actions (retry, feedback, answer) still do. */
  paused: boolean;
}

export const DEFAULT_FLOW: FlowState = { fastForward: false, paused: false };

/** Skip list of a fast-forwarded card: its own skips plus the inert columns after the Backlog (never Done). */
export function fastForwardSkipIds(columns: Column[], card: Pick<Card, "skipColumnIds">): string[] | undefined {
  const inert = columns
    .slice(1)
    .filter((c) => c.type === "inert" && c.id !== DONE_COLUMN_ID)
    .map((c) => c.id);
  return normalizeSkipColumnIds(columns, [...(card.skipColumnIds ?? []), ...inert]);
}

/** Backlog cards fast forward moves out: every one not held by its dependencies, in board order. */
export function fastForwardCandidates(board: Board): Card[] {
  return board.cards.filter((c) => c.columnId === BACKLOG_COLUMN_ID && !isHeld(c));
}

/** Column a fast-forwarded card goes to: the first after the Backlog it does not skip (Done at worst). */
export function fastForwardTarget(columns: Column[], skipColumnIds: string[] | undefined): Column | undefined {
  return resolveNextColumn(columns, { columnId: BACKLOG_COLUMN_ID, skipColumnIds });
}
