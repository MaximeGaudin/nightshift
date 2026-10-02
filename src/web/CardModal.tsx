import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  BACKLOG_COLUMN_ID,
  type Board,
  type Card,
  canSendFeedback,
  cardRef,
  columnEmoji,
  DONE_COLUMN_ID,
  type LiveStatus,
  type LogLine,
  type RunProgress as RunProgressData,
} from "../shared/types.ts";
import { api, useServerEvents, useSettings } from "./api.ts";
import { CardModelsEditor } from "./CardModelsEditor.tsx";
import { SequenceBadge } from "./CardTile.tsx";
import { attempt, deleteThenClose, sendThenClear } from "./cardActions.ts";
import { AppDialog } from "./components/app-dialog.tsx";
import { Alert, AlertDescription } from "./components/ui/alert.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Label } from "./components/ui/label.tsx";
import { Skeleton } from "./components/ui/skeleton.tsx";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { DependencyPicker } from "./DependencyPicker.tsx";
import { FeedbackForm } from "./FeedbackForm.tsx";
import { formatTime, useT } from "./i18n/index.ts";
import { StatusIcon } from "./icons.tsx";
import { cn } from "./lib/utils.ts";
import { Markdown } from "./markdown.tsx";
import { NextColumnButton } from "./NextColumnButton.tsx";
import { notifyError } from "./notify.ts";
import { RunProgress } from "./RunProgress.tsx";
import { renderCardImage } from "./Screenshot.tsx";
import { SkipColumnsPicker } from "./SkipColumnsPicker.tsx";
import { TestPanel } from "./TestPanel.tsx";
import { TimePanel } from "./TimePanel.tsx";
import { timeAgo } from "./ui.tsx";

/** Saves the skipped columns at once, on their own: the title/description draft is neither sent nor touched. */
export async function saveSkipColumns({
  project,
  cardId,
  ids,
  onError,
  update = api.updateCard,
}: {
  project: string;
  cardId: string;
  ids: string[];
  onError: (message: string) => void;
  update?: (project: string, id: string, patch: { skipColumnIds: string[] }) => Promise<unknown>;
}): Promise<boolean> {
  try {
    await update(project, cardId, { skipColumnIds: ids });
    return true;
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Saves the card's dependencies at once, on their own; the server answer (a cycle…) goes to `onError`. */
export async function saveDependencies({
  project,
  cardId,
  ids,
  onError,
  update = api.updateCard,
}: {
  project: string;
  cardId: string;
  ids: string[];
  onError: (message: string) => void;
  update?: (project: string, id: string, patch: { dependsOn: string[] }) => Promise<unknown>;
}): Promise<boolean> {
  try {
    await update(project, cardId, { dependsOn: ids });
    return true;
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * The cards this card waits for, with their current column. Editable only while the card is in Backlog;
 * a refused change (cycle, card no longer in Backlog) is shown here and the list goes back to the server value.
 */
export function DependenciesSection({
  project,
  card,
  board,
  onOpenCard,
  update,
}: {
  project: string;
  card: Card;
  board: Board;
  onOpenCard?: (id: string) => void;
  update?: (project: string, id: string, patch: { dependsOn: string[] }) => Promise<unknown>;
}) {
  const { t } = useT();
  const serverDeps = card.dependsOn ?? [];
  const [deps, setDeps] = useState(serverDeps);
  const [error, setError] = useState<string | null>(null);
  const depsKey = serverDeps.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: depsKey is the trigger (the server list changed); serverDeps is derived from it
  useEffect(() => setDeps(serverDeps), [depsKey]);
  const editable = card.columnId === BACKLOG_COLUMN_ID;
  if (!editable && serverDeps.length === 0) return null;
  const listed = serverDeps.flatMap((id) => {
    const dep = board.cards.find((c) => c.id === id);
    return dep ? [dep] : [];
  });
  return (
    <section className="card-deps flex flex-col gap-1.5 text-xs">
      <span className="font-medium text-muted-foreground">{t("card.deps.heading")}</span>
      {listed.length > 0 && (
        <ul className="card-deps-list m-0 flex list-none flex-col gap-0.5 p-0">
          {listed.map((dep) => {
            const column = board.columns.find((c) => c.id === dep.columnId);
            return (
              <li key={dep.id} className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  className="card-deps-ref cursor-pointer tabular-nums text-primary hover:underline"
                  aria-label={t("card.deps.open", { ref: cardRef(dep) })}
                  onClick={() => onOpenCard?.(dep.id)}
                >
                  {cardRef(dep)}
                </button>
                <span className="min-w-0 flex-1 truncate">{dep.title}</span>
                <span className={cn("shrink-0", dep.columnId === DONE_COLUMN_ID ? "text-ok" : "text-muted-foreground")}>
                  {column?.name}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {editable ? (
        <DependencyPicker
          cards={board.cards.filter((c) => c.id !== card.id)}
          columns={board.columns}
          value={deps}
          onChange={(ids) => {
            setDeps(ids);
            setError(null);
            void saveDependencies({ project, cardId: card.id, ids, onError: setError, update }).then((ok) => {
              if (!ok) setDeps(serverDeps);
            });
          }}
        />
      ) : (
        <span className="card-deps-readonly text-muted-foreground">{t("card.deps.readonly")}</span>
      )}
      {error && (
        <Alert variant="destructive" className="card-deps-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

type CardModalProps = {
  project: string;
  card: Card;
  board: Board;
  live?: LiveStatus;
  progress?: RunProgressData;
  testing: boolean;
  /** The sequential mode is working on this card. */
  sequential?: boolean;
  onClose: () => void;
  /** Opens another card of the board (a dependency). */
  onOpenCard?: (id: string) => void;
  /** Receives errors that happen after the card is closed (a failed save), to show them in the application banner. */
  onError: (message: string) => void;
};

/**
 * Title and description being edited. Edits are detected against `base` (the content the form started from), not against the live card,
 * so agent updates are pulled into an untouched form instead of being mistaken for user edits.
 */
export function useCardDraft(project: string, card: Card) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [base, setBase] = useState({ title: card.title, description: card.description });
  const dirty = title !== base.title || description !== base.description;
  // Read by the effect below without being one of its triggers (see there).
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Re-runs only when the card changes on the server: edits in progress are kept, so `dirty` is read through a ref.
  useEffect(() => {
    if (dirtyRef.current) return;
    setTitle(card.title);
    setDescription(card.description);
    setBase({ title: card.title, description: card.description });
  }, [card.title, card.description]);
  const saveOrThrow = () => api.updateCard(project, card.id, { title, description }).then(() => setBase({ title, description }));
  return { title, setTitle, description, setDescription, dirty, saveOrThrow };
}

export type CardDraft = ReturnType<typeof useCardDraft>;

export function CardModal(props: CardModalProps) {
  const { project, card, board, live, sequential, onClose, onError } = props;
  const { t } = useT();
  const draft = useCardDraft(project, card);
  const column = board.columns.find((c) => c.id === card.columnId);
  return (
    <AppDialog
      size="xl"
      title={
        <span>
          {t("card.heading")} <CopyRef card={card} /> {sequential && <SequenceBadge />}{" "}
          <span className="font-normal text-muted-foreground">
            · {column && columnEmoji(column) ? `${columnEmoji(column)} ` : ""}
            {column?.name}
          </span>
        </span>
      }
      onClose={() => {
        // The card closes at once; a failed save is shown in the application banner, not lost silently.
        if (draft.dirty) void attempt(draft.saveOrThrow(), (m) => onError(t("card.saveFailed", { message: m })));
        onClose();
      }}
      footer={<CardModalFooter project={project} card={card} board={board} live={live} draft={draft} onClose={onClose} />}
    >
      <CardModalContent {...props} draft={draft} />
    </AppDialog>
  );
}

function CardModalFooter({
  project,
  card,
  board,
  live,
  draft,
  onClose,
}: {
  project: string;
  card: Card;
  board: Board;
  live?: LiveStatus;
  draft: CardDraft;
  onClose: () => void;
}) {
  const { t } = useT();
  const column = board.columns.find((c) => c.id === card.columnId);
  const lr = card.lastRun;
  const guard = (p: Promise<unknown>) => void attempt(p, notifyError);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="text-err hover:text-err"
        onClick={() => {
          if (confirm(t("card.confirmDelete"))) void deleteThenClose(api.deleteCard(project, card.id), onClose, notifyError);
        }}
      >
        {t("common.delete")}
      </Button>
      <div className="flex-1" />
      {live === "running" && (
        <Button type="button" variant="outline" onClick={() => guard(api.cancel(project, card.id))}>
          {t("card.stopAgent")}
        </Button>
      )}
      {column?.type === "skill" &&
        live !== "running" &&
        lr?.sessionId &&
        lr.columnId === card.columnId &&
        (lr.status === "error" || lr.status === "cancelled") && (
          <Button type="button" variant="outline" title={t("card.resumeHint")} onClick={() => guard(api.resumeSession(project, card.id))}>
            {t("card.resume")}
          </Button>
        )}
      {column?.type === "skill" && live !== "running" && (
        <Button type="button" variant="outline" onClick={() => guard(api.retry(project, card.id))}>
          {lr?.columnId === card.columnId ? t("card.rerun") : t("card.run")}
        </Button>
      )}
      <NextColumnButton
        project={project}
        card={card}
        board={board}
        beforeMove={() => (draft.dirty ? draft.saveOrThrow() : undefined)}
        onError={notifyError}
        onMoved={onClose}
        live={live}
      />
      <Button type="button" disabled={!draft.dirty} onClick={() => guard(draft.saveOrThrow())}>
        {t("common.save")}
      </Button>
    </>
  );
}

const LAST_RUN_TONE: Partial<Record<string, string>> = {
  success: "border-ok/30 bg-ok-soft",
  error: "border-err/30 bg-err-soft",
  cancelled: "border-err/30 bg-err-soft",
};

/** Body of the card dialog (edit column + side column). Exported on its own because Radix dialogs render nothing on the server. */
export function CardModalContent({
  project,
  card,
  board,
  live,
  progress,
  testing,
  draft,
  onOpenCard,
}: CardModalProps & {
  draft: CardDraft;
}) {
  const { title, setTitle, description, setDescription, dirty } = draft;
  const { t, tn } = useT();
  const settings = useSettings();
  const [log, setLog] = useState<LogLine[]>([]);
  const [logLoaded, setLogLoaded] = useState(false);
  const [tab, setTab] = useState<"log" | "history" | "time">("log");
  const [answers, setAnswers] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  // Description shows rendered markdown by default; an empty one opens straight in the editor.
  const [descMode, setDescMode] = useState<"preview" | "edit">(card.description.trim() ? "preview" : "edit");
  const descRef = useRef<HTMLTextAreaElement>(null);
  const focusDesc = useRef(false);
  // Skipped columns are saved on each change; the display follows the board snapshot (the server value wins on every update).
  const serverSkip = card.skipColumnIds ?? [];
  const [skip, setSkip] = useState(serverSkip);
  const skipKey = serverSkip.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: skipKey is the trigger (the server list changed); serverSkip is derived from it
  useEffect(() => setSkip(serverSkip), [skipKey]);
  const skipOptions = board.columns.filter((c) => c.id !== DONE_COLUMN_ID && c.id !== card.columnId);

  useEffect(() => {
    if (descMode !== "edit" || !focusDesc.current) return;
    focusDesc.current = false;
    descRef.current?.focus();
  }, [descMode]);
  const editDescription = () => {
    focusDesc.current = true;
    setDescMode("edit");
  };

  useEffect(() => {
    setLogLoaded(false);
    void api
      .log(project, card.id)
      .then(setLog)
      .catch((e) => notifyError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLogLoaded(true));
  }, [project, card.id]);
  useServerEvents((e) => {
    if (e.type !== "log" || e.project !== project || e.cardId !== card.id) return;
    // A new run resets the log on the server: mirror that.
    // A new column's run resets the log on the server: mirror that.
    const fresh = e.line.text.startsWith("Starting skill") || e.line.text.startsWith("Continuing the card's session");
    setLog((l) => (fresh ? [e.line] : [...l, e.line]));
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: log.length is the trigger (scroll to the new line); the effect only reads the DOM
  useEffect(() => {
    const el = logRef.current;
    if (el && tab !== "time") el.scrollTop = el.scrollHeight;
  }, [log.length, tab]);
  // The time tab opens at the top, where the pie chart is.
  useEffect(() => {
    if (tab === "time" && logRef.current) logRef.current.scrollTop = 0;
  }, [tab]);

  const lr = card.lastRun;
  const asking = lr?.status === "question" && lr.columnId === card.columnId && !live;

  return (
    <div className="card-modal grid h-[calc(100dvh-13rem)] min-h-[440px] min-w-0 grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-6 max-[800px]:h-auto max-[800px]:grid-cols-[minmax(0,1fr)]">
      <div className="card-edit flex min-h-0 min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="card-title" className="self-start">
            {t("card.titleLabel")}
          </Label>
          <Input id="card-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="card-desc flex min-h-[220px] min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <span id="card-desc-label" className="text-xs font-medium text-muted-foreground">
              {t("card.descriptionLabel")}
            </span>
            <Tabs value={descMode} onValueChange={(v) => (v === "edit" ? editDescription() : setDescMode("preview"))}>
              <TabsList aria-labelledby="card-desc-label">
                <TabsTrigger value="preview">{t("card.preview")}</TabsTrigger>
                <TabsTrigger value="edit">{t("card.edit")}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {descMode === "edit" ? (
            <Textarea
              ref={descRef}
              className="card-desc-body min-h-0 min-w-0 flex-1 resize-none font-mono leading-relaxed"
              aria-label={t("card.descriptionMarkdown")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              spellCheck
            />
          ) : (
            <div
              className="card-desc-body card-desc-preview min-h-0 min-w-0 flex-1 cursor-text overflow-auto rounded-md border bg-card px-3 py-2 transition-colors duration-150 hover:border-input"
              role="tabpanel"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the scrollable preview must be reachable by keyboard
              tabIndex={0}
              title={t("card.doubleClickEdit")}
              onDoubleClick={editDescription}
            >
              {description.trim() ? (
                <Markdown source={description} renderImage={renderCardImage(project, card.id)} />
              ) : (
                <p className="text-muted-foreground">{t("card.noDescription")}</p>
              )}
            </div>
          )}
        </div>
        {live === "running" && dirty && (
          <Alert variant="warn" className="hint warn">
            <AlertDescription>{t("card.agentOverwriteWarning")}</AlertDescription>
          </Alert>
        )}
      </div>
      <aside className="card-side flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto">
        <SkipColumnsPicker
          columns={skipOptions}
          value={skip}
          onChange={(ids) => {
            setSkip(ids);
            void saveSkipColumns({ project, cardId: card.id, ids, onError: notifyError }).then((ok) => {
              if (!ok) setSkip(serverSkip);
            });
          }}
        />
        <DependenciesSection project={project} card={card} board={board} onOpenCard={onOpenCard} />
        <CardModelsEditor key={card.id} project={project} card={card} board={board} settings={settings} />
        {asking && lr && (
          <form
            className="question flex max-h-[60%] min-w-0 shrink-0 flex-col gap-3 overflow-auto rounded-md border border-warn/30 bg-warn-soft p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (answers.some((a) => a.trim()))
                void sendThenClear(api.answer(project, card.id, answers), () => setAnswers([]), notifyError);
            }}
          >
            <strong className="question-head flex items-center gap-2 font-semibold">
              <StatusIcon status="question" />
              {tn("card.agentQuestions", lr.questions?.length ?? 0)}
            </strong>
            <p className="hint small m-0 text-xs text-muted-foreground">{t("card.emptyAnswerHint")}</p>
            {(lr.questions ?? []).map((q, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: questions have no id; the answers are positional (answers[i])
              <div key={i} className="qa flex flex-col gap-2">
                <div className="qa-q flex gap-2">
                  <span className="qa-num shrink-0 text-muted-foreground tabular-nums">{i + 1}.</span>
                  <Markdown source={q} className="min-w-0 flex-1" />
                </div>
                <Textarea
                  aria-label={t("card.answerLabel", { number: i + 1 })}
                  autoFocus={i === 0}
                  className="min-h-14"
                  value={answers[i] ?? ""}
                  placeholder={t("card.answerPlaceholder")}
                  onChange={(e) => setAnswers((a) => Object.assign([...a], { [i]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
                  }}
                />
              </div>
            ))}
            <Button className="self-end" type="submit" disabled={!answers.some((a) => a?.trim())}>
              {t("card.answerAndResume")}
            </Button>
          </form>
        )}
        {lr && (lr.status !== "question" || live) && (
          <div className={cn("last-run min-w-0 shrink-0 rounded-md border bg-card p-3", LAST_RUN_TONE[lr.status], `st-${lr.status}`)}>
            <div className="last-run-head flex min-w-0 items-center gap-2">
              <StatusIcon status={lr.status} />
              <strong className="font-semibold">{t("card.lastRun")}</strong>
              <span className="truncate text-muted-foreground">
                · {board.columns.find((c) => c.id === lr.columnId)?.name ?? "?"} · {timeAgo(lr.at)}
              </span>
            </div>
            {lr.summary && <Markdown source={lr.summary} className="last-run-summary mt-2 max-h-[180px] overflow-auto" />}
            {lr.error && <pre className="error-text mt-2 whitespace-pre-wrap break-words font-mono text-xs text-err">{lr.error}</pre>}
            <div className="last-run-meta mt-2 text-xs text-muted-foreground">
              {lr.costUsd !== undefined && (
                <>
                  {t("card.cost", { amount: `$${lr.costUsd.toFixed(3)}` })}
                  {lr.sessionId ? " · " : ""}
                </>
              )}
              {lr.sessionId && (
                <span title={t("card.resumeInTerminal")}>
                  <code className="font-mono text-[11px]">claude -r {lr.sessionId}</code>
                </span>
              )}
            </div>
          </div>
        )}
        {canSendFeedback(card, live) && !asking && <FeedbackForm project={project} cardId={card.id} onError={notifyError} />}
        <TestPanel project={project} card={card} running={testing} onError={notifyError} />
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="shrink-0">
          <TabsList>
            <TabsTrigger value="log">
              {t("card.tabLog")} {live === "running" && <Loader2 className="animate-spin" aria-hidden />}
            </TabsTrigger>
            <TabsTrigger value="history">{t("card.tabHistory")}</TabsTrigger>
            <TabsTrigger value="time">{t("card.tabTime")}</TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "log" && <RunProgress progress={progress} live={live} />}
        <div
          className="log min-h-[320px] flex-[1_0_320px] overflow-auto rounded-md border bg-card px-3 py-2 font-mono text-xs leading-relaxed"
          ref={logRef}
        >
          {tab === "log" ? (
            log.length ? (
              log.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: log lines have no id and the list only grows at its end
                <LogRow key={i} kind={l.kind} time={formatTime(l.at)} text={l.text} />
              ))
            ) : !logLoaded ? (
              <LogSkeleton />
            ) : (
              <p className="m-0 font-sans text-muted-foreground">{t("card.noRun")}</p>
            )
          ) : tab === "time" ? (
            <TimePanel card={card} board={board} />
          ) : (
            [...card.history].reverse().map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: history entries have no id and the list is never reordered in place
              <LogRow key={i} kind={h.kind} time={timeAgo(h.at)} text={h.text} />
            ))
          )}
        </div>
      </aside>
    </div>
  );
}

function LogSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

const LOG_TONE: Record<string, string> = { tool: "text-primary", info: "text-muted-foreground", error: "text-err" };

function LogRow({ kind, time, text }: { kind: string; time: string; text: string }) {
  return (
    <div className={cn("log-line grid grid-cols-[70px_minmax(0,1fr)] gap-3 py-px", kind)}>
      <time className="text-muted-foreground tabular-nums">{time}</time>
      <span className={cn("break-words whitespace-pre-wrap", LOG_TONE[kind])}>{text}</span>
    </div>
  );
}

/** Card ref shown as muted text; click copies it and briefly confirms. Clipboard failures stay silent. */
function CopyRef({ card }: { card: Card }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const ref = cardRef(card);
  const copy = async () => {
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(ref);
    } catch {
      return;
    }
    if (!mounted.current) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      className="card-ref-copy cursor-pointer rounded-sm px-0.5 font-normal text-muted-foreground tabular-nums hover:text-foreground hover:underline"
      title={t("card.copyRef")}
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
    >
      {copied ? t("card.copied") : ref}
    </button>
  );
}
