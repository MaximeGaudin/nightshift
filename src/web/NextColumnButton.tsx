import { useState } from "react";
import { resolveNextColumn } from "../shared/skip.ts";
import { agentBlocker, type Board, type Card, type Column, type LiveStatus } from "../shared/types.ts";
import { api } from "./api.ts";
import { Button } from "./components/ui/button.tsx";

/** Colonne suivante si la colonne de la fiche est inerte, sinon undefined. */
export function nextInertTarget(board: Board, card: Card): Column | undefined {
  if (board.columns.find((c) => c.id === card.columnId)?.type !== "inert") return undefined;
  return resolveNextColumn(board.columns, card);
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

const BLOCKER_TITLES = {
  working: "L'agent n'a pas fini : attendez la fin de son travail (ou arrêtez-le) avant d'envoyer la fiche plus loin.",
  question: "L'agent attend une réponse : répondez-lui avant d'envoyer la fiche plus loin.",
};

export function NextColumnButton({
  project,
  card,
  board,
  beforeMove,
  onError,
  live,
}: {
  project: string;
  card: Card;
  board: Board;
  beforeMove: () => Promise<void> | void;
  onError: (message: string) => void;
  live?: LiveStatus;
}) {
  const [busy, setBusy] = useState(false);
  const target = nextInertTarget(board, card);
  if (!target) return null;
  const blocker = agentBlocker(card, live);
  return (
    <Button
      type="button"
      disabled={busy || blocker !== undefined}
      title={blocker ? BLOCKER_TITLES[blocker] : undefined}
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
    </Button>
  );
}
