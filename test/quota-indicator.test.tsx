import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { QuotaSnapshot } from "../src/shared/usage.ts";
import { setLocale } from "../src/web/i18n/index.ts";
import { QuotaIndicatorView, quotaTooltipLines } from "../src/web/QuotaIndicator.tsx";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const snap = (over: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  fiveHour: { utilization: 0.38, resetsAt: NOW / 1000 + 2 * 3600 + 15 * 60 },
  sevenDay: { utilization: 0.88, resetsAt: NOW / 1000 + 3 * 86400 },
  status: "allowed_warning",
  isUsingOverage: false,
  at: new Date(NOW - 5 * 60000).toISOString(),
  ...over,
});
const render = (usage: QuotaSnapshot | null, now = NOW) => renderToStaticMarkup(<QuotaIndicatorView usage={usage} now={now} />);

afterEach(() => setLocale("fr"));

test("ui-gauges", () => {
  setLocale("fr");
  const html = render(snap());
  expect(html).toContain("5 h 38 %");
  expect(html).toContain("7 j 88 %");
  expect(html).toMatch(/text-warn[^>]*data-level="warn"[^>]*><span>7 j 88 %/);
  expect(render(snap({ sevenDay: { utilization: 0.92, resetsAt: NOW / 1000 + 100 } }))).toContain("text-destructive");
  expect(render(snap({ status: "rejected" }))).toContain('data-level="danger"');
  setLocale("en");
  expect(render(snap())).toContain("7d 88%");
});

test("ui-empty-expired-stale", () => {
  setLocale("fr");
  expect(render(null)).toContain("Quota : —");
  const expired = render(snap(), NOW + 3 * 3600 * 1000);
  expect(expired).toContain("5 h —");
  expect(expired).toContain("7 j 88 %");
  expect(render(snap())).not.toContain("opacity-60");
  expect(render(snap({ at: new Date(NOW - 2 * 3600 * 1000).toISOString() }))).toContain("opacity-60");
});

test("ui-tooltip-text", () => {
  setLocale("fr");
  const lines = quotaTooltipLines(snap({ isUsingOverage: true }), NOW, "fr");
  expect(lines[0]).toMatch(/^5 h : 38 % · reset à .+ · dans 2 h 15$/);
  expect(lines[1]).toContain("7 j : 88 %");
  expect(lines[1]).toContain("dans 3 j 0 h");
  expect(lines).toContain("Mis à jour il y a 5 min");
  expect(lines).toContain("Dépassement en cours");
  const expired = quotaTooltipLines(snap(), NOW + 3 * 3600 * 1000, "fr");
  expect(expired[0]).toContain("réinitialisé, en attente du prochain agent");
});
