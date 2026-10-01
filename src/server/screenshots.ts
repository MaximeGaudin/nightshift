import { realpathSync, statSync } from "node:fs";
import { sep } from "node:path";

const MARKER = `${sep}nightshift-screenshots${sep}`;
const MAX_BYTES = 8_000_000;

/** PNG paths embedded as markdown images in a card description. */
export function screenshotRefs(description: string): string[] {
  return [...description.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1]!)
    .filter((p) => p.endsWith(".png"));
}

/** Absolute path of a screenshot this card is allowed to show. Throws otherwise. */
export function resolveScreenshot(description: string, requested: string): string {
  let real: string;
  try {
    real = realpathSync(requested);
  } catch {
    throw new Error("Screenshot not found");
  }
  if (!real.endsWith(".png") || !real.includes(MARKER)) throw new Error("Not a screenshot");
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
