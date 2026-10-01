import type { Card } from "../shared/types.ts";

type DoneStorage = Pick<Storage, "getItem" | "setItem">;

export const doneCollapsedKey = (projectPath: string): string => "nightshift:doneCollapsed:" + projectPath;

/** Collapsed unless the user explicitly expanded it ("0"). Unreadable storage counts as collapsed. */
export function readDoneCollapsed(storage: DoneStorage, projectPath: string): boolean {
  try {
    return storage.getItem(doneCollapsedKey(projectPath)) !== "0";
  } catch {
    return true;
  }
}

export function writeDoneCollapsed(storage: DoneStorage, projectPath: string, collapsed: boolean): void {
  try {
    storage.setItem(doneCollapsedKey(projectPath), collapsed ? "1" : "0");
  } catch {
    // Storage full or blocked: the preference just isn't persisted.
  }
}

/** Most recently finished first. Stable: ties keep their original order. */
export function sortDoneCards(cards: Card[]): Card[] {
  return cards
    .map((c, i) => ({ c, i, t: Date.parse(c.enteredColumnAt) || 0 }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.c);
}
