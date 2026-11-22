// Automatic merge cycles of the CI watcher: the count read back from the card history, and the `- Problème :` line.
import { expect, test } from "bun:test";
import { autoMergeCycles, MERGE_RELAUNCH_PREFIX } from "../src/server/ciWatcher.ts";
import { parseMergeStatus, writeMergeProblem, writeMergeStatus } from "../src/shared/pullRequests.ts";
import type { HistoryEntry } from "../src/shared/types.ts";

const at = "2026-01-01T00:00:00.000Z";
const relaunch = (n: number): HistoryEntry => ({ at, kind: "edited", text: `${MERGE_RELAUNCH_PREFIX} (${n}/3) — conflit avec main` });
const moved: HistoryEntry = { at, kind: "moved", text: "Moved: Review → Merge", columnId: "m" };
const retry: HistoryEntry = { at, kind: "edited", text: "Retry requested by user" };

test("auto-merge cycle counter: since the last move or human retry", () => {
  expect(autoMergeCycles([])).toBe(0);
  expect(autoMergeCycles([relaunch(1), moved, relaunch(1), { at, kind: "queued", text: "Queued in Merge" }, relaunch(2)])).toBe(2);
  expect(autoMergeCycles([moved, relaunch(1), relaunch(2), retry])).toBe(0);
  expect(autoMergeCycles([moved, relaunch(1), retry, relaunch(1)])).toBe(1);
  // The history is capped: with no move left in it, count from its start.
  expect(autoMergeCycles([relaunch(2), relaunch(3)])).toBe(2);
});

test("writeMergeProblem: a single Problème line under ## Merge, the PR status line kept", () => {
  const url = "https://github.com/o/r/pull/3";
  let d = writeMergeStatus("# Brief\n\n## Notes\n\nkeep\n", url, "auto");
  d = writeMergeProblem(d, "auto-merge annulé par GitHub");
  d = writeMergeProblem(d, "conflit avec main");
  expect(d).toBe(`# Brief\n\n## Notes\n\nkeep\n\n## Merge\n\n- PR: ${url} — auto-merge programmé\n- Problème : conflit avec main\n`);
  expect(parseMergeStatus(d)).toEqual({ url, status: "auto" });
  expect(writeMergeProblem("x", "y")).toBe("x\n\n## Merge\n\n- Problème : y\n");
});
