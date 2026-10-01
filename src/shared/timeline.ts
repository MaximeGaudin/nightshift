// Time spent by a card per column and part, replayed from its history. Pure, no dependencies.
import {
  type Card,
  type Column,
  DONE_COLUMN_ID,
  DONE_COLUMN_NAME,
  type HistoryEntry,
  type TimeCursor,
  type TimePart,
  type TimeSlice,
  type TimeState,
} from "./types.ts";

export type { TimeCursor, TimePart, TimeSlice, TimeState };

const PART_ORDER: TimePart[] = ["inert", "queued", "running", "human", "legacy"];

function sliceKey(columnId: string | undefined, columnName: string, part: TimePart): string {
  return (columnId !== undefined ? "id:" + columnId : "name:" + columnName) + "\0" + part;
}

function intervalMs(from: string, to: string): number {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function parseCreatedName(text: string): string {
  return /Created in (.+)$/.exec(text)?.[1] ?? "?";
}

/** Destination column name of a move text such as "Agent: Grill → Plan". */
function parseMovedName(text: string): string {
  return /.*→ (.+)$/.exec(text)?.[1] ?? "?";
}

/** Source column name of a move text, after the "<reason>: " prefix. */
function parseMovedSource(text: string): string | undefined {
  return /^(?:[^:]*: )?(.+?) → /.exec(text)?.[1];
}

function addMs(totals: Map<string, TimeSlice>, columnId: string | undefined, columnName: string, part: TimePart, ms: number) {
  const key = sliceKey(columnId, columnName, part);
  const slice = totals.get(key);
  if (slice) {
    slice.ms += ms;
    slice.columnName = columnName;
  } else {
    totals.set(key, { ...(columnId !== undefined ? { columnId } : {}), columnName, part, ms });
  }
}

/**
 * Replays history entries on top of an optional checkpoint. Replaying a prefix then the rest on the returned
 * state gives the same result as replaying everything at once, whatever the cut point. The initial interval of an
 * already truncated history is decided by state alone (no cursor yet and a `moved` entry), so it is never
 * applied twice. Does not mutate `base`.
 */
export function replayHistory(base: TimeState | undefined, entries: HistoryEntry[], createdAt: string): TimeState {
  const totals = new Map<string, TimeSlice>();
  for (const s of base?.totals ?? []) totals.set(sliceKey(s.columnId, s.columnName, s.part), { ...s });
  let cursor: TimeCursor | undefined = base?.cursor ? { ...base.cursor } : undefined;

  const close = (at: string) => {
    if (cursor?.part) addMs(totals, cursor.columnId, cursor.columnName, cursor.part, intervalMs(cursor.at, at));
  };

  for (const e of entries) {
    if (e.kind === "edited") continue;
    if (e.kind === "created" || e.kind === "moved") {
      if (cursor) close(e.at);
      else if (e.kind === "moved") {
        const source = parseMovedSource(e.text);
        if (source !== undefined) addMs(totals, undefined, source, "legacy", intervalMs(createdAt, e.at));
      }
      const name = e.kind === "created" ? parseCreatedName(e.text) : parseMovedName(e.text);
      if (e.columnId !== undefined) {
        cursor = { at: e.at, columnId: e.columnId, columnName: name, part: e.columnId === DONE_COLUMN_ID ? null : "inert" };
      } else {
        cursor = { at: e.at, columnName: name, part: name === DONE_COLUMN_NAME ? null : "legacy" };
      }
      continue;
    }
    // queued / started / run: need a counted, detailed visit.
    if (!cursor || cursor.part === null || cursor.part === "legacy") continue;
    close(e.at);
    const part: TimePart = e.kind === "queued" ? "queued" : e.kind === "started" ? "running" : "human";
    cursor = { ...cursor, at: e.at, part };
  }

  return { totals: [...totals.values()], ...(cursor ? { cursor } : {}) };
}

/** Time per (column, part) of a card at `nowMs`, in board order then deleted columns, Done and zero slices excluded. */
export function cardTimeSlices(card: Card, columns: Column[], nowMs: number): TimeSlice[] {
  const state = replayHistory(card.timeBase, card.history, card.createdAt);
  const raw = [...state.totals];
  const cur = state.cursor;
  if (cur?.part) {
    const ms = nowMs - Date.parse(cur.at);
    raw.push({
      ...(cur.columnId !== undefined ? { columnId: cur.columnId } : {}),
      columnName: cur.columnName,
      part: cur.part,
      ms: Number.isFinite(ms) && ms > 0 ? ms : 0,
    });
  }

  const byId = new Map(columns.map((c) => [c.id, c]));
  const byName = new Map<string, Column>();
  for (const c of columns) if (!byName.has(c.name)) byName.set(c.name, c);

  const merged = new Map<string, TimeSlice>();
  const deletedOrder: string[] = [];
  for (const s of raw) {
    let col = s.columnId !== undefined ? byId.get(s.columnId) : byName.get(s.columnName);
    let id = col?.id;
    let name = col?.name ?? s.columnName;
    let part = s.part;
    if (col) {
      if (col.id === DONE_COLUMN_ID) continue;
      if (part === "legacy" && col.type === "inert") part = "inert";
    } else {
      id = s.columnId;
      col = undefined;
      const dk = id !== undefined ? "id:" + id : "name:" + name;
      if (!deletedOrder.includes(dk)) deletedOrder.push(dk);
    }
    const key = (col ? "board:" + col.id : "del:" + (id !== undefined ? "id:" + id : "name:" + name)) + "\0" + part;
    const existing = merged.get(key);
    if (existing) {
      existing.ms += s.ms;
      if (!col) existing.columnName = name;
    } else merged.set(key, { ...(id !== undefined ? { columnId: id } : {}), columnName: name, part, ms: s.ms });
  }

  const out: TimeSlice[] = [];
  const pick = (prefix: string) => {
    for (const part of PART_ORDER) {
      const s = merged.get(prefix + "\0" + part);
      if (s && s.ms > 0) out.push(s);
    }
  };
  for (const c of columns) pick("board:" + c.id);
  for (const dk of deletedOrder) pick("del:" + dk);
  return out;
}

/** "45 s", "14 min", "2 h 14 min", "3 j 4 h". */
export function formatDuration(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

/** Integer percent of `part` in `total`; "< 1 %" when positive but rounds to 0. */
export function formatPercent(part: number, total: number): string {
  if (total <= 0 || part <= 0) return "0 %";
  const pct = Math.round((part / total) * 100);
  return pct === 0 ? "< 1 %" : `${pct} %`;
}
