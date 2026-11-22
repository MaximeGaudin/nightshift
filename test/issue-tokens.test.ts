import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keepSettingsGlobal, removeTempDirs, settingsGlobal, tempDir } from "./helpers.ts";

const prevHome = process.env.NIGHTSHIFT_HOME;
const keptSettings = keepSettingsGlobal();
let n = 0;

// settings.ts reads NIGHTSHIFT_HOME at import; a unique query string gives each case a fresh module instance.
async function load() {
  const home = tempDir("ns-tokens-");
  process.env.NIGHTSHIFT_HOME = home;
  settingsGlobal().__nightshiftSettings = undefined;
  try {
    return { home, mod: await import(`../src/server/settings.ts?tokens=${++n}`) };
  } finally {
    keptSettings.restore();
    if (prevHome === undefined) delete process.env.NIGHTSHIFT_HOME;
    else process.env.NIGHTSHIFT_HOME = prevHome;
  }
}

afterAll(() => {
  keptSettings.restore();
  removeTempDirs();
});

test("token-store-isolation", async () => {
  const { home, mod } = await load();
  const file = join(home, "settings.json");
  mod.setIssueToken("github:api.github.com", "secret-token-1");
  expect(mod.getIssueToken("github:api.github.com")).toBe("secret-token-1");
  expect(mod.hasIssueToken("gitea:x")).toBe(false);
  mod.updateSettings({ model: "x" });
  const raw = JSON.parse(readFileSync(file, "utf8"));
  expect(raw.issueTokens).toEqual({ "github:api.github.com": "secret-token-1" });
  expect(raw.model).toBe("x");
  const settings = mod.getSettings();
  expect("issueTokens" in settings).toBe(false);
  expect(JSON.stringify({ type: "settings", settings })).not.toContain("secret-token-1");
  // Reload from disk: the token survives and the model too.
  settingsGlobal().__nightshiftSettings = undefined;
  expect(mod.getIssueToken("github:api.github.com")).toBe("secret-token-1");
  expect(mod.getSettings().model).toBe("x");
  mod.setIssueToken("github:api.github.com", "");
  expect(mod.hasIssueToken("github:api.github.com")).toBe(false);
  expect(JSON.parse(readFileSync(file, "utf8")).issueTokens).toBeUndefined();
  expect(JSON.parse(readFileSync(file, "utf8")).model).toBe("x");
});

test("token-store-read-only", async () => {
  const { home, mod } = await load();
  mod.setSettingsReadOnly(true);
  mod.setIssueToken("gitea:g", "t");
  expect(mod.getIssueToken("gitea:g")).toBe("t");
  expect(() => readFileSync(join(home, "settings.json"), "utf8")).toThrow();
  mod.setSettingsReadOnly(false);
});
