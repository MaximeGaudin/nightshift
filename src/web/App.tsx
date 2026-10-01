import { Columns3, Info, Pause, Play, Settings as SettingsIcon, Sparkles, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { type SequenceNotice as Notice, sequenceLabel } from "../shared/sequence.ts";
import type { ProjectSnapshot } from "../shared/types.ts";
import { api, useServerEvents, useSettings } from "./api.ts";
import { Board } from "./Board.tsx";
import { CardModal } from "./CardModal.tsx";
import { ColumnsEditor } from "./ColumnsEditor.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { buildCommands, type CommandAction } from "./commands.ts";
import { AppDialog } from "./components/app-dialog.tsx";
import { IconButton } from "./components/icon-button.tsx";
import { Alert } from "./components/ui/alert.tsx";
import { Button } from "./components/ui/button.tsx";
import { Kbd } from "./components/ui/kbd.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { type MessageKey, resolveLocale, setLocale, useT } from "./i18n/index.ts";
import { Logo } from "./Logo.tsx";
import { NewCardDialog } from "./NewCardDialog.tsx";
import { notifyError } from "./notify.ts";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { SettingsModal } from "./SettingsModal.tsx";
import { ShortcutsHelp } from "./ShortcutsHelp.tsx";
import { SkillsModal } from "./SkillsModal.tsx";
import { shortcutFor } from "./shortcuts.ts";
import { installAudioUnlock, notifyAttention } from "./sound.ts";

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

type Modal = "settings" | "columns" | "skills" | "projects";

function BoardSkeleton() {
  const { t } = useT();
  return (
    <div className="flex h-full flex-col" role="status" aria-label={t("board.app.loading")}>
      <div className="flex h-11 items-center gap-3 border-b bg-card px-4">
        <Skeleton className="size-5" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="ml-auto h-6 w-24" />
      </div>
      <div className="flex flex-1 gap-4 overflow-hidden p-4">
        {[3, 2, 1, 2].map((n, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder columns
          <div key={i} className="flex w-72 shrink-0 flex-col gap-2">
            <Skeleton className="h-5 w-28" />
            {Array.from({ length: n }, (_, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cards
              <Skeleton key={j} className="h-16 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const { t, tn } = useT();
  const [project, setProject] = useProjectParam();
  const [snap, setSnap] = useState<ProjectSnapshot | null>(null);
  // Opening the project failed: go back to the project picker.
  const [openFailed, setOpenFailed] = useState(false);
  // Bumped on each pick so picking the same path again after a failure re-runs the open.
  const [openAttempt, setOpenAttempt] = useState(0);
  const [modal, setModal] = useState<Modal | null>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [newCard, setNewCard] = useState<{ title: string } | null>(null);
  const settings = useSettings(notifyError);
  const language = settings?.language;
  useEffect(() => {
    if (language) setLocale(resolveLocale(language, navigator.language));
  }, [language]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: openAttempt is a retry trigger, not read
  useEffect(() => {
    setSnap(null);
    setOpenFailed(false);
    if (!project) return;
    // Switching project quickly: only the answer of the latest open may be shown.
    let cancelled = false;
    api
      .open(project)
      .then((s) => {
        // Told once by the server: shown even if the user already switched project.
        if (s.templateSkillsNotCopied?.length)
          toast.warning(t("common.templateSkillsNotCopied", { names: s.templateSkillsNotCopied.join(", ") }));
        if (cancelled) return;
        setSnap(s);
        if (s.path !== project) setProject(s.path);
      })
      .catch((e) => {
        if (cancelled) return;
        notifyError(e.message);
        setOpenFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [project, setProject, openAttempt]);

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

  const guard = useCallback((p: Promise<unknown>) => p.catch((e) => notifyError(e.message)), []);

  const card = openCard ? snap?.board.cards.find((c) => c.id === openCard) : undefined;
  // The open card was deleted: forget it so it does not reopen nor count as a dialog.
  useEffect(() => {
    if (openCard && snap && !card) setOpenCard(null);
  }, [openCard, snap, card]);

  // Single global keyboard listener; it reads the latest state through a ref.
  // Counts what is rendered, not the raw state (settings modal waits for settings).
  const modalShown = modal === "settings" ? !!settings : !!modal;
  const dialogOpen = !!(modalShown || card || palette || help || newCard);
  const keyState = useRef({ dialogOpen, ready: false });
  keyState.current = { dialogOpen, ready: !!snap };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!keyState.current.ready || e.defaultPrevented) return;
      const action = shortcutFor(e, { dialogOpen: keyState.current.dialogOpen });
      if (!action) return;
      e.preventDefault();
      if (action === "palette") setPalette(true);
      else if (action === "newCard") setNewCard({ title: "" });
      else setHelp(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const runAction = (action: CommandAction, search: string) => {
    setPalette(false);
    if (!snap) return;
    switch (action.type) {
      case "openCard":
        setOpenCard(action.cardId);
        break;
      case "newCard":
        setNewCard({ title: search });
        break;
      case "openModal":
        setModal(action.modal);
        break;
      case "openProject":
        setProject(action.path);
        break;
      case "sequence":
        guard(action.play ? api.sequencePlay(snap.path) : api.sequencePause(snap.path));
        break;
    }
  };

  if (!project || (!snap && openFailed)) {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <ProjectPicker
          recent={settings?.recentProjects ?? []}
          onPick={(p) => {
            setOpenFailed(false);
            setOpenAttempt((n) => n + 1);
            setProject(p);
          }}
        />
      </div>
    );
  }
  if (!snap) return <BoardSkeleton />;

  const running = Object.values(snap.live).filter((s) => s === "running").length;
  const queued = Object.values(snap.live).filter((s) => s === "queued").length;
  const questions = snap.board.cards.filter(
    (c) => !snap.live[c.id] && c.lastRun?.status === "question" && c.lastRun.columnId === c.columnId,
  ).length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b bg-card px-4 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Logo size={18} className="shrink-0" />
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="truncate text-[15px] font-semibold tracking-tight">{snap.board.name}</h1>
            <button
              type="button"
              className="truncate rounded-sm font-mono text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setModal("projects")}
              title={t("board.app.switchProject")}
            >
              {snap.path}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
          <span className={`size-1.5 rounded-full ${running ? "bg-ok" : "bg-muted-foreground/40"}`} aria-hidden="true" />
          {t("board.app.agentsActive", { running, max: settings?.maxParallel ?? "?" })}
          {queued > 0 && <span> · {t("board.app.queued", { count: queued })}</span>}
          {questions > 0 && <span className="font-medium text-warn">· {tn("board.app.questions", questions)}</span>}
        </div>
        <nav className="ml-auto flex items-center gap-1">
          <SequenceButton snap={snap} guard={guard} />
          <Button variant="ghost" onClick={() => setModal("columns")}>
            <Columns3 aria-hidden="true" />
            {t("board.app.columns")}
          </Button>
          <Button variant="ghost" onClick={() => setModal("skills")}>
            <Sparkles aria-hidden="true" />
            {t("board.app.skills")}
          </Button>
          <Button variant="ghost" onClick={() => setModal("settings")}>
            <SettingsIcon aria-hidden="true" />
            {t("board.app.settings")}
          </Button>
          <Button variant="outline" size="sm" className="ml-1 text-muted-foreground" onClick={() => setPalette(true)}>
            {t("board.app.search")} <Kbd>⌘K</Kbd>
          </Button>
        </nav>
      </header>
      {(snap.agentsDisabled || snap.lockedBy || snap.sequence.notice) && (
        <div className="flex shrink-0 flex-col gap-1.5 px-4 pt-3">
          {snap.agentsDisabled && (
            <Alert role="status">
              <Info aria-hidden="true" />
              {t("board.app.noAgents")}
            </Alert>
          )}
          {snap.lockedBy && (
            <Alert role="status" variant="warn">
              <TriangleAlert aria-hidden="true" />
              {t("board.app.locked", { pid: snap.lockedBy })}
            </Alert>
          )}
          <SequenceNotice snap={snap} />
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
          onError={notifyError}
        />
      )}
      {modal === "columns" && <ColumnsEditor snap={snap} onClose={() => setModal(null)} />}
      {modal === "skills" && <SkillsModal project={snap.path} onClose={() => setModal(null)} />}
      {modal === "settings" && settings && (
        <SettingsModal
          settings={settings}
          currentProject={snap.path}
          onOpenProject={(p) => {
            setModal(null);
            setProject(p);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "projects" && (
        <AppDialog size="lg" title={t("board.app.switchProject")} onClose={() => setModal(null)}>
          <ProjectPicker
            embedded
            recent={settings?.recentProjects ?? []}
            current={snap.path}
            onPick={(p) => {
              setModal(null);
              setProject(p);
            }}
            onCancel={() => setModal(null)}
          />
        </AppDialog>
      )}
      {palette && (
        <CommandPalette
          commands={buildCommands({ snap, recentProjects: settings?.recentProjects ?? [] })}
          onRun={runAction}
          onClose={() => setPalette(false)}
        />
      )}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      {newCard && (
        <NewCardDialog
          columns={snap.board.columns}
          initialTitle={newCard.title}
          onAdd={(title, skip) => {
            const first = snap.board.columns[0];
            if (first) guard(api.createCard(snap.path, first.id, title, "", skip));
          }}
          onClose={() => setNewCard(null)}
        />
      )}
    </div>
  );
}

/** True when the sequential mode is running or paused on this card. */
export function isSequential(snap: Pick<ProjectSnapshot, "sequence">, cardId: string): boolean {
  return snap.sequence.status !== "stopped" && snap.sequence.cardId === cardId;
}

export function SequenceButton({ snap, guard }: { snap: ProjectSnapshot; guard: (p: Promise<unknown>) => void }) {
  const { t } = useT();
  const active = snap.sequence.status === "active";
  return (
    <IconButton
      className="sequence-toggle"
      label={sequenceLabel(snap.sequence, snap.board, {
        stopped: t("board.sequence.stopped"),
        active: t("board.sequence.active"),
        paused: t("board.sequence.paused"),
        pausedHint: t("board.sequence.pausedHint"),
      })}
      disabled={snap.agentsDisabled || !!snap.lockedBy}
      onClick={() => guard(active ? api.sequencePause(snap.path) : api.sequencePlay(snap.path))}
    >
      {active ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
    </IconButton>
  );
}

const NOTICE_KEYS: Record<Notice["code"], MessageKey> = {
  backlogEmpty: "board.sequence.notice.backlogEmpty",
  finished: "board.sequence.notice.finished",
  cardDeleted: "board.sequence.notice.cardDeleted",
  cardReturned: "board.sequence.notice.cardReturned",
  error: "board.sequence.notice.error",
  cancelled: "board.sequence.notice.cancelled",
  kept: "board.sequence.notice.kept",
};

export function SequenceNotice({ snap }: { snap: Pick<ProjectSnapshot, "sequence"> }) {
  const { t } = useT();
  const notice = snap.sequence.notice;
  if (!notice) return null;
  const { code, ...params } = notice;
  return (
    <Alert role="status" variant="warn" className="sequence-notice">
      <TriangleAlert aria-hidden="true" />
      {t(NOTICE_KEYS[code], params)}
    </Alert>
  );
}

export function SequenceControl({ snap, guard }: { snap: ProjectSnapshot; guard: (p: Promise<unknown>) => void }) {
  return (
    <>
      <SequenceButton snap={snap} guard={guard} />
      <SequenceNotice snap={snap} />
    </>
  );
}
