/**
 * Section editor for card descriptions. A section is a level-2 heading (`## Title`) and everything up to the next
 * level-2 heading; level-3+ headings and fenced code belong to their parent. Agents send small edits instead of
 * rewriting the whole note.
 */

export type SectionOp = "replace" | "append" | "delete";

export const MAX_SECTION_ENTRIES = 50;
/** Largest content accepted for one entry (characters). Descriptions have no other size limit. */
export const MAX_SECTION_CONTENT = 1_000_000;

export interface SectionEdit {
  heading: string;
  content: string;
  op: SectionOp;
}

export interface SectionsResult {
  text: string;
  /** Edits that were applied, as "Heading (op)". */
  applied: string[];
  /** Entries skipped or noteworthy cases, one human-readable line each. */
  logs: string[];
}

const OPS = new Set<string>(["replace", "append", "delete"]);
const HEADING_RE = /^##[ \t]+(\S.*?)[ \t]*$/;
const FENCE_RE = /^ {0,3}(```|~~~)/;

/** One untrusted entry: the edit, or why it is skipped. */
function parseEntry(e: unknown): SectionEdit | { error: string; heading?: string } {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return { error: "not an object" };
  const { heading, content, op } = e as Record<string, unknown>;
  if (typeof heading !== "string") return { error: "missing heading" };
  if (/[\r\n]/.test(heading)) return { error: "heading contains a newline" };
  const h = heading
    .trim()
    .replace(/^##[ \t]+/, "")
    .trim();
  if (!h) return { error: "empty heading" };
  const o = op === undefined || op === null ? "replace" : op;
  if (typeof o !== "string" || !OPS.has(o)) return { error: `unknown op ${JSON.stringify(o)}`, heading: h };
  if (o === "delete") return { heading: h, content: "", op: "delete" };
  if (typeof content !== "string") return { error: "content is not a string", heading: h };
  if (content.length > MAX_SECTION_CONTENT) return { error: `content larger than ${MAX_SECTION_CONTENT} characters`, heading: h };
  return { heading: h, content, op: o as SectionOp };
}

/** Validates the untrusted `sections` value of an agent output: valid entries plus what was skipped. */
export function parseSections(raw: unknown): { edits: SectionEdit[]; logs: string[] } {
  const logs: string[] = [];
  if (raw === undefined || raw === null) return { edits: [], logs };
  if (!Array.isArray(raw)) return { edits: [], logs: ["sections ignored: not an array"] };
  let entries = raw;
  if (entries.length > MAX_SECTION_ENTRIES) {
    logs.push(`sections: ${entries.length} entries, only the first ${MAX_SECTION_ENTRIES} are applied`);
    entries = entries.slice(0, MAX_SECTION_ENTRIES);
  }
  const edits: SectionEdit[] = [];
  for (const [i, e] of entries.entries()) {
    const r = parseEntry(e);
    if ("error" in r) logs.push(`sections[${i}]${r.heading ? ` (${r.heading})` : ""} skipped: ${r.error}`);
    else edits.push(r);
  }
  return { edits, logs };
}

interface Found {
  /** Index of the heading line. */
  start: number;
  /** Index after the last line of the section. */
  end: number;
}

/** Level-2 headings outside fenced code, in order, with the section span of each. */
function findSections(lines: string[]): (Found & { title: string })[] {
  const heads: { start: number; title: string }[] = [];
  let fence: string | null = null;
  lines.forEach((raw, i) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const f = FENCE_RE.exec(line);
    if (f) {
      if (fence === null) fence = f[1] as string;
      else if (fence === f[1]) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = HEADING_RE.exec(line);
    if (m) heads.push({ start: i, title: (m[1] as string).trim() });
  });
  return heads.map((h, k) => ({ ...h, end: heads[k + 1]?.start ?? lines.length }));
}

/** Applies the edits in order to a markdown note. Never throws; untouched text is kept byte for byte. */
export function applySections(text: string, edits: SectionEdit[]): SectionsResult {
  const crlf = text.includes("\r\n");
  const cr = crlf ? "\r" : "";
  let lines = text.split("\n");
  const applied: string[] = [];
  const logs: string[] = [];
  // Trailing line breaks of the content are dropped: the section keeps its own separator, so repeated edits stay stable.
  const bodyLines = (content: string) =>
    content
      .replace(/(\r?\n)+$/, "")
      .split(/\r?\n/)
      .map((l) => l + cr);
  // A kept line that gets new lines after it needs the document's line ending.
  const terminate = (l: string) => (crlf && !l.endsWith("\r") ? `${l}\r` : l);
  const isBlank = (l: string | undefined) => l !== undefined && l.trim() === "";

  for (const edit of edits) {
    const matches = findSections(lines).filter((s) => s.title === edit.heading);
    const sec = matches[0];
    if (matches.length > 1) logs.push(`Duplicate heading "${edit.heading}": the first one was edited`);
    if (!sec) {
      if (edit.op === "delete") {
        logs.push(`sections: "${edit.heading}" not found, nothing to delete`);
        continue;
      }
      // Missing section: add it at the end of the note.
      const hadFinalNewline = lines.length > 1 && lines[lines.length - 1] === "";
      while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop();
      const add = [`## ${edit.heading}${cr}`, `${cr}`, ...bodyLines(edit.content)];
      if (lines.length > 0) lines[lines.length - 1] = terminate(lines[lines.length - 1] as string);
      lines = [...lines, ...(lines.length > 0 ? [cr] : []), ...add, ...(hadFinalNewline ? [""] : [])];
      applied.push(`${edit.heading} (${edit.op})`);
      continue;
    }
    // Trailing blank lines of the section separate it from the next one: keep them.
    let bodyEnd = sec.end;
    while (bodyEnd > sec.start + 1 && isBlank(lines[bodyEnd - 1])) bodyEnd--;
    const before = lines.slice(0, sec.start);
    const after = lines.slice(sec.end);
    const heading = terminate(lines[sec.start] as string);
    const trailing = lines.slice(bodyEnd, sec.end);
    if (edit.op === "delete") {
      lines = [...before, ...after];
    } else if (edit.op === "append") {
      const kept = lines.slice(sec.start, bodyEnd).map(terminate);
      lines = [...before, ...kept, ...bodyLines(edit.content), ...trailing, ...after];
    } else {
      const body = edit.content === "" ? [] : [cr, ...bodyLines(edit.content)];
      lines = [...before, heading, ...body, ...trailing, ...after];
    }
    applied.push(`${edit.heading} (${edit.op})`);
  }
  // The last line has no line break: a CR left there (inserted content at the end of the note, or a blank line
  // left by deleting the last section) is dropped, unless the note itself ended with a bare CR.
  const last = lines[lines.length - 1] as string;
  if (crlf && last.endsWith("\r") && !text.endsWith("\r")) lines[lines.length - 1] = last.slice(0, -1);
  return { text: lines.join("\n"), applied, logs };
}
