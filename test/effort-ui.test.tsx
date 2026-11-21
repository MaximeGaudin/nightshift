import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Board, Card, Column, ProjectSnapshot, Settings } from "../src/shared/types.ts";
import { setLocale } from "../src/web/i18n/index.ts";

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
mock.module(new URL("../src/web/components/ui/collapsible.tsx", import.meta.url).pathname, () => ({
  Collapsible: Passthrough,
  CollapsibleTrigger: Passthrough,
  CollapsibleContent: Passthrough,
}));

const { ColumnsEditor } = await import("../src/web/ColumnsEditor.tsx");
const { CardModelsEditor, saveCardModels } = await import("../src/web/CardModelsEditor.tsx");
const { SettingsContent } = await import("../src/web/SettingsModal.tsx");

const columns: Column[] = [
  { id: "col_backlog", name: "Backlog", type: "inert" },
  { id: "col_merge", name: "Merge", type: "skill", skill: "nightshift-merge", effort: "high" },
  { id: "col_impl", name: "Implement", type: "skill", skill: "nightshift-implement" },
  { id: "col_done", name: "Done", type: "inert" },
];
const board = { version: 1, name: "Demo", columns, cards: [], nextCardNumber: 1 } as Board;
const snap = { path: "/tmp/demo", board, live: {}, testing: [], progress: {} } as unknown as ProjectSnapshot;
const settings: Settings = {
  claudePath: "claude",
  permissionMode: "auto",
  model: "",
  effort: "",
  extraArgs: "",
  recentProjects: [],
  soundNotifications: false,
  language: "auto",
  carryMaxTokens: 80000,
  carryMaxAgeMinutes: 5,
};

const g = globalThis as { window?: unknown };
const hadWindow = "window" in g;
const previousWindow = g.window;
const noop = () => {};
beforeAll(() => {
  g.window = {
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  };
});
afterAll(() => {
  setLocale("fr");
  if (hadWindow) g.window = previousWindow;
  else delete g.window;
});

const card = {
  id: "k",
  number: 1,
  title: "t",
  description: "",
  columnId: "col_merge",
  history: [],
  efforts: { "nightshift-merge": "xhigh" },
} as unknown as Card;

for (const [locale, effort, inherit, economic] of [
  ["en", "Effort", "Inherit global", "Economic (default)"],
  ["fr", "Effort", "Hériter du global", "Économique (défaut)"],
] as const) {
  test(`effort selectors render in ${locale}`, () => {
    setLocale(locale);
    const cols = renderToStaticMarkup(<ColumnsEditor snap={snap} onClose={noop} />);
    expect(cols.match(/id="effort-/g)).toHaveLength(2);
    expect(cols).toContain(`>${effort}</label>`);
    expect(cols).toContain(`>${inherit}</option>`);
    expect(cols).toMatch(/<option value="high" selected="">high<\/option>/);
    const st = renderToStaticMarkup(<SettingsContent value={settings} onChange={noop} currentProject={undefined} onOpenProject={noop} />);
    expect(st).toContain('id="set-effort"');
    expect(st).toContain(`>${economic}</option>`);
    for (const l of ["low", "medium", "high", "xhigh", "max"]) expect(st).toContain(`<option value="${l}">${l}</option>`);
    const ed = renderToStaticMarkup(<CardModelsEditor project="/tmp/demo" card={card} board={board} settings={settings} />);
    expect(ed).toContain('id="card-effort-nightshift-merge"');
    expect(ed).toMatch(/<option value="xhigh" selected="">xhigh<\/option>/);
    expect(ed).toContain(locale === "en" ? "Default (high)" : "Par défaut (high)");
  });
}

test("card editor saves models and efforts in one PATCH", async () => {
  const calls: unknown[] = [];
  const err = await saveCardModels({
    project: "/p",
    cardId: "k",
    values: { a: " opus ", b: "" },
    efforts: { a: "low", b: "" },
    update: async (_p, _i, patch) => {
      calls.push(patch);
    },
  });
  expect(err).toBeNull();
  expect(calls).toEqual([{ models: { a: "opus" }, efforts: { a: "low" } }]);
});

test("server rejection is returned, nothing claims success", async () => {
  const err = await saveCardModels({
    project: "/p",
    cardId: "k",
    values: {},
    efforts: { a: "turbo" },
    update: async () => {
      throw new Error('Invalid effort "turbo" for a');
    },
  });
  expect(err).toContain("turbo");
});
