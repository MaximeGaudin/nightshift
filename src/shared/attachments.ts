// Pure helpers shared by server and web: files attached to a card that are not displayable images.

/** Largest file a user may attach to a card. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Most non-image files a card may be created with. */
export const MAX_PENDING_FILES = 10;

/**
 * Largest total (decoded bytes) of the images and files a card is created with: in base64 it stays under Bun's
 * 128 MB request body limit.
 */
export const MAX_PENDING_TOTAL_BYTES = 90 * 1024 * 1024;

/** Body of `POST /api/cards/:id/attachments`: `data` is the base64 of the raw bytes, without a `data:` prefix. */
export type CardAttachmentUpload = { project: string; name: string; data: string };
/** Answer of `POST /api/cards/:id/attachments`: the absolute path of the stored file and its name on disk. */
export type CardAttachmentStored = { path: string; name: string };

/** File name safe on disk and inside a markdown link: no folders, only `[A-Za-z0-9._-]`, never empty or hidden. */
export function safeAttachmentName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const clean = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-120)
    .replace(/^[._]+/, "");
  return clean || "file";
}

/** Markdown reference of an attached file. */
export function attachmentLink(name: string, path: string): string {
  return `[${name}](${path})`;
}

/** Decoded size of a base64 string, from its length (no decoding). */
export function base64Size(data: string): number {
  if (data.length === 0) return 0;
  return (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
