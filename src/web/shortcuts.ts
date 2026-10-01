// Global keyboard shortcuts: pure decision, the App owns the single listener.

export type Shortcut = "palette" | "newCard" | "help";

export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: unknown;
}

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** True when typing happens in the target: shortcuts must not fire there. */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const t = target as TargetLike;
  if (t.tagName && FIELD_TAGS.has(t.tagName.toUpperCase())) return true;
  if (t.isContentEditable) return true;
  const attr = t.getAttribute?.("contenteditable");
  if (attr !== null && attr !== undefined && attr !== "false") return true;
  return !!t.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}

/** Maps a keydown to a shortcut; null when it is not ours, typed in a field, or a dialog is open. */
export function shortcutFor(e: ShortcutEvent, ctx: { dialogOpen: boolean }): Shortcut | null {
  if (ctx.dialogOpen || isEditableTarget(e.target)) return null;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") return "palette";
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "c" || e.key === "C") return "newCard";
  if (e.key === "?") return "help";
  return null;
}
