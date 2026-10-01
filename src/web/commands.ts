// Command palette entries: pure data built from the snapshot, executed by the App.

import { cardRef, type ProjectSnapshot } from "../shared/types.ts";

export type CommandGroup = "Cartes" | "Actions" | "Navigation" | "Projets";

export type CommandAction =
  | { type: "openCard"; cardId: string }
  | { type: "newCard" }
  | { type: "openModal"; modal: "columns" | "skills" | "settings" }
  | { type: "openProject"; path: string }
  | { type: "sequence"; play: boolean };

export interface PaletteCommand {
  id: string;
  group: CommandGroup;
  label: string;
  /** cmdk value: unique, and what the "#<number>" search matches against for cards. */
  value: string;
  keywords: string[];
  /** Secondary text (column name for a card, path for a project). */
  subtitle?: string;
  disabled?: boolean;
  /** Label to show instead of `label` once some text is typed (the "create" item quotes it). */
  searchLabel?: (text: string) => string;
  action: CommandAction;
}

export interface CommandContext {
  snap: ProjectSnapshot;
  /** Recent projects; the current one (snap.path) is left out. */
  recentProjects: string[];
}

/** Start of the "create a card" item value; paletteFilter keeps that item for any free text. */
const NEW_CARD_PREFIX = "Créer une carte";

export function buildCommands({ snap, recentProjects }: CommandContext): PaletteCommand[] {
  const { columns, cards } = snap.board;
  const columnName = (id: string) => columns.find((c) => c.id === id)?.name ?? "";
  const out: PaletteCommand[] = [];

  for (const card of cards) {
    out.push({
      id: `card:${card.id}`,
      group: "Cartes",
      label: card.title,
      value: `${cardRef(card)} ${card.title}`,
      keywords: [columnName(card.columnId)],
      subtitle: columnName(card.columnId),
      action: { type: "openCard", cardId: card.id },
    });
  }

  const first = columns[0];
  if (first) {
    const label = `${NEW_CARD_PREFIX} dans ${first.name}`;
    out.push({
      id: "new-card",
      group: "Actions",
      label,
      value: label,
      keywords: ["nouvelle", "ajouter", "fiche"],
      searchLabel: (text) => `Créer « ${text} » dans ${first.name}`,
      action: { type: "newCard" },
    });
  }

  const active = snap.sequence.status === "active";
  const seqLabel = active ? "Mettre en pause le mode séquentiel" : "Lancer le mode séquentiel";
  out.push({
    id: "sequence",
    group: "Actions",
    label: active ? "Mettre en pause" : "Lancer le mode séquentiel",
    value: seqLabel,
    keywords: ["séquence", "pause", "play", "agents"],
    disabled: !!snap.agentsDisabled || !!snap.lockedBy,
    action: { type: "sequence", play: !active },
  });

  for (const [modal, label, keywords] of [
    ["columns", "Colonnes", ["éditer", "kanban"]],
    ["skills", "Skills", ["compétences", "agents"]],
    ["settings", "Réglages", ["paramètres", "préférences", "options"]],
  ] as const) {
    out.push({
      id: `open:${modal}`,
      group: "Navigation",
      label,
      value: `Ouvrir ${label}`,
      keywords: [...keywords],
      action: { type: "openModal", modal },
    });
  }

  for (const path of recentProjects) {
    if (path === snap.path) continue;
    const name = path.split("/").pop() || path;
    out.push({
      id: `project:${path}`,
      group: "Projets",
      label: name,
      value: `Projet ${name} ${path}`,
      keywords: ["projet", "changer", path],
      subtitle: path,
      action: { type: "openProject", path },
    });
  }
  return out;
}

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** True when typed text is free text (not a "#<ref>" search): it can become a new card title. */
export function isFreeText(search: string): boolean {
  const term = search.trim();
  return term !== "" && !term.startsWith("#");
}

/** Label shown in the palette for `search`: the "create" item quotes the typed text. */
export function commandLabel(c: PaletteCommand, search: string): string {
  return c.searchLabel && isFreeText(search) ? c.searchLabel(search.trim()) : c.label;
}

/**
 * cmdk filter: "#<digits>" is an exact card number; otherwise a case and accent insensitive substring of value + keywords.
 * The "create a card" item always matches free text (low score, so it comes after real matches).
 */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const term = search.trim();
  if (!term) return 1;
  const ref = /^#(\d+)$/.exec(term);
  if (ref) return new RegExp(`^#${ref[1]}(\\s|$)`).test(value) ? 1 : 0;
  const hay = normalize([value, ...(keywords ?? [])].join(" "));
  if (hay.includes(normalize(term))) return 1;
  return isFreeText(term) && normalize(value).startsWith(normalize(NEW_CARD_PREFIX)) ? 0.01 : 0;
}
