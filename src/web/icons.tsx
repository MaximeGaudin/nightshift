// Inline SVG icons (Linear-style). No dependency; every stroke/fill uses currentColor,
// so color comes from CSS (.st-<status>, .col-<type>, or the parent's color).
import type { ReactNode } from "react";
import { type Column, columnEmoji, type LiveStatus, type RunStatus } from "../shared/types.ts";

type Status = RunStatus | LiveStatus;

function Svg({ size = 14, className, children }: { size?: number; className: string; children: ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const STATUS_SHAPES: Record<Status, ReactNode> = {
  queued: <circle cx="7" cy="7" r="5.5" strokeDasharray="2 2.32" />,
  running: (
    <>
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" stroke="none" />
    </>
  ),
  success: (
    <>
      <circle cx="7" cy="7" r="6.25" fill="currentColor" stroke="none" />
      <path d="M4.4 7.2l1.8 1.8 3.4-3.6" stroke="var(--surface)" />
    </>
  ),
  error: (
    <>
      <circle cx="7" cy="7" r="5.5" />
      <path d="M5 5l4 4M9 5l-4 4" />
    </>
  ),
  cancelled: (
    <>
      <circle cx="7" cy="7" r="5.5" />
      <path d="M3.1 10.9l7.8-7.8" />
    </>
  ),
  question: (
    <>
      <circle cx="7" cy="7" r="5.5" />
      <path d="M5.4 5.6a1.6 1.6 0 1 1 2.3 1.4c-.5.3-.7.6-.7 1.1" />
      <circle cx="7" cy="10.1" r="0.4" fill="currentColor" />
    </>
  ),
};

/** Run or live state of a card, colored by the `.st-<status>` class. */
export function StatusIcon({ status }: { status: Status }) {
  return <Svg className={`st-icon st-${status}`}>{STATUS_SHAPES[status]}</Svg>;
}

const BOLT = <path d="M7.8 1.5L3 8h3.6l-.6 4.5L11 6H7.3z" fill="currentColor" strokeWidth={1} />;

/** Column kind: inert = empty circle, skill = bolt. */
export function ColumnIcon({ type }: { type: Column["type"] }) {
  return <Svg className={`col-icon col-${type}`}>{type === "skill" ? BOLT : <circle cx="7" cy="7" r="5.5" />}</Svg>;
}

/** Column glyph: the custom emoji when set, else the type icon. Same 14px box in both cases. */
export function ColumnGlyph({ col }: { col: Pick<Column, "type" | "emoji"> }) {
  const emoji = columnEmoji(col);
  if (emoji) {
    return (
      <span className="col-icon col-emoji" aria-hidden="true">
        {emoji}
      </span>
    );
  }
  return <ColumnIcon type={col.type} />;
}

export type IconName = "moon" | "close" | "plus" | "bolt" | "folder" | "trash" | "play" | "stop" | "lock" | "arrowRight" | "skip" | "pause";

const ICONS: Record<IconName, ReactNode> = {
  moon: <path d="M11.8 8.6A5 5 0 0 1 5.4 2.2a5 5 0 1 0 6.4 6.4z" fill="currentColor" />,
  close: <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />,
  plus: <path d="M7 2.5v9M2.5 7h9" />,
  arrowRight: <path d="M2.5 7h9M8 3.5L11.5 7 8 10.5" />,
  skip: <path d="M2.5 3.5L6 7l-3.5 3.5M7.5 3.5L11 7l-3.5 3.5" />,
  bolt: BOLT,
  folder: <path d="M1.75 4a1 1 0 0 1 1-1h2.6l1.3 1.4h4.6a1 1 0 0 1 1 1v5.1a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1z" />,
  trash: <path d="M2.5 3.8h9M5.5 3.8V2.5h3v1.3M3.7 3.8l.6 7.7h5.4l.6-7.7M5.8 6v3.5M8.2 6v3.5" />,
  play: <path d="M4.5 2.8v8.4L11 7z" fill="currentColor" />,
  pause: <path d="M4.5 3v8M9.5 3v8" />,
  lock: <path d="M3.8 6.2h6.4v5.3H3.8zM5 6.2V4.5a2 2 0 0 1 4 0v1.7" />,
  stop: <rect x="3.5" y="3.5" width="7" height="7" rx="1" fill="currentColor" />,
};

/** Generic UI glyph, colored by currentColor. */
export function Icon({ name, size }: { name: IconName; size?: number }) {
  return (
    <Svg size={size} className={`icon icon-${name}`}>
      {ICONS[name]}
    </Svg>
  );
}
