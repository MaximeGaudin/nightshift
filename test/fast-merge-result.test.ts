import { expect, test } from "bun:test";

import { parseResultFields } from "../src/server/fastMerge.ts";

const note = (result: string, extra = "") => `## Brief\n\nx\n\n## Result\n\n${result}\n\n## Screenshots\n\nnone\n${extra}`;

test("parseResultFields reads real Result lines", () => {
  const r = parseResultFields(
    note(
      [
        "- Worktree: `/private/var/folders/T/tmp.abc`",
        "- Branch: nightshift/card_1",
        "- Base: main at abc1234",
        "- Commits: a1b2c3d, e4f5a6b (fix), `0123456789abcdef0123456789abcdef01234567`",
      ].join("\n"),
    ),
  );
  expect(r).toEqual({
    worktree: "/private/var/folders/T/tmp.abc",
    base: "main",
    baseSha: "abc1234",
    commits: ["a1b2c3d", "e4f5a6b", "0123456789abcdef0123456789abcdef01234567"],
  });
});

test("parseResultFields reads Worktree: none with its commits", () => {
  const r = parseResultFields(note("- Worktree: none (policy forbidden)\n- Base: WIP at 1111111\n- Commits: 2222222, 3333333"));
  expect(r).toEqual({ worktree: "none", base: "WIP", baseSha: "1111111", commits: ["2222222", "3333333"] });
});

test("parseResultFields refuses what it cannot trust", () => {
  const cases = [
    note("- Worktree: /tmp/x\n- Base: detached at abc1234\n- Commits: abc1234"),
    note("- Worktree: /tmp/x\n- Commits: abc1234"),
    note("- Worktree: /tmp/x\n- Base: nightshift/card_2 at abc1234"),
    note("- Base: main at abc1234"),
    note("- Worktree: none\n- Base: main at abc1234"),
    note("- Worktree: /tmp/x\n- Base: main at abc1234", "\n## Merge\n\n- Into: main\n"),
    "## Brief\n\nno result yet",
  ];
  for (const c of cases) expect("missing" in parseResultFields(c)).toBe(true);
});
