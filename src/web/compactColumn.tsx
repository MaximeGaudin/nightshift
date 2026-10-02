import { Plus } from "lucide-react";
import { type Column, columnEmoji, columnMaxParallel } from "../shared/types.ts";
import { IconButton } from "./components/icon-button.tsx";
import { t, useT } from "./i18n/index.ts";
import { ColumnGlyph } from "./icons.tsx";

/** Shell of a wide column: shares the free space equally between 290px and 560px; the fixed basis stops a long badge from widening it. */
export const WIDE_COLUMN =
  "column flex max-h-full min-w-[290px] max-w-[560px] flex-[1_0_290px] flex-col rounded-lg border border-transparent bg-lane p-1.5 transition-colors duration-150";
/** Shell of a strip (compact or collapsed Done): fixed width, opts out of the wide rules above. */
export const STRIP_COLUMN =
  "column flex max-h-full min-w-0 max-w-none flex-col overflow-hidden rounded-lg border border-transparent bg-lane transition-colors duration-150";
/** Highlight of the column under the dragged card. */
export const DROP_TARGET = "drop-target border-primary bg-primary/8";

/** A column collapses into a thin band when it is empty and not manually expanded. */
export function isCompactColumn(cardCount: number, expanded: boolean): boolean {
  return cardCount === 0 && !expanded;
}

/** Tooltip of the compact band: name, skill, model and parallelism of the column. */
export function compactColumnTitle(col: Column): string {
  const emoji = columnEmoji(col);
  const parts = [emoji ? `${emoji} ${col.name}` : col.name];
  if (col.type === "skill") {
    parts.push(col.skill ? t("board.compact.skill", { skill: col.skill }) : t("board.compact.noSkill"));
    if (col.model !== undefined) parts.push(t("board.compact.model", { model: col.model }));
    parts.push(t("board.compact.agents", { max: columnMaxParallel(col) }));
  } else {
    parts.push(t("board.compact.inert"));
  }
  return parts.join(" — ");
}

/** Content of a compact column (the caller renders the surrounding <section>). */
export function CompactColumnBand({ col, onAdd }: { col: Column; onAdd: () => void }) {
  const { t } = useT();
  return (
    <div className="column-band flex min-h-0 flex-1 flex-col items-center justify-start gap-2 overflow-hidden py-3 *:shrink-0">
      <ColumnGlyph col={col} />
      <span className="count text-xs text-muted-foreground tabular-nums">0</span>
      <IconButton label={t("board.addCard")} className="band-add ghost size-6" onClick={onAdd}>
        <Plus size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
      </IconButton>
      <h2 className="band-name max-h-full min-h-0 shrink! flex-auto overflow-hidden text-[13px] font-medium text-ellipsis whitespace-nowrap [writing-mode:vertical-rl]">
        {col.name}
      </h2>
    </div>
  );
}
