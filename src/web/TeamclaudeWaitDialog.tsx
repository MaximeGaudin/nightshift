import { useState } from "react";
import type { TeamclaudeAction, TeamclaudeFailure, TeamclaudeWait } from "../shared/types.ts";
import { api, useTeamclaudeWait } from "./api.ts";
import { AppDialog } from "./components/app-dialog.tsx";
import { Button } from "./components/ui/button.tsx";
import { t, useT } from "./i18n/index.ts";
import { notifyError } from "./notify.ts";

/** The reason a launch through teamclaude is blocked, in the UI language. */
export function teamclaudeFailureText(f: TeamclaudeFailure): string {
  if (f.kind === "not-found") return t("board.teamclaude.notFound");
  if (f.kind === "env-failed") return t("board.teamclaude.envFailed", { detail: f.detail });
  return t("board.teamclaude.noResponse", { url: f.url });
}

const folderName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/** Presentational half, hook-free: the wait state and the choice callback come from outside. */
export function TeamclaudeWaitView({
  wait,
  busy,
  onDecide,
  onClose,
}: {
  wait: TeamclaudeWait;
  busy: boolean;
  onDecide: (action: TeamclaudeAction) => void;
  onClose: () => void;
}) {
  const disabled = busy || wait.retrying;
  return (
    <AppDialog
      size="md"
      title={t("board.teamclaude.title")}
      description={teamclaudeFailureText(wait.failure)}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" disabled={disabled} onClick={() => onDecide("cancel")}>
            {t("board.teamclaude.cancel")}
          </Button>
          <Button type="button" variant="outline" disabled={disabled} onClick={() => onDecide("direct")}>
            {t("board.teamclaude.direct")}
          </Button>
          <Button type="button" disabled={disabled} onClick={() => onDecide("retry")}>
            {wait.retrying ? t("board.teamclaude.retrying") : t("board.teamclaude.retry")}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">{t("board.teamclaude.waitingList")}</p>
      <ul className="teamclaude-wait-list flex flex-col gap-1 text-[13px]">
        {wait.entries.map((e) => (
          <li key={e.cardId ?? e.quickRunId ?? e.title} className="flex min-w-0 items-baseline gap-1.5">
            {e.ref && <span className="shrink-0 font-mono text-xs text-muted-foreground">{e.ref}</span>}
            <span className="min-w-0 truncate">{e.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground" title={e.project}>
              — {folderName(e.project)}
            </span>
          </li>
        ))}
      </ul>
    </AppDialog>
  );
}

/** Identity of a wait state: closing the dialog hides it until this changes (a new run, a new reason). */
const signature = (w: TeamclaudeWait) => JSON.stringify([w.failure, w.entries.map((e) => e.cardId ?? e.quickRunId)]);

/** Shown in every open tab while agent launches wait for the teamclaude proxy; a choice closes it everywhere. */
export function TeamclaudeWaitDialog() {
  useT(); // re-render on a language change
  const wait = useTeamclaudeWait();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!wait || dismissed === signature(wait)) return null;
  const decide = (action: TeamclaudeAction) => {
    setBusy(true);
    api
      .teamclaudeDecision(action)
      .catch((e: unknown) => notifyError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return <TeamclaudeWaitView wait={wait} busy={busy} onDecide={decide} onClose={() => setDismissed(signature(wait))} />;
}
