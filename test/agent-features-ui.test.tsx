import { afterAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultBoard } from "../src/server/store.ts";
import type { Card, Settings } from "../src/shared/types.ts";
import { AgentFeaturesFields, agentFeaturesPatch, inheritedFeatures } from "../src/web/AgentFeaturesFields.tsx";
import { CardAgentFeaturesEditor } from "../src/web/CardAgentFeaturesEditor.tsx";
import { getLocale, setLocale } from "../src/web/i18n/index.ts";
import { SettingsContent, saveSettingsAndProject, settingsDirty } from "../src/web/SettingsModal.tsx";

const startLocale = getLocale();
afterAll(() => setLocale(startLocale));

const base: Settings = {
  claudePath: "claude",
  permissionMode: "auto",
  model: "",
  extraArgs: "",
  agentFeatures: {},
  recentProjects: [],
  soundNotifications: false,
  language: "auto",
  carryMaxTokens: 80000,
  carryMaxAgeMinutes: 5,
};
const render = (s: Settings) =>
  renderToStaticMarkup(<SettingsContent value={s} onChange={() => {}} currentProject={undefined} onOpenProject={() => {}} />);

test("settings: four rows with the inherited value, in French then English", () => {
  setLocale("fr");
  let html = render(base);
  for (const label of [
    "Serveurs MCP (utilisateur et projet)",
    "Chrome",
    "Hooks (utilisateur, plugins et projet)",
    "Skills et CLAUDE.md utilisateur",
  ])
    expect(html).toContain(label);
  expect(html.match(/Hériter \(coupé\)/g)?.length).toBe(3);
  expect(html.match(/Hériter \(activé\)/g)?.length).toBe(1);
  setLocale("en");
  html = render({ ...base, agentFeatures: { mcp: true } });
  expect(html).toContain("MCP servers (user and project)");
  expect(html).toContain("User skills and CLAUDE.md");
  expect(html).toContain("Inherit (off)");
  expect(html).toContain("Inherit (on)");
});

test("fields: a column shows what the settings give it", () => {
  setLocale("en");
  const inherited = inheritedFeatures({ settings: { agentFeatures: { mcp: true, userSettings: false } } });
  expect(inherited).toEqual({ mcp: true, chrome: false, hooks: false, userSettings: false });
  const html = renderToStaticMarkup(
    <AgentFeaturesFields idPrefix="x" value={{ chrome: true }} inherited={inherited} onChange={() => {}} />,
  );
  expect(html).toContain("Inherit (on)");
  expect(html).toContain("On");
});

test("patch: inherit drops the key, an empty object becomes undefined", () => {
  expect(agentFeaturesPatch(undefined, "mcp", "on")).toEqual({ mcp: true });
  expect(agentFeaturesPatch({ mcp: true, chrome: false }, "mcp", "inherit")).toEqual({ chrome: false });
  expect(agentFeaturesPatch({ mcp: true }, "mcp", "inherit")).toBeUndefined();
  expect(agentFeaturesPatch({ mcp: true }, "mcp", "off")).toEqual({ mcp: false });
});

test("settingsDirty sees an agent features change", () => {
  expect(settingsDirty(base, { ...base, agentFeatures: { mcp: true } })).toBe(true);
  expect(settingsDirty(base, { ...base, agentFeatures: {} })).toBe(false);
});

test("card editor: shows the column's value as inherited and the number of card overrides", () => {
  setLocale("en");
  const board = {
    ...defaultBoard("x"),
    columns: [{ id: "c", name: "Work", type: "skill" as const, skill: "s", agentFeatures: { hooks: true } }],
  };
  const card = { id: "k", columnId: "c", agentFeatures: { mcp: true } } as unknown as Card;
  const html = renderToStaticMarkup(<CardAgentFeaturesEditor project="/p" card={card} board={board} settings={null} />);
  expect(html).toContain("Agent features (1)");
  expect(html).toContain("Inherit (on)");
  expect(html).toContain("Inherit (off)");
});

test("saving the settings sends the agent features", async () => {
  const sent: Partial<Settings>[] = [];
  const client = {
    saveSettings: async (s: Partial<Settings>) => {
      sent.push(s);
      return base;
    },
    saveBoard: async () => ({}) as never,
  };
  await saveSettingsAndProject(client, { ...base, agentFeatures: { hooks: true } });
  expect(sent[0]?.agentFeatures).toEqual({ hooks: true });
});
