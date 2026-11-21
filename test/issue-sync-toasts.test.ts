import { expect, mock, test } from "bun:test";
import type { IssueSource } from "../src/shared/issues.ts";

const calls: string[] = [];
mock.module("sonner", () => ({
  toast: { success: (m: string) => calls.push(`ok ${m}`), error: (m: string) => calls.push(`err ${m}`) },
}));
const { notifySyncResults } = await import("../src/web/notify.ts");

const src: Pick<IssueSource, "id" | "repo"> = { id: "src_a", repo: "o/r" };
const base = { sourceId: "src_a", ok: true, imported: 0, updated: 0, deleted: 0, pruned: 0 };

test("ui-sync-toasts", () => {
  notifySyncResults([{ ...base, imported: 2, pruned: 1 }, base, { ...base, ok: false, error: "boom" }, { ...base, skipped: true }], [src]);
  // Success with counts, up to date, failure; the skipped sync shows nothing.
  expect(calls.length).toBe(3);
  expect(calls[0]).toMatch(/^ok .*o\/r.*2.*1/);
  expect(calls[1]).toMatch(/^ok .*o\/r/);
  expect(calls[2]).toMatch(/^err .*o\/r.*boom/);
});
