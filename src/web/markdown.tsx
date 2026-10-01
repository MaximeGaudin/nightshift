// Markdown rendering for card descriptions, agent questions and run summaries.
// Home-made, dependency-free parser that only builds React elements: any HTML in
// the source is rendered as escaped text, never injected. Malformed syntax falls
// back to text and the renderer never throws.

import { type CSSProperties, Fragment, type ReactNode } from "react";

// ---------- AST ----------

type Inline =
  | { t: "text"; v: string }
  | { t: "br" }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "img"; alt: string; dest: string; src: string };

type Align = "left" | "center" | "right" | null;

type ListItem = { task: boolean | null; blocks: Block[] };

type Block =
  | { t: "heading"; level: number; text: string }
  | { t: "para"; text: string }
  | { t: "code"; text: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "hr" }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "table"; aligns: Align[]; head: string[]; rows: string[][] };

const MAX_DEPTH = 24;

// ---------- Block parsing ----------

const FENCE = /^( *)(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(?:( +)(.*))?$/;
const DELIM = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

const isBlank = (line: string) => line.trim() === "";
const indentOf = (line: string) => line.length - line.trimStart().length;

function expandTabs(line: string): string {
  const lead = /^[ \t]*/.exec(line)![0];
  if (!lead.includes("\t")) return line;
  let width = 0;
  for (const ch of lead) width = ch === "\t" ? width + 4 - (width % 4) : width + 1;
  return " ".repeat(width) + line.slice(lead.length);
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  const next = lines[i + 1];
  return lines[i]!.includes("|") && next?.includes("-") && DELIM.test(next);
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    // Pathological nesting: stop structuring, keep the text.
    if (depth > MAX_DEPTH) {
      blocks.push({
        t: "para",
        text: lines
          .slice(i)
          .map((l) => l.trim())
          .filter(Boolean)
          .join("\n"),
      });
      break;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const ind = fence[1]!.length;
      const marker = fence[2]!;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        const close = /^ *(`{3,}|~{3,}) *$/.exec(l);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
          i++;
          break;
        }
        // An unterminated fence runs to the end of the source.
        body.push(l.slice(Math.min(indentOf(l), ind)));
        i++;
      }
      blocks.push({ t: "code", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: "heading", level: heading[1]!.length, text: (heading[2] ?? "").trim() });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (QUOTE.test(l)) inner.push(l.replace(QUOTE, ""));
        else if (!isBlank(l) && !startsBlock(l) && inner.length && !isBlank(inner[inner.length - 1]!)) inner.push(l.trim());
        else break;
        i++;
      }
      blocks.push({ t: "quote", blocks: parseBlocks(inner, depth + 1) });
      continue;
    }

    if (LIST.test(line)) {
      i = parseList(lines, i, depth, blocks);
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = splitRow(line);
      const aligns: Align[] = splitRow(lines[i + 1]!).map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      const width = aligns.length;
      const fit = (cells: string[]) => Array.from({ length: width }, (_, k) => cells[k] ?? "");
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|")) {
        rows.push(fit(splitRow(lines[i]!)));
        i++;
      }
      blocks.push({ t: "table", aligns, head: fit(head), rows });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (isBlank(l) || (para.length && (startsBlock(l) || isTableStart(lines, i)))) break;
      para.push(l.trim());
      i++;
    }
    blocks.push({ t: "para", text: para.join("\n") });
  }
  return blocks;
}

/** Parses one list starting at `start`, pushes it to `out`, returns the next line index. */
function parseList(lines: string[], start: number, depth: number, out: Block[]): number {
  const first = LIST.exec(lines[start]!)!;
  const baseIndent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: ListItem[] = [];
  let i = start;

  const sibling = (line: string | undefined) => {
    if (line === undefined || HR.test(line)) return null;
    const m = LIST.exec(line);
    if (!m) return null;
    if (m[1]!.length > baseIndent + 1 || m[1]!.length < baseIndent) return null;
    if (/\d/.test(m[2]!) !== ordered) return null;
    return m;
  };

  while (i < lines.length) {
    const m = sibling(lines[i]);
    if (!m) break;
    const spaces = m[3]?.length ?? 1;
    const contentIndent = m[1]!.length + m[2]!.length + (spaces > 4 ? 1 : spaces);
    const threshold = Math.min(contentIndent, baseIndent + 2);
    let text = m[4] ?? "";

    let task: boolean | null = null;
    const box = /^\[([ xX])\](?:[ \t]+|$)/.exec(text);
    if (box) {
      task = box[1] !== " ";
      text = text.slice(box[0].length);
    }

    const itemLines = [text];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (isBlank(l)) {
        let j = i;
        while (j < lines.length && isBlank(lines[j]!)) j++;
        if (j < lines.length && indentOf(lines[j]!) >= threshold) {
          for (let k = i; k < j; k++) itemLines.push("");
          i = j;
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind >= threshold) {
        itemLines.push(l.slice(Math.min(ind, contentIndent)));
        i++;
        continue;
      }
      // Lazy continuation of the item's paragraph.
      const last = itemLines[itemLines.length - 1]!;
      if (!startsBlock(l) && !isBlank(last) && !FENCE.test(last)) {
        itemLines.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    // "- [x] 1. Step" is a checked step, not a checkbox above a numbered list: keep the text inline.
    const blocks =
      task !== null && text && startsBlock(text)
        ? [{ t: "para" as const, text }, ...parseBlocks(itemLines.slice(1), depth + 1)]
        : parseBlocks(itemLines, depth + 1);
    items.push({ task, blocks });

    // Blank lines between siblings keep the same list.
    let j = i;
    while (j < lines.length && isBlank(lines[j]!)) j++;
    if (j > i && sibling(lines[j])) i = j;
  }

  out.push({ t: "list", ordered, start: ordered ? parseInt(first[2]!, 10) || 0 : 1, items });
  return i;
}

function parseSource(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n").map(expandTabs);
  return parseBlocks(lines, 0);
}

// ---------- Inline parsing ----------

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const isWord = (ch: string | undefined) => ch !== undefined && WORD.test(ch);
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/** Only http, https and mailto links are allowed. The source string is kept as href. */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!url || /[\s\u0000-\u001f\u007f]/.test(url)) return null;
  if (!/^(https?:\/\/|mailto:)/i.test(url)) return null;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
}

function findDouble(s: string, from: number, c: string): number {
  let j = from;
  while (true) {
    j = s.indexOf(c + c, j);
    if (j < 0) return -1;
    if (j > from && !isSpace(s[j - 1])) return j;
    j++;
  }
}

function findSingle(s: string, from: number, c: string): number {
  let j = from;
  while (true) {
    j = s.indexOf(c, j);
    if (j < 0) return -1;
    if (s[j + 1] === c) {
      j += 2;
      continue;
    }
    if (j === from || isSpace(s[j - 1]) || (c === "_" && isWord(s[j + 1]))) {
      j++;
      continue;
    }
    return j;
  }
}

type LinkMatch = { label: string; dest: string; end: number };

function matchLink(s: string, i: number): LinkMatch | null {
  let depth = 0;
  let close = -1;
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (ch === "\\") j++;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      if (depth === 0) {
        close = j;
        break;
      }
      depth--;
    }
  }
  if (close < 0 || s[close + 1] !== "(") return null;
  let parens = 0;
  let end = -1;
  for (let j = close + 2; j < s.length; j++) {
    const ch = s[j];
    if (ch === "\\") j++;
    else if (ch === "(") parens++;
    else if (ch === ")") {
      if (parens === 0) {
        end = j;
        break;
      }
      parens--;
    } else if (ch === "\n") return null;
  }
  if (end < 0) return null;
  let dest = s.slice(close + 2, end).trim();
  const angled = /^<([^>]*)>/.exec(dest);
  dest = angled ? angled[1]! : (dest.split(/\s+/)[0] ?? "");
  return { label: s.slice(i + 1, close), dest, end: end + 1 };
}

function parseInline(s: string, depth = 0, inLink = false): Inline[] {
  if (depth > MAX_DEPTH) return [{ t: "text", v: s }];
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i]!;

    if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1]!)) {
      buf += s[i + 1];
      i += 2;
      continue;
    }

    if (c === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }

    if (c === "`") {
      let run = 1;
      while (s[i + run] === "`") run++;
      const ticks = "`".repeat(run);
      // The closing run must have exactly the same length.
      let close = s.indexOf(ticks, i + run);
      while (close >= 0 && s[close + run] === "`") {
        let k = close;
        while (s[k] === "`") k++;
        close = s.indexOf(ticks, k);
      }
      if (close >= 0) {
        let code = s.slice(i + run, close).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        flush();
        out.push({ t: "code", v: code });
        i = close + run;
      } else {
        buf += ticks;
        i += run;
      }
      continue;
    }

    if (c === "*" || c === "_") {
      const leftOk = c === "*" || !isWord(s[i - 1]);
      if (s[i + 1] === c) {
        const close = leftOk && !isSpace(s[i + 2]) ? findDouble(s, i + 2, c) : -1;
        if (close > i + 2 && (c === "*" || !isWord(s[close + 2]))) {
          flush();
          out.push({ t: "strong", c: parseInline(s.slice(i + 2, close), depth + 1, inLink) });
          i = close + 2;
        } else {
          buf += c + c;
          i += 2;
        }
        continue;
      }
      const close = leftOk && !isSpace(s[i + 1]) ? findSingle(s, i + 1, c) : -1;
      if (close > i + 1) {
        flush();
        out.push({ t: "em", c: parseInline(s.slice(i + 1, close), depth + 1, inLink) });
        i = close + 1;
      } else {
        buf += c;
        i++;
      }
      continue;
    }

    if (c === "!" && s[i + 1] === "[") {
      // Images are never rendered here: the caller may supply renderImage, else the source stays as text.
      const img = matchLink(s, i + 1);
      if (img) {
        flush();
        out.push({ t: "img", alt: img.label, dest: img.dest, src: s.slice(i, img.end) });
        i = img.end;
        continue;
      }
    }

    if (c === "[" && !inLink) {
      const link = matchLink(s, i);
      if (link) {
        const href = safeHref(link.dest);
        if (href) {
          flush();
          out.push({ t: "link", href, c: parseInline(link.label, depth + 1, true) });
        } else buf += s.slice(i, link.end);
        i = link.end;
        continue;
      }
    }

    if ((c === "h" || c === "H") && !inLink && !isWord(s[i - 1])) {
      const m = /^https?:\/\/[^\s<>]+/i.exec(s.slice(i, i + 2048));
      if (m) {
        let url = m[0];
        // Trailing punctuation belongs to the sentence, unless it closes a paren of the URL.
        while (/[.,;:!?'"*_)\]]$/.test(url)) {
          if (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
          url = url.slice(0, -1);
        }
        const href = safeHref(url);
        if (href) {
          flush();
          out.push({ t: "link", href, c: [{ t: "text", v: url }] });
          i += url.length;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

// ---------- React rendering ----------

export type RenderImage = (alt: string, dest: string) => ReactNode | null;

function renderInline(nodes: Inline[], ri?: RenderImage): ReactNode[] {
  return nodes.map((n, k) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "br":
        return <br key={k} />;
      case "code":
        return <code key={k}>{n.v}</code>;
      case "strong":
        return <strong key={k}>{renderInline(n.c, ri)}</strong>;
      case "em":
        return <em key={k}>{renderInline(n.c, ri)}</em>;
      case "img": {
        const node = ri ? ri(n.alt, n.dest) : null;
        return node === null || node === undefined ? n.src : <Fragment key={k}>{node}</Fragment>;
      }
      case "link":
        return (
          <a key={k} href={n.href} target="_blank" rel="noreferrer">
            {renderInline(n.c, ri)}
          </a>
        );
    }
  });
}

function renderItem(item: ListItem, k: number, ri?: RenderImage): ReactNode {
  const inline = (s: string) => renderInline(parseInline(s), ri);
  const box = item.task === null ? null : <input type="checkbox" disabled checked={item.task} readOnly />;
  // A leading paragraph sits inline next to the bullet or checkbox.
  const [head, ...rest] = item.blocks;
  const lead = head?.t === "para" ? inline(head.text) : null;
  return (
    <li key={k} className={item.task === null ? undefined : "task"}>
      {box}
      {lead}
      {renderBlocks(head?.t === "para" ? rest : item.blocks, ri)}
    </li>
  );
}

function renderBlocks(blocks: Block[], ri?: RenderImage): ReactNode[] {
  const inline = (s: string) => renderInline(parseInline(s), ri);
  return blocks.map((b, k) => {
    switch (b.t) {
      case "heading": {
        const H = `h${b.level}` as "h1";
        return <H key={k}>{inline(b.text)}</H>;
      }
      case "para": {
        const nodes = parseInline(b.text);
        // A rendered image is a block (<figure>), which is not allowed inside <p>.
        const hasFigure = !!ri && nodes.some((n) => n.t === "img" && ri(n.alt, n.dest) != null);
        const P = hasFigure ? "div" : "p";
        return <P key={k}>{renderInline(nodes, ri)}</P>;
      }
      case "code":
        return (
          <pre key={k}>
            <code>{b.text}</code>
          </pre>
        );
      case "quote":
        return <blockquote key={k}>{renderBlocks(b.blocks, ri)}</blockquote>;
      case "hr":
        return <hr key={k} />;
      case "list": {
        const cls = b.items.some((it) => it.task !== null) ? "tasks" : undefined;
        const items = b.items.map((it, i) => renderItem(it, i, ri));
        return b.ordered ? (
          <ol key={k} className={cls} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        ) : (
          <ul key={k} className={cls}>
            {items}
          </ul>
        );
      }
      case "table": {
        const style = (c: number): CSSProperties | undefined => {
          const a = b.aligns[c];
          return a ? { textAlign: a } : undefined;
        };
        return (
          <div key={k} className="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((cell, c) => (
                    <th key={c} style={style(c)}>
                      {inline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              {b.rows.length > 0 && (
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td key={c} style={style(c)}>
                          {inline(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
        );
      }
    }
  });
}

export function Markdown({ source, className, renderImage }: { source: string; className?: string; renderImage?: RenderImage }) {
  const cls = className ? `md ${className}` : "md";
  const src = typeof source === "string" ? source : String(source ?? "");
  let content: ReactNode;
  try {
    content = renderBlocks(parseSource(src), renderImage);
  } catch {
    return <div className={`${cls} md-plain`}>{src}</div>;
  }
  return <div className={cls}>{content}</div>;
}

// ---------- Plain text ----------

function inlinePlain(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "img" ? n.src : n.t === "br" ? " " : inlinePlain(n.c)))
    .join("");
}

function blocksPlain(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.t === "heading" || b.t === "para") out.push(inlinePlain(parseInline(b.text)));
    else if (b.t === "code") out.push(b.text);
    else if (b.t === "quote") out.push(...blocksPlain(b.blocks));
    else if (b.t === "list") for (const it of b.items) out.push(...blocksPlain(it.blocks));
    else if (b.t === "table") for (const row of [b.head, ...b.rows]) out.push(...row.map((c) => inlinePlain(parseInline(c))));
  }
  return out;
}

/** Text without markdown syntax, for card excerpts; whitespace is normalized. */
export function toPlainText(source: string): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const src = typeof source === "string" ? source : String(source ?? "");
  try {
    return norm(blocksPlain(parseSource(src)).join(" "));
  } catch {
    return norm(src);
  }
}
