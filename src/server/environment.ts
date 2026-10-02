import { resolveNextColumn, skippedColumns } from "../shared/skip.ts";
import {
  agentBlocker,
  type Board,
  type Card,
  type Column,
  cardRef,
  DONE_COLUMN_ID,
  type LiveStatus,
  type WorktreePolicy,
  worktreePolicyOf,
} from "../shared/types.ts";

/** Other cards listed per column before the rest is summarised as "… and N more". */
export const ENVIRONMENT_CARDS_PER_COLUMN = 20;

/** What an agent must do about git worktrees, per policy. The skills read this line: keep the wording stable. */
export const WORKTREE_POLICY_TEXT: Record<WorktreePolicy, string> = {
  required: "make every file change in this card's own git worktree, never in the shared checkout.",
  auto: "use a git worktree for this card by default; working in the shared checkout is allowed only for a trivial change when no other agent runs on this project.",
  forbidden: "do not create git worktrees; work and commit directly in the shared checkout, on the current branch.",
};

function describeColumn(c: Column): string {
  return `${c.name} (id: ${c.id}, ${c.type === "skill" ? `skill: ${c.skill}` : "inert"})`;
}

function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function marker(card: Card, live: Record<string, LiveStatus>): string {
  if (live[card.id] === "running") return " [running]";
  if (live[card.id] === "queued") return " [queued]";
  return agentBlocker(card) === "question" ? " [question]" : "";
}

/** The columns the card still goes through, from its current one to Done, honouring its skipped columns. */
function remainingPath(board: Board, card: Card): Column[] {
  const current = board.columns.find((c) => c.id === card.columnId);
  if (!current) return [];
  const path = [current];
  for (let next = resolveNextColumn(board.columns, card); next && path.length <= board.columns.length; ) {
    path.push(next);
    next = resolveNextColumn(board.columns, { columnId: next.id, skipColumnIds: card.skipColumnIds });
  }
  return path;
}

/** The `<environment>` block put after the card in an agent prompt: its path, the project settings and the other cards. */
export function buildEnvironment(board: Board, card: Card, live: Record<string, LiveStatus>): string {
  const lines = ["<environment>", "Card path (remaining columns, in order):"];
  remainingPath(board, card).forEach((c, i) => {
    lines.push(`  ${i + 1}. ${describeColumn(c)}${c.id === card.columnId ? " ← current" : ""}`);
  });
  const currentIndex = board.columns.findIndex((c) => c.id === card.columnId);
  const skipped = skippedColumns(board.columns, card).filter((c) => board.columns.indexOf(c) > currentIndex);
  if (skipped.length > 0) lines.push(`Skipped for this card: ${skipped.map(describeColumn).join(", ")}`);
  lines.push(`Worktree policy: ${worktreePolicyOf(board)} — ${WORKTREE_POLICY_TEXT[worktreePolicyOf(board)]}`);

  const groups: string[] = [];
  for (const column of board.columns) {
    if (column.id === DONE_COLUMN_ID) continue;
    const others = board.cards.filter((c) => c.columnId === column.id && c.id !== card.id);
    if (others.length === 0) continue;
    const shown = others.slice(0, ENVIRONMENT_CARDS_PER_COLUMN).map((c) => `${cardRef(c)} ${oneLine(c.title)}${marker(c, live)}`);
    if (others.length > ENVIRONMENT_CARDS_PER_COLUMN) shown.push(`… and ${others.length - ENVIRONMENT_CARDS_PER_COLUMN} more`);
    groups.push(`  ${column.name}: ${shown.join(", ")}`);
  }
  if (groups.length === 0) lines.push("Other cards on the board: none");
  else lines.push("Other cards on the board:", ...groups);
  lines.push("</environment>");
  return lines.join("\n");
}
