import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PERMISSION_MODES, type Settings } from "../shared/types.ts";

export const NIGHTSHIFT_HOME = process.env.NIGHTSHIFT_HOME ?? join(homedir(), ".nightshift");
const SETTINGS_FILE = join(NIGHTSHIFT_HOME, "settings.json");

export const DEFAULT_SETTINGS: Settings = {
  maxParallel: 3,
  claudePath: "claude",
  permissionMode: "auto",
  model: "",
  extraArgs: "",
  recentProjects: [],
};

// Kept on globalThis so modules re-evaluated by `bun --hot` share the state seen by the long-lived orchestrator.
const shared = ((globalThis as any).__nightshiftSettings ??= {
  current: null as Settings | null,
  listeners: new Set<(s: Settings) => void>(),
});
const listeners: Set<(s: Settings) => void> = shared.listeners;

export function getSettings(): Settings {
  if (shared.current) return shared.current;
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    const loaded: Settings = { ...DEFAULT_SETTINGS, ...raw };
    if (!PERMISSION_MODES.includes(loaded.permissionMode)) loaded.permissionMode = DEFAULT_SETTINGS.permissionMode;
    shared.current = loaded;
  } catch {
    shared.current = { ...DEFAULT_SETTINGS };
  }
  return shared.current!;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  if (!PERMISSION_MODES.includes(next.permissionMode)) throw new Error(`Unknown permission mode: ${next.permissionMode}`);
  next.maxParallel = Math.max(1, Math.min(32, Math.floor(Number(next.maxParallel) || 1)));
  shared.current = next;
  mkdirSync(NIGHTSHIFT_HOME, { recursive: true });
  const tmp = SETTINGS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, SETTINGS_FILE);
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
