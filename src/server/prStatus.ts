// PR status poller: the CI state of the pull request of each card, for display only. In memory (nothing is written to
// the note nor the board), pushed to the clients in the project snapshot. Unlike CiWatcher it looks at every card that
// carries a PR URL (not only those waiting in Merge), counts every check (not only the required ones), and never acts.

import { type PrCiStatus, prUrlOf } from "../shared/pullRequests.ts";
import { isDoneColumn } from "../shared/types.ts";
import type { PrMode } from "./prMode.ts";
import type { Project } from "./store.ts";

export const PR_STATUS_POLL_MS = 2 * 60_000;
/** A status younger than this is not fetched again when a card is opened. */
export const REFRESH_STALE_MS = 30_000;
/** Consecutive failed fetches after which the last known status is dropped. */
const MAX_FAILURES = 2;

export interface PrStatusHooks {
  detect(p: Project): Promise<PrMode>;
  /** The visible status of at least one card of the project changed. */
  onChange(p: Project): void;
}

interface Entry {
  status: PrCiStatus;
  failures: number;
}

/** What a client can see of a status: a new `checkedAt` alone changes nothing on screen. */
const visible = (s: PrCiStatus) => `${s.url}\n${s.state}\n${s.failed.map((f) => `${f.name}|${f.link}`).join("\n")}`;

export class PrStatusPoller {
  private entries = new Map<string, Map<string, Entry>>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private inflight = new Map<string, Promise<void>>();
  private fetching = new Map<string, Promise<void>>();

  constructor(
    private readonly hooks: PrStatusHooks,
    private readonly intervalMs = PR_STATUS_POLL_MS,
    private readonly now: () => number = Date.now,
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
    this.entries.delete(p.path);
  }

  shutdown() {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.entries.clear();
  }

  /** The known statuses of a project, by card id. */
  status(p: Project): Record<string, PrCiStatus> {
    const out: Record<string, PrCiStatus> = {};
    for (const [id, e] of this.entries.get(p.path) ?? []) out[id] = e.status;
    return out;
  }

  /** The cards whose PR is worth looking at: a PR URL, and not in Done. */
  private watched(p: Project) {
    const out: { id: string; url: string }[] = [];
    for (const card of p.board.cards) {
      if (isDoneColumn(card.columnId)) continue;
      const url = prUrlOf(card.description);
      if (url) out.push({ id: card.id, url });
    }
    return out;
  }

  private map(p: Project) {
    const existing = this.entries.get(p.path);
    if (existing) return existing;
    const m = new Map<string, Entry>();
    this.entries.set(p.path, m);
    return m;
  }

  /** Drops the entries of cards no longer watched or whose PR URL changed; true when one was dropped. */
  private prune(p: Project, watched: { id: string; url: string }[]): boolean {
    const m = this.entries.get(p.path);
    if (!m) return false;
    const urls = new Map(watched.map((w) => [w.id, w.url]));
    let dropped = false;
    for (const [id, e] of m) {
      if (urls.get(id) !== e.status.url) {
        m.delete(id);
        dropped = true;
      }
    }
    return dropped;
  }

  /** One pass over a project; a pass already running is reused. Never throws. */
  pass(p: Project): Promise<void> {
    const running = this.inflight.get(p.path);
    if (running) return running;
    const run = this.runPass(p)
      .catch((e) => console.error(`PR status: ${(e as Error).message}`))
      .finally(() => this.inflight.delete(p.path));
    this.inflight.set(p.path, run);
    return run;
  }

  private async runPass(p: Project) {
    const mode = await this.hooks.detect(p);
    if (!mode.active) {
      if ((this.entries.get(p.path)?.size ?? 0) > 0) {
        this.entries.delete(p.path);
        this.hooks.onChange(p);
      }
      return;
    }
    const watched = this.watched(p);
    let changed = this.prune(p, watched);
    for (const { id, url } of watched) {
      const known = this.entries.get(p.path)?.get(id)?.status;
      // A merged or closed PR does not change any more: polling stops until the URL does.
      if (known && known.url === url && (known.state === "merged" || known.state === "closed")) continue;
      if (await this.fetchCard(p, id, url, mode)) changed = true;
    }
    if (changed) this.hooks.onChange(p);
  }

  /** Fetches one card's PR, deduped with a fetch already running; true when the visible status changed. */
  private async fetchCard(p: Project, cardId: string, url: string, mode: Extract<PrMode, { active: true }>): Promise<boolean> {
    const key = `${p.path}\0${cardId}`;
    const running = this.fetching.get(key);
    if (running) {
      await running;
      return false;
    }
    let changed = false;
    const run = this.doFetch(p, cardId, url, mode)
      .then((c) => {
        changed = c;
      })
      .finally(() => this.fetching.delete(key));
    this.fetching.set(key, run);
    await run;
    return changed;
  }

  private async doFetch(p: Project, cardId: string, url: string, mode: Extract<PrMode, { active: true }>): Promise<boolean> {
    const m = this.map(p);
    const before = m.get(cardId);
    try {
      const pr = await mode.host.prState(p.path, url);
      if (!pr) throw new Error(`pull request not found: ${url}`);
      let state: PrCiStatus["state"];
      let failed: PrCiStatus["failed"] = [];
      if (pr.state === "MERGED") state = "merged";
      else if (pr.state === "CLOSED") state = "closed";
      else if (pr.mergeable === "CONFLICTING") state = "conflict";
      else {
        const checks = await mode.host.checks(p.path, url, { all: true });
        state = checks.state;
        if (checks.state === "fail") failed = checks.failed;
      }
      // The card may have moved on to another PR or left the board while the host answered.
      if (prUrlOf(p.card(cardId)?.description ?? "") !== url) return false;
      const status: PrCiStatus = { url, state, failed, checkedAt: new Date(this.now()).toISOString() };
      m.set(cardId, { status, failures: 0 });
      return !before || visible(before.status) !== visible(status);
    } catch (e) {
      console.error(`PR status ${url}: ${(e as Error).message}`);
      if (!before) return false;
      before.failures++;
      if (before.failures < MAX_FAILURES) return false;
      m.delete(cardId);
      return true;
    }
  }

  /** Fetches a card's status now, unless it is younger than REFRESH_STALE_MS. Never throws. */
  async refresh(p: Project, cardId: string): Promise<PrCiStatus | null> {
    try {
      const card = p.card(cardId);
      const url = card && !isDoneColumn(card.columnId) ? prUrlOf(card.description) : undefined;
      if (!url) return null;
      const known = this.entries.get(p.path)?.get(cardId)?.status;
      const fresh = known && known.url === url && this.now() - Date.parse(known.checkedAt) < REFRESH_STALE_MS;
      if (!fresh) {
        const mode = await this.hooks.detect(p);
        if (mode.active && (await this.fetchCard(p, cardId, url, mode))) this.hooks.onChange(p);
      }
    } catch (e) {
      console.error(`PR status refresh: ${(e as Error).message}`);
    }
    const s = this.entries.get(p.path)?.get(cardId)?.status;
    return s && s.url === prUrlOf(p.card(cardId)?.description ?? "") ? s : null;
  }
}
