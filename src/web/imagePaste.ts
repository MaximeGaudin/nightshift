// Pasting or dropping files into the card description: transfer filtering, upload, and insertion of the markdown references.
// Displayable images (PNG, JPEG, GIF, WebP) are uploaded as card images and shown inline; any other file is attached
// and referenced by a plain link to its absolute path.
import { attachmentLink, type CardAttachmentStored, MAX_ATTACHMENT_BYTES } from "../shared/attachments.ts";
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
  /** Stores a file that is not a displayable image. */
  attach(file: File): Promise<CardAttachmentStored>;
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

/**
 * Every file of a paste or a drop, in order. Reads `items` first, then `files`: browsers do not all fill both
 * (Safari and pasted Finder files may only fill `files`).
 */
export function transferFiles(transfer: TransferLike): File[] {
  const fromItems: File[] = [];
  for (const item of Array.from(transfer?.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(transfer?.files ?? []);
}

/** True for an image the card shows inline (PNG, JPEG, GIF, WebP); any other file is an attachment. */
export function isCardImage(file: Blob): boolean {
  return ACCEPTED.includes(file.type);
}

/** True while a drag carries files: the drop zone must then accept it, or the browser opens the file instead. */
export function dragHasFiles(transfer: { types?: ArrayLike<string> } | null): boolean {
  return Array.from(transfer?.types ?? []).includes("Files");
}

/**
 * Replaces `start..end` (clamped to the text) with `lines`, each on its own line.
 * The cursor lands after the inserted block.
 */
export function insertBlock(text: string, start: number, end: number, lines: string[]): { text: string; cursor: number } {
  const from = Math.min(Math.max(0, start), text.length);
  const to = Math.min(Math.max(from, end), text.length);
  const before = text.slice(0, from);
  const after = text.slice(to);
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const trail = after === "" || after.startsWith("\n") ? "" : "\n";
  const block = lead + lines.join("\n") + trail;
  return { text: before + block + after, cursor: from + block.length };
}

/** `insertBlock` with one `![image](path)` line per path. */
export function insertImageBlock(text: string, start: number, end: number, paths: string[]): { text: string; cursor: number } {
  return insertBlock(
    text,
    start,
    end,
    paths.map((p) => `![image](${p})`),
  );
}

/** Client-side refusal reason (the server still checks), or null when the image may be sent. */
export function imageRefusal(image: Blob): string | null {
  if (!ACCEPTED.includes(image.type)) return t("card.imageUnsupported");
  if (image.size > MAX_CARD_IMAGE_BYTES) return t("card.imageTooLarge");
  return null;
}

/** Client-side refusal reason of an attachment (the server still checks), or null when it may be sent. */
export function attachmentRefusal(file: File): string | null {
  if (file.size > MAX_ATTACHMENT_BYTES) return t("card.attachTooLarge", { name: file.name });
  return null;
}

/**
 * Uploads every file in parallel (images as card images, the others as attachments) and inserts the references of the
 * ones that succeed, in their order, as one block at `at`. Each failure shows its own error.
 */
export function insertFiles(files: File[], at: Selection, deps: ImagePasteDeps): Promise<void> {
  const one = async (file: File): Promise<string | null> => {
    const image = isCardImage(file);
    const refused = image ? imageRefusal(file) : attachmentRefusal(file);
    if (refused) {
      deps.onError(refused);
      return null;
    }
    deps.busy(1);
    try {
      if (image) return `![image](${(await deps.upload(file)).path})`;
      const stored = await deps.attach(file);
      return attachmentLink(stored.name, stored.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.onError(image ? message : t("card.attachFailed", { name: file.name, message }));
      return null;
    } finally {
      deps.busy(-1);
    }
  };
  return Promise.all(files.map(one)).then((lines) => {
    const stored = lines.filter((l): l is string => l !== null);
    if (stored.length > 0) deps.apply((text) => insertBlock(text, at.start, at.end, stored));
  });
}

/**
 * Paste or drop handler of the description. A transfer with no file is left alone (returns null, the browser's
 * default runs: text pastes are untouched). Otherwise the default is prevented and the files are inserted at `at()`,
 * read right away (the selection at paste or drop time).
 */
export function handleImageTransfer(
  e: { preventDefault(): void },
  transfer: TransferLike,
  at: () => Selection,
  deps: ImagePasteDeps,
): Promise<void> | null {
  const files = transferFiles(transfer);
  if (files.length === 0) return null;
  e.preventDefault();
  return insertFiles(files, at(), deps);
}
