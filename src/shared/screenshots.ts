// Pure helpers shared by server and web: which markdown images are card captures.

/** True when `dest` is an absolute local PNG path that is a capture of card `cardId`. */
export function isCardScreenshot(dest: string, cardId: string): boolean {
  if (!dest.startsWith("/") || dest.startsWith("//")) return false;
  if (!dest.endsWith(".png")) return false;
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
