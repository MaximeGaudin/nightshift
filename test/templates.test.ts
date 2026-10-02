import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChildServer, removeTempDirs, startChildServer, tempDir } from "./helpers.ts";

const REPO_SKILLS = join(import.meta.dir, "..", ".claude", "skills");
const NAMES = ["nightshift-grill", "nightshift-implement", "nightshift-merge", "nightshift-plan", "nightshift-review", "nightshift-submit"];

let srv: ChildServer;
beforeAll(async () => {
  srv = await startChildServer({ env: { NIGHTSHIFT_TEMPLATE_SKILLS: REPO_SKILLS } });
});
afterAll(async () => {
  await srv.stop();
  removeTempDirs();
});

const open = (path: string) => srv.call("/api/projects/open", { body: { path } }).then((r) => r.json());
const skillFile = (dir: string, name: string) => join(dir, ".claude", "skills", name, "SKILL.md");

test("templates-copy-new-project", async () => {
  const dir = tempDir("ns-tpl-new-");
  const snap = await open(dir);
  expect(existsSync(join(dir, "nightshift.json"))).toBe(true);
  expect(snap.templateSkillsNotCopied).toBeUndefined();
  for (const name of NAMES) {
    expect(readFileSync(skillFile(dir, name)).equals(readFileSync(join(REPO_SKILLS, name, "SKILL.md")))).toBe(true);
  }
  expect(readdirSync(join(dir, ".claude", "skills")).sort()).toEqual(NAMES);
});

test("templates-keep-user-folder", async () => {
  const dir = tempDir("ns-tpl-keep-");
  mkdirSync(join(dir, ".claude", "skills", "nightshift-grill"), { recursive: true });
  writeFileSync(skillFile(dir, "nightshift-grill"), "custom grill\n");
  await open(dir);
  expect(readFileSync(skillFile(dir, "nightshift-grill"), "utf8")).toBe("custom grill\n");
  for (const name of NAMES.filter((n) => n !== "nightshift-grill")) expect(existsSync(skillFile(dir, name))).toBe(true);
});

test("templates-no-copy-existing", async () => {
  const dir = tempDir("ns-tpl-existing-");
  writeFileSync(join(dir, "nightshift.json"), JSON.stringify({ version: 1, name: "x", columns: [], cards: [] }));
  await open(dir);
  await open(dir);
  expect(existsSync(join(dir, ".claude", "skills"))).toBe(false);
});

test.skipIf(process.getuid?.() === 0)("templates-copy-failure", async () => {
  const dir = tempDir("ns-tpl-fail-");
  const skills = join(dir, ".claude", "skills");
  mkdirSync(skills, { recursive: true });
  chmodSync(skills, 0o555);
  try {
    const first = await open(dir);
    expect(existsSync(join(dir, "nightshift.json"))).toBe(true);
    expect(readdirSync(skills)).toEqual([]);
    expect([...first.templateSkillsNotCopied].sort()).toEqual(NAMES);
    const second = await open(dir);
    expect(second.templateSkillsNotCopied).toBeUndefined();
  } finally {
    chmodSync(skills, 0o755);
  }
});
