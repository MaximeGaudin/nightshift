import { randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Template skills shipped with Nightshift, copied into every new project. They live in this repository's own
 * `.claude/skills`, so the same files are the skills Nightshift runs on itself. Overridable for tests.
 */
export const TEMPLATE_SKILLS_DIR = process.env.NIGHTSHIFT_TEMPLATE_SKILLS ?? join(import.meta.dir, "..", "..", ".claude", "skills");

export interface TemplateCopyResult {
  copied: string[];
  skipped: string[];
  failed: string[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function templateNames(): string[] {
  try {
    return readdirSync(TEMPLATE_SKILLS_DIR, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
      .map((e) => e.name)
      .filter((name) => existsSync(join(TEMPLATE_SKILLS_DIR, name, "SKILL.md")))
      .sort();
  } catch (e) {
    console.warn(`[nightshift] template skills unreadable (${TEMPLATE_SKILLS_DIR}): ${message(e)}`);
    return [];
  }
}

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Copies each template skill into `<project>/.claude/skills/<name>`. An existing entry is never touched. Each
 * skill is copied to a sibling temp folder then renamed, so a failure never leaves a partial skill. Never throws.
 */
export function copyTemplateSkills(projectPath: string): TemplateCopyResult {
  const result: TemplateCopyResult = { copied: [], skipped: [], failed: [] };
  const target = join(projectPath, ".claude", "skills");
  for (const name of templateNames()) {
    const dest = join(target, name);
    if (exists(dest)) {
      result.skipped.push(name);
      continue;
    }
    const tmp = join(target, `.${name}.tmp-${randomBytes(6).toString("hex")}`);
    try {
      mkdirSync(dirname(tmp), { recursive: true });
      cpSync(join(TEMPLATE_SKILLS_DIR, name), tmp, { recursive: true, dereference: true, errorOnExist: true });
      renameSync(tmp, dest);
      result.copied.push(name);
    } catch (e) {
      console.warn(`[nightshift] template skill "${name}" not copied: ${message(e)}`);
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {}
      result.failed.push(name);
    }
  }
  return result;
}
