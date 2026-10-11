// Pure helpers shared by server and web: markers of images pasted before their card exists.

/** Most images a card may be created with (10 × 8 MB in base64 stays under Bun's 128 MB body limit). */
export const MAX_PENDING_IMAGES = 10;

const MARKER_RE = /!\[image\]\(pending:([1-9][0-9]*)\)/g;

/** Path written in place of an image until it is uploaded: `pending:N`. */
export function pendingPath(n: number): string {
  return `pending:${n}`;
}

/** Markdown marker of a pending image. */
export function pendingMarker(n: number): string {
  return `![image](${pendingPath(n)})`;
}

/** Ids of the pending markers in `text`, in order of appearance, without duplicates. */
export function pendingIds(text: string): number[] {
  return [...new Set([...text.matchAll(MARKER_RE)].map((m) => Number(m[1])))];
}

/**
 * Replaces each `![image](pending:N)` with `![image](<path>)`. A marker whose path is null or missing from `paths`
 * is removed with its line break, so no empty line is left where it stood.
 */
export function resolvePending(text: string, paths: ReadonlyMap<number, string | null>): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let dropped = false;
    const next = line.replace(MARKER_RE, (_, id: string) => {
      const path = paths.get(Number(id));
      if (path) return `![image](${path})`;
      dropped = true;
      return "";
    });
    // A line that held only removed markers goes away entirely; other text on it stays.
    if (dropped && next.trim() === "") continue;
    out.push(next);
  }
  return out.join("\n");
}
