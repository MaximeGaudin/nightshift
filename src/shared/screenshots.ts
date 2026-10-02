// Pure helpers shared by server and web: which markdown images are card captures.

/** Image types a card may show, by lowercase file extension. */
export const CARD_IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Largest card image accepted, captures and pasted images alike. */
export const MAX_CARD_IMAGE_BYTES = 8 * 1024 * 1024;

/** Body of `POST /api/cards/:id/images`: `data` is the base64 of the raw image bytes, without a `data:` prefix. */
export type CardImageUpload = { project: string; data: string };
/** Answer of `POST /api/cards/:id/images`: the absolute path of the stored file. */
export type CardImageStored = { path: string };

/** Content type of a card image from its extension (any case), null when it is not an accepted image. */
export function cardImageType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || path.indexOf("/", dot) >= 0) return null;
  return CARD_IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** True when `dest` is an absolute local image path that is a capture of card `cardId`. */
export function isCardScreenshot(dest: string, cardId: string): boolean {
  if (!dest.startsWith("/") || dest.startsWith("//")) return false;
  if (!cardImageType(dest)) return false;
  if (dest.includes("/nightshift-screenshots/")) return true;
  const marker = `/screenshots/${cardId}/`;
  const at = dest.indexOf(marker);
  if (at < 0) return false;
  const file = dest.slice(at + marker.length);
  return file.length > 0 && !file.includes("/");
}

/** All captures of the card found in a markdown text, in text order. */
export function cardScreenshots(description: string, cardId: string): { alt: string; file: string }[] {
  const out: { alt: string; file: string }[] = [];
  for (const m of description.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const file = m[2];
    if (isCardScreenshot(file, cardId)) out.push({ alt: m[1] || "Capture", file });
  }
  return out;
}

export function screenshotUrl(project: string, cardId: string, file: string): string {
  return `/api/cards/${cardId}/screenshot?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`;
}
