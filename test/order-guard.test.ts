import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { removeTempDirs, tempDir } from "./helpers.ts";

// Minimal reproduction for test-order.test.ts, which runs it after progress-prompts.test.ts in a child `bun test`.
// settings.ts and skills.ts capture NIGHTSHIFT_HOME and NIGHTSHIFT_USER_SKILLS at their first import: when another
// file imported them first, the variables set below are ignored. A file that writes or reads through the paths it
// set (instead of the paths read back from the modules) then misses its own settings and user skills. This is the
// pattern the nightshift-*.test.ts files follow; it only runs in that child, so the main suite does not run it twice.
if (process.env.ORDER_GUARD_CHILD === "1") {
  process.env.NIGHTSHIFT_HOME = tempDir("ns-guard-home-");
  process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-guard-skills-");
  const { updateSettings, NIGHTSHIFT_HOME } = await import("../src/server/settings.ts");
  const { listSkills, skillsDir } = await import("../src/server/skills.ts");
  const home = NIGHTSHIFT_HOME;
  const userSkills = skillsDir("user", "");

  test("order-guard-paths: settings and user skills land in the directories the modules use", () => {
    for (const dir of [home, userSkills]) expect(dir.startsWith(join(homedir(), "."))).toBe(false);
    updateSettings({ claudePath: "/order-guard/fake-claude" });
    expect(readFileSync(join(home, "settings.json"), "utf8")).toContain("/order-guard/fake-claude");
    mkdirSync(join(userSkills, "guard"), { recursive: true });
    writeFileSync(join(userSkills, "guard", "SKILL.md"), "---\nname: guard\ndescription: test\n---\n");
    const project = tempDir("ns-guard-proj-");
    expect(listSkills(project).map((s) => s.name)).toContain("guard");
    removeTempDirs();
  });
}
