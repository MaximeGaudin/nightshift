import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS = join(import.meta.dir, "..", ".claude", "skills");
// Column skills run under the Nightshift prompt, which carries the shared rules once. nightshift-submit is not one.
const COLUMN_SKILLS = readdirSync(SKILLS).filter((d) => d.startsWith("nightshift-") && d !== "nightshift-submit");
const read = (dir: string) => readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8");

// Signature phrases of the blocks that moved to QUESTIONS_RULE, CARD_UPDATE_RULE and PROGRESS_RULE.
const COMMON_BLOCKS = [
  "Do not call `AskUserQuestion`",
  "## Updating the card",
  "byte for byte",
  "three blank lines",
  "Ask in two places",
  "[nightshift-progress] N/M",
  "Follow extra column instructions",
  "Return work only as Nightshift's structured result",
];

// 72 619 bytes before card #72, minus 25 %.
const SIZE_CAP = 54_464;

test("template-skills-no-common-block: no column skill repeats a rule the prompt carries", () => {
  expect(COLUMN_SKILLS.length).toBe(5);
  for (const dir of COLUMN_SKILLS) {
    const md = read(dir);
    for (const block of COMMON_BLOCKS) expect(md.includes(block), `${dir}: ${block}`).toBe(false);
  }
});

test("template-skills-one-output-example: each column skill keeps one JSON output example", () => {
  for (const dir of COLUMN_SKILLS) {
    const output = read(dir).split("\n## Output\n")[1]?.split("\n## ")[0] ?? "";
    expect(output.split("```json").length - 1, dir).toBe(1);
  }
});

test("template-skills-size-cap: the column skills stay under the size cap", () => {
  const total = COLUMN_SKILLS.reduce((sum, dir) => sum + Buffer.byteLength(read(dir)), 0);
  expect(total).toBeLessThanOrEqual(SIZE_CAP);
});
