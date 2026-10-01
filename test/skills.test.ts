import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Private module instance (query string = distinct cache key) bound to our own user-skills dir, so other test
// files that set NIGHTSHIFT_USER_SKILLS before importing skills.ts are unaffected.
const previousUserSkills = process.env.NIGHTSHIFT_USER_SKILLS;
process.env.NIGHTSHIFT_USER_SKILLS = mkdtempSync(join(tmpdir(), "ns-skills-user-"));
const { createSkill, listSkills, parseFrontmatter, skillsDir } = await import("../src/server/skills.ts?skills-test");
if (previousUserSkills === undefined) delete process.env.NIGHTSHIFT_USER_SKILLS;
else process.env.NIGHTSHIFT_USER_SKILLS = previousUserSkills;

const userCreated: string[] = [];
afterAll(() => {
  for (const dir of userCreated) rmSync(dir, { recursive: true, force: true });
});

const tmp = () => mkdtempSync(join(tmpdir(), "ns-skills-"));

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
  userCreated.push(join(userDir, shared), join(userDir, unique));
  writeSkill(userDir, shared, "---\ndescription: user version\n---\n");
  writeSkill(userDir, unique, "---\ndescription: user only\n---\n");
  writeSkill(skillsDir("project", project), shared, "---\ndescription: project version\n---\n");
  const list = listSkills(project);
  expect(list.find((s) => s.name === shared)?.scope).toBe("project");
  expect(list.find((s) => s.name === shared)?.description).toBe("project version");
  expect(list.find((s) => s.name === unique)?.scope).toBe("user");
});
