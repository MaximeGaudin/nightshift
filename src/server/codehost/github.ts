// GitHub code host through the `gh` CLI. The only module that knows how GitHub pull requests are driven.

import { tmpdir } from "node:os";
import type { ChecksSummary, CodeHost, MergeResult, PrInfo, PrMergeable, PrState } from "./codehost.ts";
import { CodeHostError } from "./codehost.ts";
import { type GhResult, gh } from "./gh.ts";

const PR_FIELDS = "url,number,state,body,mergeable,mergeCommit,baseRefName,isDraft";

function errorOf(r: GhResult, what: string): CodeHostError {
  const text = `${r.stderr}\n${r.stdout}`.trim() || `exit ${r.code}`;
  if (r.code === 127) return new CodeHostError("missing", `${what}: gh not found`);
  if (r.code === 124) return new CodeHostError("network", `${what}: ${text}`);
  if (/auth login|not logged|authentication|HTTP 401|bad credentials/i.test(text)) return new CodeHostError("auth", `${what}: ${text}`);
  if (/could not resolve|timeout|connection|network|HTTP 5\d\d/i.test(text)) return new CodeHostError("network", `${what}: ${text}`);
  return new CodeHostError("other", `${what}: ${text}`);
}

function parsePr(stdout: string): PrInfo {
  const j = JSON.parse(stdout) as Record<string, unknown>;
  const state = String(j.state ?? "").toUpperCase();
  const mergeable = String(j.mergeable ?? "").toUpperCase();
  const mc = j.mergeCommit as { oid?: string } | null | undefined;
  return {
    url: String(j.url ?? ""),
    number: Number(j.number ?? 0),
    state: (["OPEN", "CLOSED", "MERGED"].includes(state) ? state : "OPEN") as PrState,
    body: typeof j.body === "string" ? j.body : "",
    mergeable: (["MERGEABLE", "CONFLICTING"].includes(mergeable) ? mergeable : "UNKNOWN") as PrMergeable,
    ...(mc?.oid ? { mergeCommit: mc.oid } : {}),
    baseRefName: String(j.baseRefName ?? ""),
    isDraft: j.isDraft === true,
  };
}

const NOT_FOUND = /no (open )?pull requests? found|could not resolve to a pull ?request|could not find pull request/i;

async function view(cwd: string, ref: string): Promise<PrInfo | null> {
  const r = await gh(cwd, ["pr", "view", ref, "--json", PR_FIELDS]);
  if (r.code !== 0) {
    if (r.code !== 127 && r.code !== 124 && NOT_FOUND.test(r.stderr)) return null;
    throw errorOf(r, "gh pr view");
  }
  try {
    return parsePr(r.stdout);
  } catch {
    throw new CodeHostError("other", "gh pr view: unreadable output");
  }
}

/** `owner/repo` of a github.com URL (PR or Actions link). */
function repoOf(url: string): string | undefined {
  const m = /^https?:\/\/[^/]+\/([^/\s]+\/[^/\s]+?)\/(pull|actions)\//.exec(url);
  return m?.[1];
}

/**
 * Merges run outside the project: with `--delete-branch`, gh run inside a checkout also deletes the local branch and
 * may switch branches, and the card branch is checked out in its worktree. Nightshift cleans up locally itself.
 */
const OUTSIDE = () => tmpdir();

export const github: CodeHost = {
  async available(cwd) {
    const v = await gh(cwd, ["--version"], { timeoutMs: 10_000 });
    if (v.code !== 0) return { ok: false, reason: v.code === 127 ? "gh not installed" : `gh --version: exit ${v.code}` };
    const a = await gh(cwd, ["auth", "status"], { timeoutMs: 15_000 });
    if (a.code !== 0) return { ok: false, reason: "gh not authenticated (gh auth status)" };
    return { ok: true };
  },

  findPr(cwd, head) {
    return view(cwd, head);
  },

  prState(cwd, url) {
    return view(cwd, url);
  },

  async createPr(cwd, pr) {
    const args = [
      "pr",
      "create",
      "--base",
      pr.base,
      "--head",
      pr.head,
      "--title",
      pr.title,
      "--body-file",
      "-",
      ...(pr.draft ? ["--draft"] : []),
    ];
    const r = await gh(cwd, args, {
      input: pr.body,
    });
    if (r.code !== 0) throw errorOf(r, "gh pr create");
    const url = r.stdout
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .reverse()
      .find((l) => /^https?:\/\//.test(l));
    if (!url) throw new CodeHostError("other", "gh pr create: no URL in the output");
    return url;
  },

  async updatePr(cwd, url, pr) {
    const r = await gh(cwd, ["pr", "edit", url, "--title", pr.title, "--body-file", "-"], { input: pr.body });
    if (r.code !== 0) throw errorOf(r, "gh pr edit");
  },

  async markReady(cwd, url) {
    const r = await gh(cwd, ["pr", "ready", url]);
    if (r.code !== 0) throw errorOf(r, "gh pr ready");
  },

  async markDraft(cwd, url) {
    const r = await gh(cwd, ["pr", "ready", url, "--undo"]);
    if (r.code !== 0) throw errorOf(r, "gh pr ready --undo");
  },

  async checks(cwd, url): Promise<ChecksSummary> {
    const r = await gh(cwd, ["pr", "checks", url, "--required", "--json", "name,state,bucket,link"]);
    // gh exits 1 on failing checks and 8 on pending ones, with the JSON on stdout anyway.
    let rows: { name?: string; bucket?: string; link?: string }[] | undefined;
    try {
      const parsed = JSON.parse(r.stdout);
      if (Array.isArray(parsed)) rows = parsed;
    } catch {}
    if (!rows) {
      if (/no (required )?checks reported/i.test(`${r.stderr}${r.stdout}`)) return { state: "none", failed: [] };
      throw errorOf(r, "gh pr checks");
    }
    if (rows.length === 0) return { state: "none", failed: [] };
    const failed = rows
      .filter((c) => c.bucket === "fail" || c.bucket === "cancel")
      .map((c) => ({ name: String(c.name ?? "?"), link: String(c.link ?? "") }));
    if (failed.length > 0) return { state: "fail", failed };
    if (rows.some((c) => c.bucket === "pending")) return { state: "pending", failed: [] };
    return { state: "pass", failed: [] };
  },

  async mergePr(_cwd, url, { method, auto }): Promise<MergeResult> {
    const r = await gh(OUTSIDE(), ["pr", "merge", url, `--${method}`, "--delete-branch", ...(auto ? ["--auto"] : [])]);
    if (r.code === 0) return { ok: true };
    const message = `${r.stderr}\n${r.stdout}`.replace(/\s+/g, " ").trim().slice(0, 1000) || `exit ${r.code}`;
    if (r.code === 127 || r.code === 124) throw errorOf(r, "gh pr merge");
    if (/not mergeable|merge conflict|conflicts?/i.test(message)) return { ok: false, kind: "conflict", message };
    if (/protected branch|review|required status|base branch policy|not authorized to merge/i.test(message)) {
      return { ok: false, kind: "protected", message };
    }
    return { ok: false, kind: "other", message };
  },

  async disableAutoMerge(_cwd, url) {
    const r = await gh(OUTSIDE(), ["pr", "merge", url, "--disable-auto"]);
    if (r.code !== 0) throw errorOf(r, "gh pr merge --disable-auto");
  },

  async failedLogs(cwd, link, maxLines) {
    const run = /\/actions\/runs\/(\d+)/.exec(link)?.[1];
    if (!run) return "";
    const repo = repoOf(link);
    const r = await gh(cwd, ["run", "view", run, "--log-failed", ...(repo ? ["-R", repo] : [])], { timeoutMs: 120_000 });
    if (r.code !== 0) throw errorOf(r, "gh run view");
    const lines = r.stdout.replace(/\s+$/, "").split("\n");
    return lines.slice(-maxLines).join("\n");
  },
};
