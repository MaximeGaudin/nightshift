import { useEffect, useState } from "react";
import { cardTimeSlices, formatDuration, formatPercent, type TimePart, type TimeSlice } from "../shared/timeline.ts";
import type { Board, Card } from "../shared/types.ts";

const HUES = [210, 25, 145, 280, 50, 340, 175, 100];
const PART_LABEL: Record<TimePart, string> = {
  queued: "En file (concurrence)",
  running: "Agent en cours",
  human: "Attente humaine",
  legacy: "Détail indisponible",
  inert: "",
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
  const slices = cardTimeSlices(card, board.columns, nowMs);
  const total = slices.reduce((sum, s) => sum + s.ms, 0);
  if (!slices.length || total <= 0) return <p className="muted">Pas encore de temps mesuré</p>;

  const parts = slices.map((s) => {
    const idx = hueIndex(board, s);
    const label = PART_LABEL[s.part];
    const title = `${s.columnName}${label ? ` — ${label}` : ""} : ${formatDuration(s.ms)} (${formatPercent(s.ms, total)})`;
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
    <div className="time-panel">
      <svg
        className="time-pie"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        role="img"
        aria-label="Répartition du temps par colonne"
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
      <ul className="time-legend">
        {parts.map((p) => (
          <li key={p.key}>
            <svg className="time-swatch" width="12" height="12" aria-hidden>
              <rect width="12" height="12" rx="2" fill={p.fill} />
            </svg>
            <span className="time-col">{p.s.columnName}</span>
            <span className="time-part muted">{p.label}</span>
            <span className="time-dur">{formatDuration(p.s.ms)}</span>
            <span className="time-pct muted">{formatPercent(p.s.ms, total)}</span>
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
