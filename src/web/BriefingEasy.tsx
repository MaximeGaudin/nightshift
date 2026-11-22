import { MessageSquare, Rocket, Zap } from "lucide-react";
import { useState } from "react";
import type { BriefingEasy } from "../shared/briefing.ts";
import { type Board, type Card, cardRef } from "../shared/types.ts";
import { ageLabel } from "./briefingUi.ts";
import { Button } from "./components/ui/button.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import { useT } from "./i18n/index.ts";
import { cn } from "./lib/utils.ts";
import { Markdown } from "./markdown.tsx";
import { renderCardImage } from "./Screenshot.tsx";

/** Ids of the easy cards that would be launched: every ready one the user did not untick. */
export function selectedEasy(ready: Pick<BriefingEasy, "cardId">[], excluded: ReadonlySet<string>): string[] {
  return ready.map((e) => e.cardId).filter((id) => !excluded.has(id));
}

/**
 * The cards the triage found buildable without a decision, in full: what the agent will build, why nothing is to
 * decide, and the card itself. The user unticks what should wait, sends a card to a conversation, then launches.
 */
export function EasyReview({
  project,
  board,
  ready,
  disabled,
  launching,
  onLaunch,
  onDiscuss,
  onOpenCard,
}: {
  project: string;
  board: Board;
  /** Easy cards not launched yet. */
  ready: BriefingEasy[];
  disabled: boolean;
  launching: boolean;
  onLaunch: (cardIds: string[]) => void;
  onDiscuss: (cardId: string) => void;
  onOpenCard: (id: string) => void;
}) {
  const { t, tn } = useT();
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const entries = ready.flatMap((e) => {
    const card = board.cards.find((c) => c.id === e.cardId);
    return card ? [{ e, card }] : [];
  });
  const ids = selectedEasy(
    entries.map((x) => x.e),
    excluded,
  );
  const toggle = (card: Card, on: boolean) =>
    setExcluded((cur) => {
      const next = new Set(cur);
      if (on) next.delete(card.id);
      else next.add(card.id);
      return next;
    });
  const allOn = ids.length === entries.length;
  return (
    <div className="briefing-easy-review flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-start gap-3 border-b px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <Zap className="size-4 text-primary" aria-hidden="true" focusable="false" />
            {t("briefing.easy.title")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("briefing.easy.lead")}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={() => setExcluded(allOn ? new Set(entries.map((x) => x.card.id)) : new Set())}
        >
          {allOn ? t("briefing.easy.selectNone") : t("briefing.easy.selectAll")}
        </Button>
        <Button
          className="briefing-launch-selected shrink-0"
          disabled={disabled || launching || ids.length === 0}
          onClick={() => onLaunch(ids)}
        >
          <Rocket aria-hidden="true" />
          {tn("briefing.easy.launchSelected", ids.length)}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <ul className="mx-auto flex max-w-3xl flex-col gap-3">
          {entries.map(({ e, card }) => {
            const on = !excluded.has(card.id);
            return (
              <li
                key={card.id}
                className={cn(
                  "briefing-easy-card flex gap-3 rounded-xl border bg-card p-3.5 shadow-xs transition-opacity",
                  on ? "border-primary/30" : "opacity-60",
                )}
              >
                <Checkbox
                  className="mt-0.5"
                  checked={on}
                  aria-label={t("briefing.easy.include", { ref: cardRef(card) })}
                  onCheckedChange={(v) => toggle(card, v === true)}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{cardRef(card)}</span>
                    <h3 className="min-w-0 flex-1 text-sm leading-snug font-semibold">{card.title}</h3>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{ageLabel(card.createdAt)}</span>
                  </div>
                  {e.plan && (
                    <div className="briefing-easy-plan rounded-lg border border-primary/25 bg-primary/5 px-3 py-2">
                      <p className="text-[11px] font-semibold tracking-wide text-primary uppercase">{t("briefing.easy.plan")}</p>
                      <p className="mt-0.5 text-[13px]">{e.plan}</p>
                    </div>
                  )}
                  {e.reason && (
                    <div>
                      <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("briefing.easy.why")}</p>
                      <p className="mt-0.5 text-[13px]">{e.reason}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("briefing.easy.note")}</p>
                    {card.description.trim() ? (
                      <Markdown
                        source={card.description}
                        className="mt-1 max-h-72 overflow-auto rounded-lg border bg-panel px-3 py-2 text-xs"
                        renderImage={renderCardImage(project, card.id)}
                      />
                    ) : (
                      <p className="mt-0.5 text-xs text-warn">{t("briefing.easy.noDescription")}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="sm" className="briefing-discuss" onClick={() => onDiscuss(card.id)}>
                      <MessageSquare aria-hidden="true" />
                      {t("briefing.easy.discussFirst")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onOpenCard(card.id)}>
                      {t("briefing.easy.open")}
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
