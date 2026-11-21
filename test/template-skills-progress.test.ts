import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS = join(import.meta.dir, "..", ".claude", "skills");
// Column skills only: nightshift-submit is called from any chat or agent to add a card, never by a column run.
const NOT_COLUMN_SKILLS = ["nightshift-submit"];
const dirs = readdirSync(SKILLS).filter((d) => d.startsWith("nightshift-") && !NOT_COLUMN_SKILLS.includes(d));

function stepsSection(md: string): string {
  const start = md.indexOf("\n## Steps\n");
  if (start < 0) return "";
  const rest = md.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  return next < 0 ? rest : rest.slice(0, next);
}

test("template-skills-steps: every column skill has numbered Steps, leaves the marker rule to the prompt, and holds no real marker", () => {
  expect(dirs.length).toBeGreaterThan(0);
  for (const dir of dirs) {
    const md = readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8");
    expect(/^1\. /m.test(stepsSection(md)), dir).toBe(true);
    // The marker rule lives in PROGRESS_RULE (src/server/orchestrator.ts), which every column prompt carries.
    expect(md, dir).not.toContain("[nightshift-progress] N/M");
    // A real marker (digits) would be parsed as progress.
    expect(/^\s*\[nightshift-progress\]\s+\d+\/\d+/m.test(md), dir).toBe(false);
  }
});
