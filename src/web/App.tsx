import { Columns3, FastForward, Info, Pause, Play, Settings as SettingsIcon, Sparkles, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { type ProjectSnapshot, type SkillInfo, worktreePolicyOf } from "../shared/types.ts";
import { api, useServerEvents, useSettings } from "./api.ts";
import { Board } from "./Board.tsx";
import { CardModal } from "./CardModal.tsx";
import { ColumnsEditor } from "./ColumnsEditor.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { buildCommands, type CommandAction, quickRunInstruction } from "./commands.ts";
import { AppDialog } from "./components/app-dialog.tsx";
import { IconButton } from "./components/icon-button.tsx";
import { Alert } from "./components/ui/alert.tsx";
import { Button } from "./components/ui/button.tsx";
import { Kbd } from "./components/ui/kbd.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { resolveLocale, setLocale, useT } from "./i18n/index.ts";
import { Logo } from "./Logo.tsx";
import { cn } from "./lib/utils.ts";
import { NewCardDialog } from "./NewCardDialog.tsx";
import { notifyError } from "./notify.ts";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { ProjectTabs } from "./ProjectTabs.tsx";
import { loadTabs, questionCount, saveTabs, type TabsState, tabBoardEvent, tabClosed, tabOpened, tabOpenFailed } from "./projectTabs.ts";
import { QuickRunToasts, showQuickRunResult } from "./QuickRunToasts.tsx";
import { QuotaIndicator } from "./QuotaIndicator.tsx";
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

/** Rounded panel that holds the board, inset from the window edges under the tab bar. */
const PANEL = "board-panel mx-2 mb-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-panel";

/** localStorage when the page may use it. */
function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function BoardSkeleton() {
  const { t } = useT();
  return (
    <div className="flex h-full flex-col" role="status" aria-label={t("board.app.loading")}>
      <div className="flex h-11 items-center gap-3 border-b px-4">
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
  const [tabsState, setTabsState] = useState<TabsState>(() => ({ tabs: loadTabs(browserStorage()), snaps: {}, errors: {} }));
  const tabsRef = useRef(tabsState);
  tabsRef.current = tabsState;
  const snap: ProjectSnapshot | null = project ? (tabsState.snaps[project] ?? null) : null;
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

  useEffect(() => saveTabs(browserStorage(), tabsState.tabs), [tabsState.tabs]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: openAttempt is a retry trigger, not read
  useEffect(() => {
    setOpenFailed(false);
    // A tab already opened shows its cached snapshot at once; board events keep it current.
    if (!project || project in tabsRef.current.snaps) return;
    // Switching project quickly: only the answer of the latest open may change the active project.
    let cancelled = false;
    const requested = project;
    api
      .open(requested)
      .then((s) => {
        // Told once by the server: shown even if the user already switched project.
        if (s.templateSkillsNotCopied?.length)
          toast.warning(t("common.templateSkillsNotCopied", { names: s.templateSkillsNotCopied.join(", ") }));
        // Cached even when the user moved on: its tab then shows it without waiting.
        setTabsState((st) => tabOpened(st, requested, s));
        if (!cancelled && s.path !== requested) setProject(s.path);
      })
      .catch((e) => {
        setTabsState((st) => tabOpenFailed(st, requested, e.message));
        if (cancelled) return;
        notifyError(e.message);
        setOpenFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [project, setProject, openAttempt]);

  // On load, open the other stored tabs so their counters are live; with no project in the URL, show the first tab.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, with the tabs read from storage
  useEffect(() => {
    const first = tabsRef.current.tabs[0];
    // The active project is opened by the effect above: with no project in the URL, that is the first tab.
    const current = readProjectParam() ?? first;
    for (const path of tabsRef.current.tabs) {
      if (path === current) continue;
      api
        .open(path)
        .then((s) => setTabsState((st) => tabOpened(st, path, s)))
        .catch((e) => setTabsState((st) => tabOpenFailed(st, path, e.message)));
    }
    if (!readProjectParam() && first) setProject(first);
  }, []);

  // Dialogs, the open card and the palette belong to the project they were opened on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: project is the trigger, not read
  useEffect(() => {
    setOpenCard(null);
    setModal(null);
    setPalette(false);
    setNewCard(null);
  }, [project]);

  /** Shows a tab; clicking the active one again retries a failed open. */
  const activate = (path: string) => {
    if (path !== project) setProject(path);
    else if (!snap) setOpenAttempt((n) => n + 1);
  };

  /** Removes a tab only: the server keeps the project, and its agents, running. */
  const closeProjectTab = (path: string) => {
    const { state, next } = tabClosed(tabsRef.current, path, project);
    setTabsState(state);
    if (path === project) setProject(next);
  };

  useEffect(() => installAudioUnlock(), []);

  // useServerEvents always calls the latest closure, so `settings` is read at receipt time.
  // Attention events from every project ring; settings not loaded yet count as on.
  useServerEvents((e) => {
    if (e.type === "attention" && settings?.soundNotifications !== false) notifyAttention(e.kind);
  });

  useServerEvents((e) => {
    if (e.type === "board") setTabsState((st) => tabBoardEvent(st, e.project, e.snapshot));
    if (e.type === "quickrun" && snap && e.project === snap.path) showQuickRunResult(e.result);
  });

  const boardName = snap?.board.name;
  useEffect(() => {
    document.title = boardName ? `${boardName} · Nightshift` : "Nightshift";
  }, [boardName]);

  const guard = useCallback((p: Promise<unknown>) => p.catch((e) => notifyError(e.message)), []);

  // Skills offered by the palette, reloaded on each open; empty until answered or if the request fails.
  const [paletteSkills, setPaletteSkills] = useState<SkillInfo[]>([]);
  const snapPath = snap?.path;
  useEffect(() => {
    if (!palette || !snapPath) return;
    let stale = false;
    setPaletteSkills([]);
    api
      .skills(snapPath)
      .then((list) => {
        if (!stale) setPaletteSkills(list);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [palette, snapPath]);

  const card = openCard ? snap?.board.cards.find((c) => c.id === openCard) : undefined;
  // The open card was deleted: forget it so it does not reopen nor count as a dialog.
  useEffect(() => {
    if (openCard && snap && !card) setOpenCard(null);
  }, [openCard, snap, card]);

  // Single global keyboard listener; it reads the latest state through a ref.
  // Counts what is rendered, not the raw state (settings modal waits for settings).
  const modalShown = modal === "settings" ? !!settings : !!modal;
  const dialogOpen = !!(modalShown || card || palette || help || newCard);
  const keyState = useRef({ dialogOpen, ready: false, tabs: tabsState.tabs, activate });
  keyState.current = { dialogOpen, ready: !!snap, tabs: tabsState.tabs, activate };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const action = shortcutFor(e, { dialogOpen: keyState.current.dialogOpen });
      if (!action) return;
      // Tab shortcuts also work while a project is loading or failed to open.
      if (typeof action === "object") {
        const path = keyState.current.tabs[action.tab - 1];
        if (!path) return;
        e.preventDefault();
        keyState.current.activate(path);
        return;
      }
      if (!keyState.current.ready) return;
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
      case "fastForward":
        guard(api.fastForward(snap.path, action.on));
        break;
      case "pause":
        guard(action.paused ? api.pause(snap.path) : api.play(snap.path));
        break;
      case "quickRun":
        guard(api.startQuickRun(snap.path, action.skill, quickRunInstruction(action.skill, search)));
        break;
    }
  };

  const tabBar = (onAdd?: () => void) => (
    <ProjectTabs
      state={tabsState}
      active={project}
      leading={<Logo size={16} className="mx-1.5 shrink-0" />}
      onSelect={activate}
      onClose={closeProjectTab}
      onAdd={onAdd}
    />
  );

  if (!project || (!snap && openFailed)) {
    return (
      <div className="flex h-full flex-col bg-background">
        {tabsState.tabs.length > 0 && tabBar()}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ProjectPicker
            recent={settings?.recentProjects ?? []}
            onPick={(p) => {
              setOpenFailed(false);
              setOpenAttempt((n) => n + 1);
              setProject(p);
            }}
          />
        </div>
      </div>
    );
  }
  if (!snap)
    return (
      <div className="flex h-full flex-col bg-background">
        {tabBar()}
        <div className={PANEL}>
          <BoardSkeleton />
        </div>
      </div>
    );

  const { running, max } = activeAgents(snap);
  const queued = Object.values(snap.live).filter((s) => s === "queued").length;
  const questions = questionCount(snap);

  return (
    <div className="flex h-full flex-col bg-background">
      {tabBar(() => setModal("projects"))}
      <div className={PANEL}>
        <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-1.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="truncate text-[14px] font-semibold tracking-tight">{snap.board.name}</h1>
            <span className="board-card-count shrink-0 text-xs text-muted-foreground tabular-nums">
              {tn("board.app.cardCount", snap.board.cards.length)}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
            <span className={`size-1.5 rounded-full ${running ? "bg-ok" : "bg-muted-foreground/40"}`} aria-hidden="true" />
            {t("board.app.agentsActive", { running, max })}
            {queued > 0 && <span> · {t("board.app.queued", { count: queued })}</span>}
            {questions > 0 && <span className="font-medium text-warn">· {tn("board.app.questions", questions)}</span>}
          </div>
          <QuotaIndicator />
          <nav className="ml-auto flex items-center gap-0.5">
            <FlowButtons snap={snap} guard={guard} />
            <IconButton label={t("board.app.columns")} onClick={() => setModal("columns")}>
              <Columns3 aria-hidden="true" />
            </IconButton>
            <IconButton label={t("board.app.skills")} onClick={() => setModal("skills")}>
              <Sparkles aria-hidden="true" />
            </IconButton>
            <IconButton label={t("board.app.settings")} onClick={() => setModal("settings")}>
              <SettingsIcon aria-hidden="true" />
            </IconButton>
            <Button variant="outline" size="sm" className="ml-1.5 text-muted-foreground" onClick={() => setPalette(true)}>
              {t("board.app.search")} <Kbd>⌘K</Kbd>
            </Button>
          </nav>
        </header>
        {(snap.agentsDisabled || snap.lockedBy) && (
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
          </div>
        )}
        <Board key={snap.path} snap={snap} onOpen={setOpenCard} onEditColumns={() => setModal("columns")} guard={guard} />
      </div>

      {card && (
        <CardModal
          project={snap.path}
          card={card}
          board={snap.board}
          live={snap.live[card.id]}
          progress={snap.progress?.[card.id]}
          testing={snap.testing?.includes(card.id) ?? false}
          onClose={() => setOpenCard(null)}
          onOpenCard={setOpenCard}
          onError={notifyError}
        />
      )}
      <QuickRunToasts project={snap.path} runs={snap.quickRuns} />
      {modal === "columns" && <ColumnsEditor snap={snap} onClose={() => setModal(null)} />}
      {modal === "skills" && <SkillsModal project={snap.path} favorites={snap.board.favoriteSkills ?? []} onClose={() => setModal(null)} />}
      {modal === "settings" && settings && (
        <SettingsModal
          settings={settings}
          currentProject={snap.path}
          projectMaxParallel={snap.maxParallel}
          worktreePolicy={worktreePolicyOf(snap.board)}
          onOpenProject={(p) => {
            setModal(null);
            setProject(p);
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "projects" && (
        <AppDialog size="lg" title={t("board.tabs.add")} onClose={() => setModal(null)}>
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
          commands={buildCommands({ snap, recentProjects: settings?.recentProjects ?? [], skills: paletteSkills })}
          onRun={runAction}
          onClose={() => setPalette(false)}
        />
      )}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      {newCard && (
        <NewCardDialog
          columns={snap.board.columns}
          cards={snap.board.cards}
          initialTitle={newCard.title}
          onAdd={(title, skip, dependsOn, draft) => {
            const first = snap.board.columns[0];
            if (first) guard(api.createCard(snap.path, first.id, title, "", skip, dependsOn, draft));
          }}
          onClose={() => setNewCard(null)}
        />
      )}
    </div>
  );
}

/** Header counter: this project's running card agents and quick runs, against this project's cap (same scope). */
export function activeAgents(snap: Pick<ProjectSnapshot, "live" | "quickRuns" | "maxParallel">): { running: number; max: number } {
  const cards = Object.values(snap.live).filter((s) => s === "running").length;
  const quick = snap.quickRuns.filter((q) => q.status === "running").length;
  return { running: cards + quick, max: snap.maxParallel };
}

/** Cards waiting for the project to leave pause. */
export function pausedCount(snap: Pick<ProjectSnapshot, "live">): number {
  return Object.values(snap.live).filter((s) => s === "paused").length;
}

/** Fast forward toggle and play/pause button of the board header. */
export function FlowButtons({ snap, guard }: { snap: ProjectSnapshot; guard: (p: Promise<unknown>) => void }) {
  const { t, tn } = useT();
  const { fastForward, paused } = snap.flow;
  const disabled = snap.agentsDisabled || !!snap.lockedBy;
  return (
    <>
      <IconButton
        className={cn("fast-forward-toggle", fastForward && "bg-accent text-primary")}
        label={fastForward ? t("board.flow.fastForwardOn") : t("board.flow.fastForwardOff")}
        aria-pressed={fastForward}
        disabled={disabled}
        onClick={() => guard(api.fastForward(snap.path, !fastForward))}
      >
        <FastForward aria-hidden="true" />
      </IconButton>
      <IconButton
        className={cn("pause-toggle", paused && "bg-warn-soft text-warn")}
        label={paused ? tn("board.flow.paused", pausedCount(snap)) : t("board.flow.playing")}
        aria-pressed={paused}
        disabled={disabled}
        onClick={() => guard(paused ? api.play(snap.path) : api.pause(snap.path))}
      >
        {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
      </IconButton>
    </>
  );
}
