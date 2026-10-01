export interface ParsedProgress {
  step: number;
  total: number;
  label: string;
}

const MARKER = /^\[nightshift-progress\] +(\d+) *\/ *(\d+)(?:[ \t]+(.*))?$/;
const MAX_LABEL = 120;
const LIST_PREFIX = /^(?:[-*+>]|\d+\.)[ \t]+/;
const EMPHASIS = /[`*_]/;

/** Strips indentation, list/quote prefixes and emphasis or code delimiters surrounding a line. */
function normalizeLine(raw: string): string {
  let line = raw.trim();
  for (let prev = ""; prev !== line; ) {
    prev = line;
    line = line.replace(LIST_PREFIX, "").trimStart();
  }
  let lead = 0;
  while (lead < line.length && EMPHASIS.test(line[lead])) lead++;
  if (lead === 0) return line;
  line = line.slice(lead);
  let end = line.length;
  while (end > 0 && EMPHASIS.test(line[end - 1])) end--;
  return line.slice(0, end).trimEnd();
}

/** Last valid `[nightshift-progress] N/M label` line of the text, if any. */
export function parseProgressMarker(text: string): ParsedProgress | undefined {
  let found: ParsedProgress | undefined;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const m = MARKER.exec(normalizeLine(line));
    if (!m) continue;
    const step = Number(m[1]);
    const total = Number(m[2]);
    if (total < 1 || total > 999 || step < 1 || step > total) continue;
    found = { step, total, label: (m[3] ?? "").trim().slice(0, MAX_LABEL) };
  }
  return found;
}

interface TodoItem {
  content?: unknown;
  activeForm?: unknown;
  status?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Progress derived from a TodoWrite tool input. */
export function progressFromTodos(input: unknown): ParsedProgress | undefined {
  const todos = (input as { todos?: unknown } | null | undefined)?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return undefined;
  const items = todos.map((t) => (t && typeof t === "object" ? (t as TodoItem) : {}));
  const total = items.length;
  const current = items.findIndex((t) => t.status === "in_progress");
  if (current >= 0) {
    const t = items[current];
    return { step: current + 1, total, label: str(t.activeForm) || str(t.content) };
  }
  let done = 0;
  let lastDone: TodoItem | undefined;
  for (const t of items) {
    if (t.status === "completed") {
      done++;
      lastDone = t;
    }
  }
  const step = Math.min(Math.max(done, 1), total);
  return { step, total, label: str((lastDone ?? items[0]).content) };
}
