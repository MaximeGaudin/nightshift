import { ArrowRight, CircleAlert, CircleCheck, LoaderCircle, Rocket, RotateCw, SkipForward, Undo2, WandSparkles } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { BriefingMessage, BriefingQuestion, BriefingTopic } from "../shared/briefing.ts";
import { type Board, type Card, cardRef } from "../shared/types.ts";
import { api } from "./api.ts";
import {
  acceptRecommended,
  advancesAfterSend,
  ageLabel,
  answeredCount,
  canSend,
  EMPTY_DRAFT,
  isCustomAnswer,
  recommendable,
  type TopicDraft,
} from "./briefingUi.ts";
import { Alert } from "./components/ui/alert.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Kbd } from "./components/ui/kbd.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { useT } from "./i18n/index.ts";
import { cn } from "./lib/utils.ts";
import { Markdown } from "./markdown.tsx";
import { notifyError } from "./notify.ts";
import { renderCardImage } from "./Screenshot.tsx";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The cards of a topic and what was decided so far: beside the conversation on a wide window, above it otherwise. */
export function TopicContext({
  project,
  board,
  topic,
  onOpenCard,
}: {
  project: string;
  board: Board;
  topic: BriefingTopic;
  onOpenCard: (id: string) => void;
}) {
  const { t } = useT();
  const cards = topic.cardIds.map((id) => board.cards.find((c) => c.id === id)).filter((c): c is Card => !!c);
  return (
    <div className="briefing-context flex flex-col gap-5">
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("briefing.context.cards")}</h3>
        {cards.length === 0 && <p className="text-xs text-muted-foreground">{t("briefing.context.gone")}</p>}
        {cards.map((card) => (
          <details key={card.id} className="briefing-card group/card rounded-lg border bg-card shadow-xs" open={cards.length === 1}>
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{cardRef(card)}</span>
              <span className="min-w-0 flex-1 truncate font-medium group-open/card:whitespace-normal">{card.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{ageLabel(card.createdAt)}</span>
            </summary>
            <div className="flex flex-col items-start gap-2 border-t px-2.5 py-2">
              {card.description.trim() ? (
                <Markdown
                  source={card.description}
                  className="max-h-80 w-full overflow-auto text-xs"
                  renderImage={renderCardImage(project, card.id)}
                />
              ) : (
                <p className="text-xs text-muted-foreground">{t("briefing.context.noDescription")}</p>
              )}
              <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onOpenCard(card.id)}>
                {t("briefing.context.open")}
              </Button>
            </div>
          </details>
        ))}
      </section>
      <section className="flex flex-col gap-1.5">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t("briefing.context.decided")}
          {topic.decisions.length > 0 && (
            <span className="rounded-full bg-ok-soft px-1.5 leading-4 text-ok tabular-nums">{topic.decisions.length}</span>
          )}
        </h3>
        {topic.decisions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("briefing.context.noDecision")}</p>
        ) : (
          <ul className="briefing-decisions flex flex-col gap-2">
            {topic.decisions.map((d) => (
              <li key={d.question} className="flex gap-2 text-xs">
                <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden="true" focusable="false" />
                <span className="min-w-0">
                  <span className="block text-muted-foreground">{d.question}</span>
                  <span className="block font-medium">{d.answer}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Message({ message }: { message: BriefingMessage }) {
  const { t } = useT();
  if (message.role === "user")
    return (
      <div className="briefing-message is-user flex flex-col items-end gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">{t("briefing.message.you")}</span>
        <div className="max-w-[85%] rounded-xl rounded-tr-sm border border-primary/25 bg-primary/10 px-3 py-2">
          {message.kind === "finalize" ? <p>{t("briefing.topic.finalizeMessage")}</p> : <Markdown source={message.text} />}
        </div>
      </div>
    );
  return (
    <div className="briefing-message is-agent flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{t("briefing.message.agent")}</span>
      <Markdown source={message.text} />
    </div>
  );
}

/** One decision: the agent's options as radio buttons, or the user's own words. */
function QuestionCard({
  index,
  question,
  answer,
  refs,
  onAnswer,
}: {
  index: number;
  question: BriefingQuestion;
  answer: string;
  /** Refs of the cards it concerns; empty when the topic has a single card. */
  refs: string[];
  onAnswer: (answer: string) => void;
}) {
  const { t } = useT();
  const custom = isCustomAnswer(question, answer);
  const done = answer.trim() !== "";
  return (
    <fieldset
      className={cn("briefing-question rounded-lg border bg-card p-3 shadow-xs transition-colors", done && "is-answered border-primary/35")}
    >
      <legend className="sr-only">{question.question}</legend>
      <div className="flex gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums",
            done ? "bg-primary text-primary-foreground" : "bg-warn-soft text-warn",
          )}
        >
          {index + 1}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div>
            <p className="text-[13px] leading-snug font-medium">{question.question}</p>
            {question.why && <p className="mt-0.5 text-xs text-muted-foreground">{question.why}</p>}
            {refs.length > 0 && <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">{refs.join(" ")}</p>}
          </div>
          {question.options.length > 0 && (
            <div role="radiogroup" aria-label={question.question} className="flex flex-col gap-1.5">
              {question.options.map((option, k) => {
                const selected = answer === option.label;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: a button styled as a radio card; a native input cannot hold the detail and the badge
                  <button
                    key={option.label}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={cn(
                      "briefing-option flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      selected ? "is-selected border-primary bg-primary/10" : "border-input hover:bg-accent/60",
                    )}
                    onClick={() => onAnswer(selected ? "" : option.label)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                        selected ? "border-primary" : "border-muted-foreground/50",
                      )}
                    >
                      {selected && <span className="size-1.5 rounded-full bg-primary" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium">{option.label}</span>
                      {option.detail && <span className="block text-xs text-muted-foreground">{option.detail}</span>}
                    </span>
                    {question.recommended === k && (
                      <Badge variant="default" className="mt-px">
                        {t("briefing.question.recommended")}
                      </Badge>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <Input
            className="briefing-other"
            value={custom ? answer : ""}
            placeholder={t("briefing.question.other")}
            aria-label={t("briefing.question.otherAria", { question: question.question })}
            onChange={(e) => onAnswer(e.target.value)}
          />
        </div>
      </div>
    </fieldset>
  );
}

function Working({ title, hint, activity, children }: { title: string; hint: string; activity?: string; children?: ReactNode }) {
  return (
    <div className="briefing-working flex items-start gap-3 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2.5" role="status">
      <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-primary" aria-hidden="true" focusable="false" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
        {activity && <p className="briefing-activity mt-1 truncate font-mono text-[11px] text-muted-foreground">{activity}</p>}
      </div>
      {children}
    </div>
  );
}

/** One topic: its context, the conversation with the agent, the decisions to make and the composer. */
export function BriefingTopicView({
  project,
  board,
  topic,
  draft,
  disabled,
  hasNext,
  onDraft,
  onNext,
  onOpenCard,
}: {
  project: string;
  board: Board;
  topic: BriefingTopic;
  draft: TopicDraft;
  /** This window does not run the project's agents: nothing can be sent. */
  disabled: boolean;
  /** Another topic still needs the user. */
  hasNext: boolean;
  onDraft: (draft: TopicDraft) => void;
  /** Shows the next topic that needs the user. */
  onNext: () => void;
  onOpenCard: (id: string) => void;
}) {
  const { t, tn } = useT();
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastMessage = useRef<HTMLDivElement>(null);
  const { status, questions } = topic;
  const waiting = status === "waiting";

  // A new message starts at the top of the view (a briefing is read from its first line); the user's own goes to the end.
  const messageCount = topic.messages.length;
  const lastRole = topic.messages[messageCount - 1]?.role;
  // biome-ignore lint/correctness/useExhaustiveDependencies: topic.id and messageCount are the triggers
  useEffect(() => {
    const box = scroller.current;
    if (!box?.scrollTo) return;
    // Scrolled by hand: scrollIntoView would also move the panel around the conversation.
    const el = lastMessage.current;
    if (messageCount <= 1) box.scrollTo({ top: 0 });
    else if (lastRole === "user" || !el) box.scrollTo({ top: box.scrollHeight });
    else box.scrollTo({ top: box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - 16 });
  }, [topic.id, messageCount, lastRole]);

  const act = (p: Promise<unknown>, then?: () => void) => {
    setBusy(true);
    p.then(() => then?.())
      .catch((e) => notifyError(errorText(e)))
      .finally(() => setBusy(false));
  };
  const topicAction = (action: Parameters<typeof api.briefingTopic>[2], then?: () => void) =>
    act(api.briefingTopic(project, topic.id, action), then);

  const sendable = waiting && !disabled && !busy && canSend(questions, draft);
  const send = () => {
    if (!sendable) return;
    const advance = advancesAfterSend(questions, draft);
    act(api.briefingSay(project, topic.id, draft.answers, draft.text), () => {
      onDraft(EMPTY_DRAFT);
      if (advance) onNext();
    });
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send();
  };

  const answered = answeredCount(questions, draft.answers);
  const multi = topic.cardIds.length > 1;
  const refsOf = (q: BriefingQuestion) =>
    multi && q.cardIds.length < topic.cardIds.length
      ? q.cardIds.flatMap((id) => {
          const card = board.cards.find((c) => c.id === id);
          return card ? [cardRef(card)] : [];
        })
      : [];
  const settled = status === "launched" || status === "skipped";
  const next = hasNext && (
    <Button variant="outline" size="sm" className="briefing-next shrink-0" onClick={onNext}>
      {t("briefing.topic.next")}
      <ArrowRight aria-hidden="true" />
    </Button>
  );

  return (
    <div className="briefing-topic-view flex min-h-0 min-w-0 flex-1" data-status={status}>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-start gap-3 border-b px-5 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold tracking-tight">{topic.title}</h2>
            {topic.why && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{topic.why}</p>}
          </div>
          <div className="briefing-topic-actions flex shrink-0 items-center gap-1">
            {waiting && questions.length > 0 && (
              <Button variant="ghost" size="sm" disabled={disabled || busy} onClick={() => topicAction("finalize", onNext)}>
                <WandSparkles aria-hidden="true" />
                {t("briefing.topic.finalize")}
              </Button>
            )}
            {!settled && status !== "thinking" && (
              <Button variant="ghost" size="sm" disabled={disabled || busy} onClick={() => topicAction("launch")}>
                <Rocket aria-hidden="true" />
                {t("briefing.topic.launchAsIs")}
              </Button>
            )}
            {!settled && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => topicAction("skip", onNext)}>
                <SkipForward aria-hidden="true" />
                {t("briefing.topic.skip")}
              </Button>
            )}
            {status === "skipped" && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => topicAction("reopen")}>
                <Undo2 aria-hidden="true" />
                {t("briefing.topic.reopen")}
              </Button>
            )}
          </div>
        </header>

        <div ref={scroller} className="briefing-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            <div className="xl:hidden">
              <TopicContext project={project} board={board} topic={topic} onOpenCard={onOpenCard} />
            </div>

            {topic.messages.map((m, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: messages are append-only and have no id
              <div key={i} ref={i === messageCount - 1 ? lastMessage : undefined} className="scroll-mt-4">
                <Message message={m} />
              </div>
            ))}

            {(status === "pending" || status === "preparing") && (
              <Working title={t("briefing.topic.preparing.title")} hint={t("briefing.topic.preparing.hint")} activity={topic.activity} />
            )}

            {waiting && questions.length > 0 && (
              <section className="briefing-questions flex flex-col gap-2.5">
                <h3 className="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-warn uppercase">
                  {tn("briefing.questions.title", questions.length)}
                  <span className="ml-auto font-medium tracking-normal text-muted-foreground normal-case tabular-nums">
                    {t("briefing.questions.answered", { answered, total: questions.length })}
                  </span>
                </h3>
                {questions.map((q, i) => (
                  <QuestionCard
                    key={q.id}
                    index={i}
                    question={q}
                    answer={draft.answers[q.id] ?? ""}
                    refs={refsOf(q)}
                    onAnswer={(a) => onDraft({ ...draft, answers: { ...draft.answers, [q.id]: a } })}
                  />
                ))}
              </section>
            )}

            {waiting && questions.length === 0 && (
              <div className="briefing-no-questions flex items-center gap-3 rounded-lg border border-ok/30 bg-ok-soft px-3 py-2.5">
                <CircleCheck className="size-4 shrink-0 text-ok" aria-hidden="true" focusable="false" />
                <p className="min-w-0 flex-1 text-[13px]">{t("briefing.topic.noQuestions")}</p>
                <Button size="sm" disabled={disabled || busy} onClick={() => topicAction("finalize", onNext)}>
                  <Rocket aria-hidden="true" />
                  {t("briefing.topic.launch")}
                </Button>
              </div>
            )}

            {status === "thinking" && (
              <Working title={t("briefing.topic.thinking.title")} hint={t("briefing.topic.thinking.hint")} activity={topic.activity}>
                {next}
              </Working>
            )}

            {status === "error" && (
              <Alert variant="destructive" className="briefing-error">
                <CircleAlert aria-hidden="true" />
                <div className="col-start-2 flex items-start gap-3">
                  <p className="min-w-0 flex-1 break-words">{t("briefing.topic.failed", { error: topic.error ?? "" })}</p>
                  <Button variant="outline" size="sm" disabled={disabled || busy} onClick={() => topicAction("retry")}>
                    <RotateCw aria-hidden="true" />
                    {t("briefing.topic.retry")}
                  </Button>
                </div>
              </Alert>
            )}

            {status === "launched" && (
              <div
                className="briefing-launched flex items-center gap-3 rounded-lg border border-ok/30 bg-ok-soft px-3 py-2.5"
                role="status"
              >
                <Rocket className="size-4 shrink-0 text-ok" aria-hidden="true" focusable="false" />
                <p className="min-w-0 flex-1 text-[13px] font-medium">
                  {topic.launchedRefs?.length
                    ? t("briefing.topic.launched", { column: topic.launchedTo ?? "", refs: topic.launchedRefs.join(" ") })
                    : t("briefing.topic.launchedNone")}
                </p>
                {next}
              </div>
            )}

            {status === "skipped" && (
              <div className="briefing-skipped flex items-center gap-3 rounded-lg border px-3 py-2.5 text-muted-foreground" role="status">
                <SkipForward className="size-4 shrink-0" aria-hidden="true" focusable="false" />
                <p className="min-w-0 flex-1 text-[13px]">{t("briefing.topic.skipped")}</p>
                {next}
              </div>
            )}
          </div>
        </div>

        {waiting && (
          <form className="briefing-composer shrink-0 border-t bg-panel px-5 py-3" onSubmit={onSubmit}>
            <div className="mx-auto flex max-w-3xl flex-col gap-2">
              <Textarea
                rows={2}
                className="min-h-14 resize-none"
                value={draft.text}
                disabled={disabled}
                placeholder={t("briefing.composer.placeholder")}
                aria-label={t("briefing.composer.aria")}
                onChange={(e) => onDraft({ ...draft, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="flex items-center gap-2">
                {recommendable(questions, draft.answers).length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="briefing-accept-all"
                    disabled={disabled}
                    onClick={() => onDraft({ ...draft, answers: acceptRecommended(questions, draft.answers) })}
                  >
                    <WandSparkles aria-hidden="true" />
                    {t("briefing.composer.acceptAll")}
                  </Button>
                )}
                <Button type="submit" className="briefing-send ml-auto" disabled={!sendable}>
                  {answered > 0 ? tn("briefing.composer.sendAnswers", answered) : t("briefing.composer.send")}
                  <Kbd className="border-white/25 bg-white/15 text-primary-foreground">⌘↵</Kbd>
                </Button>
              </div>
            </div>
          </form>
        )}
      </div>

      <aside className="hidden w-80 shrink-0 overflow-y-auto border-l p-4 xl:block">
        <TopicContext project={project} board={board} topic={topic} onOpenCard={onOpenCard} />
      </aside>
    </div>
  );
}
