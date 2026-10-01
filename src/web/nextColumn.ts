import type { Column } from "../shared/types.ts";

/** Column right after `columnId`, or undefined when it is the last one or unknown. */
export function nextColumn(columns: Column[], columnId: string): Column | undefined {
  const i = columns.findIndex((c) => c.id === columnId);
  return i === -1 ? undefined : columns[i + 1];
}
