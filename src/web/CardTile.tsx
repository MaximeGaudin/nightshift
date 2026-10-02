import { ArrowRight, ChevronsRight } from "lucide-react";
import type { HTMLAttributes, KeyboardEvent, Ref } from "react";
import { resolveModel } from "../shared/models.ts";
import { type Card, type Column, cardRef, type LiveStatus, type RunProgress as RunProgressData, type Settings } from "../shared/types.ts";
import { CardThumbnail } from "./CardThumbnail.tsx";
import { IconButton } from "./components/icon-button.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { useT } from "./i18n/index.ts";
import { StatusIcon } from "./icons.tsx";
import { cn } from "./lib/utils.ts";
import { toPlainText } from "./markdown.tsx";
import { RunProgress } from "./RunProgress.tsx";

export function SequenceBadge() {
  const { t } = useT();
  return (
    <Badge variant="secondary" className="sequence-badge ml-1.5 align-middle">
      {t("board.sequential")}
    </Badge>
  );
}

/** The card's own model when it is the one that will run (skill column, not locked); otherwise null. */
export function cardModelOverride(column: Column | undefined, settings: Pick<Settings, "model"> | null | undefined, card: Card) {
  if (column?.type !== "skill") return null;
  const r = resolveModel(column, { model: settings?.model ?? "" }, card);
  if (r.source !== "card" || !r.model) return null;
  return { model: r.model, columnModel: column.model?.trim() || undefined };
}

export function CardTile({
  project,
  card,
  live,
  progress,
  dragging,
  dndProps,
  tileRef,
  onOpen,
  next,
  skipped,
  waitingFor,
  onSendNext,
  sending,
  sequential,
  column,
  settings,
}: {
  project: string;
  card: Card;
  live?: LiveStatus;
  progress?: RunProgressData;
  /** The tile is the one being dragged (its slot is dimmed while the overlay follows the pointer). */
  dragging?: boolean;
  /** Attributes and listeners of the drag and drop wrapper; the tile itself stays free of dnd-kit. */
  dndProps?: HTMLAttributes<HTMLElement>;
  tileRef?: Ref<HTMLElement>;
  onOpen: () => void;
  next?: { name: string };
  skipped?: string[];
  /** Refs of the unmet dependencies of a card held in Backlog ([] when they are all done); undefined when not held. */
  waitingFor?: string[];
  onSendNext?: () => void;
  sending?: boolean;
  /** The sequential mode is working on this card. */
  sequential?: boolean;
  /** The column the card is in, and the settings, to flag a card model that overrides the column's. */
  column?: Column;
  settings?: Pick<Settings, "model"> | null;
}) {
  const { t, tn } = useT();
  const override = cardModelOverride(column, settings, card);
  const lr = card.lastRun?.columnId === card.columnId ? card.lastRun : undefined;
  const status = live ?? lr?.status;
  const excerpt = card.description ? toPlainText(card.description).slice(0, 160) : "";
  const label: Record<string, string> = {
    running: t("board.status.running"),
    queued: t("board.status.queued"),
    success: t("board.status.success"),
    error: t("board.status.error"),
    cancelled: t("board.status.cancelled"),
    question: t("board.status.question"),
  };
  const statusColor = status === "error" ? "text-err" : status === "question" ? "text-warn" : status === "running" ? "text-foreground" : "";
  return (
    <article
      ref={tileRef}
      {...dndProps}
      data-card
      className={cn(
        "card group relative cursor-pointer touch-manipulation rounded-lg border bg-card px-3 py-2 outline-none transition-colors duration-150 hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring",
        status === "question" && "st-question border-warn-soft hover:border-warn",
        status && status !== "question" && `st-${status}`,
        dragging && "dragging opacity-40",
      )}
      onClick={onOpen}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the tile is a focusable surface that opens the card with Enter and starts a keyboard drag with Space; it holds its own buttons, so a button role would nest controls
      tabIndex={0}
      onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
        dndProps?.onKeyDown?.(e);
        // Enter opens the card, except while it is being dragged with the keyboard.
        if (e.key === "Enter" && !dragging) onOpen();
      }}
    >
      <CardThumbnail project={project} card={card} />
      <div className="card-ref mb-0.5 flex min-h-5 items-center gap-1 pr-6 text-[11px] text-muted-foreground tabular-nums">
        <span>{cardRef(card)}</span>
        {sequential && <SequenceBadge />}
        {override && (
          <Badge
            variant="secondary"
            className="model-badge"
            title={override.columnModel ? t("board.card.modelBadge", { column: override.columnModel }) : t("board.card.modelBadgeNone")}
          >
            {override.model}
          </Badge>
        )}
        {waitingFor && (
          <Badge
            variant="outline"
            className="waiting-badge"
            title={waitingFor.length > 0 ? t("board.card.waitingTitle", { refs: waitingFor.join(", ") }) : undefined}
          >
            {waitingFor.length > 0 ? t("board.card.waiting", { refs: waitingFor.join(", ") }) : t("board.card.waitingDone")}
          </Badge>
        )}
        {skipped && skipped.length > 0 && (
          <span
            className="card-skipped inline-flex text-muted-foreground"
            title={t("board.card.skippedColumns", { names: skipped.join(", ") })}
            role="img"
            aria-label={t("board.card.skippedColumns", { names: skipped.join(", ") })}
          >
            <ChevronsRight size={12} strokeWidth={1.75} aria-hidden="true" focusable="false" />
          </span>
        )}
        {next && (
          <IconButton
            label={t("board.card.sendTo", { name: next.name })}
            title={t("board.card.sendTo", { name: next.name })}
            className="card-next absolute top-1.5 right-1.5 size-5 text-muted-foreground opacity-0 hover:text-foreground group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
            disabled={sending}
            draggable={false}
            onClick={(e) => {
              e.stopPropagation();
              onSendNext?.();
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <ArrowRight size={12} strokeWidth={1.75} aria-hidden="true" focusable="false" />
          </IconButton>
        )}
      </div>
      <h3 className="text-[13px] leading-snug font-medium [overflow-wrap:anywhere]">{card.title}</h3>
      {excerpt && (
        <p className="excerpt mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">{excerpt}</p>
      )}
      {status && (
        <div className={cn("status mt-2 flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground", `st-${status}`)}>
          <StatusIcon status={status} />
          <span className={cn("status-label shrink-0", statusColor)}>{label[status]}</span>
          {status === "success" && lr?.summary && (
            <span className="muted min-w-0 truncate font-normal"> · {toPlainText(lr.summary).slice(0, 80)}</span>
          )}
          {status === "question" && lr?.questions && (
            <span className="muted min-w-0 truncate font-normal"> · {tn("board.card.questions", lr.questions.length)}</span>
          )}
        </div>
      )}
      <RunProgress progress={progress} live={live} />
    </article>
  );
}
