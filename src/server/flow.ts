// Fast forward and pause: per-project run flow, held in memory (never written to nightshift.json).
// Fast forward moves every ready Backlog card out at once; the orchestrator gates automatic runs on pause.

import { DEFAULT_FLOW, type FlowState, fastForwardCandidates, fastForwardSkipIds, fastForwardTarget } from "../shared/flow.ts";
import { HttpError } from "./guard.ts";
import type { Project } from "./store.ts";

export interface FlowDeps {
  /** False for a `--no-agents` instance or when another process holds the project lock. */
  canRunAgents(p: Project): boolean;
  /** The state changed: broadcast the snapshot. */
  onState(p: Project): void;
  /** The project left pause: cards waiting for play can start. */
  onResume(p: Project): void;
}

export class FlowController {
  private states = new Map<string, FlowState>();
  private pending = new Map<string, Project>();

  constructor(private deps: FlowDeps) {}

  get(p: Project): FlowState {
    return { ...(this.states.get(p.path) ?? DEFAULT_FLOW) };
  }

  isPaused(p: Project): boolean {
    return this.states.get(p.path)?.paused ?? false;
  }

  isFastForward(p: Project): boolean {
    return this.states.get(p.path)?.fastForward ?? false;
  }

  setFastForward(p: Project, on: boolean) {
    this.update(p, { ...this.get(p), fastForward: on });
  }

  setPaused(p: Project, paused: boolean) {
    const resumed = this.isPaused(p) && !paused;
    this.update(p, { ...this.get(p), paused });
    if (resumed) this.deps.onResume(p);
  }

  private update(p: Project, next: FlowState) {
    if (!this.deps.canRunAgents(p)) throw new HttpError(409, "This instance does not run agents for this project");
    const prev = this.get(p);
    if (prev.fastForward === next.fastForward && prev.paused === next.paused) return;
    this.states.set(p.path, next);
    this.deps.onState(p);
    this.reconcile(p);
  }

  /** Coalesced like Orchestrator.scheduleTick: one reconcile per project per microtask, never inside an emit. */
  schedule(p: Project) {
    if (this.pending.has(p.path)) return;
    this.pending.set(p.path, p);
    queueMicrotask(() => {
      this.pending.delete(p.path);
      this.reconcile(p);
    });
  }

  /** Moves every ready Backlog card out at once. No candidate, no mutation: the change it emits finds none. */
  reconcile(p: Project) {
    const state = this.get(p);
    if (!state.fastForward || state.paused || !this.deps.canRunAgents(p)) return;
    if (fastForwardCandidates(p.board).length === 0) return;
    try {
      p.mutate((board) => {
        for (const card of fastForwardCandidates(board)) {
          const skips = fastForwardSkipIds(board.columns, card);
          const target = fastForwardTarget(board.columns, skips);
          if (!target) continue;
          if (skips) card.skipColumnIds = skips;
          else delete card.skipColumnIds;
          p.moveCard(board, card.id, target.id, undefined, "Fast forward");
        }
      });
    } catch (e) {
      console.error(`Could not fast forward the cards of ${p.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
