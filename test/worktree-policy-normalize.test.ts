import { expect, test } from "bun:test";
import { normalizeBoard } from "../src/server/store.ts";
import { worktreePolicyOf } from "../src/shared/types.ts";

test("worktree-policy-normalize keeps a valid non-default policy", () => {
  for (const policy of ["forbidden", "auto"] as const) {
    const b = normalizeBoard({ worktreePolicy: policy }, "p");
    expect(b.worktreePolicy).toBe(policy);
    expect(worktreePolicyOf(b)).toBe(policy);
  }
});

test("worktree-policy-normalize drops the default and invalid values", () => {
  for (const value of ["required", "banana", 42, null, ["auto"]]) {
    const b = normalizeBoard({ worktreePolicy: value }, "p");
    expect("worktreePolicy" in b).toBe(false);
    expect(worktreePolicyOf(b)).toBe("required");
  }
  expect("worktreePolicy" in normalizeBoard({}, "p")).toBe(false);
});
