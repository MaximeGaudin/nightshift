import type { LiveStatus, RunProgress as RunProgressData } from "../shared/types.ts";

export function RunProgress({ progress, live }: { progress?: RunProgressData; live?: LiveStatus }) {
  if (live !== "running" || !progress) return null;
  const { step, total, label } = progress;
  const pct = total > 0 ? Math.min(100, Math.max(0, ((step - 1) / total) * 100)) : 0;
  return (
    <div className="run-progress mt-2 flex min-w-0 flex-col gap-1">
      <div className="run-progress-head flex min-w-0 items-baseline gap-1.5 text-[11px] text-muted-foreground">
        <span className="run-progress-step shrink-0 tabular-nums">
          Étape {step}/{total}
        </span>
        <span className="run-progress-label min-w-0 flex-1 truncate" title={label}>
          {label}
        </span>
      </div>
      <div
        className="run-progress-bar h-1 overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`Étape ${step} sur ${total} : ${label}`}
      >
        <div className="run-progress-fill h-full rounded-full bg-primary transition-[width] duration-150" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
