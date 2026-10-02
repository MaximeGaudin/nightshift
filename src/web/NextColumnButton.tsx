import { useState } from "react";
import { resolveNextColumn } from "../shared/skip.ts";
import { agentBlocker, type Board, type Card, type Column, type LiveStatus } from "../shared/types.ts";
import { api } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { t, useT } from "./i18n/index.ts";

/** Next column when the card column is inert, otherwise undefined. */
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
  /** Called once the card has moved, never on failure. */
  onMoved?: () => void;
  moveCard?: (project: string, id: string, columnId: string, index?: number) => Promise<unknown>;
}

/** Runs beforeMove, then moves the card to the end of the target column. Returns true if moved. */
export async function sendToNext({
  project,
  card,
  target,
  beforeMove,
  onError,
  onMoved,
  moveCard = api.moveCard,
}: SendToNextArgs): Promise<boolean> {
  try {
    await beforeMove();
    await moveCard(project, card.id, target.id);
    onMoved?.();
    return true;
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

const blockerTitle = (blocker: "working" | "question"): string =>
  blocker === "working" ? t("board.next.blockedWorking") : t("board.next.blockedQuestion");

export function NextColumnButton({
  project,
  card,
  board,
  beforeMove,
  onError,
  onMoved,
  live,
}: {
  project: string;
  card: Card;
  board: Board;
  beforeMove: () => Promise<void> | void;
  onError: (message: string) => void;
  onMoved?: () => void;
  live?: LiveStatus;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const target = nextInertTarget(board, card);
  if (!target) return null;
  const blocker = agentBlocker(card, live);
  return (
    <Button
      type="button"
      disabled={busy || blocker !== undefined}
      title={blocker ? blockerTitle(blocker) : undefined}
      onClick={async () => {
        setBusy(true);
        try {
          await sendToNext({ project, card, target, beforeMove, onError, onMoved });
        } finally {
          setBusy(false);
        }
      }}
    >
      {t("board.next.sendTo", { name: target.name })}
    </Button>
  );
}
