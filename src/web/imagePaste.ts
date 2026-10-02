// Pasting images into the card description: clipboard filtering, upload, and insertion of the markdown references.
import { MAX_CARD_IMAGE_BYTES } from "../shared/screenshots.ts";
import { t } from "./i18n/index.ts";

const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type ClipboardItemLike = { kind: string; type: string; getAsFile(): File | null };

/** The paste event fields this module reads (a React or DOM ClipboardEvent on a textarea fits). */
export type PasteEventLike = {
  clipboardData: { items: ArrayLike<ClipboardItemLike> } | null;
  currentTarget: { selectionStart: number; selectionEnd: number };
  preventDefault(): void;
};

export type ImagePasteDeps = {
  upload(image: Blob): Promise<{ path: string }>;
  /** Applies an edit to the current text (read at the time the uploads end, not at paste time). */
  apply(edit: (text: string) => { text: string; cursor: number }): void;
  onError(message: string): void;
  /** +1 when an upload starts, -1 when it ends. */
  busy(delta: 1 | -1): void;
};

/** Image files of the clipboard, in clipboard order. */
export function clipboardImages(items: ArrayLike<ClipboardItemLike>): File[] {
  const out: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
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
 * Paste handler of the description textarea. A paste with no image file is left alone (returns null, default paste runs).
 * Otherwise the default paste is prevented, every image is uploaded in parallel, and the ones that succeed are inserted
 * in clipboard order where the selection was at paste time. Each failure shows its own error.
 */
export function handleImagePaste(e: PasteEventLike, deps: ImagePasteDeps): Promise<void> | null {
  const images = clipboardImages(e.clipboardData?.items ?? []);
  if (images.length === 0) return null;
  e.preventDefault();
  const { selectionStart: start, selectionEnd: end } = e.currentTarget;
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
    if (stored.length > 0) deps.apply((text) => insertImageBlock(text, start, end, stored));
  });
}
