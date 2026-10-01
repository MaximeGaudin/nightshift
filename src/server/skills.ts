import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillInfo } from "../shared/types.ts";

const USER_SKILLS = process.env.NIGHTSHIFT_USER_SKILLS ?? join(homedir(), ".claude", "skills");
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function skillsDir(scope: "project" | "user", projectPath: string) {
  return scope === "project" ? join(projectPath, ".claude", "skills") : USER_SKILLS;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded === "string") return decoded;
    } catch {}
  } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

/** Minimal frontmatter parser: handles `key: value` and folded/literal (`>` / `|`) blocks. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i]!.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]!) || lines[i + 1] === "")) {
        block.push(lines[++i]!.trim());
      }
      value = block.join(value.startsWith(">") ? " " : "\n").trim();
    }
    out[kv[1]!] = unquote(value);
  }
  return out;
}

function scan(dir: string, scope: SkillInfo["scope"]): SkillInfo[] {
  if (!existsSync(dir)) return [];
  const out: SkillInfo[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const file = join(dir, entry, "SKILL.md");
    try {
      if (!statSync(join(dir, entry)).isDirectory() || !existsSync(file)) continue;
      const fm = parseFrontmatter(readFileSync(file, "utf8"));
      out.push({ name: fm.name || entry, description: fm.description ?? "", scope, path: file });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Project skills shadow user skills with the same name (same rule as Claude Code). */
export function listSkills(projectPath: string): SkillInfo[] {
  const project = scan(skillsDir("project", projectPath), "project");
  const names = new Set(project.map((s) => s.name));
  return [...project, ...scan(skillsDir("user", projectPath), "user").filter((s) => !names.has(s.name))];
}

export function findSkill(projectPath: string, name: string): SkillInfo | undefined {
  return listSkills(projectPath).find((s) => s.name === name);
}

export function readSkill(projectPath: string, name: string) {
  const skill = findSkill(projectPath, name);
  if (!skill) throw new Error(`Skill not found: ${name}`);
  return { ...skill, content: readFileSync(skill.path, "utf8") };
}

export function saveSkill(projectPath: string, name: string, content: string) {
  const skill = findSkill(projectPath, name);
  if (!skill) throw new Error(`Skill not found: ${name}`);
  writeFileSync(skill.path, content);
  return skill;
}

export function createSkill(projectPath: string, name: string, description: string, body: string) {
  if (!NAME_RE.test(name)) throw new Error("Skill name must be lowercase letters, digits and dashes");
  const dir = join(skillsDir("project", projectPath), name);
  if (existsSync(join(dir, "SKILL.md"))) throw new Error(`Skill already exists: ${name}`);
  mkdirSync(dir, { recursive: true });
  const desc = description.replace(/\s+/g, " ").trim() || `Nightshift skill ${name}.`;
  const content = `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body.trim() || `# ${name}\n\nDescribe what to do with the card.`}\n`;
  writeFileSync(join(dir, "SKILL.md"), content);
  return findSkill(projectPath, name)!;
}
