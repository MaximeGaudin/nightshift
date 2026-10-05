import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isStale, type QuotaLevel, type QuotaSnapshot, type QuotaWindow, quotaLevel, windowExpired } from "../shared/usage.ts";
import { useUsage } from "./api.ts";
import { type Locale, t, useT } from "./i18n/index.ts";
import { useNow } from "./useNow.ts";

const INTL: Record<Locale, string> = { en: "en-US", fr: "fr-FR" };
const LEVEL_CLASS: Record<QuotaLevel, string> = { normal: "text-muted-foreground", warn: "text-warn", danger: "text-destructive" };

type WindowKey = "fiveHour" | "sevenDay";
const WINDOWS: { key: WindowKey; label: "board.quota.fiveHour" | "board.quota.sevenDay" }[] = [
  { key: "fiveHour", label: "board.quota.fiveHour" },
  { key: "sevenDay", label: "board.quota.sevenDay" },
];

export const percent = (w: QuotaWindow) => Math.round(w.utilization * 100);

/** "2 h 15", "15 min", "3 j 4 h": rounded up to the minute, so a running countdown never shows 0 before the reset. */
export function formatDuration(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 60000));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return t("board.quota.duration.dh", { d, h });
  if (h > 0) return t("board.quota.duration.hm", { h, m });
  return t("board.quota.duration.m", { m });
}

/** "14:00", or "Thu 14:00" when the reset is not today (local time). */
export function formatReset(resetsAtSec: number, nowMs: number, locale: Locale): string {
  const date = new Date(resetsAtSec * 1000);
  const time = date.toLocaleTimeString(INTL[locale], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date(nowMs).toDateString()) return time;
  return `${date.toLocaleDateString(INTL[locale], { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

/** One tooltip line per window, then the age of the data, then the overage warning. */
export function quotaTooltipLines(usage: QuotaSnapshot, nowMs: number, locale: Locale): string[] {
  const lines: string[] = [];
  for (const { key, label } of WINDOWS) {
    const w = usage[key];
    if (!w) continue;
    lines.push(
      windowExpired(w, nowMs)
        ? `${t(label)} : ${t("board.quota.expired")}`
        : `${t(label)} : ${percent(w)} % · ${t("board.quota.resetAt", { time: formatReset(w.resetsAt, nowMs, locale) })} · ${t("board.quota.resetIn", { duration: formatDuration(w.resetsAt * 1000 - nowMs) })}`,
    );
  }
  const age = nowMs - Date.parse(usage.at);
  lines.push(age < 60000 ? t("board.quota.updatedNow") : t("board.quota.updated", { duration: formatDuration(age) }));
  if (usage.isUsingOverage) lines.push(t("board.quota.overage"));
  return lines;
}

function Gauge({ w, label, status, nowMs }: { w: QuotaWindow; label: string; status?: string; nowMs: number }) {
  const expired = windowExpired(w, nowMs);
  const level = expired ? "normal" : quotaLevel(w, status);
  return (
    <span className={`inline-flex items-center gap-1 ${LEVEL_CLASS[level]}`} data-level={level}>
      <span>{expired ? t("board.quota.gaugeExpired", { label }) : t("board.quota.gauge", { label, percent: percent(w) })}</span>
      <span className="h-1 w-6 overflow-hidden rounded-full bg-current/20" aria-hidden="true">
        <span className="block h-full bg-current" style={{ width: expired ? 0 : `${Math.min(100, percent(w))}%` }} />
      </span>
    </span>
  );
}

/** Presentational half: the snapshot and the current time come from outside, so it renders without network or timers. */
export function QuotaIndicatorView({ usage, now }: { usage: QuotaSnapshot | null; now: number }) {
  const { locale } = useT();
  const lines = usage ? quotaTooltipLines(usage, now, locale) : [t("board.quota.empty")];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-2.5 rounded-md text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring ${usage && isStale(usage, now) ? "opacity-60" : ""}`}
          aria-label={lines.join(". ")}
        >
          {usage ? (
            WINDOWS.map(({ key, label }) => {
              const w = usage[key];
              return w ? <Gauge key={key} w={w} label={t(label)} status={usage.status} nowMs={now} /> : null;
            })
          ) : (
            <span className="text-muted-foreground">{t("board.quota.none")}</span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-0.5">
          {lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Header indicator of the Claude quota; the countdown follows the shared ticker. */
export function QuotaIndicator() {
  const usage = useUsage();
  return <QuotaIndicatorView usage={usage} now={useNow()} />;
}
