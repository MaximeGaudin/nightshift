// Command palette entries: pure data built from the snapshot, executed by the App.

import { cardRef, type ProjectSnapshot, type SkillInfo } from "../shared/types.ts";
import { type MessageKey, t } from "./i18n/index.ts";

export type CommandGroup = "cards" | "actions" | "skills" | "navigation" | "projects";

export type CommandAction =
  | { type: "openCard"; cardId: string }
  | { type: "newCard" }
  | { type: "openModal"; modal: "columns" | "skills" | "settings" }
  | { type: "openProject"; path: string }
  | { type: "fastForward"; on: boolean }
  | { type: "pause"; paused: boolean }
  | { type: "quickRun"; skill: string };

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
  /** Skills available to the project; only the favorite ones become entries. */
  skills: SkillInfo[];
}

/** Heading of each palette group, resolved at render so it follows the language. */
export const GROUP_LABEL_KEYS: Record<CommandGroup, MessageKey> = {
  cards: "palette.group.cards",
  actions: "palette.group.actions",
  skills: "palette.group.skills",
  navigation: "palette.group.navigation",
  projects: "palette.group.projects",
};

/** Stable, untranslated start of a skill entry value. */
const SKILL_PREFIX = "skill:";

/** Search words stored as one comma separated message. */
const words = (key: MessageKey) => t(key).split(",");

/** Start of the "create a card" item value in the active language; paletteFilter keeps that item for any free text. */
const newCardPrefix = () => t("palette.newCardPrefix");

export function buildCommands({ snap, recentProjects, skills }: CommandContext): PaletteCommand[] {
  const { columns, cards } = snap.board;
  const columnName = (id: string) => columns.find((c) => c.id === id)?.name ?? "";
  const out: PaletteCommand[] = [];

  for (const card of cards) {
    out.push({
      id: `card:${card.id}`,
      group: "cards",
      label: card.title,
      value: `${cardRef(card)} ${card.title}`,
      keywords: [columnName(card.columnId)],
      subtitle: columnName(card.columnId),
      action: { type: "openCard", cardId: card.id },
    });
  }

  const first = columns[0];
  if (first) {
    const label = t("palette.newCard", { column: first.name });
    out.push({
      id: "new-card",
      group: "actions",
      label,
      value: label,
      keywords: words("palette.keywords.newCard"),
      searchLabel: (text) => t("palette.newCardNamed", { text, column: first.name }),
      action: { type: "newCard" },
    });
  }

  const { fastForward, paused } = snap.flow;
  const flowDisabled = !!snap.agentsDisabled || !!snap.lockedBy;
  const ffLabel = fastForward ? t("palette.fastForwardOff") : t("palette.fastForwardOn");
  out.push({
    id: "fastForward",
    group: "actions",
    label: ffLabel,
    value: ffLabel,
    keywords: words("palette.keywords.fastForward"),
    disabled: flowDisabled,
    action: { type: "fastForward", on: !fastForward },
  });
  const pauseLabel = paused ? t("palette.play") : t("palette.pause");
  out.push({
    id: "pause",
    group: "actions",
    label: pauseLabel,
    value: pauseLabel,
    keywords: words("palette.keywords.pause"),
    disabled: flowDisabled,
    action: { type: "pause", paused: !paused },
  });

  const favorites = new Set(snap.board.favoriteSkills ?? []);
  const favoriteSkills = skills.filter((s) => favorites.has(s.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const skill of favoriteSkills) {
    out.push({
      id: `skill:${skill.name}`,
      group: "skills",
      label: skill.name,
      value: `${SKILL_PREFIX}${skill.name} ${skill.description}`,
      keywords: words("palette.keywords.skill"),
      subtitle: skill.description,
      disabled: !!snap.agentsDisabled || !!snap.lockedBy,
      searchLabel: (text) => {
        const instruction = quickRunInstruction(skill.name, text);
        return instruction ? t("palette.runSkillWith", { name: skill.name, instruction }) : skill.name;
      },
      action: { type: "quickRun", skill: skill.name },
    });
  }

  for (const [modal, labelKey, keywordsKey] of [
    ["columns", "palette.open.columns", "palette.keywords.columns"],
    ["skills", "palette.open.skills", "palette.keywords.skills"],
    ["settings", "palette.open.settings", "palette.keywords.settings"],
  ] as const) {
    const label = t(labelKey);
    out.push({
      id: `open:${modal}`,
      group: "navigation",
      label,
      value: t("palette.openValue", { label }),
      keywords: words(keywordsKey),
      action: { type: "openModal", modal },
    });
  }

  for (const path of recentProjects) {
    if (path === snap.path) continue;
    const name = path.split("/").pop() || path;
    out.push({
      id: `project:${path}`,
      group: "projects",
      label: name,
      value: t("palette.projectValue", { name, path }),
      keywords: [...words("palette.keywords.project"), path],
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

/** Instruction typed after the skill name ("deploy-prod v1.4" gives "v1.4"); "" when the text is not that skill followed by words. */
export function quickRunInstruction(name: string, search: string): string {
  const text = normalize(search.trim());
  const n = normalize(name);
  if (text === n) return "";
  if (!text.startsWith(n) || !/\s/.test(text.charAt(n.length))) return "";
  return search.trim().slice(name.length).trim();
}

/** True when typed text is free text (not a "#<ref>" search): it can become a new card title. */
export function isFreeText(search: string): boolean {
  const term = search.trim();
  return term !== "" && !term.startsWith("#");
}

/**
 * Groups in display order for `search`. cmdk sorts the items of a group but not the groups, and selects the first
 * item: the group holding the best enabled match comes first, so Enter on "deploy-prod v1.4" runs the skill instead
 * of the low-score "create a card" item. Equal scores keep the given order.
 */
export function orderGroups(groups: CommandGroup[], commands: PaletteCommand[], search: string): CommandGroup[] {
  if (!search.trim()) return groups;
  const best = new Map<CommandGroup, number>();
  for (const c of commands) {
    if (c.disabled) continue;
    best.set(c.group, Math.max(best.get(c.group) ?? 0, paletteFilter(c.value, search, c.keywords)));
  }
  return [...groups].sort((a, b) => (best.get(b) ?? 0) - (best.get(a) ?? 0));
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
  if (value.startsWith(SKILL_PREFIX)) {
    const name = value.slice(SKILL_PREFIX.length).split(" ")[0] ?? "";
    if (quickRunInstruction(name, term) !== "") return 1;
  }
  return isFreeText(term) && normalize(value).startsWith(normalize(newCardPrefix())) ? 0.01 : 0;
}
