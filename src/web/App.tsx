import { useCallback, useEffect, useState } from "react";
import { sequenceLabel } from "../shared/sequence.ts";
import type { ProjectSnapshot } from "../shared/types.ts";
import { api, useServerEvents, useSettings } from "./api.ts";
import { Board } from "./Board.tsx";
import { CardModal } from "./CardModal.tsx";
import { ColumnsEditor } from "./ColumnsEditor.tsx";
import { Icon } from "./icons.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { SettingsModal } from "./SettingsModal.tsx";
import { SkillsModal } from "./SkillsModal.tsx";
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
