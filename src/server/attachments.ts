import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { screenshotsDir } from "./screenshots.ts";
import { NIGHTSHIFT_HOME } from "./settings.ts";

/** Largest file a user may attach to a card. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** Stable folder holding the files attached to a card. Throws on a dubious id. */
export function attachmentsDir(cardId: string): string {
  if (!ID_RE.test(cardId)) throw new Error("Invalid card id");
  return join(NIGHTSHIFT_HOME, "attachments", cardId);
}

/** File name safe on disk and inside a markdown link: no folders, no brackets or spaces, never empty or hidden. */
export function safeAttachmentName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const clean = base
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-120);
  return clean || "file";
}

/** `name`, or `name-2.ext`, `name-3.ext`... : the first one not already in `dir`. */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

/**
 * Stores a file dropped on a card and returns its absolute path and the markdown that references it.
 * PNG images go to the card's screenshots folder so the description shows them inline; anything else is a plain link.
 */
export function saveAttachment(cardId: string, rawName: string, data: Uint8Array): { path: string; markdown: string } {
  if (data.byteLength === 0) throw new Error("File is empty");
  if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("File is larger than 20 MB");
  const name = safeAttachmentName(rawName);
  const image = name.toLowerCase().endsWith(".png");
  const dir = image ? screenshotsDir(cardId) : attachmentsDir(cardId);
  mkdirSync(dir, { recursive: true });
  const file = freeName(dir, image ? `${name.slice(0, -4)}.png` : name);
  const path = join(dir, file);
  writeFileSync(path, data, { flag: "wx" });
  return { path, markdown: image ? `![${file}](${path})` : `[${file}](${path})` };
}

/** Deletes the attached files of a card. Errors are ignored. */
export function removeAttachments(cardId: string): void {
  try {
    rmSync(attachmentsDir(cardId), { recursive: true, force: true });
  } catch {}
}
