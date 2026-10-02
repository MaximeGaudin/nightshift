import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Board, Card, Column, ProjectSnapshot } from "../src/shared/types.ts";
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
  const boxes = html.match(/class="lock-model[^"]*"[^>]*><input[^>]*type="checkbox"[^>]*>/g) ?? [];
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

// --- Card models editor ---

const { CardModelsEditor, modelRows, buildModels, saveCardModels } = await import("../src/web/CardModelsEditor.tsx");

const modelsBoard = snap.board;
const baseCard = { id: "c1", number: 1, title: "T", description: "", columnId: "col_impl" } as unknown as Card;

test("card models: one row per skill with its column names, placeholders from column then settings", () => {
  const b = {
    ...modelsBoard,
    columns: [
      { id: "a", name: "Plan", type: "skill", skill: "plan", model: "opus" },
      { id: "b", name: "Re-plan", type: "skill", skill: "plan", model: "opus" },
      { id: "c", name: "Implement", type: "skill", skill: "implement" },
      { id: "d", name: "Review", type: "skill", skill: "review" },
      { id: "e", name: "Inbox", type: "inert" },
    ],
  } as Board;
  const rows = modelRows(b, baseCard, { model: "sonnet" });
  expect(rows.map((r) => r.skill)).toEqual(["plan", "implement", "review"]);
  expect(rows[0]).toMatchObject({ columns: ["Plan", "Re-plan"], fallback: "opus", unused: false });
  expect(rows[1].fallback).toBe("sonnet");
  expect(modelRows(b, baseCard, null)[1].fallback).toBe("default");
  // the card entry is never part of the fallback
  expect(modelRows(b, { ...baseCard, models: { plan: "haiku" } }, { model: "sonnet" })[0].fallback).toBe("opus");
});

test("card models: an extra key shows as an unused row", () => {
  const rows = modelRows(modelsBoard, { ...baseCard, models: { implement: "haiku", ghost: "opus" } }, null);
  expect(rows.map((r) => [r.skill, r.unused])).toEqual([
    ["plan", false],
    ["implement", false],
    ["ghost", true],
  ]);
});

function editorHtml(card: Card) {
  return renderToStaticMarkup(<CardModelsEditor project="/tmp/demo" card={card} board={modelsBoard} settings={{ model: "sonnet" }} />);
}

test("card models: editor markup has rows, values, datalist, clear and unused label", () => {
  const out = editorHtml({ ...baseCard, models: { implement: "haiku", ghost: "opus" } } as Card);
  expect(out).toContain("plan (Plan)");
  expect(out).toContain("implement (Implement)");
  expect(out).toContain("ghost (unused)");
  expect(out).toContain('value="haiku"');
  expect(out).toContain('placeholder="opus"');
  expect(out).toContain('placeholder="sonnet"');
  expect(out).toContain("Clear all");
  for (const m of ["fable", "opus", "sonnet", "haiku"]) expect(out).toContain(`<option value="${m}"`);
});

test("card models: nothing is rendered without skill columns or entries", () => {
  const inert = { ...modelsBoard, columns: [columns[0], columns[3]] } as Board;
  expect(renderToStaticMarkup(<CardModelsEditor project="p" card={baseCard} board={inert} settings={null} />)).toBe("");
});

test("card models: save sends the full map without empty entries; clear sends {}", async () => {
  const calls: unknown[] = [];
  const update = async (_p: string, _id: string, patch: { models: Record<string, string> }) => void calls.push(patch);
  expect(buildModels({ plan: " opus ", implement: "  ", ghost: "haiku" })).toEqual({ plan: "opus", ghost: "haiku" });
  expect(await saveCardModels({ project: "p", cardId: "c1", values: { plan: "opus", implement: "", ghost: "haiku" }, update })).toBeNull();
  expect(await saveCardModels({ project: "p", cardId: "c1", values: {}, update })).toBeNull();
  expect(calls).toEqual([{ models: { plan: "opus", ghost: "haiku" } }, { models: {} }]);
});

test("card models: a 400 message is returned for inline display", async () => {
  const update = async () => {
    throw new Error('Invalid model "gpt" for plan');
  };
  expect(await saveCardModels({ project: "p", cardId: "c1", values: { plan: "gpt" }, update })).toBe('Invalid model "gpt" for plan');
});

// --- Override badge ---

const { CardTile, cardModelOverride } = await import("../src/web/CardTile.tsx");

const overridden = { ...baseCard, columnId: "col_impl", models: { implement: "haiku", plan: "fable" } } as Card;
const tile = (column: Column, settings: { model: string } | null = null) =>
  renderToStaticMarkup(
    <CardTile project="/p" card={{ ...overridden, columnId: column.id }} column={column} settings={settings} onOpen={noop} />,
  );

test("badge: shows the card model with the column in the tooltip", () => {
  const out = tile({ id: "col_impl", name: "Implement", type: "skill", skill: "implement", model: "opus" });
  expect(out).toContain("model-badge");
  expect(out).toContain(">haiku<");
  expect(out).toContain('title="Card model (column: opus)"');
});

test("badge: tooltip says the column has none", () => {
  const out = tile({ id: "col_impl", name: "Implement", type: "skill", skill: "implement" }, { model: "sonnet" });
  expect(out).toContain('title="Card model (column has none)"');
});

test("badge: absent when the column is locked, inert, or the card has no entry", () => {
  expect(tile({ id: "col_impl", name: "Implement", type: "skill", skill: "implement", lockModel: true })).not.toContain("model-badge");
  expect(tile({ id: "col_impl", name: "Notes", type: "inert" })).not.toContain("model-badge");
  expect(tile({ id: "col_impl", name: "Review", type: "skill", skill: "review" })).not.toContain("model-badge");
  expect(cardModelOverride(undefined, null, overridden)).toBeNull();
});
