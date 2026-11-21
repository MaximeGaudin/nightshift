import { afterAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Column } from "../src/shared/types.ts";
import { FastMergeControls, fastMergePatch, movedBasePatch } from "../src/web/ColumnsEditor.tsx";
import { setLocale } from "../src/web/i18n/index.ts";

afterAll(() => setLocale("en"));

const render = (col: Column) => renderToStaticMarkup(<FastMergeControls col={{ ...col, key: col.id }} onPatch={() => {}} />);

test("columns editor fast-merge controls", () => {
  setLocale("fr");
  const merge = render({ id: "m", name: "Merge", type: "skill", skill: "nightshift-merge", fastMergeTestCommand: "bun run check" });
  expect(merge).toContain("Merge rapide sans agent");
  expect(merge).toContain("Quand la base a avancé");
  expect(merge).toContain("Merger puis lancer la commande de test");
  expect(merge).toContain('value="bun run check"');
  expect(merge).toContain("checked");

  expect(render({ id: "p", name: "Plan", type: "skill", skill: "nightshift-plan" })).toBe("");
  expect(render({ id: "i", name: "Inert", type: "inert", skill: "nightshift-merge" })).toBe("");

  // Off: the checkbox is unchecked and the command is disabled.
  const off = render({ id: "m", name: "Merge", type: "skill", skill: "nightshift-merge", fastMerge: false });
  expect(off).not.toMatch(/type="checkbox" checked/);
  expect(off).toMatch(/<input[^>]*disabled[^>]*fast-merge-command|fast-merge-command[^>]*disabled/);

  // Mode "agent": the test command is disabled.
  const agent = render({ id: "m", name: "Merge", type: "skill", skill: "nightshift-merge", fastMergeMovedBase: "agent" });
  expect(agent).toContain("Passer la main à l&#x27;agent");
  expect(agent).toMatch(/fast-merge-command[^>]*disabled|disabled[^>]*fast-merge-command/);
});

test("fast-merge patches never store defaults", () => {
  expect(fastMergePatch(false)).toEqual({ fastMerge: false });
  expect(fastMergePatch(true)).toEqual({ fastMerge: undefined });
  expect(movedBasePatch("test")).toEqual({ fastMergeMovedBase: undefined });
  expect(movedBasePatch("merge")).toEqual({ fastMergeMovedBase: "merge" });
  expect(movedBasePatch("agent")).toEqual({ fastMergeMovedBase: "agent" });
});
