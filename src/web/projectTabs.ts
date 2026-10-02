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

/** Everything the tab bar knows: open tabs, the last snapshot of each opened project, and why a tab failed to open. */
export interface TabsState {
  tabs: Tabs;
  snaps: Record<string, ProjectSnapshot>;
  errors: Record<string, string>;
}

const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record;
  const { [key]: _, ...rest } = record;
  return rest;
};

/** `requested` answered with `snap`: cache it and make it a tab under its resolved path. */
export function tabOpened(state: TabsState, requested: string, snap: ProjectSnapshot): TabsState {
  return {
    tabs: renameTab(state.tabs, requested, snap.path),
    snaps: { ...state.snaps, [snap.path]: snap },
    errors: without(without(state.errors, requested), snap.path),
  };
}

/** Opening `path` failed: an existing tab keeps its place and shows the error. */
export function tabOpenFailed(state: TabsState, path: string, message: string): TabsState {
  return { ...state, errors: { ...state.errors, [path]: message } };
}

/** A board event: only projects with a cached snapshot (open tabs, or the one being shown) are followed. */
export function tabBoardEvent(state: TabsState, project: string, snap: ProjectSnapshot): TabsState {
  if (!(project in state.snaps)) return state;
  return { ...state, snaps: { ...state.snaps, [project]: snap } };
}

/** Closes a tab and forgets its snapshot and error; the server keeps the project open. */
export function tabClosed(state: TabsState, path: string, active: string | null): { state: TabsState; next: string | null } {
  const { tabs, next } = closeTab(state.tabs, path, active);
  return { state: { tabs, snaps: without(state.snaps, path), errors: without(state.errors, path) }, next };
}
