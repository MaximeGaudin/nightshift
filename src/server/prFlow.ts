// Pull request flow, server side and deterministic: after a successful review the card branch is pushed and its PR
// created or updated; in Merge the PR is merged through the code host, then the card is cleaned up locally.
// Agents only see the deviations (conflict, closed PR, branch protection), through the fast merge fallback block.
// One operation at a time per card: afterReview, tryPrMerge and the CI watcher share `withCard`.

import { rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPrBody,
  buildPrTitle,
  type MergeStatusKind,
  mergeStatusLine,
  parseMergeStatus,
  section,
  setSectionPrLine,
} from "../shared/pullRequests.ts";
import type { LogLine } from "../shared/types.ts";
import { type ChecksSummary, type CodeHost, CodeHostError, type FailedCheck, type PrInfo } from "./codehost/codehost.ts";
import {
  acquireMergeLock,
  cleanupCardWorktree,
  type FastMergeOutcome,
  LOCK_DIR,
  parseResultFields,
  parseWorktrees,
  stopWorktreeProcesses,
} from "./fastMerge.ts";
import { git, gitLine } from "./git.ts";
import type { PrMode } from "./prMode.ts";
import type { Project } from "./store.ts";

type ActiveMode = Extract<PrMode, { active: true }>;

export type PrMergeOutcome =
  | FastMergeOutcome
  | { kind: "waiting"; status: Extract<MergeStatusKind, "pending" | "auto">; summary: string; merge: string }
  | { kind: "toReview"; summary: string; ci: string }
  | { kind: "ineligible"; reason: string };

export interface PrFlowHooks {
  log(p: Project, cardId: string, kind: LogLine["kind"], text: string): void;
  /** Clock of the no-checks grace (ms since epoch); `Date.now` by default. */
  now?: () => number;
}

/** How long a PR head of a repository with CI workflows may show no check at all before it merges without CI. */
export const CI_NO_CHECKS_GRACE_MS = 10 * 60_000;

/** The CI gate's answer: red (with the failed checks), still running, or green (`noCi`: no check came at all). */
export type CiVerdict = { state: "fail"; failed: FailedCheck[] } | { state: "pending" } | { state: "pass"; noCi?: true };

/**
 * Decides whether every check of a PR is green. `none` (no check reported) is green only in a repository without CI
 * workflows, or once `graceMs` have passed since `noChecksSince` (the first time this head showed no check).
 */
export function ciVerdict(input: {
  checks: ChecksSummary;
  hasWorkflows: boolean;
  noChecksSince: number;
  now: number;
  graceMs: number;
}): CiVerdict {
  const { checks } = input;
  if (checks.state === "fail") return { state: "fail", failed: checks.failed };
  if (checks.state === "pending") return { state: "pending" };
  if (checks.state === "pass") return { state: "pass" };
  if (!input.hasWorkflows) return { state: "pass" };
  if (input.now - input.noChecksSince < input.graceMs) return { state: "pending" };
  return { state: "pass", noCi: true };
}

/** The branch holds at least one GitHub Actions workflow; a git error counts as yes (the grace bounds the wait). */
async function hasWorkflows(cwd: string, branch: string): Promise<boolean> {
  const r = await git(cwd, ["ls-tree", "--name-only", branch, ".github/workflows/"]);
  if (r.code !== 0) return true;
  return r.stdout.split("\n").some((l) => /\.ya?ml$/i.test(l.trim()));
}

/** Log lines kept per failed check in `## CI`, and the cap of the whole section. */
export const CI_LOG_LINES = 200;
export const CI_SECTION_MAX = 20_000;

/** gh's refusal when a required status check has not reported (or not passed) yet. */
const REQUIRED_STATUS_PENDING =
  /required status checks? .*(expected|pending|in progress|not (yet )?(been )?(reported|completed))|status checks? (are|is) (expected|pending)/i;

const NOTHING_CHANGED = "nothing changed: the PR, the base and the card worktree are as before";
const short = (sha: string) => sha.slice(0, 7);
const oneLine = (s: string, max = 300) => s.replace(/\s+/g, " ").trim().slice(0, max);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Branch, base and worktree of a card that can go through a pull request, or why it cannot. */
export type Eligibility = { ok: true; branch: string; base: string } | { ok: false; reason: string };

/**
 * A card goes through a PR when `## Result` names a worktree (not `none`) and a base that exists on origin.
 * Anything else stays on the local flow.
 */
export async function prEligibility(cwd: string, cardId: string, description: string): Promise<Eligibility> {
  const fields = parseResultFields(description, { allowMerge: true });
  if ("missing" in fields) return { ok: false, reason: fields.missing };
  if (fields.worktree === "none") return { ok: false, reason: "Worktree: none (no card branch)" };
  const r = await git(cwd, ["ls-remote", "--heads", "origin", fields.base], { timeoutMs: 30_000 });
  if (r.code !== 0) return { ok: false, reason: `git ls-remote origin: ${oneLine(r.stderr)}` };
  if (!r.stdout.trim()) return { ok: false, reason: `base ${fields.base} is not on origin` };
  return { ok: true, branch: `nightshift/${cardId}`, base: fields.base };
}

/** `## CI` content: one line per failed check, then the log excerpt of each CI run. */
export async function ciSection(host: CodeHost, cwd: string, failed: FailedCheck[]): Promise<string> {
  const lines = failed.map((c) => `- ${c.name} : ${c.link || "(no link)"}`);
  const blocks: string[] = [];
  for (const c of failed) {
    let log = "";
    try {
      log = await host.failedLogs(cwd, c.link, CI_LOG_LINES);
    } catch (e) {
      log = `(logs unavailable: ${messageOf(e)})`;
    }
    if (log.trim()) blocks.push(`${c.name} :\n\n\`\`\`\n${log.replace(/```/g, "ʼʼʼ")}\n\`\`\``);
  }
  let text = [lines.join("\n"), ...blocks].join("\n\n");
  if (text.length > CI_SECTION_MAX) text = `${text.slice(0, CI_SECTION_MAX - 20)}\n\`\`\`\n…`;
  return text;
}

export class PrFlow {
  private chains = new Map<string, Promise<unknown>>();
  /** First time each PR head (`<url>@<sha>`) showed no check at all, for the no-checks grace. In memory only. */
  private noChecks = new Map<string, { since: number; logged: boolean }>();

  constructor(private readonly hooks: PrFlowHooks) {}

  private now() {
    return (this.hooks.now ?? Date.now)();
  }

  /**
   * The CI gate of the Merge column and the CI watcher: every check of the PR head (required or not) must be green.
   * Call it under the card's `withCard` (it does not take the lock itself).
   */
  async ciGate(p: Project, cardId: string, branch: string, pr: PrInfo, host: CodeHost): Promise<CiVerdict> {
    const key = `${pr.url}@${pr.headSha ?? ""}`;
    const checks = await host.checks(p.path, pr.url, { all: true });
    if (checks.state !== "none") {
      this.noChecks.delete(key);
      return ciVerdict({ checks, hasWorkflows: true, noChecksSince: 0, now: 0, graceMs: 0 });
    }
    const workflows = await hasWorkflows(p.path, branch);
    const now = this.now();
    const entry = this.noChecks.get(key) ?? { since: now, logged: false };
    if (workflows) this.noChecks.set(key, entry);
    const verdict = ciVerdict({ checks, hasWorkflows: workflows, noChecksSince: entry.since, now, graceMs: CI_NO_CHECKS_GRACE_MS });
    if (verdict.state === "pass" && verdict.noCi && !entry.logged) {
      entry.logged = true;
      this.hooks.log(p, cardId, "info", `aucun check après ${Math.round(CI_NO_CHECKS_GRACE_MS / 60_000)} min : merge sans CI`);
    }
    return verdict;
  }

  /** Forgets the no-checks grace of every head of a PR (merged or closed). */
  private forgetNoChecks(url: string) {
    for (const k of this.noChecks.keys()) if (k.startsWith(`${url}@`)) this.noChecks.delete(k);
  }

  /** Runs `fn` after every earlier operation of the same card has finished. */
  withCard<T>(p: Project, cardId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${p.path}\0${cardId}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }

  /** Writes `- PR: <value>` under `## Review`. */
  private setReviewPr(p: Project, cardId: string, value: string) {
    p.mutate((board) => {
      const card = board.cards.find((c) => c.id === cardId);
      if (!card) return;
      const next = setSectionPrLine(card.description, "Review", value);
      if (next === card.description) return;
      card.description = next;
      card.updatedAt = new Date().toISOString();
      p.addHistory(card, "edited", `PR: ${value}`);
    });
  }

  /**
   * Pushes the card branch (never forced), then finds its PR: updates an open one when `update`, creates one when
   * there is none (a draft when `draft`). A closed or merged PR is returned as is: the merge path decides.
   */
  private async ensurePr(
    p: Project,
    cardId: string,
    el: Extract<Eligibility, { ok: true }>,
    host: CodeHost,
    update: boolean,
    draft = false,
  ) {
    const card = p.card(cardId);
    if (!card) throw new Error("card not found");
    const pushArgs = ["push", "-u", "origin", el.branch];
    const push = await git(p.path, pushArgs);
    if (push.code !== 0) throw new Error(`${gitLine(p.path, pushArgs)}: ${oneLine(`${push.stderr}\n${push.stdout}`)}`);
    const existing = await host.findPr(p.path, el.branch);
    if (existing && existing.state !== "OPEN") return existing;
    if (existing) {
      if (update) await host.updatePr(p.path, existing.url, { title: buildPrTitle(card), body: buildPrBody(card, existing.body) });
      return existing;
    }
    const url = await host.createPr(p.path, { base: el.base, head: el.branch, title: buildPrTitle(card), body: buildPrBody(card), draft });
    return (
      (await host.prState(p.path, url)) ?? {
        url,
        number: 0,
        state: "OPEN",
        body: "",
        mergeable: "UNKNOWN",
        baseRefName: el.base,
        isDraft: draft,
      }
    );
  }

  /**
   * A card enters Review: push, open a draft PR (or turn its open ready PR back into a draft, auto-merge disabled
   * first when `## Merge` says it is scheduled), write `- PR:` under `## Review`. Never throws, never blocks the review.
   */
  beforeReview(p: Project, cardId: string, mode: ActiveMode): Promise<void> {
    return this.withCard(p, cardId, async () => {
      const card = p.card(cardId);
      if (!card) return;
      const el = await prEligibility(p.path, cardId, card.description);
      if (!el.ok) {
        this.hooks.log(p, cardId, "info", `mode PR ignoré : ${el.reason}`);
        return;
      }
      const host = mode.host;
      let pr: PrInfo;
      try {
        pr = await this.ensurePr(p, cardId, el, host, false, true);
      } catch (e) {
        this.hooks.log(p, cardId, "error", `PR draft non créée : ${oneLine(messageOf(e), 200)}`);
        return;
      }
      if (pr.state !== "OPEN") return;
      if (!pr.isDraft) {
        if (parseMergeStatus(p.card(cardId)?.description ?? "")?.status === "auto") {
          try {
            await host.disableAutoMerge(p.path, pr.url);
          } catch (e) {
            this.hooks.log(p, cardId, "error", `auto-merge non désactivé : ${oneLine(messageOf(e), 200)}`);
          }
        }
        try {
          await host.markDraft(p.path, pr.url);
        } catch (e) {
          this.hooks.log(p, cardId, "error", `PR non repassée en draft : ${oneLine(messageOf(e), 200)}`);
          return;
        }
      }
      this.setReviewPr(p, cardId, pr.url);
      this.hooks.log(p, cardId, "info", `PR draft : ${pr.url}`);
    });
  }

  /**
   * After a successful review: push, create or update the PR, mark a draft ready, write `- PR:` under `## Review`.
   * Never throws.
   */
  afterReview(p: Project, cardId: string, mode: ActiveMode): Promise<void> {
    return this.withCard(p, cardId, async () => {
      const card = p.card(cardId);
      if (!card) return;
      const el = await prEligibility(p.path, cardId, card.description);
      if (!el.ok) {
        this.hooks.log(p, cardId, "info", `mode PR ignoré : ${el.reason}`);
        return;
      }
      try {
        const pr = await this.ensurePr(p, cardId, el, mode.host, true);
        if (pr.state === "OPEN" && pr.isDraft) {
          try {
            await mode.host.markReady(p.path, pr.url);
          } catch (e) {
            const reason = oneLine(messageOf(e), 200);
            this.setReviewPr(p, cardId, `${pr.url} — failed to mark ready: ${reason}`);
            this.hooks.log(p, cardId, "error", `PR non passée en ready : ${reason}`);
            return;
          }
          this.setReviewPr(p, cardId, pr.url);
          this.hooks.log(p, cardId, "info", `PR prête : ${pr.url}`);
          return;
        }
        this.setReviewPr(p, cardId, pr.url);
        this.hooks.log(p, cardId, "info", `PR ${pr.state === "OPEN" ? "à jour" : pr.state.toLowerCase()} : ${pr.url}`);
      } catch (e) {
        const reason = oneLine(messageOf(e), 200);
        this.setReviewPr(p, cardId, `failed — ${reason}`);
        this.hooks.log(p, cardId, "error", `PR non créée : ${reason}`);
      }
    });
  }

  /**
   * Merge column in PR mode. `ineligible` sends the orchestrator back to the local fast merge; `fallback` starts the
   * merge agent; `waiting` keeps the card in Merge; `toReview` sends it back to Review with `## CI`.
   */
  tryPrMerge(input: {
    p: Project;
    cardId: string;
    mode: ActiveMode;
    stopTest: () => void;
    isCancelled: () => boolean;
  }): Promise<PrMergeOutcome> {
    const { p, cardId, mode } = input;
    const host = mode.host;
    return this.withCard(p, cardId, async (): Promise<PrMergeOutcome> => {
      const card = p.card(cardId);
      if (!card) return { kind: "ineligible", reason: "card not found" };
      const el = await prEligibility(p.path, cardId, card.description);
      if (!el.ok) return { kind: "ineligible", reason: el.reason };
      const fallback = (step: string, command: string, error: string, merge?: string): PrMergeOutcome => ({
        kind: "fallback",
        step,
        command,
        error: error || "(no message)",
        state: NOTHING_CHANGED,
        ...(merge ? { merge } : {}),
      });
      try {
        let pr: PrInfo | null = await host.findPr(p.path, el.branch);
        if (!pr || pr.state === "OPEN") {
          // Also pushes commits made since the review (none, normally); creates the PR when the review could not.
          pr = await this.ensurePr(p, cardId, el, host, false);
          if (!prUrlUnderReview(p.card(cardId)?.description ?? "")) this.setReviewPr(p, cardId, pr.url);
        }
        if (input.isCancelled()) return { kind: "cancelled" };
        if (pr.state === "MERGED") return await this.finishMerged(p, cardId, el, pr, input.stopTest);
        if (pr.state === "CLOSED") {
          return fallback(
            "pr-closed",
            `gh pr view ${pr.url}`,
            "the pull request was closed without being merged",
            mergeStatusLine(pr.url, "closed"),
          );
        }
        if (pr.isDraft) {
          try {
            await host.markReady(p.path, pr.url);
          } catch (e) {
            return fallback("pr-ready", `gh pr ready ${pr.url}`, messageOf(e));
          }
          pr = { ...pr, isDraft: false };
        }
        // Every check counts, required or not: a red or running check never merges.
        const verdict = await this.ciGate(p, cardId, el.branch, pr, host);
        if (verdict.state === "fail") {
          return {
            kind: "toReview",
            summary: `CI en échec sur ${pr.url} : retour en review`,
            ci: await ciSection(host, p.path, verdict.failed),
          };
        }
        // Checks still running: wait in Merge (the CI watcher follows), or let GitHub's auto-merge wait for them, which
        // it only does for required checks: on a base without any, GitHub would merge at once.
        const waitForChecks = async (url: string): Promise<PrMergeOutcome> => {
          if (!mode.autoMerge || !(await host.requiredChecks(p.path, el.base))) {
            return {
              kind: "waiting",
              status: "pending",
              summary: `PR en attente des checks : ${url}`,
              merge: mergeStatusLine(url, "pending"),
            };
          }
          const r = await host.mergePr(p.path, url, { method: mode.mergeMethod, auto: true });
          if (!r.ok) return fallback(`pr-${r.kind}`, `gh pr merge ${url} --${mode.mergeMethod} --auto`, r.message);
          return { kind: "waiting", status: "auto", summary: `auto-merge programmé : ${url}`, merge: mergeStatusLine(url, "auto") };
        };
        if (verdict.state === "pending") return await waitForChecks(pr.url);
        if (pr.mergeable === "CONFLICTING") {
          return fallback("pr-conflict", `gh pr view ${pr.url} --json mergeable`, `${pr.url} conflicts with ${el.base}`);
        }
        const r = await host.mergePr(p.path, pr.url, { method: mode.mergeMethod, auto: false });
        // Right after a push the required checks may not have reported yet: GitHub refuses the merge for a missing
        // required status. That is a pending check, not a protection to escalate.
        if (!r.ok && r.kind === "protected" && REQUIRED_STATUS_PENDING.test(r.message)) return await waitForChecks(pr.url);
        if (!r.ok) return fallback(`pr-${r.kind}`, `gh pr merge ${pr.url} --${mode.mergeMethod} --delete-branch`, r.message);
        if (input.isCancelled()) return { kind: "cancelled" };
        const merged = (await host.prState(p.path, pr.url)) ?? pr;
        return await this.finishMerged(p, cardId, el, { ...merged, state: "MERGED" }, input.stopTest);
      } catch (e) {
        const kind = e instanceof CodeHostError ? e.kind : "other";
        return fallback(`pr-${kind}`, "", messageOf(e));
      }
    });
  }

  /**
   * The PR is merged on the host: fast-forwards the local base when its checkout is clean, removes the worktree and
   * the local branches (`-D`: squash and rebase leave the branch out of the base), and writes `## Merge`.
   */
  async finishMerged(
    p: Project,
    cardId: string,
    el: Extract<Eligibility, { ok: true }>,
    pr: PrInfo,
    stopTest: () => void,
  ): Promise<FastMergeOutcome> {
    this.forgetNoChecks(pr.url);
    const cwd = p.path;
    const { branch, base } = el;
    const worktree = parseWorktrees((await git(cwd, ["worktree", "list", "--porcelain"])).stdout).find((w) => w.branch === branch)?.path;
    stopTest();
    let testLine = "- Test environment: none running";
    if (worktree) {
      const s = await stopWorktreeProcesses(worktree);
      if (s.stopped.length > 0) testLine = `- Test environment: stopped ${s.stopped.join(", ")}`;
    }
    const common = (await git(cwd, ["rev-parse", "--git-common-dir"])).stdout.trim();
    const lock = await acquireMergeLock(resolve(cwd, common || ".git", LOCK_DIR), cardId, {
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      check: () => {},
    });
    if (!lock.ok) {
      const merge = [
        mergeStatusLine(pr.url, "merged", short(pr.mergeCommit ?? "")),
        `- the local base is busy: lock held by ${lock.owner}`,
      ].join("\n");
      return { kind: "busy", summary: `PR mergée, nettoyage local en attente (verrou tenu par ${lock.owner})`, merge, owner: lock.owner };
    }
    try {
      const fetch = await git(cwd, ["fetch", "origin"]);
      const notes = [...lock.notes];
      if (fetch.code !== 0) notes.push(`- Fetch: failed (${oneLine(fetch.stderr)})`);
      const remoteSha = (await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`])).stdout.trim();
      const sha = pr.mergeCommit || remoteSha;
      let baseLine = `- Base locale : ${base} non mise à jour (origin/${base} introuvable)`;
      if (remoteSha) {
        const checkout = parseWorktrees((await git(cwd, ["worktree", "list", "--porcelain"])).stdout).find((w) => w.branch === base)?.path;
        const ancestor = (await git(cwd, ["merge-base", "--is-ancestor", `refs/heads/${base}`, remoteSha])).code === 0;
        if (!ancestor) baseLine = `- Base locale : ${base} diverge de origin/${base}, non mise à jour`;
        else if (checkout) {
          const dirty = (await git(checkout, ["status", "--porcelain", "--untracked-files=no"])).stdout.trim();
          if (dirty) baseLine = `- Base locale : ${base} non mise à jour (checkout ${checkout} modifié)`;
          else {
            const ff = await git(checkout, ["merge", "--ff-only", remoteSha]);
            baseLine =
              ff.code === 0
                ? `- Base locale : ${base} fast-forward à ${short(remoteSha)}`
                : `- Base locale : fast-forward échoué (${oneLine(ff.stderr)})`;
          }
        } else {
          const u = await git(cwd, ["update-ref", `refs/heads/${base}`, remoteSha]);
          baseLine =
            u.code === 0
              ? `- Base locale : ${base} avancée à ${short(remoteSha)}`
              : `- Base locale : non mise à jour (${oneLine(u.stderr)})`;
        }
      }
      const clean = await cleanupCardWorktree(cwd, worktree, branch, { force: true });
      const merge = [
        ...notes,
        mergeStatusLine(pr.url, "merged", short(sha || "?")),
        `- Into: ${base}`,
        testLine,
        baseLine,
        clean.worktreeLine,
        clean.branchLine,
        "- Card branch deleted on origin: by gh pr merge --delete-branch",
      ].join("\n");
      return { kind: "merged", summary: `PR mergée : ${pr.url} (${short(sha || "?")})`, merge };
    } finally {
      rmSync(lock.path, { recursive: true, force: true });
    }
  }
}

function prUrlUnderReview(description: string): boolean {
  const body = section(description, "Review");
  return body !== undefined && /^\s*[-*]\s*PR\s*:\s*https?:\/\//im.test(body);
}
