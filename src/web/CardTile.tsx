import { cardRef, type Card, type LiveStatus } from "../shared/types.ts";
import { Icon, StatusIcon } from "./icons.tsx";
import { toPlainText } from "./markdown.tsx";

export function CardTile({
  card,
  live,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
  next,
  onSendNext,
  sending,
}: {
  card: Card;
  live?: LiveStatus;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  next?: { name: string };
  onSendNext?: () => void;
  sending?: boolean;
}) {
  const lr = card.lastRun?.columnId === card.columnId ? card.lastRun : undefined;
  const status = live ?? lr?.status;
  const excerpt = card.description ? toPlainText(card.description).slice(0, 160) : "";
  const label: Record<string, string> = {
    running: "En cours",
    queued: "En attente",
    success: "Traité",
    error: "Erreur",
    cancelled: "Annulé",
    question: "Question pour vous",
  };
  return (
    <article
      data-card
      className={`card ${dragging ? "dragging" : ""} ${status ? `st-${status}` : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
    >
      <div className="card-ref">
        {cardRef(card)}
        {next && (
          <button
            type="button"
            className="card-next"
            title={`Envoyer vers ${next.name}`}
            aria-label={`Envoyer vers ${next.name}`}
            disabled={sending}
            draggable={false}
            onClick={(e) => {
              e.stopPropagation();
              onSendNext?.();
            }}
            onKeyDown={(e) => e.stopPropagation()}
            onDragStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <Icon name="arrowRight" size={12} />
          </button>
        )}
      </div>
      <h3>{card.title}</h3>
      {excerpt && <p className="excerpt">{excerpt}</p>}
      {status && (
        <div className={`status st-${status}`}>
          <StatusIcon status={status} />
          <span className="status-label">{label[status]}</span>
          {status === "success" && lr?.summary && <span className="muted"> · {toPlainText(lr.summary).slice(0, 80)}</span>}
          {status === "question" && lr?.questions && (
            <span className="muted"> · {lr.questions.length} question{lr.questions.length > 1 ? "s" : ""}</span>
          )}
        </div>
      )}
    </article>
  );
}
