import { arrayMove } from "@dnd-kit/sortable";
import { type Column, isDoneColumn } from "../shared/types.ts";

export type KeyedColumn = Column & { key: string };

/**
 * Pure reorder for the columns editor: same as `arrayMove(activeKey -> overKey)` except that Done is never movable
 * and nothing can end up after it. Unknown keys and no-ops return the same array.
 */
export function reorderColumns<T extends KeyedColumn>(cols: T[], activeKey: string, overKey: string): T[] {
  const from = cols.findIndex((c) => c.key === activeKey);
  let to = cols.findIndex((c) => c.key === overKey);
  if (from < 0 || to < 0 || from === to) return cols;
  if (isDoneColumn(cols[from])) return cols;
  const doneIndex = cols.findIndex(isDoneColumn);
  if (doneIndex >= 0 && to >= doneIndex) to = doneIndex - 1;
  if (to === from) return cols;
  return arrayMove(cols, from, to);
}
