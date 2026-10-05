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

/** State for a `SaveStatus` indicator; `track` wraps a save that resolves to whether it succeeded. */
export function useSaveStatus(holdMs = SAVED_HOLD_MS) {
  const [state, setState] = useState<SaveState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const track = (run: () => Promise<boolean>) => {
    clearTimeout(timer.current);
    return trackSave(run, setState, (reset) => {
      timer.current = setTimeout(reset, holdMs);
    });
  };
  return { state, track };
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
