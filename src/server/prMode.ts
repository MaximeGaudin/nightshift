// Pull request mode of a project: on when origin is a provider with a code host (GitHub), its CLI is installed and
// authenticated, and the board's "Pull requests" setting is not off. Off means the local flow, untouched.

import { parseGitRemote } from "../shared/issues.ts";
import { autoMergeOf, type MergeMethod, mergeMethodOf, pullRequestsOf } from "../shared/pullRequests.ts";
import type { Board } from "../shared/types.ts";
import type { CodeHost } from "./codehost/codehost.ts";
import { codeHostFor } from "./codehost/registry.ts";
import { git } from "./git.ts";

export type PrMode =
  | { active: true; hostId: string; host: CodeHost; mergeMethod: MergeMethod; autoMerge: boolean }
  | { active: false; reason: string };

/** How long the remote and CLI checks of a project are reused. Settings are always read live. */
export const PR_MODE_CACHE_MS = 60_000;

type Probe = { ok: true; hostId: string; host: CodeHost } | { ok: false; reason: string };
const cache = new Map<string, { at: number; probe: Promise<Probe> }>();

/** Forgets the cached probes (all projects, or one). */
export function clearPrModeCache(path?: string) {
  if (path === undefined) cache.clear();
  else cache.delete(path);
}

async function probe(projectPath: string): Promise<Probe> {
  // The configured URL, before any `url.<base>.insteadOf` rewrite: that is the host the user names.
  const r = await git(projectPath, ["config", "--get", "remote.origin.url"], { timeoutMs: 5000 });
  if (r.code !== 0) return { ok: false, reason: "no origin remote" };
  const parsed = parseGitRemote(r.stdout.trim());
  const host = parsed ? codeHostFor(parsed.provider) : undefined;
  if (!parsed || !host) return { ok: false, reason: "origin has no supported code host" };
  const a = await host.available(projectPath);
  if (!a.ok) return { ok: false, reason: a.reason };
  return { ok: true, hostId: parsed.provider, host };
}

export async function detectPrMode(projectPath: string, board: Board, now = Date.now()): Promise<PrMode> {
  if (pullRequestsOf(board) === "off") return { active: false, reason: "pull requests are off in the project settings" };
  let entry = cache.get(projectPath);
  if (!entry || now - entry.at > PR_MODE_CACHE_MS) {
    entry = { at: now, probe: probe(projectPath).catch((e) => ({ ok: false, reason: (e as Error).message }) as Probe) };
    cache.set(projectPath, entry);
  }
  const p = await entry.probe;
  if (!p.ok) return { active: false, reason: p.reason };
  return { active: true, hostId: p.hostId, host: p.host, mergeMethod: mergeMethodOf(board), autoMerge: autoMergeOf(board) };
}

/** The `<environment>` line announcing the mode; undefined when it is off. */
export function prModeLine(mode: PrMode | undefined): string | undefined {
  if (!mode?.active) return undefined;
  return `Pull requests: ${mode.hostId} via gh (merge method: ${mode.mergeMethod}, auto-merge: ${mode.autoMerge ? "on" : "off"})`;
}
