// Icons on lucide-react. Every stroke uses currentColor, so color comes from CSS (.st-<status>, .col-<type>, or the parent's color).
import {
  ArrowRight,
  Ban,
  ChevronsRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  CircleX,
  Folder,
  LoaderCircle,
  Lock,
  type LucideIcon,
  Moon,
  Pause,
  Play,
  Plus,
  Square,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { type Column, columnEmoji, type LiveStatus, type RunStatus } from "../shared/types.ts";

type Status = RunStatus | LiveStatus;

const STATUS_ICONS: Record<Status, LucideIcon> = {
  queued: CircleDashed,
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

export type IconName = "moon" | "close" | "plus" | "bolt" | "folder" | "trash" | "play" | "stop" | "lock" | "arrowRight" | "skip" | "pause";

const ICONS: Record<IconName, LucideIcon> = {
  moon: Moon,
  close: X,
  plus: Plus,
  arrowRight: ArrowRight,
  skip: ChevronsRight,
  bolt: Zap,
  folder: Folder,
  trash: Trash2,
  play: Play,
  pause: Pause,
  lock: Lock,
  stop: Square,
};

/** Adapter over lucide for the legacy `<Icon name=… />` call sites; new code imports lucide-react directly. */
export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  const Glyph = ICONS[name];
  return <Glyph className={`icon icon-${name}`} size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />;
}
