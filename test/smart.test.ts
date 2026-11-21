import { describe, expect, test } from "bun:test";
import { resolveAgentFeatures } from "../src/shared/agentFeatures.ts";
import { resolveEffort } from "../src/shared/effort.ts";
import { formatSmartChoice, sanitizeSmartChoices, smartEnabled, smartNeeded, validateSmartOutput } from "../src/shared/smart.ts";
import type { Column } from "../src/shared/types.ts";

const col = (over: Partial<Column> = {}): Column => ({ id: "c", name: "C", type: "skill", skill: "nightshift-merge", ...over });
const smartAll = { mcp: true, chrome: true, hooks: true, userSettings: false };

describe("smart layer in the resolution", () => {
  test("card and column win over smart", () => {
    const column = col({ agentFeatures: { mcp: false }, effort: "low" });
    const r = resolveAgentFeatures({ column, settings: { agentFeatures: {} }, smart: smartAll });
    expect(r.mcp).toEqual({ enabled: false, source: "column" });
    expect(r.chrome).toEqual({ enabled: true, source: "smart" });
    expect(resolveEffort(column, { effort: "" }, undefined, "high")).toEqual({ effort: "low", source: "column" });
    const card = { agentFeatures: { chrome: false }, efforts: { "nightshift-merge": "medium" as const } };
    const rc = resolveAgentFeatures({ card, column: col(), settings: { agentFeatures: {} }, smart: smartAll });
    expect(rc.chrome).toEqual({ enabled: false, source: "card" });
    expect(resolveEffort(col(), { effort: "" }, card, "high")).toEqual({ effort: "medium", source: "card" });
  });

  test("smart wins over settings, inherit included", () => {
    const settings = { agentFeatures: { chrome: true }, effort: "inherit" as const };
    const r = resolveAgentFeatures({ column: col(), settings, smart: { ...smartAll, chrome: false } });
    expect(r.chrome).toEqual({ enabled: false, source: "smart" });
    expect(resolveEffort(col(), settings, undefined, "medium")).toEqual({ effort: "medium", source: "smart" });
  });

  test("without smart, the results are unchanged", () => {
    const settings = { agentFeatures: { chrome: true }, effort: "inherit" as const };
    expect(resolveAgentFeatures({ column: col(), settings }).chrome).toEqual({ enabled: true, source: "settings" });
    expect(resolveEffort(col(), settings)).toEqual({ effort: undefined, source: "settings" });
  });
});

describe("validateSmartOutput", () => {
  const ok = { mcp: false, chrome: false, hooks: false, userSettings: true, effort: "low", reason: " merge trivial " };
  test("accepts a complete output and trims the reason", () => {
    expect(validateSmartOutput(ok)).toEqual({
      features: { mcp: false, chrome: false, hooks: false, userSettings: true },
      effort: "low",
      reason: "merge trivial",
    });
  });
  test("rejects a missing key, a non-boolean, an effort above high, an empty reason", () => {
    const { hooks: _h, ...missing } = ok;
    expect(validateSmartOutput(missing)).toBeNull();
    expect(validateSmartOutput({ ...ok, mcp: "yes" })).toBeNull();
    expect(validateSmartOutput({ ...ok, effort: "max" })).toBeNull();
    expect(validateSmartOutput({ ...ok, effort: "xhigh" })).toBeNull();
    expect(validateSmartOutput({ ...ok, reason: "  " })).toBeNull();
    expect(validateSmartOutput(null)).toBeNull();
  });
  test("formats the choice like the features log line", () => {
    expect(formatSmartChoice(validateSmartOutput(ok) as never)).toBe("mcp off, chrome off, hooks off, user skills on, effort low");
  });
});

describe("when to call", () => {
  test("column value wins over the global setting; never for an inert column", () => {
    expect(smartEnabled(col(), { smartMode: true })).toBe(true);
    expect(smartEnabled(col({ smartMode: false }), { smartMode: true })).toBe(false);
    expect(smartEnabled(col({ smartMode: true }), { smartMode: false })).toBe(true);
    expect(smartEnabled(col(), { smartMode: false })).toBe(false);
    expect(smartEnabled({ type: "inert" }, { smartMode: true })).toBe(false);
  });
  test("not needed when card and column fix every feature and the effort", () => {
    const all = { mcp: false, chrome: false, hooks: false, userSettings: true };
    expect(smartNeeded({}, col())).toBe(true);
    expect(smartNeeded({}, col({ agentFeatures: all }))).toBe(true);
    expect(smartNeeded({}, col({ agentFeatures: all, effort: "low" }))).toBe(false);
    expect(
      smartNeeded(
        { agentFeatures: { mcp: true, chrome: true }, efforts: { "nightshift-merge": "high" } },
        col({ agentFeatures: { hooks: false, userSettings: false } }),
      ),
    ).toBe(false);
  });
});

describe("sanitizeSmartChoices", () => {
  test("keeps valid entries, drops corrupt ones", () => {
    const good = {
      features: { mcp: true, chrome: false, hooks: false, userSettings: true },
      effort: "medium",
      reason: "r",
      fingerprint: "abc",
      costUsd: 0.001,
      durationMs: 1200,
      at: "2026-01-01T00:00:00.000Z",
    };
    expect(sanitizeSmartChoices({ a: good, b: { ...good, effort: "max" }, c: "x" })).toEqual({ a: good });
    expect(sanitizeSmartChoices({ b: 1 })).toBeUndefined();
    expect(sanitizeSmartChoices([])).toBeUndefined();
  });
});
