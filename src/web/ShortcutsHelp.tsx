import { AppDialog } from "./components/app-dialog.tsx";
import { Kbd } from "./components/ui/kbd.tsx";
import { useT } from "./i18n/index.ts";
import { shortcutHelpRows } from "./shortcuts.ts";

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  return (
    <AppDialog size="md" title={t("shortcuts.title")} description={t("shortcuts.description")} onClose={onClose}>
      <ul className="flex flex-col divide-y">
        {shortcutHelpRows().map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-4 py-2 text-[13px]">
            <span>{s.label}</span>
            <span className="flex items-center gap-1">
              {s.keys.map((k, i) => (
                <span key={k} className="flex items-center gap-1">
                  {i > 0 && <span className="text-xs text-muted-foreground">{t("shortcuts.or")}</span>}
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
