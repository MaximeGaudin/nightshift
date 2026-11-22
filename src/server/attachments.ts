// Files attached to a card that are not displayable images: stored under NIGHTSHIFT_HOME, referenced by absolute path.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { base64Size, type CardAttachmentStored, MAX_ATTACHMENT_BYTES, safeAttachmentName } from "../shared/attachments.ts";
import { HttpError } from "./guard.ts";
import { NIGHTSHIFT_HOME } from "./settings.ts";

const ID_RE = /^[A-Za-z0-9_-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Stable folder holding the files attached to a card. Throws on a dubious id. */
export function attachmentsDir(cardId: string): string {
  if (!ID_RE.test(cardId)) throw new Error("Invalid card id");
  return join(NIGHTSHIFT_HOME, "attachments", cardId);
}

/**
 * Checks the base64 of an attachment before anything is decoded or written: bad data or an empty file (400),
 * a file over 20 MB (413). Returns its decoded size.
 */
export function checkAttachmentData(data: unknown): number {
  if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64_RE.test(data)) throw new Error("data must be base64");
  const size = base64Size(data);
  if (size === 0) throw new Error("File is empty");
  if (size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "File is larger than 20 MB");
  return size;
}

/**
 * Stores a file (base64 of its raw bytes) in the card's attachments folder and returns its absolute path and name.
 * The name is `safeAttachmentName(rawName)`, or `stem-2.ext`, `stem-3.ext`... when taken: an existing file is never
 * overwritten (exclusive create, the next candidate on EEXIST).
 */
export function storeCardAttachment(cardId: string, rawName: string, data: string): CardAttachmentStored {
  const dir = attachmentsDir(cardId);
  checkAttachmentData(data);
  const bytes = Buffer.from(data, "base64");
  const name = safeAttachmentName(rawName);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  mkdirSync(dir, { recursive: true });
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stem}-${i}${ext}`;
    const path = join(dir, candidate);
    try {
      writeFileSync(path, bytes, { flag: "wx" });
      return { path, name: candidate };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

/** Deletes the attached files of a card. Errors are ignored. */
export function removeAttachments(cardId: string): void {
  try {
    rmSync(attachmentsDir(cardId), { recursive: true, force: true });
  } catch {}
}
