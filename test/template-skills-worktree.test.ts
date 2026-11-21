import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = (name: string) => join(import.meta.dir, "..", ".claude", "skills", name);
const skill = (name: string) => readFileSync(join(dir(name), "SKILL.md"), "utf8");
const noWorktree = (name: string) => readFileSync(join(dir(name), "references", "no-worktree.md"), "utf8");

test("template-skills-worktree-policy: implement and merge describe the three policies", () => {
  const implement = skill("nightshift-implement");
  expect(implement).toContain("Worktree policy:");
  for (const policy of ["required", "auto", "forbidden"]) expect(implement).toContain(`\`${policy}\``);
  expect(implement).toContain("references/no-worktree.md");
  const rare = noWorktree("nightshift-implement");
  expect(rare).toContain("Worktree: none");
  expect(rare).toContain("`auto`");
  expect(rare).toContain("`forbidden`");
  const merge = skill("nightshift-merge");
  expect(merge).toContain("Worktree: none");
  expect(merge).toContain("references/no-worktree.md");
  const mergeRare = noWorktree("nightshift-merge");
  expect(mergeRare).toContain("Worktree: none");
  expect(mergeRare).toContain("Decide from `## Result`");
  expect(mergeRare).toContain("never `--force`");
});

test("template-skills-worktree-policy: review handles a card committed on the base without a worktree", () => {
  const review = skill("nightshift-review");
  expect(review).toContain("Worktree: none");
  expect(review).toContain("references/no-worktree.md");
  const rare = noWorktree("nightshift-review");
  expect(rare).toContain("Worktree: none");
  expect(rare).toContain("Skip the branch and worktree-recreation bullets");
});
