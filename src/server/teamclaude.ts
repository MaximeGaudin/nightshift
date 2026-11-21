// Everything that talks to teamclaude (https://github.com/KarpelesLab/teamclaude), the local multi-account proxy
// for Claude Code: reading `teamclaude env`, probing the proxy, mapping its pooled quota, the gate that holds agent
// launches while the proxy is unreachable, and the quota poller. No orchestrator state lives here.

import type { TeamclaudeAction, TeamclaudeFailure, TeamclaudeWait, TeamclaudeWaitEntry } from "../shared/types.ts";
import { parseWindow, type QuotaSnapshot, type QuotaWindow } from "../shared/usage.ts";

/** Variables to set and to remove for a `claude` process launched through the proxy. */
export interface ProxyEnv {
  set: Record<string, string>;
  unset: string[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Decodes one shell word made only of unquoted text, '…' and "…" segments (`'\''` is a closed quote, an escaped
 * apostrophe and a reopened quote). Returns null on anything it does not understand: nothing is ever evaluated.
 */
function decodeWord(raw: string): string | null {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "'") {
      const end = raw.indexOf("'", i + 1);
      if (end < 0) return null;
      out += raw.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let seg = "";
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === "\\" && j + 1 < raw.length && '"\\$`'.includes(raw[j + 1] as string)) {
          seg += raw[j + 1];
          j += 2;
        } else {
          if (raw[j] === "$" || raw[j] === "`") return null;
          seg += raw[j];
          j++;
        }
      }
      if (j >= raw.length) return null;
      out += seg;
      i = j + 1;
    } else if (c === "\\" && i + 1 < raw.length) {
      out += raw[i + 1];
      i += 2;
    } else {
      if (/[\s;&|<>()$`]/.test(c as string)) return null;
      out += c;
      i++;
    }
  }
  return out;
}

/** Reads the output of `teamclaude env`: `export NAME=value` and `unset NAME` lines; every other line is ignored. */
export function parseEnvScript(text: string): ProxyEnv {
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const exp = line.match(/^export\s+([^=\s]+)=(.*)$/);
    if (exp) {
      const [, name, rawValue] = exp as unknown as [string, string, string];
      if (!NAME_RE.test(name)) continue;
      const value = decodeWord(rawValue);
      if (value === null) continue;
      set[name] = value;
      const at = unset.indexOf(name);
      if (at >= 0) unset.splice(at, 1);
      continue;
    }
    const un = line.match(/^unset\s+(.+)$/);
    if (un) {
      for (const name of (un[1] as string).split(/\s+/)) {
        if (!NAME_RE.test(name)) continue;
        delete set[name];
        if (!unset.includes(name)) unset.push(name);
      }
    }
  }
  return { set, unset };
}

/** The environment of a `claude` launched through the proxy: `base` plus `set`, minus `unset`. */
export function applyProxyEnv(base: Record<string, string | undefined>, env: ProxyEnv): Record<string, string | undefined> {
  const out = { ...base, ...env.set };
  for (const name of env.unset) delete out[name];
  return out;
}

export const PROBE_TIMEOUT_MS = 2000;
export const ENV_TIMEOUT_MS = 5000;

/** True when `GET <url>/teamclaude/quota` answers 2xx within the timeout. Never throws. */
export async function probeProxy(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`${url}/teamclaude/quota`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}

/** Runs `teamclaude env` (no shell) and parses it. ENOENT is "not-found"; a non-zero exit or a timeout is "env-failed". */
export async function readTeamclaudeEnv(
  timeoutMs = ENV_TIMEOUT_MS,
): Promise<{ ok: true; env: ProxyEnv } | { ok: false; failure: TeamclaudeFailure }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["teamclaude", "env"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  } catch (e) {
    const code = (e as { code?: string }).code;
    const msg = e instanceof Error ? e.message : String(e);
    if (code === "ENOENT" || /ENOENT|not found|No such file/i.test(msg)) return { ok: false, failure: { kind: "not-found" } };
    return { ok: false, failure: { kind: "env-failed", detail: msg.slice(0, 300) } };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    if (timedOut) return { ok: false, failure: { kind: "env-failed", detail: `timed out after ${timeoutMs / 1000} s` } };
    if (proc.exitCode !== 0) {
      const detail = (stderr.trim() || `exit code ${proc.exitCode}`).slice(0, 300);
      return { ok: false, failure: { kind: "env-failed", detail } };
    }
    return { ok: true, env: parseEnvScript(stdout) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probes the proxy, then reads `teamclaude env`: what a launch through teamclaude needs. */
export async function prepareProxyEnv(url: string): Promise<{ ok: true; env: ProxyEnv } | { ok: false; failure: TeamclaudeFailure }> {
  if (!(await probeProxy(url))) return { ok: false, failure: { kind: "no-response", url } };
  return readTeamclaudeEnv();
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One pooled window of `/teamclaude/quota`: `nextResetAt` is in ms, a QuotaWindow's `resetsAt` in seconds. */
function aggregateWindow(v: unknown): QuotaWindow | undefined {
  if (!isObject(v) || typeof v.nextResetAt !== "number") return undefined;
  return parseWindow({ utilization: v.utilization, resetsAt: v.nextResetAt / 1000 });
}

/**
 * Maps the untrusted body of `GET /teamclaude/quota` (teamclaude's `buildQuotaSummary`) to a QuotaSnapshot:
 * `aggregate.fiveHour` and `aggregate.weeklyShared` are the 5 h and 7 d windows. Null without an `aggregate`.
 */
export function quotaFromSummary(json: unknown, at: string): QuotaSnapshot | null {
  if (!isObject(json) || !isObject(json.aggregate)) return null;
  const snap: QuotaSnapshot = { at, source: "teamclaude" };
  const fiveHour = aggregateWindow(json.aggregate.fiveHour);
  const sevenDay = aggregateWindow(json.aggregate.weeklyShared);
  if (fiveHour) snap.fiveHour = fiveHour;
  if (sevenDay) snap.sevenDay = sevenDay;
  if (Array.isArray(json.accounts)) snap.accounts = json.accounts.filter((a) => !(isObject(a) && a.disabled === true)).length;
  return snap;
}
