// Pasting or dropping images into the card description: transfer filtering, upload, and insertion of the markdown references.
import { MAX_CARD_IMAGE_BYTES } from "../shared/screenshots.ts";
import { t } from "./i18n/index.ts";

const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type ClipboardItemLike = { kind: string; type: string; getAsFile(): File | null };

/** The DataTransfer fields this module reads: a paste's `clipboardData` or a drop's `dataTransfer`. */
export type TransferLike = { items?: ArrayLike<ClipboardItemLike>; files?: ArrayLike<File> } | null;

/** Where the images go: the selection to replace, read when the paste or drop happens. */
export type Selection = { start: number; end: number };

export type ImagePasteDeps = {
  upload(image: Blob): Promise<{ path: string }>;
  /** Applies an edit to the current text (read at the time the uploads end, not at paste time). */
  apply(edit: (text: string) => { text: string; cursor: number }): void;
  onError(message: string): void;
  /** +1 when an upload starts, -1 when it ends. */
  busy(delta: 1 | -1): void;
};

/**
 * Image files of a paste or a drop, in order. Reads `items` first, then `files`: browsers do not all fill
 * both (Safari and pasted Finder files may only fill `files`).
 */
export function transferImages(transfer: TransferLike): File[] {
  const fromItems: File[] = [];
  for (const item of Array.from(transfer?.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(transfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
}

/** True while a drag carries files: the drop zone must then accept it, or the browser opens the file instead. */
export function dragHasFiles(transfer: { types?: ArrayLike<string> } | null): boolean {
  return Array.from(transfer?.types ?? []).includes("Files");
}

/**
 * Replaces `start..end` (clamped to the text) with one `![image](path)` line per path, each on its own line.
 * The cursor lands after the inserted block.
 */
export function insertImageBlock(text: string, start: number, end: number, paths: string[]): { text: string; cursor: number } {
  const from = Math.min(Math.max(0, start), text.length);
  const to = Math.min(Math.max(from, end), text.length);
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const trail = after === "" || after.startsWith("\n") ? "" : "\n";
  const block = lead + paths.map((p) => `![image](${p})`).join("\n") + trail;
  return { text: before + block + after, cursor: from + block.length };
}

/** Client-side refusal reason (the server still checks), or null when the image may be sent. */
export function imageRefusal(image: Blob): string | null {
  if (!ACCEPTED.includes(image.type)) return t("card.imageUnsupported");
  if (image.size > MAX_CARD_IMAGE_BYTES) return t("card.imageTooLarge");
  return null;
}

/**
 * Uploads every image in parallel and inserts the ones that succeed, in their order, at `at`.
 * Each failure shows its own error.
 */
export function insertImages(images: File[], at: Selection, deps: ImagePasteDeps): Promise<void> {
  const one = async (image: Blob): Promise<string | null> => {
    const refused = imageRefusal(image);
    if (refused) {
      deps.onError(refused);
      return null;
    }
    deps.busy(1);
    try {
      return (await deps.upload(image)).path;
    } catch (err) {
      deps.onError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      deps.busy(-1);
    }
  };
  return Promise.all(images.map(one)).then((paths) => {
    const stored = paths.filter((p): p is string => p !== null);
    if (stored.length > 0) deps.apply((text) => insertImageBlock(text, at.start, at.end, stored));
  });
}

/**
 * Paste or drop handler of the description. A transfer with no image file is left alone (returns null, the browser's
 * default runs: text pastes are untouched). Otherwise the default is prevented and the images are inserted at `at()`,
 * read right away (the selection at paste or drop time).
 */
export function handleImageTransfer(
  e: { preventDefault(): void },
  transfer: TransferLike,
  at: () => Selection,
  deps: ImagePasteDeps,
): Promise<void> | null {
  const images = transferImages(transfer);
  if (images.length === 0) return null;
  e.preventDefault();
  return insertImages(images, at(), deps);
}
