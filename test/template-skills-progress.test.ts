import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS = join(import.meta.dir, "..", ".claude", "skills");
const dirs = readdirSync(SKILLS).filter((d) => d.startsWith("nightshift-"));

function stepsSection(md: string): string {
  const start = md.indexOf("\n## Steps\n");
  if (start < 0) return "";
  const rest = md.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  return next < 0 ? rest : rest.slice(0, next);
}

test("template-skills-emit-marker: every nightshift skill tells the agent to write the progress marker in its Steps", () => {
  expect(dirs.length).toBeGreaterThan(0);
  for (const dir of dirs) {
    const md = readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8");
    expect(md, dir).toContain("[nightshift-progress]");
    expect(stepsSection(md), dir).toContain("[nightshift-progress] N/M");
    // The template must not itself contain a real marker (digits), or it would be parsed as progress.
    expect(/^\s*\[nightshift-progress\]\s+\d+\/\d+/m.test(md), dir).toBe(false);
  }
});
