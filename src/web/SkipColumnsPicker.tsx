import { type Column, columnEmoji } from "../shared/types.ts";

export interface SkipColumnsPickerProps {
  /** Columns offered, already filtered by the caller (no Done, no current column…). */
  columns: Column[];
  value: string[];
  onChange: (ids: string[]) => void;
}

/** Collapsed list of checkboxes: the columns a card jumps over when it goes to the next column. */
export function SkipColumnsPicker({ columns, value, onChange }: SkipColumnsPickerProps) {
  if (columns.length === 0) return null;
  const checked = columns.filter((c) => value.includes(c.id)).length;
  const toggle = (id: string, on: boolean) => {
    const set = new Set(value);
    if (on) set.add(id);
    else set.delete(id);
    onChange(columns.filter((c) => set.has(c.id)).map((c) => c.id));
  };
  return (
    <details className="skip-picker">
      <summary>Sauter des colonnes{checked > 0 ? ` (${checked})` : ""}</summary>
      <div className="skip-picker-list">
        {columns.map((c) => {
          const emoji = columnEmoji(c);
          return (
            <label key={c.id} className="skip-picker-item">
              <input type="checkbox" checked={value.includes(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
              <span>{emoji ? `${emoji} ${c.name}` : c.name}</span>
            </label>
          );
        })}
      </div>
    </details>
  );
}
