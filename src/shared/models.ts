// Per-card model overrides: validation, merge and resolution. Pure, no I/O.
// "default" is only a merge instruction (remove the entry); it is never stored.

import type { Card, Column, Settings } from "./types.ts";

export const MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;
export const MODEL_ID_RE = /^claude-[a-z0-9.-]{1,60}(\[1m\])?$/;
export const SKILL_KEY_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

export type ModelSource = "card" | "column" | "settings" | "default";
export type Models = Record<string, string>;
export interface Dropped {
  key: string;
  value: string;
}

/** Alias or Claude model ID, on the trimmed value (case-sensitive). "default" is not a value. */
export function isValidModelValue(v: string): boolean {
  const t = v.trim();
  return (MODEL_ALIASES as readonly string[]).includes(t) || MODEL_ID_RE.test(t);
}

/** Card entry (skill column, not locked) > column > settings > CLI default. */
export function resolveModel(
  column: Column,
  settings: Pick<Settings, "model">,
  card?: Pick<Card, "models">,
): { model: string | undefined; source: ModelSource } {
  if (card && column.type === "skill" && column.skill && !column.lockModel) {
    const m = card.models?.[column.skill]?.trim();
    if (m) return { model: m, source: "card" };
  }
  const c = column.model?.trim();
  if (c) return { model: c, source: "column" };
  const s = settings.model?.trim();
  if (s) return { model: s, source: "settings" };
  return { model: undefined, source: "default" };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function render(v: unknown): string {
  return typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
}

/** Lenient (load): keeps valid entries, reports the others. undefined when nothing is left. */
export function sanitizeModels(raw: unknown): { models: Models | undefined; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  if (!isPlainObject(raw)) return { models: undefined, dropped };
  const models: Models = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SKILL_KEY_RE.test(key) && typeof value === "string" && isValidModelValue(value)) models[key] = value.trim();
    else dropped.push({ key, value: render(value) });
  }
  return { models: Object.keys(models).length > 0 ? models : undefined, dropped };
}

/** Applies an agent's patch on the current models. "default" removes an entry. */
export function mergeModels(
  current: Models | undefined,
  patch: unknown,
): { models: Models | undefined; changes: string[]; dropped: Dropped[] } {
  const changes: string[] = [];
  const dropped: Dropped[] = [];
  if (!isPlainObject(patch)) return { models: current, changes, dropped };
  const out: Models = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    const v = typeof value === "string" ? value.trim() : undefined;
    if (!SKILL_KEY_RE.test(key) || v === undefined || (v !== "default" && !isValidModelValue(v))) {
      dropped.push({ key, value: render(value) });
    } else if (v === "default") {
      if (key in out) {
        delete out[key];
        changes.push(`${key} removed`);
      }
    } else if (out[key] !== v) {
      out[key] = v;
      changes.push(`${key}=${v}`);
    }
  }
  return { models: Object.keys(out).length > 0 ? out : undefined, changes, dropped };
}

/** Strict (PATCH): null or {} clears; any invalid entry, "default" included, rejects the whole value. */
export function validateModelsStrict(raw: unknown): { ok: true; models: Models | undefined } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, models: undefined };
  if (!isPlainObject(raw)) return { ok: false, error: "models must be an object" };
  const models: Models = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!SKILL_KEY_RE.test(key)) return { ok: false, error: `Invalid skill name "${key}"` };
    if (typeof value !== "string" || !isValidModelValue(value))
      return { ok: false, error: `Invalid model ${JSON.stringify(render(value))} for ${key}` };
    models[key] = value.trim();
  }
  return { ok: true, models: Object.keys(models).length > 0 ? models : undefined };
}

export function describeModelChanges(changes: string[], by: "agent" | "user"): string {
  return `Models: ${changes.join(", ")} (by ${by})`;
}

/** Same vocabulary as mergeModels changes, sorted by key. */
export function diffModels(before: Models | undefined, after: Models | undefined): string[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  const out: string[] = [];
  for (const k of keys) {
    const b = before?.[k];
    const a = after?.[k];
    if (a === undefined) out.push(`${k} removed`);
    else if (a !== b) out.push(`${k}=${a}`);
  }
  return out;
}

export function formatDropped(d: Dropped): string {
  return `Ignored model "${d.value.slice(0, 80)}" for ${d.key.slice(0, 80)} (invalid)`;
}
