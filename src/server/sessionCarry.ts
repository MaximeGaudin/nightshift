import type { Column, LastRun } from "../shared/types.ts";

export interface CarryLimits {
  carryMaxTokens: number;
  carryMaxAgeMinutes: number;
}

export interface CarryDecision {
  carry: boolean;
  /** Line to log on the card; only set in auto mode. */
  log?: string;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Context size of one assistant message: everything the model read this turn. Undefined when it carries no usage. */
export function contextTokensOf(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const u = usage as Record<string, unknown>;
  return count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens);
}

const kilo = (n: number) => `${Math.round(n / 1000)}k`;

/** Whether a new column run continues the card's session. Answers, resumes and feedback never come here. */
export function decideCarry(mode: Column["freshSession"], lastRun: LastRun | undefined, limits: CarryLimits, nowMs: number): CarryDecision {
  if (mode === true) return { carry: false };
  if (mode !== "auto") return { carry: true };
  const tokens = lastRun?.contextTokens;
  if (tokens === undefined) return { carry: false, log: "Fresh session: carried context size unknown" };
  if (tokens > limits.carryMaxTokens) {
    return { carry: false, log: `Fresh session: carried context ${kilo(tokens)} > ${kilo(limits.carryMaxTokens)}` };
  }
  const ageMs = nowMs - Date.parse(lastRun?.at ?? "");
  const minutes = Math.floor(ageMs / 60000);
  if (!(ageMs < limits.carryMaxAgeMinutes * 60000)) {
    return { carry: false, log: `Fresh session: last run ${Number.isFinite(minutes) ? minutes : "?"} min ago` };
  }
  return { carry: true, log: `Continuing the card's session (${kilo(tokens)} tokens, ${minutes} min old)` };
}
