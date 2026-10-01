import { useState } from "react";
import {
  type CommandAction,
  commandLabel,
  GROUP_LABEL_KEYS,
  type CommandGroup as Group,
  type PaletteCommand,
  paletteFilter,
} from "./commands.ts";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./components/ui/command.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";
import { useT } from "./i18n/index.ts";

const GROUPS: Group[] = ["cards", "actions", "skills", "navigation", "projects"];

/** ⌘K palette: cards by title or #number, actions, navigation, recent projects. Runs nothing itself, it reports the chosen action. */
export function CommandPalette({
  commands,
  onRun,
  onClose,
}: {
  commands: PaletteCommand[];
  /** `search` is the text typed so far (used to prefill a new card). */
  onRun: (action: CommandAction, search: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const [search, setSearch] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-[20%] translate-y-0 overflow-hidden p-0 sm:max-w-xl"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("palette.title")}</DialogTitle>
          <DialogDescription>{t("palette.description")}</DialogDescription>
        </DialogHeader>
        <Command
          filter={paletteFilter}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-1"
        >
          <CommandInput value={search} onValueChange={setSearch} placeholder={t("palette.placeholder")} />
          <CommandList>
            <CommandEmpty>{t("palette.empty")}</CommandEmpty>
            {GROUPS.map((group) => {
              const items = commands.filter((c) => c.group === group);
              if (items.length === 0) return null;
              return (
                <CommandGroup key={group} heading={t(GROUP_LABEL_KEYS[group])}>
                  {items.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={c.value}
                      keywords={c.keywords}
                      disabled={c.disabled}
                      onSelect={() => onRun(c.action, search.trim())}
                    >
                      <span className="min-w-0 truncate">{commandLabel(c, search)}</span>
                      {/* The label wins the space: a long subtitle (a skill description) is cut first. */}
                      {c.subtitle && (
                        <span className="ml-auto min-w-0 max-w-[50%] shrink-[100] truncate pl-3 text-xs text-muted-foreground">
                          {c.subtitle}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
