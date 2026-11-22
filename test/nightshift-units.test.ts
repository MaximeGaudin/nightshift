import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column, Settings } from "../src/shared/types.ts";
import { must, settingsGlobal, tempDir } from "./helpers.ts";
import { nightshiftEnv } from "./nightshift-helpers.ts";

nightshiftEnv();
const { parseFrontmatter, listSkills, createSkill, skillsDir } = await import("../src/server/skills.ts");
const { resolveModel, splitArgs } = await import("../src/server/orchestrator.ts");
const { defaultBoard, needsRun, normalizeBoard } = await import("../src/server/store.ts");
const { updateSettings, NIGHTSHIFT_HOME } = await import("../src/server/settings.ts");
const home = NIGHTSHIFT_HOME;
const userSkills = skillsDir("user", "");
const { columnMaxParallel } = await import("../src/shared/types.ts");

test("parseFrontmatter handles folded descriptions", () => {
  const fm = parseFrontmatter("---\nname: x\ndescription: >\n  hello\n  world\n---\nbody");
  expect(fm).toEqual({ name: "x", description: "hello world" });
});

test("splitArgs honours quotes", () => {
  expect(splitArgs(`--allowedTools "Bash(git *)" --x 'a b' c`)).toEqual(["--allowedTools", "Bash(git *)", "--x", "a b", "c"]);
});

test("needsRun logic", () => {
  const b = normalizeBoard(
    {
      columns: [
        { id: "a", name: "A", type: "skill", skill: "s" },
        { id: "b", name: "B", type: "inert" },
      ],
      cards: [],
    },
    "x",
  );
  const card = { id: "c", columnId: "a", enteredColumnAt: "2026-01-01T00:00:00Z", history: [] } as unknown as Card;
  expect(needsRun(b, card)).toBe(true);
  card.lastRun = { columnId: "a", status: "success", at: "2026-01-01T00:00:01Z" };
  expect(needsRun(b, card)).toBe(false);
  card.enteredColumnAt = "2026-01-01T00:00:02Z";
  expect(needsRun(b, card)).toBe(true);
  card.columnId = "b";
  expect(needsRun(b, card)).toBe(false);
});

test("normalizeBoard keeps a trimmed model and drops empty ones", () => {
  const b = normalizeBoard(
    {
      columns: [
        { id: "a", name: "A", type: "skill", skill: "s", model: " sonnet " },
        { id: "b", name: "B", type: "skill", skill: "s", model: "   " },
        { id: "c", name: "C", type: "inert" },
      ],
      cards: [],
    },
    "x",
  );
  expect(b.columns[1].model).toBe("sonnet");
  expect("model" in b.columns[2]).toBe(false);
  expect("model" in b.columns[3]).toBe(false);
});

test("resolveModel priority", () => {
  const col = (model?: string): Column => ({ id: "a", name: "A", type: "skill", skill: "s", ...(model ? { model } : {}) });
  const settings = (model: string): Settings => ({
    claudePath: "claude",
    permissionMode: "auto",
    model,
    extraArgs: "",
    recentProjects: [],
    soundNotifications: true,
    language: "auto",
  });
  expect(resolveModel(col("opus"), settings("sonnet")).model).toBe("opus");
  expect(resolveModel(col(), settings(" sonnet ")).model).toBe("sonnet");
  expect(resolveModel(col(), settings("")).model).toBeUndefined();
});

test("project skills shadow user skills", () => {
  const proj = tempDir("ns-proj-");
  mkdirSync(join(userSkills, "dup"), { recursive: true });
  writeFileSync(join(userSkills, "dup", "SKILL.md"), "---\nname: dup\ndescription: user\n---\n");
  createSkill(proj, "dup", "project one", "body");
  const dup = listSkills(proj).filter((s) => s.name === "dup");
  expect(dup).toHaveLength(1);
  expect(dup[0].scope).toBe("project");
  expect(() => createSkill(proj, "Bad Name", "", "")).toThrow();
});

test("columnMaxParallel default", () => {
  expect(columnMaxParallel({})).toBe(1);
  expect(columnMaxParallel({ maxParallel: 5 })).toBe(5);
});

test("prompt: includes card ref", async () => {
  const { buildPrompt } = await import("../src/server/orchestrator.ts");
  const column = { id: "col", name: "Work", type: "skill" as const, skill: "s" };
  const card = {
    id: "card_abc",
    number: 32,
    title: "T",
    description: "D",
    columnId: "col",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    enteredColumnAt: "2026-01-01T00:00:00Z",
    history: [],
  };
  const board = { version: 1 as const, name: "x", columns: [column], cards: [card], nextCardNumber: 33 };
  expect(buildPrompt(board, card, column, undefined)).toContain(`<card id="card_abc" ref="#32">`);
});

test("settings: soundNotifications defaults to true and persists", async () => {
  const { getSettings } = await import("../src/server/settings.ts");
  const file = join(home, "settings.json");
  const old = { maxParallel: 2, claudePath: "claude", permissionMode: "auto", model: "", extraArgs: "", recentProjects: [] };
  writeFileSync(file, JSON.stringify(old));
  must(settingsGlobal().__nightshiftSettings).current = null;
  expect(getSettings().soundNotifications).toBe(true);
  writeFileSync(file, JSON.stringify({ ...old, soundNotifications: "true" }));
  must(settingsGlobal().__nightshiftSettings).current = null;
  expect(getSettings().soundNotifications).toBe(true);
  updateSettings({ soundNotifications: false });
  expect(JSON.parse(readFileSync(file, "utf8")).soundNotifications).toBe(false);
  expect(readFileSync(file, "utf8")).toContain('"soundNotifications": false');
  updateSettings({ soundNotifications: null as unknown as boolean });
  expect(JSON.parse(readFileSync(file, "utf8")).soundNotifications).toBe(true);
});

test("auto fresh session is the default of the default board's skill columns only", () => {
  const skills = defaultBoard("x").columns.filter((c) => c.type === "skill");
  expect(skills.length).toBe(5);
  for (const c of skills) expect(c.freshSession).toBe("auto");
  const loaded = normalizeBoard({ columns: [{ id: "a", name: "A", type: "skill", skill: "s" }], cards: [] }, "x");
  expect(loaded.columns.find((c) => c.id === "a")?.freshSession).toBeUndefined();
});
