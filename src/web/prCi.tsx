// CI state of a card's pull request, as the tile and the dialog show it. The status comes from the server snapshot.

import { type PrCiState, type PrCiStatus, prUrlOf } from "../shared/pullRequests.ts";
import { safeHttpUrl } from "../shared/urls.ts";
import { type MessageKey, useT } from "./i18n/index.ts";
import { cn } from "./lib/utils.ts";

/** A status older than this is fetched again when the card is opened. */
export const CI_STALE_MS = 30_000;

/** The status when it is the one of the card's current PR; a status of another URL is stale and ignored. */
export function ciOf(card: { description: string }, status: PrCiStatus | undefined): PrCiStatus | undefined {
  const url = prUrlOf(card.description);
  return url && status && status.url === url ? status : undefined;
}

export const isCiStale = (status: PrCiStatus | undefined, now = Date.now()) => !status || now - Date.parse(status.checkedAt) >= CI_STALE_MS;

const LABEL: Record<PrCiState, MessageKey> = {
  pass: "card.ci.pass",
  pending: "card.ci.pending",
  fail: "card.ci.fail",
  none: "card.ci.none",
  merged: "card.ci.merged",
  closed: "card.ci.closed",
};

/** Text colour and dot colour of each state; a merged or closed PR has no dot. */
const TONE: Record<PrCiState, { text: string; dot?: string }> = {
  pass: { text: "text-ok", dot: "bg-ok" },
  pending: { text: "text-warn", dot: "bg-warn animate-pulse" },
  fail: { text: "text-err", dot: "bg-err" },
  none: { text: "text-muted-foreground", dot: "bg-muted-foreground/50" },
  merged: { text: "text-muted-foreground" },
  closed: { text: "text-muted-foreground" },
};

export function useCiText() {
  const { t } = useT();
  return (ci: PrCiStatus): string =>
    ci.state === "fail" && ci.failed.length > 0
      ? t("card.ci.failNamed", { names: ci.failed.map((f) => f.name).join(", ") })
      : t(LABEL[ci.state]);
}

export const ciTextClass = (ci: PrCiStatus | undefined) => (ci ? TONE[ci.state].text : "");

/** Small coloured dot of a state, for the tile; nothing for a merged or closed PR. */
export function CiDot({ ci }: { ci: PrCiStatus }) {
  const dot = TONE[ci.state].dot;
  if (!dot) return null;
  return <span data-ci={ci.state} className={cn("card-ci size-1.5 rounded-full", dot)} aria-hidden="true" />;
}

/** Status chip of the dialog: the state label, and the failed checks as links to their run. */
export function CiChip({ ci }: { ci: PrCiStatus }) {
  const { t } = useT();
  const label = useCiText();
  const tone = TONE[ci.state];
  return (
    <span data-ci={ci.state} className="card-ci-chip inline-flex flex-wrap items-center gap-1 text-xs font-normal">
      <span className={cn("inline-flex items-center gap-1", tone.text)}>
        {tone.dot && <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden="true" />}
        {ci.state === "fail" ? t(LABEL.fail) : label(ci)}
      </span>
      {ci.state === "fail" && ci.failed.length > 0 && (
        <span className="text-muted-foreground">
          ({t("card.ci.failedChecks")}{" "}
          {ci.failed.map((f, i) => {
            const href = safeHttpUrl(f.link);
            return (
              <span key={`${f.name}|${f.link}`}>
                {i > 0 && ", "}
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline">
                    {f.name}
                  </a>
                ) : (
                  f.name
                )}
              </span>
            );
          })}
          )
        </span>
      )}
    </span>
  );
}
