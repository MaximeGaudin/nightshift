import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_PARALLEL, LANGUAGE_SETTINGS, normalizeProjectParallel, PERMISSION_MODES, type Settings } from "../shared/types.ts";
import { writeFileAtomic } from "./fsutil.ts";

export const NIGHTSHIFT_HOME = process.env.NIGHTSHIFT_HOME ?? join(homedir(), ".nightshift");
const SETTINGS_FILE = join(NIGHTSHIFT_HOME, "settings.json");
// A test run that reaches this line without its own home would rewrite the user's real settings
// (claudePath pointing at a worktree's fake binary, test parallelism, temp projects in the recent list).
if (process.env.NODE_ENV === "test" && !process.env.NIGHTSHIFT_HOME) {
  throw new Error("NIGHTSHIFT_HOME must be set when running tests: refusing to use the real ~/.nightshift");
}

export const DEFAULT_SETTINGS: Settings = {
  claudePath: "claude",
  permissionMode: "auto",
  model: "",
  extraArgs: "",
  recentProjects: [],
  soundNotifications: true,
  language: "auto",
  carryMaxTokens: 80000,
  carryMaxAgeMinutes: 5,
};

// Kept on globalThis so modules re-evaluated by `bun --hot` share the state seen by the long-lived orchestrator.
const globals = globalThis as {
  __nightshiftSettings?: {
    current: Settings | null;
    listeners: Set<(s: Settings) => void>;
    readOnly?: boolean;
    /** Raw `maxParallel` of the file (the former global cap): kept as is on every write, never edited. */
    legacyMaxParallel?: unknown;
    /** Issue provider tokens by `tokenKey`: kept in the file, never part of `Settings` (which is sent to clients). */
    issueTokens?: Record<string, string>;
  };
};
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
    case "soundNotifications":
      return typeof value === "boolean" ? null : "soundNotifications must be a boolean";
    case "permissionMode":
      return PERMISSION_MODES.includes(value as Settings["permissionMode"]) ? null : `Unknown permission mode: ${String(value)}`;
    case "language":
      return LANGUAGE_SETTINGS.includes(value as Settings["language"]) ? null : `Unknown language: ${String(value)}`;
    case "carryMaxTokens":
      return Number.isInteger(value) && (value as number) >= 0 ? null : "carryMaxTokens must be an integer of 0 or more";
    case "carryMaxAgeMinutes":
      return Number.isInteger(value) && (value as number) >= 1 ? null : "carryMaxAgeMinutes must be an integer of 1 or more";
    case "recentProjects":
      return isStringArray(value) ? null : "recentProjects must be an array of strings";
  }
}

export function getSettings(): Settings {
  if (shared.current) return shared.current;
  const loaded: Settings = { ...DEFAULT_SETTINGS, recentProjects: [] };
  shared.legacyMaxParallel = undefined;
  shared.issueTokens = {};
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
      if ("maxParallel" in obj) shared.legacyMaxParallel = obj.maxParallel;
      shared.issueTokens = readTokens(obj.issueTokens);
      for (const key of KEYS) {
        if (key in obj && checkField(key, obj[key]) === null) (loaded as unknown as Record<string, unknown>)[key] = obj[key];
      }
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
  // The former global cap is now per project: older clients may still send it, it is ignored.
  const entries = Object.entries(patch).filter(([key]) => key !== "maxParallel");
  for (const [key] of entries) {
    if (!KEYS.includes(key as keyof Settings)) throw new Error(`Unknown setting: ${key}`);
  }
  for (const [key, value] of entries) {
    const err = checkField(key as keyof Settings, value);
    if (err) throw new Error(err);
  }
  const next: Settings = { ...getSettings(), ...Object.fromEntries(entries) };
  writeSettingsFile(next);
  shared.current = next;
  for (const l of listeners) l(next);
  return next;
}

function readTokens(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
}

/** Writes the settings file: the legacy cap, the settings, then the issue tokens. Skipped in read-only mode. */
function writeSettingsFile(settings: Settings) {
  if (shared.readOnly) return;
  mkdirSync(NIGHTSHIFT_HOME, { recursive: true });
  const legacy = shared.legacyMaxParallel;
  const tokens = shared.issueTokens ?? {};
  const file = {
    ...(legacy === undefined ? {} : { maxParallel: legacy }),
    ...settings,
    ...(Object.keys(tokens).length > 0 ? { issueTokens: tokens } : {}),
  };
  writeFileAtomic(SETTINGS_FILE, `${JSON.stringify(file, null, 2)}\n`);
}

/** Token saved for a `tokenKey`, or undefined. Never send it to a client. */
export function getIssueToken(key: string): string | undefined {
  getSettings();
  return shared.issueTokens?.[key];
}

export function hasIssueToken(key: string): boolean {
  return getIssueToken(key) !== undefined;
}

/** Saves (or, with an empty token, removes) the token of a `tokenKey`. Keeps every other field of the file. */
export function setIssueToken(key: string, token: string) {
  const current = getSettings();
  const tokens = { ...(shared.issueTokens ?? {}) };
  const t = token.trim();
  if (t) tokens[key] = t;
  else delete tokens[key];
  shared.issueTokens = tokens;
  writeSettingsFile(current);
}

/** Project cap used when a board has no `maxParallel`: the former global setting, else the default. */
export function legacyMaxParallel(): number {
  getSettings();
  return normalizeProjectParallel(shared.legacyMaxParallel) ?? DEFAULT_PROJECT_PARALLEL;
}

export function onSettingsChange(fn: (s: Settings) => void) {
  listeners.add(fn);
}

/**
 * A test instance (`--no-agents`, started from a card's worktree) reads the user's settings but keeps every
 * change in memory: its code may be older or newer than the user's, and its projects are temporary copies.
 */
export function setSettingsReadOnly(readOnly: boolean) {
  shared.readOnly = readOnly;
}

export function rememberProject(path: string) {
  if (shared.readOnly) return;
  const recent = [path, ...getSettings().recentProjects.filter((p) => p !== path)].slice(0, 15);
  updateSettings({ recentProjects: recent });
}
