import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Board, Card } from "../src/shared/types.ts";
import { CardModalContent, useCardDraft } from "../src/web/CardModal.tsx";

const board = {
  version: 1,
  name: "b",
  columns: [
    { id: "col_a", name: "Backlog", type: "inert" },
    { id: "col_done", name: "Done", type: "inert" },
  ],
  cards: [],
  nextCardNumber: 2,
} as Board;
const card: Card = {
  id: "c1",
  number: 1,
  title: "T",
  description: "d",
  columnId: "col_a",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  enteredColumnAt: "2026-01-01T00:00:00Z",
  history: [],
};
function Content() {
  const draft = useCardDraft("p", card);
  return <CardModalContent project="p" card={card} board={board} testing={false} onClose={() => {}} onError={() => {}} draft={draft} />;
}
const html = renderToStaticMarkup(<Content />);

/** Class list of the first element whose class attribute contains the hook class. */
const classesOf = (hook: string): string[] => {
  const m = html.match(new RegExp(`class="([^"]*\\b${hook}\\b[^"]*)"`));
  if (!m) throw new Error(`element not found: ${hook}`);
  return m[1].split(/\s+/);
};

test("card-modal-grid-tracks-shrink", () => {
  expect(classesOf("card-modal")).toContain("grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]");
});

test("card-modal-mobile-track-shrinks", () => {
  expect(classesOf("card-modal")).toContain("max-[800px]:grid-cols-[minmax(0,1fr)]");
});

test("card-modal-children-min-width", () => {
  for (const hook of ["card-modal", "card-edit", "card-side", "card-desc"]) {
    expect(classesOf(hook)).toContain("min-w-0");
  }
  const side = classesOf("card-side");
  expect(side).toContain("overflow-y-auto");
  expect(side).toContain("min-h-0");
  expect(side).not.toContain("overflow-x-hidden");
});

test("card-modal-log-min-height", () => {
  const log = classesOf("log");
  expect(log).toContain("min-h-[320px]");
  expect(log).toContain("flex-[1_0_320px]");
});

const mdCss = readFileSync(new URL("../src/web/styles/markdown.css", import.meta.url), "utf8");
const mdRule = (selector: string): string => {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  const blocks = [...mdCss.matchAll(re)].map((m) => m[1]);
  if (!blocks.length) throw new Error(`rule not found: ${selector}`);
  return blocks.join(" ");
};

test("markdown-wide-blocks-scroll", () => {
  const table = mdRule(".md .md-table");
  expect(table).toContain("overflow-x: auto");
  expect(table).toContain("max-width: 100%");
  expect(mdRule(".md pre")).toContain("overflow-x: auto");
  expect(mdRule(".md")).toContain("overflow-wrap: anywhere");
});

test("markdown-uses-theme-variables-only", () => {
  const used = new Set([...mdCss.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
  // --muted is a shadcn theme background now, so it is allowed; the other legacy names are not.
  for (const legacy of ["--text", "--ui-muted", "--surface", "--surface-2", "--border-strong", "--sp-1", "--fs-md"]) {
    expect(used.has(legacy)).toBe(false);
  }
  // Every variable used is defined by the theme sheet.
  const themeCss = readFileSync(new URL("../src/web/index.css", import.meta.url), "utf8");
  const defined = new Set([...themeCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  expect([...used].filter((v) => !defined.has(v))).toEqual([]);
});
