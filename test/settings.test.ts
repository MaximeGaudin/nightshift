import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "../src/shared/types.ts";
import { removeTempDirs, settingsGlobal, tempDir } from "./helpers.ts";

const prevHome = process.env.NIGHTSHIFT_HOME;
let n = 0;
let home = "";

// settings.ts reads NIGHTSHIFT_HOME at import; a unique query string gives each case a fresh module instance.
async function load(file?: string) {
  home = tempDir("ns-settings-");
  if (file !== undefined) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), file);
  }
  process.env.NIGHTSHIFT_HOME = home;
  settingsGlobal().__nightshiftSettings = undefined;
  try {
    return await import(`../src/server/settings.ts?case=${++n}`);
  } finally {
    if (prevHome === undefined) delete process.env.NIGHTSHIFT_HOME;
    else process.env.NIGHTSHIFT_HOME = prevHome;
  }
}

beforeEach(() => {
  settingsGlobal().__nightshiftSettings = undefined;
});

test("settings-reject", async () => {
  const { updateSettings, getSettings } = await load();
  const ok = updateSettings({ claudePath: "/bin/x" });
  const file = join(home, "settings.json");
  const before = readFileSync(file, "utf8");
  for (const bad of [
    { claudePath: 42 },
    { claudePath: "   " },
    { unknownKey: 1 },
    { recentProjects: "x" },
    { recentProjects: [1] },
    { model: 5 },
    { maxParallel: "abc" },
    { soundNotifications: "yes" },
    { permissionMode: "nope" },
  ]) {
    expect(() => updateSettings(bad as unknown as Partial<Settings>)).toThrow();
  }
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(getSettings()).toEqual(ok);
});

test("settings-clamp-max-parallel", async () => {
  const { updateSettings } = await load();
  expect(updateSettings({ maxParallel: 0 }).maxParallel).toBe(1);
  expect(updateSettings({ maxParallel: 999 }).maxParallel).toBe(32);
  expect(updateSettings({ maxParallel: 4.7 }).maxParallel).toBe(4);
});

test("settings-load-legacy", async () => {
  const { getSettings, DEFAULT_SETTINGS } = await load(
    JSON.stringify({ maxParallel: "abc", soundNotifications: "yes", model: 5, recentProjects: "x", extra: 1, claudePath: "/c" }),
  );
  const s = getSettings();
  expect(s).toEqual({ ...DEFAULT_SETTINGS, claudePath: "/c" });
});

test("settings-load-corrupt-keeps-backup", async () => {
  const { getSettings, updateSettings, DEFAULT_SETTINGS } = await load("{oops");
  expect(getSettings()).toEqual(DEFAULT_SETTINGS);
  expect(readFileSync(join(home, "settings.json.bak"), "utf8")).toBe("{oops");
  updateSettings({ model: "m" });
  expect(existsSync(join(home, "settings.json.bak"))).toBe(true);
});

afterAll(removeTempDirs);

test("settings-read-only: a --no-agents instance never writes the settings file", async () => {
  const original = `${JSON.stringify({ claudePath: "claude", maxParallel: 3, recentProjects: ["/real"] }, null, 2)}\n`;
  const { updateSettings, getSettings, rememberProject, setSettingsReadOnly } = await load(original);
  setSettingsReadOnly(true);
  updateSettings({ maxParallel: 7 });
  rememberProject("/tmp/nightshift-test-card_x");
  expect(getSettings().maxParallel).toBe(7);
  expect(getSettings().recentProjects).toEqual(["/real"]);
  expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(original);
});

test("settings-test-guard: under bun test, a missing NIGHTSHIFT_HOME is refused", () => {
  const out = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(join(import.meta.dir, "../src/server/settings.ts"))})`], {
    env: { ...process.env, NIGHTSHIFT_HOME: "", NODE_ENV: "test" },
    stderr: "pipe",
  });
  expect(out.exitCode).not.toBe(0);
  expect(out.stderr.toString()).toContain("NIGHTSHIFT_HOME must be set");
});
