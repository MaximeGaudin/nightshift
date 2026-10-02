// Global keyboard shortcuts: pure decision, the App owns the single listener.

import { t } from "./i18n/index.ts";

/** `{ tab: n }` activates the n-th project tab (1-based). */
export type Shortcut = "palette" | "newCard" | "help" | { tab: number };

export interface ShortcutEvent {
  key: string;
  /** Physical key (`Digit1`…): with ⌥ on macOS, `key` is a special character instead of the digit. */
  code?: string;
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
  const digit = /^Digit([1-9])$/.exec(e.code ?? "")?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : undefined);
  // ⌘N / Ctrl+N (often kept by the browser for its own tabs) and ⌥N, which always reaches the page.
  if (digit && [e.metaKey, e.ctrlKey, e.altKey].filter(Boolean).length === 1) return { tab: Number(digit) };
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "c" || e.key === "C") return "newCard";
  if (e.key === "?") return "help";
  return null;
}

/** Rows of the help dialog, resolved at call time so they follow the language. */
export function shortcutHelpRows(): { keys: string[]; label: string }[] {
  return [
    { keys: ["⌘ K", "Ctrl K"], label: t("shortcuts.palette") },
    { keys: ["⌘ 1–9", "⌥ 1–9"], label: t("shortcuts.tab") },
    { keys: ["C"], label: t("shortcuts.newCard") },
    { keys: ["?"], label: t("shortcuts.help") },
    { keys: [t("shortcuts.keyEscape")], label: t("shortcuts.close") },
    { keys: [t("shortcuts.keySpace")], label: t("shortcuts.drag") },
    { keys: ["↑", "↓", "←", "→"], label: t("shortcuts.move") },
  ];
}
