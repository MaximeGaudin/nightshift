// Resync confirmation: runs a dry run of the resync and shows what it would change before anything is deleted.

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { IssueSyncPreview } from "../shared/issues.ts";
import { api } from "./api.ts";
import { AppDialog } from "./components/app-dialog.tsx";
import { Button } from "./components/ui/button.tsx";
import { useT } from "./i18n/index.ts";

export type PreviewState = { kind: "loading" } | { kind: "ready"; preview: IssueSyncPreview } | { kind: "failed"; error: string };

/** Body of the dialog for each state of the preview. */
export function ResyncPreviewBody({ state }: { state: PreviewState }): ReactNode {
  const { t } = useT();
  if (state.kind === "loading")
    return <p className="resync-preview-loading text-sm text-muted-foreground">{t("settings.issues.resyncPreviewLoading")}</p>;
  if (state.kind === "failed") {
    return (
      <p className="resync-preview-error text-sm text-destructive">{t("settings.issues.resyncPreviewFailed", { error: state.error })}</p>
    );
  }
  const p = state.preview;
  return (
    <div className="resync-preview-summary flex flex-col gap-2 text-sm">
      <p>
        {t("settings.issues.resyncPreviewSummary", {
          matching: p.matching,
          imported: p.toImport,
          updated: p.toUpdate,
          removed: p.toClose + p.toPrune,
          before: p.backlogNow,
          after: p.backlogNow + p.toImport - p.toClose - p.toPrune,
        })}
      </p>
      <p className="text-xs text-muted-foreground">{t("settings.issues.resyncPreviewApprox")}</p>
    </div>
  );
}

export function ResyncPreviewDialog({
  project,
  sourceId,
  repo,
  description,
  onClose,
  onConfirm,
}: {
  project: string;
  sourceId: string;
  repo: string;
  /** Shown under the title, e.g. "Filters changed" when opened after a save. */
  description?: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useT();
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  useEffect(() => {
    let alive = true;
    api
      .previewResync(project, sourceId)
      .then((preview) => alive && setState({ kind: "ready", preview }))
      .catch((e) => alive && setState({ kind: "failed", error: (e as Error).message }));
    return () => {
      alive = false;
    };
  }, [project, sourceId]);
  return (
    <AppDialog
      size="md"
      title={t("settings.issues.resyncPreviewTitle", { repo })}
      description={description}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="outline" size="sm" className="resync-cancel" onClick={onClose}>
            {t("settings.issues.resyncCancel")}
          </Button>
          <Button type="button" size="sm" className="resync-confirm" disabled={state.kind !== "ready"} onClick={onConfirm}>
            {t("settings.issues.resyncConfirmButton")}
          </Button>
        </>
      }
    >
      <ResyncPreviewBody state={state} />
    </AppDialog>
  );
}
