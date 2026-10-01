import { useCallback, useEffect, useRef, useState } from "react";
import { sequenceLabel } from "../shared/sequence.ts";
import { resolveNextColumn, skippedColumns } from "../shared/skip.ts";
import { type Card, type Column, columnMaxParallel, DONE_COLUMN_ID, isDoneColumn, type ProjectSnapshot } from "../shared/types.ts";
import { api, useServerEvents, useSettings } from "./api.ts";
import { CardModal } from "./CardModal.tsx";
import { CardTile } from "./CardTile.tsx";
import { ColumnsEditor } from "./ColumnsEditor.tsx";
import { CompactColumnBand, compactColumnTitle, isCompactColumn } from "./compactColumn.tsx";
import { DoneColumn } from "./DoneColumn.tsx";
import { readDoneCollapsed, writeDoneCollapsed } from "./doneColumn.ts";
import { ColumnGlyph, Icon } from "./icons.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { SettingsModal } from "./SettingsModal.tsx";
import { SkillsModal } from "./SkillsModal.tsx";
import { SkipColumnsPicker } from "./SkipColumnsPicker.tsx";
import { installAudioUnlock, notifyAttention } from "./sound.ts";
import { ErrorBanner } from "./ui.tsx";

const readProjectParam = () => new URLSearchParams(location.search).get("project");

function useProjectParam(): [string | null, (p: string | null) => void] {
  const [project, setProject] = useState(readProjectParam);
  useEffect(() => {
    const onPop = () => setProject(readProjectParam());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // Stable: it is a dependency of the effect that opens the project.
  const set = useCallback((p: string | null) => {
    history.pushState(null, "", p ? `/?project=${encodeURIComponent(p)}` : "/");
    setProject(p);
  }, []);
  return [project, set];
}

export function App() {
  const [project, setProject] = useProjectParam();
  const [snap, setSnap] = useState<ProjectSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<"settings" | "columns" | "skills" | "projects" | null>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const settings = useSettings(setError);

  useEffect(() => {
    setSnap(null);
    if (!project) return;
    // Switching project quickly: only the answer of the latest open may be shown.
    let cancelled = false;
    api
      .open(project)
      .then((s) => {
        if (cancelled) return;
        setSnap(s);
        if (s.path !== project) setProject(s.path);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [project, setProject]);

  useEffect(() => installAudioUnlock(), []);

  // useServerEvents always calls the latest closure, so `settings` is read at receipt time.
  // Attention events from every project ring; settings not loaded yet count as on.
  useServerEvents((e) => {
    if (e.type === "attention" && settings?.soundNotifications !== false) notifyAttention(e.kind);
  });

  useServerEvents((e) => {
    if (e.type === "board" && snap && e.project === snap.path) setSnap(e.snapshot);
  });

  const boardName = snap?.board.name;
  useEffect(() => {
    document.title = boardName ? `${boardName} · Nightshift` : "Nightshift";
  }, [boardName]);

  const guard = useCallback((p: Promise<unknown>) => p.catch((e) => setError(e.message)), []);

  if (!project || (!snap && error)) {
    return (
      <div className="app">
        <ErrorBanner error={error} onClose={() => setError(null)} />
        <ProjectPicker
          recent={settings?.recentProjects ?? []}
          onPick={(p) => {
            setError(null);
            setProject(p);
          }}
        />
      </div>
    );
  }
  if (!snap) return <div className="app loading">Chargement…</div>;

  const running = Object.values(snap.live).filter((s) => s === "running").length;
  const queued = Object.values(snap.live).filter((s) => s === "queued").length;
  const questions = snap.board.cards.filter(
    (c) => !snap.live[c.id] && c.lastRun?.status === "question" && c.lastRun.columnId === c.columnId,
  ).length;
  const card = openCard ? snap.board.cards.find((c) => c.id === openCard) : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="moon">
            <Icon name="moon" size={18} />
          </span>
          <div className="brand-text">
            <h1>{snap.board.name}</h1>
            <button type="button" className="path ghost" onClick={() => setModal("projects")} title="Changer de projet">
              {snap.path}
            </button>
          </div>
        </div>
        <div className="agent-status" aria-live="polite">
          <span className={`dot ${running ? "on" : ""}`} />
          {running} / {settings?.maxParallel ?? "?"} agents actifs
          {queued > 0 && <span className="muted"> · {queued} en attente</span>}
          {questions > 0 && (
            <span className="questions">
              · {questions} question{questions > 1 ? "s" : ""} pour vous
            </span>
          )}
        </div>
        <nav className="actions">
          <SequenceControl snap={snap} guard={guard} />
          <button type="button" className="ghost" onClick={() => setModal("columns")}>
            Colonnes
          </button>
          <button type="button" className="ghost" onClick={() => setModal("skills")}>
            Skills
          </button>
          <button type="button" className="ghost" onClick={() => setModal("settings")}>
            Réglages
          </button>
        </nav>
      </header>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {snap.agentsDisabled && (
        <div className="lock-banner" role="status">
          Instance de test (--no-agents) : aucun agent ne sera lancé depuis cette fenêtre.
        </div>
      )}
      {snap.lockedBy && (
        <div className="lock-banner" role="status">
          Un autre processus Nightshift (pid {snap.lockedBy}) exécute déjà les agents de ce projet. Cette fenêtre affiche et édite le kanban
          mais ne lance aucun agent tant que l'autre processus tourne.
        </div>
      )}
      <Board snap={snap} onOpen={setOpenCard} guard={guard} />

      {card && (
        <CardModal
          project={snap.path}
          card={card}
          board={snap.board}
          live={snap.live[card.id]}
          progress={snap.progress?.[card.id]}
          testing={snap.testing?.includes(card.id) ?? false}
          sequential={isSequential(snap, card.id)}
          onClose={() => setOpenCard(null)}
          onError={setError}
        />
      )}
      {modal === "columns" && <ColumnsEditor snap={snap} onClose={() => setModal(null)} />}
      {modal === "skills" && <SkillsModal project={snap.path} onClose={() => setModal(null)} />}
      {modal === "settings" && settings && <SettingsModal settings={settings} onClose={() => setModal(null)} />}
      {modal === "projects" && (
        // biome-ignore lint/a11y/noStaticElementInteractions: clicking outside the dialog is a mouse shortcut; the project picker has its own cancel button
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setModal(null)}>
          <div className="modal wide">
            <ProjectPicker
              recent={settings?.recentProjects ?? []}
              current={snap.path}
              onPick={(p) => {
                setModal(null);
                setProject(p);
              }}
              onCancel={() => setModal(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** True when the sequential mode is running or paused on this card. */
export function isSequential(snap: Pick<ProjectSnapshot, "sequence">, cardId: string): boolean {
  return snap.sequence.status !== "stopped" && snap.sequence.cardId === cardId;
}

export function SequenceControl({ snap, guard }: { snap: ProjectSnapshot; guard: (p: Promise<unknown>) => void }) {
  const active = snap.sequence.status === "active";
  const label = sequenceLabel(snap.sequence, snap.board);
  return (
    <>
      <button
        type="button"
        className="ghost sequence-toggle"
        title={label}
        aria-label={label}
        disabled={snap.agentsDisabled || !!snap.lockedBy}
        onClick={() => guard(active ? api.sequencePause(snap.path) : api.sequencePlay(snap.path))}
      >
        <Icon name={active ? "pause" : "play"} size={14} />
      </button>
      {snap.sequence.notice && (
        <span className="sequence-notice" role="status">
          {snap.sequence.notice}
        </span>
      )}
    </>
  );
}

function Board({ snap, onOpen, guard }: { snap: ProjectSnapshot; onOpen: (id: string) => void; guard: (p: Promise<unknown>) => void }) {
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

/** Columns a new card can be told to skip: those after the creation column, never Done. */
export function skipOptions(columns: Column[], columnId: string): Column[] {
  const index = columns.findIndex((c) => c.id === columnId);
  if (index < 0) return [];
  return columns.slice(index + 1).filter((c) => c.id !== DONE_COLUMN_ID);
}

/** Submits the add-card form: a blank title submits nothing; the form state is fresh afterwards either way. */
export function submitAddCard(
  title: string,
  skip: string[],
  onAdd: (title: string, skip: string[]) => void,
): { title: string; skip: string[] } {
  if (title.trim()) onAdd(title.trim(), skip);
  return { title: "", skip: [] };
}

export function AddCard({
  skipOptions: skipColumns = [],
  onAdd,
  initialOpen,
  onClose,
  closeOnEmptyBlur,
}: {
  skipOptions?: Column[];
  onAdd: (title: string, skip: string[]) => void;
  initialOpen?: boolean;
  onClose?: () => void;
  closeOnEmptyBlur?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen ?? false);
  const [title, setTitle] = useState("");
  const [skip, setSkip] = useState<string[]>([]);
  const formRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  if (!open)
    return (
      <button type="button" className="add-card ghost" onClick={() => setOpen(true)}>
        <Icon name="plus" size={12} />
        Ajouter une fiche
      </button>
    );
  const submit = () => {
    const fresh = submitAddCard(title, skip, onAdd);
    setTitle(fresh.title);
    setSkip(fresh.skip);
  };
  return (
    <div className="add-card-form" ref={formRef}>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the form opens on user request ("add a card"), the title field is what they want to type in
        autoFocus
        value={title}
        onBlur={(e) => {
          if (!closeOnEmptyBlur || title.trim() !== "") return;
          const next = e.relatedTarget as Node | null;
          if (next && formRef.current?.contains(next)) return;
          close();
        }}
        placeholder="Titre de la fiche…"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") close();
        }}
      />
      {/* Keep the focus in the textarea while the picker is used, so opening it does not count as leaving the form. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse-only focus guard, the picker inside stays keyboard accessible */}
      <div onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
        <SkipColumnsPicker columns={skipColumns} value={skip} onChange={setSkip} />
      </div>
      <div className="row">
        <button type="button" className="primary" onClick={submit}>
          Ajouter
        </button>
        <button type="button" onClick={close}>
          Annuler
        </button>
      </div>
    </div>
  );
}
