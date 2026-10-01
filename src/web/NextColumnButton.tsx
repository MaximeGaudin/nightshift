import { useState } from "react";
import type { Board, Card, Column } from "../shared/types.ts";
import { api } from "./api.ts";

/** Colonne suivante si la colonne de la fiche est inerte, sinon undefined. */
export function nextInertTarget(board: Board, card: Card): Column | undefined {
  const index = board.columns.findIndex((c) => c.id === card.columnId);
  if (index < 0 || board.columns[index]?.type !== "inert") return undefined;
  return board.columns[index + 1];
}

export interface SendToNextArgs {
  project: string;
  card: Card;
  target: Column;
  beforeMove: () => Promise<void> | void;
  onError: (message: string) => void;
  moveCard?: (project: string, id: string, columnId: string, index?: number) => Promise<unknown>;
}

/** Runs beforeMove, then moves the card to the end of the target column. Returns true if moved. */
export async function sendToNext({
  project,
  card,
  target,
  beforeMove,
  onError,
  moveCard = api.moveCard,
}: SendToNextArgs): Promise<boolean> {
  try {
    await beforeMove();
    await moveCard(project, card.id, target.id);
    return true;
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

export function NextColumnButton({
  project,
  card,
  board,
  beforeMove,
  onError,
}: {
  project: string;
  card: Card;
  board: Board;
  beforeMove: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const target = nextInertTarget(board, card);
  if (!target) return null;
  return (
    <button
      type="button"
      className="primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await sendToNext({ project, card, target, beforeMove, onError });
        } finally {
          setBusy(false);
        }
      }}
    >
      Envoyer à {target.name} →
    </button>
  );
}
