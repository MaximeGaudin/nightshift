#!/usr/bin/env bun
// Creates a deterministic demo project for screenshots: bun scripts/demo-board.ts <dir>
// Also writes <dir>-user-skills with two user skills (use it as NIGHTSHIFT_USER_SKILLS).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Board, Card, Column, HistoryEntry } from "../src/shared/types.ts";

const target = process.argv[2];
if (!target) {
  console.error("Usage: bun scripts/demo-board.ts <dir>");
  process.exit(2);
}
const dir = resolve(target);
const userSkillsDir = `${dir}-user-skills`;

const BASE = Date.parse("2026-05-04T09:00:00.000Z");
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

const columns: Column[] = [
  { id: "col_backlog", name: "Backlog", type: "inert" },
  { id: "col_plan", name: "Plan", type: "skill", skill: "demo-plan", model: "opus", maxParallel: 2, emoji: "🗺️" },
  { id: "col_build", name: "Implement", type: "skill", skill: "demo-implement", model: "sonnet", maxParallel: 3, emoji: "🧑‍💻" },
  { id: "col_review", name: "Review", type: "skill", skill: "user-review", model: "opus", maxParallel: 1, emoji: "🧐" },
  { id: "col_test", name: "To Test", type: "inert", emoji: "🪲" },
  { id: "col_done", name: "Done", type: "inert" },
];

const entry = (kind: HistoryEntry["kind"], text: string, minutes: number, columnId?: string): HistoryEntry => ({
  at: at(minutes),
  kind,
  text,
  ...(columnId ? { columnId } : {}),
});

let counter = 0;
function card(title: string, columnId: string, extra: Partial<Card> & { description?: string } = {}): Card {
  counter++;
  const created = counter * 30;
  return {
    id: `card_demo${String(counter).padStart(6, "0")}`,
    number: counter,
    title,
    description: extra.description ?? "",
    columnId,
    createdAt: at(created),
    updatedAt: at(created + 20),
    enteredColumnAt: at(created + 10),
    history: [entry("created", "Card created", created, columns[0]?.id), entry("moved", "Moved", created + 10, columnId)],
    ...extra,
  };
}

const richDescription = `## Context

Users want to **export** the board as \`CSV\` from the top bar.

### To do

- Add an *Export* button next to "Settings"
- Generate the file on the server
  - columns: number, title, column
  - UTF-8 encoding
- Show a toast when done

1. Write the test
2. Implement
3. Update the [README](https://example.com/readme)

> Warning: do not block the event loop on large boards.

\`\`\`ts
export function toCsv(cards: Card[]): string {
  return cards.map((c) => [c.number, JSON.stringify(c.title)].join(",")).join("\\n");
}
\`\`\`

| Column | Type | Limit |
| --- | --- | --- |
| Plan | skill | 2 |
| Implement | skill | 3 |
| Review | skill | 1 |
`;

const cards: Card[] = [
  card("Export the board as CSV", "col_backlog", { description: richDescription }),
  card("Fix modal scrolling", "col_backlog", { description: "The side column does not scroll on small screens." }),
  card("Add a compact mode", "col_backlog", {
    description: "Reduce card height.",
    skipColumnIds: ["col_plan", "col_review"],
  }),
  card("Run completion notifications", "col_build", {
    description: "Play a sound and show a notification when an agent finishes.",
    lastRun: { columnId: "col_build", status: "success", at: at(200), summary: "Sound added, notification shown.", costUsd: 0.42 },
  }),
  card("Migrate authentication", "col_plan", {
    description: "Switch to short-lived tokens.",
    lastRun: {
      columnId: "col_plan",
      status: "question",
      at: at(210),
      summary: "Two points to clarify before planning.",
      questions: ["Should old tokens be kept during the migration?", "What lifetime for the new tokens?"],
      sessionId: "sess_demo_question",
    },
  }),
  card("Fix skill import", "col_build", {
    description: "Import fails when the folder name contains a dot.",
    lastRun: { columnId: "col_build", status: "error", at: at(220), error: "Command failed: bun test (exit 1)", costUsd: 0.18 },
  }),
  card("Review the Settings page", "col_review", {
    description: "Check label consistency.",
    lastRun: { columnId: "col_review", status: "success", at: at(230), summary: "Labels checked, no inconsistency found.", costUsd: 0.12 },
  }),
  card("Preview the interface", "col_test", {
    description: "Run the app from the worktree.",
    test: { command: "bun start --no-agents --port 4611", url: "http://localhost:4611" },
  }),
  card("Automatic deployment", "col_done", { description: "One-click deployment pipeline." }),
  card("Card search", "col_done", { description: "Search field in the top bar." }),
  card("Dark theme", "col_done", { description: "Follow prefers-color-scheme." }),
];

const board: Board = { version: 1, name: "Nightshift Demo", columns, cards, nextCardNumber: counter + 1 };

function skill(root: string, name: string, description: string, body: string) {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

rmSync(dir, { recursive: true, force: true });
rmSync(userSkillsDir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
mkdirSync(userSkillsDir, { recursive: true });
writeFileSync(join(dir, "nightshift.json"), `${JSON.stringify(board, null, 2)}\n`);

const projectSkills = join(dir, ".claude", "skills");
skill(
  projectSkills,
  "demo-plan",
  "Writes an implementation plan from a card.",
  "# Plan\n\nRead the card, then write a plan in numbered steps.",
);
skill(
  projectSkills,
  "demo-implement",
  "Implements a card according to its plan.",
  "# Implementation\n\nImplement the plan, run the tests, commit.",
);
skill(userSkillsDir, "user-review", "Reviews a diff and reports defects.", "# Review\n\nRead the diff, fix the defects, re-run the tests.");
skill(userSkillsDir, "user-summarize", "Summarizes a discussion thread.", "# Summary\n\nProduce a short, factual summary.");

console.log(`Demo project written to ${dir} (user skills: ${userSkillsDir})`);
