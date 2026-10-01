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
    history: [entry("created", "Carte créée", created, columns[0]?.id), entry("moved", "Déplacée", created + 10, columnId)],
    ...extra,
  };
}

const richDescription = `## Contexte

Les utilisateurs veulent **exporter** le tableau en \`CSV\` depuis la barre du haut.

### À faire

- Ajouter un bouton *Exporter* à côté de « Réglages »
- Générer le fichier côté serveur
  - colonnes : numéro, titre, colonne
  - encodage UTF-8
- Afficher un toast à la fin

1. Écrire le test
2. Implémenter
3. Mettre à jour le [README](https://example.com/readme)

> Attention : ne pas bloquer la boucle d'événements sur les gros tableaux.

\`\`\`ts
export function toCsv(cards: Card[]): string {
  return cards.map((c) => [c.number, JSON.stringify(c.title)].join(",")).join("\\n");
}
\`\`\`

| Colonne | Type | Limite |
| --- | --- | --- |
| Plan | skill | 2 |
| Implement | skill | 3 |
| Review | skill | 1 |
`;

const cards: Card[] = [
  card("Exporter le tableau en CSV", "col_backlog", { description: richDescription }),
  card("Corriger le défilement de la modale", "col_backlog", { description: "La colonne latérale ne défile pas sur les petits écrans." }),
  card("Ajouter un mode compact", "col_backlog", {
    description: "Réduire la hauteur des cartes.",
    skipColumnIds: ["col_plan", "col_review"],
  }),
  card("Notifications de fin de run", "col_build", {
    description: "Jouer un son et afficher une notification quand un agent termine.",
    lastRun: { columnId: "col_build", status: "success", at: at(200), summary: "Son ajouté, notification affichée.", costUsd: 0.42 },
  }),
  card("Migrer l'authentification", "col_plan", {
    description: "Passer sur des jetons à durée courte.",
    lastRun: {
      columnId: "col_plan",
      status: "question",
      at: at(210),
      summary: "Deux points à préciser avant de planifier.",
      questions: ["Faut-il conserver les anciens jetons pendant la migration ?", "Quelle durée de vie pour les nouveaux jetons ?"],
      sessionId: "sess_demo_question",
    },
  }),
  card("Réparer l'import des skills", "col_build", {
    description: "L'import échoue quand le dossier contient un point.",
    lastRun: { columnId: "col_build", status: "error", at: at(220), error: "Command failed: bun test (exit 1)", costUsd: 0.18 },
  }),
  card("Revue de la page Réglages", "col_review", { description: "Vérifier la cohérence des libellés." }),
  card("Prévisualiser l'interface", "col_test", {
    description: "Lancer l'application depuis le worktree.",
    test: { command: "bun start --no-agents --port 4611", url: "http://localhost:4611" },
  }),
  card("Déploiement automatique", "col_done", { description: "Pipeline de déploiement en un clic." }),
  card("Recherche dans les cartes", "col_done", { description: "Champ de recherche dans la barre du haut." }),
  card("Thème sombre", "col_done", { description: "Suivre prefers-color-scheme." }),
];

const board: Board = { version: 1, name: "Démo Nightshift", columns, cards, nextCardNumber: counter + 1 };

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
  "Écrit un plan d'implémentation à partir d'une carte.",
  "# Plan\n\nLis la carte puis écris un plan en étapes numérotées.",
);
skill(
  projectSkills,
  "demo-implement",
  "Implémente une carte selon son plan.",
  "# Implémentation\n\nImplémente le plan, lance les tests, commite.",
);
skill(
  userSkillsDir,
  "user-review",
  "Relit un diff et signale les défauts.",
  "# Revue\n\nRelis le diff, corrige les défauts, relance les tests.",
);
skill(userSkillsDir, "user-summarize", "Résume un fil de discussion.", "# Résumé\n\nProduis un résumé court et factuel.");

console.log(`Demo project written to ${dir} (user skills: ${userSkillsDir})`);
