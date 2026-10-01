import { beforeEach, expect, mock, test } from "bun:test";
import type { QuickRun } from "../src/shared/types.ts";

const calls: { fn: string; args: unknown[] }[] = [];
const rec =
  (fn: string) =>
  (...args: unknown[]) => {
    calls.push({ fn, args });
    return args[1] && typeof args[1] === "object" ? (args[1] as { id?: string }).id : undefined;
  };
const toastMock = Object.assign(rec("toast"), {
  success: rec("success"),
  error: rec("error"),
  info: rec("info"),
  warning: rec("warning"),
  dismiss: rec("dismiss"),
});
mock.module("sonner", () => ({ toast: toastMock, Toaster: () => null }));

const cancel = mock(async (_p: string, _id: string) => ({ ok: true }));
const { api } = await import("../src/web/api.ts");
api.cancelQuickRun = cancel;
const { clearQuickRunToasts, showQuickRunResult, syncQuickRunToasts } = await import("../src/web/QuickRunToasts.tsx");

const run = (id: string, over: Partial<QuickRun> = {}): QuickRun => ({
  id,
  skill: "s",
  instruction: "",
  status: "running",
  createdAt: "",
  ...over,
});
const shownIds = () => calls.filter((c) => c.fn === "toast").map((c) => (c.args[1] as { id: string }).id);
const dismissed = () => calls.filter((c) => c.fn === "dismiss").map((c) => c.args[0]);

function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { type: unknown; props: { children?: unknown } };
  if (typeof el.type === "function") return textOf((el.type as (p: unknown) => unknown)(el.props));
  return textOf(el.props?.children);
}
function findButton(node: unknown): { onClick: () => void } | null {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) return node.map(findButton).find(Boolean) ?? null;
  const el = node as { type: unknown; props: { children?: unknown; onClick?: () => void } };
  if (el.props?.onClick) return el.props as { onClick: () => void };
  const next = typeof el.type === "function" ? (el.type as (p: unknown) => unknown)(el.props) : el.props?.children;
  return findButton(next);
}

beforeEach(() => {
  calls.length = 0;
  clearQuickRunToasts();
  calls.length = 0;
});

test("quick-run-toasts-sync", () => {
  const A = run("A", { progress: { step: 1, total: 2, label: "lbl", source: "marker", at: "" } });
  syncQuickRunToasts("/p", [A, run("B")]);
  const a = calls.find((c) => c.fn === "toast" && (c.args[1] as { id: string }).id === "A");
  expect(textOf(a?.args[0])).toContain("1/2");
  expect(a?.args[1]).toMatchObject({ duration: Number.POSITIVE_INFINITY });

  // B vanishes with no result: dismissed. A result then empty snapshot: stays.
  showQuickRunResult({ id: "A", skill: "s", instruction: "", status: "success", summary: "done" });
  expect(calls.some((c) => c.fn === "success" && (c.args[1] as { id: string }).id === "A")).toBe(true);
  calls.length = 0;
  syncQuickRunToasts("/p", []);
  expect(dismissed()).toEqual(["B"]);
});

test("finalized id is not re-shown by later snapshots", () => {
  showQuickRunResult({ id: "F", skill: "s", instruction: "", status: "error", error: "boom" });
  expect(calls[0]?.fn).toBe("error");
  expect(calls[0]?.args[0]).toBe("boom");
  calls.length = 0;
  syncQuickRunToasts("/p", [run("F")]);
  syncQuickRunToasts("/p", []);
  expect(shownIds()).toEqual([]);
  expect(dismissed()).toEqual([]);
});

test("stop button cancels the run; indeterminate for activity", () => {
  syncQuickRunToasts("/proj", [run("S", { progress: { step: 1, total: 1, label: "x", source: "activity", at: "" } })]);
  const content = calls[0]?.args[0];
  expect(textOf(content)).not.toContain("1/1");
  findButton(content)?.onClick();
  expect(cancel).toHaveBeenCalledWith("/proj", "S");
});

test("cancelled shows default-duration info", () => {
  showQuickRunResult({ id: "C", skill: "s", instruction: "", status: "cancelled" });
  expect(calls[0]?.fn).toBe("info");
  expect(calls[0]?.args[1]).not.toHaveProperty("duration");
});
