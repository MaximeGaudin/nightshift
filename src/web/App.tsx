import { useCallback, useEffect, useState } from "react";
import { cardRef, type Card, type Column, type LiveStatus, type ProjectSnapshot } from "../shared/types.ts";
import { api, useServerEvents, useSettings } from "./api.ts";
import { CardModal } from "./CardModal.tsx";
import { ColumnsEditor } from "./ColumnsEditor.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { SettingsModal } from "./SettingsModal.tsx";
import { SkillsModal } from "./SkillsModal.tsx";
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
          <span className="moon" aria-hidden>
            ☾
          </span>
          <div>
            <h1>{snap.board.name}</h1>
            <button className="path" onClick={() => setModal("projects")} title="Changer de projet">
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
          <button onClick={() => setModal("columns")}>Colonnes</button>
          <button onClick={() => setModal("skills")}>Skills</button>
          <button onClick={() => setModal("settings")}>Réglages</button>
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

  const onDrop = (col: Column) => {
    if (drag && drop) guard(api.moveCard(snap.path, drag, col.id, drop.index));
    setDrag(null);
    setDrop(null);
  };

  return (
    <main className="board">
      {snap.board.columns.map((col) => {
        const cards = snap.board.cards.filter((c) => c.columnId === col.id);
        return (
          <section
            key={col.id}
            className={`column ${col.type} ${drop?.col === col.id ? "drop-target" : ""}`}
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
            <header className="column-head">
              <div className="column-title">
                <h2>{col.name}</h2>
                <span className="count">{cards.length}</span>
              </div>
              {col.type === "skill" ? (
                <div className="column-badges">
                  <span className="badge skill" title={col.instructions || undefined}>
                    ⚡ {col.skill || "aucun skill"}
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
            <AddCard onAdd={(title) => guard(api.createCard(snap.path, col.id, title))} />
          </section>
        );
      })}
    </main>
  );
}

function CardTile({
  card,
  live,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  card: Card;
  live?: LiveStatus;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const lr = card.lastRun?.columnId === card.columnId ? card.lastRun : undefined;
  const status = live ?? lr?.status;
  const label: Record<string, string> = {
    running: "En cours",
    queued: "En attente",
    success: "Traité",
    error: "Erreur",
    cancelled: "Annulé",
    question: "Question pour vous",
  };
  return (
    <article
      data-card
      className={`card ${dragging ? "dragging" : ""} ${status ? `st-${status}` : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", card.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
    >
      <div className="card-ref">{cardRef(card)}</div>
      <h3>{card.title}</h3>
      {card.description && <p className="excerpt">{card.description.slice(0, 160)}</p>}
      {status && (
        <div className={`status st-${status}`}>
          {status === "running" && <span className="spinner" aria-hidden />}
          {label[status]}
          {status === "success" && lr?.summary && <span className="muted"> · {lr.summary.slice(0, 80)}</span>}
          {status === "question" && lr?.questions && (
            <span className="muted"> · {lr.questions.length} question{lr.questions.length > 1 ? "s" : ""}</span>
          )}
        </div>
      )}
    </article>
  );
}

function AddCard({ onAdd }: { onAdd: (title: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  if (!open)
    return (
      <button className="add-card" onClick={() => setOpen(true)}>
        + Ajouter une fiche
      </button>
    );
  const submit = () => {
    if (title.trim()) onAdd(title.trim());
    setTitle("");
  };
  return (
    <div className="add-card-form">
      <textarea
        autoFocus
        value={title}
        placeholder="Titre de la fiche…"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      <div className="row">
        <button className="primary" onClick={submit}>
          Ajouter
        </button>
        <button onClick={() => setOpen(false)}>Annuler</button>
      </div>
    </div>
  );
}
