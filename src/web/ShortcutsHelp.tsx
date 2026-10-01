import { AppDialog } from "./components/app-dialog.tsx";
import { Kbd } from "./components/ui/kbd.tsx";

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["⌘ K", "Ctrl K"], label: "Ouvrir la palette de commandes" },
  { keys: ["C"], label: "Nouvelle carte dans la première colonne" },
  { keys: ["?"], label: "Afficher cette aide" },
  { keys: ["Échap"], label: "Fermer la fenêtre ou la palette" },
  { keys: ["Espace"], label: "Saisir ou déposer une carte (glisser au clavier)" },
  { keys: ["↑", "↓", "←", "→"], label: "Déplacer la carte saisie" },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <AppDialog
      size="md"
      title="Raccourcis clavier"
      description="Les raccourcis à une touche sont ignorés dans les champs de saisie."
      onClose={onClose}
    >
      <ul className="flex flex-col divide-y">
        {SHORTCUTS.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-4 py-2 text-[13px]">
            <span>{s.label}</span>
            <span className="flex items-center gap-1">
              {s.keys.map((k, i) => (
                <span key={k} className="flex items-center gap-1">
                  {i > 0 && <span className="text-xs text-muted-foreground">ou</span>}
                  <Kbd>{k}</Kbd>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </AppDialog>
  );
}
