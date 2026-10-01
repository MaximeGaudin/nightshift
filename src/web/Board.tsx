import { useEffect, useState } from "react";
import { resolveNextColumn, skippedColumns } from "../shared/skip.ts";
import { type Card, type Column, columnMaxParallel, DONE_COLUMN_ID, isDoneColumn, type ProjectSnapshot } from "../shared/types.ts";
import { AddCard, skipOptions } from "./AddCard.tsx";
import { isSequential } from "./App.tsx";
import { api } from "./api.ts";
import { CardTile } from "./CardTile.tsx";
import { CompactColumnBand, compactColumnTitle, isCompactColumn } from "./compactColumn.tsx";
import { DoneColumn } from "./DoneColumn.tsx";
import { readDoneCollapsed, writeDoneCollapsed } from "./doneColumn.ts";
import { ColumnGlyph } from "./icons.tsx";

export function Board({
  snap,
  onOpen,
  guard,
}: {
  snap: ProjectSnapshot;
  onOpen: (id: string) => void;
  guard: (p: Promise<unknown>) => void;
}) {
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ col: string; index: number } | null>(null);
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

  const onDrop = (col: Column) => {
    if (drag && drop) guard(api.moveCard(snap.path, drag, col.id, drop.index));
    setDrag(null);
    setDrop(null);
  };
  const onDropDone = () => {
    if (drag) guard(api.moveCard(snap.path, drag, DONE_COLUMN_ID));
    setDrag(null);
    setDrop(null);
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
  const tile = (card: Card) => {
    const next = resolveNextColumn(snap.board.columns, card);
    return (
      <CardTile
        project={snap.path}
        card={card}
        live={snap.live[card.id]}
        progress={snap.progress?.[card.id]}
        dragging={drag === card.id}
        next={next ? { name: next.name } : undefined}
        skipped={skippedColumns(snap.board.columns, card).map((c) => c.name)}
        onSendNext={next ? () => sendNext(card, next.id) : undefined}
        sending={sending.has(card.id)}
        sequential={isSequential(snap, card.id)}
        onOpen={() => onOpen(card.id)}
        onDragStart={() => setDrag(card.id)}
        onDragEnd={() => {
          setDrag(null);
          setDrop(null);
        }}
      />
    );
  };

  return (
    <main className="board">
      {snap.board.columns.map((col) => {
        const cards = snap.board.cards.filter((c) => c.columnId === col.id);
        if (isDoneColumn(col))
          return (
            <DoneColumn
              key={col.id}
              cards={cards}
              dragging={drag !== null}
              dropActive={drop?.col === col.id}
              onDragOverDone={() => drop?.col !== col.id && setDrop({ col: col.id, index: 0 })}
              onDragLeaveDone={() => setDrop(null)}
              onDropDone={onDropDone}
              collapsed={doneCollapsed}
              onToggle={toggleDone}
              renderCard={tile}
            />
          );
        const compact = isCompactColumn(cards.length, expanded === col.id);
        return (
          <section
            key={col.id}
            title={compact ? compactColumnTitle(col) : undefined}
            className={`column ${compact ? "compact " : ""}${col.type} ${drop?.col === col.id ? "drop-target" : ""}`}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              const list = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-card]");
              let index = list.length;
              for (let i = 0; i < list.length; i++) {
                const r = list[i]?.getBoundingClientRect();
                if (e.clientY < r.top + r.height / 2) {
                  index = i;
                  break;
                }
              }
              if (drop?.col !== col.id || drop.index !== index) setDrop({ col: col.id, index });
            }}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrop(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              onDrop(col);
            }}
          >
            {compact ? (
              <CompactColumnBand col={col} onAdd={() => setExpanded(col.id)} />
            ) : (
              <>
                <header className="column-head">
                  <div className="column-title">
                    <ColumnGlyph col={col} />
                    <h2>{col.name}</h2>
                    <span className="count">{cards.length}</span>
                    {col.type === "skill" && (
                      <span className="column-parallel" title="agents actifs / limite de la colonne">
                        {cards.filter((c) => snap.live[c.id] === "running").length} / {columnMaxParallel(col)}
                      </span>
                    )}
                  </div>
                  {col.type === "skill" ? (
                    <div className="column-badges">
                      <span className="badge skill" title={col.instructions || undefined}>
                        {col.skill || "aucun skill"}
                      </span>
                      {col.model && (
                        <span className="badge model" title={`Modèle : ${col.model}`}>
                          {col.model}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="badge inert">inerte</span>
                  )}
                </header>
                <div className="cards">
                  {cards.map((card, i) => (
                    <div key={card.id}>
                      {drop?.col === col.id && drop.index === i && <div className="drop-indicator" />}
                      {tile(card)}
                    </div>
                  ))}
                  {drop?.col === col.id && drop.index === cards.length && <div className="drop-indicator" />}
                </div>
                {expanded === col.id ? (
                  <AddCard
                    key="expanded"
                    initialOpen
                    closeOnEmptyBlur
                    onClose={() => setExpanded(null)}
                    skipOptions={skipOptions(snap.board.columns, col.id)}
                    onAdd={(title, skip) => guard(api.createCard(snap.path, col.id, title, "", skip))}
                  />
                ) : (
                  <AddCard
                    key="plain"
                    skipOptions={skipOptions(snap.board.columns, col.id)}
                    onAdd={(title, skip) => guard(api.createCard(snap.path, col.id, title, "", skip))}
                  />
                )}
              </>
            )}
          </section>
        );
      })}
    </main>
  );
}
