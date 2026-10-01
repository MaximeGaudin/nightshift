import { type Card, type Column, isDoneColumn } from "../shared/types.ts";

/** What the dragged card is hovering: another card, or the background of a column (wide, compact or Done). */
export type DropOver = { kind: "card"; cardId: string } | { kind: "column"; columnId: string };

/** Target of `api.moveCard`: no `index` means "end of column" (always the case for Done, which is ordered by date). */
export interface DropTarget {
  columnId: string;
  index?: number;
}

/**
 * Where a dropped card lands, with the server semantics of `store.moveCard`: the card is removed, then inserted before
 * `sameCol[index]`, so `index` is its final position in the target column list WITHOUT the moved card.
 * - Hovering a card takes its place: before it when coming from another column, the `arrayMove` position in the same column.
 * - Column background means end of list; an empty (compact) column gives index 0; Done gives no index.
 * - `null` when the card would end up where it started. `origin` is that start position when `cards` already holds a
 *   tentative position of the card (the live move made while dragging); it defaults to the position in `cards`.
 */
export function resolveDrop(
  columns: Column[],
  cards: Card[],
  activeId: string,
  over: DropOver,
  origin?: { columnId: string; index: number },
): DropTarget | null {
  const active = cards.find((c) => c.id === activeId);
  if (!active) return null;
  let overCard: Card | undefined;
  let columnId: string;
  if (over.kind === "card") {
    overCard = cards.find((c) => c.id === over.cardId);
    if (!overCard) return null;
    columnId = overCard.columnId;
  } else columnId = over.columnId;
  const col = columns.find((c) => c.id === columnId);
  if (!col) return null;
  const from = origin ?? {
    columnId: active.columnId,
    index: cards.filter((c) => c.columnId === active.columnId).findIndex((c) => c.id === activeId),
  };
  if (isDoneColumn(col)) return from.columnId === col.id ? null : { columnId: col.id };

  const full = cards.filter((c) => c.columnId === columnId);
  const without = full.filter((c) => c.id !== activeId);
  let index: number;
  if (!overCard) index = without.length;
  else if (overCard.id === activeId) index = full.findIndex((c) => c.id === activeId);
  else if (active.columnId === columnId) index = full.findIndex((c) => c.id === overCard.id);
  else index = without.findIndex((c) => c.id === overCard.id);
  if (from.columnId === columnId && from.index === index) return null;
  return { columnId, index };
}

/** Card ids per column while a drag is in progress (the order shown on screen, not the server's). */
export type LocalOrder = Record<string, string[]>;

export function snapshotOrder(columns: Column[], cards: Card[]): LocalOrder {
  return Object.fromEntries(columns.map((col) => [col.id, cards.filter((c) => c.columnId === col.id).map((c) => c.id)]));
}

/** Cards of each column: the server order, or `local` when set. Fresh snapshot data wins; unknown cards are appended, gone ones dropped. */
export function cardsByColumn(columns: Column[], cards: Card[], local: LocalOrder | null): Record<string, Card[]> {
  const server = Object.fromEntries(columns.map((col) => [col.id, cards.filter((c) => c.columnId === col.id)]));
  if (!local) return server;
  const byId = new Map(cards.map((c) => [c.id, c]));
  const placed = new Set<string>();
  const out: Record<string, Card[]> = {};
  for (const col of columns) {
    out[col.id] = [];
    for (const id of local[col.id] ?? []) {
      const card = byId.get(id);
      if (card && !placed.has(id)) {
        out[col.id]?.push(card);
        placed.add(id);
      }
    }
  }
  for (const card of cards) if (!placed.has(card.id)) out[card.columnId]?.push(card);
  return out;
}

/** Flat card list with the column of every card taken from the local order (input of `resolveDrop` while dragging). */
export function localCards(columns: Column[], cards: Card[], local: LocalOrder): Card[] {
  const grouped = cardsByColumn(columns, cards, local);
  return columns.flatMap((col) => (grouped[col.id] ?? []).map((c) => (c.columnId === col.id ? c : { ...c, columnId: col.id })));
}

/** Moves a card to another column of the local order, before `beforeCardId` or at the end. */
export function moveLocal(local: LocalOrder, activeId: string, columnId: string, beforeCardId?: string): LocalOrder {
  const next: LocalOrder = {};
  for (const [id, ids] of Object.entries(local)) next[id] = ids.filter((c) => c !== activeId);
  const target = next[columnId] ?? [];
  const at = beforeCardId ? target.indexOf(beforeCardId) : -1;
  target.splice(at < 0 ? target.length : at, 0, activeId);
  next[columnId] = target;
  return next;
}

/** Column holding a card in the local order. */
export function localColumnOf(local: LocalOrder, cardId: string): string | undefined {
  return Object.keys(local).find((id) => local[id]?.includes(cardId));
}
