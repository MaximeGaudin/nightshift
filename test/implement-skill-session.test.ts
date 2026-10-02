import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../src/server/skills.ts";

const text = readFileSync(join(import.meta.dir, "..", ".claude", "skills", "nightshift-implement", "SKILL.md"), "utf8");

const section = (title: string, until?: string) => {
  const start = text.indexOf(`\n## ${title}\n`);
  expect(start).toBeGreaterThan(-1);
  const end = until ? text.indexOf(`\n## ${until}\n`, start) : -1;
  return text.slice(start, end === -1 ? undefined : end);
};

test("implement-skill-one-worktree", () => {
  expect(text.split("git worktree add").length - 1).toBe(1);
  expect(text).not.toContain("<task-slug>");
  expect(text).not.toContain("git merge --no-edit");
  expect(text).not.toContain("git worktree remove");
});

test("implement-skill-session-transport", () => {
  for (const needle of ["SendMessage", "select:SendMessage", "--output-format json", "--resume"]) expect(text).toContain(needle);
  expect(text.toLowerCase()).not.toContain("one agent per");
  expect(text.toLowerCase()).not.toContain("parallel agents");
});

test("implement-skill-reporting", () => {
  const fm = parseFrontmatter(text);
  expect(fm.name).toBe("nightshift-implement");
  expect(fm.description.toLowerCase()).not.toContain("one agent per parallel task");
  const result = section("Result", "Output");
  expect(result).toContain("Tasks done:");
  expect(result).toContain("one agent session");
  expect(result).not.toContain("Tasks merged");
  const done = section("Done when");
  expect(done).toContain("Every task ran in the same agent session, in this run's worktree");
  expect(done).not.toContain("Agent count");
});
