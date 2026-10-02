import { useState } from "react";
import { type Card, type Column, cardRef } from "../shared/types.ts";
import { Input } from "./components/ui/input.tsx";
import { useT } from "./i18n/index.ts";
import { cn } from "./lib/utils.ts";

export interface DependencyPickerProps {
  /** Cards offered, already filtered by the caller (never the card itself). */
  cards: Card[];
  columns: Column[];
  /** Selected card ids, in selection order. */
  value: string[];
  onChange: (ids: string[]) => void;
}

/** Cards matching a search: `#12` or `12` matches the number prefix, anything else the title (case-insensitive). */
export function filterDependencyCards(cards: Card[], query: string): Card[] {
  const q = query.trim().toLowerCase();
  if (!q) return cards;
  const num = /^#?(\d+)$/.exec(q)?.[1];
  return cards.filter((c) => (num !== undefined && String(c.number).startsWith(num)) || c.title.toLowerCase().includes(q));
}

/** Collapsed, searchable list of checkboxes: the cards this card waits for before leaving Backlog. */
export function DependencyPicker({ cards, columns, value, onChange }: DependencyPickerProps) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  if (cards.length === 0) return null;
  // Selected cards first, in selection order, then the others in board order.
  const matches = filterDependencyCards(cards, query);
  const shown = [...value.flatMap((id) => matches.filter((c) => c.id === id)), ...matches.filter((c) => !value.includes(c.id))];
  const toggle = (id: string, on: boolean) => onChange(on ? [...value.filter((v) => v !== id), id] : value.filter((v) => v !== id));
  return (
    <details className="dependency-picker min-w-0 text-xs text-muted-foreground">
      <summary className="cursor-pointer leading-6 select-none hover:text-foreground">
        {t("board.deps.summary")}
        {value.length > 0 ? ` (${value.length})` : ""}
      </summary>
      <div className="flex flex-col gap-1.5 pt-1.5">
        <Input
          className="h-7 text-xs"
          value={query}
          placeholder={t("board.deps.search")}
          aria-label={t("board.deps.search")}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="dependency-picker-list flex max-h-40 flex-col gap-0.5 overflow-y-auto">
          {shown.length === 0 && <span className="px-1.5 py-0.5">{t("board.deps.none")}</span>}
          {shown.map((c) => {
            const on = value.includes(c.id);
            const column = columns.find((col) => col.id === c.columnId);
            return (
              <label
                key={c.id}
                className={cn(
                  "dependency-picker-item flex cursor-pointer flex-row items-center gap-1.5 rounded-sm border border-transparent px-1.5 py-0.5 font-normal text-foreground hover:border-foreground/25",
                  on && "border-primary",
                )}
              >
                <input type="checkbox" className="size-3 accent-primary" checked={on} onChange={(e) => toggle(c.id, e.target.checked)} />
                <span className="tabular-nums text-muted-foreground">{cardRef(c)}</span>
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {column && <span className="shrink-0 text-muted-foreground">{column.name}</span>}
              </label>
            );
          })}
        </div>
      </div>
    </details>
  );
}
