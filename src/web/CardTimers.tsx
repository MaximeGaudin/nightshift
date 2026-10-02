import { Timer } from "lucide-react";
import { cardTimers, type DurationUnits, formatDuration } from "../shared/timeline.ts";
import type { Card, Column } from "../shared/types.ts";
import { t, useT } from "./i18n/index.ts";
import { useNow } from "./useNow.ts";

const durationUnits = (): DurationUnits => ({
  second: t("time.unit.second"),
  minute: t("time.unit.minute"),
  hour: t("time.unit.hour"),
  day: t("time.unit.day"),
});

/** Total and current-step chronos of a tile; nothing for a card in Backlog or Done. Ticks with the shared board clock. */
export function CardTimers({ card, columns, column }: { card: Card; columns: Column[]; column?: Column }) {
  useT();
  const nowMs = useNow();
  const timers = cardTimers(card, columns, nowMs);
  if (!timers) return null;
  const units = durationUnits();
  const total = formatDuration(timers.totalMs, units);
  const step = formatDuration(timers.stepMs, units);
  return (
    <div className="card-timers mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
      <Timer size={12} strokeWidth={1.75} aria-hidden="true" focusable="false" className="shrink-0" />
      <span className="card-timer-total" title={t("board.card.timerTotalTitle")}>
        {total}
      </span>
      <span aria-hidden="true">·</span>
      <span className="card-timer-step truncate" title={t("board.card.timerStepTitle", { column: column?.name ?? card.columnId })}>
        {t("board.card.timerStep", { duration: step })}
      </span>
    </div>
  );
}
