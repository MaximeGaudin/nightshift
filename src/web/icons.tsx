// Icons on lucide-react. Every stroke uses currentColor, so color comes from CSS (.st-<status>, .col-<type>, or the parent's color).
import {
  Ban,
  Circle,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleQuestionMark,
  CircleX,
  LoaderCircle,
  type LucideIcon,
  Zap,
} from "lucide-react";
import { type Column, columnEmoji, type LiveStatus, type RunStatus } from "../shared/types.ts";

type Status = RunStatus | LiveStatus;

const STATUS_ICONS: Record<Status, LucideIcon> = {
  queued: CircleDashed,
  paused: CirclePause,
  running: LoaderCircle,
  success: CircleCheck,
  error: CircleX,
  cancelled: Ban,
  question: CircleQuestionMark,
};

/** Run or live state of a card, colored by the `.st-<status>` class. */
export function StatusIcon({ status }: { status: Status }) {
  const Glyph = STATUS_ICONS[status];
  return <Glyph className={`st-icon st-${status}`} size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />;
}

/** Column kind: inert = empty circle, skill = bolt. */
export function ColumnIcon({ type }: { type: Column["type"] }) {
  const Glyph = type === "skill" ? Zap : Circle;
  return <Glyph className={`col-icon col-${type}`} size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />;
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
