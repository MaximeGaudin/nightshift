import { useEffect, useState } from "react";
import { cardTimeSlices, formatDuration, formatPercent, type TimePart, type TimeSlice } from "../shared/timeline.ts";
import type { Board, Card } from "../shared/types.ts";
import { type MessageKey, t, useT } from "./i18n/index.ts";

const HUES = [210, 25, 145, 280, 50, 340, 175, 100];
const PART_LABEL_KEY: Record<TimePart, MessageKey | null> = {
  queued: "card.time.queued",
  running: "card.time.running",
  human: "card.time.human",
  legacy: "card.time.legacy",
  inert: null,
};
const PART_LIGHTNESS: Record<Exclude<TimePart, "legacy">, number> = { queued: 74, running: 52, human: 34, inert: 52 };

const SIZE = 160;
const R = SIZE / 2 - 4;
const C = SIZE / 2;

/** Hue slot of the slice's column: its board index modulo the palette, or null (grey) for a deleted column. */
function hueIndex(board: Board, s: TimeSlice): number | null {
  const i = s.columnId !== undefined ? board.columns.findIndex((c) => c.id === s.columnId) : -1;
  return i < 0 ? null : i % HUES.length;
}

function baseColor(idx: number | null, lightness: number): string {
  return idx === null ? `hsl(0 0% ${lightness}%)` : `hsl(${HUES[idx]} 65% ${lightness}%)`;
}

function patternId(idx: number | null): string {
  return `time-legacy-${idx ?? "x"}`;
}

function fillFor(s: TimeSlice, idx: number | null): string {
  return s.part === "legacy" ? `url(#${patternId(idx)})` : baseColor(idx, PART_LIGHTNESS[s.part]);
}

function arcPath(from: number, to: number): string {
  const pt = (a: number) => `${(C + R * Math.cos(a)).toFixed(3)} ${(C + R * Math.sin(a)).toFixed(3)}`;
  const large = to - from > Math.PI ? 1 : 0;
  return `M ${C} ${C} L ${pt(from)} A ${R} ${R} 0 ${large} 1 ${pt(to)} Z`;
}

/** Runs `onTick` every `ms` until the returned function is called. */
export function startTicker(onTick: () => void, ms = 1000): () => void {
  const id = setInterval(onTick, ms);
  return () => clearInterval(id);
}

/** Pie and legend at a given instant. Pure rendering, no timer. */
export function TimePanelView({ card, board, nowMs }: { card: Card; board: Board; nowMs: number }) {
  useT();
  const slices = cardTimeSlices(card, board.columns, nowMs);
  const total = slices.reduce((sum, s) => sum + s.ms, 0);
  if (!slices.length || total <= 0) return <p className="m-0 font-sans text-muted-foreground">{t("card.time.empty")}</p>;

  const parts = slices.map((s) => {
    const idx = hueIndex(board, s);
    const labelKey = PART_LABEL_KEY[s.part];
    const label = labelKey ? t(labelKey) : "";
    const params = { column: s.columnName, part: label, duration: formatDuration(s.ms), percent: formatPercent(s.ms, total) };
    const title = t(label ? "card.time.sliceTitleWithPart" : "card.time.sliceTitle", params);
    // One slice per column and part (see cardTimeSlices): that pair is the identity of the slice.
    const key = `${s.columnId ?? `name:${s.columnName}`}:${s.part}`;
    return { s, idx, label, title, key, fill: fillFor(s, idx) };
  });
  const patternIdxs = [...new Set(parts.filter((p) => p.s.part === "legacy").map((p) => p.idx))];

  let angle = -Math.PI / 2;
  const shapes = parts.map((p) => {
    const sweep = (p.s.ms / total) * 2 * Math.PI;
    const from = angle;
    angle += sweep;
    return p.s.ms >= total ? (
      <circle key={p.key} cx={C} cy={C} r={R} fill={p.fill}>
        <title>{p.title}</title>
      </circle>
    ) : (
      <path key={p.key} d={arcPath(from, angle)} fill={p.fill}>
        <title>{p.title}</title>
      </path>
    );
  });

  return (
    <div className="time-panel flex flex-col items-center gap-3 font-sans text-[13px]">
      <svg
        className="time-pie shrink-0"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        role="img"
        aria-label={t("card.time.chartLabel")}
      >
        <defs>
          {patternIdxs.map((idx) => (
            <pattern
              key={patternId(idx)}
              id={patternId(idx)}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" fill={baseColor(idx, 80)} />
              <rect width="3" height="6" fill={baseColor(idx, 52)} />
            </pattern>
          ))}
        </defs>
        {shapes}
      </svg>
      <ul className="time-legend m-0 flex w-full min-w-0 list-none flex-col gap-1 p-0">
        {parts.map((p) => (
          <li key={p.key} className="grid grid-cols-[12px_minmax(0,1fr)_auto_auto_auto] items-center gap-2">
            <svg className="time-swatch shrink-0" width="12" height="12" aria-hidden>
              <rect width="12" height="12" rx="2" fill={p.fill} />
            </svg>
            <span className="time-col truncate">{p.s.columnName}</span>
            <span className="time-part text-xs text-muted-foreground">{p.label}</span>
            <span className="time-dur tabular-nums">{formatDuration(p.s.ms)}</span>
            <span className="time-pct text-right text-xs text-muted-foreground tabular-nums">{formatPercent(p.s.ms, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** « Temps » tab: refreshes every second while mounted. */
export function TimePanel({ card, board }: { card: Card; board: Board }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
    return startTicker(() => setNowMs(Date.now()));
  }, []);
  return <TimePanelView card={card} board={board} nowMs={nowMs} />;
}
