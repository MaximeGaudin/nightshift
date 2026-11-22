// Pure helpers shared by server and web: markers of images and files pasted before their card exists.

/** Most images a card may be created with (10 × 8 MB in base64 stays under Bun's 128 MB body limit). */
export const MAX_PENDING_IMAGES = 10;

/**
 * Pending markers: `![image](pending:N)` for an image, `[<name>](pending:N)` for another file (the name holds only
 * `[A-Za-z0-9._-]`, see `safeAttachmentName`). Images and files share the ids `N`.
 */
const MARKER_RE = /!\[image\]\(pending:([1-9][0-9]*)\)|(?<!!)\[([A-Za-z0-9._-]+)\]\(pending:([1-9][0-9]*)\)/g;

export type PendingKind = "image" | "file";
/** A marker found in a text: its id, its kind, and for a file the name it shows. */
export type PendingRef = { id: number; kind: PendingKind; label: string };

/** What replaces a marker: a path (the marker keeps its label), a path with a new label, or null to remove it. */
export type PendingTarget = string | { path: string; label: string } | null;

/** Path written in place of an image or file until it is uploaded: `pending:N`. */
export function pendingPath(n: number): string {
  return `pending:${n}`;
}

/** Markdown marker of a pending image. */
export function pendingMarker(n: number): string {
  return `![image](${pendingPath(n)})`;
}

/** Markdown marker of a pending file; `name` must already be safe (see `safeAttachmentName`). */
export function pendingFileMarker(n: number, name: string): string {
  return `[${name}](${pendingPath(n)})`;
}

/** Markers of `text`, in order of appearance, one per id (the first occurrence wins). */
export function pendingRefs(text: string): PendingRef[] {
  const seen = new Map<number, PendingRef>();
  for (const m of text.matchAll(MARKER_RE)) {
    const ref: PendingRef =
      m[1] !== undefined ? { id: Number(m[1]), kind: "image", label: "image" } : { id: Number(m[3]), kind: "file", label: m[2] };
    if (!seen.has(ref.id)) seen.set(ref.id, ref);
  }
  return [...seen.values()];
}

/** Ids of the pending markers in `text`, images and files, in order of appearance, without duplicates. */
export function pendingIds(text: string): number[] {
  return pendingRefs(text).map((r) => r.id);
}

/**
 * Replaces each marker by its target: `![image](pending:N)` becomes `![image](<path>)`, `[name](pending:N)` becomes
 * `[name](<path>)` (or `[label](<path>)` when the target gives one). A marker whose target is null or missing from
 * `targets` is removed with its line break, so no empty line is left where it stood.
 */
export function resolvePending(text: string, targets: ReadonlyMap<number, PendingTarget>): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let dropped = false;
    const next = line.replace(MARKER_RE, (_, imageId: string | undefined, name: string | undefined, fileId: string | undefined) => {
      const target = targets.get(Number(imageId ?? fileId));
      if (!target) {
        dropped = true;
        return "";
      }
      const path = typeof target === "string" ? target : target.path;
      if (imageId !== undefined) return `![image](${path})`;
      return `[${typeof target === "string" ? name : target.label}](${path})`;
    });
    // A line that held only removed markers goes away entirely; other text on it stays.
    if (dropped && next.trim() === "") continue;
    out.push(next);
  }
  return out.join("\n");
}
