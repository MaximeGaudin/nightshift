import { useEffect } from "react";
import { toast } from "sonner";
import type { QuickRun, QuickRunResult } from "../shared/types.ts";
import { api } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { t } from "./i18n/index.ts";
import { notifyError } from "./notify.ts";

/** Ids finalized by showQuickRunResult: never re-shown nor dismissed by the snapshot sync. */
const finalized = new Set<string>();
/** Ids whose in-flight toast is currently shown by the snapshot sync. */
const shown = new Set<string>();

function QuickRunToastBody({ project, run }: { project: string; run: QuickRun }) {
  const p = run.progress;
  const determinate = run.status === "running" && p && (p.source === "marker" || p.source === "todo");
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5" data-quick-run={run.id}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{run.skill}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t(run.status === "queued" ? "quickRun.queued" : "quickRun.running")}
        </span>
        <Button size="sm" variant="outline" onClick={() => api.cancelQuickRun(project, run.id).catch((e) => notifyError(e.message))}>
          {t("quickRun.stop")}
        </Button>
      </div>
      {run.instruction ? <div className="truncate text-xs text-muted-foreground">{run.instruction}</div> : null}
      {determinate ? (
        <div className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 tabular-nums">{`${p.step}/${p.total}`}</span>
          <span className="min-w-0 flex-1 truncate" title={p.label}>
            {p.label}
          </span>
        </div>
      ) : (
        <div className="run-progress-bar run-progress-indeterminate h-1 overflow-hidden rounded-full bg-border" role="progressbar">
          <div className="run-progress-fill h-full rounded-full bg-primary" />
        </div>
      )}
    </div>
  );
}

/** Reconciles the toasts with the snapshot's runs. Exported for tests. */
export function syncQuickRunToasts(project: string, runs: QuickRun[]): void {
  const live = new Set<string>();
  for (const run of runs) {
    if (finalized.has(run.id)) continue;
    live.add(run.id);
    shown.add(run.id);
    toast(<QuickRunToastBody project={project} run={run} />, { id: run.id, duration: Number.POSITIVE_INFINITY });
  }
  for (const id of [...shown]) {
    if (live.has(id)) continue;
    shown.delete(id);
    if (!finalized.has(id)) toast.dismiss(id);
  }
}

/** Dismisses the in-flight toasts, keeping finalized ones. Exported for tests. */
export function clearQuickRunToasts(): void {
  for (const id of shown) if (!finalized.has(id)) toast.dismiss(id);
  shown.clear();
}

/** Toasts of the quick runs in flight. */
export function QuickRunToasts({ project, runs }: { project: string; runs: QuickRun[] }): null {
  useEffect(() => clearQuickRunToasts, []);
  useEffect(() => {
    syncQuickRunToasts(project, runs);
  }, [project, runs]);
  return null;
}

/** Shows the outcome of a finished quick run, replacing its in-flight toast. */
export function showQuickRunResult(result: QuickRunResult): void {
  finalized.add(result.id);
  shown.delete(result.id);
  const description = result.instruction || undefined;
  if (result.status === "success") {
    toast.success(result.summary || result.skill, { id: result.id, description, duration: Number.POSITIVE_INFINITY, closeButton: true });
  } else if (result.status === "error") {
    toast.error(result.error ?? result.summary ?? t("quickRun.error"), {
      id: result.id,
      description,
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
    });
  } else {
    toast.info(t("quickRun.cancelled"), { id: result.id, description: result.skill });
  }
}
