import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CompactColumnBand, compactColumnTitle, isCompactColumn } from "../src/web/compactColumn.tsx";
import type { Column } from "../src/shared/types.ts";

test("compact-rule", () => {
  expect(isCompactColumn(0, false)).toBe(true);
  expect(isCompactColumn(0, true)).toBe(false);
  expect(isCompactColumn(1, false)).toBe(false);
  expect(isCompactColumn(1, true)).toBe(false);
});

test("compact-title-skill", () => {
  const col: Column = { id: "c1", name: "Implement", type: "skill", skill: "nightshift-implement", model: "opus" };
  expect(compactColumnTitle(col)).toBe("Implement — skill : nightshift-implement — modèle : opus — 0/1 agents");
});

test("compact-title-no-model-no-skill", () => {
  const col: Column = { id: "c2", name: "Review", type: "skill", skill: "", maxParallel: 2 };
  expect(compactColumnTitle(col)).toBe("Review — skill : aucun skill — 0/2 agents");
});

test("compact-title-inert", () => {
  const col: Column = { id: "c3", name: "Backlog", type: "inert" };
  expect(compactColumnTitle(col)).toBe("Backlog — inerte");
});

test("compact-band-markup", () => {
  const col: Column = { id: "c1", name: "Implement", type: "skill", skill: "x", maxParallel: 3 };
  const html = renderToStaticMarkup(<CompactColumnBand col={col} onAdd={() => {}} />);
  const marks = ['class="column-band"', 'class="count">0<', 'class="band-add ghost"', 'aria-label="Ajouter une fiche"', 'class="band-name">Implement<'];
  const idx = marks.map((m) => html.indexOf(m));
  expect(idx.every((i) => i >= 0)).toBe(true);
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  expect(html).not.toContain("badge");
  expect(html).not.toContain("column-parallel");
});

test("compact-band-emoji", () => {
  const col: Column = { id: "c1", name: "Test", type: "skill", skill: "x", emoji: "🧪" };
  const html = renderToStaticMarkup(<CompactColumnBand col={col} onAdd={() => {}} />);
  expect(html).toContain("🧪");
  expect(html).not.toContain('<svg class="col-icon');
});

test("compact-band-no-emoji", () => {
  const skill: Column = { id: "c1", name: "A", type: "skill", skill: "x" };
  const inert: Column = { id: "c2", name: "B", type: "inert" };
  expect(renderToStaticMarkup(<CompactColumnBand col={skill} onAdd={() => {}} />)).toContain("col-icon col-skill");
  expect(renderToStaticMarkup(<CompactColumnBand col={inert} onAdd={() => {}} />)).toContain("col-icon col-inert");
});

test("compact-title-emoji", () => {
  const col: Column = { id: "c3", name: "Backlog", type: "inert", emoji: "📥" };
  expect(compactColumnTitle(col)).toBe("📥 Backlog — inerte");
});
