// Card dependencies: pure helpers shared by the server and the web client. No I/O.

import { resolveNextColumn } from "./skip.ts";
import { BACKLOG_COLUMN_ID, type Board, type Card, type Column, cardRef, DONE_COLUMN_ID } from "./types.ts";

/**
 * Canonical dependency list: ids of existing cards (`knownIds`), never `selfId`, unique, in input order.
 * Anything that is not an array of strings is ignored; an empty result is `undefined` (the field is then absent).
 */
export function normalizeDependsOn(knownIds: ReadonlySet<string>, selfId: string, ids: unknown): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const out: string[] = [];
  for (const id of ids) if (typeof id === "string" && id !== selfId && knownIds.has(id) && !out.includes(id)) out.push(id);
  return out.length > 0 ? out : undefined;
}

/**
 * Turns API input (refs `"#12"`, numbers `12` or `"12"`, card ids) into unique card ids, in input order.
 * Throws on a non-array, an unknown card or a reference to `selfId`. An empty array gives `[]`.
 */
export function resolveDependencyRefs(board: Pick<Board, "cards">, input: unknown, selfId?: string): string[] {
  if (!Array.isArray(input)) throw new Error("dependsOn must be an array");
  const out: string[] = [];
  for (const ref of input) {
    let card: Card | undefined;
    if (typeof ref === "number" && Number.isInteger(ref)) card = board.cards.find((c) => c.number === ref);
    else if (typeof ref === "string") {
      const m = /^#?(\d+)$/.exec(ref.trim());
      card = m ? board.cards.find((c) => c.number === Number(m[1])) : board.cards.find((c) => c.id === ref);
    }
    if (!card)
      throw new Error(`Unknown card in dependsOn: ${typeof ref === "string" || typeof ref === "number" ? ref : JSON.stringify(ref)}`);
    if (card.id === selfId) throw new Error("A card cannot depend on itself");
    if (!out.includes(card.id)) out.push(card.id);
  }
  return out;
}

/**
 * Path of card ids from one of `ids` back to `cardId` through the other cards' dependencies, when `cardId`
 * depending on `ids` would close a cycle; undefined otherwise. Terminates on cycles already in the board.
 */
export function dependencyCycle(board: Pick<Board, "cards">, cardId: string, ids: readonly string[]): string[] | undefined {
  const byId = new Map(board.cards.map((c) => [c.id, c]));
  const visited = new Set<string>();
  const walk = (id: string, path: string[]): string[] | undefined => {
    if (id === cardId) return path;
    if (visited.has(id)) return undefined;
    visited.add(id);
    for (const next of byId.get(id)?.dependsOn ?? []) {
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return undefined;
  };
  for (const id of ids) {
    const found = walk(id, [id]);
    if (found) return [cardId, ...found];
  }
  return undefined;
}

/** True when `cardId` depending on `ids` would create a dependency cycle. */
export function wouldCreateCycle(board: Pick<Board, "cards">, cardId: string, ids: readonly string[]): boolean {
  return dependencyCycle(board, cardId, ids) !== undefined;
}

/** Error text for a cycle path of card ids, e.g. `Dependency cycle: #1 → #2 → #1`. */
export function describeCycle(board: Pick<Board, "cards">, path: readonly string[]): string {
  const ref = (id: string) => {
    const c = board.cards.find((x) => x.id === id);
    return c ? cardRef(c) : id;
  };
  return `Dependency cycle: ${path.map(ref).join(" → ")}`;
}

/** Dependencies of the card not in Done yet, in `dependsOn` order. Unknown ids are skipped. */
export function unmetDependencies(board: Pick<Board, "cards">, card: Pick<Card, "dependsOn">): Card[] {
  const out: Card[] = [];
  for (const id of card.dependsOn ?? []) {
    const dep = board.cards.find((c) => c.id === id);
    if (dep && dep.columnId !== DONE_COLUMN_ID) out.push(dep);
  }
  return out;
}

/** A card held by its dependencies: in Backlog with a dependency list. */
export function isHeld(card: Pick<Card, "columnId" | "dependsOn">): boolean {
  return card.columnId === BACKLOG_COLUMN_ID && !!card.dependsOn;
}

/** A held card whose dependencies are all in Done: it must be released. A draft is never ready. */
export function isReady(board: Pick<Board, "cards">, card: Card): boolean {
  return !card.draft && isHeld(card) && unmetDependencies(board, card).length === 0;
}

/** Column a released card goes to: the first after Backlog it does not skip (Done at worst). */
export function releaseTarget(columns: Column[], card: Pick<Card, "skipColumnIds">): Column | undefined {
  return resolveNextColumn(columns, { columnId: BACKLOG_COLUMN_ID, skipColumnIds: card.skipColumnIds });
}

/** History reason of a release: the refs of the card's current dependencies, or "cleared" when there are none. */
export function releaseReason(board: Pick<Board, "cards">, card: Pick<Card, "dependsOn">): string {
  const refs = (card.dependsOn ?? []).flatMap((id) => {
    const c = board.cards.find((x) => x.id === id);
    return c ? [cardRef(c)] : [];
  });
  return refs.length > 0 ? `Dependencies done (${refs.join(", ")})` : "Dependencies cleared";
}
