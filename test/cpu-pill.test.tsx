import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CpuThrottlePill } from "../src/web/CpuThrottlePill.tsx";
import { TooltipProvider } from "../src/web/components/ui/tooltip.tsx";
import { en } from "../src/web/i18n/en/index.ts";

const render = (throttle?: { load: number; limit: number }) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <CpuThrottlePill throttle={throttle} />
    </TooltipProvider>,
  );

test("cpu-pill-shown: the load is in the pill, the limit in the English tooltip text", () => {
  expect(render({ load: 92, limit: 85 })).toContain("CPU 92 %");
  expect(en["board.app.cpuThrottledTip"]).toContain("{limit}");
});

test("cpu-pill-hidden: no pill without a throttle", () => {
  expect(render(undefined)).toBe("");
});
