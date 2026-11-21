// CI watcher: follows the cards waiting in Merge on their pull request (`checks en attente`, `auto-merge programmé`).
// A failed required check writes `## CI` and sends the card back to Review; a PR merged by GitHub's auto-merge is
// cleaned up and the card moves on; green checks without auto-merge mark the card ready. Polls each open project.

import { parseMergeStatus, writeMergeStatus } from "../shared/pullRequests.ts";
import type { LogLine } from "../shared/types.ts";
import { ciSection, type PrFlow, prEligibility } from "./prFlow.ts";
import type { PrMode } from "./prMode.ts";
import { applySections } from "./sections.ts";
import type { Project } from "./store.ts";

export const CI_POLL_MS = 5 * 60_000;
const REVIEW_SKILL = "nightshift-review";
const MERGE_SKILL = "nightshift-merge";

export interface CiWatcherHooks {
  /** This process runs the project's agents (holds its lock). */
  canRun(p: Project): boolean;
  /** A run of the card is in progress. */
  isBusy(p: Project, cardId: string): boolean;
  detect(p: Project): Promise<PrMode>;
  prFlow: PrFlow;
  stopTest(p: Project, cardId: string): void;
  log(p: Project, cardId: string, kind: LogLine["kind"], text: string): void;
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

  /** The cards of the Merge columns waiting on their PR, and not running. */
  private watched(p: Project) {
    const merge = new Set(p.board.columns.filter((c) => c.skill === MERGE_SKILL).map((c) => c.id));
    return p.board.cards
      .filter((c) => merge.has(c.columnId) && !this.hooks.isBusy(p, c.id))
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
      if (!card || this.hooks.isBusy(p, cardId)) return undefined;
      if (p.column(card.columnId)?.skill !== MERGE_SKILL) return undefined;
      const s = parseMergeStatus(card.description);
      return s && (s.status === "pending" || s.status === "auto") ? { card, s } : undefined;
    };
    const first = still();
    if (!first) return;
    const { url, status } = first.s;
    const host = mode.host;
    const pr = await host.prState(p.path, url);
    if (!pr) return;
    if (pr.state === "MERGED") {
      const el = await prEligibility(p.path, cardId, first.card.description);
      if (!el.ok) {
        this.writeStatus(p, cardId, url, "merged", pr.mergeCommit?.slice(0, 7));
        return;
      }
      const o = await this.hooks.prFlow.finishMerged(p, cardId, el, pr, () => this.hooks.stopTest(p, cardId));
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
      return;
    }
    if (pr.state === "CLOSED") {
      this.writeStatus(p, cardId, url, "closed");
      this.hooks.log(p, cardId, "info", `PR fermée sans merge : ${url}`);
      return;
    }
    const checks = await host.checks(p.path, url);
    if (checks.state === "fail") {
      if (status === "auto") {
        try {
          await host.disableAutoMerge(p.path, url);
        } catch (e) {
          this.hooks.log(p, cardId, "error", `auto-merge non désactivé : ${(e as Error).message}`);
        }
      }
      const ci = await ciSection(host, p.path, checks.failed);
      if (!still()) return;
      const review = p.board.columns.find((c) => c.skill === REVIEW_SKILL);
      p.mutate((board) => {
        const card = board.cards.find((c) => c.id === cardId);
        if (!card) return;
        card.description = applySections(card.description, [{ heading: "CI", op: "replace", content: ci }]).text;
        card.updatedAt = new Date().toISOString();
        if (review) p.moveCard(board, cardId, review.id, undefined, "CI");
      });
      this.hooks.log(p, cardId, "info", `CI en échec (${checks.failed.map((c) => c.name).join(", ")}) : retour en review`);
      return;
    }
    // `none` here means the required checks have not reported yet (a PR without required checks never waits).
    if (checks.state === "pass" && status === "pending") {
      this.writeStatus(p, cardId, url, "ready");
      this.hooks.log(p, cardId, "info", `checks verts, prêt à merger : ${url}`);
    }
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
