import { toast } from "sonner";
import type { IssueSource, IssueSyncResult } from "../shared/issues.ts";
import { t } from "./i18n/index.ts";

/** Transient error shown as a toast (the Toaster is mounted by the app shell). */
export function notifyError(message: string) {
  toast.error(message);
}

/**
 * One toast per source synced by hand: success with the counts (or "up to date"), or the provider's error.
 * Uses the module-level `t`, so it still works when the Settings that triggered the sync were closed meanwhile.
 * Results of syncs that did not run (`skipped`) show nothing.
 */
export function notifySyncResults(results: IssueSyncResult[], sources: Pick<IssueSource, "id" | "repo">[]) {
  for (const r of results) {
    if (r.skipped) continue;
    const repo = sources.find((s) => s.id === r.sourceId)?.repo ?? r.sourceId;
    if (!r.ok) {
      toast.error(t("settings.issues.syncFailed", { repo, error: r.error ?? "" }));
      continue;
    }
    const removed = r.deleted + r.pruned;
    if (r.imported + r.updated + removed === 0) toast.success(t("settings.issues.syncUpToDate", { repo }));
    else toast.success(t("settings.issues.syncDone", { repo, imported: r.imported, updated: r.updated, removed }));
  }
}
