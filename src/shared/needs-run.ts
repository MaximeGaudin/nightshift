import type { Board, Card } from "./types.ts";

/** A card needs an agent run when it sits in a skill column and has not been processed since it entered it. */
export function needsRun(board: Board, card: Card): boolean {
  const col = board.columns.find((c) => c.id === card.columnId);
  if (!col) return false;
  // pendingAnswer only exists in the current column (moveCard clears it): run whatever the column type.
  if (card.pendingAnswer) return true;
  if (col.type !== "skill" || !col.skill) return false;
  const lr = card.lastRun;
  if (!lr || lr.columnId !== card.columnId) return true;
  return lr.at < card.enteredColumnAt;
}
