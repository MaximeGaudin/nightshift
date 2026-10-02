import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Board, Column, ProjectSnapshot } from "../src/shared/types.ts";
import { setLocale } from "../src/web/i18n/index.ts";

// Radix dialogs render nothing on the server: swap them for plain wrappers so the whole editor body is rendered.
const Passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const Close = ({ "aria-label": label }: ComponentProps<"button">) => <button type="button" aria-label={label} />;
mock.module(new URL("../src/web/components/ui/dialog.tsx", import.meta.url).pathname, () => ({
  Dialog: Passthrough,
  DialogTrigger: Passthrough,
  DialogPortal: Passthrough,
  DialogClose: Close,
  DialogOverlay: Passthrough,
  DialogContent: Passthrough,
  DialogHeader: Passthrough,
  DialogFooter: Passthrough,
  DialogTitle: Passthrough,
  DialogDescription: Passthrough,
}));

// Collapsed rows render no content on the server: open them.
mock.module(new URL("../src/web/components/ui/collapsible.tsx", import.meta.url).pathname, () => ({
  Collapsible: Passthrough,
  CollapsibleTrigger: Passthrough,
  CollapsibleContent: Passthrough,
}));

const { ColumnsEditor, lockModelPatch } = await import("../src/web/ColumnsEditor.tsx");

const columns: Column[] = [
  { id: "col_backlog", name: "Backlog", type: "inert", emoji: "📥" },
  { id: "col_plan", name: "Plan", type: "skill", skill: "plan", model: "opus", lockModel: true },
  { id: "col_impl", name: "Implement", type: "skill", skill: "implement" },
  { id: "col_done", name: "Done", type: "inert" },
];
const snap = {
  path: "/tmp/demo",
  board: { version: 1, name: "Demo", columns, cards: [], nextCardNumber: 1 } as Board,
  live: {},
  testing: [],
  progress: {},
} as unknown as ProjectSnapshot;

const g = globalThis as { window?: unknown };
const hadWindow = "window" in g;
const previousWindow = g.window;
const noop = () => {};
let html = "";

beforeAll(() => {
  setLocale("en");
  g.window = {
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  };
  html = renderToStaticMarkup(<ColumnsEditor snap={snap} onClose={noop} />);
});

afterAll(() => {
  setLocale("fr");
  if (hadWindow) g.window = previousWindow;
  else delete g.window;
});

test("columns editor: lock checkbox only on skill columns, checked from lockModel", () => {
  const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
  expect(boxes).toHaveLength(2);
  expect(boxes[0]).toContain("checked");
  expect(boxes[1]).not.toContain("checked");
  expect(html.match(/Always use this column&#x27;s model/g)).toHaveLength(2);
});

test("columns editor: model datalist comes from the shared aliases", () => {
  for (const m of ["fable", "opus", "sonnet", "haiku"]) expect(html).toContain(`<option value="${m}"`);
});

test("lockModelPatch stores true and omits the flag when off", () => {
  expect(lockModelPatch(true)).toEqual({ lockModel: true });
  expect(JSON.stringify({ ...columns[1], ...lockModelPatch(false) })).not.toContain("lockModel");
});
