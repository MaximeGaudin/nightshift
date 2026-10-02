import { Timer } from "lucide-react";
import { cardTimers, type DurationUnits, formatDuration } from "../shared/timeline.ts";
import type { Card, Column } from "../shared/types.ts";
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
 * Chronos of a tile as "⏱ step / total"; nothing for a card in Backlog or Done. Ticks with the shared board clock.
 * `inline` renders them in parentheses inside the status line; otherwise they get their own line.
 */
export function CardTimers({ card, columns, column, inline }: { card: Card; columns: Column[]; column?: Column; inline?: boolean }) {
  useT();
  const nowMs = useNow();
  const timers = cardTimers(card, columns, nowMs);
  if (!timers) return null;
  const units = durationUnits();
  const total = formatDuration(timers.totalMs, units);
  const step = formatDuration(timers.stepMs, units);
  const chronos = (
    <span className="flex items-center gap-1">
      <Timer size={12} strokeWidth={1.75} aria-hidden="true" focusable="false" className="shrink-0" />
      <span className="card-timer-step" title={t("board.card.timerStepTitle", { column: column?.name ?? card.columnId })}>
        {step}
      </span>
      <span aria-hidden="true">/</span>
      <span className="card-timer-total" title={t("board.card.timerTotalTitle")}>
        {total}
      </span>
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
