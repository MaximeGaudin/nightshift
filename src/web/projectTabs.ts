// Project tabs of the app shell: pure state, the App owns the React state and the storage.

import type { ProjectSnapshot } from "../shared/types.ts";

/** Resolved project paths (as `snap.path` returns them), in opening order, without duplicates. */
export type Tabs = string[];

export type TabStorage = Pick<Storage, "getItem" | "setItem">;

const KEY = "nightshift.tabs";

/** Stored tabs; anything unreadable is an empty list. Never throws. */
export function loadTabs(storage: TabStorage | undefined): Tabs {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((p): p is string => typeof p === "string" && p !== "").reduce<Tabs>(addTab, []);
  } catch {
    return [];
  }
}

/** Saves the tabs; a storage that refuses the write is ignored. */
export function saveTabs(storage: TabStorage | undefined, tabs: Tabs): void {
  try {
    storage?.setItem(KEY, JSON.stringify(tabs));
  } catch {
    // Private mode or quota: the tabs only last for this page.
  }
}

/** Appends `path` unless it is already open (same array then). */
export function addTab(tabs: Tabs, path: string): Tabs {
  return tabs.includes(path) ? tabs : [...tabs, path];
}

/** Replaces a raw path by the resolved one the server answered, without creating a duplicate. */
export function renameTab(tabs: Tabs, from: string, to: string): Tabs {
  if (from === to || !tabs.includes(from)) return addTab(tabs, to);
  if (tabs.includes(to)) return tabs.filter((p) => p !== from);
  return tabs.map((p) => (p === from ? to : p));
}

/**
 * Removes `path`. Closing the active tab activates its left neighbour, else its right one, else nothing (`null`).
 * Closing another tab keeps `active`.
 */
export function closeTab(tabs: Tabs, path: string, active: string | null): { tabs: Tabs; next: string | null } {
  const i = tabs.indexOf(path);
  if (i < 0) return { tabs, next: active };
  const rest = tabs.filter((p) => p !== path);
  if (path !== active) return { tabs: rest, next: active };
  return { tabs: rest, next: tabs[i - 1] ?? tabs[i + 1] ?? null };
}

/** Name shown on a tab: the last non-empty path segment. */
export function tabLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Cards waiting for a human answer: not live, and their last run asked questions in their current column. */
export function questionCount(snap: Pick<ProjectSnapshot, "board" | "live">): number {
  return snap.board.cards.filter((c) => !snap.live[c.id] && c.lastRun?.status === "question" && c.lastRun.columnId === c.columnId).length;
}
