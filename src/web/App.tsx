import { useCallback, useEffect, useRef, useState } from "react";
import { columnMaxParallel, isDoneColumn, DONE_COLUMN_ID, type Card, type Column, type LiveStatus, type ProjectSnapshot } from "../shared/types.ts";
import { api, useServerEvents, useSettings } from "./api.ts";
import { CardTile } from "./CardTile.tsx";
import { CardModal } from "./CardModal.tsx";
import { CompactColumnBand, compactColumnTitle, isCompactColumn } from "./compactColumn.tsx";
import { DoneColumn } from "./DoneColumn.tsx";
import { readDoneCollapsed, writeDoneCollapsed } from "./doneColumn.ts";
import { ColumnsEditor } from "./ColumnsEditor.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { SettingsModal } from "./SettingsModal.tsx";
import { SkillsModal } from "./SkillsModal.tsx";
import { ColumnIcon, Icon } from "./icons.tsx";
import { toPlainText } from "./markdown.tsx";
import { installAudioUnlock, notifyAttention } from "./sound.ts";
import { ErrorBanner } from "./ui.tsx";

function useProjectParam(): [string | null, (p: string | null) => void] {
  const read = () => new URLSearchParams(location.search).get("project");
  const [project, setProject] = useState(read);
  useEffect(() => {
    const onPop = () => setProject(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const set = (p: string | null) => {
    history.pushState(null, "", p ? `/?project=${encodeURIComponent(p)}` : "/");
    setProject(p);
  };
  return [project, set];
}

export function App() {
  const [project, setProject] = useProjectParam();
  const [snap, setSnap] = useState<ProjectSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<"settings" | "columns" | "skills" | "projects" | null>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const settings = useSettings();

  useEffect(() => {
    setSnap(null);
    if (!project) return;
    api
      .open(project)
      .then((s) => {
        setSnap(s);
        if (s.path !== project) setProject(s.path);
      })
      .catch((e) => setError(e.message));
  }, [project]);

  useEffect(() => installAudioUnlock(), []);

  // useServerEvents always calls the latest closure, so `settings` is read at receipt time.
  // Attention events from every project ring; settings not loaded yet count as on.
  useServerEvents((e) => {
    if (e.type === "attention" && settings?.soundNotifications !== false) notifyAttention(e.kind);
  });

  useServerEvents((e) => {
    if (e.type === "board" && snap && e.project === snap.path) setSnap(e.snapshot);
  });

  useEffect(() => {
    document.title = snap ? `${snap.board.name} · Nightshift` : "Nightshift";
  }, [snap?.board.name]);

  const guard = useCallback(
    (p: Promise<unknown>) => p.catch((e) => setError(e.message)),
    [],
  );

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
            <button className="path ghost" onClick={() => setModal("projects")} title="Changer de projet">
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
          <button className="ghost" onClick={() => setModal("columns")}>
            Colonnes
          </button>
          <button className="ghost" onClick={() => setModal("skills")}>
            Skills
          </button>
          <button className="ghost" onClick={() => setModal("settings")}>
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
          Un autre processus Nightshift (pid {snap.lockedBy}) exécute déjà les agents de ce projet. Cette fenêtre affiche et
          édite le kanban mais ne lance aucun agent tant que l'autre processus tourne.
        </div>
      )}
      <Board snap={snap} onOpen={setOpenCard} guard={guard} />

      {card && <CardModal project={snap.path} card={card} board={snap.board} live={snap.live[card.id]} testing={snap.testing?.includes(card.id) ?? false} onClose={() => setOpenCard(null)} />}
      {modal === "columns" && <ColumnsEditor snap={snap} onClose={() => setModal(null)} />}
      {modal === "skills" && <SkillsModal project={snap.path} onClose={() => setModal(null)} />}
      {modal === "settings" && settings && <SettingsModal settings={settings} onClose={() => setModal(null)} />}
      {modal === "projects" && (
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

function Board({
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
  const tile = (card: Card) => (
    <CardTile
      card={card}
      live={snap.live[card.id]}
      dragging={drag === card.id}
      onOpen={() => onOpen(card.id)}
      onDragStart={() => setDrag(card.id)}
      onDragEnd={() => {
        setDrag(null);
        setDrop(null);
      }}
    />
  );

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
                const r = list[i]!.getBoundingClientRect();
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
                  <ColumnIcon type={col.type} />
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
                    <CardTile
                      card={card}
                      live={snap.live[card.id]}
                      dragging={drag === card.id}
                      onOpen={() => onOpen(card.id)}
                      onDragStart={() => setDrag(card.id)}
                      onDragEnd={() => {
                        setDrag(null);
                        setDrop(null);
                      }}
                    />
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
                  onAdd={(title) => guard(api.createCard(snap.path, col.id, title))}
                />
              ) : (
                <AddCard key="plain" onAdd={(title) => guard(api.createCard(snap.path, col.id, title))} />
              )}
              </>
            )}
          </section>
        );
      })}
    </main>
  );
}

function AddCard({
  onAdd,
  initialOpen,
  onClose,
  closeOnEmptyBlur,
}: {
  onAdd: (title: string) => void;
  initialOpen?: boolean;
  onClose?: () => void;
  closeOnEmptyBlur?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen ?? false);
  const [title, setTitle] = useState("");
  const formRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  if (!open)
    return (
      <button className="add-card ghost" onClick={() => setOpen(true)}>
        <Icon name="plus" size={12} />
        Ajouter une fiche
      </button>
    );
  const submit = () => {
    if (title.trim()) onAdd(title.trim());
    setTitle("");
  };
  return (
    <div className="add-card-form" ref={formRef}>
      <textarea
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
      <div className="row">
        <button className="primary" onClick={submit}>
          Ajouter
        </button>
        <button onClick={close}>Annuler</button>
      </div>
    </div>
  );
}
