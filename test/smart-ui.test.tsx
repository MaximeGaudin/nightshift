import { afterAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Settings } from "../src/shared/types.ts";
import { SMART_MODES, smartModeOf, smartModePatch } from "../src/web/ColumnsEditor.tsx";
import { getLocale, setLocale } from "../src/web/i18n/index.ts";
import { SettingsContent, saveSettingsAndProject, settingsDirty } from "../src/web/SettingsModal.tsx";

const startLocale = getLocale();
afterAll(() => setLocale(startLocale));

const base: Settings = {
  claudePath: "claude",
  permissionMode: "auto",
  model: "",
  effort: "",
  extraArgs: "",
  agentFeatures: {},
  smartMode: true,
  recentProjects: [],
  soundNotifications: false,
  language: "auto",
  carryMaxTokens: 80000,
  carryMaxAgeMinutes: 5,
  teamclaudeEnabled: false,
  teamclaudeUrl: "http://localhost:3456",
};
const render = (s: Settings) =>
  renderToStaticMarkup(<SettingsContent value={s} onChange={() => {}} currentProject={undefined} onOpenProject={() => {}} />);

test("settings-ui: smart toggle in French and English; the global features and effort say they are the fallback", () => {
  setLocale("fr");
  let html = render(base);
  expect(html).toContain("Mode smart");
  expect(html).toContain('id="set-smart-mode"');
  expect(html.match(/Utilisé quand le mode smart est désactivé ou échoue\./g)?.length).toBe(2);
  setLocale("en");
  html = render(base);
  expect(html).toContain("Smart mode");
  expect(html.match(/Used when smart mode is off or fails\./g)?.length).toBe(2);
  expect(render({ ...base, smartMode: false })).not.toContain("Used when smart mode is off or fails.");
});

test("settings-ui: dirty check and save include smartMode", async () => {
  expect(settingsDirty(base, { ...base, smartMode: false })).toBe(true);
  expect(settingsDirty(base, { ...base })).toBe(false);
  const sent: Partial<Settings>[] = [];
  const client = {
    saveSettings: async (s: Partial<Settings>) => {
      sent.push(s);
      return base;
    },
    saveBoard: async () => ({}) as never,
  };
  await saveSettingsAndProject(client, { ...base, smartMode: false });
  expect(sent[0]?.smartMode).toBe(false);
});

test("columns-ui: the smart select writes true or false, and inherit removes the key", () => {
  expect(smartModePatch("on")).toEqual({ smartMode: true });
  expect(smartModePatch("off")).toEqual({ smartMode: false });
  expect(smartModePatch("inherit")).toEqual({ smartMode: undefined });
  expect(JSON.stringify({ id: "c", ...smartModePatch("inherit") })).toBe('{"id":"c"}');
  for (const m of SMART_MODES) expect(smartModeOf(smartModePatch(m))).toBe(m);
});
