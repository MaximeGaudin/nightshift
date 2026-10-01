import type { skills as enSkills } from "../en/skills.ts";

export const skills: Record<keyof typeof enSkills, string> = {
  "skills.create.template":
    "Tu reçois une fiche de kanban (titre + description).\n\n1. Lis la fiche.\n2. Fais le travail demandé.\n3. Mets à jour la description avec le résultat.\n4. Envoie la fiche à la colonne suivante.",
  "skills.create.title": "Nouveau skill",
  "skills.create.descriptionBefore": "Le skill sera créé dans",
  "skills.create.nameToken": "nom",
  "skills.create.descriptionAfter": "du projet (commitable).",
  "skills.create.submit": "Créer",
  "skills.create.nameLabel": "Nom (minuscules, chiffres, tirets)",
  "skills.create.namePlaceholder": "ex. write-spec",
  "skills.create.descriptionLabel": "Description (quand l'utiliser)",
  "skills.create.bodyLabel": "Instructions",
  "skills.discardChanges": "Abandonner les modifications non enregistrées ?",
  "skills.title": "Skills",
  "skills.description": "Instructions réutilisables que les colonnes confient aux agents.",
  "skills.new": "Nouveau skill (projet)",
  "skills.searchLabel": "Rechercher un skill",
  "skills.searchPlaceholder": "Rechercher…",
  "skills.empty": "Aucun skill pour le moment. Créez-en un avec « Nouveau skill ».",
  "skills.noMatch": "Aucun skill ne correspond à la recherche.",
  "skills.scopeProject": "projet",
  "skills.scopeUser": "utilisateur",
  "skills.userScopeNote": " · skill utilisateur, partagé par tous vos projets",
  "skills.contentLabel": "Contenu du skill {name}",
  "skills.pick": "Choisissez un skill à éditer, ou créez-en un nouveau.",
};
