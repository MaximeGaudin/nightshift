import { useState } from "react";
import { type CommandAction, commandLabel, type CommandGroup as Group, type PaletteCommand, paletteFilter } from "./commands.ts";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./components/ui/command.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog.tsx";

const GROUPS: Group[] = ["Cartes", "Actions", "Navigation", "Projets"];

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
          <DialogTitle>Palette de commandes</DialogTitle>
          <DialogDescription>Rechercher une carte par titre ou #numéro, ou lancer une action</DialogDescription>
        </DialogHeader>
        <Command
          filter={paletteFilter}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-1"
        >
          <CommandInput value={search} onValueChange={setSearch} placeholder="Rechercher une carte, une action…" />
          <CommandList>
            <CommandEmpty>Aucun résultat.</CommandEmpty>
            {GROUPS.map((group) => {
              const items = commands.filter((c) => c.group === group);
              if (items.length === 0) return null;
              return (
                <CommandGroup key={group} heading={group}>
                  {items.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={c.value}
                      keywords={c.keywords}
                      disabled={c.disabled}
                      onSelect={() => onRun(c.action, search.trim())}
                    >
                      <span className="truncate">{commandLabel(c, search)}</span>
                      {c.subtitle && <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">{c.subtitle}</span>}
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
