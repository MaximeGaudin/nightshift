// Smart mode: a quick, cheap `claude -p` call picks the agent features and the effort of a new column run.
// This module holds the pure contract (types, schema, validation, when to call). Pure, no I/O.
// Resolution order, per feature and for the effort: card > column > smart > settings > default.

import { AGENT_FEATURES, type AgentFeature } from "./agentFeatures.ts";
import type { Card, Column, Settings } from "./types.ts";

/** Levels the smart call may choose: xhigh and max stay reserved to explicit overrides. */
export const SMART_EFFORTS = ["low", "medium", "high"] as const;
export type SmartEffort = (typeof SMART_EFFORTS)[number];

export const SMART_REASON_MAX = 300;

export interface SmartChoice {
  features: Record<AgentFeature, boolean>;
  effort: SmartEffort;
  /** One sentence, at most SMART_REASON_MAX characters. */
  reason: string;
}

/** A smart choice cached on the card for one column, valid while the fingerprint matches. */
export interface SmartEntry extends SmartChoice {
  /** Hash of the card title, description and the column's skill when the choice was made. */
  fingerprint: string;
  costUsd: number;
  durationMs: number;
  at: string;
}

/** JSON Schema passed to `--json-schema` for the smart call. */
export const SMART_SCHEMA = {
  type: "object",
  properties: {
    mcp: { type: "boolean", description: "Load the user's MCP servers (external tools: issue trackers, docs, chat...)." },
    chrome: { type: "boolean", description: "Claude in Chrome: drive a real browser." },
    hooks: { type: "boolean", description: "Run the user's hooks." },
    userSettings: { type: "boolean", description: "Load the user's own skills and CLAUDE.md." },
    effort: { type: "string", enum: [...SMART_EFFORTS] },
    reason: { type: "string", description: "One sentence explaining the choice." },
  },
  required: ["mcp", "chrome", "hooks", "userSettings", "effort", "reason"],
  additionalProperties: false,
} as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strict: every feature a boolean, an allowed effort and a non-empty reason, else null (the whole output is invalid). */
export function validateSmartOutput(raw: unknown): SmartChoice | null {
  if (!isPlainObject(raw)) return null;
  const features = {} as Record<AgentFeature, boolean>;
  for (const f of AGENT_FEATURES) {
    if (typeof raw[f] !== "boolean") return null;
    features[f] = raw[f];
  }
  if (typeof raw.effort !== "string" || !(SMART_EFFORTS as readonly string[]).includes(raw.effort)) return null;
  if (typeof raw.reason !== "string" || !raw.reason.trim()) return null;
  return { features, effort: raw.effort as SmartEffort, reason: raw.reason.trim().slice(0, SMART_REASON_MAX) };
}

/** Smart mode of a run in this column: the column's own value, else the global setting. Never for a non-skill column. */
export function smartEnabled(column: Pick<Column, "type" | "smartMode">, settings: Pick<Settings, "smartMode">): boolean {
  if (column.type !== "skill") return false;
  return column.smartMode ?? settings.smartMode !== false;
}

/** False when the card and the column already set every feature and the effort: there is nothing left to decide. */
export function smartNeeded(card: Pick<Card, "agentFeatures" | "efforts">, column: Column): boolean {
  const allFeatures = AGENT_FEATURES.every((f) => card.agentFeatures?.[f] !== undefined || column.agentFeatures?.[f] !== undefined);
  const cardEffort = column.skill ? card.efforts?.[column.skill] : undefined;
  return !(allFeatures && (cardEffort !== undefined || column.effort !== undefined));
}

const LABELS: Record<AgentFeature, string> = { mcp: "mcp", chrome: "chrome", hooks: "hooks", userSettings: "user skills" };

/** `mcp off, chrome off, hooks off, user skills on, effort low` */
export function formatSmartChoice(c: Pick<SmartChoice, "features" | "effort">): string {
  return [...AGENT_FEATURES.map((f) => `${LABELS[f]} ${c.features[f] ? "on" : "off"}`), `effort ${c.effort}`].join(", ");
}

/** `$0.0012` */
export function formatSmartCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function sanitizeEntry(raw: unknown): SmartEntry | null {
  if (!isPlainObject(raw) || !isPlainObject(raw.features)) return null;
  const choice = validateSmartOutput({ ...raw.features, effort: raw.effort, reason: raw.reason });
  if (!choice) return null;
  if (typeof raw.fingerprint !== "string" || !raw.fingerprint) return null;
  const costUsd = typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd) && raw.costUsd >= 0 ? raw.costUsd : 0;
  const durationMs = typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? raw.durationMs : 0;
  const at = typeof raw.at === "string" ? raw.at : "";
  return { ...choice, fingerprint: raw.fingerprint, costUsd, durationMs, at };
}

/** Lenient (load): keeps the valid entries, drops the others. undefined when nothing is left. */
export function sanitizeSmartChoices(raw: unknown): Record<string, SmartEntry> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, SmartEntry> = {};
  for (const [columnId, entry] of Object.entries(raw)) {
    const e = sanitizeEntry(entry);
    if (columnId && e) out[columnId] = e;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
