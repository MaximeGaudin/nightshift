// CI watcher: follows the cards waiting in Merge on their pull request (`checks en attente`, `auto-merge programmé`).
// Any failed check (required or not) writes `## CI` and sends the card back to Review; a PR merged by GitHub's
// auto-merge is cleaned up and the card moves on; green checks mark the card ready, or, with the board's auto-merge on
// and a base that requires no check (GitHub's auto-merge would not wait), Nightshift merges itself. With auto-merge,
// a PR that can no longer merge on its own (auto-merge cancelled by the host, conflict, closed, merge refused) gets a
// new merge cycle: `- Problème :` under `## Merge` and a new run of the Merge column, at most MAX_AUTO_MERGE_CYCLES
// times per entry in the column, then the card needs a human. Polls each project.

import { needsRun } from "../shared/needs-run.ts";
import { mergeStatusLine, parseMergeStatus, writeMergeProblem, writeMergeStatus } from "../shared/pullRequests.ts";
import type { Card, HistoryEntry, LogLine } from "../shared/types.ts";
import type { PrInfo } from "./codehost/codehost.ts";
import type { FastMergeOutcome } from "./fastMerge.ts";
import { ciSection, type PrFlow, prEligibility } from "./prFlow.ts";
import type { PrMode } from "./prMode.ts";
import { applySections } from "./sections.ts";
import type { Project } from "./store.ts";

export const CI_POLL_MS = 60_000;
const REVIEW_SKILL = "nightshift-review";
const MERGE_SKILL = "nightshift-merge";

/** Automatic merge cycles allowed per entry in the Merge column (or per human retry). */
export const MAX_AUTO_MERGE_CYCLES = 3;
/** Start of the history entry written by each automatic merge cycle: the count is read back from the history. */
export const MERGE_RELAUNCH_PREFIX = "CI : relance du merge";
/** History text of `Orchestrator.retry`. */
const USER_RETRY = "Retry requested by user";
const CYCLES_EXHAUSTED = `${MAX_AUTO_MERGE_CYCLES} relances automatiques sans merge, intervention requise`;

/** Automatic merge cycles since the card's last move or the last human retry (persisted through the history). */
export function autoMergeCycles(history: readonly HistoryEntry[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.kind === "moved" || (h.kind === "edited" && h.text === USER_RETRY)) break;
    if (h.kind === "edited" && h.text.startsWith(MERGE_RELAUNCH_PREFIX)) n++;
  }
  return n;
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

export interface CiWatcherHooks {
  /** This process runs the project's agents (holds its lock). */
  canRun(p: Project): boolean;
  /** A run of the card is in progress. */
  isBusy(p: Project, cardId: string): boolean;
  detect(p: Project): Promise<PrMode>;
  prFlow: PrFlow;
  stopTest(p: Project, cardId: string): void;
  log(p: Project, cardId: string, kind: LogLine["kind"], text: string): void;
  /** Queues a new run of the card's column (not explicit: waits for Play when paused); false once the limit is hit. */
  relaunchMerge(p: Project, cardId: string, reason: string): boolean;
  /** Marks the card as needing a human (lastRun `attention`) and rings. */
  needsAttention(p: Project, cardId: string, text: string): void;
}

export class CiWatcher {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly hooks: CiWatcherHooks,
    private readonly intervalMs = CI_POLL_MS,
  ) {}

  /** Starts polling a project and checks it now. */
  start(p: Project) {
    if (!this.timers.has(p.path)) {
      const timer = setInterval(() => void this.pass(p), this.intervalMs);
      timer.unref?.();
      this.timers.set(p.path, timer);
    }
    void this.pass(p);
  }

  stop(p: Project) {
    const t = this.timers.get(p.path);
    if (t) clearInterval(t);
    this.timers.delete(p.path);
  }

  shutdown() {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  /**
   * Not for the watcher right now: a run in progress, a run queued (a new cycle not started yet, paused project
   * included), or a card left for a human after its automatic cycles.
   */
  private idle(p: Project, card: Card): boolean {
    if (this.hooks.isBusy(p, card.id) || needsRun(p.board, card)) return false;
    return !(card.lastRun?.status === "attention" && card.lastRun.columnId === card.columnId);
  }

  /** The cards of the Merge columns waiting on their PR, and idle. */
  private watched(p: Project) {
    const merge = new Set(p.board.columns.filter((c) => c.skill === MERGE_SKILL).map((c) => c.id));
    return p.board.cards
      .filter((c) => merge.has(c.columnId) && this.idle(p, c))
      .map((c) => ({ card: c, status: parseMergeStatus(c.description) }))
      .filter((x) => x.status?.status === "pending" || x.status?.status === "auto");
  }

  /** One pass over a project; a pass already running is reused. Never throws. */
  pass(p: Project): Promise<void> {
    const running = this.inflight.get(p.path);
    if (running) return running;
    const run = this.runPass(p)
      .catch(() => {})
      .finally(() => this.inflight.delete(p.path));
    this.inflight.set(p.path, run);
    return run;
  }

  private async runPass(p: Project) {
    if (!this.hooks.canRun(p) || this.watched(p).length === 0) return;
    const mode = await this.hooks.detect(p);
    if (!mode.active) return;
    for (const { card } of this.watched(p)) {
      await this.hooks.prFlow
        .withCard(p, card.id, () => this.check(p, card.id, mode))
        .catch((e) => {
          this.hooks.log(p, card.id, "error", `CI : ${(e as Error).message}`);
        });
    }
  }

  private async check(p: Project, cardId: string, mode: Extract<PrMode, { active: true }>) {
    // Checked again under the card's lock: a run, a human or another pass may have moved it meanwhile.
    const still = () => {
      const card = p.card(cardId);
      if (!card || !this.idle(p, card)) return undefined;
      if (p.column(card.columnId)?.skill !== MERGE_SKILL) return undefined;
      const s = parseMergeStatus(card.description);
      return s && (s.status === "pending" || s.status === "auto") ? { card, s } : undefined;
    };
    const first = still();
    if (!first) return;
    const { url, status } = first.s;
    const host = mode.host;
    // The PR was left to merge on its own: GitHub's auto-merge, or Nightshift once the checks are green.
    const automatic = status === "auto" || mode.autoMerge;
    const pr = await host.prState(p.path, url);
    if (!pr) return;
    if (pr.state === "MERGED") {
      await this.finishAndAdvance(p, cardId, url, pr, still);
      return;
    }
    if (pr.state === "CLOSED") {
      if (automatic) return this.newCycle(p, cardId, url, "PR fermée sans merge", still, "closed");
      this.writeStatus(p, cardId, url, "closed");
      this.hooks.log(p, cardId, "info", `PR fermée sans merge : ${url}`);
      return;
    }
    // Every check counts, required or not; no check at all waits while the repository has CI workflows (grace).
    const verdict = await this.hooks.prFlow.ciGate(p, cardId, `nightshift/${cardId}`, pr, host);
    if (verdict.state === "fail") {
      if (status === "auto") {
        try {
          await host.disableAutoMerge(p.path, url);
        } catch (e) {
          this.hooks.log(p, cardId, "error", `auto-merge non désactivé : ${(e as Error).message}`);
        }
      }
      const ci = await ciSection(host, p.path, verdict.failed);
      if (!still()) return;
      const review = p.board.columns.find((c) => c.skill === REVIEW_SKILL);
      p.mutate((board) => {
        const card = board.cards.find((c) => c.id === cardId);
        if (!card) return;
        card.description = applySections(card.description, [{ heading: "CI", op: "replace", content: ci }]).text;
        card.updatedAt = new Date().toISOString();
        if (review) p.moveCard(board, cardId, review.id, undefined, "CI");
      });
      this.hooks.log(p, cardId, "info", `CI en échec (${verdict.failed.map((c) => c.name).join(", ")}) : retour en review`);
      return;
    }
    if (automatic && pr.mergeable === "CONFLICTING") {
      if (status === "auto" && pr.autoMerge !== false) {
        try {
          await host.disableAutoMerge(p.path, url);
        } catch (e) {
          this.hooks.log(p, cardId, "error", `auto-merge non désactivé : ${(e as Error).message}`);
        }
      }
      return this.newCycle(p, cardId, url, `conflit avec ${pr.baseRefName || "la base"}`, still);
    }
    // `false` only when the host said so: an unknown state is still waiting on the host.
    if (status === "auto" && pr.autoMerge === false) return this.newCycle(p, cardId, url, "auto-merge annulé par GitHub", still);
    // Green with `auto`: GitHub merges (the next pass sees MERGED). Green with `pending` and the board's auto-merge on:
    // the base requires no check, so GitHub's auto-merge would not have waited; Nightshift merges itself.
    if (verdict.state !== "pass" || status !== "pending") return;
    if (!mode.autoMerge) {
      this.writeStatus(p, cardId, url, "ready");
      this.hooks.log(p, cardId, "info", `checks verts, prêt à merger : ${url}`);
      return;
    }
    if (!still()) return;
    const r = await host.mergePr(p.path, url, { method: mode.mergeMethod, auto: false });
    if (!r.ok) {
      this.hooks.log(p, cardId, "error", `merge par Nightshift refusé : ${r.message.slice(0, 300)}`);
      return this.newCycle(p, cardId, url, `merge refusé : ${oneLine(r.message, 200)}`, still);
    }
    const merged = (await host.prState(p.path, url)) ?? pr;
    await this.finishAndAdvance(p, cardId, url, { ...merged, state: "MERGED" }, still);
  }

  /**
   * A merged PR: local cleanup, `## Merge`, and the card moves on (when it is still where the watcher left it). With
   * nothing local left to clean, it still moves on. A busy local base waits for the next pass.
   */
  private async finishAndAdvance(p: Project, cardId: string, url: string, pr: PrInfo, still: () => unknown) {
    const el = await prEligibility(p.path, cardId, p.card(cardId)?.description ?? "");
    let o: FastMergeOutcome;
    if (el.ok) o = await this.hooks.prFlow.finishMerged(p, cardId, el, pr, () => this.hooks.stopTest(p, cardId));
    else {
      // Merged on the host but nothing local to clean (worktree or branch already gone): the card is done all the same.
      this.hooks.stopTest(p, cardId);
      const merge = [mergeStatusLine(url, "merged", pr.mergeCommit?.slice(0, 7)), `- Nettoyage local : rien à nettoyer (${el.reason})`];
      o = { kind: "merged", summary: `PR mergée : ${url}`, merge: merge.join("\n") };
    }
    if (o.kind !== "merged" || !still()) return;
    p.mutate((board) => {
      const card = board.cards.find((c) => c.id === cardId);
      if (!card) return;
      card.description = applySections(card.description, [{ heading: "Merge", op: "replace", content: o.merge }]).text;
      card.updatedAt = new Date().toISOString();
      const next = p.nextColumnFor(card);
      if (next) p.moveCard(board, cardId, next.id, undefined, "CI");
    });
    this.hooks.log(p, cardId, "info", o.summary);
  }

  /**
   * A problem keeps the PR from merging on its own: writes `- Problème :` under `## Merge` (and the status line, when
   * given) and starts a new run of the Merge column; past the limit, the card needs a human instead. Synchronous from
   * the `still()` check to the relaunch, so nothing moves the card in between.
   */
  private newCycle(p: Project, cardId: string, url: string, reason: string, still: () => unknown, status?: "closed") {
    if (!still()) return;
    const write = (text: string) =>
      p.mutate((board) => {
        const card = board.cards.find((c) => c.id === cardId);
        if (!card) return;
        const d = status ? writeMergeStatus(card.description, url, status) : card.description;
        card.description = writeMergeProblem(d, text);
        card.updatedAt = new Date().toISOString();
      });
    write(reason);
    if (this.hooks.relaunchMerge(p, cardId, reason)) {
      this.hooks.log(p, cardId, "info", `${reason} : nouveau cycle de merge (${url})`);
      return;
    }
    write(CYCLES_EXHAUSTED);
    this.hooks.needsAttention(p, cardId, `Merge : ${CYCLES_EXHAUSTED} (${reason})`);
    this.hooks.log(p, cardId, "error", `${reason} : ${CYCLES_EXHAUSTED} (${url})`);
  }

  private writeStatus(p: Project, cardId: string, url: string, status: "ready" | "closed" | "merged", sha?: string) {
    p.mutate((board) => {
      const card = board.cards.find((c) => c.id === cardId);
      if (!card) return;
      card.description = writeMergeStatus(card.description, url, status, sha);
      card.updatedAt = new Date().toISOString();
    });
  }
}
