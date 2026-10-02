import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { cardImageType, MAX_CARD_IMAGE_BYTES } from "../shared/screenshots.ts";
import { HttpError } from "./guard.ts";
import { NIGHTSHIFT_HOME } from "./settings.ts";

const MARKER = `${sep}nightshift-screenshots${sep}`;
const MAX_BYTES = MAX_CARD_IMAGE_BYTES;
const ID_RE = /^[A-Za-z0-9_-]+$/;
const IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

/** Image paths (PNG, JPEG, GIF, WebP) embedded as markdown images in a card description. */
export function screenshotRefs(description: string): string[] {
  return [...description.matchAll(IMAGE_RE)].map((m) => m[1]).filter((p) => cardImageType(p) !== null);
}

/** Stable folder holding the captures of a card. Throws on a dubious id. */
export function screenshotsDir(cardId: string): string {
  if (!ID_RE.test(cardId)) throw new Error("Invalid card id");
  return join(NIGHTSHIFT_HOME, "screenshots", cardId);
}

/**
 * Copies worktree captures referenced by the description into the stable per-card folder and
 * rewrites the description to point at the copies. Never throws: a capture that cannot be
 * copied keeps its original path.
 */
export function persistScreenshots(cardId: string, description: string): string {
  let dir: string;
  try {
    dir = screenshotsDir(cardId);
  } catch (e) {
    console.warn(`[screenshots] ${(e as Error).message}`);
    return description;
  }
  let result = description;
  for (const dest of new Set(screenshotRefs(description))) {
    if (!dest.includes(MARKER.replaceAll(sep, "/")) || dest.startsWith(dir + sep)) continue;
    try {
      if (!existsSync(dest)) throw new Error("file is missing");
      // The real file must sit in a captures folder: `..` or symlinks must not reach other files.
      if (!realpathSync(dest).includes(MARKER)) throw new Error("not inside a nightshift-screenshots folder");
      const st = statSync(dest);
      if (!st.isFile() || st.size > MAX_BYTES) throw new Error("not a regular file or larger than 8 MB");
      mkdirSync(dir, { recursive: true });
      const copy = join(dir, basename(dest));
      copyFileSync(dest, copy);
      result = result.split(dest).join(copy);
    } catch (e) {
      console.warn(`[screenshots] kept ${dest}: ${(e as Error).message}`);
    }
  }
  return result;
}

/** Deletes the stored captures of a card. Errors are ignored. */
export function removeScreenshots(cardId: string): void {
  try {
    rmSync(screenshotsDir(cardId), { recursive: true, force: true });
  } catch {}
}

/** Absolute path of a screenshot this card is allowed to show. Throws otherwise. */
export function resolveScreenshot(description: string, requested: string, cardId: string): string {
  let real: string;
  try {
    real = realpathSync(requested);
  } catch {
    throw new Error("Screenshot not found");
  }
  let stable: string | undefined;
  try {
    stable = realpathSync(screenshotsDir(cardId)) + sep;
  } catch {}
  const inStable = stable !== undefined && real.startsWith(stable);
  if (!cardImageType(real) || !(real.includes(MARKER) || inStable)) throw new Error("Not a screenshot");
  const allowed = screenshotRefs(description).some((ref) => {
    try {
      return realpathSync(ref) === real;
    } catch {
      return false;
    }
  });
  if (!allowed) throw new Error("Screenshot is not on this card");
  const st = statSync(real);
  if (!st.isFile() || st.size > MAX_BYTES) throw new Error("Screenshot is unreadable");
  return real;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Extension of an image from its first bytes, null when it is not PNG, JPEG, GIF or WebP. */
export function sniffImage(bytes: Uint8Array): "png" | "jpg" | "gif" | "webp" | null {
  const at = (offset: number, sig: number[]) => sig.every((b, i) => bytes[offset + i] === b);
  const ascii = (offset: number, text: string) =>
    at(
      offset,
      Array.from(text, (c) => c.charCodeAt(0)),
    );
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (at(0, [0xff, 0xd8, 0xff])) return "jpg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  return null;
}

/**
 * Stores a pasted image (base64 of its raw bytes) in the card's folder and returns its absolute path.
 * The type comes from the bytes and the name is generated here: nothing the client sends names the file.
 * Throws before writing anything on bad data (400), a file over 8 MB (413) or an unsupported type (415).
 */
export function storeCardImage(cardId: string, data: string): string {
  const dir = screenshotsDir(cardId);
  if (!data || data.length % 4 !== 0 || !BASE64_RE.test(data)) throw new Error("data must be the base64 of an image");
  // Size from the base64 length, so an oversized upload is refused before decoding it.
  const size = (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (size > MAX_BYTES) throw new HttpError(413, "Image is larger than 8 MB");
  const bytes = Buffer.from(data, "base64");
  const ext = sniffImage(bytes);
  if (!ext) throw new HttpError(415, "Unsupported image type (PNG, JPEG, GIF or WebP)");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `paste-${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`);
  writeFileSync(file, bytes, { flag: "wx" });
  return file;
}
