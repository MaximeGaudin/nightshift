import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = (name: string) => readFileSync(join(import.meta.dir, "..", ".claude", "skills", name, "SKILL.md"), "utf8");

test("template-skills-worktree-policy: implement and merge describe the three policies", () => {
  const implement = skill("nightshift-implement");
  const merge = skill("nightshift-merge");
  for (const text of [implement, merge]) {
    expect(text).toContain("Worktree: none");
    expect(text).toContain("forbidden");
  }
  expect(implement).toContain("Worktree policy:");
  for (const policy of ["required", "auto", "forbidden"]) expect(implement).toContain(`\`${policy}\``);
  expect(merge).toContain("Decide from `## Result`");
  expect(merge).toContain("never `--force`");
});

test("template-skills-worktree-policy: review handles a card committed on the base without a worktree", () => {
  const review = skill("nightshift-review");
  expect(review).toContain("Worktree: none");
  expect(review).toContain("Skip the next two bullets");
});
