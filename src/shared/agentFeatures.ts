// Agent features: what a `claude -p` run loads of the user's setup. Each one is on or off, resolved
// one by one: card > column > settings > default. Pure, no I/O.

import { type LayerSource, resolveLayered } from "./layers.ts";
import type { Card, Column, Settings } from "./types.ts";

export const AGENT_FEATURES = ["mcp", "chrome", "hooks", "userSettings"] as const;
export type AgentFeature = (typeof AGENT_FEATURES)[number];
/** `true` = on, `false` = off, absent key = inherit from the layer below. */
export type AgentFeaturesOverride = Partial<Record<AgentFeature, boolean>>;
export type ResolvedAgentFeatures = Record<AgentFeature, { enabled: boolean; source: LayerSource }>;

/** The economical default: everything on the context bill is off, except the user's skills and CLAUDE.md. */
export const DEFAULT_AGENT_FEATURES: Record<AgentFeature, boolean> = { mcp: false, chrome: false, hooks: false, userSettings: true };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function resolveAgentFeatures(layers: {
  card?: Pick<Card, "agentFeatures">;
  column?: Pick<Column, "agentFeatures">;
  settings: Pick<Settings, "agentFeatures">;
}): ResolvedAgentFeatures {
  const out = {} as ResolvedAgentFeatures;
  for (const f of AGENT_FEATURES) {
    const r = resolveLayered<boolean>(
      [
        { source: "card", value: layers.card?.agentFeatures?.[f] },
        { source: "column", value: layers.column?.agentFeatures?.[f] },
        { source: "settings", value: layers.settings.agentFeatures?.[f] },
      ],
      DEFAULT_AGENT_FEATURES[f],
    );
    out[f] = { enabled: r.value, source: r.source };
  }
  return out;
}

/** The `claude` flags that switch the disabled features off. Never `--bare`: it needs ANTHROPIC_API_KEY. */
export function agentFeatureArgs(r: ResolvedAgentFeatures): string[] {
  return [
    ...(r.mcp.enabled ? [] : ["--strict-mcp-config"]),
    ...(r.chrome.enabled ? [] : ["--no-chrome"]),
    ...(r.hooks.enabled ? [] : ["--settings", '{"disableAllHooks":true}']),
    ...(r.userSettings.enabled ? [] : ["--setting-sources", "project,local"]),
  ];
}

const LOG_LABELS: Record<AgentFeature, string> = { mcp: "mcp", chrome: "chrome", hooks: "hooks", userSettings: "user skills" };

/** `features: mcp off (default), chrome off (default), hooks off (column), user skills on (settings)` */
export function formatAgentFeatures(r: ResolvedAgentFeatures): string {
  return `features: ${AGENT_FEATURES.map((f) => `${LOG_LABELS[f]} ${r[f].enabled ? "on" : "off"} (${r[f].source})`).join(", ")}`;
}

/** Lenient (load): keeps known keys with a boolean value. undefined when nothing is left. */
export function sanitizeAgentFeatures(raw: unknown): AgentFeaturesOverride | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: AgentFeaturesOverride = {};
  for (const f of AGENT_FEATURES) if (typeof raw[f] === "boolean") out[f] = raw[f];
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Strict (API): null clears, {} clears, an unknown key or a non-boolean value rejects the whole value. */
export function validateAgentFeaturesStrict(
  raw: unknown,
): { ok: true; value: AgentFeaturesOverride | undefined } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  if (!isPlainObject(raw)) return { ok: false, error: "agentFeatures must be an object" };
  const out: AgentFeaturesOverride = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(AGENT_FEATURES as readonly string[]).includes(key)) return { ok: false, error: `Unknown agent feature "${key}"` };
    if (typeof value !== "boolean") return { ok: false, error: `Agent feature "${key}" must be a boolean` };
    out[key as AgentFeature] = value;
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : undefined };
}

/** Same vocabulary as the model changes in the card history. */
export function diffAgentFeatures(before: AgentFeaturesOverride | undefined, after: AgentFeaturesOverride | undefined): string[] {
  const out: string[] = [];
  for (const f of AGENT_FEATURES) {
    const b = before?.[f];
    const a = after?.[f];
    if (a === b) continue;
    out.push(a === undefined ? `${f} inherited` : `${f}=${a ? "on" : "off"}`);
  }
  return out;
}
