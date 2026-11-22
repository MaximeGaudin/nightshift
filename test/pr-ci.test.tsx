// Conflict state of the PR badge: tile dot and dialog chip.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrCiStatus } from "../src/shared/pullRequests.ts";
import { CiChip, CiDot } from "../src/web/prCi.tsx";

const ci: PrCiStatus = { url: "https://github.com/o/r/pull/1", state: "conflict", failed: [], checkedAt: new Date().toISOString() };

test("tile shows the conflict icon with its colour", () => {
  const html = renderToStaticMarkup(<CiDot ci={ci} />);
  expect(html).toContain('data-ci="conflict"');
  expect(html).toContain("text-conflict");
});

test("dialog chip shows the conflict label", () => {
  const html = renderToStaticMarkup(<CiChip ci={ci} />);
  expect(html).toContain('data-ci="conflict"');
  expect(html).toContain("text-conflict");
  expect(html).toMatch(/Merge conflict with base branch|Conflit avec la branche de base/);
});
