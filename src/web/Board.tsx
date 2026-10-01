import {
  type Announcements,
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveNextColumn, skippedColumns } from "../shared/skip.ts";
import { type Card, type Column, cardRef, columnMaxParallel, isDoneColumn, type ProjectSnapshot } from "../shared/types.ts";
import { AddCard, skipOptions } from "./AddCard.tsx";
import { isSequential } from "./App.tsx";
import { api } from "./api.ts";
import {
  cardsByColumn,
  type DropOver,
  type LocalOrder,
  localCards,
  localColumnOf,
  moveLocal,
  resolveDrop,
  snapshotOrder,
} from "./boardDnd.ts";
import { CardTile } from "./CardTile.tsx";
import { CompactColumnBand, compactColumnTitle, DROP_TARGET, isCompactColumn, STRIP_COLUMN, WIDE_COLUMN } from "./compactColumn.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { DoneColumn } from "./DoneColumn.tsx";
import { readDoneCollapsed, writeDoneCollapsed } from "./doneColumn.ts";
import { usePrefersReducedMotion } from "./hooks/use-reduced-motion.ts";
import { ColumnGlyph } from "./icons.tsx";
import { cn } from "./lib/utils.ts";
import { notifyError } from "./notify.ts";

type TileExtra = Pick<React.ComponentProps<typeof CardTile>, "dragging" | "dndProps" | "tileRef">;

const columnDropId = (columnId: string) => `column:${columnId}`;

/** Drop zone for the cards of a column: the nearest card of the hovered column, or the column itself below its last card. */
const collide: CollisionDetection = (args) => {
  const isCard = (c: { data: { current?: { type?: string } } }) => c.data.current?.type === "card";
  if (!args.pointerCoordinates) {
    // Keyboard: nearest card, or a column that has no card to point at (compact, Done).
    const containers = args.droppableContainers.filter((c) => isCard(c) || c.data.current?.type === "column-empty");
    return closestCenter({ ...args, droppableContainers: containers });
  }
  const hits = pointerWithin(args);
  const card = hits.find((h) => h.data?.droppableContainer && isCard(h.data.droppableContainer));
  if (card) return [card];
  const column = hits[0];
  if (!column) return [];
  const columnId = column.data?.droppableContainer.data.current?.columnId;
  const cards = args.droppableContainers.filter((c) => isCard(c) && c.data.current?.columnId === columnId);
  if (cards.length === 0) return [column];
  const nearest = closestCenter({ ...args, droppableContainers: cards })[0];
  const rect = nearest ? args.droppableRects.get(nearest.id) : undefined;
  if (!nearest || !rect || args.pointerCoordinates.y > rect.top + rect.height) return [column];
  return [nearest];
};

function SortableCard({ card, render }: { card: Card; render: (card: Card, extra: TileExtra) => ReactNode }) {
  const reduced = usePrefersReducedMotion();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    data: { type: "card", columnId: card.columnId },
    transition: reduced ? null : { duration: 150, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }}>
      {render(card, { dragging: isDragging, dndProps: { ...attributes, ...listeners }, tileRef: setActivatorNodeRef })}
    </div>
  );
}

/** Cards of Done are ordered by date: they can be dragged out but never reordered. */
function DraggableCard({ card, render }: { card: Card; render: (card: Card, extra: TileExtra) => ReactNode }) {
  const { attributes, listeners, setActivatorNodeRef, isDragging } = useDraggable({
    id: card.id,
    data: { type: "card", columnId: card.columnId },
  });
  return render(card, { dragging: isDragging, dndProps: { ...attributes, ...listeners }, tileRef: setActivatorNodeRef });
}

export function Board({
  snap,
  onOpen,
  guard,
}: {
  snap: ProjectSnapshot;
  onOpen: (id: string) => void;
  guard: (p: Promise<unknown>) => void;
}) {
  const reduced = usePrefersReducedMotion();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  // Card order shown while dragging (and until the move is saved): snapshots keep updating data, never the order.
  const [local, setLocal] = useState<LocalOrder | null>(null);
  // Card whose column comes from `local` (the dragged one, then the dropped one until the move is saved).
  const [moving, setMoving] = useState<string | null>(null);
  const clearLocal = () => {
    setLocal(null);
    setMoving(null);
  };
  const origin = useRef<{ columnId: string; index: number } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sending, setSending] = useState<Set<string>>(() => new Set());

  const [doneCollapsed, setDoneCollapsed] = useState(() => readDoneCollapsed(window.localStorage, snap.path));
  useEffect(() => {
    setDoneCollapsed(readDoneCollapsed(window.localStorage, snap.path));
  }, [snap.path]);
  const toggleDone = () => {
    const next = !doneCollapsed;
    setDoneCollapsed(next);
    writeDoneCollapsed(window.localStorage, snap.path, next);
  };

  const columns = snap.board.columns;
  const cards = snap.board.cards;
  const serverCards = useMemo(() => cardsByColumn(columns, cards, null), [columns, cards]);
  const shownCards = useMemo(() => cardsByColumn(columns, cards, local, moving), [columns, cards, local, moving]);
  const compactIds = useMemo(
    () =>
      new Set(
        columns.filter((c) => !isDoneColumn(c) && isCompactColumn(serverCards[c.id]?.length ?? 0, expanded === c.id)).map((c) => c.id),
      ),
    [columns, serverCards, expanded],
  );
  const activeCard = activeId ? cards.find((c) => c.id === activeId) : undefined;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Space starts, moves with the arrows, drops; Enter keeps opening the card.
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  const describe = (over: { id: string | number; data: { current?: { type?: string; columnId?: string } } }): DropOver | null => {
    const data = over.data.current;
    if (data?.type === "card") return { kind: "card", cardId: String(over.id) };
    if (data?.columnId) return { kind: "column", columnId: data.columnId };
    return null;
  };
  const colName = (id: string | undefined) => columns.find((c) => c.id === id)?.name ?? "";
  const label = (id: string | number) => {
    const card = cards.find((c) => c.id === String(id));
    return card ? cardRef(card) : "";
  };

  const onDragStart = ({ active }: DragStartEvent) => {
    const id = String(active.id);
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    origin.current = { columnId: card.columnId, index: serverCards[card.columnId]?.findIndex((c) => c.id === id) ?? 0 };
    setActiveId(id);
    setMoving(id);
    setLocal(snapshotOrder(columns, cards));
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    const id = String(active.id);
    const target = over ? describe(over) : null;
    const columnOf = (order: LocalOrder) => (target?.kind === "card" ? localColumnOf(order, target.cardId) : target?.columnId);
    setOverColumn((local && columnOf(local)) ?? null);
    if (!target) return;
    setLocal((prev) => {
      if (!prev) return prev;
      const targetCol = columnOf(prev);
      const col = columns.find((c) => c.id === targetCol);
      if (!col || !targetCol) return prev;
      const current = localColumnOf(prev, id);
      // Compact columns and Done never open to host the card: put it back where it came from.
      if (isDoneColumn(col) || compactIds.has(col.id)) return current === origin.current?.columnId ? prev : snapshotOrder(columns, cards);
      if (target.kind === "card" && target.cardId === id) return prev;
      if (current === targetCol) return prev;
      return moveLocal(prev, id, targetCol, target.kind === "card" ? target.cardId : undefined);
    });
  };

  const finish = () => {
    setActiveId(null);
    setOverColumn(null);
    origin.current = null;
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const id = String(active.id);
    const start = origin.current;
    finish();
    const target = over ? describe(over) : null;
    if (!target || !local || !start) {
      clearLocal();
      return;
    }
    const drop = resolveDrop(columns, localCards(columns, cards, local, id), id, target, start);
    if (!drop) {
      clearLocal();
      return;
    }
    api
      .moveCard(snap.path, id, drop.columnId, drop.index)
      .catch((e) => notifyError(e instanceof Error ? e.message : String(e)))
      .finally(clearLocal);
  };

  const onDragCancel = () => {
    finish();
    clearLocal();
  };

  const position = (over: { id: string | number; data: { current?: { type?: string; columnId?: string } } } | null) => {
    const target = over ? describe(over) : null;
    if (!target) return undefined;
    const columnId = target.kind === "card" ? (over?.data.current?.columnId as string) : target.columnId;
    const list = shownCards[columnId] ?? [];
    const index = target.kind === "card" ? list.findIndex((c) => c.id === target.cardId) : list.length;
    return { columnId, position: Math.max(0, index) + 1 };
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Carte ${label(active.id)} saisie`,
    onDragOver: ({ active, over }) => {
      const p = position(over);
      return p ? `Carte ${label(active.id)} au-dessus de ${colName(p.columnId)}, position ${p.position}` : undefined;
    },
    onDragEnd: ({ active, over }) => {
      const p = position(over);
      return p ? `Carte ${label(active.id)} déposée dans ${colName(p.columnId)}` : `Carte ${label(active.id)} relâchée`;
    },
    onDragCancel: ({ active }) => `Déplacement de la carte ${label(active.id)} annulé`,
  };

  const sendNext = (card: Card, nextId: string) => {
    if (sending.has(card.id)) return;
    setSending((s) => new Set(s).add(card.id));
    guard(
      api.moveCard(snap.path, card.id, nextId).finally(() =>
        setSending((s) => {
          const n = new Set(s);
          n.delete(card.id);
          return n;
        }),
      ),
    );
  };
  const tile = (card: Card, extra: TileExtra = {}) => {
    const next = resolveNextColumn(columns, card);
    return (
      <CardTile
        project={snap.path}
        card={card}
        live={snap.live[card.id]}
        progress={snap.progress?.[card.id]}
        next={next ? { name: next.name } : undefined}
        skipped={skippedColumns(columns, card).map((c) => c.name)}
        onSendNext={next ? () => sendNext(card, next.id) : undefined}
        sending={sending.has(card.id)}
        sequential={isSequential(snap, card.id)}
        onOpen={() => onOpen(card.id)}
        {...extra}
      />
    );
  };

  return (
    <DndContext
      id="board-dnd"
      sensors={sensors}
      collisionDetection={collide}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            "Pour déplacer la carte, appuyez sur Espace, choisissez la destination avec les flèches, puis appuyez sur Espace pour la déposer. Échap annule le déplacement. Entrée ouvre la carte.",
        },
      }}
    >
      <main className="board flex flex-1 items-start gap-3 overflow-x-auto px-4 py-3 [&>:first-child]:ml-auto [&>:last-child]:mr-auto">
        {columns.map((col) => {
          const colCards = shownCards[col.id] ?? [];
          if (isDoneColumn(col))
            return (
              <DoneZone
                key={col.id}
                columnId={col.id}
                cards={colCards}
                dropActive={activeId !== null && overColumn === col.id}
                collapsed={doneCollapsed}
                onToggle={toggleDone}
                renderCard={(card) => <DraggableCard card={card} render={tile} />}
              />
            );
          const compact = compactIds.has(col.id);
          return (
            <ColumnZone
              key={col.id}
              col={col}
              compact={compact}
              dropActive={activeId !== null && overColumn === col.id}
              cardsList={colCards}
            >
              {compact ? (
                <CompactColumnBand col={col} onAdd={() => setExpanded(col.id)} />
              ) : (
                <>
                  <header className="column-head flex min-w-0 items-center gap-2 px-2 pt-1 pb-2">
                    <div className="column-title flex max-w-[60%] min-w-0 shrink-0 items-center gap-2">
                      <ColumnGlyph col={col} />
                      <h2 className="truncate text-[13px] font-medium">{col.name}</h2>
                      <span className="count text-xs text-muted-foreground tabular-nums">{colCards.length}</span>
                      {col.type === "skill" && (
                        <span
                          className="column-parallel rounded-sm border px-1.5 text-xs text-muted-foreground tabular-nums"
                          title="agents actifs / limite de la colonne"
                        >
                          {colCards.filter((c) => snap.live[c.id] === "running").length} / {columnMaxParallel(col)}
                        </span>
                      )}
                    </div>
                    {col.type === "skill" ? (
                      <div className="column-badges ml-auto flex min-w-0 gap-1">
                        <Badge variant="default" className="badge skill min-w-0 shrink font-mono" title={col.instructions || undefined}>
                          <span className="truncate">{col.skill || "aucun skill"}</span>
                        </Badge>
                        {col.model && (
                          <Badge variant="outline" className="badge model font-mono text-muted-foreground" title={`Modèle : ${col.model}`}>
                            {col.model}
                          </Badge>
                        )}
                      </div>
                    ) : (
                      <Badge variant="secondary" className="badge inert ml-auto">
                        inerte
                      </Badge>
                    )}
                  </header>
                  <SortableContext items={colCards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                    <div className="cards flex min-h-5 flex-col gap-1.5 overflow-y-auto p-0.5">
                      {colCards.map((card) => (
                        <SortableCard key={card.id} card={card} render={tile} />
                      ))}
                      {colCards.length === 0 && (
                        <div className="rounded-md border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
                          Aucune fiche. Glissez une fiche ici ou ajoutez-en une.
                        </div>
                      )}
                    </div>
                  </SortableContext>
                  {expanded === col.id ? (
                    <AddCard
                      key="expanded"
                      initialOpen
                      closeOnEmptyBlur
                      onClose={() => setExpanded(null)}
                      skipOptions={skipOptions(columns, col.id)}
                      onAdd={(title, skip) => guard(api.createCard(snap.path, col.id, title, "", skip))}
                    />
                  ) : (
                    <AddCard
                      key="plain"
                      skipOptions={skipOptions(columns, col.id)}
                      onAdd={(title, skip) => guard(api.createCard(snap.path, col.id, title, "", skip))}
                    />
                  )}
                </>
              )}
            </ColumnZone>
          );
        })}
      </main>
      <DragOverlay dropAnimation={reduced ? null : undefined}>
        {activeCard ? <div className="cursor-grabbing rotate-1 shadow-xs">{tile(activeCard)}</div> : null}
      </DragOverlay>
    </DndContext>
  );
}

/** A wide or compact column, droppable as a whole (background = end of list, compact = index 0). */
function ColumnZone({
  col,
  compact,
  dropActive,
  cardsList,
  children,
}: {
  col: Column;
  compact: boolean;
  dropActive: boolean;
  cardsList: Card[];
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id: columnDropId(col.id),
    data: { type: compact || cardsList.length === 0 ? "column-empty" : "column", columnId: col.id },
  });
  return (
    <section
      ref={setNodeRef}
      title={compact ? compactColumnTitle(col) : undefined}
      className={cn(compact ? `${STRIP_COLUMN} compact flex-[0_0_48px] self-stretch` : WIDE_COLUMN, col.type, dropActive && DROP_TARGET)}
    >
      {children}
    </section>
  );
}

/** Done as a drop zone: it takes cards without an index (ordered by date). */
function DoneZone(props: {
  columnId: string;
  cards: Card[];
  dropActive: boolean;
  collapsed: boolean;
  onToggle: () => void;
  renderCard: (card: Card) => ReactNode;
}) {
  const { columnId, ...rest } = props;
  const { setNodeRef } = useDroppable({ id: columnDropId(columnId), data: { type: "column-empty", columnId } });
  return <DoneColumn {...rest} dropRef={setNodeRef} />;
}
