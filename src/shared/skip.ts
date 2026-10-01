import { type Card, type Column, DONE_COLUMN_ID } from "./types.ts";

/**
 * Canonical skip list: unique ids that exist in `columns`, never Done, in board column order.
 * Anything that is not an array of strings is ignored; an empty result is `undefined` (the field is then absent).
 */
export function normalizeSkipColumnIds(columns: Column[], ids: unknown): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const wanted = new Set(ids.filter((id): id is string => typeof id === "string"));
  const out = columns.filter((c) => c.id !== DONE_COLUMN_ID && wanted.has(c.id)).map((c) => c.id);
  return out.length > 0 ? out : undefined;
}

/** First column after the card's own that it does not skip. Done is never skipped. Undefined when there is none. */
export function resolveNextColumn(columns: Column[], card: Pick<Card, "columnId" | "skipColumnIds">): Column | undefined {
  const index = columns.findIndex((c) => c.id === card.columnId);
  if (index < 0) return undefined;
  const skipped = new Set(card.skipColumnIds ?? []);
  return columns.slice(index + 1).find((c) => c.id === DONE_COLUMN_ID || !skipped.has(c.id));
}

/** Existing, non-Done columns the card skips, in board order. */
export function skippedColumns(columns: Column[], card: Pick<Card, "skipColumnIds">): Column[] {
  const skipped = new Set(card.skipColumnIds ?? []);
  return columns.filter((c) => c.id !== DONE_COLUMN_ID && skipped.has(c.id));
}
