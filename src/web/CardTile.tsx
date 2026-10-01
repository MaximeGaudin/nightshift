import { type Card, cardRef, type LiveStatus, type RunProgress as RunProgressData } from "../shared/types.ts";
import { CardThumbnail } from "./CardThumbnail.tsx";
import { Icon, StatusIcon } from "./icons.tsx";
import { toPlainText } from "./markdown.tsx";
import { RunProgress } from "./RunProgress.tsx";

export function CardTile({
  project,
  card,
  live,
  progress,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
  next,
  onSendNext,
  sending,
}: {
  project: string;
  card: Card;
  live?: LiveStatus;
  progress?: RunProgressData;
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
      <CardThumbnail project={project} card={card} />
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
            <span className="muted">
              {" "}
              · {lr.questions.length} question{lr.questions.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
      )}
      <RunProgress progress={progress} live={live} />
    </article>
  );
}
