import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeRateLimitInfo, parseSnapshot, type QuotaSnapshot } from "../shared/usage.ts";
import { writeFileAtomic } from "./fsutil.ts";
import { NIGHTSHIFT_HOME } from "./settings.ts";

const USAGE_FILE = join(NIGHTSHIFT_HOME, "usage.json");

// Kept on globalThis so modules re-evaluated by `bun --hot` share one snapshot (same reason as settings.ts).
const globals = globalThis as { __nightshiftUsage?: { loaded: boolean; current: QuotaSnapshot | null } };
if (!globals.__nightshiftUsage) globals.__nightshiftUsage = { loaded: false, current: null };
const state = globals.__nightshiftUsage;

/** The Claude quota is per account, not per project: one snapshot for the whole server, read once from `usage.json`. */
export function getUsage(): QuotaSnapshot | null {
  if (!state.loaded) {
    state.loaded = true;
    try {
      state.current = parseSnapshot(JSON.parse(readFileSync(USAGE_FILE, "utf8")));
    } catch {
      state.current = null;
    }
  }
  return state.current;
}

/** Folds a `rate_limit_info` into the snapshot and persists it. Returns the new snapshot, or null when nothing changed. Never throws. */
export function recordRateLimit(info: unknown): QuotaSnapshot | null {
  try {
    const prev = getUsage();
    const next = mergeRateLimitInfo(prev, info, new Date().toISOString());
    if (next === prev) return null;
    state.current = next;
    try {
      writeFileAtomic(USAGE_FILE, `${JSON.stringify(next)}\n`);
    } catch (e) {
      console.error(`Could not write ${USAGE_FILE}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return next;
  } catch {
    return null;
  }
}
