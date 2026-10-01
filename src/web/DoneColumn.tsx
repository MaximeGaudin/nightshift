import { ChevronDown } from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { Card } from "../shared/types.ts";
import { DROP_TARGET, STRIP_COLUMN, WIDE_COLUMN } from "./compactColumn.tsx";
import { sortDoneCards } from "./doneColumn.ts";
import { cn } from "./lib/utils.ts";

export interface DoneColumnProps {
  cards: Card[];
  /** True while the dragged card hovers this column. */
  dropActive?: boolean;
  /** Drop zone ref of the board (dnd-kit): dropping never carries an index, Done is ordered by date, not by hand. */
  dropRef?: Ref<HTMLElement>;
  collapsed: boolean;
  onToggle: () => void;
  renderCard: (card: Card) => ReactNode;
}

export function DoneColumn({ cards, dropActive, dropRef, collapsed, onToggle, renderCard }: DoneColumnProps) {
  if (collapsed) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: the whole strip is both the toggle and a drop target; a native button cannot host the drop zone ref and the counter layout
      <div
        ref={dropRef as Ref<HTMLDivElement>}
        className={cn(
          STRIP_COLUMN,
          "done done-collapsed w-11 flex-[0_0_44px] cursor-pointer items-center gap-2 border-border py-3 outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          dropActive && DROP_TARGET,
        )}
        role="button"
        aria-expanded="false"
        aria-label={`Done, ${cards.length} fiches. Déplier`}
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="done-strip-label text-[13px] font-medium tracking-wide [writing-mode:vertical-rl]">Done</span>
        <span className="count text-xs text-muted-foreground tabular-nums">{cards.length}</span>
      </div>
    );
  }

  return (
    <section ref={dropRef as Ref<HTMLElement>} className={cn(WIDE_COLUMN, "done", dropActive && DROP_TARGET)}>
      {/* biome-ignore lint/a11y/useSemanticElements: a <header> carries the column heading (h2); the button role and the keyboard handlers make it the collapse toggle without a native button around a heading */}
      <header
        className="column-head done-head flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 pt-1 pb-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="button"
        aria-expanded="true"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="column-title flex min-w-0 items-center gap-2">
          <ChevronDown className="done-chevron size-3.5 text-muted-foreground" aria-hidden="true" focusable="false" />
          <h2 className="text-[13px] font-medium">Done</h2>
          <span className="count text-xs text-muted-foreground tabular-nums">{cards.length}</span>
        </div>
      </header>
      <div className="cards flex min-h-5 flex-col gap-1.5 overflow-y-auto p-0.5">
        {sortDoneCards(cards).map((card) => (
          <div key={card.id}>{renderCard(card)}</div>
        ))}
      </div>
    </section>
  );
}
