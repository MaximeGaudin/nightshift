import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PERMISSION_MODES, type Settings } from "../shared/types.ts";
import { writeFileAtomic } from "./fsutil.ts";

export const NIGHTSHIFT_HOME = process.env.NIGHTSHIFT_HOME ?? join(homedir(), ".nightshift");
const SETTINGS_FILE = join(NIGHTSHIFT_HOME, "settings.json");

export const DEFAULT_SETTINGS: Settings = {
  maxParallel: 3,
  claudePath: "claude",
  permissionMode: "auto",
  model: "",
  extraArgs: "",
  recentProjects: [],
  soundNotifications: true,
};

// Kept on globalThis so modules re-evaluated by `bun --hot` share the state seen by the long-lived orchestrator.
const globals = globalThis as { __nightshiftSettings?: { current: Settings | null; listeners: Set<(s: Settings) => void> } };
if (!globals.__nightshiftSettings) globals.__nightshiftSettings = { current: null, listeners: new Set() };
const shared = globals.__nightshiftSettings;
const listeners: Set<(s: Settings) => void> = shared.listeners;

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Returns an error message when `value` is not valid for `key`, else null. */
function checkField(key: keyof Settings, value: unknown): string | null {
  switch (key) {
    case "claudePath":
      return typeof value === "string" && value.trim() !== "" ? null : "claudePath must be a non-empty string";
    case "model":
    case "extraArgs":
      return typeof value === "string" ? null : `${key} must be a string`;
    case "maxParallel":
      return typeof value === "number" && Number.isFinite(value) ? null : "maxParallel must be a number";
    case "soundNotifications":
      return typeof value === "boolean" ? null : "soundNotifications must be a boolean";
    case "permissionMode":
      return PERMISSION_MODES.includes(value as Settings["permissionMode"]) ? null : `Unknown permission mode: ${String(value)}`;
    case "recentProjects":
      return isStringArray(value) ? null : "recentProjects must be an array of strings";
  }
}

function clampParallel(n: number): number {
  return Math.max(1, Math.min(32, Math.floor(n)));
}

export function getSettings(): Settings {
  if (shared.current) return shared.current;
  const loaded: Settings = { ...DEFAULT_SETTINGS, recentProjects: [] };
  let text: string | null = null;
  try {
    text = readFileSync(SETTINGS_FILE, "utf8");
  } catch {
    // No settings file yet: defaults.
  }
  if (text !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      console.error(`Unreadable ${SETTINGS_FILE}, keeping a .bak copy and using defaults:`, err);
      try {
        writeFileSync(`${SETTINGS_FILE}.bak`, text);
      } catch {}
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      for (const key of KEYS) {
        if (key in obj && checkField(key, obj[key]) === null) (loaded as any)[key] = obj[key];
      }
      loaded.maxParallel = clampParallel(loaded.maxParallel);
    }
  }
  shared.current = loaded;
  return loaded;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Settings patch must be an object");
  // Historical contract: null resets soundNotifications to its default.
  if ((patch as Record<string, unknown>).soundNotifications === null) {
    patch = { ...patch, soundNotifications: DEFAULT_SETTINGS.soundNotifications };
  }
  const entries = Object.entries(patch);
  for (const [key] of entries) {
    if (!KEYS.includes(key as keyof Settings)) throw new Error(`Unknown setting: ${key}`);
  }
  for (const [key, value] of entries) {
    const err = checkField(key as keyof Settings, value);
    if (err) throw new Error(err);
  }
  const next: Settings = { ...getSettings(), ...patch };
  next.maxParallel = clampParallel(next.maxParallel);
  mkdirSync(NIGHTSHIFT_HOME, { recursive: true });
  writeFileAtomic(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  shared.current = next;
  for (const l of listeners) l(next);
  return next;
}

export function onSettingsChange(fn: (s: Settings) => void) {
  listeners.add(fn);
}

export function rememberProject(path: string) {
  const recent = [path, ...getSettings().recentProjects.filter((p) => p !== path)].slice(0, 15);
  updateSettings({ recentProjects: recent });
}
