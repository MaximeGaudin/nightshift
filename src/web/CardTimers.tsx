import { History, Hourglass, Timer } from "lucide-react";
import { cardTimers, type DurationUnits, formatDuration } from "../shared/timeline.ts";
import type { Card, Column, LiveStatus, RunEstimate } from "../shared/types.ts";
import { t, useT } from "./i18n/index.ts";
import { cn } from "./lib/utils.ts";
import { useNow } from "./useNow.ts";

const durationUnits = (): DurationUnits => ({
  second: t("time.unit.second"),
  minute: t("time.unit.minute"),
  hour: t("time.unit.hour"),
  day: t("time.unit.day"),
});

/**
 * Chronos of a tile, one icon per value: time in the step, total time, and while an agent runs with an estimate the
 * remaining time ("~5 min", or "over" once the estimate is exceeded). Nothing for a card in Backlog or Done.
 * Ticks with the shared board clock. `inline` renders them in parentheses inside the status line; otherwise they
 * get their own line.
 */
export function CardTimers({
  card,
  columns,
  column,
  inline,
  live,
  estimate,
}: {
  card: Card;
  columns: Column[];
  column?: Column;
  inline?: boolean;
  live?: LiveStatus;
  estimate?: RunEstimate;
}) {
  useT();
  const nowMs = useNow();
  const timers = cardTimers(card, columns, nowMs);
  if (!timers) return null;
  const units = durationUnits();
  const total = formatDuration(timers.totalMs, units);
  const step = formatDuration(timers.stepMs, units);
  const columnName = column?.name ?? card.columnId;
  const startedMs = estimate ? Date.parse(estimate.runStartedAt) : Number.NaN;
  const remainingMs =
    estimate && live === "running" && Number.isFinite(startedMs) ? estimate.minutes * 60_000 - (nowMs - startedMs) : undefined;
  const chronos = (
    <span className="flex items-center gap-1.5">
      <span className="card-timer-step flex items-center gap-1" title={t("board.card.timerStepTitle", { column: columnName })}>
        <Timer size={12} strokeWidth={1.75} aria-hidden="true" focusable="false" className="shrink-0" />
        {step}
      </span>
      <span aria-hidden="true">·</span>
      <span className="card-timer-total flex items-center gap-1" title={t("board.card.timerTotalTitle")}>
        <History size={12} strokeWidth={1.75} aria-hidden="true" focusable="false" className="shrink-0" />
        {total}
      </span>
      {remainingMs !== undefined && (
        <>
          <span aria-hidden="true">·</span>
          <span className="card-timer-estimate flex items-center gap-1" title={t("board.card.timerEstimateTitle", { column: columnName })}>
            <Hourglass size={12} strokeWidth={1.75} aria-hidden="true" focusable="false" className="shrink-0" />
            {remainingMs > 0 ? `~${formatDuration(remainingMs, units)}` : t("board.card.timerOverrun")}
          </span>
        </>
      )}
    </span>
  );
  return (
    <span
      className={cn(
        "card-timers flex shrink-0 items-center text-[11px] font-normal text-muted-foreground tabular-nums",
        !inline && "mt-1.5",
      )}
    >
      {/* Parentheses hug the chronos: they sit outside the gapped group. */}
      {inline && <span aria-hidden="true">(</span>}
      {chronos}
      {inline && <span aria-hidden="true">)</span>}
    </span>
  );
}
