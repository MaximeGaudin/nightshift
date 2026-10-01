import type { LiveStatus, RunProgress as RunProgressData } from "../shared/types.ts";

export function RunProgress({ progress, live }: { progress?: RunProgressData; live?: LiveStatus }) {
  if (live !== "running" || !progress) return null;
  const { step, total, label } = progress;
  const pct = total > 0 ? Math.min(100, Math.max(0, ((step - 1) / total) * 100)) : 0;
  return (
    <div className="run-progress">
      <div className="run-progress-head">
        <span className="run-progress-step">
          Étape {step}/{total}
        </span>
        <span className="run-progress-label" title={label}>
          {label}
        </span>
      </div>
      <div
        className="run-progress-bar"
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`Étape ${step} sur ${total} : ${label}`}
      >
        <div className="run-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
