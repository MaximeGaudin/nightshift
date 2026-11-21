// Generic issue sync: imports the open issues of each source into Backlog, follows upstream edits and closes while
// the card is still in Backlog, and writes back (comment + close) when an imported card reaches Done.
// No provider-specific code here: providers come from the registry.

import {
  type CardExternal,
  type ExternalIssue,
  type IssueSource,
  type IssueSourceStatus,
  matchesLabels,
  providerLabel,
} from "../../shared/issues.ts";
import { BACKLOG_COLUMN_ID, BACKLOG_COLUMN_NAME, type Card, cardRef, DONE_COLUMN_ID } from "../../shared/types.ts";
import type { Project } from "../store.ts";
import type { IssueProvider } from "./provider.ts";
import { providerFor } from "./registry.ts";
import { getToken, hasToken } from "./tokens.ts";

export const SYNC_INTERVAL_MS = 5 * 60_000;

export interface IssueSyncHooks {
  /** True when this process runs the project's agents: the only one allowed to sync and write back. */
  canRun(p: Project): boolean;
  /** Live status changed: broadcast the project snapshot. */
  onState(p: Project): void;
  /** Removes the files kept for a deleted card (screenshots, logs). */
  purge(p: Project, cardId: string): void;
}

interface LiveState {
  syncing: boolean;
  lastSyncAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  writeBackError?: string;
  writeBackErrorAt?: string;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const newer = (a: string, b: string) => {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isNaN(ta) || Number.isNaN(tb) ? a !== b : ta > tb;
};
const sameTarget = (a: IssueSource, b: IssueSource) => a.provider === b.provider && a.baseUrl === b.baseUrl && a.repo === b.repo;
/** Same target, label filter and query: a plan fetched for one source config is only applied to that config. */
const sameConfig = (a: IssueSource, b: IssueSource) =>
  sameTarget(a, b) && JSON.stringify(a.labels ?? []) === JSON.stringify(b.labels ?? []) && (a.query ?? "") === (b.query ?? "");

/** Card description built from an issue: its body, then a link back to it. */
export function issueDescription(issue: Pick<ExternalIssue, "body" | "url">): string {
  const body = issue.body.trim();
  return body ? `${body}\n\nSource: ${issue.url}` : `Source: ${issue.url}`;
}

const issueTitle = (issue: ExternalIssue) => issue.title.trim() || "Untitled";
const refOf = (src: Pick<IssueSource, "provider" | "repo">, n: number) => `${providerLabel(src.provider)} ${src.repo}#${n}`;

export class IssueSync {
  private readonly hooks: IssueSyncHooks;
  private readonly intervalMs: number;
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  /** In-flight sync per `path::sourceId`: a trigger during a sync gets the running one. */
  private inflight = new Map<string, Promise<void>>();
  /** One follow-up sync per `path::sourceId`, queued when a trigger arrives during a sync (the source may have changed). */
  private queued = new Map<string, Promise<void>>();
  /** Live state per project path, then per source id. */
  private states = new Map<string, Map<string, LiveState>>();
  private writeBackScheduled = new Set<string>();
  /** `path::cardId` of every write-back started by this process: never attempted twice. */
  private writeBackStarted = new Set<string>();

  constructor(hooks: IssueSyncHooks, { intervalMs = SYNC_INTERVAL_MS }: { intervalMs?: number } = {}) {
    this.hooks = hooks;
    this.intervalMs = intervalMs;
  }

  /** Starts the polling of a project and syncs it now (when this process may). */
  start(p: Project) {
    if (!this.timers.has(p.path)) {
      const timer = setInterval(() => void this.syncAll(p), this.intervalMs);
      timer.unref?.();
      this.timers.set(p.path, timer);
    }
    void this.syncAll(p);
    this.scheduleWriteBack(p);
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

  private state(p: Project, sourceId: string): LiveState {
    let byId = this.states.get(p.path);
    if (!byId) {
      byId = new Map();
      this.states.set(p.path, byId);
    }
    let s = byId.get(sourceId);
    if (!s) {
      s = { syncing: false };
      byId.set(sourceId, s);
    }
    return s;
  }

  /** Live status of every source of the board; undefined when the board has none. */
  status(p: Project): Record<string, IssueSourceStatus> | undefined {
    const sources = p.board.issueSources;
    if (!sources || sources.length === 0) return undefined;
    const byId = this.states.get(p.path);
    const out: Record<string, IssueSourceStatus> = {};
    for (const src of sources) {
      const s = byId?.get(src.id);
      out[src.id] = {
        hasToken: hasToken(src.provider, src.baseUrl),
        syncing: s?.syncing ?? false,
        ...(s?.lastSyncAt ? { lastSyncAt: s.lastSyncAt } : {}),
        ...(s?.lastError ? { lastError: s.lastError, ...(s.lastErrorAt ? { lastErrorAt: s.lastErrorAt } : {}) } : {}),
        ...(s?.writeBackError
          ? { writeBackError: s.writeBackError, ...(s.writeBackErrorAt ? { writeBackErrorAt: s.writeBackErrorAt } : {}) }
          : {}),
      };
    }
    return out;
  }

  /** Syncs every enabled source; one failing source never stops the others. */
  async syncAll(p: Project): Promise<void> {
    if (!this.hooks.canRun(p)) return;
    const ids = (p.board.issueSources ?? []).filter((s) => s.enabled).map((s) => s.id);
    await Promise.allSettled(ids.map((id) => this.syncSource(p, id)));
  }

  /** Syncs one source. Resolves once done (errors are recorded in the live status, never thrown). */
  syncSource(p: Project, sourceId: string): Promise<void> {
    const key = `${p.path}::${sourceId}`;
    const running = this.inflight.get(key);
    if (running) {
      // The running sync read the source before this trigger: run once more after it, with the current source.
      let next = this.queued.get(key);
      if (!next) {
        next = running.then(() => {
          this.queued.delete(key);
          return this.syncSource(p, sourceId);
        });
        this.queued.set(key, next);
      }
      return next;
    }
    const run = this.runSync(p, sourceId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private async runSync(p: Project, sourceId: string): Promise<void> {
    if (!this.hooks.canRun(p)) return;
    const src = p.board.issueSources?.find((s) => s.id === sourceId);
    if (!src?.enabled) return;
    const impl = providerFor(src.provider);
    if (!impl) return;
    const snapshot = structuredClone(src);
    const state = this.state(p, sourceId);
    state.syncing = true;
    this.hooks.onState(p);
    let deleted: string[] = [];
    try {
      const plan = await this.fetchPlan(p, snapshot, impl);
      if (this.hooks.canRun(p)) deleted = this.apply(p, snapshot, plan);
      state.lastSyncAt = new Date().toISOString();
      delete state.lastError;
      delete state.lastErrorAt;
    } catch (e) {
      state.lastError = errorMessage(e);
      state.lastErrorAt = new Date().toISOString();
    } finally {
      state.syncing = false;
    }
    for (const id of deleted) this.hooks.purge(p, id);
    this.hooks.onState(p);
  }

  /** Network phase: reads the provider, never the board's future state. Throws on the first provider error. */
  private async fetchPlan(p: Project, src: IssueSource, impl: IssueProvider) {
    const token = getToken(src.provider, src.baseUrl);
    const open = await impl.listOpenIssues(src, token);
    const openById = new Map(open.map((i) => [i.externalId, i]));
    const updates = new Map<string, ExternalIssue>();
    const gone = new Set<string>();
    const mine = p.board.cards.filter((c) => c.columnId === BACKLOG_COLUMN_ID && c.external?.sourceId === src.id);
    for (const card of mine) {
      const ext = card.external as CardExternal;
      let issue: ExternalIssue | null | undefined = openById.get(ext.externalId);
      if (!issue) issue = await impl.getIssue(src, token, ext.number);
      if (!issue || issue.state === "closed") gone.add(card.id);
      else if (newer(issue.updatedAt, ext.updatedAt)) updates.set(card.id, issue);
    }
    const toImport = open.filter((i) => matchesLabels(i, src.labels)).sort((a, b) => a.number - b.number);
    return { toImport, updates, gone };
  }

  /**
   * Board phase: re-checks everything against the current board (it may have changed during the network phase),
   * then applies the changes in one mutation, or none when there is nothing to do. Returns the deleted card ids.
   */
  private apply(
    p: Project,
    fetched: IssueSource,
    plan: { toImport: ExternalIssue[]; updates: Map<string, ExternalIssue>; gone: Set<string> },
  ): string[] {
    const current = () => p.board.issueSources?.find((s) => s.id === fetched.id && s.enabled && sameConfig(s, fetched));
    const src = current();
    if (!src) return [];
    const inBacklog = (id: string) => {
      const c = p.card(id);
      return c && c.columnId === BACKLOG_COLUMN_ID && c.external?.sourceId === src.id ? c : undefined;
    };
    const imported = new Set(src.importedIds);
    const creates = plan.toImport.filter((i) => !imported.has(i.externalId));
    const updates = [...plan.updates].filter(([id, issue]) => {
      const c = inBacklog(id);
      return c?.external && newer(issue.updatedAt, c.external.updatedAt);
    });
    const deletes = [...plan.gone].filter((id) => inBacklog(id));
    if (creates.length === 0 && updates.length === 0 && deletes.length === 0) return [];
    p.mutate((board) => {
      const s = board.issueSources?.find((x) => x.id === src.id);
      if (!s) return;
      for (const issue of creates) {
        p.addCard(
          board,
          {
            title: issueTitle(issue),
            description: issueDescription(issue),
            columnId: BACKLOG_COLUMN_ID,
            external: {
              sourceId: s.id,
              provider: s.provider,
              repo: s.repo,
              externalId: issue.externalId,
              number: issue.number,
              url: issue.url,
              updatedAt: issue.updatedAt,
            },
          },
          `Created in ${BACKLOG_COLUMN_NAME} by ${refOf(s, issue.number)}`,
        );
        s.importedIds.push(issue.externalId);
      }
      for (const [id, issue] of updates) {
        const c = board.cards.find((x) => x.id === id);
        if (!c?.external) continue;
        c.title = issueTitle(issue);
        c.description = issueDescription(issue);
        c.external.updatedAt = issue.updatedAt;
        c.external.url = issue.url;
        c.updatedAt = new Date().toISOString();
        p.addHistory(c, "edited", `Updated from ${refOf(s, issue.number)}`);
      }
      for (const id of deletes) p.deleteCard(board, id);
    });
    return deletes;
  }

  // ---- write-back ----------------------------------------------------------

  /** Coalesced per project and microtask, like the dependency pass. */
  scheduleWriteBack(p: Project) {
    if (this.writeBackScheduled.has(p.path)) return;
    this.writeBackScheduled.add(p.path);
    queueMicrotask(() => {
      this.writeBackScheduled.delete(p.path);
      this.startWriteBacks(p);
    });
  }

  private startWriteBacks(p: Project) {
    if (!this.hooks.canRun(p)) return;
    for (const card of p.board.cards) {
      const ext = card.external;
      if (card.columnId !== DONE_COLUMN_ID || !ext || ext.writeBack) continue;
      const key = `${p.path}::${card.id}`;
      if (this.writeBackStarted.has(key)) continue;
      const src = p.board.issueSources?.find((s) => s.id === ext.sourceId && s.enabled);
      const impl = src && providerFor(src.provider);
      if (!src || !impl) continue;
      this.writeBackStarted.add(key);
      void this.writeBack(p, card, structuredClone(src), impl);
    }
  }

  private async writeBack(p: Project, card: Card, src: IssueSource, impl: IssueProvider) {
    const ext = card.external as CardExternal;
    const summary = card.lastRun?.summary?.trim();
    const text = `Done in Nightshift (${cardRef(card)}).${summary ? `\n\n${summary}` : ""}`;
    const token = getToken(src.provider, src.baseUrl);
    let error: string | undefined;
    try {
      if (!token) throw new Error("no token");
      await impl.comment(src, token, ext.number, text);
      await impl.close(src, token, ext.number);
    } catch (e) {
      error = errorMessage(e);
    }
    try {
      p.mutate((board) => {
        const c = board.cards.find((x) => x.id === card.id);
        if (!c?.external) return;
        c.external.writeBack = error ? "failed" : "done";
        if (error) p.addHistory(c, "edited", `Write-back to ${ext.repo}#${ext.number} failed: ${error}`);
      });
    } catch (e) {
      console.error(`Could not record the write-back of ${cardRef(card)}: ${errorMessage(e)}`);
    }
    if (error) {
      const state = this.state(p, src.id);
      state.writeBackError = `${ext.repo}#${ext.number}: ${error}`;
      state.writeBackErrorAt = new Date().toISOString();
      this.hooks.onState(p);
    }
  }
}
