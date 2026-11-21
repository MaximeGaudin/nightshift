import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IssueSourceStatus } from "../src/shared/issues.ts";
import { IssueSyncIndicator, issueSyncIndicatorState } from "../src/web/IssueSyncIndicator.tsx";

const a = { id: "a", repo: "o/a", enabled: true };
const b = { id: "b", repo: "o/b", enabled: true };
const st = (x: Partial<IssueSourceStatus>): IssueSourceStatus => ({ hasToken: true, syncing: false, ...x });

test("ui-sync-indicator-state", () => {
  expect(issueSyncIndicatorState([a], undefined)).toBeNull();
  expect(issueSyncIndicatorState([a], { a: st({ lastSyncAt: "2026-01-01T00:00:00Z" }) })).toBeNull();
  expect(issueSyncIndicatorState([a, b], { a: st({ lastError: "boom" }), b: st({ syncing: true }) })).toEqual({
    kind: "syncing",
    lines: ["o/b"],
  });
  expect(issueSyncIndicatorState([a], { a: st({ lastError: "boom" }) })).toEqual({ kind: "error", lines: ["o/a: boom"] });
  // Disabled sources are ignored.
  expect(issueSyncIndicatorState([{ ...a, enabled: false }], { a: st({ syncing: true, lastError: "x" }) })).toBeNull();
});

test("ui-sync-indicator-render", () => {
  const html = (status: Record<string, IssueSourceStatus>) =>
    renderToStaticMarkup(<IssueSyncIndicator sources={[a]} status={status} onOpen={() => {}} />);
  expect(html({ a: st({ syncing: true }) })).toContain('data-state-kind="syncing"');
  expect(html({ a: st({ lastError: "boom" }) })).toContain('data-state-kind="error"');
  expect(html({ a: st({}) })).toBe("");
});
