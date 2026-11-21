import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

const references = (dir: string) => {
  const refDir = join(SKILLS, dir, "references");
  return existsSync(refDir) ? readdirSync(refDir).map((f) => readFileSync(join(refDir, f), "utf8")) : [];
};

test("template-skills-no-common-block: no column skill repeats a rule the prompt carries", () => {
  expect(COLUMN_SKILLS.length).toBe(5);
  for (const dir of COLUMN_SKILLS) {
    for (const md of [read(dir), ...references(dir)])
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

// Rare cases live in references/, read on demand: only the SKILL.md counts against these caps.
const SKILL_CAPS: Record<string, number> = { "nightshift-implement": 10_496, "nightshift-review": 7_296 };

test("template-skills-on-demand: implement and review stay small and point at their references", () => {
  for (const [dir, cap] of Object.entries(SKILL_CAPS)) {
    const md = read(dir);
    expect(Buffer.byteLength(md), dir).toBeLessThanOrEqual(cap);
    for (const ref of ["references/ui-cards.md", "references/no-worktree.md"]) {
      expect(md.includes(ref), `${dir}: ${ref}`).toBe(true);
      expect(existsSync(join(SKILLS, dir, ref)), `${dir}: ${ref} exists`).toBe(true);
    }
    // A reference must stand alone: it never sends the agent to another skill.
    for (const text of references(dir)) expect(text.includes("nightshift-review`'s"), dir).toBe(false);
  }
});

test("template-skills-merge-cap: nightshift-merge stays under 6 KB and points at its full procedure", () => {
  const md = read("nightshift-merge");
  expect(Buffer.byteLength(md)).toBeLessThanOrEqual(6_144);
  expect(md.includes("references/full-merge.md")).toBe(true);
  expect(existsSync(join(SKILLS, "nightshift-merge", "references", "full-merge.md"))).toBe(true);
  for (const f of ["pull-requests.md", "references/no-worktree.md"]) expect(md.includes(f), f).toBe(true);
  for (const line of ["- Into:", "- Test environment:", "- Merge commit:", "- Pushed:", "- Worktree removed:", "- Card branch deleted:"])
    expect(md.includes(line), line).toBe(true);
});

test("template-skills-capture-once: only review captures when it remains, implement defers", () => {
  const impl = read("nightshift-implement");
  expect(impl).toContain("Deferred to review.");
  expect(impl).toContain("no `nightshift-review` column remains in `Card path`");
  const reviewRef = references("nightshift-review").join("\n");
  expect(reviewRef).toContain("Review captures, once");
});

test("template-skills-baseline-on-demand: no base run before the change, only failing tests re-run on the base", () => {
  const impl = read("nightshift-implement");
  expect(impl).toContain("No base run before implementing");
  expect(impl).toContain("re-run only those on the base SHA");
  expect(impl).toContain("Baseline:");
  expect(impl).toContain("failing:");
});

test("template-skills-project-playwright: the project's Playwright comes before npx", () => {
  for (const dir of ["nightshift-implement", "nightshift-review"]) {
    const ref = references(dir).join("\n");
    const local = ref.indexOf("node_modules/.bin/playwright");
    const bunx = ref.indexOf("bunx playwright");
    const npx = ref.indexOf("npx --yes playwright");
    expect(local, dir).toBeGreaterThanOrEqual(0);
    expect(bunx, dir).toBeGreaterThan(local);
    expect(npx, dir).toBeGreaterThan(bunx);
  }
});
