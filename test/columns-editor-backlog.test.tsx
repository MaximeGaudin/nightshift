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

const { ColumnsEditor } = await import("../src/web/ColumnsEditor.tsx");

const columns: Column[] = [
  { id: "col_backlog", name: "Backlog", type: "inert", emoji: "📥" },
  { id: "col_a", name: "Alpha", type: "inert" },
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

/** The `<li>` elements of the editor list, in order. */
const rows = () => html.slice(html.indexOf('class="col-editor')).split("<li").slice(1);

test("editor-backlog-locked", () => {
  const [backlog, alpha, done] = rows();
  expect(backlog).toContain("locked");
  expect(backlog).toContain("Backlog");
  expect(backlog).toContain("System column");
  expect(backlog).toContain('aria-label="Emoji"');
  expect(backlog).toContain('value="📥"');
  expect(backlog).not.toContain(" readonly=");
  expect(backlog).not.toContain(" disabled=");
  expect(backlog).not.toContain('aria-label="Name"');
  expect(backlog).not.toContain('aria-label="Type"');
  expect(backlog).not.toContain('role="combobox"');
  expect(backlog).not.toContain("<select");
  expect(backlog).not.toContain("Delete");
  expect(backlog).not.toContain("Reorder");
  expect(backlog).not.toContain("aria-roledescription");
  expect(alpha).toContain("Reorder");
  expect(alpha).toContain('aria-label="Name"');
  expect(done).toContain("locked");
});
