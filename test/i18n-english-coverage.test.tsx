import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Board, Card, Column, ProjectSnapshot, Settings } from "../src/shared/types.ts";
import { messages, setLocale } from "../src/web/i18n/index.ts";

// Radix dialogs render nothing on the server: swap them for plain wrappers so the whole modal body is rendered.
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

// App first: Board and App import each other.
const { SequenceButton, SequenceNotice } = await import("../src/web/App.tsx");
const { Board: BoardView } = await import("../src/web/Board.tsx");
const { CardModal } = await import("../src/web/CardModal.tsx");
const { SettingsContent, SettingsModal } = await import("../src/web/SettingsModal.tsx");
const { SkillsModal } = await import("../src/web/SkillsModal.tsx");
const { ColumnsEditor } = await import("../src/web/ColumnsEditor.tsx");
const { CommandPalette } = await import("../src/web/CommandPalette.tsx");
const { ShortcutsHelp } = await import("../src/web/ShortcutsHelp.tsx");
const { TimePanelView } = await import("../src/web/TimePanel.tsx");
const { buildCommands } = await import("../src/web/commands.ts");

const FRENCH_ONLY_CHARS = /[àâçéèêëîïôûùüÿœ]/i;
/** Option label of the language select: the name of a language stays in that language. */
const ALLOWED_LITERALS = ["Français"];

const T0 = "2026-01-01T00:00:00Z";
const columns: Column[] = [
  { id: "col_backlog", name: "Backlog", type: "inert" },
  { id: "col_review", name: "Review", type: "skill", skill: "review" },
  { id: "col_merge", name: "Merge", type: "skill", skill: "merge" },
  { id: "col_done", name: "Done", type: "inert" },
];
const mk = (n: number, columnId: string, extra: Partial<Card> = {}): Card => ({
  id: `c${n}`,
  number: n,
  title: `Card ${n}`,
  description: "Some description",
  columnId,
  createdAt: T0,
  updatedAt: T0,
  enteredColumnAt: T0,
  history: [
    { at: T0, kind: "created", text: "Created in Backlog", columnId: "col_backlog" },
    { at: "2026-01-01T01:30:00Z", kind: "moved", text: "Moved", columnId },
    { at: "2026-01-01T01:40:00Z", kind: "started", text: "Started", columnId },
  ],
  ...extra,
});
const cards = [
  mk(1, "col_backlog"),
  mk(2, "col_review", {
    lastRun: { status: "question", columnId: "col_review", at: T0, questions: ["Which option?"], sessionId: "s1" } as Card["lastRun"],
  }),
  mk(3, "col_merge", {
    lastRun: { status: "error", columnId: "col_merge", at: T0, error: "boom" } as Card["lastRun"],
    skipColumnIds: ["col_review"],
  }),
  mk(4, "col_done"),
];
const board = { version: 1, name: "Demo", columns, cards, nextCardNumber: 5 } as Board;
const snap = {
  path: "/tmp/demo",
  board,
  live: { c2: "running", c3: "queued" },
  testing: [],
  progress: {},
  sequence: { status: "paused", cardId: "c1" },
} as unknown as ProjectSnapshot;
const settings: Settings = {
  maxParallel: 3,
  claudePath: "claude",
  permissionMode: "bypassPermissions",
  model: "",
  extraArgs: "",
  recentProjects: ["/tmp/other", "/tmp/demo"],
  soundNotifications: false,
  language: "auto",
};

const noop = () => {};
const rendered: Record<string, string> = {};
const surfaces: Record<string, () => ReactNode> = {
  board: () => <BoardView snap={snap} onOpen={noop} guard={noop} />,
  "card modal": () => (
    <CardModal project="/tmp/demo" card={cards[2]} board={board} testing={false} sequential onClose={noop} onError={noop} />
  ),
  "card modal running": () => (
    <CardModal project="/tmp/demo" card={cards[1]} board={board} live="running" testing onClose={noop} onError={noop} />
  ),
  settings: () => <SettingsModal settings={settings} currentProject="/tmp/demo" onClose={noop} onOpenProject={noop} />,
  "settings content": () => <SettingsContent value={settings} onChange={noop} currentProject="/tmp/demo" onOpenProject={noop} />,
  "skills modal": () => <SkillsModal project="/tmp/demo" onClose={noop} />,
  "columns editor": () => <ColumnsEditor snap={snap} onClose={noop} />,
  "command palette": () => (
    <CommandPalette commands={buildCommands({ snap, recentProjects: settings.recentProjects, skills: [] })} onRun={noop} onClose={noop} />
  ),
  "shortcuts help": () => <ShortcutsHelp onClose={noop} />,
  "sequence button": () => <SequenceButton snap={snap} guard={noop} />,
  "sequence notice": () => (
    <SequenceNotice snap={{ sequence: { status: "stopped", cardId: "c1", notice: { code: "kept", ref: "#3", column: "Review" } } }} />
  ),
  "time panel": () => <TimePanelView card={cards[2]} board={board} nowMs={Date.parse("2026-01-04T05:00:00Z")} />,
};

const storage = { getItem: () => null, setItem: noop, removeItem: noop };
const g = globalThis as { window?: unknown };
const hadWindow = "window" in g;
const previousWindow = g.window;

beforeAll(() => {
  setLocale("en");
  g.window = { localStorage: storage, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) };
  for (const [name, render] of Object.entries(surfaces)) {
    try {
      rendered[name] = renderToStaticMarkup(render());
    } catch (e) {
      throw new Error(`${name}: ${e}`);
    }
  }
});

afterAll(() => {
  setLocale("fr");
  if (hadWindow) g.window = previousWindow;
  else delete g.window;
});

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** Literal pieces of a message around its {placeholders}. */
const literals = (value: string) => value.split(/\{\w+\}/).map((s) => s.trim());

const strip = (html: string) => ALLOWED_LITERALS.reduce((acc, lit) => acc.split(lit).join(""), html);

test("every surface rendered something", () => {
  for (const [name, html] of Object.entries(rendered)) expect(html.length, name).toBeGreaterThan(100);
});

test("no French-only character in any English surface", () => {
  for (const [name, html] of Object.entries(rendered)) {
    const text = strip(html);
    const found = text.match(FRENCH_ONLY_CHARS);
    expect(found ? text.slice(Math.max(0, (found.index ?? 0) - 40), (found.index ?? 0) + 40) : null, name).toBeNull();
  }
});

test("no French message value appears in any English surface", () => {
  const { en, fr } = messages;
  const leaks: string[] = [];
  for (const [key, frValue] of Object.entries(fr)) {
    if (frValue === undefined || frValue === en[key]) continue;
    const enText = (en[key] ?? "").toLowerCase();
    for (const piece of literals(frValue)) {
      // A piece the English message shares (a word both languages spell alike) is not French-specific.
      if (piece.length < 4 || enText.includes(piece.toLowerCase())) continue;
      for (const [name, html] of Object.entries(rendered)) {
        const text = strip(html);
        if (text.includes(piece) || text.includes(escapeHtml(piece))) leaks.push(`${name}: ${key} -> ${piece}`);
      }
    }
  }
  expect(leaks).toEqual([]);
});
