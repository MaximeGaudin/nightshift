// Claude quota snapshot, read from the `rate_limit_event` lines of the agents' stream-json output.

/** One quota window: `utilization` from 0 to 1, `resetsAt` in Unix seconds. */
export interface QuotaWindow {
  utilization: number;
  resetsAt: number;
}

/** Last quota state seen by the server. `at` is the ISO time Nightshift received the event. */
export interface QuotaSnapshot {
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
  status?: string;
  isUsingOverage?: boolean;
  at: string;
}

export type QuotaLevel = "normal" | "warn" | "danger";

export const QUOTA_STALE_MS = 3_600_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A window is valid with a finite utilization >= 0 and a finite resetsAt > 0. */
export function parseWindow(v: unknown): QuotaWindow | undefined {
  if (!isObject(v)) return undefined;
  const { utilization, resetsAt } = v;
  if (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0) return undefined;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  return { utilization, resetsAt };
}

/**
 * Folds an untrusted `rate_limit_info` into the previous snapshot, field by field: a valid field replaces the old
 * value, a missing or invalid one keeps it. Returns `prev` itself (same reference) when nothing is usable. Never throws.
 */
export function mergeRateLimitInfo(prev: QuotaSnapshot | null, info: unknown, at: string): QuotaSnapshot | null {
  if (!isObject(info)) return prev;
  const unified = isObject(info.unifiedWindows) ? info.unifiedWindows : undefined;
  let fiveHour = parseWindow(unified?.five_hour);
  let sevenDay = parseWindow(unified?.seven_day);
  if (!unified) {
    const top = parseWindow(info);
    if (info.rateLimitType === "five_hour") fiveHour = top;
    else if (info.rateLimitType === "seven_day") sevenDay = top;
  }
  const status = typeof info.status === "string" ? info.status : undefined;
  const isUsingOverage = typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : undefined;
  if (!fiveHour && !sevenDay && status === undefined && isUsingOverage === undefined) return prev;
  const next: QuotaSnapshot = { at };
  const f = fiveHour ?? prev?.fiveHour;
  const s = sevenDay ?? prev?.sevenDay;
  const st = status ?? prev?.status;
  const o = isUsingOverage ?? prev?.isUsingOverage;
  if (f) next.fiveHour = f;
  if (s) next.sevenDay = s;
  if (st !== undefined) next.status = st;
  if (o !== undefined) next.isUsingOverage = o;
  return next;
}

/** Revalidates a snapshot read from disk or the network: null when it has no usable shape. */
export function parseSnapshot(v: unknown): QuotaSnapshot | null {
  if (!isObject(v) || typeof v.at !== "string") return null;
  const snap: QuotaSnapshot = { at: v.at };
  const f = parseWindow(v.fiveHour);
  const s = parseWindow(v.sevenDay);
  if (f) snap.fiveHour = f;
  if (s) snap.sevenDay = s;
  if (typeof v.status === "string") snap.status = v.status;
  if (typeof v.isUsingOverage === "boolean") snap.isUsingOverage = v.isUsingOverage;
  return snap.fiveHour || snap.sevenDay ? snap : null;
}

export function quotaLevel(w: QuotaWindow, status?: string): QuotaLevel {
  if (status === "rejected" || w.utilization >= 0.9) return "danger";
  return w.utilization >= 0.75 ? "warn" : "normal";
}

export const windowExpired = (w: QuotaWindow, nowMs: number): boolean => w.resetsAt * 1000 <= nowMs;

export const isStale = (s: QuotaSnapshot, nowMs: number): boolean => nowMs - Date.parse(s.at) > QUOTA_STALE_MS;
