import { expect, test } from "bun:test";
import {
  agentFeatureArgs,
  DEFAULT_AGENT_FEATURES,
  formatAgentFeatures,
  resolveAgentFeatures,
  sanitizeAgentFeatures,
  validateAgentFeaturesStrict,
} from "../src/shared/agentFeatures.ts";
import { resolveLayered } from "../src/shared/layers.ts";

const none = { agentFeatures: {} };

test("resolveLayered: false and empty string win, order decides", () => {
  expect(
    resolveLayered<boolean>(
      [
        { source: "column", value: false },
        { source: "settings", value: true },
      ],
      true,
    ),
  ).toEqual({
    value: false,
    source: "column",
  });
  expect(
    resolveLayered<string>(
      [
        { source: "card", value: undefined },
        { source: "settings", value: "" },
      ],
      "x",
    ),
  ).toEqual({
    value: "",
    source: "settings",
  });
  expect(resolveLayered<number>([], 3)).toEqual({ value: 3, source: "default" });
});

test("resolveAgentFeatures: a column false beats a global true", () => {
  const r = resolveAgentFeatures({ column: { agentFeatures: { hooks: false } }, settings: { agentFeatures: { hooks: true } } });
  expect(r.hooks).toEqual({ enabled: false, source: "column" });
});

test("resolveAgentFeatures: each level overrides the next, per feature", () => {
  const r = resolveAgentFeatures({
    card: { agentFeatures: { mcp: true } },
    column: { agentFeatures: { mcp: false, chrome: true } },
    settings: { agentFeatures: { mcp: false, chrome: false, hooks: true } },
  });
  expect(r.mcp).toEqual({ enabled: true, source: "card" });
  expect(r.chrome).toEqual({ enabled: true, source: "column" });
  expect(r.hooks).toEqual({ enabled: true, source: "settings" });
  expect(r.userSettings).toEqual({ enabled: DEFAULT_AGENT_FEATURES.userSettings, source: "default" });
});

test("agentFeatureArgs: default", () => {
  expect(agentFeatureArgs(resolveAgentFeatures({ settings: none }))).toEqual([
    "--strict-mcp-config",
    "--no-chrome",
    "--settings",
    '{"disableAllHooks":true}',
  ]);
});

test("agentFeatureArgs: toggles, never --bare", () => {
  const off = agentFeatureArgs(resolveAgentFeatures({ settings: { agentFeatures: { userSettings: false } } }));
  expect(off.join(" ")).toContain("--setting-sources project,local");
  const on = agentFeatureArgs(resolveAgentFeatures({ settings: { agentFeatures: { mcp: true, chrome: true, hooks: true } } }));
  expect(on).toEqual([]);
  expect([...off, ...on]).not.toContain("--bare");
});

test("formatAgentFeatures lists state and source", () => {
  const r = resolveAgentFeatures({ column: { agentFeatures: { hooks: false } }, settings: { agentFeatures: { userSettings: true } } });
  expect(formatAgentFeatures(r)).toBe("features: mcp off (default), chrome off (default), hooks off (column), user skills on (settings)");
});

test("validate and sanitize", () => {
  expect(validateAgentFeaturesStrict({ mcp: "yes" }).ok).toBe(false);
  expect(validateAgentFeaturesStrict({ nope: true }).ok).toBe(false);
  expect(validateAgentFeaturesStrict([]).ok).toBe(false);
  expect(validateAgentFeaturesStrict({ mcp: true })).toEqual({ ok: true, value: { mcp: true } });
  expect(validateAgentFeaturesStrict({})).toEqual({ ok: true, value: undefined });
  expect(validateAgentFeaturesStrict(null)).toEqual({ ok: true, value: undefined });
  expect(sanitizeAgentFeatures({ mcp: true, hooks: 1, x: true })).toEqual({ mcp: true });
  expect(sanitizeAgentFeatures({ hooks: 1 })).toBeUndefined();
});
