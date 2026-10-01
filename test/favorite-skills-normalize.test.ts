import { expect, test } from "bun:test";
import { normalizeBoard } from "../src/server/store.ts";

test("favorite-skills-normalize keeps valid unique names in order", () => {
  expect(normalizeBoard({ favoriteSkills: ["b", "a", "a", "", 3, " c "] }, "p").favoriteSkills).toEqual(["b", "a", "c"]);
});

test("favorite-skills-normalize drops empty or invalid values", () => {
  expect("favoriteSkills" in normalizeBoard({ favoriteSkills: [] }, "p")).toBe(false);
  expect("favoriteSkills" in normalizeBoard({ favoriteSkills: ["", 1] }, "p")).toBe(false);
  expect("favoriteSkills" in normalizeBoard({ favoriteSkills: "a" }, "p")).toBe(false);
});

test("favorite-skills-normalize preserves unknown board fields", () => {
  const b = normalizeBoard({ favoriteSkills: ["a"], custom: { x: 1 } }, "p") as unknown as Record<string, unknown>;
  expect(b.custom).toEqual({ x: 1 });
  expect(b.favoriteSkills).toEqual(["a"]);
});
