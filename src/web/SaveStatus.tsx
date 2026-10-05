import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n/index.ts";
import { cn } from "./lib/utils.ts";

export type SaveState = "idle" | "saving" | "saved";

/** How long "Saved" stays visible. */
export const SAVED_HOLD_MS = 2000;

/**
 * Runs a save and reports its progress: "saving" while it runs, then "saved" when it resolved `true`,
 * or back to "idle" when it resolved `false` (the caller already shows the error). `schedule` clears "saved" later.
 */
export async function trackSave(
  run: () => Promise<boolean>,
  set: (state: SaveState) => void,
  schedule: (reset: () => void) => void,
): Promise<boolean> {
  set("saving");
  const ok = await run();
  set(ok ? "saved" : "idle");
  if (ok) schedule(() => set("idle"));
  return ok;
}

/**
 * One indicator for successive saves: only the latest one drives it, so an earlier save that answers
 * while a newer one runs neither shows "saved" too early nor clears "saving".
 */
export function createSaveTracker({
  set,
  holdMs = SAVED_HOLD_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: {
  set: (state: SaveState) => void;
  holdMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout> | undefined) => void;
}) {
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const track = (run: () => Promise<boolean>) => {
    clearTimer(timer);
    const id = ++latest;
    const current = () => id === latest;
    return trackSave(
      run,
      (state) => {
        if (current()) set(state);
      },
      (reset) => {
        if (current()) timer = setTimer(reset, holdMs);
      },
    );
  };
  const dispose = () => {
    latest++;
    clearTimer(timer);
  };
  return { track, dispose };
}

/** State for a `SaveStatus` indicator; `track` wraps a save that resolves to whether it succeeded. */
export function useSaveStatus(holdMs = SAVED_HOLD_MS) {
  const [state, setState] = useState<SaveState>("idle");
  const tracker = useRef<ReturnType<typeof createSaveTracker> | undefined>(undefined);
  tracker.current ??= createSaveTracker({ set: setState, holdMs });
  useEffect(() => () => tracker.current?.dispose(), []);
  return { state, track: tracker.current.track };
}

/** Polite live region next to a block title: always mounted so screen readers announce the change. */
export function SaveStatus({ state, className }: { state: SaveState; className?: string }) {
  const { t } = useT();
  return (
    <span role="status" aria-live="polite" className={cn("save-status ml-2 inline-flex items-center gap-1 font-normal", className)}>
      {state === "saving" && <span className="save-status-saving text-muted-foreground">{t("card.saving")}</span>}
      {state === "saved" && (
        <span className="save-status-saved inline-flex items-center gap-1 text-ok">
          <Check className="size-3" aria-hidden="true" />
          {t("card.saved")}
        </span>
      )}
    </span>
  );
}
