// Header indicator of the issue sync running in the background, or of the sources whose last sync failed.

import { Loader2, TriangleAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { IssueSource, IssueSourceStatus } from "../shared/issues.ts";
import { useT } from "./i18n/index.ts";

export type IssueSyncIndicatorState = { kind: "syncing"; lines: string[] } | { kind: "error"; lines: string[] } | null;

/** Syncing wins over error; disabled sources are ignored; null when nothing is running and nothing failed. */
export function issueSyncIndicatorState(
  sources: Pick<IssueSource, "id" | "repo" | "enabled">[],
  status: Record<string, IssueSourceStatus> | undefined,
): IssueSyncIndicatorState {
  const active = sources.filter((s) => s.enabled);
  const syncing = active.filter((s) => status?.[s.id]?.syncing);
  if (syncing.length > 0) return { kind: "syncing", lines: syncing.map((s) => s.repo) };
  const failed = active.filter((s) => status?.[s.id]?.lastError);
  if (failed.length > 0) return { kind: "error", lines: failed.map((s) => `${s.repo}: ${status?.[s.id]?.lastError}`) };
  return null;
}

export function IssueSyncIndicator({
  sources,
  status,
  onOpen,
}: {
  sources: Pick<IssueSource, "id" | "repo" | "enabled">[];
  status: Record<string, IssueSourceStatus> | undefined;
  onOpen: () => void;
}) {
  const { t } = useT();
  const state = issueSyncIndicatorState(sources, status);
  if (!state) return null;
  const syncing = state.kind === "syncing";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t("board.issueSync.open")}
          data-state-kind={state.kind}
          onClick={onOpen}
          className={`issue-sync-indicator inline-flex items-center gap-1 text-xs ${syncing ? "text-muted-foreground" : "text-destructive"}`}
        >
          {syncing ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <TriangleAlert className="size-3.5" aria-hidden="true" />
          )}
          <span className="max-lg:hidden">{syncing ? t("board.issueSync.syncing") : t("board.issueSync.error")}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {state.lines.map((l) => (
          <div key={l}>{l}</div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
