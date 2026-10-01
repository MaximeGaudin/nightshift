import type { common as enCommon } from "../en/common.ts";

export const common: Record<keyof typeof enCommon, string> = {
  "common.cancel": "Annuler",
  "common.save": "Enregistrer",
  "common.close": "Fermer",
  "common.delete": "Supprimer",
  "common.templateSkillsNotCopied": "Skills modèles non copiés : {names}",
  "time.justNow": "à l'instant",
  "time.minutesAgo": "il y a {count} min",
  "time.hoursAgo": "il y a {count} h",
};
