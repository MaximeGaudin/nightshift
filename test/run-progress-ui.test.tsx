import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunProgress as P } from "../src/shared/types.ts";
import { RunProgress } from "../src/web/RunProgress.tsx";

const p: P = { step: 3, total: 7, label: "Tests", source: "agent", at: 0 } as P;

test("ui-tile-progress", () => {
  const html = renderToStaticMarkup(<RunProgress progress={p} live="running" />);
  expect(html).toContain("Étape 3/7");
  expect(html).toContain("Tests");
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-valuenow="3"');
  expect(html).toContain('aria-valuemax="7"');
  const w = Number(/width:([\d.]+)%/.exec(html)?.[1]);
  expect(w).toBeCloseTo(28.57, 1);
});

test("ui-fill-last-step-not-full", () => {
  const html = renderToStaticMarkup(<RunProgress progress={{ ...p, step: 7 }} live="running" />);
  expect(Number(/width:([\d.]+)%/.exec(html)?.[1])).toBeLessThan(100);
});

test("ui-no-progress-when-not-running", () => {
  expect(renderToStaticMarkup(<RunProgress progress={p} live="queued" />)).not.toContain("progressbar");
  expect(renderToStaticMarkup(<RunProgress progress={p} live={undefined} />)).not.toContain("progressbar");
  expect(renderToStaticMarkup(<RunProgress progress={undefined} live="running" />)).not.toContain("progressbar");
});
