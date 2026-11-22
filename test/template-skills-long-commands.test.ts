import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = (name: string) => readFileSync(join(import.meta.dir, "..", ".claude", "skills", name, "SKILL.md"), "utf8");

test("skills-long-commands: implement and review start their tests in the background with a long timeout", () => {
  for (const name of ["nightshift-implement", "nightshift-review"]) {
    const text = skill(name);
    expect(text, name).toContain("`run_in_background: true` and an explicit `timeout`");
    expect(text, name).toContain("max 7200000");
    expect(text, name).toContain("wait for it inside your turn");
  }
});

test("skills-long-commands: the README recommends one parallel agent for the full-suite column", () => {
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
  expect(readme).toContain("should keep its parallel limit at 1");
  expect(readme).toContain("**Needs attention**");
});
