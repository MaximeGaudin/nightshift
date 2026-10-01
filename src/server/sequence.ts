// Sequential mode: runs the top card of the source column through the board, one at a time.
// Held in memory per project (never written to nightshift.json). All transitions are synchronous.

import { autoMergeSkipIds, type SequenceState, sequenceColumns, sequenceFailure, topSourceCard } from "../shared/sequence.ts";
import { cardRef, DONE_COLUMN_ID } from "../shared/types.ts";
import { HttpError } from "./guard.ts";
import type { Project } from "./store.ts";

export interface SequenceDeps {
  /** True while an agent job runs for this card. */
  isRunning(p: Project, cardId: string): boolean;
  /** False for a `--no-agents` instance or when another process holds the project lock. */
  canRunAgents(p: Project): boolean;
  /** The state changed: broadcast the snapshot. */
  onState(p: Project): void;
  /** The sequence stopped on a failure: play the attention sound. */
  onAttention(p: Project, cardId: string): void;
}

export class SequenceController {
  private states = new Map<string, SequenceState>();
  private pending = new Map<string, Project>();

  constructor(private deps: SequenceDeps) {}

  get(p: Project): SequenceState {
    return { ...(this.states.get(p.path) ?? { status: "stopped" }) };
  }

  private set(p: Project, next: SequenceState) {
    const prev = this.get(p);
    this.states.set(p.path, next);
    if (prev.status !== next.status || prev.cardId !== next.cardId || prev.notice !== next.notice) this.deps.onState(p);
  }

  private stop(p: Project, notice?: string, keepCard = false) {
    const cardId = keepCard ? this.get(p).cardId : undefined;
    this.set(p, { status: "stopped", ...(cardId ? { cardId } : {}), ...(notice ? { notice } : {}) });
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

  play(p: Project) {
    if (!this.deps.canRunAgents(p)) throw new HttpError(409, "Cette instance ne lance pas d'agents pour ce projet");
    const state = this.get(p);
    if (state.status === "active") return;
    if (state.status === "paused") {
      this.set(p, { status: "active", ...(state.cardId ? { cardId: state.cardId } : {}) });
      this.reconcile(p);
      return;
    }
    const cols = sequenceColumns(p.board.columns);
    const tracked = state.cardId ? p.board.cards.find((c) => c.id === state.cardId) : undefined;
    if (tracked && cols && tracked.columnId !== cols.source.id && tracked.columnId !== DONE_COLUMN_ID) {
      this.set(p, { status: "active", cardId: tracked.id });
      this.reconcile(p);
      return;
    }
    if (!this.launchNext(p)) this.stop(p, "Backlog vide");
  }

  pause(p: Project) {
    const state = this.get(p);
    if (state.status !== "active") return;
    this.set(p, { status: "paused", ...(state.cardId ? { cardId: state.cardId } : {}) });
  }

  reconcile(p: Project) {
    const state = this.get(p);
    if (state.status === "stopped") return;
    const board = p.board;
    const cols = sequenceColumns(board.columns);
    const card = state.cardId ? board.cards.find((c) => c.id === state.cardId) : undefined;
    if (!cols || !card) return this.stop(p, "Séquence arrêtée : carte supprimée");
    if (card.columnId === cols.source.id) {
      return this.stop(p, `Séquence arrêtée : ${cardRef(card)} ramenée dans ${cols.source.name}`);
    }
    if (card.columnId === DONE_COLUMN_ID) {
      if (state.status === "paused") return this.stop(p);
      if (!this.launchNext(p)) this.stop(p, "Séquence terminée : backlog vide");
      return;
    }
    const reason = sequenceFailure(board, card, this.deps.isRunning(p, card.id));
    if (reason) {
      this.stop(p, `Séquence arrêtée : ${cardRef(card)} ${reason}`, true);
      this.deps.onAttention(p, card.id);
    }
  }

  /** Moves the top source card into the entry column and tracks it. False when the backlog is empty. */
  private launchNext(p: Project): boolean {
    const cols = sequenceColumns(p.board.columns);
    const top = topSourceCard(p.board);
    if (!cols || !top) return false;
    const previous = this.states.get(p.path);
    this.states.set(p.path, { status: "active", cardId: top.id });
    try {
      p.mutate((board) => {
        const card = board.cards.find((c) => c.id === top.id);
        if (!card) throw new Error("Unknown card");
        const skips = autoMergeSkipIds(board.columns, card);
        if (skips) card.skipColumnIds = skips;
        else delete card.skipColumnIds;
        p.moveCard(board, card.id, cols.entry.id, undefined, "Sequence");
      });
    } catch (e) {
      if (previous) this.states.set(p.path, previous);
      else this.states.delete(p.path);
      throw e;
    }
    this.deps.onState(p);
    return true;
  }
}
