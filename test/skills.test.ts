import { afterAll, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTempDirs, tempDir } from "./helpers.ts";

// Private module instance (query string = distinct cache key) bound to our own user-skills dir, so other test
// files that set NIGHTSHIFT_USER_SKILLS before importing skills.ts are unaffected.
const previousUserSkills = process.env.NIGHTSHIFT_USER_SKILLS;
process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-skills-user-");
const { createSkill, listSkills, parseFrontmatter, saveSkill, skillsDir } = await import("../src/server/skills.ts?skills-test");
if (previousUserSkills === undefined) delete process.env.NIGHTSHIFT_USER_SKILLS;
else process.env.NIGHTSHIFT_USER_SKILLS = previousUserSkills;

afterAll(removeTempDirs);

const tmp = () => tempDir("ns-skills-");

function writeSkill(root: string, name: string, content: string) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), content);
}

test("skills-roundtrip", () => {
  const project = tmp();
  const desc = 'say "hi" \\ ok';
  createSkill(project, "demo", desc, "# Demo");
  const found = listSkills(project).find((s) => s.name === "demo");
  expect(found?.description).toBe(desc);
  expect(found?.scope).toBe("project");
});

test("skills-frontmatter-legacy", () => {
  expect(parseFrontmatter("no frontmatter")).toEqual({});
  expect(parseFrontmatter("---\nname: a\ndescription: it's plain\n---\nbody")).toEqual({
    name: "a",
    description: "it's plain",
  });
  expect(parseFrontmatter("---\ndescription: 'single quoted'\n---")).toEqual({ description: "single quoted" });
  expect(parseFrontmatter('---\ndescription: "double quoted"\n---')).toEqual({ description: "double quoted" });
  expect(parseFrontmatter("---\ndescription: >\n  folded\n  text\n---")).toEqual({ description: "folded text" });
  expect(parseFrontmatter("---\ndescription: |\n  line one\n  line two\n---")).toEqual({
    description: "line one\nline two",
  });
  expect(parseFrontmatter("---\r\nname: crlf\r\ndescription: win\r\n---\r\nbody")).toEqual({
    name: "crlf",
    description: "win",
  });
});

test("skills-single-quote-escape", () => {
  expect(parseFrontmatter("---\ndescription: 'it''s'\n---")).toEqual({ description: "it's" });
});

test("skills-invalid-double-quote-fallback", () => {
  expect(parseFrontmatter('---\ndescription: "bad \\q escape"\n---')).toEqual({ description: "bad \\q escape" });
});

test("skills-project-shadows-user", () => {
  const project = tmp();
  writeSkill(skillsDir("project", project), "shared", "---\ndescription: project one\n---\n");
  const userDir = skillsDir("user", project);
  const unique = `user-only-${Date.now()}`;
  const shared = `shared-${Date.now()}`;
  writeSkill(userDir, shared, "---\ndescription: user version\n---\n");
  writeSkill(userDir, unique, "---\ndescription: user only\n---\n");
  writeSkill(skillsDir("project", project), shared, "---\ndescription: project version\n---\n");
  const list = listSkills(project);
  expect(list.find((s) => s.name === shared)?.scope).toBe("project");
  expect(list.find((s) => s.name === shared)?.description).toBe("project version");
  expect(list.find((s) => s.name === unique)?.scope).toBe("user");
});

test("skills-save-atomic: saveSkill replaces the file through a rename and leaves no .tmp", () => {
  const project = tmp();
  createSkill(project, "atomic", "d", "# first");
  const file = join(skillsDir("project", project), "atomic", "SKILL.md");
  // A second name for the old inode: a rename leaves it untouched, an in-place write would change it too.
  const old = join(project, "old-inode");
  linkSync(file, old);
  const content = `---\nname: atomic\ndescription: "d"\n---\n\n${"x".repeat(100_000)}\n`;
  saveSkill(project, "atomic", content);
  expect(readFileSync(file, "utf8")).toBe(content);
  expect(readFileSync(old, "utf8")).toContain("# first");
  expect(readdirSync(join(skillsDir("project", project), "atomic"))).toEqual(["SKILL.md"]);
  expect(existsSync(`${file}.tmp`)).toBe(false);
  expect(readdirSync(skillsDir("project", project))).toEqual(["atomic"]);
});
