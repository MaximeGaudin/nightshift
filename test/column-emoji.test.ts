import { afterAll, beforeAll, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { type ChildServer, removeTempDirs, startChildServer, tempDir } from "./helpers.ts";

const { doneColumnChanged, normalizeBoard, numberingChanged } = await import("../src/server/store.ts");
const { normalizeColumnEmoji } = await import("../src/shared/types.ts");
const { ColumnGlyph } = await import("../src/web/icons.tsx");

test("emoji-normalize", () => {
  expect(normalizeColumnEmoji(" 🚀 ")).toBe("🚀");
  expect(normalizeColumnEmoji("🇫🇷abc")).toBe("🇫🇷");
  expect(normalizeColumnEmoji("👨‍👩‍👧x")).toBe("👨‍👩‍👧");
  expect(normalizeColumnEmoji("👍🏽")).toBe("👍🏽");
  expect(normalizeColumnEmoji("a")).toBe("a");
  for (const v of ["", "   ", 3, undefined]) expect(normalizeColumnEmoji(v)).toBeUndefined();
});

test("emoji-load: normalizeBoard keeps first grapheme, drops empty and non-string", () => {
  const b = normalizeBoard(
    {
      columns: [
        { id: "a", name: "A", type: "inert", emoji: "  ✅ ok" },
        { id: "b", name: "B", type: "inert", emoji: "" },
        { id: "c", name: "C", type: "inert", emoji: 5 },
      ],
      cards: [],
    },
    "x",
  );
  expect(b.columns[0].emoji).toBe("✅");
  expect("emoji" in b.columns[1]).toBe(false);
  expect("emoji" in b.columns[2]).toBe(false);
});

test("emoji-no-rewrite", () => {
  const plain = {
    columns: [
      { id: "a", name: "A", type: "skill", skill: "s", maxParallel: 2 },
      { id: "col_done", name: "Done", type: "inert" },
    ],
    cards: [],
    nextCardNumber: 1,
  };
  expect(doneColumnChanged(plain, normalizeBoard(plain, "x"))).toBe(false);
  expect(numberingChanged(plain, normalizeBoard(plain, "x"))).toBe(false);
  const withEmoji = {
    columns: [
      { id: "a", name: "A", type: "skill", skill: "s", model: "m", maxParallel: 2, emoji: "🚀" },
      { id: "col_done", name: "Done", type: "inert", emoji: "🏁" },
    ],
    cards: [],
    nextCardNumber: 1,
  };
  const n = normalizeBoard(withEmoji, "x");
  expect(n.columns[1].emoji).toBe("🏁");
  expect(doneColumnChanged(withEmoji, n)).toBe(false);
  expect(numberingChanged(withEmoji, n)).toBe(false);
});

// The server runs in a child process with its own NIGHTSHIFT_HOME (see test/helpers.ts).
let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer({ settings: { maxParallel: 1 } });
});
afterAll(async () => {
  await srv.stop();
  removeTempDirs();
});

test("emoji-save via board endpoint", async () => {
  const proj = tempDir("ns-emoji-proj-");
  const post = (path: string, body: unknown, method = "POST") => srv.call(path, { method, body }).then((r) => r.json());
  await post("/api/projects/open", { path: proj });
  const res = await post(
    "/api/board",
    {
      project: proj,
      columns: [
        { name: "A", type: "inert", emoji: "  ✅ ok" },
        { name: "B", type: "inert", emoji: "" },
        { name: "C", type: "inert", emoji: 7 },
        { id: "col_done", name: "Done", type: "inert", emoji: "🏁" },
      ],
    },
    "PUT",
  );
  const cols = res.board.columns;
  expect(cols[0].emoji).toBe("✅");
  expect("emoji" in cols[1]).toBe(false);
  expect("emoji" in cols[2]).toBe(false);
  expect(cols[3].emoji).toBe("🏁");
});

test("glyph-render", () => {
  const withEmoji = renderToStaticMarkup(createElement(ColumnGlyph, { col: { type: "skill", emoji: "🚀" } }));
  expect(withEmoji).toContain("🚀");
  expect(withEmoji).toContain("col-emoji");
  expect(withEmoji).not.toContain("<svg");
  for (const emoji of [undefined, "  "]) {
    const html = renderToStaticMarkup(createElement(ColumnGlyph, { col: { type: "skill", emoji } }));
    expect(html).toContain("<svg");
    expect(html).toContain("col-skill");
  }
});
