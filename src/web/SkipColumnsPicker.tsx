import { type Column, columnEmoji } from "../shared/types.ts";
import { Button } from "./components/ui/button.tsx";
import { useT } from "./i18n/index.ts";
import { cn } from "./lib/utils.ts";

export interface SkipColumnsPickerProps {
  /** Columns offered, already filtered by the caller (no Done, no current column…). */
  columns: Column[];
  value: string[];
  onChange: (ids: string[]) => void;
}

/**
 * Shortcut for the most common case: checks every inert column offered, or unchecks them all when they already are.
 * Other columns keep their state. Ids come back in column order.
 */
export function toggleInertColumns(columns: Column[], value: string[]): string[] {
  const inert = columns.filter((c) => c.type === "inert").map((c) => c.id);
  const set = new Set(value);
  const allOn = inert.length > 0 && inert.every((id) => set.has(id));
  for (const id of inert) {
    if (allOn) set.delete(id);
    else set.add(id);
  }
  return columns.filter((c) => set.has(c.id)).map((c) => c.id);
}

/** Collapsed list of checkboxes: the columns a card jumps over when it goes to the next column. */
export function SkipColumnsPicker({ columns, value, onChange }: SkipColumnsPickerProps) {
  const { t } = useT();
  if (columns.length === 0) return null;
  const checked = columns.filter((c) => value.includes(c.id)).length;
  const inert = columns.filter((c) => c.type === "inert");
  const inertOn = inert.length > 0 && inert.every((c) => value.includes(c.id));
  const toggle = (id: string, on: boolean) => {
    const set = new Set(value);
    if (on) set.add(id);
    else set.delete(id);
    onChange(columns.filter((c) => set.has(c.id)).map((c) => c.id));
  };
  return (
    <div className="skip-picker flex items-start gap-1.5 text-xs text-muted-foreground">
      <details className="min-w-0 flex-1">
        <summary className="cursor-pointer leading-6 select-none hover:text-foreground">
          {t("board.skip.summary")}
          {checked > 0 ? ` (${checked})` : ""}
        </summary>
        <div className="skip-picker-list flex flex-wrap gap-1 pt-1.5">
          {columns.map((c) => {
            const emoji = columnEmoji(c);
            const on = value.includes(c.id);
            return (
              <label
                key={c.id}
                className={cn(
                  "skip-picker-item flex cursor-pointer flex-row items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-normal whitespace-nowrap text-foreground transition-colors duration-150 hover:border-foreground/25",
                  on && "border-primary",
                )}
              >
                <input type="checkbox" className="size-3 accent-primary" checked={on} onChange={(e) => toggle(c.id, e.target.checked)} />
                <span>{emoji ? `${emoji} ${c.name}` : c.name}</span>
              </label>
            );
          })}
        </div>
      </details>
      {inert.length > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("skip-picker-inert shrink-0 text-muted-foreground", inertOn && "border-primary text-foreground")}
          aria-pressed={inertOn}
          title={t("board.skip.inertTitle", { names: inert.map((c) => c.name).join(", ") })}
          onClick={() => onChange(toggleInertColumns(columns, value))}
        >
          {t("board.skip.inert")}
        </Button>
      )}
    </div>
  );
}
