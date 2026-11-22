// Icons on lucide-react. Every stroke uses currentColor, so color comes from CSS (.st-<status>, .col-<type>, or the parent's color).
import {
  Ban,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleQuestionMark,
  CircleStop,
  CircleX,
  Coffee,
  LoaderCircle,
  type LucideIcon,
  Zap,
} from "lucide-react";
import type { ReactElement } from "react";
import { type Column, columnEmoji, type LiveStatus, type RunStatus } from "../shared/types.ts";

/** "interrupted": a cancelled run that Nightshift itself stopped (shutdown or crash). */
type Status = RunStatus | LiveStatus | "interrupted";

const STATUS_ICONS: Record<Status, LucideIcon> = {
  queued: CircleDashed,
  paused: CirclePause,
  running: LoaderCircle,
  success: CircleCheck,
  error: CircleX,
  cancelled: Ban,
  interrupted: CircleStop,
  question: CircleQuestionMark,
  attention: CircleAlert,
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

/** GitHub mark, filled with currentColor (lucide has no brand icons). */
function GithubMark({ className, size = 12 }: { className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

const lucideGlyph =
  (Glyph: LucideIcon) =>
  ({ className, size = 12 }: { className?: string; size?: number }) => <Glyph size={size} aria-hidden="true" className={className} />;

/** Icon of each issue provider, keyed by provider id (see PROVIDERS); unknown ids get a generic issue icon. */
const PROVIDER_ICONS: Record<string, (props: { className?: string; size?: number }) => ReactElement> = {
  github: GithubMark,
  gitea: lucideGlyph(Coffee),
};
const FallbackProviderIcon = lucideGlyph(CircleDot);

export function ProviderIcon({ provider, className, size }: { provider: string; className?: string; size?: number }) {
  const Glyph = PROVIDER_ICONS[provider] ?? FallbackProviderIcon;
  return <Glyph className={`provider-icon provider-${provider} ${className ?? ""}`.trim()} size={size} />;
}
