import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  LoaderCircle,
  MessageSquare,
  MessagesSquare,
  MoonStar,
  Rocket,
  SkipForward,
  SquareKanban,
  X,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type BriefingState,
  type BriefingTopic,
  type BriefingTopicStatus,
  briefingCandidates,
  briefingCounts,
  briefingLeftOut,
  isSettled,
  nextTopicId,
  uncoveredCards,
} from "../shared/briefing.ts";
import { type Card, cardRef, type ProjectSnapshot } from "../shared/types.ts";
import { api } from "./api.ts";
import { EasyReview } from "./BriefingEasy.tsx";
import { BriefingTopicView } from "./BriefingTopic.tsx";
import { ageLabel, EMPTY_DRAFT, type TopicDraft } from "./briefingUi.ts";
import { IconButton } from "./components/icon-button.tsx";
import { Alert } from "./components/ui/alert.tsx";
import { Button } from "./components/ui/button.tsx";
import { useT } from "./i18n/index.ts";
import { cn } from "./lib/utils.ts";
import { notifyError } from "./notify.ts";

/** Selection that shows the easy cards instead of a topic. */
const EASY = "easy";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const guard = (p: Promise<unknown>) => p.catch((e) => notifyError(errorText(e)));

/** Board / Briefing switch of the header; the briefing side counts the topics waiting for the user. */
export function ViewSwitch({
  view,
  yourTurn,
  onChange,
}: {
  view: "board" | "briefing";
  yourTurn: number;
  onChange: (view: "board" | "briefing") => void;
}) {
  const { t, tn } = useT();
  const item = (value: "board" | "briefing", icon: ReactNode, label: string, extra?: ReactNode) => (
    // biome-ignore lint/a11y/useSemanticElements: a two-button switch; native radios cannot hold the icon and the counter
    <button
      type="button"
      role="radio"
      aria-checked={view === value}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5",
        view === value ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
      )}
      onClick={() => onChange(value)}
    >
      {icon}
      {label}
      {extra}
    </button>
  );
  return (
    <div
      role="radiogroup"
      aria-label={t("briefing.view.label")}
      className="view-switch flex items-center gap-0.5 rounded-md border bg-secondary p-0.5"
    >
      {item("board", <SquareKanban aria-hidden="true" />, t("briefing.view.board"))}
      {item(
        "briefing",
        <MessagesSquare aria-hidden="true" />,
        t("briefing.view.briefing"),
        yourTurn > 0 && (
          <span
            className="briefing-your-turn rounded-full bg-warn-soft px-1.5 text-[11px] leading-4 text-warn tabular-nums"
            title={tn("briefing.view.yourTurn", yourTurn)}
          >
            {yourTurn}
          </span>
        ),
      )}
    </div>
  );
}

function TopicStatusIcon({ status }: { status: BriefingTopicStatus }) {
  const common = { size: 14, strokeWidth: 1.75, "aria-hidden": true, focusable: false } as const;
  switch (status) {
    case "preparing":
    case "thinking":
      return <LoaderCircle {...common} className="animate-spin text-primary" />;
    case "waiting":
      return <MessageSquare {...common} className="text-warn" />;
    case "launched":
      return <CircleCheck {...common} className="text-ok" />;
    case "skipped":
      return <SkipForward {...common} className="text-muted-foreground" />;
    case "error":
      return <CircleAlert {...common} className="text-err" />;
    default:
      return <CircleDashed {...common} className="text-muted-foreground" />;
  }
}

/** Shown before a briefing exists: what it does, how many cards it would read, and the start button. */
function Intro({
  snap,
  error,
  disabled,
  starting,
  onStart,
}: {
  snap: ProjectSnapshot;
  error?: string;
  disabled: boolean;
  starting: boolean;
  onStart: () => void;
}) {
  const { t, tn } = useT();
  const candidates = briefingCandidates(snap.board);
  const left = briefingLeftOut(snap.board);
  const oldest = candidates[0];
  const steps = [
    { icon: <Zap aria-hidden="true" />, title: t("briefing.intro.step1.title"), text: t("briefing.intro.step1.text") },
    { icon: <Rocket aria-hidden="true" />, title: t("briefing.intro.step2.title"), text: t("briefing.intro.step2.text") },
    { icon: <MessagesSquare aria-hidden="true" />, title: t("briefing.intro.step3.title"), text: t("briefing.intro.step3.text") },
  ];
  return (
    <div className="briefing-intro flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-3xl flex-col items-center gap-6 text-center">
        <span className="flex size-11 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
          <MoonStar className="size-5" aria-hidden="true" focusable="false" />
        </span>
        <div className="flex flex-col gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">{t("briefing.intro.title")}</h2>
          <p className="mx-auto max-w-xl text-sm text-muted-foreground">{t("briefing.intro.lead")}</p>
        </div>
        <ol className="grid w-full gap-3 text-left sm:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} className="briefing-step flex flex-col gap-1.5 rounded-xl border bg-card p-3.5 shadow-xs">
              <span className="flex items-center gap-2 text-primary [&_svg]:size-4">
                {s.icon}
                <span className="text-[11px] font-semibold text-muted-foreground tabular-nums">{i + 1}</span>
              </span>
              <span className="text-[13px] font-semibold">{s.title}</span>
              <span className="text-xs text-muted-foreground">{s.text}</span>
            </li>
          ))}
        </ol>
        {error && (
          <Alert variant="destructive" className="text-left">
            <CircleAlert aria-hidden="true" />
            <p className="col-start-2 break-words">{t("briefing.triage.failed", { error })}</p>
          </Alert>
        )}
        <div className="flex flex-col items-center gap-2">
          <Button size="lg" className="briefing-start" disabled={disabled || starting || candidates.length === 0} onClick={onStart}>
            <MessagesSquare aria-hidden="true" />
            {error ? t("briefing.triage.retry") : t("briefing.intro.start")}
          </Button>
          <p className="briefing-intro-count text-xs text-muted-foreground">
            {disabled
              ? t("briefing.intro.noAgents")
              : candidates.length === 0
                ? t("briefing.intro.empty")
                : [
                    tn("briefing.intro.ready", candidates.length),
                    oldest ? t("briefing.intro.oldest", { age: ageLabel(oldest.createdAt) }) : "",
                    left.drafts > 0 ? tn("briefing.intro.drafts", left.drafts) : "",
                    left.held > 0 ? tn("briefing.intro.held", left.held) : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
          </p>
        </div>
      </div>
    </div>
  );
}

function Triaging({ count, activity, onCancel }: { count: number; activity?: string; onCancel: () => void }) {
  const { t, tn } = useT();
  return (
    <div className="briefing-triage flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center" role="status">
      <LoaderCircle className="size-7 animate-spin text-primary" aria-hidden="true" focusable="false" />
      <h2 className="text-lg font-semibold tracking-tight">{tn("briefing.triage.title", count)}</h2>
      <p className="text-sm text-muted-foreground">{t("briefing.triage.hint")}</p>
      <p className="h-4 max-w-md truncate font-mono text-[11px] text-muted-foreground">{activity}</p>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
    </div>
  );
}

/** Shown when no topic needs the user: what the session did, and the way back to the board. */
function Summary({ briefing, launchedCards, onBack }: { briefing: BriefingState; launchedCards: number; onBack: () => void }) {
  const { t, tn } = useT();
  const counts = briefingCounts(briefing);
  return (
    <div className="briefing-summary flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center" role="status">
      {counts.working > 0 ? (
        <LoaderCircle className="size-7 animate-spin text-primary" aria-hidden="true" focusable="false" />
      ) : (
        <CircleCheck className="size-7 text-ok" aria-hidden="true" focusable="false" />
      )}
      <h2 className="text-lg font-semibold tracking-tight">{t("briefing.done.title")}</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {counts.working > 0 ? tn("briefing.done.working", counts.working) : t("briefing.done.allSettled")}
      </p>
      <p className="text-xs text-muted-foreground tabular-nums">
        {[tn("briefing.done.launched", launchedCards), counts.skipped > 0 ? tn("briefing.done.skipped", counts.skipped) : ""]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <Button variant="outline" onClick={onBack}>
        <SquareKanban aria-hidden="true" />
        {t("briefing.done.back")}
      </Button>
    </div>
  );
}

/** Cards that left the Backlog through this briefing: the launched easy ones and those of the launched topics. */
export function launchedCardCount(briefing: BriefingState): number {
  return (
    briefing.easy.filter((e) => e.launched).length +
    briefing.topics.reduce((n, t) => n + (t.status === "launched" ? (t.launchedRefs?.length ?? 0) : 0), 0)
  );
}

/** The briefing of a project: triage, the easy cards to launch, and one conversation per topic to decide. */
export function BriefingView({
  snap,
  briefing,
  onOpenCard,
  onBack,
}: {
  snap: ProjectSnapshot;
  briefing: BriefingState | null;
  onOpenCard: (id: string) => void;
  /** Goes back to the board. */
  onBack: () => void;
}) {
  const { t, tn } = useT();
  const project = snap.path;
  const disabled = !!snap.agentsDisabled || !!snap.lockedBy;
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, TopicDraft>>({});
  const [starting, setStarting] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const topics = briefing?.topics ?? [];
  // The easy cards come first (they start the agents): they are shown until the user launches them or picks a topic.
  const easyPending = (briefing?.easy ?? []).some((e) => !e.launched);
  const showEasy = easyPending && (selected === EASY || !topics.some((x) => x.id === selected));
  const topic: BriefingTopic | undefined = showEasy
    ? undefined
    : (topics.find((x) => x.id === selected) ?? (briefing ? topics.find((x) => x.id === nextTopicId(briefing)) : undefined));
  const topicId = topic?.id;
  const topicStatus = topic?.status;

  // Opening a topic that is not prepared yet prepares it now, whatever the lookahead.
  useEffect(() => {
    if (topicId && topicStatus === "pending" && !disabled) void api.briefingTopic(project, topicId, "focus").catch(() => {});
  }, [project, topicId, topicStatus, disabled]);

  // A topic that just launched says so wherever the user is looking.
  const seen = useRef<Record<string, BriefingTopicStatus>>({});
  useEffect(() => {
    const before = seen.current;
    const now: Record<string, BriefingTopicStatus> = {};
    for (const x of topics) {
      now[x.id] = x.status;
      if (x.status === "launched" && before[x.id] && before[x.id] !== "launched" && x.launchedRefs?.length)
        toast.success(t("briefing.topic.launched", { column: x.launchedTo ?? "", refs: x.launchedRefs.join(" ") }));
    }
    seen.current = now;
  }, [topics, t]);

  const start = () => {
    setStarting(true);
    void guard(api.briefingStart(project)).finally(() => setStarting(false));
  };
  const end = () => {
    setConfirmEnd(false);
    setSelected(null);
    setDrafts({});
    void guard(api.briefingEnd(project));
  };

  if (!briefing || (topics.length === 0 && briefing.easy.length === 0)) {
    if (briefing?.triage?.status === "running")
      return <Triaging count={briefing.triage.count} activity={briefing.triage.activity} onCancel={end} />;
    return <Intro snap={snap} error={briefing?.triage?.error} disabled={disabled} starting={starting} onStart={start} />;
  }

  const counts = briefingCounts(briefing);
  const cardOf = (id: string): Card | undefined => snap.board.cards.find((c) => c.id === id);
  const easyReady = briefing.easy.filter((e) => !e.launched);
  const fresh = uncoveredCards(snap.board, briefing).length;
  const launchEasy = (cardIds: string[]) => {
    setLaunching(true);
    void guard(
      api.briefingLaunchEasy(project, cardIds).then((r) => {
        if (r.launched > 0) toast.success(tn("briefing.easy.launched", r.launched));
        // On to the conversations: the unticked cards stay one click away in the rail.
        setSelected(nextTopicId(briefing));
      }),
    ).finally(() => setLaunching(false));
  };
  const discuss = (cardId: string) => void guard(api.briefingDiscuss(project, cardId).then((r) => setSelected(r.topicId)));
  const goNext = () => setSelected(nextTopicId(briefing, topicId));
  const hasNext = nextTopicId(briefing, topicId) !== null;

  return (
    <div className="briefing flex min-h-0 flex-1">
      <aside className="briefing-rail flex w-[320px] shrink-0 flex-col border-r">
        <div className="flex shrink-0 flex-col gap-2 border-b px-3.5 py-3">
          <div className="flex items-center gap-2">
            <MoonStar className="size-4 text-primary" aria-hidden="true" focusable="false" />
            <h2 className="text-[13px] font-semibold tracking-tight">{t("briefing.name")}</h2>
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
              {t("briefing.rail.progress", { settled: counts.settled, total: counts.topics })}
            </span>
            <IconButton
              label={confirmEnd ? t("briefing.rail.endConfirm") : t("briefing.rail.end")}
              className={cn("briefing-end size-6 text-muted-foreground", confirmEnd && "bg-err-soft text-err")}
              onClick={() => (confirmEnd ? end() : setConfirmEnd(true))}
              onBlur={() => setConfirmEnd(false)}
            >
              <X size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
            </IconButton>
          </div>
          <div
            className="briefing-progress h-1 overflow-hidden rounded-full bg-secondary"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={counts.topics}
            aria-valuenow={counts.settled}
            aria-label={t("briefing.rail.progress", { settled: counts.settled, total: counts.topics })}
          >
            <div
              className="run-progress-fill h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${counts.topics ? (counts.settled / counts.topics) * 100 : 100}%` }}
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2.5">
          <section
            className={cn(
              "briefing-easy flex flex-col gap-2 rounded-xl border bg-card p-2.5 shadow-xs",
              showEasy && "is-active border-primary/40",
            )}
          >
            <div className="flex items-center gap-2">
              <Zap className="size-3.5 text-primary" aria-hidden="true" focusable="false" />
              <h3 className="text-[13px] font-semibold">{t("briefing.easy.title")}</h3>
              <span className="text-[11px] text-muted-foreground">{t("briefing.easy.hint")}</span>
            </div>
            {easyReady.length > 0 ? (
              <>
                <button
                  type="button"
                  aria-current={showEasy ? "true" : undefined}
                  className="briefing-easy-open flex flex-col gap-0.5 rounded-md text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setSelected(EASY)}
                >
                  {easyReady.slice(0, 6).map((e) => {
                    const card = cardOf(e.cardId);
                    return card ? (
                      <span key={e.cardId} className="flex items-baseline gap-1.5 px-1 py-0.5">
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{cardRef(card)}</span>
                        <span className="truncate text-xs font-medium">{card.title}</span>
                      </span>
                    ) : null;
                  })}
                  {easyReady.length > 6 && <span className="px-1 text-[11px] text-muted-foreground">+{easyReady.length - 6}</span>}
                </button>
                <Button
                  variant={showEasy ? "secondary" : "default"}
                  className="briefing-review-easy w-full"
                  onClick={() => setSelected(EASY)}
                >
                  {t("briefing.easy.review")} · {easyReady.length}
                </Button>
              </>
            ) : (
              <p className={cn("flex items-center gap-1.5 text-xs", counts.easyLaunched > 0 ? "text-ok" : "text-muted-foreground")}>
                {counts.easyLaunched > 0 && <CircleCheck className="size-3.5" aria-hidden="true" focusable="false" />}
                {counts.easyLaunched > 0 ? tn("briefing.easy.launched", counts.easyLaunched) : t("briefing.easy.none")}
              </p>
            )}
          </section>

          <section className="briefing-topics flex flex-col gap-1">
            <div className="flex items-baseline gap-2 px-1.5">
              <h3 className="text-[13px] font-semibold">{t("briefing.topics.title")}</h3>
              <span className="text-[11px] text-muted-foreground">{t("briefing.topics.order")}</span>
            </div>
            {topics.length === 0 && <p className="px-1.5 text-xs text-muted-foreground">{t("briefing.topics.none")}</p>}
            {topics.map((x) => {
              const active = x.id === topicId;
              const refs = x.cardIds.flatMap((id) => {
                const card = cardOf(id);
                return card ? [cardRef(card)] : [];
              });
              return (
                <button
                  key={x.id}
                  type="button"
                  aria-current={active ? "true" : undefined}
                  data-status={x.status}
                  className={cn(
                    "briefing-topic flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    active ? "is-active border-primary/40 bg-card shadow-xs" : "border-transparent hover:bg-accent/60",
                    isSettled(x) && !active && "opacity-60",
                  )}
                  onClick={() => setSelected(x.id)}
                >
                  <span className="mt-0.5 shrink-0">
                    <TopicStatusIcon status={x.status} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-[13px] leading-snug font-medium">{x.title}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                      <span className="truncate">{(x.launchedRefs?.length ? x.launchedRefs : refs).join(" ")}</span>
                      {x.oldestAt && <span className="shrink-0">· {ageLabel(x.oldestAt)}</span>}
                      <span className={cn("ml-auto shrink-0", x.status === "waiting" && "font-medium text-warn")}>
                        {t(`briefing.status.${x.status}`)}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </section>
        </div>

        {(briefing.triage || fresh > 0) && (
          <div className="briefing-fresh flex shrink-0 items-center gap-2 border-t px-3.5 py-2 text-xs text-muted-foreground">
            {briefing.triage?.status === "running" ? (
              <>
                <LoaderCircle className="size-3.5 animate-spin text-primary" aria-hidden="true" focusable="false" />
                <span className="min-w-0 flex-1 truncate">{tn("briefing.triage.title", briefing.triage.count)}</span>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate" title={briefing.triage?.error}>
                  {briefing.triage?.error ? t("briefing.triage.failed", { error: briefing.triage.error }) : tn("briefing.new", fresh)}
                </span>
                {fresh > 0 && (
                  <Button variant="outline" size="sm" disabled={disabled || starting} onClick={start}>
                    {briefing.triage?.error ? t("briefing.triage.retry") : t("briefing.new.triage")}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </aside>

      {showEasy ? (
        <EasyReview
          project={project}
          board={snap.board}
          ready={easyReady}
          disabled={disabled}
          launching={launching}
          onLaunch={launchEasy}
          onDiscuss={discuss}
          onOpenCard={onOpenCard}
        />
      ) : topic ? (
        <BriefingTopicView
          key={topic.id}
          project={project}
          board={snap.board}
          topic={topic}
          draft={drafts[topic.id] ?? EMPTY_DRAFT}
          disabled={disabled}
          hasNext={hasNext}
          onDraft={(d) => setDrafts((all) => ({ ...all, [topic.id]: d }))}
          onNext={goNext}
          onOpenCard={onOpenCard}
        />
      ) : (
        <Summary briefing={briefing} launchedCards={launchedCardCount(briefing)} onBack={onBack} />
      )}
    </div>
  );
}
