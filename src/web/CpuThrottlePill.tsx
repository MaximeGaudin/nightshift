import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProjectSnapshot } from "../shared/types.ts";
import { t } from "./i18n/index.ts";

/** Header pill shown only while this project's ready cards wait because the CPU load reached the limit. */
export function CpuThrottlePill({ throttle }: { throttle: ProjectSnapshot["cpuThrottle"] }) {
  if (!throttle) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cpu-throttle-pill rounded-full px-2 py-0.5 text-warn tabular-nums">
          {t("board.app.cpuThrottled", { load: throttle.load })}
        </span>
      </TooltipTrigger>
      <TooltipContent>{t("board.app.cpuThrottledTip", { load: throttle.load, limit: throttle.limit })}</TooltipContent>
    </Tooltip>
  );
}
