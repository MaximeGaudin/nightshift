// Per-column / per-card / global effort levels (`claude --effort`): validation, merge and resolution. Pure, no I/O.

import { type Dropped, diffModels, type Models, mergeMap, sanitizeMap, validateMapStrict } from "./models.ts";
import { type Layer, resolveLayers } from "./resolve.ts";
import type { Card, Column, Settings } from "./types.ts";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type EffortSource = "card" | "column" | "settings" | "default";

/** Economic default per skill template when nothing else is set. */
export const ECONOMIC_EFFORT: Record<string, EffortLevel> = {
  "nightshift-grill": "medium",
  "nightshift-plan": "high",
  "nightshift-implement": "medium",
  "nightshift-review": "medium",
  "nightshift-merge": "low",
};

export function isValidEffort(v: unknown): v is EffortLevel {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v.trim());
}

/** "" | "inherit" | a level. */
export function isValidEffortSetting(v: unknown): boolean {
  return v === "" || v === "inherit" || isValidEffort(v);
}

export function economicEffort(skill?: string): EffortLevel {
  return (skill && ECONOMIC_EFFORT[skill]) || "medium";
}

function settingsLayer(settings: Pick<Settings, "effort">): Layer<EffortLevel, EffortSource> {
  const e = typeof settings.effort === "string" ? settings.effort.trim() : "";
  return { source: "settings", value: e === "inherit" ? null : e ? (e as EffortLevel) : undefined };
}

/** Card entry (skill column) > column > settings > economic default of the skill. "inherit" yields no effort. */
export function resolveEffort(
  column: Column,
  settings: Pick<Settings, "effort">,
  card?: Pick<Card, "efforts">,
): { effort: EffortLevel | undefined; source: EffortSource } {
  const cardValue = card && column.type === "skill" && column.skill ? card.efforts?.[column.skill] : undefined;
  const r = resolveLayers<EffortLevel, EffortSource>(
    [{ source: "card", value: cardValue }, { source: "column", value: column.effort }, settingsLayer(settings)],
    { source: "default", value: economicEffort(column.type === "skill" ? column.skill : undefined) },
  );
  return { effort: r.value, source: r.source };
}

/** Quick runs have no card or column: settings > economic default of the skill. */
export function resolveQuickEffort(
  skill: string,
  settings: Pick<Settings, "effort">,
): { effort: EffortLevel | undefined; source: EffortSource } {
  const r = resolveLayers<EffortLevel, EffortSource>([settingsLayer(settings)], { source: "default", value: economicEffort(skill) });
  return { effort: r.value, source: r.source };
}

export type Efforts = Record<string, EffortLevel>;

export function sanitizeEfforts(raw: unknown): { efforts: Efforts | undefined; dropped: Dropped[] } {
  const r = sanitizeMap(raw, isValidEffort);
  return { efforts: r.models as Efforts | undefined, dropped: r.dropped };
}

export function mergeEfforts(current: Efforts | undefined, patch: unknown) {
  const r = mergeMap(current, patch, isValidEffort);
  return { efforts: r.models as Efforts | undefined, changes: r.changes, dropped: r.dropped };
}

export function validateEffortsStrict(raw: unknown): { ok: true; efforts: Efforts | undefined } | { ok: false; error: string } {
  const r = validateMapStrict(raw, isValidEffort, "effort", "efforts");
  return r.ok ? { ok: true, efforts: r.models as Efforts | undefined } : r;
}

export function diffEfforts(before: Efforts | undefined, after: Efforts | undefined): string[] {
  return diffModels(before as Models | undefined, after as Models | undefined);
}

export function describeEffortChanges(changes: string[], by: "agent" | "user"): string {
  return `Efforts: ${changes.join(", ")} (by ${by})`;
}

export function formatDroppedEffort(d: Dropped): string {
  return `Ignored effort "${d.value.slice(0, 80)}" for ${d.key.slice(0, 80)} (invalid)`;
}

/** "medium (default)", or "inherit (settings)" when no --effort is passed. */
export function effortLabel(effort: EffortLevel | undefined, source: EffortSource): string {
  return effort ? `${effort} (${source})` : `inherit (${source})`;
}
