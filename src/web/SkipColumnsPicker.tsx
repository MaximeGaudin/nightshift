import { type Column, columnEmoji } from "../shared/types.ts";

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
    <div className="skip-picker">
      <details>
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
      {inert.length > 0 && (
        <button
          type="button"
          className="skip-picker-inert"
          aria-pressed={inertOn}
          title={`Sauter les colonnes inertes : ${inert.map((c) => c.name).join(", ")}`}
          onClick={() => onChange(toggleInertColumns(columns, value))}
        >
          Sauter les inertes
        </button>
      )}
    </div>
  );
}
