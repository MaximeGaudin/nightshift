import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { NIGHTSHIFT_HOME } from "./settings.ts";

const MARKER = `${sep}nightshift-screenshots${sep}`;
const MAX_BYTES = 8 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]+$/;
const IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

/** PNG paths embedded as markdown images in a card description. */
export function screenshotRefs(description: string): string[] {
  return [...description.matchAll(IMAGE_RE)].map((m) => m[1]!).filter((p) => p.endsWith(".png"));
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
  if (!real.endsWith(".png") || !(real.includes(MARKER) || inStable)) throw new Error("Not a screenshot");
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
