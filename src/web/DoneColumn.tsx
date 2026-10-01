import type { ReactNode } from "react";
import type { Card } from "../shared/types.ts";
import { sortDoneCards } from "./doneColumn.ts";

export interface DoneColumnProps {
  cards: Card[];
  /** True while a card is being dragged anywhere on the board. */
  dragging: boolean;
  /** True while the dragged card hovers this column. */
  dropActive: boolean;
  onDragOverDone: () => void;
  onDragLeaveDone: () => void;
  /** Dropping never carries an index: Done is ordered by date, not by hand. */
  onDropDone: () => void;
  collapsed: boolean;
  onToggle: () => void;
  renderCard: (card: Card) => ReactNode;
}

export function DoneColumn({
  cards,
  dragging,
  dropActive,
  onDragOverDone,
  onDragLeaveDone,
  onDropDone,
  collapsed,
  onToggle,
  renderCard,
}: DoneColumnProps) {
  const dnd = {
    onDragOver: (e: React.DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      onDragOverDone();
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) onDragLeaveDone();
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      onDropDone();
    },
  };

  if (collapsed) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: the whole strip is both the toggle and a drop target; a native button cannot host the drag and drop handlers and the counter layout
      <div
        className={`column done done-collapsed ${dropActive ? "drop-target" : ""}`}
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
        {...dnd}
      >
        <span className="done-strip-label">Done</span>
        <span className="count">{cards.length}</span>
      </div>
    );
  }

  return (
    <section className={`column done ${dropActive ? "drop-target" : ""}`} {...dnd}>
      {/* biome-ignore lint/a11y/useSemanticElements: a <header> carries the column heading (h2); the button role and the keyboard handlers make it the collapse toggle without a native button around a heading */}
      <header
        className="column-head done-head"
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
        <div className="column-title">
          <span className="done-chevron" aria-hidden="true">
            ▾
          </span>
          <h2>Done</h2>
          <span className="count">{cards.length}</span>
        </div>
      </header>
      <div className="cards">
        {sortDoneCards(cards).map((card) => (
          <div key={card.id}>{renderCard(card)}</div>
        ))}
      </div>
    </section>
  );
}
